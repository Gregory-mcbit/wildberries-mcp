#!/usr/bin/env node
// wb-mcp — Wildberries Seller API as a local MCP server (stdio transport).
//
// Design goals:
//   * zero dependencies: everything below is plain Node.js (>=20)
//   * full API coverage: every method from the official WB OpenAPI specs
//   * no VPS: the MCP client (Cursor / Claude Desktop / Codex) spawns this file
//   * context friendly: a handful of meta-tools instead of 1000+ generated tools
//   * safe: token only goes to *.wildberries.ru, bodies are never logged,
//     huge responses are written to disk instead of being pushed into context
//
// The server is a factory (createMcpServer) so it can be embedded in tests and
// other tools without spawning a child process.

import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandQueryTokens } from './search.mjs';
import { describeToken, loadTokenAccounts } from './tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const NAME = 'wb-mcp';
export const VERSION = '0.1.4';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_DEFAULT_VERSION = '2025-06-18';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const INSTRUCTIONS = [
  'Wildberries Seller API (полное покрытие официальных OpenAPI-спеков).',
  'Как работать:',
  '1) wb_search — найди метод по словам ("остатки", "отзывы", "поставки").',
  '2) wb_describe — посмотри параметры, тело запроса и лимиты метода.',
  '3) wb_call — вызови метод: params = параметры по именам из wb_describe, body = JSON-тело.',
  'Дополнительно: wb_sections (обзор), wb_token_info (что умеет токен), wb_request (сырой запрос), wb_refresh (обновить каталог).',
  'Большие ответы автоматически сохраняются в файл; предупреждай пользователя перед методами записи.',
].join('\n');

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isWbHost(hostname) {
  const h = String(hostname).toLowerCase();
  return h === 'wildberries.ru' || h.endsWith('.wildberries.ru');
}

// Key-order independent JSON, so the write-confirmation id is stable across
// re-sent (reordered) arguments.
function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function extensionForContentType(contentType) {
  if (/csv/.test(contentType)) return '.csv';
  if (/zip/.test(contentType)) return '.zip';
  if (/excel|vnd\.ms/.test(contentType)) return '.xlsx';
  if (/json/.test(contentType)) return '.json';
  return '.bin';
}

function validateEnum(param, value) {
  if (!Array.isArray(param.enum) || !param.enum.length) return;
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (!param.enum.some((allowed) => String(allowed) === String(v))) {
      throw new ToolError(
        `Параметр "${param.name}" = ${JSON.stringify(v)} недопустим. Возможные значения: ${param.enum.join(', ')}.`,
      );
    }
  }
}

export class ToolError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ToolError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export class Catalog {
  constructor(dir) {
    this.dir = dir;
    this.meta = null;
    this.operations = [];
    this.byId = new Map();
    this.moduleCache = new Map();
    this.loaded = false;
    this.error = null;
  }

