// Tests for the encrypted local token storage and its integration with env.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTokenFromFile, saveTokenToFile } from '../tokenstore.mjs';
import { loadTokenAccounts } from '../tokens.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhY2MiOjEsImV4cCI6OTk5OTk5OTk5OSwic2lkIjoic2VlbGxlciIsInMiOjJ9.sig';

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

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-token-'));
  const tokenFile = path.join(tmp, 'token.enc');
  const keyFile = path.join(tmp, 'token.key');
  try {
    await test('save/load: токен шифруется и расшифровывается', async () => {
      const saved = saveTokenToFile(TOKEN, { file: tokenFile, keyFile });
      assert.equal(saved.file, tokenFile);
      const raw = await readFile(tokenFile, 'utf8');
      assert.ok(!raw.includes(TOKEN), 'токен не лежит в файле открытым текстом');
      const payload = JSON.parse(raw);
      assert.equal(payload.alg, 'aes-256-gcm');
      assert.ok(payload.iv && payload.tag && payload.data);
      assert.equal(loadTokenFromFile(tokenFile, { keyFile }), TOKEN);
    });

    await test('ключ создаётся один раз и переиспользуется', async () => {
      const keyBefore = await readFile(keyFile, 'utf8');
      saveTokenToFile(`${TOKEN}-2`, { file: tokenFile, keyFile });
      assert.equal((await readFile(keyFile, 'utf8')).trim(), keyBefore.trim(), 'ключ не меняется');
      assert.equal(loadTokenFromFile(tokenFile, { keyFile }), `${TOKEN}-2`);
    });

    await test('подмена данных/чужой ключ не расшифровываются', async () => {
      const payload = JSON.parse(await readFile(tokenFile, 'utf8'));
      const tampered = { ...payload, data: Buffer.from('hacked').toString('base64') };
      await writeFile(tokenFile, JSON.stringify(tampered));
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile }), /cannot be decrypted/);

      saveTokenToFile(TOKEN, { file: tokenFile, keyFile });
      const otherKey = path.join(tmp, 'other.key');
      await writeFile(otherKey, Buffer.alloc(32, 7).toString('base64'));
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile: otherKey }), /cannot be decrypted/);
    });

    await test('понятные ошибки: нет файла, нет ключа, битый JSON', async () => {
      assert.throws(() => loadTokenFromFile(path.join(tmp, 'nope.enc'), { keyFile }), /not found/);
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile: path.join(tmp, 'nope.key') }), /key not found/);
      await writeFile(tokenFile, 'not-json');
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile }), /not valid JSON/);
    });

    await test('loadTokenAccounts: WB_TOKEN_FILE даёт токен, ошибки не теряются', async () => {
      const goodFile = path.join(tmp, 'good.enc');
      const goodKey = path.join(tmp, 'good.key');
      saveTokenToFile(TOKEN, { file: goodFile, keyFile: goodKey });
      const ok = loadTokenAccounts({ WB_TOKEN_FILE: goodFile, WB_TOKEN_KEY: goodKey });
      assert.equal(ok.accounts.get('default'), TOKEN);
      assert.deepEqual(ok.errors, []);

      const bad = loadTokenAccounts({ WB_TOKEN_FILE: path.join(tmp, 'broken.enc'), WB_TOKEN_KEY: goodKey });
      assert.equal(bad.accounts.size, 0);
      assert.equal(bad.errors.length, 1);
      assert.ok(bad.errors[0].includes('WB_TOKEN_FILE'));

      const wrongKey = loadTokenAccounts({ WB_TOKEN_FILE: goodFile, WB_TOKEN_KEY: path.join(tmp, 'nope.key') });
      assert.equal(wrongKey.accounts.size, 0);
      assert.ok(wrongKey.errors[0].includes('key not found'));
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
