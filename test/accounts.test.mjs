// Tests for account-file ids: different store names must never share a token file.

import assert from 'node:assert/strict';
import { accountFileId } from '../accounts.mjs';

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`FAIL ${name}`);
    console.error(err?.stack ?? err);
  }
}

test('разные имена дают разные id (в т.ч. кириллица)', () => {
  const used = new Set();
  const ids = ['Основной', 'Второй', 'Третий'].map((name) => accountFileId(name, used));
  assert.equal(new Set(ids).size, ids.length, `ids должны быть уникальны: ${ids.join(', ')}`);
  for (const id of ids) {
    assert.match(id, /^[A-Za-z0-9._-]+$/, `id безопасен для файла: ${id}`);
    assert.ok(!id.includes('..'), 'без ..');
    assert.ok(!id.startsWith('.'), 'без ведущей точки');
  }
});

test('одинаковое имя даёт одинаковый id', () => {
  assert.equal(accountFileId('shop', new Set()), accountFileId('shop', new Set()));
});

test('коллизия префикса разрешается суффиксом', () => {
  const used = new Set();
  const a = accountFileId('a', used);
  const b = accountFileId('a', used);
  assert.notEqual(a, b);
  assert.ok(b.endsWith('-2'), b);
});

test('опасные символы не создают путь', () => {
  const used = new Set();
  for (const name of ['../../evil', 'a/b', 'a\\b', '..', '']) {
    const id = accountFileId(name, used);
    assert.match(id, /^[A-Za-z0-9._-]+$/, `id безопасен: ${id}`);
    assert.ok(!id.includes('/') && !id.includes('\\'), `без слэшей: ${id}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, err } of failures) console.error(`\n--- ${name} ---\n${err?.stack ?? err}`);
  process.exit(1);
}
