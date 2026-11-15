#!/usr/bin/env node
// Builds the WB API catalog from the official OpenAPI specs published by
// Wildberries (dev.wildberries.ru). Output is split into a small searchable
// index plus one file per module, so the MCP server can start fast and load
// operation details lazily.
//
// Robustness notes:
//   * WB renames module slugs from time to time, so every module has a list of
//     candidate file names; the first one that exists wins.
//   * if candidates fail, slug discovery runs once against a public mirror of
//     the spec list and the discovered names are retried on dev.wildberries.ru.
//   * a module that fails to download/parse does not kill the build: the catalog
//     is built from the rest and the gap is reported in index.json meta.missing.
//     Use --strict to fail instead.
//
// Usage:
//   node sync.mjs                       # download specs and build ./catalog
//   node sync.mjs --from-dir specs-raw  # build from local .yaml files
//   node sync.mjs --out catalog
//   node sync.mjs --lang en
//   node sync.mjs --strict              # non-zero exit if any module is missing
//   node sync.mjs --no-discovery        # do not ask GitHub for renamed slugs
//   node sync.mjs --no-response-schemas
//   node sync.mjs --module 02-items --module 05-dbs   # only these modules
//   node sync.mjs --verbose

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.mjs';
import { extractKeywords } from './search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_BASE = 'https://dev.wildberries.ru/api/swagger/yaml';
const USER_AGENT = 'wb-mcp-catalog-builder/1.1 (+https://github.com/)';
const DISCOVERY_URL = 'https://api.github.com/repos/eslazarev/wildberries-sdk/contents/specs';

// Modules published by WB. `candidates` are file names observed in official
// docs or in public mirrors for the same section; the first existing one wins.
export const MODULES = [
  { key: '01-general', candidates: ['01-general', '01-api-information'] },
  { key: '02-items', candidates: ['02-items', '02-products', '02-item-management', '02-work-with-products'] },
  { key: '03-orders-fbs', candidates: ['03-orders-fbs', '03-fbs', '03-orders-fbs-assembly'] },
  { key: '04-orders-dbw', candidates: ['04-orders-dbw', '04-orders-dbs', '04-dbs', '04-orders'] },
  { key: '05-dbs', candidates: ['05-dbs', '05-orders-dbs'] },
  { key: '06-in-store-pickup', candidates: ['06-in-store-pickup', '06-pickup', '06-selfpickup'] },
  { key: '07-orders-fbw', candidates: ['07-orders-fbw', '07-fbw', '07-orders-fbw-supplies'] },
  { key: '08-promotion', candidates: ['08-promotion', '08-advert', '08-advertising'] },
  { key: '09-communications', candidates: ['09-communications', '09-customer-communication', '09-feedbacks'] },
  { key: '10-rates', candidates: ['10-rates', '10-tariffs'] },
  { key: '11-analytics', candidates: ['11-analytics', '11-analytics-data'] },
  { key: '12-reports', candidates: ['12-reports', '12-report'] },
  { key: '13-finances', candidates: ['13-finances', '13-documents-and-accounting'] },
  // WBD (Wildberries Цифровой) — отдельный продукт со своим порталом
  // devapi-digital.wildberries.ru и отдельной авторизацией; в Seller API его нет.
  // Пробуем как опциональный модуль: если спек есть — попадёт в каталог.
  { key: '14-wbd', candidates: ['14-wbd', '14-wb-delivery', '14-delivery'], optional: true },
];

