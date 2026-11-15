// Encrypted local token storage for CLI MCP clients.
//
// Goal: the WB API token must not sit in a client config JSON in plaintext.
// The installer writes an AES-256-GCM blob (~/.wb-mcp/token.enc) and only puts
// the *path* into the client config (WB_TOKEN_FILE). The server decrypts it at
// startup. The 32-byte AES key is protected by the OS keyring (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux; see keyring.mjs) and stored as a blob
// in `token.key`.
//
// Set WB_KEYRING=require to refuse a plain-file fallback (fails instead of
// silently using weaker storage). Migration of legacy raw keys and of a `file`
// scheme to the system keyring is best-effort and reported through `onWarn`.
//
// Honest limits: no scheme protects against malware running as the same OS user.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import * as defaultKeyring from './keyring.mjs';

const ALG = 'aes-256-gcm';

function ensureDir(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function restrict(file, { onWarn } = {}) {
  try {
    chmodSync(file, 0o600);
  } catch (err) {
    if (typeof onWarn === 'function') onWarn(`не удалось ограничить права на ${file}: ${err.message}`);
  }
}

export function defaultKeyFile(tokenFile) {
  return path.join(path.dirname(tokenFile), 'token.key');
}

function opts(defaults, extra) {
  return {
    require: extra?.require ?? process.env.WB_KEYRING === 'require',
    onWarn: extra?.onWarn ?? defaults?.onWarn,
  };
}

function readKey(keyFile, keyring, { require, onWarn }) {
  const text = readFileSync(keyFile, 'utf8').trim();
  if (text.startsWith('{')) {
    let blob;
    try {
      blob = JSON.parse(text);
    } catch {
      throw new Error(`key file ${keyFile} is not valid JSON`);
    }
    return keyring.unprotectKey(blob, { id: keyFile, require });
  }
  // Legacy key file: a raw base64 32-byte key from older versions.
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error(`key file ${keyFile} is corrupted (expected 32 bytes)`);
  return key;
}

function writeKey(keyFile, key, keyring, { require }) {
  const blob = keyring.protectKey(key, { id: keyFile, require });
  writeFileSync(keyFile, JSON.stringify({ v: 1, scheme: blob.scheme, data: blob.data }) + '\n', { mode: 0o600 });
  restrict(keyFile);
}

// Best-effort upgrade of a legacy raw key or a `file`-scheme key to the system
// keyring. Failures are reported (never silently swallowed) through onWarn.
function migrateKeyIfLegacy(keyFile, keyring, { require, onWarn }) {
  try {
    const text = readFileSync(keyFile, 'utf8').trim();
    let key;
    if (text.startsWith('{')) {
      const blob = JSON.parse(text);
      if (blob.scheme !== 'file') return; // already protected by the system keyring
      key = keyring.unprotectKey(blob, { id: keyFile });
    } else {
      key = Buffer.from(text, 'base64');
      if (key.length !== 32) return;
    }
    const upgraded = keyring.protectKey(key, { id: keyFile, require: false });
    if (upgraded.scheme !== 'file') writeKey(keyFile, key, keyring, { require });
  } catch (err) {
    if (typeof onWarn === 'function') onWarn(`миграция защиты ключа ${keyFile} не удалась: ${err.message}`);
  }
}

export function keySchemeOf(keyFile) {
  try {
    const text = readFileSync(keyFile, 'utf8').trim();
    if (text.startsWith('{')) return JSON.parse(text).scheme ?? 'unknown';
    return 'raw';
  } catch {
    return 'missing';
  }
}

// Encrypts `token` into `file` (JSON: {v, alg, iv, tag, data}) and creates the
// key file (keyring-protected) if it does not exist yet.
export function saveTokenToFile(token, { file, keyFile = defaultKeyFile(file), keyring = defaultKeyring, ...extra } = {}) {
  if (!token || typeof token !== 'string') throw new Error('token must be a non-empty string');
  if (!file) throw new Error('token file path is required');
  const { require, onWarn } = opts(extra, extra);
  ensureDir(file);
  ensureDir(keyFile);
  let key;
  if (existsSync(keyFile)) {
    key = readKey(keyFile, keyring, { require, onWarn });
  } else {
    key = keyring.generateKey();
    writeKey(keyFile, key, keyring, { require });
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = { v: 1, alg: ALG, iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  writeFileSync(file, JSON.stringify(payload) + '\n', { mode: 0o600 });
  restrict(file, { onWarn });
  migrateKeyIfLegacy(keyFile, keyring, { require, onWarn });
  return { file, keyFile };
}

export function loadTokenFromFile(file, { keyFile = defaultKeyFile(file), keyring = defaultKeyring, ...extra } = {}) {
  if (!file) throw new Error('token file path is required');
  if (!existsSync(file)) throw new Error(`token file not found: ${file}`);
  if (!existsSync(keyFile)) throw new Error(`token key not found: ${keyFile}`);
  const { require, onWarn } = opts(extra, extra);
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`token file ${file} is not valid JSON: ${err.message}`);
  }
  if (payload?.v !== 1 || payload?.alg !== ALG) throw new Error(`token file ${file} has unsupported format`);
  const key = readKey(keyFile, keyring, { require, onWarn });
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    migrateKeyIfLegacy(keyFile, keyring, { require, onWarn });
    return token;
  } catch {
    throw new Error(`token file ${file} cannot be decrypted (wrong key or tampered data)`);
  }
}
