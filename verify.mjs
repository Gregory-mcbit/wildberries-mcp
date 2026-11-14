#!/usr/bin/env node
// Validates a generated catalog: coverage, structure, hosts, ids, sums.
// Exported for doctor.mjs; also usable as a CLI.
//
// Usage:
//   node verify.mjs                 # check ./catalog
//   node verify.mjs --catalog DIR

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const HOST_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.wildberries\.ru$/;

export async function verifyCatalog(catalogDir) {
  const problems = [];
  const add = (msg) => problems.push(msg);

  const indexRaw = await readFile(path.join(catalogDir, 'index.json'), 'utf8').catch(() => null);
  if (!indexRaw) {
    return {
      summary: { catalog: catalogDir, exists: false },
      problems: [`нет ${path.join(catalogDir, 'index.json')}`],
    };
  }
  let parsedIndex;
  try {
    parsedIndex = JSON.parse(indexRaw);
  } catch (err) {
    return { summary: { catalog: catalogDir, exists: true }, problems: [`index.json не парсится: ${err.message}`] };
  }
  const { meta, operations } = parsedIndex;
  if (!meta || !Array.isArray(operations)) return { summary: { catalog: catalogDir }, problems: ['index.json: нет meta/operations'] };

  const modules = meta.modules ?? [];
  const missing = meta.missing ?? [];
  const optionalMissing = meta.optionalMissing ?? [];
  const expected = meta.expectedModules ?? modules.length;
  if (modules.length < expected) add(`покрытие неполное: ${modules.length}/${expected} обязательных модулей`);
  if (missing.length) add(`отсутствуют обязательные модули: ${missing.map((m) => m.key).join(', ')}`);
  if (operations.length !== meta.totalOps) add(`totalOps=${meta.totalOps}, в индексе ${operations.length}`);

  const files = new Set((await readdir(catalogDir).catch(() => [])).filter((f) => f.endsWith('.json')));
  const ids = new Set();
  const hosts = new Set();
  const categories = new Set();
  const perModule = new Map();
  let ro = 0;
  let write = 0;
  let fileOps = 0;

  for (const entry of operations) {
    if (!entry.id || !entry.moduleKey) add(`операция без id/moduleKey: ${JSON.stringify(entry).slice(0, 100)}`);
    if (ids.has(entry.id)) add(`дублирующийся id: ${entry.id}`);
    ids.add(entry.id);
    if (!HTTP_METHODS.has(entry.method)) add(`${entry.id}: неизвестный метод ${entry.method}`);
    if (!entry.path?.startsWith('/')) add(`${entry.id}: путь ${entry.path}`);
    if (!HOST_RE.test(entry.host ?? '')) add(`${entry.id}: хост ${entry.host} не *.wildberries.ru`);
    if (/sandbox/.test(entry.host ?? '')) add(`${entry.id}: sandbox-хост в прод-каталоге`);
    if (typeof entry.readonly !== 'boolean') add(`${entry.id}: readonly не boolean`);
    if (entry.readonly) ro++;
    else write++;
    if (entry.file) fileOps++;
    hosts.add(entry.host);
    categories.add(entry.category);
    perModule.set(entry.moduleKey, (perModule.get(entry.moduleKey) ?? 0) + 1);
    if (!files.has(`${entry.moduleKey}.json`)) add(`нет файла модуля ${entry.moduleKey}.json`);
  }

  for (const module of modules) {
    if (!files.has(`${module.key}.json`)) {
      add(`модуль ${module.key}: нет файла`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(catalogDir, `${module.key}.json`), 'utf8'));
    } catch (err) {
      add(`модуль ${module.key}: не парсится (${err.message})`);
      continue;
    }
    if (parsed.operations.length !== module.ops) add(`модуль ${module.key}: ops=${parsed.operations.length}, в meta ${module.ops}`);
    const indexOps = perModule.get(module.key) ?? 0;
    if (indexOps !== module.ops) add(`модуль ${module.key}: в индексе ${indexOps}, в модуле ${module.ops}`);
    for (const op of parsed.operations) if (!ids.has(op.id)) add(`модуль ${module.key}: ${op.id} нет в индексе`);
  }

  return {
    summary: {
      catalog: catalogDir,
      exists: true,
      generatedAt: meta.generatedAt,
      source: meta.source,
      coverage: { requiredModules: expected, builtModules: modules.length, missing: missing.map((m) => m.key), optionalMissing: optionalMissing.map((m) => m.key) },
      operations: { total: operations.length, readonly: ro, write, files: fileOps, byModule: Object.fromEntries([...perModule].sort()) },
      hosts: [...hosts].sort(),
      categories: [...categories].sort(),
    },
    problems,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const catalogDir = get('--catalog') ?? path.join(HERE, 'catalog');
  const report = await verifyCatalog(catalogDir);
  console.log(JSON.stringify({ ...report.summary, problems: report.problems }, null, 2));
  if (report.problems.length) {
    console.error(`\nПроверка НЕ пройдена: ${report.problems.length} проблем(ы).`);
    process.exit(1);
  }
  console.log('\nПроверка пройдена: каталог структурно валиден, обязательное покрытие полное.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('verify failed:', err?.stack ?? err);
    process.exit(1);
  });
}