// x-category -> production host. Verified against the `servers` list of every
// operation during the build; an unknown category is resolved heuristically and
// reported as a warning.
const CATEGORY_HOSTS = {
  commonapi: 'https://common-api.wildberries.ru',
  content: 'https://content-api.wildberries.ru',
  contentanalytics: 'https://seller-analytics-api.wildberries.ru',
  analytics: 'https://seller-analytics-api.wildberries.ru',
  discountsandprices: 'https://discounts-prices-api.wildberries.ru',
  marketplace: 'https://marketplace-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
  advert: 'https://advert-api.wildberries.ru',
  promotion: 'https://advert-api.wildberries.ru',
  questionsandfeedback: 'https://feedbacks-api.wildberries.ru',
  buyerchat: 'https://buyer-chat-api.wildberries.ru',
  supplies: 'https://supplies-api.wildberries.ru',
  returns: 'https://returns-api.wildberries.ru',
  documents: 'https://documents-api.wildberries.ru',
  finance: 'https://finance-api.wildberries.ru',
  usermanagement: 'https://user-management-api.wildberries.ru',
  wbd: 'https://wbd-api.wildberries.ru',
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function log(verbose, ...args) {
  if (verbose) console.error(...args);
}

function normCategory(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function trimText(text, max) {
  if (!text || typeof text !== 'string') return text;
  const s = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Parses the "Лимит запросов" markdown table that WB embeds in descriptions.
function parseLimits(description) {
  if (!description || typeof description !== 'string') return undefined;
  if (!description.includes('Лимит запросов')) return undefined;
  const rowRe =
    /\|\s*([^|\n]+?)\s*\|\s*(\d+)\s*(мин[^|\n]*|ч[^|\n]*|сек[^|\n]*)\s*\|\s*(\d+)\s*запрос[^|\n]*\|\s*([^|\n]+?)\s*\|\s*(\d+)\s*запрос[^|\n]*\|/g;
  const kindMap = [
    [/персональн/i, 'personal'],
    [/сервисн/i, 'service'],
    [/базовый с секретом/i, 'baseWithSecret'],
    [/базов/i, 'base'],
    [/тестов/i, 'test'],
  ];
  const out = {};
  let m;
  while ((m = rowRe.exec(description))) {
    const [, kindRaw, periodNum, periodUnit, limit, intervalRaw, burst] = m;
    const kind = kindMap.find(([re]) => re.test(kindRaw))?.[1];
    if (!kind) continue;
    out[kind] = {
      periodSec: Number(periodNum) * unitSeconds(periodUnit),
      limit: Number(limit),
      intervalSec: toSecondsFromText(intervalRaw),
      burst: Number(burst),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function unitSeconds(unitText) {
  if (/^ч/.test(unitText)) return 3600;
  if (/^мин/.test(unitText)) return 60;
  return 1;
}

function toSecondsFromText(text) {
  const m = /(\d+)\s*(сек|мин|ч)/.exec(text ?? '');
  if (!m) return undefined;
  return Number(m[1]) * unitSeconds(m[2]);
}

// Resolves local "#/components/..." pointers, inlines schemas up to `depth`
// and strips noise (examples, xml, docs) to keep the catalog compact.
function makeDeref(rootDoc) {
  function resolvePointer(ref) {
    if (!ref.startsWith('#/')) return undefined;
    let node = rootDoc;
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node === null || typeof node !== 'object') return undefined;
      node = node[key];
    }
    return node;
  }

  function deref(node, depth, stack) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n) => deref(n, depth, stack));
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (stack.includes(ref)) return { type: 'object', note: 'recursive' };
      if (depth <= 0) return { type: 'object', note: `ref:${ref.split('/').pop()}` };
      const target = resolvePointer(ref);
      if (!target) return { type: 'object', note: `unresolved:${ref}` };
      return deref(target, depth - 1, [...stack, ref]);
    }
    const out = {};
    const KEEP = [
      'type', 'format', 'nullable', 'enum', 'default', 'minimum', 'maximum',
      'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'uniqueItems',
      'required', 'properties', 'items', 'additionalProperties', 'oneOf', 'anyOf',
      'allOf', 'not', 'description', 'title', 'example', 'deprecated',
    ];
    for (const key of KEEP) {
      if (!(key in node)) continue;
      if (key === 'description') {
        out.description = trimText(node.description, 300);
      } else if (key === 'example') {
        const json = JSON.stringify(node.example);
        if (json && json.length <= 120) out.example = node.example;
      } else if (key === 'properties' && node.properties && typeof node.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(node.properties)) {
          const resolved = deref(prop, depth - 1, stack);
          const desc = prop && typeof prop === 'object' ? prop.description : undefined;
          if (desc && resolved && typeof resolved === 'object' && !resolved.description) {
            resolved.description = trimText(desc, 200);
          }
          out.properties[name] = resolved;
        }
      } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(node[key])) {
        out[key] = node[key].map((n) => deref(n, depth - 1, stack));
      } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
        out[key] = deref(node[key], depth - 1, stack);
      } else {
        out[key] = node[key];
      }
    }
    return out;
  }

  return (schema, depth = 4) => (schema ? deref(schema, depth, []) : undefined);
}

