// Encrypted local token storage for CLI MCP clients.
//
// Goal: the WB API token must not sit in a client config JSON in plaintext.
// The installer writes an AES-256-GCM blob (~/.wb-mcp/token.enc) and only puts
// the *path* into the client config (WB_TOKEN_FILE). The server decrypts it at
// startup. The 32-byte AES key is protected by the OS keyring (DPAPI on Windows;
// see keyring.mjs) and stored as a blob in `token.key`.
//
// Honest limits: this protects against accidental config leaks (screenshots,
// synced dotfiles, pasted configs, git). It is not protection against malware
// running as the same OS user — no zero-dependency scheme can provide that.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import * as defaultKeyring from './keyring.mjs';

const ALG = 'aes-256-gcm';

function ensureDir(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function restrict(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows mostly ignores POSIX modes; ACLs are managed by the user profile.
  }
}

export function defaultKeyFile(tokenFile) {
  return path.join(path.dirname(tokenFile), 'token.key');
}

function readKey(keyFile, keyring) {
  const text = readFileSync(keyFile, 'utf8').trim();
  if (text.startsWith('{')) {
    let blob;
    try {
      blob = JSON.parse(text);
    } catch {
      throw new Error(`key file ${keyFile} is not valid JSON`);
    }
    return keyring.unprotectKey(blob, { id: keyFile });
  }
  // Legacy key file: a raw base64 32-byte key from older versions.
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error(`key file ${keyFile} is corrupted (expected 32 bytes)`);
  return key;
}

function writeKey(keyFile, key, keyring) {
  const blob = keyring.protectKey(key, { id: keyFile });
  writeFileSync(keyFile, JSON.stringify({ v: 1, scheme: blob.scheme, data: blob.data }) + '\n', { mode: 0o600 });
  restrict(keyFile);
}

// Best-effort upgrade of a legacy raw key file to a keyring-protected blob.
function migrateKeyIfLegacy(keyFile, keyring) {
  try {
    const text = readFileSync(keyFile, 'utf8').trim();
    if (text.startsWith('{')) return;
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32) return;
    writeKey(keyFile, key, keyring);
  } catch {
    // Leaving a legacy raw key is still functional; migration is best-effort.
  }
}

// Encrypts `token` into `file` (JSON: {v, alg, iv, tag, data}) and creates the
// key file (keyring-protected) if it does not exist yet.
export function saveTokenToFile(token, { file, keyFile = defaultKeyFile(file), keyring = defaultKeyring } = {}) {
  if (!token || typeof token !== 'string') throw new Error('token must be a non-empty string');
  if (!file) throw new Error('token file path is required');
  ensureDir(file);
  ensureDir(keyFile);
  let key;
  if (existsSync(keyFile)) {
    key = readKey(keyFile, keyring);
  } else {
    key = keyring.generateKey();
    writeKey(keyFile, key, keyring);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = { v: 1, alg: ALG, iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  writeFileSync(file, JSON.stringify(payload) + '\n', { mode: 0o600 });
  restrict(file);
  migrateKeyIfLegacy(keyFile, keyring);
  return { file, keyFile };
}

export function loadTokenFromFile(file, { keyFile = defaultKeyFile(file), keyring = defaultKeyring } = {}) {
  if (!file) throw new Error('token file path is required');
  if (!existsSync(file)) throw new Error(`token file not found: ${file}`);
  if (!existsSync(keyFile)) throw new Error(`token key not found: ${keyFile}`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`token file ${file} is not valid JSON: ${err.message}`);
  }
  if (payload?.v !== 1 || payload?.alg !== ALG) throw new Error(`token file ${file} has unsupported format`);
  const key = readKey(keyFile, keyring);
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    migrateKeyIfLegacy(keyFile, keyring);
    return token;
  } catch {
    throw new Error(`token file ${file} cannot be decrypted (wrong key or tampered data)`);
  }
}
