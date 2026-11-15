#!/usr/bin/env node
// Live read-only smoke test against the real Wildberries API.
// Run manually with a token; not part of `npm test` (CI triggers it via
// workflow_dispatch with a repo secret). Never commit the token itself.

import { describeToken } from './tokens.mjs';

const token = process.env.WB_API_TOKEN;
if (!token || token.includes('<')) {
  console.error('live-smoke: задай WB_API_TOKEN (реальный токен) через переменную окружения');
  process.exit(1);
}

const info = describeToken(token);
console.log(
  `токен: ${info.valid ? 'валиден' : 'НЕ валиден'} | тип: ${info.type} | readOnly: ${info.readOnly} | ` +
    `категорий: ${info.categories.length}`,
);
if (!info.valid) process.exit(1);

const ua = { 'user-agent': 'wb-mcp-live-smoke', Authorization: token, Accept: 'application/json' };
const checks = [
  ['ping (публичный)', 'https://common-api.wildberries.ru/ping', 200],
  ['finance balance (авторизация)', 'https://finance-api.wildberries.ru/api/v1/account/balance', 200],
];

let failed = 0;
for (const [name, url, expect] of checks) {
  try {
    const res = await fetch(url, { headers: ua });
    const text = (await res.text()).slice(0, 120).replace(/\n/g, ' ');
    const ok = res.status === expect;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: HTTP ${res.status} ${text}`);
    if (!ok) failed++;
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} проверка(и) не прошла`);
  process.exit(1);
}
console.log('\n✔ live-smoke: токен работает против реального WB (только чтение)');