  async load() {
    try {
      const raw = await readFile(path.join(this.dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      this.meta = parsed.meta;
      this.operations = Array.isArray(parsed.operations) ? parsed.operations : [];
      this.byId = new Map(this.operations.map((op) => [op.id, op]));
      this.moduleCache.clear();
      this.loaded = true;
      this.error = null;
    } catch (err) {
      this.loaded = false;
      this.error =
        `Каталог не найден в ${this.dir} (${err.code ?? err.message}). ` +
        'Собери его: `node sync.mjs` (нужна сеть) или переустанови через `node install.mjs`.';
    }
    return this.loaded;
  }

  async loadModule(moduleKey) {
    if (this.moduleCache.has(moduleKey)) return this.moduleCache.get(moduleKey);
    const raw = await readFile(path.join(this.dir, `${moduleKey}.json`), 'utf8');
    const mod = JSON.parse(raw);
    this.moduleCache.set(moduleKey, mod);
    return mod;
  }

  getOperation(id) {
    return this.byId.get(id) ?? null;
  }

  async getFullOperation(id) {
    const entry = this.byId.get(id);
    if (!entry) return null;
    const mod = await this.loadModule(entry.moduleKey);
    const op = mod.operations.find((o) => o.id === id);
    return op ? { entry, op, module: mod } : null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (uses per-method limits parsed from WB descriptions)
// ---------------------------------------------------------------------------

export class RateLimiter {
  constructor({ maxWaitMs = 120_000, defaultLimit = 5, defaultPeriodSec = 1, disabled = false } = {}) {
    this.state = new Map();
    this.maxWaitMs = maxWaitMs;
    this.defaultLimit = defaultLimit;
    this.defaultPeriodSec = defaultPeriodSec;
    this.disabled = disabled;
  }

  async wait(key, limits, onWait) {
    if (this.disabled) return;
    const cfg = limits?.personal ?? limits?.base ?? limits?.service ?? null;
    const periodSec = cfg?.periodSec && cfg.periodSec > 0 ? cfg.periodSec : this.defaultPeriodSec;
    const limit = cfg?.limit && cfg.limit > 0 ? cfg.limit : this.defaultLimit;
    const burst = cfg?.burst && cfg.burst > 0 ? cfg.burst : limit;
    const perSec = limit / periodSec;
    const minIntervalMs = (periodSec * 1000) / limit;

    let st = this.state.get(key);
    if (!st) {
      st = { tokens: burst, last: Date.now(), lastCall: 0 };
      this.state.set(key, st);
    }
    const now = Date.now();
    st.tokens = Math.min(burst, st.tokens + ((now - st.last) / 1000) * perSec);
    st.last = now;

    let waitMs = 0;
    if (st.tokens < 1) waitMs = Math.ceil(((1 - st.tokens) / perSec) * 1000);
    const sinceLast = now - st.lastCall;
    if (sinceLast < minIntervalMs) waitMs = Math.max(waitMs, Math.ceil(minIntervalMs - sinceLast));
    if (waitMs > this.maxWaitMs) {
      throw new ToolError(
        `Лимит метода исчерпан, нужно подождать ~${Math.ceil(waitMs / 1000)} с (WB limit: ${limit}/${periodSec}s). ` +
          'Повтори запрос позже или уменьши частоту.',
      );
    }
    if (waitMs > 0) {
      if (typeof onWait === 'function') onWait(waitMs);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    st.tokens = Math.max(0, st.tokens - 1);
    st.lastCall = Date.now();
  }

  penalize(key, retryAfterSec) {
    const st = this.state.get(key);
    if (st) {
      st.tokens = 0;
      st.last = Date.now() + retryAfterSec * 1000;
    }
  }
}

// ---------------------------------------------------------------------------
// MCP tool definitions (static: same for every server instance)
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'wb_search',
    title: 'Wildberries API: поиск метода',
    description:
      'Найти метод Wildberries Seller API по словам (например "остатки", "отзывы", "поставки", "цены"). ' +
      'Начни с этого инструмента. Возвращает id, метод, путь, признак readonly и краткое описание. ' +
      'Дальше: wb_describe для схемы, wb_call для вызова.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос: русские или английские слова, часть operationId или пути' },
        section: { type: 'string', description: 'Ограничить разделом: например 02-items, 11-analytics, 13-finances' },
        mode: {
          type: 'string',
          enum: ['all', 'read', 'write'],
          description: 'all — всё, read — только чтение, write — только изменяющие методы',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Сколько результатов вернуть (по умолчанию 10)' },
      },
      required: ['query'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wb_describe',
    title: 'Wildberries API: описание метода',
    description:
      'Показать полную схему метода: URL, обязательные параметры, тело запроса, схему ответа, лимиты и типы токенов. ' +
      'Используй после wb_search перед вызовом.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'id метода из wb_search, например getV1Warehouses' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wb_get',
    title: 'Wildberries API: чтение (read-only)',
    description:
      'Вызвать READ-ONLY метод Wildberries API по id. Используй этот инструмент для любых чтений ' +
      '(диагностика, отчёты, списки, остатки, отзывы) — он не требует подтверждения и работает с токеном ' +
      '«Только чтение». Параметры path/query/header — в "params", тело — в "body". ' +
      'Для изменяющих методов используй wb_call.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id read-only метода из wb_search' },
        params: {
          type: 'object',
          description: 'Именованные параметры метода (path/query/header) — имена и типы смотри в wb_describe',
          additionalProperties: true,
        },
        body: { description: 'Тело запроса для POST read-only методов (JSON)' },
        account: { type: 'string', description: 'Имя аккаунта, если настроено несколько токенов' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'wb_call',
    title: 'Wildberries API: вызов метода',
    description:
      'Вызвать ИЗМЕНЯЮЩИЙ метод Wildberries API по id (создание/обновление/удаление: цены, карточки, ' +
      'заказы, поставки, реклама, ответы на отзывы). Сервер блокирует запись, пока не передан параметр ' +
      '"confirm" — id подтверждения, который возвращает первый вызов. Для чтения используй wb_get. ' +
      'Параметры path/query/header передавай в "params", JSON-тело — в "body".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id метода из wb_search' },
        params: {
          type: 'object',
          description: 'Именованные параметры метода (path/query/header) — имена и типы смотри в wb_describe',
          additionalProperties: true,
        },
        body: { description: 'Тело запроса для POST/PUT/PATCH (JSON)' },
        confirm: {
          type: 'string',
          description: 'Для изменяющих методов: id подтверждения, который сервер вернул в прошлом ответе. Без него запись блокируется.',
        },
        account: { type: 'string', description: 'Имя аккаунта, если настроено несколько токенов' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'wb_sections',
    title: 'Wildberries API: разделы и покрытие',
    description:
      'Обзор каталога: разделы WB API, число методов в каждом, состояние токенов и дата сборки каталога. ' +
      'Полезно в начале работы, чтобы понять какие разделы доступны.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wb_token_info',
    title: 'Wildberries API: информация о токене',
    description:
      'Локально декодирует WB API токен (без запросов в WB): тип токена, срок действия, категории доступа, ' +
      'признак «только чтение» и ID продавца. Помогает понять, почему метод возвращает 403.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wb_request',
    title: 'Wildberries API: сырой запрос',
    description:
      'Прямой HTTP-запрос к любому хосту *.wildberries.ru — на случай нового метода, которого ещё нет в каталоге. ' +
      'Разрешены только хосты wildberries.ru. Указывай url (или host+path), query, body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP метод',
        },
        url: { type: 'string', description: 'Полный URL (host и path), например https://common-api.wildberries.ru/ping' },
        host: { type: 'string', description: 'Хост, если не указан url, например https://finance-api.wildberries.ru' },
        path: { type: 'string', description: 'Путь, если не указан url, например /api/v1/account/balance' },
        query: { type: 'object', description: 'Query-параметры', additionalProperties: true },
        headers: { type: 'object', description: 'Дополнительные заголовки (Authorization игнорируется)', additionalProperties: true },
        body: { description: 'Тело запроса (JSON)' },
        confirm: {
          type: 'string',
          description: 'Для изменяющих методов: id подтверждения из прошлого ответа сервера. Без него запись блокируется.',
        },
        account: { type: 'string', description: 'Имя аккаунта' },
      },
      required: ['method'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'wb_refresh',
    title: 'Wildberries API: обновить каталог',
    description:
      'Скачать свежие OpenAPI-спеки с dev.wildberries.ru и пересобрать каталог методов (когда WB меняет API). ' +
      'Требует сеть; занимает несколько секунд.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: { type: 'string', enum: ['ru', 'en'], description: 'Язык описаний (по умолчанию ru)' },
        fromDir: { type: 'string', description: 'Собрать из локальной папки со .yaml вместо скачивания' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// ---------------------------------------------------------------------------
// MCP prompts: scenario templates ("call this tool when that happens")
// ---------------------------------------------------------------------------

export const PROMPTS = [
  {
    name: 'sales-accelerator',
    title: 'Разгон продаж: полный аудит и план роста',
    description:
      'Глубокая диагностика роста: воронка и CTR, контент карточек, SEO/поисковые запросы, цены, ' +
      'реклама и ставки, акции, остатки, отзывы/рейтинг, возвраты. На выходе — таблица потерь в ₽, ' +
      'приоритеты impact/effort и план на 7/30 дней с конкретными методами WB.',
    arguments: [
      { name: 'period', description: 'Период анализа в днях или дата начала YYYY-MM-DD (по умолчанию 28 дней).', required: false },
      { name: 'focus', description: 'Ограничить блоком: all | ads | content | seo | pricing | stocks (по умолчанию all).', required: false },
      { name: 'target', description: 'Цель роста, например "+20% GMV" (для приоритизации).', required: false },
      { name: 'margin', description: 'Если известна себестоимость/маржа, передай для анализа цен.', required: false },
    ],
  },
  {
    name: 'diagnose-orders-drop',
    title: 'Почему упали заказы',
    description:
      'Пошаговая диагностика падения заказов: сравнить заказы/продажи по дням, проверить воронку, ' +
      'остатки на складах WB, статус рекламных кампаний и блокировки карточек.',
    arguments: [
      { name: 'date', description: 'Дата начала анализа (YYYY-MM-DD). По умолчанию — вчера.', required: false },
      { name: 'days', description: 'За сколько дней сравнить (по умолчанию 7).', required: false },
    ],
  },
  {
    name: 'check-stock',
    title: 'Проверить остатки',
    description:
      'Найти товары с нулевым или низким остатком на складах WB и на складах продавца, ' +
      'подсказать, что нужно пополнить.',
    arguments: [{ name: 'threshold', description: 'Порог остатка (по умолчанию 5).', required: false }],
  },
  {
    name: 'reply-reviews',
    title: 'Ответить на отзывы',
    description:
      'Найти неотвеченные отзывы и вопросы покупателей, показать их и подготовить ответы ' +
      '(публикация — только после подтверждения пользователя через wb_call).',
    arguments: [{ name: 'limit', description: 'Сколько отзывов посмотреть (по умолчанию 20).', required: false }],
  },
  {
    name: 'weekly-report',
    title: 'Недельный отчёт по магазину',
    description: 'Собрать сводку: заказы, продажи, выкупы, остатки, возвраты и реклама за неделю.',
    arguments: [{ name: 'from', description: 'С даты (YYYY-MM-DD).', required: false }],
  },
];

function buildPrompt(name, args = {}) {
  const a = (key) => (args[key] ? String(args[key]) : null);
  if (name === 'sales-accelerator') {
    const period = a('period') ?? '28 дней';
    const focus = a('focus') ?? 'all';
    const target = a('target') ?? 'не задана (предложи реалистичную сам)';
    const margin = a('margin') ?? 'неизвестна (спроси у пользователя, если нужен анализ маржи)';
    const blocks = {
      all: 'A-F (все блоки)',
      ads: 'D (реклама и ставки)',
      content: 'A-B (воронка и контент)',
      seo: 'C (SEO и поисковые запросы)',
      pricing: 'E (цены и скидки)',
      stocks: 'F (остатки и логистика)',
    };
    return {
      description: 'Разгон продаж: полный аудит и план роста',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Ты — аналитик роста продаж на Wildberries. Проведи полный аудит магазина и выдай план роста.',
              `Вводные: период — ${period}; фокус — ${blocks[focus] ?? blocks.all}; цель — ${target}; маржа/себестоимость — ${margin}.`,
              '',
              'ЖЁСТКИЕ ПРАВИЛА:',
              '• Только чтение: используй ТОЛЬКО wb_get (read-only). Никаких wb_call и изменений данных магазина.',
              '• Изменяющие методы НЕ вызывай — перечисли их в финальном плане как действия «требует подтверждения».',
              '• Все цифры — только из ответов API; указывай метод и период. Нет данных — так и напиши, не выдумывай.',
              '• Если id метода не найден — wb_search по словам (рус/англ), затем wb_describe.',
              '• Если токен не имеет нужной категории (wb_token_info) — пропусти блок и укажи, что запросить.',
              '• Лимиты WB соблюдает сервер; не вызывай один и тот же метод повторно без нужды. Большие ответы сохраняются в файл — читай файл, а не перезапрашивай.',
              '',
              'ШАГ 0. Контекст: wb_sections (каталог), wb_token_info (срок, категории, read-only).',
              '',
              'ШАГ 1. База (всегда): заказы и продажи за период и предыдущий такой же период.',
              '• getV1SupplierOrders (dateFrom, flag), getV1SupplierSales (dateFrom, flag) — статистика.',
              '• Динамика по дням, топ/антитоп SKU по выручке, средний чек, доля выкупа (sales/orders).',
              '',
              'ШАГ 2. Воронка и CTR (блок A):',
              '• postV3SalesFunnelProducts, postV3SalesFunnelProductsHistory, postV3SalesFunnelGroupedHistory (analytics).',
              '• Смотри: показы → клики → CTR → корзина → заказ → выкуп.',
              '• Диагнозы: много показов + низкий CTR → контент/фото/название;',
              '  хороший CTR + мало заказов → цена/отзывы/остаток; заказы есть + низкий выкуп → качество/логистика.',
              '• Выдели SKU с наибольшим потенциалом (показы высокие, CTR ниже среднего по категории).',
              '',
              'ШАГ 3. Контент карточек (блок B):',
              '• postV2GetCardsList (фото, название, характеристики, описание), postV2CardsErrorList,',
              '  getV1AnalyticsBannedProducsBlocked (заблокированные/причины), postV1RecommendationsList, postV2ItemRating.',
              '• Проверь: количество и качество фото (5+), видео/инфографика, длина и ключи в названии,',
              '  заполненность характеристик, ошибки карточек, причины блокировок.',
              '• На каждую проблему — конкретное действие (что заменить/добавить), приоритет по влиянию на CTR.',
              '',
              'ШАГ 4. SEO и поисковые запросы (блок C):',
              '• postV2SearchReportReport, postV2SearchReportProductSearchTexts, postV2SearchReportProductOrders,',
              '  postV2SearchReportTableGroups, postV2NmReportDownloads (отчёт по товарам).',
              '• Для рекламных кластеров: postV0NormqueryList, postV0NormqueryStats, postV1NormqueryStats, postV0NormqueryGetBids.',
              '• Ищи: запросы с показами без заказов, запросы конкурентов/категорий с нашей низкой позицией,',
              '  брендовые запросы; предложи ключи в название/характеристики/описание и минус-фразы для рекламы.',
              '',
              'ШАГ 5. Цены и скидки (блок E):',
              '• getV2ListGoodsFilter (текущие цены/скидки), getV2HistoryTasks + getV2HistoryGoodsTask (история),',
              '  getV2BufferTasks (загруженные изменения, ещё не применённые).',
              '• Сопоставь цену с конверсией и позицией; найди SKU, где цена выше конкурентной без роста конверсии.',
              '• Если маржа известна — посчитай допустимый коридор скидки; если нет — попроси себестоимость у пользователя.',
              '',
              'ШАГ 6. Реклама и ставки (блок D):',
              '• getV1Adverts (кампании и статусы), postV1Stats / getV3Fullstats (статистика), getV1Count, getV1PromotionCount,',
              '  getV0BidsRecommendations, postV1BidsMin, postV0NormqueryGetBids.',
              '• Смотри: кампании с показами без заказов, CTR по кампаниям, ставки ниже рекомендованных,',
              '  неэффективные кластеры (кандидаты в минус), кампании на паузе с остатком товара.',
              '• Write-методы для плана (не вызывать): patchV1Bids, postV0NormquerySetMinus, postV1NormqueryBids.',
              '',
              'ШАГ 7. Акции (часть блока D/E):',
              '• getV1CalendarPromotions, getV1CalendarPromotionsDetails, getV1CalendarPromotionsNomenclatures.',
              '• Найди акции, где товар может участвовать с выгодой; действие для плана: postV1CalendarPromotionsUpload (write).',
              '',
              'ШАГ 8. Остатки и логистика (блок F):',
              '• postV2StocksReportProductsProducts / Groups / Sizes, postV2StocksReportOffices,',
              '  getV1WarehouseRemains, postV1StocksReportWbWarehouses, postV1StocksReportSellerWarehouses.',
              '• Найди SKU с продажами и нулевым/низким остатком — оцени потерянную выручку =',
              '  средние продажи/день × дни отсутствия × цена.',
              '',
              'ШАГ 9. Отзывы, рейтинг, возвраты (всегда):',
              '• getV1Rating, getV1FeedbacksCountUnanswered, getV1QuestionsCountUnanswered, getV1Feedbacks, getV1Questions,',
              '  getV1Claims, getV1AnalyticsAntifraudDetails.',
              '• Оцени влияние рейтинга на конверсию; неотвеченный негатив — действие «ответить» (postV1FeedbacksAnswer — write).',
              '',
              'ШАГ 10. Синтез и план:',
              '1) Таблица: Проблема | Данные (метод, период, цифры) | Потеря/потенциал, ₽ | Действие | Метод WB (read/write).',
              '2) Матрица приоритетов impact × effort; top-10 действий.',
              '3) План на 7 дней (быстрые победы) и 30 дней (системные изменения).',
              '4) Список write-методов для реализации — каждый только после подтверждения пользователя.',
              '5) Метрики контроля: CTR, конверсия в заказ, выкуп, ДРР/CPO, остаток, рейтинг.',
              '',
              'Формат ответа: markdown, таблицы, суммы в ₽, периоды датами. Кратко и по делу, без воды.',
              'Если данных для блока нет (нет категории токена/нет отчёта) — зафиксируй это в конце как «не проверено».',
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'diagnose-orders-drop') {
    const date = a('date') ?? 'вчера';
    const days = a('days') ?? '7';
    return {
      description: 'Диагностика падения заказов',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Выясни, почему упали заказы (дата: ${date}, окно сравнения: ${days} дн.).`,
              'Работай только read-only инструментами (wb_get) и не меняй данные магазина.',
              '',
              'План:',
              '1) wb_search {"query":"заказы","mode":"read"} → найди статистику заказов.',
              '2) wb_describe по найденному id → уточни обязательные параметры и лимит.',
              '3) wb_get: заказы за нужный период; затем то же для продаж (wb_search "продажи").',
              '4) Сравни количество/сумму по дням, найди день и товары провала.',
              '5) Проверь гипотезы по порядку, останавливаясь когда причина ясна:',
              '   - воронка: wb_search "воронка" → postV3SalesFunnelProducts (показы/клики/конверсия);',
              '   - остатки: wb_search "остатки на складах" → отчёт по складам WB;',
              '   - реклама: wb_search "кампании" → getV1Adverts, проверь статусы и бюджеты;',
              '   - блокировки: wb_search "заблокированные карточки" → список причин;',
              '   - цены: wb_search "цены" → текущие цены и история изменений.',
              '6) Собери короткий вывод: цифры, наиболее вероятная причина, что сделать (без записи в WB).',
              '',
              'Учитывай лимиты WB: сервер сам ждёт паузу, но не вызывай один и тот же метод повторно без нужды.',
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'check-stock') {
    const threshold = a('threshold') ?? '5';
    return {
      description: 'Проверка остатков',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Найди товары с остатком <= ${threshold} на складах WB и на складах продавца.`,
              'План: wb_search "остатки на складах" → wb_describe → wb_get отчёт по складам WB;',
              'затем wb_search "остатки на складах продавца" → wb_get. Сведи таблицу: SKU, остаток, склад.',
              'В конце предложи, что пополнить. Данные не меняй.',
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'reply-reviews') {
    const limit = a('limit') ?? '20';
    return {
      description: 'Ответы на отзывы',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Посмотри до ${limit} неотвеченных отзывов и вопросов.`,
              'План: wb_search "отзывы" / "вопросы" → wb_describe → wb_get списки; выдели негатив и повторяющиеся темы.',
              'Подготовь ответы, покажи их пользователю и опубликуй только после явного подтверждения (wb_call).',
            ].join('\n'),
          },
        },
      ],
    };
  }
  if (name === 'weekly-report') {
    const from = a('from') ?? '7 дней назад';
    return {
      description: 'Недельный отчёт',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Собери отчёт по магазину за период с ${from}.`,
              'План: через wb_search найди и через wb_get собери: заказы, продажи/выкупы, остатки, возвраты, статистику рекламы.',
              'Сведи в таблицы, посчитай динамику к предыдущему периоду, выдели 3 главных вывода.',
            ].join('\n'),
          },
        },
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer({ env = process.env, input, output, error = process.stderr } = {}) {
  const config = {
    name: NAME,
    version: VERSION,
    catalogDir: env.WB_MCP_CATALOG || path.join(HERE, 'catalog'),
    maxOutput: Number(env.WB_MAX_OUTPUT ?? 80_000),
    maxWaitMs: Number(env.WB_MAX_WAIT_MS ?? 120_000),
    httpTimeoutMs: Number(env.WB_HTTP_TIMEOUT_MS ?? 120_000),
    readOnlyMode: env.WB_READONLY === '1' || env.WB_READONLY === 'true',
    // Обязательное подтверждение изменяющих запросов (wb_call/wb_request). Отключить: WB_CONFIRM_WRITES=0.
    confirmWrites: env.WB_CONFIRM_WRITES !== '0' && env.WB_CONFIRM_WRITES !== 'false',
    // Для хостов wildberries.ru разрешён только https://. Отключить (тесты): WB_ALLOW_HTTP=1.
    allowHttp: env.WB_ALLOW_HTTP === '1',
    allowAnyHost: env.WB_ALLOW_ANY_HOST === '1',
    // WB_RATE_LIMIT=off — только для тестов/бенчмарков: отключает ожидание лимитов.
    rateLimitDisabled: env.WB_RATE_LIMIT === 'off' || env.WB_RATE_LIMIT === '0',
    // WB_AUTO_SYNC=1 — собрать каталог при старте, если его нет (режим npx github:...).
    autoSync: env.WB_AUTO_SYNC === '1',
    dataDir: env.WB_MCP_HOME || path.join(os.homedir(), '.wb-mcp'),
  };
  config.downloadDir = path.join(config.dataDir, 'downloads');
  config.outputDir = path.join(config.dataDir, 'out');

  const log = (...args) => error.write(`[${config.name}] ${args.join(' ')}\n`);

  const tokenState = loadTokenAccounts(env);
  const accounts = tokenState.accounts;
  const catalog = new Catalog(config.catalogDir);
  const limiter = new RateLimiter({ maxWaitMs: config.maxWaitMs, disabled: config.rateLimitDisabled });

  // Client capabilities (sampling etc.), reported in `initialize`.
  let clientCapabilities = {};
  // One-time, expiring, operation-bound approvals for mutating calls.
  const pendingApprovals = new Map();
  const APPROVAL_TTL_MS = 300_000;
  // Outbound requests to the client (sampling/createMessage) and their responses.
  let nextOutboundId = 0;
  const pendingOutbound = new Map();

  function approvalFingerprint({ method, url, params, body, token }) {
    return createHash('sha256')
      .update([method, url, stableStringify(params ?? null), stableStringify(body ?? null), String(token ?? '')].join('\n'))
      .digest('hex');
  }

  function issueApproval(fingerprint) {
    for (const [id, rec] of pendingApprovals) if (rec.expiresAt < Date.now()) pendingApprovals.delete(id);
    const confirmId = randomBytes(16).toString('hex');
    pendingApprovals.set(confirmId, { fingerprint, expiresAt: Date.now() + APPROVAL_TTL_MS, used: false });
    return confirmId;
  }

  function consumeApproval(confirmId, fingerprint) {
    const rec = pendingApprovals.get(String(confirmId));
    if (!rec) return { ok: false, reason: 'код неизвестен или истёк' };
    if (rec.expiresAt < Date.now()) {
      pendingApprovals.delete(String(confirmId));
      return { ok: false, reason: 'код истёк (срок действия 5 минут)' };
    }
    if (rec.used) return { ok: false, reason: 'код уже использован (одноразовый)' };
    if (rec.fingerprint !== fingerprint) return { ok: false, reason: 'код не соответствует этой операции' };
    rec.used = true;
    return { ok: true, rec };
  }

  function requestFromClient(method, params, timeoutMs = 30_000) {
    const id = `wb-srv-${++nextOutboundId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingOutbound.delete(id);
        reject(new Error(`клиент не ответил на ${method}`));
      }, timeoutMs);
      pendingOutbound.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async function elicitApproval(summary) {
    if (!clientCapabilities.sampling) return true; // нет доверенного канала — остаётся одноразовый nonce
    try {
      const result = await requestFromClient(
        'sampling/createMessage',
        {
          messages: [{ role: 'user', content: { type: 'text', text: summary } }],
          systemPrompt:
            'Ты — контролёр операции записи в кабинет Wildberries. Ответь ровно одним словом: "Разрешить" или "Отклонить".',
          maxTokens: 8,
        },
        config.httpTimeoutMs,
      );
      const text = String(result?.content?.text ?? '').trim().toLowerCase();
      return /разрешить|approve|yes|да|подтверждаю/i.test(text);
    } catch {
      return false; // fail closed: без явного согласия не выполняем
    }
  }

  function pickAccount(name) {
    if (name) {
      if (!accounts.has(name)) {
        throw new ToolError(
          `Аккаунт "${name}" не найден. Доступны: ${[...accounts.keys()].join(', ') || '(ни одного)'}. ` +
            'Токены задаются через WB_API_TOKEN или WB_ACCOUNTS в env MCP-клиента.',
        );
      }
      return { name, token: accounts.get(name) };
    }
    const first = [...accounts.entries()][0];
    if (!first) {
      throw new ToolError(
        'Нет токена Wildberries. Добавь "WB_API_TOKEN": "<токен>" в env сервера в конфиге MCP-клиента. ' +
          'Токен создаётся в кабинете продавца: Интеграции по API. Без токена доступны wb_search и wb_describe.',
      );
    }
    return { name: first[0], token: first[1] };
  }

  function assertAllowedUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError(`Некорректный URL: ${url}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new ToolError('Разрешены только http/https');
    if (isWbHost(parsed.hostname)) {
      if (parsed.protocol !== 'https:' && !config.allowHttp) {
        throw new ToolError(
          `Для хостов wildberries.ru разрешён только https:// (получено ${parsed.protocol}//${parsed.hostname}). ` +
            'Токен не отправляется по открытому HTTP. Для локальных тестовых серверов — WB_ALLOW_ANY_HOST=1.',
        );
      }
    } else if (!config.allowAnyHost) {
      throw new ToolError(
        `Хост ${parsed.hostname} не относится к wildberries.ru. ` +
          'Для своих тестовых серверов разреши явно: WB_ALLOW_ANY_HOST=1.',
      );
    }
    return parsed;
  }

  function buildUrl(op, params) {
    let pathname = op.path;
    for (const p of op.params.filter((x) => x.in === 'path')) {
      const value = params[p.name];
      if (value === undefined || value === null) {
        throw new ToolError(`Не передан обязательный path-параметр "${p.name}" для ${op.method} ${op.path}`);
      }
      pathname = pathname.split(`{${p.name}}`).join(encodeURIComponent(String(value)));
    }
    if (/\{[^}]+\}/.test(pathname)) throw new ToolError(`В path остались неподставленные параметры: ${pathname}`);

    const url = new URL(pathname, op.host);
    for (const p of op.params.filter((x) => x.in === 'query')) {
      const value = params[p.name];
      if (value === undefined || value === null) continue;
      validateEnum(p, value);
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(p.name, String(item));
      } else if (typeof value === 'object') {
        url.searchParams.set(p.name, JSON.stringify(value));
      } else {
        url.searchParams.set(p.name, String(value));
      }
    }
    return url;
  }

  function requestHeaders(op, params, token) {
    const headers = { Authorization: token, Accept: 'application/json', 'user-agent': `${config.name}/${config.version}` };
    for (const p of op.params.filter((x) => x.in === 'header')) {
      const value = params[p.name];
      if (value === undefined || value === null) continue;
      validateEnum(p, value);
      headers[p.name] = String(value);
    }
    return headers;
  }

  async function serializeBody(op, body) {
    if (body === undefined || body === null) {
      if (op.body?.required) {
        throw new ToolError(
          `Метод требует тело запроса (JSON). Передай его в аргументе "body". Схема: wb_describe ${op.id}`,
        );
      }
      return undefined;
    }
    let payload = body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // keep string as-is
      }
    }
    if (op.body?.contentType?.includes('x-www-form-urlencoded')) {
      if (typeof payload !== 'object') throw new ToolError('Тело должно быть объектом для form-urlencoded');
      return {
        body: new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString(),
        contentType: op.body.contentType,
      };
    }
    if (op.body?.contentType?.includes('multipart')) {
      if (typeof payload !== 'object' || payload === null) {
        throw new ToolError('Тело multipart должно быть объектом: поля по именам из wb_describe, файлы — как path или {path|content, filename}.');
      }
      const schemaProps = op.body?.schema?.properties ?? {};
      const form = new FormData();
      for (const [name, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue;
        const prop = schemaProps[name];
        const isFile = prop && (prop.type === 'file' || prop.format === 'binary' || (prop.type === 'string' && prop.format === 'binary'));
        if (isFile) {
          let buffer;
          let filename = name;
          if (typeof value === 'string') {
            buffer = await readFile(value);
            filename = path.basename(value);
          } else if (value && typeof value === 'object') {
            if (value.path) {
              buffer = await readFile(String(value.path));
              filename = value.filename ?? path.basename(String(value.path));
            } else if (value.content) {
              buffer = Buffer.from(String(value.content), 'base64');
              filename = value.filename ?? name;
            } else {
              throw new ToolError(`Файл "${name}": укажи path (путь к файлу) или content (base64).`);
            }
          } else {
            throw new ToolError(`Файл "${name}": ожидается путь к файлу или {path|content, filename}.`);
          }
          form.append(name, new Blob([buffer]), filename);
        } else {
          form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      // fetch сам проставит content-type с boundary; не дублируем заголовок.
      return { body: form, contentType: undefined };
    }
    return { body: JSON.stringify(payload), contentType: op.body?.contentType ?? 'application/json' };
  }

  async function saveToDir(dir, fileName, data) {
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, fileName);
    await writeFile(target, data);
    return target;
  }

  async function executeHttp({ url, method, headers, body, contentType, opId, onRetry, mutating = false }) {
    const started = Date.now();
    const attempts = 3;
    let totalWaited = 0;
    let penalized409 = false;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) },
          body,
          signal: AbortSignal.timeout(config.httpTimeoutMs),
        });
      } catch (err) {
        lastError = err;
        // Изменяющие запросы не повторяем вслепую: ответ мог потеряться, а объект — создаться.
        if (mutating) {
          throw new ToolError(
            `Сетевой сбой при ${method} ${url}: ${err.name === 'TimeoutError' ? 'таймаут' : err.message}. ` +
              'Операция могла выполниться, а ответ потеряться — проверь состояние в WB, прежде чем повторять.',
          );
        }
        if (attempt < attempts) {
          const wait = 1000 * attempt;
          totalWaited += wait;
          if (typeof onRetry === 'function') onRetry({ attempt, waitMs: wait, reason: 'network' });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw new ToolError(
          `Не удалось выполнить запрос к WB (${method} ${url}): ` +
            `${err.name === 'TimeoutError' ? 'таймаут' : err.message}. Проверь сеть и повтори.`,
        );
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('x-ratelimit-retry') ?? res.headers.get('retry-after') ?? 5);
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
        if (opId) limiter.penalize(opId, retryAfter);
        if (attempt < attempts && totalWaited + retryAfter * 1000 <= config.maxWaitMs) {
          totalWaited += retryAfter * 1000;
          log(`429 for ${opId ?? url}; waiting ${retryAfter}s (attempt ${attempt})`);
          if (typeof onRetry === 'function') onRetry({ attempt, waitMs: retryAfter * 1000, reason: 'rate-limit' });
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new ToolError(
          `WB ограничил запросы (429). Повтори через ${retryAfter} с` +
            (reset ? `, лимит восстановится через ${reset} с` : '') +
            '. Учти: ошибки 4xx считаются как 10 запросов в лимите.',
        );
      }
      if (res.status === 409) {
        // WB 409 is a penalty for bursts (or data validation). Headers say how
        // long to back off: X-Ratelimit-Retry-After / X-Ratelimit-Reset.
        const retryAfter = Number(
          res.headers.get('x-ratelimit-retry-after') ?? res.headers.get('x-ratelimit-retry') ?? res.headers.get('retry-after') ?? 5,
        );
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
        const penaltySec = Math.max(retryAfter, reset);
        const waitMs = penaltySec * 1000;
        if (opId) limiter.penalize(opId, penaltySec);
        if (!penalized409 && attempt < attempts && totalWaited + waitMs <= config.maxWaitMs) {
          penalized409 = true;
          totalWaited += waitMs;
          log(`409 penalty for ${opId ?? url}; waiting ${penaltySec}s (attempt ${attempt})`);
          if (typeof onRetry === 'function') onRetry({ attempt, waitMs, reason: 'penalty-409' });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new ToolError(
          `WB вернул 409 (штраф за всплеск или ошибка данных). Подожди ~${penaltySec} с и повтори; ` +
            'не делай повторных запросов сразу — штраф продлевается.',
        );
      }
      if (res.status >= 500 && res.status < 600) {
        if (mutating) {
          throw new ToolError(
            `WB вернул ${res.status} на ${method} ${url}. Операция могла выполниться, а ответ потерян — ` +
              'проверь состояние в WB, не повторяй вслепую.',
          );
        }
        if (attempt < attempts) {
          const wait = 1000 * attempt;
          totalWaited += wait;
          if (typeof onRetry === 'function') onRetry({ attempt, waitMs: wait, reason: 'server-error' });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      }
      return { res, elapsedMs: Date.now() - started };
    }
    throw new ToolError(`Запрос не удался после ${attempts} попыток: ${lastError?.message ?? 'unknown'}`);
  }

  async function readResponse(res) {
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('json')) {
      const text = await res.text();
      try {
        return { kind: 'json', value: JSON.parse(text), text };
      } catch {
        return { kind: 'text', value: text, text };
      }
    }
    if (/octet-stream|zip|excel|vnd\.ms|csv/.test(contentType)) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { kind: 'binary', buffer, contentType };
    }
    const text = await res.text();
    return { kind: 'text', value: text, text, contentType };
  }

