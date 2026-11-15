#!/usr/bin/env node
// wb-mcp installer.
//
// Why it exists: `npx github:owner/repo` runs from a temporary cache directory,
// so a config that points into that cache would break after cleanup. The
// installer copies the server into a stable folder and wires the MCP client
// configs to that copy.
//
// What it does:
//   1. copies server.mjs / sync.mjs / yaml.mjs / package.json to ~/.wb-mcp/app
//   2. builds the API catalog there (node sync.mjs) unless --skip-sync
//   3. writes the "wb" MCP server entry into Cursor / Claude Desktop / Codex /
//      VS Code config (existing files are backed up first)
//
// Usage:
//   node install.mjs --client all --token <WB_API_TOKEN>
//   node install.mjs --client cursor --token <token> --dry-run
//   node install.mjs --client claude --skip-sync
//   npx -y -p github:owner/wb-mcp wb-mcp-install --client all --token <token>

import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, loadCatalogBundle, writeCatalogBundle } from './sync.mjs';
import { saveTokenToFile } from './tokenstore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['server.mjs', 'sync.mjs', 'yaml.mjs', 'search.mjs', 'tokens.mjs', 'tokenstore.mjs', 'keyring.mjs', 'verify.mjs', 'doctor.mjs', 'package.json', 'README.md', 'AGENT-INSTALL.md', 'LICENSE'];

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY_RUN = has('--dry-run');
const SKIP_SYNC = has('--skip-sync');
const NO_RELEASE = has('--no-release');
const LOCAL_BUNDLE = get('--bundle');
const PLAIN_TOKEN = has('--plain-token');
const NO_BACKUP = has('--no-backup');
const CLIENTS = (() => {
  const raw = get('--client') ?? 'auto';
  if (raw === 'all') return ['cursor', 'claude', 'claude-code', 'codex', 'gemini', 'vscode'];
  if (raw === 'auto') return null; // detect below
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
})();

// WB_MCP_CONFIG_ROOT is a testing hook: keeps all configs inside a temp dir.
const CONFIG_ROOT = process.env.WB_MCP_CONFIG_ROOT || null;
const DATA_ROOT = process.env.WB_MCP_HOME || CONFIG_ROOT || path.join(os.homedir(), '.wb-mcp');
const APP_DIR = path.join(DATA_ROOT, 'app');

const TOKEN = get('--token') ?? process.env.WB_API_TOKEN ?? null;
const ACCOUNTS_RAW = get('--accounts') ?? null;
const NODE_BIN = process.execPath;

function home(...parts) {
  const base = CONFIG_ROOT || os.homedir();
  return path.join(base, ...parts);
}

function appData(...parts) {
  const base = CONFIG_ROOT ? path.join(CONFIG_ROOT, 'AppData', 'Roaming') : process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, ...parts);
}

const TARGETS = {
  cursor: {
    title: 'Cursor',
    kind: 'json',
    file: home('.cursor', 'mcp.json'),
    doc: 'Restart Cursor → Settings → MCP: сервер "wb" должен быть в списке.',
  },
  claude: {
    title: 'Claude Desktop',
    kind: 'json',
    file: appData('Claude', 'claude_desktop_config.json'),
    doc: 'Полностью перезапусти Claude Desktop (иконка в трее → Quit), затем проверь раздел MCP.',
  },
  'claude-code': {
    title: 'Claude Code',
    kind: 'json',
    file: home('.claude.json'),
    doc: 'В новом чате Claude Code проверь /mcp — сервер "wb" должен быть в списке.',
  },
  codex: {
    title: 'Codex CLI',
    kind: 'toml',
    file: home('.codex', 'config.toml'),
    doc: 'Запусти `codex` заново; MCP-сервер "wb" появится в списке инструментов.',
  },
  gemini: {
    title: 'Gemini CLI',
    kind: 'json',
    file: home('.gemini', 'settings.json'),
    doc: 'Запусти `gemini` заново и проверь /mcp.',
  },
  vscode: {
    title: 'VS Code (Copilot MCP)',
    kind: 'json',
    file: appData('Code', 'User', 'mcp.json'),
    doc: 'Перезагрузи VS Code; MCP-сервер "wb" появится в Copilot Chat.',
  },
};

function detectClients() {
  const found = [];
  for (const [key, target] of Object.entries(TARGETS)) {
    if (existsSync(path.dirname(target.file))) found.push(key);
  }
  return found;
}

