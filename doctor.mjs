#!/usr/bin/env node
// wb-mcp doctor: self-check for agents and humans.
// Verifies Node version, catalog, token, network reachability and client configs.
//
// Usage:
//   node doctor.mjs                # human-readable report
//   node doctor.mjs --json         # machine-readable JSON
//   node doctor.mjs --catalog DIR

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeToken, loadTokenAccounts } from './tokens.mjs';
import { keySchemeOf, defaultKeyFile } from './tokenstore.mjs';
import { verifyCatalog } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const has = (name) => ARGV.includes(name);
const get = (name) => {
  const i = ARGV.indexOf(name);
  return i >= 0 ? ARGV[i + 1] : undefined;
};

const ICONS = { ok: '✅', warn: '⚠️ ', fail: '❌' };

function home(...parts) {
  return path.join(os.homedir(), ...parts);
}

function appData(...parts) {
  return path.join(process.env.APPDATA || home('AppData', 'Roaming'), ...parts);
}

const CLIENT_CONFIGS = {
  cursor: { title: 'Cursor', file: home('.cursor', 'mcp.json'), kind: 'json' },
  claude: { title: 'Claude Desktop', file: appData('Claude', 'claude_desktop_config.json'), kind: 'json' },
  'claude-code': { title: 'Claude Code', file: home('.claude.json'), kind: 'json' },
  codex: { title: 'Codex CLI', file: home('.codex', 'config.toml'), kind: 'toml' },
  gemini: { title: 'Gemini CLI', file: home('.gemini', 'settings.json'), kind: 'json' },
  vscode: { title: 'VS Code', file: appData('Code', 'User', 'mcp.json'), kind: 'json' },
};

function clientConfigured(config, text) {
  if (!text) return false;
  if (config.kind === 'toml') return /^\[mcp_servers\.wb\]/m.test(text);
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed?.mcpServers?.wb);
  } catch {
    return text.includes('"wb"');
  }
}

async function checkNode() {
  const raw = process.version.replace(/^v/, '');
  const major = Number(raw.split('.')[0]);
  const ok = major >= 20;
  return {
    id: 'node',
    title: 'Node.js',
    status: ok ? 'ok' : 'fail',
    detail: `v${raw}${ok ? '' : ' — нужен Node.js >= 20'}`,
  };
}

async function checkCatalog(env, explicitDir, includeDefaults) {
  const candidates = [
    explicitDir,
    env.WB_MCP_CATALOG,
    ...(includeDefaults ? [path.join(HERE, 'catalog'), home('.wb-mcp', 'app', 'catalog')] : []),
  ].filter(Boolean);
  const dir = candidates.find((candidate) => existsSync(path.join(candidate, 'index.json')));
  if (!dir) {
    return {
      id: 'catalog',
      title: 'Каталог WB API',
      status: 'fail',
      detail: `не найден (искал: ${candidates.join(', ')}). Собери: node sync.mjs`,
    };
  }
  const report = await verifyCatalog(dir);
  const s = report.summary;
  const ops = s.operations?.total ?? 0;
  const coverage = s.coverage ? `${s.coverage.builtModules}/${s.coverage.requiredModules}` : '?';
  const ageDays = s.generatedAt ? Math.floor((Date.now() - new Date(s.generatedAt).getTime()) / 86_400_000) : null;
  const maxAgeDays = Number(env.WB_CATALOG_MAX_AGE_DAYS ?? 30);
  const stale = ageDays !== null && ageDays > maxAgeDays;
  let status = report.problems.length ? 'fail' : s.coverage && s.coverage.builtModules < s.coverage.requiredModules ? 'warn' : 'ok';
  if (stale && status !== 'fail') status = 'warn';
  return {
    id: 'catalog',
    title: 'Каталог WB API',
    status,
    detail:
      `${dir} · ${ops} методов · покрытие ${coverage}` +
      (ageDays !== null ? ` · собран ${ageDays} дн. назад` : '') +
      (stale ? ` (устарел > ${maxAgeDays} дн. — запусти wb_refresh)` : '') +
      (report.problems.length ? ` · проблем: ${report.problems.length}` : ''),
    dir,
    operations: ops,
    coverage: s.coverage,
    problems: report.problems,
    generatedAt: s.generatedAt,
    ageDays,
    stale,
  };
}

