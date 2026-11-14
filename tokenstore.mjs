// Encrypted local token storage for CLI MCP clients.
//
// Goal: the WB API token must not sit in a client config JSON in plaintext.
// The installer writes an AES-256-GCM blob (~/.wb-mcp/token.enc) and only puts
// the *path* into the client config (WB_TOKEN_FILE). The server decrypts it at
// startup. The key lives in a separate file with owner-only permissions.
//
// Honest limits: this protects against accidental config leaks (screenshots,
// synced dotfiles, pasted configs, git). It is not protection against malware
// running as the same OS user — no zero-dependency scheme can provide that.
// The OS keychain could be added later per-platform.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';

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

// Encrypts `token` into `file` (JSON: {v, alg, iv, tag, data}) and creates the
// key file if it does not exist yet.
export function saveTokenToFile(token, { file, keyFile = defaultKeyFile(file) } = {}) {
  if (!token || typeof token !== 'string') throw new Error('token must be a non-empty string');
  if (!file) throw new Error('token file path is required');
  ensureDir(file);
  ensureDir(keyFile);
  let key;
  if (existsSync(keyFile)) {
    key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`key file ${keyFile} is corrupted (expected 32 bytes)`);
  } else {
    key = randomBytes(32);
    writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600 });
    restrict(keyFile);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = { v: 1, alg: ALG, iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  writeFileSync(file, JSON.stringify(payload) + '\n', { mode: 0o600 });
  restrict(file);
  return { file, keyFile };
}

export function loadTokenFromFile(file, { keyFile = defaultKeyFile(file) } = {}) {
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
  const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`token file ${file} cannot be decrypted (wrong key or tampered data)`);
  }
}