  function wbErrorMessage(res, parsed) {
    const status = res.status;
    const body = parsed?.value ?? {};
    const title = body?.title ?? body?.error ?? res.statusText;
    const detail = body?.detail ?? body?.message ?? '';
    const requestId = body?.requestId ?? body?.request_id ?? '';
    const lines = [`WB API вернул ${status}${title ? ` (${title})` : ''}${detail ? `: ${detail}` : ''}`];
    if (requestId) lines.push(`requestId: ${requestId}`);
    if (status === 401) {
      lines.push(
        'Токен не принят: проверь, что он не истёк (180 дней) и создан в Интеграциях по API. wb_token_info покажет срок.',
      );
    } else if (status === 403) {
      lines.push(
        'Доступ запрещён. Причины: категория токена не покрывает метод, тип токена не подходит (базовый/тестовый), ' +
          'у токена режим «только чтение», или нужна подписка «Джем». Проверь wb_token_info и права токена в кабинете.',
      );
    } else if (status === 404) {
      lines.push('Метод/путь не найден. Возможно, WB изменил API: выполни wb_refresh и проверь актуальный каталог.');
    } else if (status === 409) {
      lines.push('WB вернул 409. Не повторяй запрос сразу: проверь данные запроса (часть объектов/ссылок некорректна).');
    } else if (status === 422) {
      lines.push('Ошибка валидации данных запроса: проверь обязательные поля и ограничения в wb_describe.');
    }
    return lines.join('\n');
  }

