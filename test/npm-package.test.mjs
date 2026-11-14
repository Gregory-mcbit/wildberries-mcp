// Validates npm/MCP Registry release metadata (offline, no npm calls).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease, loadReleaseMeta } from '../publish-npm.mjs';

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

async function makeFixture({ pkg = {}, server = {}, files = ['server.mjs'] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-npm-'));
  const basePkg = {
    name: 'wb-mcp',
    version: '0.1.0',
    license: 'MIT',
    mcpName: 'io.github.gregory-mcbit/wb-mcp',
    files: [...files, 'LICENSE'],
    ...pkg,
  };
  const baseServer = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'io.github.gregory-mcbit/wb-mcp',
    description: 'MCP server for the full Wildberries Seller API: 309 methods',
    repository: { url: 'https://github.com/Gregory-mcbit/wildberries-mcp', source: 'github' },
    version: '0.1.0',
    packages: [
      {
        registryType: 'npm',
        identifier: 'wb-mcp',
        version: '0.1.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'WB_API_TOKEN', format: 'string', isRequired: true, isSecret: true }],
      },
    ],
    ...server,
  };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(basePkg, null, 2));
  await writeFile(path.join(dir, 'server.json'), JSON.stringify(baseServer, null, 2));
  await writeFile(path.join(dir, 'LICENSE'), 'MIT\n');
  for (const file of files) {
    if (file === 'LICENSE') continue;
    await copyFile(path.join(ROOT, file), path.join(dir, file)).catch(async () => {
      await writeFile(path.join(dir, file), '// stub\n');
    });
  }
  return dir;
}

async function main() {
  const tmpDirs = [];
  try {
    await test('репозиторий: package.json и server.json согласованы', async () => {
      const { problems, pkg, server } = await validateRelease(ROOT);
      assert.deepEqual(problems, []);
      assert.equal(pkg.name, 'wb-mcp');
      assert.equal(server.name, 'io.github.gregory-mcbit/wb-mcp');
      assert.equal(pkg.mcpName, server.name);
      assert.ok(server.description.length <= 100);
    });

    await test('server.json: npm-пакет, токен секретный, версия совпадает', async () => {
      const { server, pkg } = await loadReleaseMeta(ROOT);
      const entry = server.packages.find((p) => p.registryType === 'npm');
      assert.equal(entry.identifier, pkg.name);
      assert.equal(entry.version, pkg.version);
      assert.equal(entry.transport.type, 'stdio');
      assert.equal(entry.environmentVariables[0].name, 'WB_API_TOKEN');
      assert.equal(entry.environmentVariables[0].isSecret, true);
    });

    await test('ошибки валидации ловятся', async () => {
      const cases = [
        [{ pkg: { mcpName: 'io.github.gregory-mcbit/other' } }, /mcpName/],
        [{ pkg: {}, server: { name: 'io.github.gregory-mcbit/other' } }, /mcpName|не совпадает/],
        [{ server: { description: 'x'.repeat(120) } }, /100 символов/],
        [{ server: { version: '9.9.9' } }, /верси/],
        [{ pkg: { files: ['missing-file.mjs'] } }, /missing-file/],
        [
          {
            server: {
              packages: [
                { registryType: 'npm', identifier: 'wb-mcp', version: '0.1.0', environmentVariables: [{ name: 'WB_API_TOKEN', isRequired: true }] },
              ],
            },
          },
          /isSecret/,
        ],
      ];
      for (const [overrides, re] of cases) {
        const dir = await makeFixture(overrides);
        tmpDirs.push(dir);
        const { problems } = await validateRelease(dir);
        assert.ok(problems.some((p) => re.test(p)), `ожидалась ошибка ${re}: ${problems.join('; ')}`);
      }
    });

    await test('валидная фикстура проходит проверку', async () => {
      const dir = await makeFixture();
      tmpDirs.push(dir);
      const { problems } = await validateRelease(dir);
      assert.deepEqual(problems, []);
    });
  } finally {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
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
