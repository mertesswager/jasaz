import assert from 'node:assert/strict';
import test from 'node:test';
import { deployWorker } from '../functions/_core.js';
import { onRequestPost } from '../functions/api/deploy.js';

const credentials = { accountId: 'test-account', apiToken: 'test-token', workerName: 'upload-test' };
const scriptUrl = 'https://example.com/worker.js';
const apiBase = 'https://api.cloudflare.com/client/v4/accounts/test-account';

function mockCloudflare(t, { source = '', downloadStatus = 200 } = {}) {
  const calls = [];
  const state = { calls, upload: null };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url === scriptUrl) return new Response(source, { status: downloadStatus });
    if (url === `${apiBase}/workers/scripts/upload-test` && options.method === 'PUT') {
      state.upload = options.body;
      return Response.json({ success: true });
    }
    if (url === `${apiBase}/workers/scripts/upload-test` && options.method === 'DELETE') {
      return Response.json({ success: true });
    }
    if (url === `${apiBase}/workers/scripts/upload-test/subdomain`) {
      return Response.json({ success: true });
    }
    if (url === `${apiBase}/workers/subdomain`) {
      return Response.json({ success: true, result: { subdomain: 'example' } });
    }
    if (url === `${apiBase}/d1/database`) {
      return Response.json({ success: true, result: [{ name: 'existing-db', uuid: 'd1-id' }] });
    }
    if (url === `${apiBase}/storage/kv/namespaces`) {
      return Response.json({ success: true, result: [{ title: 'existing-kv', id: 'kv-id' }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return state;
}

test('local UTF-8 module is uploaded unchanged without downloading a URL', async t => {
  const state = mockCloudflare(t);
  const scriptContent = '\uFEFF// سلام\r\nexport default { fetch() { return new Response("درود 🌱"); } };\r\n';
  const result = await deployWorker({ ...credentials, scriptContent, scriptUrl });
  assert.equal(result.success, true);
  assert.equal(result.workerUrl, 'https://upload-test.example.workers.dev');
  assert.equal(await state.upload.get('worker.js').text(), scriptContent.replace(/^\uFEFF/, ''));
  assert.deepEqual(new Uint8Array(await state.upload.get('worker.js').arrayBuffer()), new TextEncoder().encode(scriptContent));
  const metadata = JSON.parse(await state.upload.get('metadata').text());
  assert.equal(metadata.main_module, 'worker.js');
  assert.equal(state.calls.some(call => call.url === scriptUrl), false);
});

test('classic local Worker retains service-worker metadata', async t => {
  const state = mockCloudflare(t);
  const scriptContent = 'addEventListener("fetch", event => event.respondWith(new Response("ok")));';
  await deployWorker({ ...credentials, scriptContent });
  const metadata = JSON.parse(await state.upload.get('metadata').text());
  assert.equal(metadata.body_part, 'worker.js');
  assert.equal(metadata.main_module, undefined);
  assert.equal(await state.upload.get('worker.js').text(), scriptContent);
});

test('URL-based deployments keep downloading and installing their source', async t => {
  const source = 'export default { fetch() { return new Response("remote"); } };';
  const state = mockCloudflare(t, { source });
  await deployWorker({ ...credentials, scriptUrl });
  assert.equal(state.calls[0].url, scriptUrl);
  assert.equal(await state.upload.get('worker.js').text(), source);
});

test('local source supports obfuscation, D1, KV and clean rebuild', async t => {
  const state = mockCloudflare(t);
  const result = await deployWorker({
    ...credentials,
    scriptContent: 'export default { fetch() { return new Response("hello"); } };',
    enableObfuscation: true,
    recreateWorker: true,
    d1Name: 'existing-db', bindingName: 'DB',
    kvName: 'existing-kv', kvBindingName: 'KV',
  });
  const metadata = JSON.parse(await state.upload.get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'd1', name: 'DB', id: 'd1-id' },
    { type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id' },
  ]);
  assert.match(await state.upload.get('worker.js').text(), /func_dec\(/);
  assert.equal(result.obfuscated, true);
  assert.equal(result.recreated, true);
  const deleteIndex = state.calls.findIndex(call => call.method === 'DELETE');
  const uploadIndex = state.calls.findIndex(call => call.method === 'PUT');
  assert.ok(deleteIndex >= 0 && deleteIndex < uploadIndex);
});

test('empty or non-text local sources fail before any Cloudflare request', async t => {
  const state = mockCloudflare(t);
  for (const scriptContent of ['', ' \n\t', 42, false, {}, []]) {
    await assert.rejects(deployWorker({ ...credentials, scriptUrl, scriptContent }), /خالی|متن/);
  }
  assert.equal(state.calls.length, 0);
});

test('credentials and at least one source remain mandatory', async t => {
  const state = mockCloudflare(t);
  await assert.rejects(deployWorker(credentials), /ناقص/);
  await assert.rejects(deployWorker({ scriptContent: 'export default {};' }), /ناقص/);
  assert.equal(state.calls.length, 0);
});

test('download errors fail before upload', async t => {
  const state = mockCloudflare(t, { downloadStatus: 404 });
  await assert.rejects(deployWorker({ ...credentials, scriptUrl }), /404/);
  assert.equal(state.upload, null);
});

test('empty remote sources fail before any Cloudflare request', async t => {
  const state = mockCloudflare(t, { source: ' \n\t' });
  await assert.rejects(deployWorker({ ...credentials, scriptUrl }), /خالی/);
  assert.equal(state.calls.length, 1);
  assert.equal(state.upload, null);
});

test('JSON deployment endpoint accepts local file content', async t => {
  const state = mockCloudflare(t);
  const scriptContent = 'export default { fetch() { return new Response("local"); } };';
  const request = new Request('https://example.com/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, scriptContent }),
  });
  const response = await onRequestPost({ request });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(await state.upload.get('worker.js').text(), scriptContent);
});

test('JSON deployment endpoint rejects an empty local file', async t => {
  const state = mockCloudflare(t);
  const request = new Request('https://example.com/api/deploy', {
    method: 'POST', body: JSON.stringify({ ...credentials, scriptContent: '  ' }),
  });
  const response = await onRequestPost({ request });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
  assert.equal(state.calls.length, 0);
});
