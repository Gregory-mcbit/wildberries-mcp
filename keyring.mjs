// OS-keyring integration for the local token key (zero dependencies).
//
// Windows: DPAPI (CurrentUser) — the blob on disk is readable only by this user
//          on this machine.
// macOS:   Keychain via `security` — the key is stored in the login keychain,
//          and the on-disk `data` field only records the keychain account name.
// Linux:   libsecret via `secret-tool` (falls back to a plain file if the
//          Secret Service / secret-tool is unavailable).
//
// `protectKey` / `unprotectKey` operate on the raw 32-byte AES key and return a
// `{ scheme, data }` blob that the caller stores on disk. Pass `id` (the key
// file path) so Keychain/libsecret can derive a stable account name.

import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

const SERVICE = 'wb-mcp';

const WIN_DPAPI = (b64, verb) =>
  `Add-Type -AssemblyName System.Security;` +
  `$b=[Convert]::FromBase64String('${b64}');` +
  `$x=[System.Security.Cryptography.ProtectedData]::${verb}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Convert]::ToBase64String($x)`;

export function generateKey() {
  return randomBytes(32);
}

function accountFor(id) {
  return 'wb-mcp-' + createHash('sha256').update(String(id ?? 'default')).digest('hex').slice(0, 24);
}

function run(bin, args, { input } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', input, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  if (result.error) return { ok: false, err: result.error.message };
  if (result.status !== 0) return { ok: false, err: (result.stderr || result.stdout || '').trim() };
  return { ok: true, stdout: (result.stdout || '').trim() };
}

export function protectKey(key, { id, warn = console.error } = {}) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  if (buf.length !== 32) throw new Error('keyring: ключ должен быть 32 байта');

  if (process.platform === 'win32') {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_DPAPI(buf.toString('base64'), 'Protect')]);
    if (!r.ok) throw new Error(`keyring: DPAPI не сработал: ${r.err}`);
    return { scheme: 'dpapi', data: r.stdout };
  }

  if (process.platform === 'darwin') {
    const account = accountFor(id);
    run('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
    const add = run('security', ['add-generic-password', '-U', '-a', account, '-s', SERVICE, '-w', buf.toString('base64')]);
    if (add.ok) return { scheme: 'keychain', data: account };
    warn(`keyring: Keychain недоступен (${add.err}) — ключ хранится в файле рядом с данными`);
    return { scheme: 'file', data: buf.toString('base64') };
  }

  if (process.platform === 'linux') {
    const account = accountFor(id);
    const store = run('secret-tool', ['store', '--label', SERVICE, 'service', SERVICE, 'account', account], { input: buf.toString('base64') });
    if (store.ok) return { scheme: 'libsecret', data: account };
    warn(`keyring: secret-tool (libsecret) недоступен (${store.err}) — ключ хранится в файле рядом с данными`);
    return { scheme: 'file', data: buf.toString('base64') };
  }

  warn(`keyring: платформа ${process.platform} не поддерживается — ключ хранится в файле рядом с данными`);
  return { scheme: 'file', data: buf.toString('base64') };
}

export function unprotectKey(blob, { id, warn = console.error } = {}) {
  if (!blob || typeof blob !== 'object' || typeof blob.scheme !== 'string') {
    throw new Error('keyring: некорректный блоб ключа');
  }
  if (blob.scheme === 'dpapi') {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_DPAPI(String(blob.data), 'Unprotect')]);
    if (!r.ok) throw new Error(`keyring: DPAPI не расшифровал ключ: ${r.err}`);
    return Buffer.from(r.stdout, 'base64');
  }
  if (blob.scheme === 'keychain') {
    const r = run('security', ['find-generic-password', '-w', '-a', String(blob.data), '-s', SERVICE]);
    if (!r.ok) throw new Error(`keyring: не удалось прочитать ключ из Keychain: ${r.err}`);
    return Buffer.from(r.stdout, 'base64');
  }
  if (blob.scheme === 'libsecret') {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', String(blob.data)]);
    if (!r.ok) throw new Error(`keyring: не удалось прочитать ключ из libsecret: ${r.err}`);
    return Buffer.from(r.stdout, 'base64');
  }
  if (blob.scheme === 'file') return Buffer.from(String(blob.data), 'base64');
  throw new Error(`keyring: неизвестная схема ключа: ${blob.scheme}`);
}
