import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../.github/scripts/check-deploy-config.sh', import.meta.url));

function checkConfig(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jasaz-deploy-config-'));
  const output = join(directory, 'output');
  try {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
        CLOUDFLARE_API_TOKEN: 'test-cloudflare-token',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_SECRET_TOKEN: '',
        ...overrides,
        GITHUB_OUTPUT: output,
      },
    });
    assert.ifError(result.error);
    return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('missing Cloudflare credentials fail with the exact required secret names', () => {
  const result = checkConfig({ CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error.*CLOUDFLARE_ACCOUNT_ID/);
  assert.match(result.stdout, /::error.*CLOUDFLARE_API_TOKEN/);
  assert.match(result.stdout, /Repository secrets/);
  assert.equal(result.output, '');
});

test('both Cloudflare credentials are required even when Telegram is configured', () => {
  for (const secret of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    const result = checkConfig({ [secret]: '', TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_SECRET_TOKEN: 'test-bot-secret' });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(secret));
    assert.equal(result.output, '');
  }
});

test('the web app can deploy with only the Cloudflare credentials', () => {
  const result = checkConfig();
  assert.equal(result.status, 0);
  assert.equal(result.output, 'telegram_enabled=false\n');
  assert.match(result.stdout, /Telegram setup skipped/);
  assert.doesNotMatch(result.stdout, /::error/);
});

test('partially configured Telegram skips the optional bot', () => {
  for (const secret of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_SECRET_TOKEN']) {
    const result = checkConfig({ [secret]: 'test-telegram-value' });
    assert.equal(result.status, 0);
    assert.equal(result.output, 'telegram_enabled=false\n');
    assert.match(result.stdout, /Telegram setup skipped/);
  }
});

test('both Telegram credentials enable secret synchronization and webhook setup', () => {
  const result = checkConfig({ TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_SECRET_TOKEN: 'test-bot-secret' });
  assert.equal(result.status, 0);
  assert.equal(result.output, 'telegram_enabled=true\n');
  assert.doesNotMatch(result.stdout, /Telegram setup skipped/);
});

test('configuration checks never print credential values', () => {
  const result = checkConfig({ TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_SECRET_TOKEN: 'test-bot-secret' });
  const logs = result.stdout + result.stderr;
  for (const value of ['test-account-id', 'test-cloudflare-token', 'test-bot-token', 'test-bot-secret']) {
    assert.equal(logs.includes(value), false);
  }
});
