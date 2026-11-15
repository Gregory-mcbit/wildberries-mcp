// Integration tests: build a catalog from the local specs, point it at a mock
// Wildberries API, start the real MCP server in-process (no child processes)
// and exercise the whole JSON-RPC surface over a pair of streams.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../sync.mjs';
import { createMcpServer } from '../server.mjs';
import { startMock } from './mock-wb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;

const RW_TOKEN = makeJwt({ acc: 1, sid: 'seller-rw', exp: Math.floor(Date.now() / 1000) + 86_400, s: (1 << 13) | (1 << 1) });
const RO_TOKEN = makeJwt({
  acc: 1,
  sid: 'seller-ro',
  exp: Math.floor(Date.now() / 1000) + 86_400,
  s: (1 << 13) | (1 << 1) | (1 << 30),
});

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

async function rewriteHosts(catalogDir, baseUrl) {
  for (const file of await readdir(catalogDir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(catalogDir, file);
    const parsed = JSON.parse(await readFile(full, 'utf8'));
    for (const op of parsed.operations ?? []) {
      if (typeof op.host === 'string' && op.host.includes('wildberries.ru')) op.host = baseUrl;
    }
    await writeFile(full, JSON.stringify(parsed));
  }
}

async function startServer(env, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = [];
  const errorStream = { write: (chunk) => (errors.push(String(chunk)), true) };
  const server = createMcpServer({ env, input, output, error: errorStream });
  await server.start();

  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  const rl = createInterface({ input: output, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Server -> client request (sampling/createMessage): answer with a canned reply.
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.method === 'sampling/createMessage') {
      const reply = typeof opts.samplingReply === 'function' ? opts.samplingReply(msg.params) : (opts.samplingReply ?? 'Отклонить');
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { role: 'assistant', content: { type: 'text', text: reply }, model: 'test-model', stopReason: 'endTurn' },
        }) + '\n',
      );
      return;
    }
    if (msg.id === undefined) {
      notifications.push(msg);
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message), { rpcError: msg.error }));
    else waiter.resolve(msg.result);
  });

  const rpc = {
    errors,
    notifications,
    notify(method, params = {}) {
      input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    request(method, params = {}, timeoutMs = 20_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async tool(name, args = {}, extra = {}) {
      const result = await rpc.request('tools/call', { name, arguments: args, ...extra });
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
      return { ...result, text };
    },
  };

  return {
    rpc,
    errors,
    async stop() {
      rl.close();
      input.end();
      await server.stop();
    },
  };
}

async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-test-'));
  const catalogDir = path.join(tmp, 'catalog');
  const home = path.join(tmp, 'home');
  const mock = await startMock();
  let server;

  try {
    const sampleDir = path.join(HERE, 'specs-sample');
    const sampleFiles = (await readdir(sampleDir)).filter((f) => /\.ya?ml$/i.test(f)).length;
    const stats = await buildCatalog({ fromDir: sampleDir, outDir: catalogDir, verbose: false });
    assert.equal(stats.modules, sampleFiles, 'собраны все модули из test/specs-sample');
    assert.ok(stats.operations >= 60, `в каталоге из примеров достаточно операций: ${stats.operations}`);
    await rewriteHosts(catalogDir, mock.baseUrl);

    const env = {
      WB_ACCOUNTS: JSON.stringify({ rw: RW_TOKEN, ro: RO_TOKEN }),
      WB_MCP_CATALOG: catalogDir,
      WB_MCP_HOME: home,
      WB_ALLOW_ANY_HOST: '1',
      WB_CONFIRM_WRITES: '0',
      WB_MAX_OUTPUT: '1500',
      WB_MAX_WAIT_MS: '5000',
      WB_RATE_LIMIT: 'off',
    };
    server = await startServer(env);
    const { rpc } = server;

    await test('initialize (legacy handshake) отвечает версией и capabilities', async () => {
      const res = await rpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      });
      assert.equal(res.protocolVersion, '2025-06-18');
      assert.ok(res.capabilities.tools);
      assert.equal(res.serverInfo.name, 'wb-mcp');
      assert.ok(res.instructions.includes('wb_search'));
      rpc.notify('notifications/initialized');
    });

    await test('server/discover отвечает modern-версией 2026-07-28', async () => {
      const res = await rpc.request('server/discover', {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      });
      assert.ok(res.supportedVersions.includes('2026-07-28'));
      assert.equal(res._meta['io.modelcontextprotocol/serverInfo'].name, 'wb-mcp');
    });

    await test('tools/list отдаёт инструменты с inputSchema (read/write разделены)', async () => {
      const res = await rpc.request('tools/list', {});
      const names = res.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'wb_call',
        'wb_describe',
        'wb_get',
        'wb_refresh',
        'wb_request',
        'wb_search',
        'wb_sections',
        'wb_token_info',
      ]);
      for (const tool of res.tools) {
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} has inputSchema`);
      }
      const get = res.tools.find((t) => t.name === 'wb_get');
      const call = res.tools.find((t) => t.name === 'wb_call');
      assert.equal(get.annotations.readOnlyHint, true, 'wb_get помечен read-only');
      assert.equal(call.annotations.readOnlyHint, false, 'wb_call не read-only');
      assert.ok(res.tools.find((t) => t.name === 'wb_search').outputSchema, 'outputSchema есть у wb_search');
    });

    await test('initialize объявляет capabilities tools/prompts/resources', async () => {
      const res = await rpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test2', version: '1' },
      });
      assert.ok(res.capabilities.tools);
      assert.ok(res.capabilities.prompts);
      assert.equal(res.capabilities.resources.subscribe, true);
    });

    await test('prompts/list и prompts/get отдают сценарий диагностики заказов', async () => {
      const list = await rpc.request('prompts/list', {});
      const names = list.prompts.map((p) => p.name);
      for (const name of ['sales-accelerator', 'diagnose-orders-drop', 'check-stock', 'reply-reviews', 'weekly-report']) {
        assert.ok(names.includes(name), `prompt ${name} есть`);
      }
      const got = await rpc.request('prompts/get', {
        name: 'diagnose-orders-drop',
        arguments: { date: '2026-11-14', days: '7' },
      });
      assert.ok(got.messages?.length, 'messages есть');
      const text = got.messages[0].content.text;
      assert.ok(text.includes('2026-11-14'), 'аргумент подставлен');
      assert.ok(text.includes('wb_search'), 'план ссылается на wb_search');
      assert.ok(text.includes('wb_get'), 'план использует read-only wb_get');
    });

    await test('prompt sales-accelerator: полный аудит с реальными методами и правилами', async () => {
      const list = await rpc.request('prompts/list', {});
      const prompt = list.prompts.find((p) => p.name === 'sales-accelerator');
      assert.ok(prompt, 'sales-accelerator есть в prompts/list');
      assert.ok(prompt.arguments.some((arg) => arg.name === 'focus'), 'есть аргумент focus');
      assert.ok(prompt.description.includes('CTR'), 'описание упоминает CTR');

      const got = await rpc.request('prompts/get', {
        name: 'sales-accelerator',
        arguments: { period: '14', focus: 'ads', target: '+20% GMV' },
      });
      const text = got.messages[0].content.text;
      for (const marker of [
        '14', // период подставлен
        '+20% GMV',
        'D (реклама и ставки)', // focus ограничил блок
        'wb_get',
        'wb_call',
        'getV1SupplierOrders',
        'postV3SalesFunnelProducts',
        'postV2SearchReportReport',
        'getV1Adverts',
        'getV1CalendarPromotions',
        'postV2StocksReportProductsProducts',
        'getV1Rating',
      ]) {
        assert.ok(text.includes(marker), `в промпте есть "${marker}"`);
      }
      assert.ok(text.includes('ЖЁСТКИЕ ПРАВИЛА'), 'есть правила read-only');
      assert.ok(text.includes('требует подтверждения'), 'write-методы только после подтверждения');
    });

    await test('resources/list и resources/read отдают каталог, раздел и метод', async () => {
      const list = await rpc.request('resources/list', {});
      const uris = list.resources.map((r) => r.uri);
      assert.ok(uris.includes('wb://catalog/index'), 'ресурс индекса каталога');
      assert.ok(uris.some((u) => u.startsWith('wb://sections/')), 'ресурсы разделов');
      const index = await rpc.request('resources/read', { uri: 'wb://catalog/index' });
      const idx = JSON.parse(index.contents[0].text);
      assert.equal(idx.operations.length, 64, 'в индексе все операции sample-каталога');
      const method = await rpc.request('resources/read', { uri: 'wb://method/getV1Warehouses' });
      const op = JSON.parse(method.contents[0].text);
      assert.equal(op.id, 'getV1Warehouses');
      assert.ok(op.host && op.path === '/api/v1/warehouses');
    });

    await test('wb_get: работает для readonly и блокирует запись', async () => {
      const ok = await rpc.tool('wb_get', { id: 'getV1Warehouses' });
      assert.ok(!ok.isError, ok.text);
      assert.ok(ok.text.includes('HTTP 200'));
      const index = JSON.parse(await readFile(path.join(catalogDir, 'index.json'), 'utf8'));
      const writeOp = index.operations.find((op) => op.readonly === false);
      const blocked = await rpc.tool('wb_get', { id: writeOp.id });
      assert.equal(blocked.isError, true);
      assert.ok(blocked.text.includes('только с read-only'), blocked.text);
    });

    await test('structuredContent + progress notifications', async () => {
      const search = await rpc.tool('wb_search', { query: 'warehouses', limit: 3 });
      assert.ok(search.structuredContent, 'structuredContent у wb_search');
      assert.equal(search.structuredContent.found, search.structuredContent.results.length);
      await rpc.tool('wb_get', { id: 'getV1Warehouses' }, { _meta: { progressToken: 'tok-1' } });
      const progress = rpc.notifications.filter((n) => n.method === 'notifications/progress');
      assert.ok(progress.length > 0, 'отправлены progress-уведомления');
      assert.ok(progress.every((n) => n.params.progressToken === 'tok-1'));
    });

    await test('wb_sections показывает разделы и аккаунты', async () => {
      const { text, isError } = await rpc.tool('wb_sections');
      assert.ok(!isError, text);
      const data = JSON.parse(text);
      const index = JSON.parse(await readFile(path.join(catalogDir, 'index.json'), 'utf8'));
      assert.equal(data.catalog.modules.length, index.meta.modules.length);
      assert.equal(data.catalog.totalOperations, index.meta.totalOps);
      assert.equal(data.accounts.length, 2);
      assert.equal(data.accounts.find((a) => a.name === 'ro').readOnly, true);
    });

    await test('wb_search находит метод по operationId', async () => {
      const { text } = await rpc.tool('wb_search', { query: 'warehouses', limit: 5 });
      const data = JSON.parse(text);
      assert.ok(data.results.some((r) => r.id === 'getV1Warehouses'), text);
    });

    await test('wb_search находит методы по русскому слову', async () => {
      const { text } = await rpc.tool('wb_search', { query: 'поставки', limit: 10 });
      const data = JSON.parse(text);
      assert.ok(data.results.length > 0, text);
    });

    await test('wb_search: русская морфология и синонимы ведут в нужный раздел', async () => {
      const cases = [
        ['заказы', '04-orders-dbw'],
        ['поставки', '07-orders-fbw'],
        ['финансы', '13-finances'],
        ['тарифы', '10-rates'],
      ];
      for (const [query, expectedSection] of cases) {
        const { text } = await rpc.tool('wb_search', { query, limit: 10 });
        const data = JSON.parse(text);
        assert.ok(data.found > 0, `${query}: ничего не найдено`);
        assert.ok(
          data.results.some((r) => r.sectionKey === expectedSection),
          `${query}: ожидался раздел ${expectedSection}, получено ${data.results.map((r) => r.sectionKey).join(', ')}`,
        );
        assert.ok(data.results[0].sectionTitle, `${query}: у результатов есть sectionTitle`);
      }
    });

    await test('wb_search фильтрует по режиму write', async () => {
      const { text } = await rpc.tool('wb_search', { query: 'a', mode: 'write', limit: 50 });
      const data = JSON.parse(text);
      assert.ok(data.results.every((r) => r.ro === false), text);
    });

    await test('wb_describe показывает путь, параметры и пример вызова', async () => {
      const { text } = await rpc.tool('wb_describe', { id: 'getV1Warehouses' });
      assert.ok(text.includes('/api/v1/warehouses'));
      assert.ok(text.includes('readonly: да'));
      assert.ok(text.includes('Пример вызова'));
    });

    await test('wb_call выполняет GET через каталог и подставляет токен', async () => {
      const { text, isError } = await rpc.tool('wb_call', { id: 'getV1Warehouses' });
      assert.ok(!isError, text);
      assert.ok(text.includes('HTTP 200'));
      assert.ok(text.includes('Коледино'));
      const last = mock.state.requests.at(-1);
      assert.equal(last.path, '/api/v1/warehouses');
      assert.equal(last.auth, RW_TOKEN);
    });

    await test('wb_call отправляет JSON-тело и query-параметры', async () => {
      const { text, isError } = await rpc.tool('wb_call', {
        id: 'postV1AcceptanceOptions',
        params: { warehouseID: 507 },
        body: { goods: [{ nmId: 123 }] },
      });
      assert.ok(!isError, text);
      assert.ok(text.includes('"received"'));
      const last = mock.state.requests.at(-1);
      assert.equal(last.query.warehouseID, '507');
      assert.deepEqual(JSON.parse(last.body), { goods: [{ nmId: 123 }] });
    });

    await test('wb_call возвращает isError и requestId при 403', async () => {
      const { text, isError } = await rpc.tool('wb_call', { id: 'getV1AccountBalance' });
      assert.equal(isError, true);
      assert.ok(text.includes('403'));
      assert.ok(text.includes('test-request-id'));
      assert.ok(text.includes('категория токена'), text);
    });

    await test('wb_call блокирует запись read-only токеном до запроса', async () => {
      const index = JSON.parse(await readFile(path.join(catalogDir, 'index.json'), 'utf8'));
      const writeOp = index.operations.find((op) => op.readonly === false);
      assert.ok(writeOp, 'в тестовом каталоге есть изменяющий метод');
      const before = mock.state.requests.length;
      const { text, isError } = await rpc.tool('wb_call', { id: writeOp.id, account: 'ro' });
      assert.equal(isError, true);
      assert.ok(text.includes('Только чтение'), text);
      assert.equal(mock.state.requests.length, before, 'запрос не ушёл в WB');
    });

    await test('wb_token_info декодирует токен локально и не утекает целиком', async () => {
      const { text } = await rpc.tool('wb_token_info');
      const data = JSON.parse(text);
      assert.equal(data.accounts.find((a) => a.name === 'ro').readOnly, true);
      assert.equal(data.accounts.find((a) => a.name === 'rw').readOnly, false);
      assert.equal(data.accounts.find((a) => a.name === 'rw').type, 'базовый');
      assert.ok(!text.includes(RO_TOKEN), 'полный токен не попадает в ответ');
    });

    await test('wb_request: большой ответ обрезается и сохраняется в файл', async () => {
      const { text, isError } = await rpc.tool('wb_request', { method: 'GET', url: `${mock.baseUrl}/api/v1/big` });
      assert.ok(!isError, text);
      assert.ok(text.includes('Полный ответ:'), text);
      const file = /Полный ответ: (.+)/.exec(text)[1].trim();
      assert.ok((await stat(file)).size > 1500, 'файл содержит полный ответ');
      assert.ok((await readFile(file, 'utf8')).includes('товар-399'));
    });

    await test('wb_request: csv-файл сохраняется на диск', async () => {
      const { text, isError } = await rpc.tool('wb_request', {
        method: 'GET',
        url: `${mock.baseUrl}/api/v1/documents/download`,
      });
      assert.ok(!isError, text);
      assert.ok(text.includes('Файл сохранён'), text);
      const file = /Файл сохранён: (.+)/.exec(text)[1].trim();
      assert.ok(file.endsWith('.csv'), file);
      assert.ok((await readFile(file, 'utf8')).includes('id;amount'));
    });

    await test('wb_request: 429 ретраится по X-Ratelimit-Retry', async () => {
      const { text, isError } = await rpc.tool('wb_request', { method: 'GET', url: `${mock.baseUrl}/api/v1/rate-limited` });
      assert.ok(!isError, text);
      assert.ok(text.includes('afterRetry'), text);
      assert.equal(mock.state.rateLimitedCalls, 2);
    });

    await test('неизвестный инструмент даёт JSON-RPC ошибку -32602', async () => {
      await assert.rejects(
        () => rpc.request('tools/call', { name: 'wb_nope', arguments: {} }),
        (err) => err.rpcError?.code === -32602,
      );
    });

    await test('wb_request: 409-штраф ретраится по X-Ratelimit-Retry-After', async () => {
      const { text, isError } = await rpc.tool('wb_request', { method: 'GET', url: `${mock.baseUrl}/api/v1/penalty` });
      assert.ok(!isError, text);
      assert.ok(text.includes('afterPenalty'), text);
      assert.equal(mock.state.penaltyCalls, 2);
    });

    await test('resources/subscribe + wb_refresh шлёт resources/updated', async () => {
      const subscribe = await rpc.request('resources/subscribe', { uri: 'wb://catalog/index' });
      assert.equal(subscribe.resultType, 'complete');
      const before = rpc.notifications.filter((n) => n.method === 'notifications/resources/updated').length;
      const refresh = await rpc.tool('wb_refresh', { fromDir: path.join(HERE, 'specs-sample') });
      assert.ok(!refresh.isError, refresh.text);
      const after = rpc.notifications.filter((n) => n.method === 'notifications/resources/updated');
      assert.ok(after.length > before, 'уведомление об обновлении ресурса');
      assert.equal(after.at(-1).params.uri, 'wb://catalog/index');
    });

    await test('неизвестный JSON-RPC метод даёт -32601', async () => {
      await assert.rejects(() => rpc.request('foo/bar', {}), (err) => err.rpcError?.code === -32601);
    });

    // -- защита записи: подтверждение, read-only для сырого запроса, https, multipart --

    const writeCatalogDir = path.join(tmp, 'catalog-writes');
    await buildCatalog({ fromDir: sampleDir, outDir: writeCatalogDir, verbose: false });
    await rewriteHosts(writeCatalogDir, mock.baseUrl);
    const writeIndex = JSON.parse(await readFile(path.join(writeCatalogDir, 'index.json'), 'utf8'));
    const writeOp = writeIndex.operations.find((op) => op.id === 'postV1Drafts');
    assert.ok(writeOp && writeOp.readonly === false, 'postV1Drafts — изменяющий метод');

    await test('wb_call: запись без confirm блокируется (запрос не уходит)', async () => {
      const confirmServer = await startServer({ ...env, WB_MCP_CATALOG: writeCatalogDir, WB_CONFIRM_WRITES: '1' });
      try {
        const before = mock.state.requests.length;
        const { text, isError, structuredContent } = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts' });
        assert.ok(!isError, text);
        assert.equal(structuredContent.approvalRequired, true);
        assert.ok(structuredContent.confirmId, 'выдан id подтверждения');
        assert.ok(text.includes('Требуется подтверждение'), text);
        assert.equal(mock.state.requests.length, before, 'запрос не ушёл без confirm');
      } finally {
        await confirmServer.stop();
      }
    });

    await test('wb_call: верный confirm выполняет запись, неверный и повторный — блокируют', async () => {
      const confirmServer = await startServer({ ...env, WB_MCP_CATALOG: writeCatalogDir, WB_CONFIRM_WRITES: '1' });
      try {
        const first = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts' });
        const confirmId = first.structuredContent.confirmId;

        const beforeWrong = mock.state.requests.length;
        const wrong = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts', confirm: 'wrong-id' });
        assert.equal(wrong.isError, true, 'неверный confirm — ошибка');
        assert.ok(wrong.text.includes('отклонено'), wrong.text);
        assert.equal(mock.state.requests.length, beforeWrong, 'неверный confirm не шлёт запрос');

        const before = mock.state.requests.length;
        await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts', confirm: confirmId });
        assert.equal(mock.state.requests.length, before + 1, 'запрос выполнен после подтверждения');
        assert.equal(mock.state.requests.at(-1).path, '/api/supplies/v1/drafts');

        // Одноразовость: тот же confirm повторно не сработает.
        const again = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts', confirm: confirmId });
        assert.equal(again.isError, true, 'повторный confirm — ошибка');
        assert.ok(again.text.includes('уже использован'), again.text);
        assert.equal(mock.state.requests.length, before + 1, 'повторный confirm не шлёт запрос');
      } finally {
        await confirmServer.stop();
      }
    });

    await test('wb_call: при sampling пользователь может отклонить запись', async () => {
      const confirmServer = await startServer({ ...env, WB_MCP_CATALOG: writeCatalogDir, WB_CONFIRM_WRITES: '1' }, { samplingReply: 'Отклонить' });
      try {
        await confirmServer.rpc.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: { sampling: {} },
          clientInfo: { name: 't', version: '1' },
        });
        const first = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts' });
        const before = mock.state.requests.length;
        const denied = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts', confirm: first.structuredContent.confirmId });
        assert.equal(denied.isError, true, 'отклонение пользователем — ошибка');
        assert.ok(denied.text.includes('отклонил'), denied.text);
        assert.equal(mock.state.requests.length, before, 'запрос не выполнен после отказа');
      } finally {
        await confirmServer.stop();
      }
    });

    await test('wb_call: при sampling пользователь может разрешить запись', async () => {
      const confirmServer = await startServer({ ...env, WB_MCP_CATALOG: writeCatalogDir, WB_CONFIRM_WRITES: '1' }, { samplingReply: 'Разрешить' });
      try {
        await confirmServer.rpc.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: { sampling: {} },
          clientInfo: { name: 't', version: '1' },
        });
        const first = await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts' });
        const before = mock.state.requests.length;
        await confirmServer.rpc.tool('wb_call', { id: 'postV1Drafts', confirm: first.structuredContent.confirmId });
        assert.equal(mock.state.requests.length, before + 1, 'запрос выполнен после согласия (sampling)');
        assert.equal(mock.state.requests.at(-1).path, '/api/supplies/v1/drafts');
      } finally {
        await confirmServer.stop();
      }
    });

    await test('wb_request: POST без confirm блокируется, с confirm — выполняется', async () => {
      const confirmServer = await startServer({ ...env, WB_CONFIRM_WRITES: '1' });
      try {
        const before = mock.state.requests.length;
        const blocked = await confirmServer.rpc.tool('wb_request', {
          method: 'POST',
          url: `${mock.baseUrl}/api/v1/acceptance/options`,
          body: { x: 1 },
        });
        assert.equal(blocked.structuredContent.approvalRequired, true);
        assert.equal(mock.state.requests.length, before, 'сырой POST не ушёл без confirm');

        const { text, isError } = await confirmServer.rpc.tool('wb_request', {
          method: 'POST',
          url: `${mock.baseUrl}/api/v1/acceptance/options`,
          body: { x: 1 },
          confirm: blocked.structuredContent.confirmId,
        });
        assert.ok(!isError, text);
        assert.ok(text.includes('"received"'));
      } finally {
        await confirmServer.stop();
      }
    });

    await test('wb_request: POST блокируется режимом WB_READONLY=1', async () => {
      const ro = await startServer({ ...env, WB_READONLY: '1' });
      try {
        const before = mock.state.requests.length;
        const { text, isError } = await ro.rpc.tool('wb_request', {
          method: 'POST',
          url: `${mock.baseUrl}/api/v1/acceptance/options`,
          body: { x: 1 },
        });
        assert.equal(isError, true);
        assert.ok(text.includes('WB_READONLY'), text);
        assert.equal(mock.state.requests.length, before);
      } finally {
        await ro.stop();
      }
    });

    await test('wb_request: POST блокируется read-only токеном', async () => {
      const ro = await startServer({ ...env, WB_ACCOUNTS: JSON.stringify({ ro: RO_TOKEN }) });
      try {
        const before = mock.state.requests.length;
        const { text, isError } = await ro.rpc.tool('wb_request', {
          method: 'POST',
          url: `${mock.baseUrl}/api/v1/acceptance/options`,
          body: { x: 1 },
        });
        assert.equal(isError, true);
        assert.ok(text.includes('Только чтение'), text);
        assert.equal(mock.state.requests.length, before);
      } finally {
        await ro.stop();
      }
    });

    await test('http:// к хосту wildberries.ru отклоняется (нужен https)', async () => {
      const before = mock.state.requests.length;
      const { text, isError } = await rpc.tool('wb_request', { method: 'GET', url: 'http://common-api.wildberries.ru/ping' });
      assert.equal(isError, true);
      assert.ok(text.includes('https'), text);
      assert.equal(mock.state.requests.length, before, 'запрос не выполнен');
    });

    await test('wb_request: изменяющий POST не повторяется после 5xx', async () => {
      const { text, isError } = await rpc.tool('wb_request', {
        method: 'POST',
        url: `${mock.baseUrl}/api/v1/flaky-write`,
        body: { x: 1 },
      });
      assert.equal(isError, true, '5xx на запись — ошибка');
      assert.ok(text.includes('проверь состояние'), text);
      assert.equal(mock.state.flakyCalls, 1, 'POST не повторяется вслепую после 5xx');
    });

    await test('wb_call: multipart-загрузка файла выполняется', async () => {      const upDir = path.join(tmp, 'catalog-upload');
      await mkdir(upDir, { recursive: true });
      const uploadFile = path.join(tmp, 'sample.txt');
      await writeFile(uploadFile, 'hello wb upload');
      const uploadOp = {
        id: 'postV1Upload',
        moduleKey: 'upload',
        module: 'upload',
        method: 'POST',
        path: '/api/v1/upload',
        host: mock.baseUrl,
        summary: 'загрузка файла',
        description: '',
        tags: [],
        category: 'other',
        readonly: false,
        destructive: false,
        file: false,
        params: [],
        body: {
          required: true,
          contentType: 'multipart/form-data',
          schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string' } } },
        },
      };
      await writeFile(
        path.join(upDir, 'index.json'),
        JSON.stringify({ meta: { modules: ['upload'], totalOps: 1 }, operations: [{ id: uploadOp.id, moduleKey: 'upload' }] }),
      );
      await writeFile(path.join(upDir, 'upload.json'), JSON.stringify({ moduleKey: 'upload', title: 'upload', operations: [uploadOp] }));

      const up = await startServer({ ...env, WB_MCP_CATALOG: upDir });
      try {
        const { text, isError } = await up.rpc.tool('wb_call', { id: 'postV1Upload', body: { file: uploadFile, name: 'note' } });
        assert.ok(!isError, text);
        assert.ok(text.includes('HTTP 200'), text);
        const last = mock.state.requests.at(-1);
        assert.equal(last.path, '/api/v1/upload');
        assert.match(last.contentType ?? '', /multipart\/form-data; boundary=/);
        assert.ok(last.body.includes('hello wb upload'), 'содержимое файла в теле');
        assert.ok(last.body.includes('sample.txt'), 'имя файла в теле');
        assert.ok(last.body.includes('note'), 'текстовое поле в теле');
      } finally {
        await up.stop();
      }
    });
  } finally {
    if (server) await server.stop();
  }

  try {
    await test('wb_request блокирует хосты вне wildberries.ru', async () => {
      const guardCatalog = path.join(tmp, 'catalog-guard');
      await buildCatalog({ fromDir: path.join(HERE, 'specs-sample'), outDir: guardCatalog, verbose: false });
      const guard = await startServer({
        WB_API_TOKEN: RW_TOKEN,
        WB_MCP_CATALOG: guardCatalog,
        WB_MCP_HOME: path.join(tmp, 'home2'),
      });
      try {
        const { text, isError } = await guard.rpc.tool('wb_request', { method: 'GET', url: 'https://example.com/steal' });
        assert.equal(isError, true);
        assert.ok(text.includes('wildberries.ru'), text);
      } finally {
        await guard.stop();
      }
    });

    await test('пустой каталог: сервер стартует и просит sync.mjs', async () => {
      const empty = path.join(tmp, 'empty-catalog');
      await mkdir(empty, { recursive: true });
      const srv = await startServer({ WB_API_TOKEN: RW_TOKEN, WB_MCP_CATALOG: empty, WB_MCP_HOME: home });
      try {
        const res = await srv.rpc.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        });
        assert.ok(res.serverInfo, 'initialize works without catalog');
        const out = await srv.rpc.tool('wb_search', { query: 'warehouses' });
        assert.equal(out.isError, true);
        assert.ok(out.text.includes('sync.mjs'), out.text);
      } finally {
        await srv.stop();
      }
    });

    await test('wb_refresh пересобирает каталог из локальной папки', async () => {
      const refreshCatalog = path.join(tmp, 'catalog-refresh');
      await buildCatalog({ fromDir: path.join(HERE, 'specs-sample'), outDir: refreshCatalog, verbose: false });
      const srv = await startServer({
        WB_API_TOKEN: RW_TOKEN,
        WB_MCP_CATALOG: refreshCatalog,
        WB_MCP_HOME: path.join(tmp, 'home3'),
      });
      try {
        const { text, isError } = await srv.rpc.tool('wb_refresh', { fromDir: path.join(HERE, 'specs-sample') });
        assert.ok(!isError, text);
        const data = JSON.parse(text);
        assert.equal(data.ok, true);
        assert.ok(data.operations >= 60);
      } finally {
        await srv.stop();
      }
    });
  } finally {
    await mock.close();
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
