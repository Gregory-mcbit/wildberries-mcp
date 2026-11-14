#!/usr/bin/env node
// Publishes this repository to GitHub through the REST API (no git needed).
//
// Why: on this machine `git` cannot speak TLS to github.com (schannel
// SEC_E_NO_CREDENTIALS), while Node's fetch works. So the publisher creates the
// repo, uploads every tracked file as a Git blob/tree/commit and updates the
// branch ref via the Git Data API.
//
// Usage:
//   $env:GITHUB_TOKEN = "github_pat_..."      # token with "repo" scope (fine-grained: Contents + Administration write)
//   node publish-gh.mjs --repo wb-mcp
//   node publish-gh.mjs --dry-run             # validate token + list files, ничего не пишет
//   node publish-gh.mjs --owner me --repo wb-mcp --private --branch main
//
// The script also replaces <owner> / <REPO_URL> placeholders in README.md and
// AGENT-INSTALL.md with real values, both in the published commit and locally.

import { readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDeeplinks } from './deeplinks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const API = 'https://api.github.com';
const USER_AGENT = 'wb-mcp-publisher/1.0';

// Files/dirs listed in `.publish` are the only ones uploaded to GitHub when the
// manifest exists. Everything else is development-only (roadmap, tooling,
// generated catalog, downloaded specs).
async function readManifest(dir) {
  try {
    const raw = await readFile(path.join(dir, '.publish'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return null;
  }
}

export function applyManifest(files, manifest) {
  if (!manifest) return files;
  const matches = (relPath) =>
    manifest.some((entry) => (entry.endsWith('/') ? relPath === entry.slice(0, -1) || relPath.startsWith(entry) : relPath === entry));
  return files.filter((file) => matches(file.path));
}

export const DEFAULT_IGNORES = [
  '.git',
  'catalog/',
  'catalog-*/',
  'specs-raw/',
  'node_modules/',
  '*.bak-*',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function normalizeRules(lines) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const dirOnly = line.endsWith('/');
      const body = line.replace(/\/$/, '');
      const hasGlob = /[*?]/.test(body);
      return { raw: body, dirOnly, hasGlob, re: hasGlob ? globToRegex(body) : null };
    });
}

export function isIgnored(relPath, rules) {
  const normalized = relPath.split(path.sep).join('/');
  const segments = normalized.split('/');
  for (const rule of rules) {
    if (rule.dirOnly) {
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join('/');
        if (rule.re ? rule.re.test(prefix) : prefix === rule.raw) return true;
      }
      continue;
    }
    for (const segment of segments) {
      if (rule.re ? rule.re.test(segment) : segment === rule.raw) return true;
    }
    if (rule.re ? rule.re.test(normalized) : normalized === rule.raw) return true;
  }
  return false;
}

export async function collectFiles(dir, rules) {
  const out = [];
  async function walk(rel) {
    const abs = path.join(dir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (isIgnored(childRel, rules)) continue;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        const info = await stat(path.join(dir, childRel));
        out.push({ path: childRel.split(path.sep).join('/'), abs: path.join(dir, childRel), size: info.size });
      }
    }
  }
  await walk('');
  return out;
}

export function substitutePlaceholders(text, { owner, repo }) {
  const url = `https://github.com/${owner}/${repo}`;
  return text
    .replaceAll('<REPO_URL>', url)
    .replaceAll('<owner>/<repo>', `${owner}/${repo}`)
    .replaceAll('<owner>', owner)
    .replaceAll('<OWNER>', owner)
    .replaceAll('<repo>', repo)
    .replaceAll('<REPO>', repo);
}

async function apiRequest(fetchImpl, token, method, url, body) {
  const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 300) };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

