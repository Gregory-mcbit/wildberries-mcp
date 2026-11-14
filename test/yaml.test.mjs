import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from '../yaml.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', '01-general.paths.yaml');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('basic mapping and sequence', () => {
  const v = parseYaml('a: 1\nb: two\nc:\n  - x\n  - y\n');
  assert.deepEqual(v, { a: 1, b: 'two', c: ['x', 'y'] });
});

test('quoted keys and null/bool/float', () => {
  const v = parseYaml(`'429': ok\n200: null\nflag: true\nf: 1.5\ns: 1.0.0\n`);
  assert.deepEqual(v, { 429: 'ok', 200: null, flag: true, f: 1.5, s: '1.0.0' });
});

test('literal block scalar with unicode', () => {
  const v = parseYaml('d: |\n  Привет\n  мир\n');
  assert.equal(v.d, 'Привет\nмир\n');
});

test('literal block scalar strip chomping', () => {
  const v = parseYaml('d: |-\n  a\n  b\n');
  assert.equal(v.d, 'a\nb');
});

test('folded block scalar', () => {
  const v = parseYaml('d: >\n  a\n  b\n\n  c\n');
  assert.equal(v.d, 'a b\nc\n');
});

test('flow collections', () => {
  const v = parseYaml('a: [1, two, {x: 1}]\nb: {k: v, n: [a, b]}\n');
  assert.deepEqual(v, { a: [1, 'two', { x: 1 }], b: { k: 'v', n: ['a', 'b'] } });
});

test('anchors and aliases', () => {
  const v = parseYaml('base: &b\n  x: 1\nuse: *b\n');
  assert.deepEqual(v, { base: { x: 1 }, use: { x: 1 } });
});

test('comments ignored', () => {
  const v = parseYaml('a: 1 # trailing\n# whole line\nb: 2\n');
  assert.deepEqual(v, { a: 1, b: 2 });
});

test('sequence of mappings', () => {
  const v = parseYaml('items:\n  - name: a\n    v: 1\n  - name: b\n    v: 2\n');
  assert.deepEqual(v, { items: [{ name: 'a', v: 1 }, { name: 'b', v: 2 }] });
});

test('real spec: parses and has expected shape', () => {
  const text = readFileSync(fixture, 'utf8');
  const t0 = Date.now();
  const doc = parseYaml(text);
  const ms = Date.now() - t0;
  assert.equal(doc.openapi, '3.0.1');
  assert.ok(doc.paths && typeof doc.paths === 'object');
  const pathKeys = Object.keys(doc.paths);
  assert.equal(pathKeys.length, 11, `expected 11 paths, got ${pathKeys.length}: ${pathKeys.join(', ')}`);
  const ping = doc.paths['/ping'];
  assert.ok(ping.servers && ping.servers.length >= 10, 'servers list parsed');
  assert.equal(ping.servers[0].url, 'https://common-api.wildberries.ru');
  const op = ping.get;
  assert.equal(op.operationId, 'getPing');
  assert.equal(op['x-readonly-method'], true);
  assert.equal(op['x-category'], 'commonapi');
  assert.ok(op.summary.includes('Проверка'), 'cyrillic preserved in summary');
  assert.ok(op.description.includes('Метод проверяет'), 'block scalar description preserved');
  assert.ok(Array.isArray(op.tags));
  assert.ok(op.tags[0].includes('Проверка'), 'cyrillic tag preserved');
  // write operation present
  const invite = Object.values(doc.paths).map((p) => p.post).find((o) => o && o.operationId === 'postV1Invite');
  assert.ok(invite, 'postV1Invite found');
  assert.equal(invite['x-readonly-method'], false);
  console.log(`     parsed ${text.length} bytes / ${pathKeys.length} paths in ${ms}ms`);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}`);
if (process.exitCode) process.exit(process.exitCode);