  async function finalizeResult(payload, { opId, url, method, status, elapsedMs }) {
    const header = `HTTP ${status} · ${method} ${new URL(url).pathname} · ${elapsedMs} ms`;
    const fileNameBase = `${timestamp()}-${(opId ?? 'request').replace(/[^\w.-]+/g, '_')}`;

    if (payload.kind === 'binary') {
      const filePath = await saveToDir(
        config.downloadDir,
        fileNameBase + extensionForContentType(payload.contentType ?? ''),
        payload.buffer,
      );
      const sha = createHash('sha256').update(payload.buffer).digest('hex').slice(0, 16);
      return {
        text: [
          header,
          `Файл сохранён: ${filePath}`,
          `Размер: ${payload.buffer.length} байт, sha256: ${sha}…, content-type: ${payload.contentType}`,
          'Подсказка: читай файл локально (csv/xlsx/bin), не вставляй целиком в контекст.',
        ].join('\n'),
      };
    }

    const raw = payload.kind === 'json' ? JSON.stringify(payload.value, null, 2) : payload.text;
    if (raw.length <= config.maxOutput) return { text: `${header}\n\n${raw}` };

    const rest = raw.length - config.maxOutput;
    const filePath = await saveToDir(config.outputDir, fileNameBase + '.json', raw);
    return {
      text: [header, `…вывод обрезан (${rest} символов).`, `Полный ответ: ${filePath}`, '', raw.slice(0, config.maxOutput)].join(
        '\n',
      ),
    };
  }