function maskToken(token) {
  if (!token) return null;
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} символов)`;
}

function serverEntry(extraEnv) {
  const entry = { command: NODE_BIN, args: [path.join(APP_DIR, 'server.mjs')], env: { ...(extraEnv ?? {}) } };
  return entry;
}

// Stores the WB token encrypted (AES-256-GCM) and returns the env block for the
// client config: clients get only the path to the encrypted file, not the token.
// With --accounts, stores each token in its own encrypted file and returns
// WB_TOKEN_FILES (JSON) — so multi-store is encrypted too, not plaintext in env.
function parseAccounts(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ожидается JSON-объект вида {"имя":"токен", ...}');
  }
  const out = {};
  for (const [name, token] of Object.entries(parsed)) {
    if (typeof token !== 'string' || !token.trim()) throw new Error(`пустой токен для аккаунта "${name}"`);
    out[name] = token.trim();
  }
  if (!Object.keys(out).length) throw new Error('нет ни одного аккаунта');
  return out;
}

function accountsEnv() {
  let accounts;
  try {
    accounts = parseAccounts(ACCOUNTS_RAW);
  } catch (err) {
    console.error(`! --accounts: ${err.message}`);
    return { error: true };
  }
  const files = {};
  for (const [name, token] of Object.entries(accounts)) {
    const safe = String(name).replace(/[^\w.-]+/g, '_') || 'account';
    const file = path.join(DATA_ROOT, 'accounts', `${safe}.enc`);
    const key = `${file}.key`;
    if (DRY_RUN) {
      console.log(`· аккаунт "${name}" будет сохранён зашифрованно: ${file}`);
    } else {
      saveTokenToFile(token, { file, keyFile: key });
      console.log(`· аккаунт "${name}" сохранён зашифрованно: ${file} (ключ: ${key})`);
    }
    files[name] = { file, key };
  }
  return { env: { WB_TOKEN_FILES: JSON.stringify(files) } };
}

function prepareTokenEnv() {
  if (ACCOUNTS_RAW) {
    const result = accountsEnv();
    if (result.error) return null;
    return result.env;
  }
  const tokenFile = path.join(DATA_ROOT, 'token.enc');
  const keyFile = path.join(DATA_ROOT, 'token.key');
  if (TOKEN && !PLAIN_TOKEN) {
    if (DRY_RUN) {
      console.log(`· токен будет сохранён зашифрованно: ${tokenFile} (ключ: ${keyFile})`);
    } else {
      saveTokenToFile(TOKEN, { file: tokenFile, keyFile });
      console.log(`· токен сохранён зашифрованно: ${tokenFile} (ключ: ${keyFile})`);
    }
    return { WB_TOKEN_FILE: tokenFile };
  }
  if (!TOKEN && !PLAIN_TOKEN && existsSync(tokenFile)) {
    console.log(`· использую ранее сохранённый зашифрованный токен: ${tokenFile}`);
    return { WB_TOKEN_FILE: tokenFile };
  }
  if (TOKEN && PLAIN_TOKEN) {
    console.log('· ВНИМАНИЕ: --plain-token — токен будет лежать в конфиге клиента открытым текстом');
    return { WB_API_TOKEN: TOKEN };
  }
  return {};
}
  async function copyApp() {
  const needCopy = [path.resolve(HERE) !== path.resolve(APP_DIR), !existsSync(path.join(APP_DIR, 'server.mjs'))];
  if (!needCopy[0] && !needCopy[1]) return { copied: false };
  if (DRY_RUN) return { copied: true, dryRun: true };
  await mkdir(APP_DIR, { recursive: true });
  for (const file of FILES) {
    const from = path.join(HERE, file);
    if (!existsSync(from)) continue;
    await copyFile(from, path.join(APP_DIR, file));
  }
  return { copied: true };
}

async function backup(file) {
  if (NO_BACKUP || !existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const target = `${file}.bak-${stamp}`;
  if (!DRY_RUN) await copyFile(file, target);
  return target;
}

async function writeJsonConfig(target, entry) {
  let config = {};
  let existed = false;
  if (existsSync(target.file)) {
    existed = true;
    const raw = await readFile(target.file, 'utf8');
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      throw new Error(`Не могу разобрать ${target.file}: ${err.message}. Исправь файл вручную и повтори (бэкап делать не буду вслепую).`);
    }
  }
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.wb = entry;
  const bak = await backup(target.file);
  if (!DRY_RUN) {
    await mkdir(path.dirname(target.file), { recursive: true });
    await writeFile(target.file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  return { file: target.file, existed, backup: bak };
}

function tomlSection(entry) {
  const lines = ['[mcp_servers.wb]', `command = ${JSON.stringify(entry.command)}`];
  lines.push('args = [' + entry.args.map((a) => JSON.stringify(a)).join(', ') + ']');
  if (entry.env) {
    const pairs = Object.entries(entry.env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    lines.push(`env = { ${pairs.join(', ')} }`);
  }
  return lines.join('\n');
}

async function writeTomlConfig(target, entry) {
  let text = '';
  let existed = false;
  if (existsSync(target.file)) {
    existed = true;
    text = await readFile(target.file, 'utf8');
  }
  const section = tomlSection(entry);
  // Replace the whole [mcp_servers.wb] block: header + body, up to the next
  // table header at line start or end of file. `$` must not be used in the
  // lookahead here because /m makes it match end-of-line.
  const sectionRe = /^\[mcp_servers\.wb\][^\n]*\n?[\s\S]*?(?=^\[|(?![\s\S]))/m;
  if (sectionRe.test(text)) {
    text = text.replace(sectionRe, section + '\n\n');
  } else {
    text = `${text.trimEnd()}\n\n${section}\n`;
  }
  const bak = await backup(target.file);
  if (!DRY_RUN) {
    await mkdir(path.dirname(target.file), { recursive: true });
    await writeFile(target.file, text.replace(/\n{3,}/g, '\n\n'), 'utf8');
  }
  return { file: target.file, existed, backup: bak };
}

async function resolveRepo(explicit) {
  if (explicit) return explicit;
  if (process.env.WB_MCP_REPO) return process.env.WB_MCP_REPO;
  try {
    const pkg = JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    const match = /github\.com[/:]([^/]+)\/([^/.#]+?)(?:\.git)?$/.exec(url);
    if (match && !match[1].includes('<') && !match[2].includes('<')) return `${match[1]}/${match[2]}`;
  } catch {
    // package.json is optional here
  }
  return null;
}

// Downloads the prebuilt catalog bundle attached to the latest GitHub release.
// There are no dependencies and the bundle is a single JSON file, so no tar.
async function catalogFromRelease(repo) {
  const ua = { 'user-agent': 'wb-mcp-install/1.0', accept: 'application/vnd.github+json' };
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: ua,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET release → HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets ?? []).find((item) => item.name === 'catalog.bundle.json');
  if (!asset) throw new Error('в последнем релизе нет catalog.bundle.json');
  const download = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'wb-mcp-install/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!download.ok) throw new Error(`download bundle → HTTP ${download.status}`);
  const bundle = await download.json();
  const stats = await writeCatalogBundle(bundle, path.join(APP_DIR, 'catalog'));
  return { ...stats, tag: release.tag_name, url: release.html_url };
}

async function runSync() {
  if (SKIP_SYNC) {
    console.log('· каталог не собираю (--skip-sync)');
    return { ok: true, skipped: true };
  }

  if (LOCAL_BUNDLE) {
    try {
      const bundle = await loadCatalogBundle(LOCAL_BUNDLE);
      const stats = await writeCatalogBundle(bundle, path.join(APP_DIR, 'catalog'));
      console.log(`· каталог из локального бандла: ${stats.modules} разделов, ${stats.operations} методов`);
      return { ok: true, mode: 'bundle', stats };
    } catch (err) {
      console.error(`! локальный бандл не прочитан: ${err.message}`);
    }
  }

  const repo = await resolveRepo(get('--repo'));
  if (!NO_RELEASE && repo) {
    try {
      const stats = await catalogFromRelease(repo);
      console.log(
        `· каталог из GitHub Release ${repo}@${stats.tag || 'latest'}: ${stats.modules} разделов, ` +
          `${stats.operations} методов (readonly ${stats.readonly}, запись ${stats.write}, файлы ${stats.file})`,
      );
      return { ok: true, mode: 'release', stats };
    } catch (err) {
      console.log(`· релиз с каталогом недоступен (${err.message}) — собираю из официальных спек`);
    }
  }

  try {
    const stats = await buildCatalog({ outDir: path.join(APP_DIR, 'catalog'), verbose: false });
    console.log(
      `· каталог собран: ${stats.modules} разделов, ${stats.operations} методов ` +
        `(readonly ${stats.readonly}, запись ${stats.write}, файлы ${stats.file})`,
    );
    if (stats.missing?.length) {
      console.log(`  ВНИМАНИЕ: не собраны модули: ${stats.missing.join(', ')}`);
      console.log('  WB мог переименовать спеку: см. sync.mjs (MODULES) и AGENT-INSTALL.md, раздел «Если что-то не работает».');
    }
    if (stats.optionalMissing?.length) {
      console.log(`  опциональные модули недоступны: ${stats.optionalMissing.join(', ')} (это отдельные продукты WB, не Seller API)`);
    }
    if (stats.warnings.length) console.log(`  предупреждений: ${stats.warnings.length} (подробнее: node sync.mjs --verbose)`);
    return { ok: true, mode: 'sync', stats };
  } catch (err) {
    console.error(`! не удалось собрать каталог: ${err.message}`);
    console.error('  Проверь интернет и повтори `node sync.mjs`, либо укажи локальную папку со спеками или бандл: --bundle <file>');
    return { ok: false, error: err.message };
  }
}

async function main() {
  console.log('wb-mcp installer');
  console.log(`· стабильная папка: ${APP_DIR}`);
  console.log(`· node: ${NODE_BIN}`);
  console.log(`· токен: ${TOKEN ? maskToken(TOKEN) : 'НЕ ПЕРЕДАН (добавь --token <WB_API_TOKEN>)'}`);
  if (DRY_RUN) console.log('· режим: DRY-RUN (ничего не пишу на диск)');

  if (!TOKEN) {
    console.log('\nВнимание: без токена сервер запустится, но wb_call будет возвращать ошибку.');
    console.log('Токен создаётся: кабинет продавца → Интеграции по API → Создать токен (категории + «Только чтение» по желанию).');
  }

  const copy = await copyApp();
  if (copy.copied) console.log(`· файлы сервера ${DRY_RUN ? 'будут скопированы' : 'скопированы'} в ${APP_DIR}`);

  const tokenEnv = prepareTokenEnv();
  if (tokenEnv === null) return { code: 1 };

  let sync;
  if (DRY_RUN) {
    console.log('· каталог не собираю (dry-run)');
    sync = { ok: true, skipped: true };
  } else {
    sync = await runSync();
  }
  if (!sync.ok && !DRY_RUN) {
    console.log('\nКаталог не собран — конфиги всё равно пропишу, но перед использованием нужно выполнить:');
    console.log(`  node "${path.join(APP_DIR, 'sync.mjs')}"`);
  }

  const chosen = CLIENTS ?? detectClients();
  if (!chosen.length) {
    console.log('\nКлиенты не обнаружены автоматически. Ниже готовые конфиги — вставь нужный вручную.\n');
    for (const [key, target] of Object.entries(TARGETS)) {
      console.log(`--- ${target.title} (${target.file}) ---`);
      if (target.kind === 'json') {
        console.log(JSON.stringify({ mcpServers: { wb: serverEntry(tokenEnv) } }, null, 2));
      } else {
        console.log(tomlSection(serverEntry(tokenEnv)));
      }
      console.log('');
    }
    return { code: sync.ok ? 0 : 2 };
  }

  const entry = serverEntry(tokenEnv);
  const results = [];
  const failures = [];
  for (const key of chosen) {
    const target = TARGETS[key];
    if (!target) {
      console.log(`! неизвестный клиент "${key}" (доступны: ${Object.keys(TARGETS).join(', ')})`);
      failures.push(key);
      continue;
    }
    try {
      const res = target.kind === 'json' ? await writeJsonConfig(target, entry) : await writeTomlConfig(target, entry);
      results.push({ key, ...res });
      console.log(`· ${target.title}: ${DRY_RUN ? 'будет записано в ' : 'записано в '}${res.file}`);
      if (res.existed) console.log(`  существующий конфиг ${DRY_RUN ? 'будет ' : ''}сохранён в бэкап${res.backup ? `: ${res.backup}` : ''}`);
      console.log(`  ${target.doc}`);
    } catch (err) {
      failures.push(key);
      console.log(`! ${target.title}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.log(`\nВНИМАНИЕ: не удалось записать конфиг для клиентов: ${failures.join(', ')}.`);
    console.log('Проверь права на файлы/папки конфигов и повтори установку.');
    return { code: 1 };
  }

  console.log('\nГотово. Что дальше:');
  console.log('1) Перезапусти MCP-клиент (или переподключи MCP-сервер).');
  console.log('2) В чате попроси агента: "покажи разделы WB API" — он вызовет wb_sections.');
  console.log('3) Проверка доступа: "проверь мой WB токен" → wb_token_info, затем "проверь подключение к WB" → wb_get getPing.');
  console.log('4) Диагностика: node ~/.wb-mcp/app/doctor.mjs (Node, каталог, токен, сеть, конфиги).');
  if (results.length && sync.ok) console.log(`\nУстановлено клиентов: ${results.length}. Каталог: ${path.join(APP_DIR, 'catalog')}`);
  return { code: sync.ok || SKIP_SYNC ? 0 : 2 };
}

main()
  .then((res) => process.exit(res?.code ?? 0))
  .catch((err) => {
    console.error('install failed:', err?.stack ?? err);
    process.exit(1);
  });
