// Package sanity tests: everything needed for `npx github:<owner>/wb-mcp` and
// npm publishing must be in place, including the zero-dependency invariant.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  await test('package.json: имя, версия, лицензия, engines', async () => {
    assert.equal(pkg.name, 'wildberries-seller-mcp');
    assert.equal(pkg.mcpName, 'io.github.gregory-mcbit/wb-mcp', 'mcpName нужен для MCP Registry');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.engines?.node, 'engines.node задан');
  });

  await test('инвариант: ноль runtime-зависимостей', async () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    const peer = Object.keys(pkg.peerDependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    assert.deepEqual([...deps, ...peer, ...optional], [], 'зависимостей быть не должно');
    const lockfile = await exists(path.join(ROOT, 'package-lock.json'));
    assert.equal(lockfile, false, 'lockfile не нужен для zero-dep пакета');
  });

  await test('bin: цели существуют и имеют shebang', async () => {
    const bins = Object.entries(pkg.bin ?? {});
    assert.ok(bins.length >= 3, 'минимум wb-mcp / sync / install');
    for (const [name, target] of bins) {
      const file = path.join(ROOT, target);
      assert.ok(await exists(file), `${name} -> ${target} существует`);
      const head = (await readFile(file, 'utf8')).split('\n')[0];
      assert.match(head, /^#!\/usr\/bin\/env node/, `${target} начинается с shebang`);
    }
  });

  await test('files: все заявленные файлы существуют', async () => {
    for (const file of pkg.files ?? []) {
      assert.ok(await exists(path.join(ROOT, file)), `${file} существует`);
    }
    for (const required of ['server.mjs', 'sync.mjs', 'yaml.mjs', 'search.mjs', 'tokens.mjs', 'tokenstore.mjs', 'keyring.mjs', 'verify.mjs', 'doctor.mjs', 'install.mjs', 'README.md', 'AGENT-INSTALL.md', 'LICENSE']) {
      assert.ok(pkg.files.includes(required), `${required} в files (нужен npx-пользователям)`);
    }
  });

  await test('относительные import-ы в .mjs резолвятся', async () => {
    const files = (await readdir(ROOT)).filter((f) => f.endsWith('.mjs'));
    const importRe = /from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const file of files) {
      const text = await readFile(path.join(ROOT, file), 'utf8');
      let match;
      while ((match = importRe.exec(text))) {
        const target = path.resolve(ROOT, path.dirname(file), match[1]);
        assert.ok(await exists(target), `${file}: import ${match[1]} не резолвится`);
      }
    }
  });

  await test('install.mjs копирует все runtime-файлы', async () => {
    const source = await readFile(path.join(ROOT, 'install.mjs'), 'utf8');
    for (const file of ['server.mjs', 'sync.mjs', 'yaml.mjs', 'search.mjs', 'tokens.mjs', 'tokenstore.mjs', 'keyring.mjs', 'verify.mjs', 'doctor.mjs']) {
      assert.ok(source.includes(`'${file}'`), `${file} в списке FILES установщика`);
    }
  });

  await test('.gitignore исключает генерируемое и секреты', async () => {
    const ignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
    for (const pattern of ['catalog/', 'specs-raw/', 'node_modules/', '*.log']) {
      assert.ok(ignore.includes(pattern), `${pattern} в .gitignore`);
    }
    assert.ok(!ignore.includes('package.json'), 'package.json не игнорируется');
  });

  await test('AGENT-INSTALL.md содержит машинную инструкцию', async () => {
    const text = await readFile(path.join(ROOT, 'AGENT-INSTALL.md'), 'utf8');
    for (const marker of ['node install.mjs', '--client', 'WB_API_TOKEN', 'verify.mjs']) {
      assert.ok(text.includes(marker), `в инструкции есть "${marker}"`);
    }
  });

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