function resolveParamRef(root, param) {
  if (!param || typeof param !== 'object') return null;
  if (typeof param.$ref === 'string') {
    const name = param.$ref.replace('#/components/parameters/', '');
    const target = root.components?.parameters?.[name];
    return target ? { ...target } : null;
  }
  return param;
}

function paramOut(root, param) {
  const p = resolveParamRef(root, param);
  if (!p) return null;
  const schema = p.schema ?? {};
  return {
    name: p.name,
    in: p.in,
    required: p.in === 'path' ? true : Boolean(p.required),
    type: schema.type ?? (schema.oneOf ? 'oneOf' : undefined),
    format: schema.format,
    enum: Array.isArray(schema.enum) ? schema.enum.slice(0, 30) : undefined,
    default: schema.default,
    description: trimText(p.description ?? schema.description, 200),
  };
}

function detectFile(op, resp200) {
  const route = op.path.toLowerCase();
  if (/csv|download|\/file|report-file/.test(route)) return true;
  for (const [type, media] of Object.entries(resp200?.content ?? {})) {
    if (/csv|octet-stream|zip|excel|vnd\.ms|binary/i.test(type)) return true;
    if (media?.schema?.format === 'binary' && /octet-stream|csv/i.test(type)) return true;
  }
  return false;
}

function respSummary(resp200, deref) {
  if (!resp200) return undefined;
  const content = resp200.content ?? {};
  const json =
    content['application/json']?.schema ??
    content['application/problem+json']?.schema ??
    Object.values(content)[0]?.schema;
  return { contentTypes: Object.keys(content), schema: json ? deref(json, 3) : undefined };
}