async function uploadAsset(fetchImpl, token, uploadUrl, name, content, contentType) {
  const url = `${String(uploadUrl).replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': contentType,
      'user-agent': USER_AGENT,
    },
    body: content,
  });
  if (!res.ok) throw new Error(`upload ${name} → HTTP ${res.status}`);
  return res;
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

export async function publish(options) {
  const {
    token,
    dir = HERE,
    owner: ownerArg,
    repo = 'wb-mcp',
    branch = 'main',
    description = 'MCP server for the full Wildberries Seller API: all 13 official sections, 309 methods, zero dependencies, no VPS',
    topics = ['mcp', 'model-context-protocol', 'wildberries', 'seller-api', 'ai', 'cursor', 'claude', 'codex'],
    privateRepo = false,
    dryRun = false,
    message,
    ignoreManifest = false,
    exclude = [],
    publishRelease = true,
    publishMcpb = true,
    releaseTag = 'catalog',
    catalogDir = null,
    fetchImpl = globalThis.fetch,
    log = console.log,
  } = options;

  if (!token) fail('Не передан GitHub-токен. Задай GITHUB_TOKEN (scope: repo / Contents+Administration write).');

  const auth = await apiRequest(fetchImpl, token, 'GET', '/user');
  if (auth.status === 401) fail('GitHub отклонил токен (401). Проверь срок действия и scope.', 401);
  if (!auth.ok) fail(`GET /user → ${auth.status} ${auth.data?.message ?? ''}`, auth.status);
  const owner = ownerArg ?? auth.data.login;
  if (owner !== auth.data.login) {
    fail(`Токен принадлежит "${auth.data.login}", а --owner="${owner}". Публикация в чужой аккаунт невозможна.`);
  }

  const rules = normalizeRules([
    ...(await readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => '')).split(/\r?\n/),
    ...DEFAULT_IGNORES,
  ]);
  const allFiles = await collectFiles(dir, rules);
  if (!allFiles.length) fail('Не найдено ни одного файла для публикации');
  const manifest = ignoreManifest ? null : await readManifest(dir);
  let files = applyManifest(allFiles, manifest);
  if (exclude.length) {
    files = files.filter(
      (file) => !exclude.some((pattern) => (pattern.endsWith('/') ? file.path.startsWith(pattern) : file.path === pattern)),
    );
  }
  if (!files.length) fail('Манифест .publish не оставил ни одного файла для публикации');
  log(`· аккаунт: ${auth.data.login}`);
  if (manifest) log(`· файлов к публикации: ${files.length} из ${allFiles.length} (фильтр .publish, dev-файлы остаются локально)`);
  else log(`· файлов к публикации: ${files.length}`);

  const docsToRewrite = ['README.md', 'README.en.md', 'AGENT-INSTALL.md', 'package.json'];
  const deeplinks = makeDeeplinks({ owner, repo });

  // Prepare contents (placeholders are substituted in docs)
  const prepared = [];
  for (const file of files) {
    const raw = await readFile(file.abs);
    const isText = /\.(md|mjs|js|json|yml|yaml|txt|gitignore)$/i.test(file.path) || file.path === '.gitignore';
    let content = raw;
    if (isText) {
      let text = raw.toString('utf8');
      if (docsToRewrite.includes(file.path)) {
        text = substitutePlaceholders(text, { owner, repo });
        text = text
          .replaceAll('<CURSOR_DEEPLINK>', deeplinks.cursor)
          .replaceAll('<VSCODE_DEEPLINK>', deeplinks.vscode);
      }
      content = Buffer.from(text, 'utf8');
    }
    prepared.push({ ...file, content });
  }

  if (dryRun) {
    log('· DRY-RUN: ничего не пишу на GitHub и локально');
    log(`· файлы:\n  ${prepared.map((f) => f.path).join('\n  ')}`);
    log(`· будет создан/обновлён репозиторий: https://github.com/${owner}/${repo} (${privateRepo ? 'private' : 'public'})`);
    return { dryRun: true, owner, repo, files: prepared.map((f) => f.path), url: `https://github.com/${owner}/${repo}` };
  }

  // 1. Ensure repository exists
  let repoInfo = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}`);
  if (repoInfo.status === 404) {
    log(`· создаю репозиторий ${owner}/${repo} (${privateRepo ? 'private' : 'public'})`);
    repoInfo = await apiRequest(fetchImpl, token, 'POST', '/user/repos', {
      name: repo,
      description,
      private: privateRepo,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    });
    if (!repoInfo.ok) fail(`не удалось создать репозиторий: ${repoInfo.status} ${repoInfo.data?.message ?? ''}`, repoInfo.status);
  } else if (!repoInfo.ok) {
    fail(`GET /repos/${owner}/${repo} → ${repoInfo.status}`, repoInfo.status);
  }

  // 2. Current branch tip (empty repo has no refs)
  const authorName = process.env.GIT_AUTHOR_NAME || 'wb-mcp';
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || 'wb-mcp@users.noreply.github.com';
  let parentSha = null;
  let refRes = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (refRes.ok && refRes.data?.object?.sha) {
    parentSha = refRes.data.object.sha;
  } else if (refRes.status === 404 || refRes.status === 409) {
    // The Git Data API refuses to create blobs on a repository without commits,
    // so seed the default branch with one tiny file via the Contents API first.
    log('· репозиторий пуст — создаю начальный коммит');
    const seed = await apiRequest(fetchImpl, token, 'PUT', `/repos/${owner}/${repo}/contents/.gitignore`, {
      message: 'init: bootstrap empty repository',
      content: Buffer.from('\n').toString('base64'),
      branch,
      author: { name: authorName, email: authorEmail },
      committer: { name: authorName, email: authorEmail },
    });
    if (!seed.ok) fail(`не удалось создать начальный коммит: ${seed.status} ${seed.data?.message ?? ''}`, seed.status);
    refRes = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    if (refRes.ok && refRes.data?.object?.sha) parentSha = refRes.data.object.sha;
    else fail(`ветка ${branch} не появилась после bootstrap: ${refRes.status}`, refRes.status);
  } else {
    fail(`не удалось прочитать ветку ${branch}: ${refRes.status}`, refRes.status);
  }

  // 3. Blobs
  log('· загружаю блобы файлов...');
  const treeEntries = [];
  for (const file of prepared) {
    const blob = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: file.content.toString('base64'),
      encoding: 'base64',
    });
    if (!blob.ok) fail(`blob ${file.path}: ${blob.status} ${blob.data?.message ?? ''}`, blob.status);
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha });
  }

  // 4. Tree (based on the parent tree when the branch already exists)
  let baseTree = null;
  if (parentSha) {
    const parentCommit = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`);
    if (parentCommit.ok) baseTree = parentCommit.data?.tree?.sha ?? null;
  }
  const treeRes = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
    tree: treeEntries.slice(0, 1).map((e) => e),
    ...(baseTree ? { base_tree: baseTree } : {}),
  });
  if (!treeRes.ok) fail(`tree: ${treeRes.status} ${treeRes.data?.message ?? ''}`, treeRes.status);
  let treeSha = treeRes.data.sha;
  if (treeEntries.length > 1) {
    // Add remaining entries through a second tree request on top of the first.
    const restRes = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: treeSha,
      tree: treeEntries.slice(1),
    });
    if (!restRes.ok) fail(`tree (rest): ${restRes.status} ${restRes.data?.message ?? ''}`, restRes.status);
    treeSha = restRes.data.sha;
  }

  // 5. Commit
  const now = new Date().toISOString();
  const commitMessage = message ?? `wb-mcp 0.1.0: full Wildberries Seller API MCP (${prepared.length} files)`;
  const commitRes = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message: commitMessage,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
    author: { name: authorName, email: authorEmail, date: now },
    committer: { name: authorName, email: authorEmail, date: now },
  });
  if (!commitRes.ok) fail(`commit: ${commitRes.status} ${commitRes.data?.message ?? ''}`, commitRes.status);
  const commitSha = commitRes.data.sha;

  // 6. Create or fast-forward the branch
  if (parentSha) {
    const patch = await apiRequest(fetchImpl, token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commitSha,
      force: false,
    });
    if (!patch.ok) fail(`не удалось обновить ветку: ${patch.status} ${patch.data?.message ?? ''}`, patch.status);
  } else {
    const create = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
    if (!create.ok) fail(`не удалось создать ветку: ${create.status} ${create.data?.message ?? ''}`, create.status);
  }

  // 7. Metadata (description/topics) — best effort
  await apiRequest(fetchImpl, token, 'PATCH', `/repos/${owner}/${repo}`, { description, homepage: `https://github.com/${owner}/${repo}` });
  await apiRequest(fetchImpl, token, 'PUT', `/repos/${owner}/${repo}/topics`, { names: topics });

  // 7. Offline catalog as a GitHub Release asset (single JSON bundle, no tar).
  let releaseUrl = null;
  const catalogPath = catalogDir ?? path.join(dir, 'catalog');
  if (publishRelease && existsSync(path.join(catalogPath, 'index.json'))) {
    try {
      const { createCatalogBundle } = await import('./sync.mjs');
      const bundle = await createCatalogBundle(catalogPath);
      const body = JSON.stringify(bundle);
      log(`· готовлю релиз ${releaseTag}: ${bundle.index.operations.length} методов, ${(body.length / 1024 / 1024).toFixed(2)} МБ`);

      let release = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}/releases/tags/${releaseTag}`);
      if (release.status === 404) {
        release = await apiRequest(fetchImpl, token, 'POST', `/repos/${owner}/${repo}/releases`, {
          tag_name: releaseTag,
          name: 'Каталог WB API (offline bundle)',
          body: `Готовый каталог ${bundle.index.meta.totalOps} методов (${bundle.index.meta.modules.length} разделов) от ${bundle.createdAt}. Установщик скачивает его, чтобы работать без сборки спек.`,
        });
      }
      if (!release.ok) throw new Error(`GET/POST release → ${release.status} ${release.data?.message ?? ''}`);
      const releaseId = release.data.id;

      // Replace existing assets with the same names (re-runs would otherwise 422).
      const ASSET_NAMES = ['catalog.bundle.json', 'wb-mcp.mcpb', 'wb-mcp-portable.zip'];
      const assets = await apiRequest(fetchImpl, token, 'GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets`);
      for (const asset of assets.data ?? []) {
        if (ASSET_NAMES.includes(asset.name)) {
          await apiRequest(fetchImpl, token, 'DELETE', asset.url);
        }
      }
      const uploadUrl = String(release.data.upload_url);
      await uploadAsset(fetchImpl, token, uploadUrl, 'catalog.bundle.json', body, 'application/json');
      log('· каталог приложен к релизу (catalog.bundle.json)');

      // MCP Bundle for Claude Desktop (double-click install).
      if (publishMcpb) {
        try {
          const { buildMcpb } = await import('./build-mcpb.mjs');
          const mcpbFile = path.join(os.tmpdir(), `wb-mcp-${process.pid}-${Date.now()}.mcpb`);
          let version = '0.1.0';
          try {
            version = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).version ?? version;
          } catch {
            // package.json is optional here
          }
          const built = await buildMcpb({ outFile: mcpbFile, catalogDir: catalogPath, sourceDir: dir, owner, repo, version });
          const mcpbBytes = await readFile(mcpbFile);
          await uploadAsset(fetchImpl, token, uploadUrl, 'wb-mcp.mcpb', mcpbBytes, 'application/zip');
          await unlink(mcpbFile).catch(() => {});
          log(`· MCP Bundle приложен к релизу (wb-mcp.mcpb, ${(built.bytes / 1024 / 1024).toFixed(2)} МБ, ${built.entries} файлов)`);
        } catch (err) {
          log(`! не удалось собрать/приложить .mcpb: ${err.message}`);
        }
      }

      releaseUrl = release.data.html_url;
      log(`· релиз: ${releaseUrl}`);

      // Portable ZIP (Windows install.cmd / macOS-Linux install.sh + offline catalog).
      if (publishMcpb) {
        try {
          const { buildPortableZip } = await import('./build-mcpb.mjs');
          const zipFile = path.join(os.tmpdir(), `wb-mcp-portable-${process.pid}-${Date.now()}.zip`);
          const portable = await buildPortableZip({ outFile: zipFile, catalogDir: catalogPath, sourceDir: dir });
          await uploadAsset(fetchImpl, token, uploadUrl, 'wb-mcp-portable.zip', await readFile(zipFile), 'application/zip');
          await unlink(zipFile).catch(() => {});
          log(`· Portable ZIP приложен к релизу (wb-mcp-portable.zip, ${(portable.bytes / 1024 / 1024).toFixed(2)} МБ)`);
        } catch (err) {
          log(`! не удалось собрать/приложить portable zip: ${err.message}`);
        }
      }
    } catch (err) {
      log(`! не удалось приложить каталог к релизу: ${err.message} (репозиторий всё равно опубликован)`);
    }
  } else if (publishRelease) {
    log('· локального каталога нет — релиз с каталогом не создаю (собери: node sync.mjs)');
  }

  // 8. Rewrite local docs so the workspace matches what was published
  for (const file of prepared.filter((f) => docsToRewrite.includes(f.path))) {
    await writeFile(file.abs, file.content);
  }

  const url = `https://github.com/${owner}/${repo}`;
  log(`\n✔ Опубликовано: ${url}`);
  log(`  ветка: ${branch}, коммит: ${commitSha.slice(0, 10)}, файлов: ${prepared.length}`);
  if (releaseUrl) log(`  релиз с офлайн-каталогом: ${releaseUrl}`);
  log('\nДальше:');
  log(`1) Проверь репозиторий: ${url}`);
  log(`2) Подключение одной строкой: npx -y -p github:${owner}/${repo} wb-mcp-install --client all --token <WB_API_TOKEN>`);
  log(`3) Инструкция для агента: ${url}/blob/${branch}/AGENT-INSTALL.md`);
  return { url, owner, repo, branch, commitSha, releaseUrl, files: prepared.map((f) => f.path) };
}

async function main() {
  const token = get('--token') ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  try {
    const result = await publish({
      token,
      owner: get('--owner'),
      repo: get('--repo') ?? 'wb-mcp',
      branch: get('--branch') ?? 'main',
      description: get('--description'),
      privateRepo: has('--private'),
      dryRun: has('--dry-run'),
      message: get('--message'),
      ignoreManifest: has('--all'),
      exclude: (() => {
        const out = [];
        for (let i = 0; i < argv.length; i++) if (argv[i] === '--exclude' && argv[i + 1]) out.push(argv[i + 1]);
        return out;
      })(),
      publishRelease: !has('--no-release'),
      publishMcpb: !has('--no-mcpb'),
      releaseTag: get('--release-tag') ?? 'catalog',
      catalogDir: get('--catalog'),
    });
    if (result.dryRun) process.exit(0);
  } catch (err) {
    console.error(`publish failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