  async function callOperation(op, args, ctx = {}) {
    const progress = typeof ctx.progress === 'function' ? ctx.progress : null;
    if (config.readOnlyMode && !op.readonly) {
      throw new ToolError(`Режим WB_READONLY=1: метод ${op.id} изменяет данные и заблокирован.`);
    }
    const account = pickAccount(args.account);
    const tokenInfo = describeToken(account.token);
    if (!tokenInfo.valid && tokenInfo.expiresAt) {
      throw new ToolError(`Токен аккаунта "${account.name}" истёк ${tokenInfo.expiresAt}. Создай новый токен в кабинете WB.`);
    }
    if (!op.readonly && tokenInfo.readOnly) {
      throw new ToolError(
        `Токен аккаунта "${account.name}" создан в режиме «Только чтение», поэтому ${op.id} (запись) вернёт 403. ` +
          'Создай токен с доступом «Чтение и запись» или используй read-only методы.',
      );
    }

    const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
    const known = new Set(op.params.map((p) => p.name));
    const warnings = [];
    for (const key of Object.keys(params)) {
      if (!known.has(key)) warnings.push(`неизвестный параметр "${key}" проигнорирован`);
    }

    await limiter.wait(op.id, op.limits, (waitMs) => progress?.(0.2, 1, `лимит WB: ожидание ${Math.round(waitMs / 1000)} с`));
    progress?.(0.4, 1, `запрос к WB: ${op.method} ${op.path}`);
    const url = buildUrl(op, params);
    assertAllowedUrl(url.toString());

    // Обязательное подтверждение изменяющих методов: первый вызов не шлёт запрос,
    // а возвращает одноразовый id подтверждения; реальный запрос — только с совпавшим
    // (и не использованным) id, а при наличии sampling — с явным согласием человека.
    if (!op.readonly && config.confirmWrites) {
      const fingerprint = approvalFingerprint({ method: op.method, url: url.toString(), params, body: args.body, token: account.token });
      if (!args.confirm) {
        const confirmId = issueApproval(fingerprint);
        return {
          text: [
            `⚠ Требуется подтверждение: ${op.method} ${url.pathname} ИЗМЕНИТ данные магазина.`,
            `params: ${JSON.stringify(params)}`,
            ...(args.body !== undefined ? [`body: ${JSON.stringify(args.body)}`] : []),
            '',
            `Повтори вызов wb_call с "confirm": "${confirmId}" (код одноразовый, действует 5 минут).`,
            'Отключить подтверждение (осознанный риск): env WB_CONFIRM_WRITES=0.',
          ].join('\n'),
          structured: {
            approvalRequired: true,
            confirmId,
            expiresInSec: APPROVAL_TTL_MS / 1000,
            method: op.method,
            path: url.pathname,
            params,
            body: args.body ?? null,
          },
        };
      }
      const check = consumeApproval(args.confirm, fingerprint);
      if (!check.ok) throw new ToolError(`Подтверждение отклонено: ${check.reason}. Запусти операцию заново.`);
      const approved = await elicitApproval(
        `Разрешить изменение кабинета Wildberries?\n\n${op.method} ${url.pathname}\nparams: ${JSON.stringify(params)}\n` +
          (args.body !== undefined ? `body: ${JSON.stringify(args.body)}` : '') +
          '\n\nОтветь "Разрешить", чтобы выполнить, или "Отклонить", чтобы отменить.',
      );
      if (!approved) {
        pendingApprovals.delete(String(args.confirm));
        throw new ToolError('Пользователь отклонил изменение — операция не выполнена.');
      }
    }

    const headers = requestHeaders(op, params, account.token);
    const bodyInfo = await serializeBody(op, args.body);

    const { res, elapsedMs } = await executeHttp({
      url: url.toString(),
      method: op.method,
      headers,
      body: bodyInfo?.body,
      contentType: bodyInfo?.contentType,
      opId: op.id,
      mutating: !op.readonly,
      onRetry: ({ attempt, waitMs, reason }) =>
        progress?.(0.5, 1, `повтор ${attempt} (${reason}): ожидание ${Math.round(waitMs / 1000)} с`),
    });
    progress?.(0.9, 1, `ответ WB: HTTP ${res.status}`);

    if (res.status === 204) {
      return { text: `HTTP 204 · ${op.method} ${url.pathname} · пустой успешный ответ (без тела)` };
    }
    const payload = await readResponse(res);
    if (!res.ok) throw new ToolError(wbErrorMessage(res, payload), { status: res.status });
    const result = await finalizeResult(payload, {
      opId: op.id,
      url: url.toString(),
      method: op.method,
      status: res.status,
      elapsedMs,
    });
    if (warnings.length) result.text += `\n\nВнимание: ${warnings.join('; ')}`;
    return result;
  }

