// Tests for the encrypted local token storage and its integration with env.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTokenFromFile, saveTokenToFile } from '../tokenstore.mjs';
import { loadTokenAccounts } from '../tokens.mjs';
import { generateKey } from '../keyring.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhY2MiOjEsImV4cCI6OTk5OTk5OTk5OSwic2lkIjoic2VlbGxlciIsInMiOjJ9.sig';

// In-memory keyring stand-in (behaves like the DPAPI scheme without spawning
// powershell), so the tests run offline on every OS and prove the key is not
// written to disk in the clear.
const fakeKeyring = {
  generateKey: () => Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  protectKey: (key) => ({ scheme: 'dpapi', data: Buffer.concat([Buffer.from('DPAPI:'), key]).toString('base64') }),
  unprotectKey: (blob) => Buffer.from(Buffer.from(blob.data, 'base64').toString('utf8').slice('DPAPI:'.length), 'utf8'),
};

// File-scheme keyring: used where the reader is the real default keyring
// (loadTokenAccounts), which must not spawn powershell in tests.
const fileKeyring = {
  generateKey: () => Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  protectKey: (key) => ({ scheme: 'file', data: key.toString('base64') }),
  unprotectKey: (blob) => Buffer.from(blob.data, 'base64'),
};

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
      const saved = saveTokenToFile(TOKEN, { file: tokenFile, keyFile, keyring: fakeKeyring });
      assert.equal(saved.file, tokenFile);
      const raw = await readFile(tokenFile, 'utf8');
      assert.ok(!raw.includes(TOKEN), 'токен не лежит в файле открытым текстом');
      const payload = JSON.parse(raw);
      assert.equal(payload.alg, 'aes-256-gcm');
      assert.ok(payload.iv && payload.tag && payload.data);
      assert.equal(loadTokenFromFile(tokenFile, { keyFile, keyring: fakeKeyring }), TOKEN);
    });

    await test('ключ хранится не в открытом виде (keyring-блоб)', async () => {
      const keyRaw = await readFile(keyFile, 'utf8');
      const keyJson = JSON.parse(keyRaw);
      assert.equal(keyJson.scheme, 'dpapi');
      assert.ok(!keyRaw.includes('0123456789abcdef'), 'сырой ключ не записан в файл ключа');
      const plain = Buffer.from(fakeKeyring.generateKey());
      const blob = fakeKeyring.protectKey(plain);
      assert.deepEqual(fakeKeyring.unprotectKey(blob), plain, 'keyring round-trip');
    });

    await test('ключ создаётся один раз и переиспользуется', async () => {
      const keyBefore = await readFile(keyFile, 'utf8');
      saveTokenToFile(`${TOKEN}-2`, { file: tokenFile, keyFile, keyring: fakeKeyring });
      assert.equal((await readFile(keyFile, 'utf8')).trim(), keyBefore.trim(), 'ключ не меняется');
      assert.equal(loadTokenFromFile(tokenFile, { keyFile, keyring: fakeKeyring }), `${TOKEN}-2`);
    });

    await test('подмена данных/чужой ключ не расшифровываются', async () => {
      const payload = JSON.parse(await readFile(tokenFile, 'utf8'));
      const tampered = { ...payload, data: Buffer.from('hacked').toString('base64') };
      await writeFile(tokenFile, JSON.stringify(tampered));
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile, keyring: fakeKeyring }), /cannot be decrypted/);

      saveTokenToFile(TOKEN, { file: tokenFile, keyFile, keyring: fakeKeyring });
      const otherKey = path.join(tmp, 'other.key');
      await writeFile(otherKey, Buffer.alloc(32, 7).toString('base64'));
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile: otherKey, keyring: fakeKeyring }), /cannot be decrypted/);
    });

    await test('понятные ошибки: нет файла, нет ключа, битый JSON', async () => {
      assert.throws(() => loadTokenFromFile(path.join(tmp, 'nope.enc'), { keyFile, keyring: fakeKeyring }), /not found/);
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile: path.join(tmp, 'nope.key'), keyring: fakeKeyring }), /key not found/);
      await writeFile(tokenFile, 'not-json');
      assert.throws(() => loadTokenFromFile(tokenFile, { keyFile, keyring: fakeKeyring }), /not valid JSON/);
    });

    await test('loadTokenAccounts: WB_TOKEN_FILE даёт токен, ошибки не теряются', async () => {
      const goodFile = path.join(tmp, 'good.enc');
      const goodKey = path.join(tmp, 'good.key');
      saveTokenToFile(TOKEN, { file: goodFile, keyFile: goodKey, keyring: fileKeyring });
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

    await test('keyring.generateKey возвращает 32 байта', async () => {
      const k = generateKey();
      assert.ok(Buffer.isBuffer(k) && k.length === 32);
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
