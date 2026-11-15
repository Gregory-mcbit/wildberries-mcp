// Tests for doctor.mjs: no real network, no real client configs required.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../sync.mjs';
import { runDoctor } from '../doctor.mjs';
import { saveTokenToFile } from '../tokenstore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
const RW_TOKEN = makeJwt({ acc: 1, sid: 'seller', exp: Math.floor(Date.now() / 1000) + 30 * 86_400, s: (1 << 13) | (1 << 1) });
const RO_TOKEN = makeJwt({
  acc: 1,
  sid: 'seller',
  exp: Math.floor(Date.now() / 1000) + 30 * 86_400,
  s: (1 << 30) | (1 << 13),
});

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`FAIL ${name}`);
    console.error(err?.stack ?? err);
  }
}

const okFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
const failFetch = async () => {
  throw new Error('getaddrinfo ENOTFOUND');
};
const checkById = (report, id) => report.checks.find((c) => c.id === id);

// Deterministic file-scheme keyring: keeps this test independent of PowerShell /
// OS keychain availability (CI may run in a restricted environment).
const fileKeyring = {
  generateKey: () => Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  protectKey: (key) => ({ scheme: 'file', data: key.toString('base64') }),
  unprotectKey: (blob) => Buffer.from(blob.data, 'base64'),
};

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-doctor-'));
  const catalogDir = path.join(tmp, 'catalog');
  try {
    await buildCatalog({ fromDir: path.join(ROOT, 'test', 'specs-sample'), outDir: catalogDir, verbose: false });

    await test('здоровый сценарий: catalog ok, token ok, сеть ok', async () => {
      const report = await runDoctor({
        env: { WB_MCP_CATALOG: catalogDir, WB_API_TOKEN: RW_TOKEN },
        fetchImpl: okFetch,
      });
      assert.equal(checkById(report, 'node').status, 'ok');
      assert.equal(checkById(report, 'catalog').status, 'ok');
      assert.equal(checkById(report, 'token').status, 'ok');
      assert.equal(checkById(report, 'network-wb').status, 'ok');
      assert.equal(checkById(report, 'network-github').status, 'ok');
      assert.equal(report.healthy, true);
      assert.ok(report.summary.ok >= 4);
    });

    await test('без токена: warn, но не fail', async () => {
      const report = await runDoctor({ env: { WB_MCP_CATALOG: catalogDir }, fetchImpl: okFetch });
      assert.equal(checkById(report, 'token').status, 'warn');
      assert.equal(report.healthy, true);
    });

    await test('зашифрованный токен: doctor не падает и показывает схему ключа', async () => {
      const encFile = path.join(tmp, 'token.enc');
      const keyFile = path.join(tmp, 'token.key');
      saveTokenToFile(RW_TOKEN, { file: encFile, keyFile, keyring: fileKeyring });
      const report = await runDoctor({
        env: { WB_MCP_CATALOG: catalogDir, WB_TOKEN_FILE: encFile, WB_TOKEN_KEY: keyFile },
        fetchImpl: okFetch,
        keyring: fileKeyring,
      });
      const token = checkById(report, 'token');
      assert.equal(token.status, 'ok', token.detail);
      assert.ok(token.detail.includes('ключ'), `detail содержит схему ключа: ${token.detail}`);
    });

    await test('read-only токен: warn с подсказкой', async () => {
      const report = await runDoctor({ env: { WB_MCP_CATALOG: catalogDir, WB_API_TOKEN: RO_TOKEN }, fetchImpl: okFetch });
      assert.equal(checkById(report, 'token').status, 'warn');
      assert.ok(checkById(report, 'token').detail.includes('только чтение'));
    });

    await test('битый токен: fail', async () => {
      const report = await runDoctor({ env: { WB_MCP_CATALOG: catalogDir, WB_API_TOKEN: 'not-a-jwt' }, fetchImpl: okFetch });
      assert.equal(checkById(report, 'token').status, 'fail');
      assert.equal(report.healthy, false);
    });

    await test('нет сети: network-проверки fail, healthy false', async () => {
      const report = await runDoctor({ env: { WB_MCP_CATALOG: catalogDir, WB_API_TOKEN: RW_TOKEN }, fetchImpl: failFetch });
      assert.equal(checkById(report, 'network-wb').status, 'fail');
      assert.equal(checkById(report, 'network-github').status, 'fail');
      assert.equal(report.healthy, false);
    });

    await test('устаревший каталог: warn с подсказкой wb_refresh', async () => {
      const staleDir = path.join(tmp, 'catalog-stale');
      await buildCatalog({ fromDir: path.join(ROOT, 'test', 'specs-sample'), outDir: staleDir, verbose: false });
      const indexFile = path.join(staleDir, 'index.json');
      const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(indexFile, 'utf8'));
      parsed.meta.generatedAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
      await (await import('node:fs/promises')).writeFile(indexFile, JSON.stringify(parsed));
      const report = await runDoctor({
        env: { WB_MCP_CATALOG: staleDir, WB_API_TOKEN: RW_TOKEN },
        fetchImpl: okFetch,
        includeDefaultCatalog: false,
      });
      const catalog = checkById(report, 'catalog');
      assert.equal(catalog.status, 'warn');
      assert.equal(catalog.stale, true);
      assert.ok(catalog.detail.includes('wb_refresh'), catalog.detail);
    });

    await test('нет каталога: fail с подсказкой про sync', async () => {
      const report = await runDoctor({
        env: { WB_MCP_CATALOG: path.join(tmp, 'nope'), WB_API_TOKEN: RW_TOKEN },
        fetchImpl: okFetch,
        includeDefaultCatalog: false,
      });
      assert.equal(checkById(report, 'catalog').status, 'fail');
      assert.ok(checkById(report, 'catalog').detail.includes('sync.mjs'));
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const { name, err } of failures) console.error(`\n--- ${name} ---\n${err?.stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test harness failed:', err);
  process.exit(1);
});