  // -- tools ---------------------------------------------------------------

  function requireCatalog() {
    if (!catalog.loaded) {
      throw new ToolError(
        catalog.error ??
          'Каталог WB API не загружен. Выполни `node sync.mjs` в папке wb-mcp (или `node install.mjs`) и перезапусти сервер.',
      );
    }
  }

  function toolSections() {
    requireCatalog();
    const missing = catalog.meta.missing ?? [];
    const data = {
      catalog: {
        generatedAt: catalog.meta.generatedAt,
        source: catalog.meta.source,
        coverage: {
          expectedModules: catalog.meta.expectedModules ?? catalog.meta.modules.length,
          builtModules: catalog.meta.modules.length,
          missingModules: missing.map((m) => m.key),
        },
        modules: catalog.meta.modules,
        totalOperations: catalog.meta.totalOps,
      },
      accounts: [...accounts.entries()].map(([name, token]) => ({ name, ...describeToken(token) })),
      readOnlyMode: config.readOnlyMode,
      hints: [
        'wb_search — поиск метода по словам',
        'wb_describe <id> — параметры и схема',
        'wb_call <id> — вызов',
        'wb_refresh — пересобрать каталог из официальных спеков',
      ],
      ...(missing.length
        ? {
            warning:
              `Каталог неполный: не собраны модули ${missing.map((m) => m.key).join(', ')}. ` +
              'Запусти wb_refresh (или node sync.mjs) при доступе к dev.wildberries.ru; если модуль переименован — ' +
              'см. sync.mjs (MODULES) и сообщи об этом.',
          }
        : {}),
    };
    return { text: JSON.stringify(data, null, 2), structured: data };
  }

  function toolSearch(args) {
    requireCatalog();
    const query = String(args.query ?? '').trim();
    if (!query) throw new ToolError('Укажи query — что ищем, например "остатки" или "отзывы".');
    const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
    const { expanded } = expandQueryTokens(query);
    const mode = args.mode ?? 'all';
    const section = args.section ? String(args.section) : null;
    const q = query.toLowerCase();

    const scored = [];
    for (const op of catalog.operations) {
      if (section && op.moduleKey !== section && op.module !== section) continue;
      if (mode === 'read' && !op.readonly) continue;
      if (mode === 'write' && op.readonly) continue;
      let score = 0;
      const id = op.id.toLowerCase();
      const route = op.path.toLowerCase();
      const summary = (op.summary ?? '').toLowerCase();
      const tags = (op.tags ?? []).join(' ').toLowerCase();
      const sectionTitle = (op.sectionTitle ?? '').toLowerCase();
      const keywords = (op.keywords ?? []).join(' ').toLowerCase();
      const moduleName = `${op.module} ${op.moduleKey}`.toLowerCase();
      if (id === q) score += 120;
      else if (id.startsWith(q)) score += 70;
      else if (id.includes(q)) score += 45;
      if (route.includes(q)) score += 30;
      if (summary.includes(q)) score += 35;
      if (sectionTitle.includes(q)) score += 40;
      for (const t of expanded) {
        if (id.includes(t)) score += 12;
        if (route.includes(t)) score += 8;
        if (summary.includes(t)) score += 12;
        if (tags.includes(t)) score += 10;
        if (sectionTitle.includes(t)) score += 16;
        if (moduleName.includes(t)) score += 6;
        if (keywords.includes(t)) score += 14;
      }
      if (!score) continue;
      if (op.deprecated) score -= 15;
      scored.push({ op, score });
    }
    scored.sort((a, b) => b.score - a.score || a.op.id.localeCompare(b.op.id));
    const found = scored.slice(0, limit).map(({ op }) => ({
      id: op.id,
      method: op.method,
      path: op.path,
      ro: op.readonly,
      file: op.file || undefined,
      section: op.module,
      sectionKey: op.moduleKey,
      sectionTitle: op.sectionTitle,
      summary: op.summary,
      category: op.category,
    }));
    if (!found.length) {
      return {
        text:
          `Ничего не найдено по "${query}". Попробуй другие слова (например: остатки, цены, заказы, отзывы, поставки, ` +
          'финансы, отчёты, реклама, карточки) или wb_sections, чтобы увидеть разделы.',
      };
    }
    const payload = {
      query,
      found: found.length,
      totalMatched: scored.length,
      hint: 'Дальше: wb_describe <id> чтобы увидеть параметры, затем wb_get <id>.',
      results: found,
    };
    return { text: JSON.stringify(payload, null, 2), structured: payload };
  }

  function paramLine(p) {
    const flags = [p.in, p.type ?? 'any', p.required ? 'required' : 'optional'];
    if (p.enum) flags.push(`enum: ${p.enum.slice(0, 8).join('|')}${p.enum.length > 8 ? '|…' : ''}`);
    return `- ${p.name} (${flags.join(', ')})${p.description ? ` — ${p.description}` : ''}`;
  }

