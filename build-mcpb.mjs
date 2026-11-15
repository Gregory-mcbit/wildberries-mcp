#!/usr/bin/env node
// Builds an MCP Bundle (.mcpb, formerly DXT) for Claude Desktop: a ZIP with
// manifest.json + the local server + the offline catalog. Zero dependencies:
// the ZIP container and CRC32 are implemented here on top of node:zlib.
//
// Usage:
//   node build-mcpb.mjs                       # dist/wb-mcp.mcpb
//   node build-mcpb.mjs --out dist/wb-mcp.mcpb --catalog catalog --version 0.1.0
//   node build-mcpb.mjs --owner me --repo wb-mcp
//
// The resulting file is installed by double-click in Claude Desktop (macOS/Windows):
// Claude asks for the WB token in its UI (field is marked "sensitive").

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const has = (name) => ARGV.includes(name);
const get = (name) => {
  const i = ARGV.indexOf(name);
  return i >= 0 ? ARGV[i + 1] : undefined;
};

// Files that must be inside the bundle: the MCP server and everything it imports.
export const SERVER_FILES = [
  'server.mjs',
  'sync.mjs',
  'yaml.mjs',
  'search.mjs',
  'tokens.mjs',
  'tokenstore.mjs',
  'keyring.mjs',
  'verify.mjs',
  'package.json',
  'LICENSE',
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal ZIP writer: deflate each entry, central directory, EOCD.
export function writeZip(entries) {
  const now = new Date('2026-01-01T00:00:00Z');
  const dosTime = ((now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()) & 0xffff;

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const body = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// Minimal ZIP reader (enough for tests and validation).
export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(pos + 10);
    const crcExpected = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const body = buffer.slice(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : body;
    if (crc32(data) !== crcExpected) throw new Error(`crc mismatch for ${name}`);
    if (data.length !== uncompressedSize) throw new Error(`size mismatch for ${name}`);
    entries.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function makeManifest({ version = '0.1.0', owner = 'Gregory-mcbit', repo = 'wildberries-mcp' } = {}) {
  return {
    manifest_version: '0.4',
    name: 'wb-mcp',
    display_name: 'Wildberries MCP',
    version,
    description: 'Wildberries Seller API (13 разделов, 309 методов) для ИИ-ассистента: локально, без VPS',
    long_description:
      'Локальный MCP-сервер Wildberries Seller API. Полное покрытие официальных OpenAPI-спеков, ' +
      'поиск методов, read-only и запись раздельно, офлайн-каталог внутри бандла, ' +
      'проверка токена и сценарии (prompts) для продаж. Токен хранится в защищённом хранилище Claude, ' +
      'запросы идут только на *.wildberries.ru с твоей машины.',
    author: { name: 'Gregory-mcbit' },
    repository: { type: 'git', url: `https://github.com/${owner}/${repo}.git` },
    homepage: `https://github.com/${owner}/${repo}`,
    support: `https://github.com/${owner}/${repo}/issues`,
    server: {
      type: 'node',
      entry_point: 'server/server.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/server.mjs'],
        env: {
          WB_MCP_CATALOG: '${__dirname}/catalog',
          WB_API_TOKEN: '${user_config.wb_token}',
        },
      },
    },
    user_config: {
      wb_token: {
        type: 'string',
        title: 'WB API токен',
        description:
          'Токен из кабинета продавца: Настройки → Интеграции по API → Создать токен. ' +
          'Для начала достаточно режима «Только чтение». Токен сохраняется в защищённом хранилище Claude.',
        sensitive: true,
        required: true,
      },
    },
  };
}

export const PORTABLE_FILES = [
  ...SERVER_FILES,
  'doctor.mjs',
  'install.mjs',
  'deeplinks.mjs',
  'README.md',
  'README.en.md',
  'AGENT-INSTALL.md',
  'install.cmd',
  'install.sh',
];

async function collect(prefix, dir, files) {
  const entries = [];
  for (const name of files) {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`missing file for bundle: ${name}`);
    entries.push({ name: `${prefix}${name}`, data: await readFile(file) });
  }
  return entries;
}

export async function buildMcpb({
  outFile = path.join(HERE, 'dist', 'wb-mcp.mcpb'),
  catalogDir = path.join(HERE, 'catalog'),
  sourceDir = HERE,
  version = '0.1.0',
  owner = 'Gregory-mcbit',
  repo = 'wildberries-mcp',
} = {}) {
  if (!existsSync(path.join(catalogDir, 'index.json'))) {
    throw new Error(`catalog not found in ${catalogDir}: run "node sync.mjs" first`);
  }
  const entries = [];
  entries.push({ name: 'manifest.json', data: JSON.stringify(makeManifest({ version, owner, repo }), null, 2) });
  entries.push(...(await collect('server/', sourceDir, SERVER_FILES)));

  const catalogFiles = (await readdir(catalogDir)).filter((f) => f.endsWith('.json')).sort();
  for (const file of catalogFiles) {
    entries.push({ name: `catalog/${file}`, data: await readFile(path.join(catalogDir, file)) });
  }

  const zip = writeZip(entries);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, zip);
  const manifest = makeManifest({ version, owner, repo });
  return {
    file: outFile,
    bytes: zip.length,
    entries: entries.length,
    operations: JSON.parse(await readFile(path.join(catalogDir, 'index.json'), 'utf8')).operations.length,
    manifest,
  };
}