export function buildModuleCatalog(moduleKey, doc, { lang, includeResponseSchemas, warn }) {
  const deref = makeDeref(doc);
  const moduleName = doc.info?.['x-file-name'] ?? moduleKey;
  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  const operations = [];
  const sectionTags = new Map();

  for (const [route, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const prodServers = (Array.isArray(pathItem.servers) ? pathItem.servers.map((s) => s?.url).filter(Boolean) : []).filter(
      (u) => !/-sandbox\./.test(u),
    );
    const commonParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const opId = op.operationId ?? `${method}_${route}`;
      const category = normCategory(op['x-category']);
      const mapped = CATEGORY_HOSTS[category];
      let host;
      if (prodServers.length === 1) {
        // The spec's own `servers` is authoritative for this path: WB moves
        // endpoints between domains (e.g. advert -> advert-media-api,
        // promo calendar -> dp-calendar-api) and the category map goes stale.
        host = prodServers[0];
        if (mapped && mapped !== host) {
          warn(`[${moduleKey}] ${method.toUpperCase()} ${route}: spec host ${host} (category ${category}); using spec, map said ${mapped}`);
        }
      } else {
        host = mapped;
        if (!host) {
          const guess =
            prodServers.find((u) => {
              const hostName = u.replace(/^https?:\/\//, '').split('.')[0];
              return normCategory(hostName).startsWith(category) || category.startsWith(normCategory(hostName));
            }) ?? (prodServers.length === 1 ? prodServers[0] : undefined);
          if (!guess) {
            throw new Error(
              `[${moduleKey}] cannot resolve host for x-category="${category}" in ${method.toUpperCase()} ${route}; ` +
                `known categories: ${Object.keys(CATEGORY_HOSTS).join(', ')}`,
            );
          }
          warn(`[${moduleKey}] unknown x-category "${category}" for ${method.toUpperCase()} ${route}; using ${guess}`);
          host = guess;
        } else if (prodServers.length && !prodServers.includes(host)) {
          warn(`[${moduleKey}] ${method.toUpperCase()} ${route}: host ${host} not in servers [${prodServers.join(', ')}]`);
        }
      }

      const readonly =
        typeof op['x-readonly-method'] === 'boolean' ? op['x-readonly-method'] : ['get', 'head', 'options'].includes(method);
      const destructive = method === 'delete' || /delete|cancel|remove|archive|close|block|truncate/i.test(route);

      const params = [];
      for (const p of [...commonParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const out = paramOut(doc, p);
        if (out) params.push(out);
      }

      let body;
      const rb = op.requestBody;
      if (rb) {
        const rbResolved =
          typeof rb.$ref === 'string' ? doc.components?.requestBodies?.[rb.$ref.split('/').pop()] : rb;
        const content = rbResolved?.content ?? {};
        const jsonType = Object.keys(content).find((t) => /json/.test(t)) ?? Object.keys(content)[0];
        if (jsonType) {
          const schema = content[jsonType]?.schema;
          body = { required: Boolean(rbResolved.required), contentType: jsonType, schema: schema ? deref(schema, 4) : undefined };
        }
      }

      const resp200 = op.responses?.['200'] ?? op.responses?.['201'];
      const file = detectFile({ path: route }, resp200);
      const response = includeResponseSchemas && !file ? respSummary(resp200, deref) : undefined;
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];
      const tagKey = op['x-tagKey'];
      if (tagKey && tags[0]) sectionTags.set(tagKey, tags[0]);

      operations.push({
        id: opId,
        moduleKey,
        module: moduleName,
        method: method.toUpperCase(),
        path: route,
        host,
        summary: trimText(op.summary ?? op.description ?? '', 160),
        description: trimText(op.description ?? '', 900),
        tags,
        tagKey,
        category,
        readonly,
        destructive,
        file,
        deprecated: Boolean(op.deprecated),
        tokenTypes: Array.isArray(op['x-token-types']) ? op['x-token-types'] : undefined,
        limits: parseLimits(op.description),
        params,
        body,
        response,
      });
    }
  }

  return {
    moduleKey,
    title: doc.info?.title ?? moduleName,
    version: doc.info?.version,
    lang,
    servers: [...new Set(Object.values(paths).flatMap((p) => (p?.servers ?? []).map((s) => s?.url).filter(Boolean)))],
    tags: Object.fromEntries(sectionTags),
    operations,
  };
}

function indexEntry(op, sectionTitle) {
  return {
    id: op.id,
    moduleKey: op.moduleKey,
    module: op.module,
    sectionTitle,
    method: op.method,
    path: op.path,
    pathParams: op.params.filter((p) => p.in === 'path').map((p) => p.name),
    summary: op.summary,
    tags: op.tags,
    tagKey: op.tagKey,
    category: op.category,
    readonly: op.readonly,
    destructive: op.destructive,
    file: op.file,
    deprecated: op.deprecated,
    host: op.host,
    keywords: extractKeywords(op),
  };
}

// ---------------------------------------------------------------------------
// Downloading / resolving specs
// ---------------------------------------------------------------------------

function defaultFetchText({ timeoutMs = 90_000, retries = 3, verbose = false } = {}) {
  return async function fetchText(url, { headers = {} } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log(verbose, `GET ${url} (attempt ${attempt})`);
        const res = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, 'accept-language': 'ru,en;q=0.8', ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) return { status: 404 };
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return { status: res.status, text: await res.text() };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error(`failed to fetch ${url}: ${lastErr?.message ?? lastErr}`);
  };
}