  async function toolDescribe(args) {
    requireCatalog();
    const id = String(args.id ?? '').trim();
    if (!id) throw new ToolError('Укажи id метода (из wb_search).');
    let found = await catalog.getFullOperation(id);
    if (!found) {
      const matches = catalog.operations.filter((o) => o.id.toLowerCase().includes(id.toLowerCase())).slice(0, 5);
      if (matches.length === 1) found = await catalog.getFullOperation(matches[0].id);
      if (!found) {
        throw new ToolError(
          `Метод "${id}" не найден.` +
            (matches.length ? ` Похожие: ${matches.map((m) => m.id).join(', ')}` : ' Сначала найди метод через wb_search.'),
        );
      }
    }
    const { op } = found;
    const lines = [];
    lines.push(`${op.id} — ${op.summary || '(без описания)'}`);
    lines.push(`${op.method} ${op.host}${op.path}`);
    lines.push(
      `Раздел: ${op.module} (${op.moduleKey})${op.tags?.length ? ` · теги: ${op.tags.join(', ')}` : ''}` +
        ` · readonly: ${op.readonly ? 'да' : 'НЕТ (изменяет данные)'}` +
        (op.destructive ? ' · destructive: да' : '') +
        (op.file ? ' · файл: да' : ''),
    );
    if (op.tokenTypes?.length) lines.push(`Типы токенов: ${op.tokenTypes.join(', ')}`);
    if (op.limits?.personal) {
      const l = op.limits.personal;
      lines.push(`Лимит (персональный токен): ${l.limit}/${l.periodSec} с, интервал ${Math.round(l.intervalSec ?? 0)} с, burst ${l.burst}`);
    }
    if (op.deprecated) lines.push('ВНИМАНИЕ: метод помечен deprecated в спеке WB.');
    if (op.description) {
      lines.push('', op.description.length > 1500 ? `${op.description.slice(0, 1500)}…` : op.description);
    }
    if (op.params.length) {
      lines.push('', 'Параметры:');
      for (const p of op.params) lines.push(paramLine(p));
    } else {
      lines.push('', 'Параметры: нет');
    }
    if (op.body) {
      lines.push('', `Тело запроса (${op.body.contentType}${op.body.required ? ', обязательное' : ''}):`);
      lines.push(JSON.stringify(op.body.schema ?? {}, null, 2).slice(0, 5000));
    }
    if (op.response?.contentTypes) {
      lines.push('', `Ответ 200: ${op.response.contentTypes.join(', ')}`);
      if (op.response.schema) lines.push(JSON.stringify(op.response.schema, null, 2).slice(0, 3000));
    }
    const exampleParams = Object.fromEntries(
      op.params
        .filter((p) => p.in !== 'header')
        .slice(0, 3)
        .map((p) => [p.name, p.default ?? (p.enum ? p.enum[0] : p.type === 'integer' || p.type === 'number' ? 0 : '...')]),
    );
    lines.push(
      '',
      'Пример вызова:',
      `wb_call { "id": "${op.id}"${Object.keys(exampleParams).length ? `, "params": ${JSON.stringify(exampleParams)}` : ''}${op.body ? ', "body": { ... }' : ''} }`,
    );
    return { text: lines.join('\n') };
  }

  async function toolCall(args, ctx = {}) {
    requireCatalog();
    const id = String(args.id ?? '').trim();
    if (!id) throw new ToolError('Укажи id метода. Найти: wb_search.');
    const found = await catalog.getFullOperation(id);
    if (!found) {
      throw new ToolError(
        `Метод "${id}" не найден. Сначала wb_search, затем wb_describe. Если метод новый — wb_refresh обновит каталог.`,
      );
    }
    return callOperation(found.op, args, ctx);
  }

  async function toolGet(args, ctx = {}) {
    requireCatalog();
    const id = String(args.id ?? '').trim();
    if (!id) throw new ToolError('Укажи id read-only метода. Найти: wb_search с mode=read.');
    const found = await catalog.getFullOperation(id);
    if (!found) {
      throw new ToolError(`Метод "${id}" не найден. Сначала wb_search (mode=read), затем wb_describe.`);
    }
    if (!found.op.readonly) {
      throw new ToolError(
        `Метод "${id}" изменяет данные магазина — wb_get работает только с read-only. ` +
          'Для записи используй wb_call (и предупреди пользователя).',
      );
    }
    return callOperation(found.op, args, ctx);
  }

  async function toolRequest(args) {
    const method = String(args.method ?? 'GET').toUpperCase();
    if (!HTTP_METHODS.includes(method)) throw new ToolError(`Неподдерживаемый method: ${method}`);
    const account = pickAccount(args.account);
    let url;
    if (args.url) {
      url = new URL(String(args.url));
    } else {
      if (!args.host || !args.path) throw new ToolError('Нужно указать url либо host+path');
      url = new URL(String(args.path), String(args.host));
    }
    assertAllowedUrl(url.toString());
    if (args.query && typeof args.query === 'object') {
      for (const [key, value] of Object.entries(args.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
        else url.searchParams.set(key, String(value));
      }
    }

    // Сырой запрос подчиняется тем же защитам, что и вызов по каталогу.
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutating) {
      const tokenInfo = describeToken(account.token);
      if (config.readOnlyMode) {
        throw new ToolError(`Режим WB_READONLY=1: ${method} изменяет данные и заблокирован (в т.ч. сырой wb_request).`);
      }
      if (tokenInfo.readOnly) {
        throw new ToolError(
          `Токен аккаунта "${account.name}" создан в режиме «Только чтение», поэтому ${method} через wb_request заблокирован. ` +
            'Создай токен «Чтение и запись» или используй read-only методы.',
        );
      }
      if (config.confirmWrites) {
        const fingerprint = approvalFingerprint({ method, url: url.toString(), params: args.query ?? null, body: args.body ?? null, token: account.token });
        if (!args.confirm) {
          const confirmId = issueApproval(fingerprint);
          return {
            text: [
              `⚠ Требуется подтверждение: ${method} ${url.pathname} ИЗМЕНИТ данные магазина.`,
              ...(args.body !== undefined ? [`body: ${typeof args.body === 'string' ? args.body : JSON.stringify(args.body)}`] : []),
              '',
              `Повтори вызов wb_request с "confirm": "${confirmId}" (код одноразовый, действует 5 минут).`,
              'Отключить подтверждение (осознанный риск): env WB_CONFIRM_WRITES=0.',
            ].join('\n'),
            structured: { approvalRequired: true, confirmId, expiresInSec: APPROVAL_TTL_MS / 1000, method, path: url.pathname },
          };
        }
        const check = consumeApproval(args.confirm, fingerprint);
        if (!check.ok) throw new ToolError(`Подтверждение отклонено: ${check.reason}. Запусти операцию заново.`);
        const approved = await elicitApproval(
          `Разрешить изменение кабинета Wildberries?\n\n${method} ${url.pathname}` +
            (args.body !== undefined ? `\nbody: ${typeof args.body === 'string' ? args.body : JSON.stringify(args.body)}` : '') +
            '\n\nОтветь "Разрешить", чтобы выполнить, или "Отклонить", чтобы отменить.',
        );
        if (!approved) {
          pendingApprovals.delete(String(args.confirm));
          throw new ToolError('Пользователь отклонил изменение — операция не выполнена.');
        }
      }
    }

    const headers = { Authorization: account.token, Accept: 'application/json' };
    if (args.headers && typeof args.headers === 'object') {
      for (const [key, value] of Object.entries(args.headers)) {
        if (/^(authorization|cookie|host)$/i.test(key)) continue;
        headers[key] = String(value);
      }
    }
    const body = args.body === undefined ? undefined : typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    const { res, elapsedMs } = await executeHttp({
      url: url.toString(),
      method,
      headers,
      body,
      contentType: body ? 'application/json' : undefined,
      opId: 'raw',
      mutating: !['GET', 'HEAD', 'OPTIONS'].includes(method),
    });
    const payload = await readResponse(res);
    if (!res.ok) throw new ToolError(wbErrorMessage(res, payload), { status: res.status });
    return finalizeResult(payload, { opId: 'raw', url: url.toString(), method, status: res.status, elapsedMs });
  }

  function toolTokenInfo() {
    if (!accounts.size) {
      const text =
        'Токены не заданы. Добавь "WB_API_TOKEN": "<токен>" в env сервера в конфиге MCP-клиента. ' +
        'Создать токен: кабинет продавца → Интеграции по API.';
      return { text, structured: { accounts: [] } };
    }
    const rows = [];
    for (const [name, token] of accounts) {
      const info = describeToken(token);
      rows.push({ name, ...info, tokenPreview: `${String(token).slice(0, 6)}…${String(token).slice(-4)}` });
    }
    return { text: JSON.stringify({ accounts: rows }, null, 2), structured: { accounts: rows } };
  }

  // -- MCP resources -------------------------------------------------------

  const subscriptions = new Set();

  function resourceDefs() {
    if (!catalog.loaded) return [];
    return [
      {
        uri: 'wb://catalog/index',
        name: 'WB API catalog index',
        description: 'Все методы WB API (id, метод, путь, readonly) из официальных OpenAPI-спеков',
        mimeType: 'application/json',
      },
      ...catalog.meta.modules.map((module) => ({
        uri: `wb://sections/${module.key}`,
        name: `${module.title} (${module.key})`,
        description: `Раздел WB API: ${module.ops} методов`,
        mimeType: 'application/json',
      })),
    ];
  }

