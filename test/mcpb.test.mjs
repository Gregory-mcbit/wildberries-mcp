// Tests for the .mcpb (MCP Bundle) builder: ZIP writer/reader, manifest and
// bundle content for Claude Desktop.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../sync.mjs';
import { buildMcpb, buildPortableZip, makeManifest, readZipEntries, writeZip, crc32, SERVER_FILES } from '../build-mcpb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-mcpb-'));
  const catalogDir = path.join(tmp, 'catalog');
  try {
    await buildCatalog({ fromDir: path.join(ROOT, 'test', 'specs-sample'), outDir: catalogDir, verbose: false });

    await test('ZIP writer/reader: содержимое, CRC и сжатие', async () => {
      const entries = [
        { name: 'a.txt', data: 'hello '.repeat(200) },
        { name: 'dir/b.json', data: JSON.stringify({ x: 1 }) },
      ];
      const zip = writeZip(entries);
      const back = readZipEntries(zip);
      assert.equal(back.get('a.txt').toString('utf8'), 'hello '.repeat(200));
      assert.equal(JSON.parse(back.get('dir/b.json').toString('utf8')).x, 1);
      assert.ok(zip.length < 200 * 6, 'длинный текст сжат');
      assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'эталонный CRC32');
      assert.throws(() => readZipEntries(Buffer.from('not a zip')), /EOCD/);
    });

    await test('manifest 0.4: node-сервер, каталог и sensitive-токен', async () => {
      const manifest = makeManifest({ version: '0.1.0', owner: 'tester', repo: 'wb-mcp' });
      assert.equal(manifest.manifest_version, '0.4');
      assert.equal(manifest.server.type, 'node');
      assert.equal(manifest.server.entry_point, 'server/server.mjs');
      assert.equal(manifest.server.mcp_config.env.WB_API_TOKEN, '${user_config.wb_token}');
      assert.equal(manifest.server.mcp_config.env.WB_MCP_CATALOG, '${__dirname}/catalog');
      assert.equal(manifest.user_config.wb_token.type, 'string');
      assert.equal(manifest.user_config.wb_token.sensitive, true);
      assert.equal(manifest.user_config.wb_token.required, true);
      assert.equal(manifest.repository.url, 'https://github.com/tester/wb-mcp.git');
    });

    await test('bundle: собирается, содержит сервер, каталог и манифест', async () => {
      const outFile = path.join(tmp, 'wb-mcp.mcpb');
      const result = await buildMcpb({
        outFile,
        catalogDir,
        sourceDir: ROOT,
        version: '0.1.0',
        owner: 'tester',
        repo: 'wb-mcp',
      });
      assert.ok(result.bytes > 30_000, `bundle слишком маленький: ${result.bytes}`);
      const zip = readZipEntries(await readFile(outFile));
      const manifest = JSON.parse(zip.get('manifest.json').toString('utf8'));
      assert.equal(manifest.manifest_version, '0.4');
      for (const file of SERVER_FILES) {
        assert.ok(zip.has(`server/${file}`), `в бандле есть server/${file}`);
      }
      assert.ok(zip.has('catalog/index.json'), 'в бандле есть catalog/index.json');
      for (const key of Object.keys(JSON.parse(zip.get('catalog/index.json').toString('utf8')).modules ?? {})) {
        assert.ok(zip.has(`catalog/${key}.json`), `каталог модуля ${key} в бандле`);
      }
      const serverText = zip.get('server/server.mjs').toString('utf8');
      assert.ok(serverText.includes('createMcpServer'), 'server.mjs внутри — настоящий сервер');
      const index = JSON.parse(zip.get('catalog/index.json').toString('utf8'));
      assert.ok(index.operations.length >= 60);
    });

    await test('portable ZIP: install-скрипты, офлайн-каталог и skill', async () => {
      const file = path.join(tmp, 'wb-mcp-portable.zip');
      const result = await buildPortableZip({ outFile: file, catalogDir, sourceDir: ROOT });
      const zip = readZipEntries(await readFile(file));
      for (const name of ['install.cmd', 'install.sh', 'server.mjs', 'install.mjs', 'doctor.mjs', 'README.en.md', 'catalog/index.json']) {
        assert.ok(zip.has(name), `в portable zip есть ${name}`);
      }
      assert.ok(zip.has('skills/wb-mcp/SKILL.md'), 'skill внутри portable zip');
      assert.ok(zip.get('install.cmd').toString('utf8').includes('install.mjs'));
      assert.ok(result.bytes > 30_000);
    });

    await test('bundle без каталога: понятная ошибка', async () => {
      await assert.rejects(
        () => buildMcpb({ outFile: path.join(tmp, 'x.mcpb'), catalogDir: path.join(tmp, 'empty'), sourceDir: ROOT }),
        /catalog not found/,
      );
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
