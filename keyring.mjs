// OS-keyring integration for the local token key (zero dependencies).
//
// Windows: the key is protected with DPAPI (CurrentUser), so the file on disk is
//          a DPAPI blob readable only by this Windows user on this machine.
// macOS/Linux: falls back to a plain file key with a warning — the OS keychain
//          (`security` / libsecret) can be added per-platform later.
//
// `protectKey` / `unprotectKey` operate on the raw 32-byte AES key and return a
// `{ scheme, data }` blob that the caller stores on disk.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const WIN_DPAPI = (b64, verb) =>
  `Add-Type -AssemblyName System.Security;` +
  `$b=[Convert]::FromBase64String('${b64}');` +
  `$x=[System.Security.Cryptography.ProtectedData]::${verb}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Convert]::ToBase64String($x)`;

export function generateKey() {
  return randomBytes(32);
}

export function protectKey(key, { warn = console.error } = {}) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  if (buf.length !== 32) throw new Error('keyring: ключ должен быть 32 байта');
  if (process.platform === 'win32') {
    return { scheme: 'dpapi', data: runWinPs(WIN_DPAPI(buf.toString('base64'), 'Protect')) };
  }
  warn('keyring: системный keychain недоступен на этой платформе — ключ хранится в файле рядом с данными (от чтения под тем же пользователем не защищает)');
  return { scheme: 'file', data: buf.toString('base64') };
}

export function unprotectKey(blob) {
  if (!blob || typeof blob !== 'object' || typeof blob.scheme !== 'string') {
    throw new Error('keyring: некорректный блоб ключа');
  }
  if (blob.scheme === 'dpapi') return Buffer.from(runWinPs(WIN_DPAPI(String(blob.data), 'Unprotect')), 'base64');
  if (blob.scheme === 'file') return Buffer.from(String(blob.data), 'base64');
  throw new Error(`keyring: неизвестная схема ключа: ${blob.scheme}`);
}

function runWinPs(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`keyring: не удалось запустить powershell.exe: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`keyring: powershell завершился с ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  const out = lines.filter(Boolean).pop();
  if (!out) throw new Error('keyring: пустой ответ от powershell');
  return out.trim();
}
