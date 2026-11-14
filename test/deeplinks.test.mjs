// Tests for one-click deeplinks (Cursor / VS Code).

import assert from 'node:assert/strict';
import { makeDeeplinks, makeNpxConfig, parseDeeplink, TOKEN_PLACEHOLDER } from '../deeplinks.mjs';

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`FAIL ${name}`);
    console.error(err?.stack ?? err);
  }
}

test('npx-конфиг: github-пакет, авто-каталог и плейсхолдер токена', () => {
  const config = makeNpxConfig({ owner: 'tester', repo: 'wb-mcp' });
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, ['-y', '-p', 'github:tester/wb-mcp', 'wb-mcp']);
  assert.equal(config.env.WB_AUTO_SYNC, '1');
  assert.equal(config.env.WB_API_TOKEN, TOKEN_PLACEHOLDER);
  assert.ok(!JSON.stringify(config).includes('eyJ'), 'реального токена в ссылке нет');
});

test('дееплинки: Cursor и VS Code кодируют один и тот же конфиг', () => {
  const links = makeDeeplinks({ owner: 'tester', repo: 'wb-mcp' });
  assert.ok(links.cursor.startsWith('https://cursor.com/install-mcp?'));
  assert.ok(links.vscode.startsWith('vscode:mcp/install?'));

  const cursor = parseDeeplink(links.cursor);
  assert.equal(cursor.client, 'cursor');
  assert.equal(cursor.name, 'wb');
  assert.equal(cursor.config.command, 'npx');
  assert.deepEqual(cursor.config.args, links.config.args);

  const vscode = parseDeeplink(links.vscode);
  assert.equal(vscode.client, 'vscode');
  assert.equal(vscode.config.env.WB_AUTO_SYNC, '1');

  const configInLink = JSON.parse(Buffer.from(new URL(links.cursor).searchParams.get('config'), 'base64').toString('utf8'));
  assert.deepEqual(configInLink.args, links.config.args);
  assert.ok(configInLink.args.includes('github:tester/wb-mcp'));
});

test('неизвестный формат ссылки — ошибка', () => {
  assert.throws(() => parseDeeplink('https://example.com/nope'), /unknown deeplink/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, err } of failures) console.error(`\n--- ${name} ---\n${err?.stack ?? err}`);
  process.exit(1);
}
