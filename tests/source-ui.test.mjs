import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the page's actual source-selection and submit handlers with DOM test doubles.
function page() {
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\s+([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attributes = match[1];
    const bareAttributes = attributes.replace(/"[^"]*"/g, '');
    const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
    elements.set(match[2], {
      value: attributes.match(/\bvalue="([^"]*)"/)?.[1] || '',
      type: attributes.match(/\btype="([^"]*)"/)?.[1] || '',
      checked: /\bchecked\b/.test(bareAttributes),
      required: /\brequired\b/.test(bareAttributes),
      disabled: /\bdisabled\b/.test(bareAttributes),
      files: [], listeners: {}, textContent: '', validationMessage: '',
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelector() { return null; },
      setCustomValidity(message) { this.validationMessage = message; },
      checkValidity() {
        if (this.disabled) return true;
        if (this.validationMessage) return false;
        if (this.type === 'file') return !this.required || this.files.length > 0;
        if (this.required && !this.value) return false;
        if (this.type === 'url' && this.value) {
          try { new URL(this.value); } catch { return false; }
        }
        return true;
      },
      reportValidity() { return this.checkValidity(); },
    });
  }
  const requests = [];
  const stored = new Map();
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    window: { addEventListener() {} },
    localStorage: { setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    TextEncoder, TextDecoder, URLSearchParams, btoa, atob,
    alert() {},
    fetch: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return { json: async () => ({ success: true, workerName: 'test-worker' }) };
    },
  });
  vm.runInContext(inlineScript, context);
  context.selectPreset('custom');
  return { context, elements, requests, stored };
}

test('file mode requires a file and disables the URL field', () => {
  const { context, elements } = page();
  context.setSourceType('file');
  assert.equal(elements.get('scriptFile').required, true);
  assert.equal(elements.get('scriptFile').disabled, false);
  assert.equal(elements.get('scriptUrl').required, false);
  assert.equal(elements.get('scriptUrl').disabled, true);
  assert.equal(elements.get('scriptFileFields').classList.contains('hidden'), false);
});

test('choosing a preset restores URL mode without submitting the previous file', async () => {
  const { context, elements } = page();
  context.setSourceType('file');
  elements.get('scriptFile').files = [new File(['local'], 'worker.js')];
  context.selectPreset('zeus');
  const source = await context.getWorkerSource();
  assert.equal(elements.get('scriptFile').disabled, true);
  assert.equal(elements.get('scriptFile').required, false);
  assert.equal(elements.get('scriptUrl').disabled, false);
  assert.equal(elements.get('scriptUrl').required, true);
  assert.equal(source.scriptContent, undefined);
  assert.match(source.scriptUrl, /Z-E-U-S/);
});

test('switching to a local file unlocks the preset-specific obfuscation control', () => {
  const { context, elements } = page();
  context.selectPreset('nahan');
  assert.equal(elements.get('enableObfuscation').disabled, true);
  context.setSourceType('file');
  assert.equal(elements.get('enableObfuscation').disabled, false);
  assert.equal(elements.get('nahanObfBadge').classList.contains('hidden'), true);
  context.setSourceType('url');
  assert.equal(elements.get('enableObfuscation').disabled, true);
});

test('invalid, missing, whitespace-only and unreadable files are rejected', async () => {
  const { context, elements } = page();
  context.setSourceType('file');
  for (const file of [null, new File(['code'], 'worker.txt'), new File([], 'worker.js'), new File([' \n\t'], 'worker.js')]) {
    elements.get('scriptFile').files = file ? [file] : [];
    await assert.rejects(context.getWorkerSource(), /انتخاب|جاوااسکریپت|خالی/);
  }
  elements.get('scriptFile').files = [{ name: 'worker.js', size: 20, text: async () => { throw new Error('Read failed'); } }];
  await assert.rejects(context.getWorkerSource(), /خواندن فایل/);
});

test('wizard cannot advance without selecting a local file', () => {
  const { context, elements } = page();
  context.setSourceType('file');
  elements.get('workerName').value = 'test-worker';
  vm.runInContext('currentStep = 2', context);
  context.nextStep();
  assert.equal(vm.runInContext('currentStep', context), 2);
  assert.match(elements.get('scriptFile').validationMessage, /انتخاب/);
});

test('review displays the local filename as text', () => {
  const { context, elements } = page();
  context.setSourceType('file');
  elements.get('scriptFile').files = [new File(['export default {};'], '<worker>.mjs')];
  vm.runInContext('currentStep = 4', context);
  context.updateStepper();
  assert.equal(elements.get('reviewSource').textContent, '<worker>.mjs');
});

test('submit reads a local MJS file and sends only its UTF-8 content', async () => {
  const { context, elements, requests, stored } = page();
  const code = '// سلام\nexport default { fetch() { return new Response("🌱"); } };\n';
  elements.get('accountId').value = 'test-account';
  elements.get('apiToken').value = 'test-token';
  elements.get('workerName').value = 'test-worker';
  elements.get('scriptUrl').value = 'https://example.com/stale-worker.js';
  elements.get('scriptFile').files = [new File([code], 'local-worker.MJS')];
  context.setSourceType('file');
  context.updateScriptFileInfo();
  assert.match(elements.get('scriptFileInfo').textContent, /local-worker\.MJS/);
  await elements.get('wizardForm').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/deploy');
  assert.equal(requests[0].payload.scriptContent, code);
  assert.equal(requests[0].payload.scriptUrl, undefined);
  assert.equal(elements.get('submitBtn').disabled, false);
  assert.equal([...stored.values()].includes(code), false);
});

test('submit reports local read failures and allows retry without sending a request', async () => {
  const { context, elements, requests } = page();
  context.setSourceType('file');
  elements.get('scriptFile').files = [{ name: 'worker.js', size: 20, text: async () => { throw new Error('Read failed'); } }];
  await elements.get('wizardForm').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, 0);
  assert.match(elements.get('output').innerText, /خواندن فایل/);
  assert.equal(elements.get('submitBtn').disabled, false);
  assert.equal(elements.get('prevBtn').disabled, false);
});

test('URL submission sends the URL without any previously selected local content', async () => {
  const { context, elements, requests } = page();
  elements.get('scriptFile').files = [new File(['local'], 'worker.js')];
  context.setSourceType('file');
  context.updateScriptFileInfo();
  context.setSourceType('url');
  elements.get('scriptUrl').value = 'https://example.com/worker.js';
  await elements.get('wizardForm').listeners.submit({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.scriptUrl, 'https://example.com/worker.js');
  assert.equal(requests[0].payload.scriptContent, undefined);
});