function checkToken(env) {
  const { accounts, errors } = loadTokenAccounts(env);
  if (!accounts.size) {
    return {
      id: 'token',
      title: 'Токен WB',
      status: errors.length ? 'fail' : 'warn',
      detail:
        (errors.length ? errors.join('; ') + '. ' : '') +
        'токен не задан (WB_API_TOKEN / WB_TOKEN_FILE / WB_ACCOUNTS) — чтение/запись в WB недоступны, поиск и схемы работают',
      errors,
    };
  }
  const rows = [];
  let status = 'ok';
  for (const [name, token] of accounts) {
    const info = describeToken(token);
    rows.push({ name, ...info });
    if (!info.valid) status = 'fail';
    else if (info.readOnly || info.testToken || (info.expiresInDays ?? 999) < 7) {
      if (status === 'ok') status = 'warn';
    }
  }
  const first = rows[0];
  const detail = rows
    .map((r) => `${r.name}: ${r.valid ? 'ок' : 'невалиден'} · ${r.type ?? '?'} · категорий ${r.categories?.length ?? 0} · ${r.readOnly ? 'только чтение' : 'чтение/запись'} · до ${r.expiresAt ?? '?'}`)
    .join('; ');
  // Фактический способ хранения ключа шифрования (dpapi/keychain/libsecret/file/raw).
  const keyStorage = [];
  if (env.WB_TOKEN_FILE) keyStorage.push(`ключ ${keySchemeOf(env.WB_TOKEN_KEY ?? defaultKeyFile(env.WB_TOKEN_FILE))}`);
  if (env.WB_TOKEN_FILES) {
    try {
      for (const [name, spec] of Object.entries(JSON.parse(env.WB_TOKEN_FILES))) {
        const file = typeof spec === 'string' ? spec : spec?.file;
        if (file) keyStorage.push(`${name}: ключ ${keySchemeOf(typeof spec === 'string' ? `${file}.key` : spec.key ?? `${file}.key`)}`);
      }
    } catch {
      // WB_TOKEN_FILES уже сообщил об ошибке через loadTokenAccounts
    }
  }
  if (keyStorage.length) detail += ` · ${keyStorage.join(', ')}`;
  return { id: 'token', title: 'Токен WB', status, detail, accounts: rows, firstExpiresInDays: first?.expiresInDays };
}

async function checkNetwork(fetchImpl, id, title, url, transform) {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { 'user-agent': 'wb-mcp-doctor/1.0' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      await res.arrayBuffer?.().catch(() => {});
      return { id, title, status: 'fail', detail: `HTTP ${res.status} от ${url}` };
    }
    return { id, title, status: 'ok', detail: transform ? transform(res) : `HTTP ${res.status}` };
  } catch (err) {
    return { id, title, status: 'fail', detail: `${url}: ${err?.message ?? err}` };
  }
}

function checkClients() {
  const found = [];
  for (const [key, config] of Object.entries(CLIENT_CONFIGS)) {
    if (!existsSync(config.file)) {
      found.push({ key, title: config.title, status: 'absent', file: config.file });
      continue;
    }
    const text = (() => {
      try {
        return readFileSync(config.file, 'utf8');
      } catch {
        return '';
      }
    })();
    found.push({ key, title: config.title, status: clientConfigured(config, text) ? 'configured' : 'present', file: config.file });
  }
  const configured = found.filter((c) => c.status === 'configured');
  return {
    id: 'clients',
    title: 'Конфиги MCP-клиентов',
    status: configured.length ? 'ok' : 'warn',
    detail: configured.length
      ? `подключён: ${configured.map((c) => c.title).join(', ')}`
      : 'ни один клиент не подключён — установи: node install.mjs --client all --token <WB_API_TOKEN>',
    clients: found,
  };
}

async function checkApp() {
  const appDir = home('.wb-mcp', 'app');
  const serverFile = path.join(appDir, 'server.mjs');
  const ok = existsSync(serverFile);
  return {
    id: 'app',
    title: 'Установка в ~/.wb-mcp/app',
    status: ok ? 'ok' : 'warn',
    detail: ok ? serverFile : 'не установлено (node install.mjs скопирует)',
  };
}

export async function runDoctor({ env = process.env, fetchImpl = globalThis.fetch, catalogDir = get('--catalog'), includeDefaultCatalog = true } = {}) {
  const checks = [];
  checks.push(await checkNode());
  checks.push(await checkCatalog(env, catalogDir, includeDefaultCatalog));
  checks.push(checkToken(env));
  checks.push(
    await checkNetwork(
      fetchImpl,
      'network-wb',
      'Сеть до dev.wildberries.ru',
      'https://dev.wildberries.ru/api/swagger/yaml/ru/10-rates.yaml',
      (res) => `HTTP ${res.status} (спеки доступны)`,
    ),
  );
  checks.push(
    await checkNetwork(fetchImpl, 'network-github', 'Сеть до api.github.com', 'https://api.github.com/rate_limit', (res) => `HTTP ${res.status} (релиз с каталогом доступен)`),
  );
  checks.push(checkClients());
  checks.push(await checkApp());
  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return { checks, summary, healthy: summary.fail === 0 };
}

function printHuman(report) {
  console.log('wb-mcp doctor');
  for (const check of report.checks) {
    console.log(`${ICONS[check.status] ?? '  '} ${check.title}: ${check.detail}`);
    for (const client of check.clients ?? []) {
      const mark = client.status === 'configured' ? '•' : '-';
      console.log(`   ${mark} ${client.title}: ${client.status === 'configured' ? 'подключён' : client.status === 'present' ? 'файл есть, wb не прописан' : 'нет конфига'} (${client.file})`);
    }
  }
  console.log(`\nИтог: ok ${report.summary.ok}, warn ${report.summary.warn}, fail ${report.summary.fail}`);
  if (!report.healthy) console.log('Есть проблемы — см. ❌ выше.');
}

async function main() {
  const report = await runDoctor();
  if (has('--json')) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exit(report.healthy ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('doctor failed:', err?.stack ?? err);
    process.exit(1);
  });
}