async function fromDirectory(dir, warn) {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/i.test(f)).sort();
  if (!files.length) throw new Error(`no .yaml files found in ${dir}`);
  const specs = new Map();
  for (const file of files) {
    specs.set(file.replace(/\.ya?ml$/i, ''), await readFile(path.join(dir, file), 'utf8'));
  }
  return specs;
}

async function discoverSlugs(fetchText, verbose, warn) {
  try {
    const res = await fetchText(DISCOVERY_URL, { headers: { accept: 'application/vnd.github+json' } });
    if (res.status !== 200 || !res.text) return [];
    const list = JSON.parse(res.text);
    const names = list.map((item) => String(item.name ?? '').replace(/\.ya?ml$/i, '')).filter(Boolean);
    log(verbose, `discovery: ${names.length} slug(s) from mirror`);
    return names;
  } catch (err) {
    warn(`discovery failed: ${err.message}`);
    return [];
  }
}

async function resolveSpecs({ fromDir, lang, fetchText, verbose, warn, discovery, onlyModules }) {
  if (fromDir) {
    const specs = await fromDirectory(fromDir, warn);
    const wanted = onlyModules?.length ? new Set(onlyModules) : null;
    if (wanted) for (const key of [...specs.keys()]) if (!wanted.has(key)) specs.delete(key);
    return { specs, missing: [], optionalMissing: [] };
  }

  const modules = onlyModules?.length ? MODULES.filter((m) => onlyModules.includes(m.key)) : MODULES;
  const specs = new Map();
  const missing = [];
  const optionalMissing = [];
  const unresolved = [];

  for (const mod of modules) {
    let found = null;
    const tried = [];
    for (const candidate of mod.candidates) {
      const url = `${SPEC_BASE}/${lang}/${candidate}.yaml`;
      tried.push(url);
      const res = await fetchText(url);
      if (res.status !== 404 && res.text) {
        found = { url, text: res.text };
        break;
      }
      log(verbose, `404 ${url}`);
    }
    if (found) specs.set(mod.key, found.text);
    else unresolved.push({ mod, tried });
  }

  if (unresolved.length && discovery) {
    const known = await discoverSlugs(fetchText, verbose, warn);
    const discovered = new Set(known);
    for (const { mod, tried } of unresolved) {
      const num = mod.key.slice(0, 2);
      const candidates = [...discovered].filter((name) => name.startsWith(`${num}-`));
      for (const name of candidates) {
        const url = `${SPEC_BASE}/${lang}/${name}.yaml`;
        if (tried.includes(url)) continue;
        tried.push(url);
        const res = await fetchText(url);
        if (res.status !== 404 && res.text) {
          log(verbose, `discovered ${mod.key} as ${name}`);
          specs.set(mod.key, res.text);
          break;
        }
      }
    }
  }

  for (const mod of modules) {
    if (!specs.has(mod.key)) {
      const { tried = [] } = unresolved.find((u) => u.mod.key === mod.key) ?? {};
      const entry = {
        key: mod.key,
        optional: Boolean(mod.optional),
        tried: tried.length ? tried : mod.candidates.map((c) => `${SPEC_BASE}/${lang}/${c}.yaml`),
        hint: mod.optional
          ? 'Опциональный модуль (отдельный продукт WB, не входит в Seller API).'
          : 'WB мог переименовать файл спеки. Открой раздел на dev.wildberries.ru/swagger, найди URL YAML и добавь slug в MODULES (sync.mjs) или передай --module NN-slug.',
      };
      if (mod.optional) optionalMissing.push(entry);
      else missing.push(entry);
    }
  }
  return { specs, missing, optionalMissing };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function buildCatalog(options = {}) {
  const {
    fromDir = null,
    lang = 'ru',
    outDir = path.join(HERE, 'catalog'),
    includeResponseSchemas = true,
    verbose = false,
    strict = false,
    discovery = true,
    onlyModules = null,
    fetchText = defaultFetchText({ verbose }),
  } = options;
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    if (verbose) console.error('WARN', msg);
  };

  const { specs, missing, optionalMissing } = await resolveSpecs({
    fromDir,
    lang,
    fetchText,
    verbose,
    warn,
    discovery,
    onlyModules,
  });
  if (!specs.size) {
    const attempted = [...missing, ...optionalMissing].map((m) => `  ${m.key}: ${m.tried.join(', ')}`).join('\n');
    throw new Error(`не удалось получить ни одной спеки. Попытки:\n${attempted}`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const moduleSummaries = [];
  const index = [];
  const categories = new Map();
  const failed = [];
  let totalOps = 0;

  for (const [moduleKey, text] of specs) {
    try {
      const doc = parseYaml(text);
      if (!doc || typeof doc !== 'object') throw new Error('спек не распарсился в объект');
      if (!doc.paths || typeof doc.paths !== 'object') throw new Error('в спеке нет объекта "paths"');

      const full = buildModuleCatalog(moduleKey, doc, { lang, includeResponseSchemas, warn });
      if (!full.operations.length) throw new Error('в спеке не найдено ни одной операции');

      const ids = new Set();
      for (const op of full.operations) {
        if (ids.has(op.id)) throw new Error(`дублирующийся operationId "${op.id}"`);
        ids.add(op.id);
      }

      await writeFile(path.join(outDir, `${moduleKey}.json`), JSON.stringify(full));
      for (const op of full.operations) {
        index.push(indexEntry(op, full.title));
        categories.set(op.category, op.host);
      }
      totalOps += full.operations.length;
      moduleSummaries.push({
        key: moduleKey,
        name: full.module,
        title: full.title,
        ops: full.operations.length,
        readonly: full.operations.filter((o) => o.readonly).length,
        write: full.operations.filter((o) => !o.readonly).length,
        files: full.operations.filter((o) => o.file).length,
        tags: full.tags,
      });
      log(verbose, `${moduleKey}: ${full.operations.length} операций`);
    } catch (err) {
      failed.push({ key: moduleKey, error: err.message });
      warn(`[${moduleKey}] пропущен: ${err.message}`);
      log(verbose, `[${moduleKey}] failed: ${err.stack ?? err}`);
    }
  }

  if (!moduleSummaries.length) {
    throw new Error(`каталог пуст: все спеки не удалось обработать (${failed.map((f) => f.key).join(', ')})`);
  }

  // Deduplicate ids across modules by prefixing the module key.
  const seen = new Set();
  for (const entry of index) {
    if (seen.has(entry.id)) {
      entry.id = `${entry.moduleKey}:${entry.id}`;
      warn(`дублирующийся id "${entry.id}" — переименован в "${entry.id}"`);
    }
    seen.add(entry.id);
  }
  index.sort((a, b) => a.id.localeCompare(b.id));

  const expected = onlyModules?.length
    ? MODULES.filter((m) => onlyModules.includes(m.key) && !m.optional).length
    : MODULES.filter((m) => !m.optional).length;
  const meta = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    lang,
    source: fromDir ? `local:${path.resolve(fromDir)}` : `${SPEC_BASE}/${lang}/`,
    expectedModules: fromDir ? moduleSummaries.length + failed.length : expected,
    modules: moduleSummaries,
    missing: [...missing, ...failed.map((f) => ({ key: f.key, error: f.error }))],
    optionalMissing,
    categories: Object.fromEntries([...categories].sort()),
    totalOps,
  };
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify({ meta, operations: index }));

  const stats = {
    outDir,
    modules: moduleSummaries.length,
    operations: totalOps,
    readonly: index.filter((o) => o.readonly).length,
    write: index.filter((o) => !o.readonly).length,
    file: index.filter((o) => o.file).length,
    missing: meta.missing.map((m) => m.key),
    optionalMissing: optionalMissing.map((m) => m.key),
    warnings,
  };
  log(verbose, 'catalog built:', JSON.stringify(stats));

  if (strict && meta.missing.length) {
    throw new Error(`--strict: отсутствуют модули: ${meta.missing.map((m) => m.key).join(', ')}`);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Offline catalog bundle (used by GitHub Releases and `doctor`)
// ---------------------------------------------------------------------------

// Packs catalog/ into one JSON document so it can be shipped as a release asset:
// { schemaVersion, createdAt, index, modules: { <key>: <module catalog> } }
export async function createCatalogBundle(catalogDir) {
  const index = JSON.parse(await readFile(path.join(catalogDir, 'index.json'), 'utf8'));
  const modules = {};
  for (const module of index.meta.modules) {
    modules[module.key] = JSON.parse(await readFile(path.join(catalogDir, `${module.key}.json`), 'utf8'));
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(), index, modules };
}

export async function loadCatalogBundle(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

// Unpacks a bundle written by createCatalogBundle into a catalog directory.
export async function writeCatalogBundle(bundle, outDir) {
  if (!bundle?.index?.meta || !bundle?.modules) throw new Error('bundle is malformed: index/modules missing');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const root = path.resolve(outDir);
  const safePath = (key) => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
      throw new Error(`bundle: небезопасное имя модуля "${key}" (допустимы буквы/цифры/._- без слэшей)`);
    }
    const target = path.resolve(root, `${key}.json`);
    if (path.dirname(target) !== root) {
      throw new Error(`bundle: модуль "${key}" выходит за пределы каталога`);
    }
    return target;
  };
  await writeFile(path.join(root, 'index.json'), JSON.stringify(bundle.index));
  for (const [key, module] of Object.entries(bundle.modules)) {
    await writeFile(safePath(key), JSON.stringify(module));
  }
  return {
    modules: Object.keys(bundle.modules).length,
    operations: bundle.index.operations.length,
    readonly: bundle.index.operations.filter((op) => op.readonly).length,
    write: bundle.index.operations.filter((op) => !op.readonly).length,
    file: bundle.index.operations.filter((op) => op.file).length,
    generatedAt: bundle.index.meta.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name) => argv.includes(name);
  const modules = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--module' && argv[i + 1]) modules.push(argv[i + 1]);

  const options = {
    fromDir: get('--from-dir') ?? null,
    fromBundle: get('--from-bundle') ?? null,
    bundleOut: get('--bundle-out') ?? null,
    outDir: get('--out') ?? path.join(HERE, 'catalog'),
    lang: get('--lang') ?? 'ru',
    includeResponseSchemas: !has('--no-response-schemas'),
    verbose: has('--verbose') || has('-v'),
    strict: has('--strict'),
    discovery: !has('--no-discovery'),
    onlyModules: modules.length ? modules : null,
  };
  try {
    if (options.fromBundle) {
      const bundle = await loadCatalogBundle(options.fromBundle);
      const stats = await writeCatalogBundle(bundle, options.outDir);
      console.log(JSON.stringify({ outDir: options.outDir, ...stats, source: `bundle:${options.fromBundle}` }, null, 2));
      return;
    }
    const stats = await buildCatalog(options);
    if (options.bundleOut) {
      const bundle = await createCatalogBundle(options.outDir);
      await writeFile(options.bundleOut, JSON.stringify(bundle));
      stats.bundleOut = options.bundleOut;
      stats.bundleBytes = (await readFile(options.bundleOut)).length;
    }
    console.log(JSON.stringify(stats, null, 2));
    if (stats.missing.length) {
      console.error(`\nВНИМАНИЕ: не собраны модули: ${stats.missing.join(', ')}.`);
      console.error("Сервер будет работать с остальными; полное покрытие потребует найти новые slug'и (см. sync.mjs, MODULES).");
    }
    if (stats.optionalMissing.length) {
      console.error(`\nОпциональные модули недоступны: ${stats.optionalMissing.join(', ')} (в Seller API их нет — это отдельные продукты WB).`);
    }
  } catch (err) {
    console.error('catalog build failed:', err.message);
    if (options.verbose) console.error(err.stack);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
