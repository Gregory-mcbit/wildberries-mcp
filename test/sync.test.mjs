// Tests for the catalog builder: candidate fallback, tolerant mode and strict
// mode. No network: a stub fetchText is injected.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, writeCatalogBundle } from '../sync.mjs';

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

const SYNTHETIC_SPEC = `openapi: 3.0.1
info:
  title: Тестовый раздел
  version: test
  x-file-name: items
paths:
  /ping:
    servers:
      - url: https://common-api.wildberries.ru
    get:
      operationId: getPing
      x-readonly-method: true
      x-category: commonapi
      summary: Проверка подключения
      description: |
        Просто проверка.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
`;

const BROKEN_SPEC = `openapi: [unterminated
  x: y
`;

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-sync-'));

  await test('кандидаты: 02-items → 404, 02-products → успех', async () => {
    const calls = [];
    const fetchText = async (url) => {
      calls.push(url);
      if (url.endsWith('/02-products.yaml')) return { status: 200, text: SYNTHETIC_SPEC };
      return { status: 404 };
    };
    const stats = await buildCatalog({
      outDir: path.join(tmp, 'cand'),
      onlyModules: ['02-items'],
      fetchText,
      discovery: false,
      verbose: false,
    });
    assert.equal(stats.modules, 1, JSON.stringify(stats));
    assert.equal(stats.operations, 1);
    assert.deepEqual(stats.missing, []);
    assert.ok(calls.some((u) => u.endsWith('/02-items.yaml')), 'первый кандидат опробован');
    assert.ok(calls.some((u) => u.endsWith('/02-products.yaml')), 'второй кандидат опробован');
    const index = JSON.parse(await readFile(path.join(tmp, 'cand', 'index.json'), 'utf8'));
    assert.equal(index.operations[0].id, 'getPing');
    assert.equal(index.operations[0].readonly, true);
    assert.equal(index.operations[0].host, 'https://common-api.wildberries.ru');
    assert.equal(index.meta.missing.length, 0);
  });

  await test('--from-dir: битый файл не ломает сборку, попадает в missing', async () => {
    const dir = path.join(tmp, 'dir-tolerant');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '10-rates.yaml'), SYNTHETIC_SPEC, 'utf8');
    await writeFile(path.join(dir, '99-broken.yaml'), BROKEN_SPEC, 'utf8');
    const stats = await buildCatalog({ fromDir: dir, outDir: path.join(tmp, 'out-tolerant'), verbose: false });
    assert.equal(stats.modules, 1, JSON.stringify(stats));
    assert.deepEqual(stats.missing, ['99-broken']);
    assert.ok(stats.warnings.some((w) => w.includes('99-broken')), 'предупреждение о битом модуле');
    const index = JSON.parse(await readFile(path.join(tmp, 'out-tolerant', 'index.json'), 'utf8'));
    assert.equal(index.meta.modules.length, 1);
    assert.equal(index.meta.missing[0].key, '99-broken');
    assert.ok(index.meta.missing[0].error);
  });

  await test('--strict: битый модуль приводит к ошибке', async () => {
    const dir = path.join(tmp, 'dir-strict');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '01-ok.yaml'), SYNTHETIC_SPEC, 'utf8');
    await writeFile(path.join(dir, '02-bad.yaml'), BROKEN_SPEC, 'utf8');
    await assert.rejects(
      () => buildCatalog({ fromDir: dir, outDir: path.join(tmp, 'out-strict'), verbose: false, strict: true }),
      /strict/,
    );
  });

  await test('пустая папка: понятная ошибка', async () => {
    const dir = path.join(tmp, 'dir-empty');
    await mkdir(dir, { recursive: true });
    await assert.rejects(() => buildCatalog({ fromDir: dir, outDir: path.join(tmp, 'out-empty'), verbose: false }), /no \.yaml/);
  });

  await test('все кандидаты 404: ошибка со списком попыток', async () => {
    const fetchText = async () => ({ status: 404 });
    await assert.rejects(
      () =>
        buildCatalog({
          outDir: path.join(tmp, 'out-404'),
          onlyModules: ['13-finances'],
          fetchText,
          discovery: false,
          verbose: false,
        }),
      (err) => /13-finances/.test(err.message) && /13-finances\.yaml/.test(err.message),
    );
  });

  await test('опциональный модуль 404 не считается потерей покрытия', async () => {
    const fetchText = async (url) => {
      if (url.endsWith('/01-general.yaml')) return { status: 200, text: SYNTHETIC_SPEC };
      return { status: 404 };
    };
    const stats = await buildCatalog({
      outDir: path.join(tmp, 'out-optional'),
      onlyModules: ['01-general', '14-wbd'],
      fetchText,
      discovery: false,
      verbose: false,
    });
    assert.deepEqual(stats.missing, []);
    assert.deepEqual(stats.optionalMissing, ['14-wbd']);
    const index = JSON.parse(await readFile(path.join(tmp, 'out-optional', 'index.json'), 'utf8'));
    assert.equal(index.meta.missing.length, 0);
    assert.equal(index.meta.optionalMissing[0].key, '14-wbd');
    assert.equal(index.meta.expectedModules, 1);
  });

  await test('каталог детерминирован: повторная сборка даёт те же id', async () => {
    const dir = path.join(tmp, 'dir-repeat');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '10-rates.yaml'), SYNTHETIC_SPEC, 'utf8');
    await buildCatalog({ fromDir: dir, outDir: path.join(tmp, 'out-a'), verbose: false });
    await buildCatalog({ fromDir: dir, outDir: path.join(tmp, 'out-b'), verbose: false });
    const a = JSON.parse(await readFile(path.join(tmp, 'out-a', 'index.json'), 'utf8'));
    const b = JSON.parse(await readFile(path.join(tmp, 'out-b', 'index.json'), 'utf8'));
    assert.deepEqual(a.operations.map((o) => o.id), b.operations.map((o) => o.id));
  });

  await test('writeCatalogBundle: небезопасный модуль отклоняется, старый каталог цел', async () => {
    const out = path.join(tmp, 'bundle-out');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'old-marker.json'), JSON.stringify({ keep: true }));
    const bundle = {
      index: { meta: { modules: ['evil'], totalOps: 0 }, operations: [] },
      modules: { '../escaped': { moduleKey: 'x', operations: [] } },
    };
    await assert.rejects(() => writeCatalogBundle(bundle, out), /небезопасное имя|выходит за пределы/);
    assert.ok(!existsSync(path.join(tmp, 'escaped.json')), 'файл вне каталога не создан');
    assert.ok(existsSync(path.join(out, 'old-marker.json')), 'прежний каталог не удалён при ошибке');
  });

  await test('writeCatalogBundle: структурно битый bundle не удаляет каталог', async () => {
    const out = path.join(tmp, 'bundle-struct');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'old-marker.json'), JSON.stringify({ keep: true }));
    const bundle = { index: { meta: { modules: [] } }, modules: {} }; // no index.operations
    await assert.rejects(() => writeCatalogBundle(bundle, out), /index\.operations/);
    assert.ok(existsSync(path.join(out, 'old-marker.json')), 'прежний каталог цел');
    assert.ok(!existsSync(path.join(out, 'index.json')), 'новый index не записан');
  });

  await rm(tmp, { recursive: true, force: true });
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