// Portable ZIP for users who do not use Claude Desktop: unpack → run
// install.cmd (Windows) / install.sh (macOS/Linux) → installer does the rest.
export async function buildPortableZip({
  outFile = path.join(HERE, 'dist', 'wb-mcp-portable.zip'),
  catalogDir = path.join(HERE, 'catalog'),
  sourceDir = HERE,
} = {}) {
  if (!existsSync(path.join(catalogDir, 'index.json'))) {
    throw new Error(`catalog not found in ${catalogDir}: run "node sync.mjs" first`);
  }
  const entries = [];
  for (const file of PORTABLE_FILES) {
    const full = path.join(sourceDir, file);
    if (!existsSync(full)) throw new Error(`missing file for portable zip: ${file}`);
    entries.push({ name: file, data: await readFile(full) });
  }
  const skill = path.join(sourceDir, 'skills', 'wb-mcp', 'SKILL.md');
  if (existsSync(skill)) entries.push({ name: 'skills/wb-mcp/SKILL.md', data: await readFile(skill) });
  for (const file of (await readdir(catalogDir)).filter((f) => f.endsWith('.json')).sort()) {
    entries.push({ name: `catalog/${file}`, data: await readFile(path.join(catalogDir, file)) });
  }
  const zip = writeZip(entries);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, zip);
  return { file: outFile, bytes: zip.length, entries: entries.length };
}

async function main() {
  try {
    const result = await buildMcpb({
      outFile: get('--out') ?? path.join(HERE, 'dist', 'wb-mcp.mcpb'),
      catalogDir: get('--catalog') ?? path.join(HERE, 'catalog'),
      version: get('--version') ?? JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8')).version,
      owner: get('--owner') ?? 'Gregory-mcbit',
      repo: get('--repo') ?? 'wildberries-mcp',
    });
    console.log(JSON.stringify({ file: result.file, bytes: result.bytes, entries: result.entries, operations: result.operations }, null, 2));
    if (has('--portable')) {
      const portable = await buildPortableZip({
        outFile: get('--portable-out') ?? path.join(HERE, 'dist', 'wb-mcp-portable.zip'),
        catalogDir: get('--catalog') ?? path.join(HERE, 'catalog'),
      });
      console.log(JSON.stringify({ portable: portable.file, bytes: portable.bytes, entries: portable.entries }, null, 2));
    }
  } catch (err) {
    console.error(`mcpb build failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