  async function readResource(uri) {
    requireCatalog();
    if (uri === 'wb://catalog/index') {
      const compact = {
        generatedAt: catalog.meta.generatedAt,
        source: catalog.meta.source,
        coverage: {
          expectedModules: catalog.meta.expectedModules,
          builtModules: catalog.meta.modules.length,
          missing: (catalog.meta.missing ?? []).map((m) => m.key),
        },
        modules: catalog.meta.modules,
        operations: catalog.operations.map((op) => ({
          id: op.id,
          method: op.method,
          path: op.path,
          ro: op.readonly,
          section: op.moduleKey,
          summary: op.summary,
        })),
      };
      return { uri, mimeType: 'application/json', text: JSON.stringify(compact) };
    }
    if (uri.startsWith('wb://sections/')) {
      const key = uri.slice('wb://sections/'.length);
      const module = catalog.meta.modules.find((m) => m.key === key);
      if (!module) throw new ToolError(`Раздел "${key}" не найден. Список: resources/list.`);
      const full = await catalog.loadModule(key);
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ module, tags: full.tags, servers: full.servers, operations: full.operations.map((o) => o.id) }),
      };
    }
    if (uri.startsWith('wb://method/')) {
      const id = uri.slice('wb://method/'.length);
      const found = await catalog.getFullOperation(id);
      if (!found) throw new ToolError(`Метод "${id}" не найден. Найти: wb_search.`);
      return { uri, mimeType: 'application/json', text: JSON.stringify(found.op) };
    }
    throw new ToolError(`Неизвестный ресурс: ${uri}. Доступные: resources/list.`);
  }

  function notifyResourceUpdated() {
    for (const uri of subscriptions) {
      send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
    }
  }

  async function toolRefresh(args) {
    const { buildCatalog } = await import('./sync.mjs');
    const stats = await buildCatalog({
      fromDir: args.fromDir ? String(args.fromDir) : null,
      lang: args.lang === 'en' ? 'en' : 'ru',
      outDir: config.catalogDir,
      includeResponseSchemas: true,
      verbose: false,
    });
    await catalog.load();
    notifyResourceUpdated();
    return {
      text: JSON.stringify(
        {
          ok: true,
          catalog: config.catalogDir,
          modules: stats.modules,
          operations: stats.operations,
          readonly: stats.readonly,
          write: stats.write,
          file: stats.file,
          warnings: stats.warnings,
          hint: 'Каталог обновлён. Перезапуск сервера не нужен.',
        },
        null,
        2,
      ),
    };
  }

  const handlers = {
    wb_search: (args) => toolSearch(args),
    wb_describe: (args) => toolDescribe(args),
    wb_get: (args, ctx) => toolGet(args, ctx),
    wb_call: (args, ctx) => toolCall(args, ctx),
    wb_sections: () => toolSections(),
    wb_token_info: () => toolTokenInfo(),
    wb_request: (args, ctx) => toolRequest(args, ctx),
    wb_refresh: (args) => toolRefresh(args),
  };

  // -- JSON-RPC plumbing ---------------------------------------------------

  function send(message) {
    output.write(JSON.stringify(message) + '\n');
  }

  function toolContent(text, isError = false, structured = undefined) {
    return {
      resultType: 'complete',
      content: [{ type: 'text', text }],
      ...(structured !== undefined ? { structuredContent: structured } : {}),
      ...(isError ? { isError: true } : {}),
    };
  }

  async function handleRequest(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LEGACY_DEFAULT_VERSION;
      clientCapabilities = params?.capabilities ?? {};
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          protocolVersion: version,
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { subscribe: true, listChanged: false },
          },
          serverInfo: { name: config.name, version: config.version },
          instructions: INSTRUCTIONS,
        },
      };
    }

    if (method === 'server/discover') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: {
            tools: {},
            prompts: {},
            resources: { subscribe: true, listChanged: false },
          },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: config.name, version: config.version } },
          instructions: INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: 'private',
        },
      };
    }

    if (method === 'ping') return { jsonrpc: '2.0', id, result: { resultType: 'complete' } };

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', tools: TOOLS } };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const handler = handlers[toolName];
      if (!handler) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Неизвестный инструмент: ${toolName}` } };
      }
      const progressToken = params?._meta?.progressToken;
      const ctx = progressToken
        ? {
            progress: (progress, total, message) =>
              send({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken, progress, total, message },
              }),
          }
        : {};
      try {
        const out = await handler(params?.arguments ?? {}, ctx);
        return { jsonrpc: '2.0', id, result: toolContent(out.text ?? String(out), false, out.structured) };
      } catch (err) {
        if (err instanceof ToolError) return { jsonrpc: '2.0', id, result: toolContent(err.message, true) };
        log(`tool ${toolName} failed: ${err?.stack ?? err}`);
        return { jsonrpc: '2.0', id, result: toolContent(`Внутренняя ошибка ${config.name}: ${err?.message ?? err}`, true) };
      }
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', prompts: PROMPTS } };
    }

    if (method === 'prompts/get') {
      const name = params?.name;
      const prompt = buildPrompt(name, params?.arguments ?? {});
      if (!prompt) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Неизвестный prompt: ${name}` } };
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', ...prompt } };
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', resources: resourceDefs() } };
    }

    if (method === 'resources/read') {
      try {
        const contents = await readResource(String(params?.uri ?? ''));
        return { jsonrpc: '2.0', id, result: { resultType: 'complete', contents: [contents] } };
      } catch (err) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: err.message } };
      }
    }

    if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
      const uri = String(params?.uri ?? '');
      if (!uri.startsWith('wb://')) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Неизвестный ресурс: ${uri}` } };
      }
      if (method === 'resources/subscribe') subscriptions.add(uri);
      else subscriptions.delete(uri);
      return { jsonrpc: '2.0', id, result: { resultType: 'complete' } };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Метод не поддерживается: ${method}` } };
  }

  async function handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: строка не является JSON' } });
      return;
    }
    if (msg?.jsonrpc !== '2.0') {
      send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request: ожидается JSON-RPC 2.0' } });
      return;
    }
    if (msg.id !== undefined && pendingOutbound.has(msg.id)) {
      const pending = pendingOutbound.get(msg.id);
      clearTimeout(pending.timer);
      pendingOutbound.delete(msg.id);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message), { rpcError: msg.error }));
      else pending.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      // notifications (initialized/cancelled/...): no response
      return;
    }
    try {
      const response = await handleRequest(msg);
      if (response) send(response);
    } catch (err) {
      log(`request failed: ${err?.stack ?? err}`);
      send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: `Internal error: ${err?.message ?? err}` } });
    }
  }

  let rl = null;
  const inflight = new Set();

  function handleLineSafe(line) {
    const task = handleLine(line).catch((err) => log(`line handler error: ${err?.message ?? err}`));
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }

  return {
    config,
    catalog,
    accounts,
    handleLine,
    async start() {
      await catalog.load();
      if (!catalog.loaded && config.autoSync) {
        log('каталог не найден — собираю автоматически (WB_AUTO_SYNC=1)…');
        try {
          const { buildCatalog } = await import('./sync.mjs');
          const stats = await buildCatalog({ outDir: config.catalogDir, verbose: false });
          await catalog.load();
          log(`каталог собран: ${stats.modules} разделов, ${stats.operations} методов`);
        } catch (err) {
          log(`автосборка каталога не удалась: ${err.message}`);
        }
      }
      log(
        `${config.name} ${config.version} запущен; каталог: ${config.catalogDir}` +
          `${catalog.loaded ? '' : ' (НЕ НАЙДЕН)'}; аккаунтов: ${accounts.size}`,
      );
      for (const err of tokenState.errors) log(`токен: ${err}`);
      if (catalog.loaded) {
        log(`методов в каталоге: ${catalog.operations.length}; модулей: ${catalog.meta.modules.length}`);
        const missing = catalog.meta.missing ?? [];
        if (missing.length) log(`ВНИМАНИЕ: каталог неполный, нет модулей: ${missing.map((m) => m.key).join(', ')}`);
      } else log(catalog.error);
      rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
      // Handle each line independently (not via a serial chain), so an outbound
      // request such as sampling/createMessage can be answered while a tool call
      // is still awaiting it.
      rl.on('line', (line) => handleLineSafe(line));
      rl.on('close', () => {
        if (typeof input.destroy === 'function') input.destroy();
      });
    },
    async stop() {
      if (rl) rl.close();
      await this.whenIdle();
    },
    async whenIdle() {
      while (inflight.size) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

// Entry point when executed directly (normal MCP stdio usage).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createMcpServer({ input: process.stdin, output: process.stdout });
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
  server.start().catch((err) => {
    process.stderr.write(`[${NAME}] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
