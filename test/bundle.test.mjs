// Tests for the offline catalog bundle used by GitHub Releases and doctor.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, createCatalogBundle, loadCatalogBundle, writeCatalogBundle } from '../sync.mjs';
import { verifyCatalog } from '../verify.mjs';

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-bundle-'));
  try {
    const sourceDir = path.join(tmp, 'catalog-source');
    await test('собираем каталог из sample-спек', async () => {
      await buildCatalog({ fromDir: path.join(ROOT, 'test', 'specs-sample'), outDir: sourceDir, verbose: false });
      const check = await verifyCatalog(sourceDir);
      assert.deepEqual(check.problems, []);
    });

    await test('bundle: pack → JSON-файл → unpack даёт эквивалентный каталог', async () => {
      const bundle = await createCatalogBundle(sourceDir);
      assert.equal(bundle.schemaVersion, 1);
      assert.ok(bundle.index.operations.length >= 60);
      assert.ok(Object.keys(bundle.modules).length >= 5);
      for (const key of Object.keys(bundle.modules)) {
        assert.ok(bundle.modules[key].operations.length > 0, `${key} содержит операции`);
      }

      const bundleFile = path.join(tmp, 'catalog.bundle.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(bundleFile, JSON.stringify(bundle));
      const loaded = await loadCatalogBundle(bundleFile);
      assert.equal(loaded.index.operations.length, bundle.index.operations.length);

      const restoredDir = path.join(tmp, 'catalog-restored');
      const stats = await writeCatalogBundle(loaded, restoredDir);
      assert.equal(stats.modules, Object.keys(bundle.modules).length);
      assert.equal(stats.operations, bundle.index.operations.length);
      assert.equal(stats.readonly + stats.write, stats.operations);
      assert.ok(stats.generatedAt);

      const restored = await verifyCatalog(restoredDir);
      assert.deepEqual(restored.problems, []);
      const a = JSON.parse(await readFile(path.join(sourceDir, 'index.json'), 'utf8'));
      const b = JSON.parse(await readFile(path.join(restoredDir, 'index.json'), 'utf8'));
      assert.deepEqual(
        a.operations.map((o) => o.id),
        b.operations.map((o) => o.id),
      );
    });

    await test('bundle: битый бандл даёт понятную ошибку', async () => {
      await assert.rejects(() => writeCatalogBundle({ modules: {} }, path.join(tmp, 'x')), /malformed/);
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
