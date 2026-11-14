// Tests for publish-gh.mjs with a mocked GitHub REST API: no network, no token
// leaves the process.

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyManifest, publish } from '../publish-gh.mjs';
import { PORTABLE_FILES } from '../build-mcpb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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

const TOKEN = 'ghp_SUPERSECRET_TOKEN_1234567890';

function makeMock({ repoExists = false, parentSha = null, authStatus = 200 } = {}) {
  const calls = [];
  const blobs = new Map();
  const state = { seeded: false };
  let blobIndex = 0;
  const json = (status, data) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(data),
  });

  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    let body = options.body;
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      try {
        body = JSON.parse(options.body.toString());
      } catch {
        body = options.body;
      }
    }
    calls.push({ method, url, body, headers: options.headers });

    if (method === 'GET' && url.endsWith('/user')) {
      if (authStatus === 401) return json(401, { message: 'Bad credentials' });
      return json(200, { login: 'tester' });
    }
    if (method === 'GET' && /\/repos\/tester\/wb-mcp$/.test(url)) {
      return repoExists ? json(200, { full_name: 'tester/wb-mcp', default_branch: 'main' }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && url.endsWith('/user/repos')) return json(201, { full_name: 'tester/wb-mcp' });
    if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(url)) {
      if (parentSha) return json(200, { object: { sha: parentSha } });
      if (state.seeded) return json(200, { object: { sha: 'seed-sha' } });
      return json(404, { message: 'Not Found' });
    }
    if (method === 'PUT' && /\/contents\/\.gitignore$/.test(url)) {
      state.seeded = true;
      return json(201, { content: { sha: 'seed-blob' }, commit: { sha: 'seed-sha' } });
    }
    if (method === 'GET' && /\/git\/commits\/seed-sha$/.test(url)) return json(200, { tree: { sha: 'seed-tree' } });
    if (method === 'GET' && /\/git\/commits\/parent-sha$/.test(url)) return json(200, { tree: { sha: 'parent-tree' } });
    if (method === 'POST' && /\/git\/blobs$/.test(url)) {
      const sha = `blob-${blobIndex++}`;
      blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return json(201, { sha });
    }
    if (method === 'POST' && /\/git\/trees$/.test(url)) {
      return json(201, { sha: body.base_tree ? 'tree-rest' : 'tree-1' });
    }
    if (method === 'POST' && /\/git\/commits$/.test(url)) return json(201, { sha: 'commit-1' });
    if (method === 'POST' && /\/git\/refs$/.test(url)) return json(201, { ref: body.ref });
    if (method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url)) return json(200, { ref: 'refs/heads/main' });
    if (method === 'PATCH' && /\/repos\/tester\/wb-mcp$/.test(url)) return json(200, {});
    if (method === 'PUT' && /\/topics$/.test(url)) return json(200, { names: body.names });
    if (method === 'GET' && /\/releases\/tags\/catalog$/.test(url)) return json(404, { message: 'Not Found' });
    if (method === 'POST' && /\/releases$/.test(url)) {
      return json(201, {
        id: 77,
        html_url: 'https://github.com/tester/wb-mcp/releases/tag/catalog',
        upload_url: 'https://uploads.github.com/repos/tester/wb-mcp/releases/77/assets{?name,label}',
      });
    }
    if (method === 'GET' && /\/releases\/77\/assets$/.test(url)) return json(200, []);
    if (method === 'POST' && url.startsWith('https://uploads.github.com/')) return json(201, { name: 'catalog.bundle.json' });
    return json(404, { message: `mock has no route for ${method} ${url}` });
  };
  return { fetchImpl, calls, blobs };
}

async function makeProject() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-publish-'));
  await writeFile(path.join(dir, '.gitignore'), 'catalog/\n*.log\nspecs-raw/\n', 'utf8');
  await writeFile(
    path.join(dir, 'README.md'),
    '# wb-mcp\n\nРепозиторий: <REPO_URL>\nПодключение: github:<owner>/wb-mcp\n\n' +
      '[Установить в Cursor](<CURSOR_DEEPLINK>)\n[Установить в VS Code](<VSCODE_DEEPLINK>)\n',
    'utf8',
  );
  await writeFile(path.join(dir, 'AGENT-INSTALL.md'), 'Ссылка: <REPO_URL>\n', 'utf8');
  await writeFile(path.join(dir, 'server.mjs'), '#!/usr/bin/env node\nconsole.log("hi");\n', 'utf8');
  await mkdir(path.join(dir, 'catalog'), { recursive: true });
  await writeFile(path.join(dir, 'catalog', 'index.json'), '{"secret":"generated"}', 'utf8');
  await writeFile(path.join(dir, 'debug.log'), 'ignored log', 'utf8');
  await mkdir(path.join(dir, 'specs-raw'), { recursive: true });
  await writeFile(path.join(dir, 'specs-raw', '01-general.yaml'), 'openapi: 3.0.1', 'utf8');
  await mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
  return dir;
}

async function main() {
  const dir = await makeProject();
  try {
    await test('манифест .publish ограничивает публикацию (dev-файлы не уходят)', async () => {
      const all = [
        { path: 'server.mjs' },
        { path: 'README.md' },
        { path: 'ROADMAP.md' },
        { path: 'publish-gh.mjs' },
        { path: 'test/mcp.test.mjs' },
        { path: '.github/workflows/ci.yml' },
      ];
      const filtered = applyManifest(all, ['server.mjs', 'README.md', 'test/', '.github/']);
      assert.deepEqual(
        filtered.map((f) => f.path),
        ['server.mjs', 'README.md', 'test/mcp.test.mjs', '.github/workflows/ci.yml'],
      );
      assert.deepEqual(
        applyManifest(all, null).map((f) => f.path),
        all.map((f) => f.path),
        'без манифеста публикуется всё',
      );
    });

    await test('dry-run: проверяет токен, показывает файлы и ничего не пишет', async () => {
      const mock = makeMock();
      const logs = [];
      const result = await publish({
        token: TOKEN,
        dir,
        repo: 'wb-mcp',
        dryRun: true,
        fetchImpl: mock.fetchImpl,
        log: (...a) => logs.push(a.join(' ')),
      });
      assert.equal(result.dryRun, true);
      assert.equal(result.url, 'https://github.com/tester/wb-mcp');
      const writes = mock.calls.filter((c) => c.method !== 'GET');
      assert.equal(writes.length, 0, 'в dry-run нет записывающих запросов');
      assert.ok(result.files.includes('README.md'));
      assert.ok(result.files.includes('.github/workflows/ci.yml'));
      assert.ok(!result.files.some((f) => f.startsWith('catalog/')), 'catalog/ игнорируется');
      assert.ok(!result.files.some((f) => f.endsWith('.log')), '*.log игнорируется');
      assert.ok(!result.files.some((f) => f.startsWith('specs-raw/')), 'specs-raw/ игнорируется');
      assert.ok(!logs.join('\n').includes(TOKEN), 'токен не попадает в лог');
    });

    await test('новая репозитория: создаёт repo, блобы, дерево, коммит и ветку', async () => {
      const mock = makeMock({ repoExists: false });
      const result = await publish({
        token: TOKEN,
        dir,
        repo: 'wb-mcp',
        fetchImpl: mock.fetchImpl,
        log: () => {},
      });
      assert.equal(result.url, 'https://github.com/tester/wb-mcp');
      assert.equal(result.commitSha, 'commit-1');
      const createRepo = mock.calls.find((c) => c.method === 'POST' && c.url.endsWith('/user/repos'));
      assert.ok(createRepo, 'репозиторий создан');
      assert.equal(createRepo.body.name, 'wb-mcp');
      const blobCalls = mock.calls.filter((c) => c.method === 'POST' && /\/git\/blobs$/.test(c.url));
      assert.equal(blobCalls.length, 5, 'ровно 5 файлов (без игнорируемых)');
      const readmeBlob = [...mock.blobs.values()].find((text) => text.includes('# wb-mcp'));
      assert.ok(readmeBlob.includes('https://github.com/tester/wb-mcp'), 'подставлен реальный URL');
      assert.ok(!readmeBlob.includes('<owner>'), 'плейсхолдеры <owner> заменены');
      const commit = mock.calls.find((c) => c.method === 'POST' && /\/git\/commits$/.test(c.url));
      assert.deepEqual(commit.body.parents, ['seed-sha'], 'коммит поверх bootstrap-коммита');
      const boot = mock.calls.find((c) => c.method === 'PUT' && /\/contents\/\.gitignore$/.test(c.url));
      assert.ok(boot, 'пустой репозиторий засеян начальным коммитом');
      assert.equal(boot.body.author.email, 'wb-mcp@users.noreply.github.com', 'bootstrap-коммит без личных данных');
      const patch = mock.calls.find((c) => c.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(c.url));
      assert.ok(patch, 'ветка обновлена на итоговый коммит');
      assert.equal(patch.body.sha, 'commit-1');
      const authHeader = mock.calls[0].headers.authorization;
      assert.ok(authHeader.includes(TOKEN), 'токен уходит только в заголовке');
      // локальные доки переписаны
      const localReadme = await readFile(path.join(dir, 'README.md'), 'utf8');
      assert.ok(localReadme.includes('https://github.com/tester/wb-mcp'), 'локальный README обновлён');
    });

    await test('релиз с офлайн-каталогом: создаёт release и загружает бандл', async () => {
      const mock = makeMock({ repoExists: true, parentSha: 'parent-sha' });
      const catalogDir = path.join(dir, 'catalog');
      await mkdir(catalogDir, { recursive: true });
      await writeFile(
        path.join(catalogDir, 'index.json'),
        JSON.stringify({
          meta: { modules: [{ key: '01-test', ops: 1 }], totalOps: 1, generatedAt: new Date().toISOString(), expectedModules: 1 },
          operations: [{ id: 'getPing', readonly: true, file: false, moduleKey: '01-test' }],
        }),
      );
      await writeFile(path.join(catalogDir, '01-test.json'), JSON.stringify({ operations: [{ id: 'getPing', readonly: true }] }));
      await writeFile(path.join(dir, 'server.mjs'), 'console.log(1)\n', 'utf8');
      // .mcpb and portable zip are built from the bundle source too: copy all runtime files.
      for (const file of PORTABLE_FILES) {
        await copyFile(path.join(ROOT, file), path.join(dir, file));
      }
      await mkdir(path.join(dir, 'skills', 'wb-mcp'), { recursive: true });
      await copyFile(path.join(ROOT, 'skills', 'wb-mcp', 'SKILL.md'), path.join(dir, 'skills', 'wb-mcp', 'SKILL.md'));
      // PORTABLE_FILES overwrites README with the real (already substituted) repo README;
      // write a fresh placeholder copy so substitution can be asserted deterministically.
      await writeFile(
        path.join(dir, 'README.md'),
        '# wb-mcp\n\nРепозиторий: <REPO_URL>\n\n[Установить в Cursor](<CURSOR_DEEPLINK>)\n[Установить в VS Code](<VSCODE_DEEPLINK>)\n',
        'utf8',
      );

      const result = await publish({
        token: TOKEN,
        dir,
        repo: 'wb-mcp',
        fetchImpl: mock.fetchImpl,
        log: () => {},
        catalogDir,
        releaseTag: 'catalog',
      });
      assert.equal(result.releaseUrl, 'https://github.com/tester/wb-mcp/releases/tag/catalog');
      const readmeBlob = [...mock.blobs.values()].find((text) => text.includes('[Установить в Cursor]'));
      assert.ok(readmeBlob.includes('cursor.com/install-mcp'), 'deeplink Cursor подставлен');
      assert.ok(readmeBlob.includes('vscode:mcp/install'), 'deeplink VS Code подставлен');
      assert.ok(readmeBlob.includes('github.com/tester/wb-mcp'), 'ссылки на репозиторий подставлены');
      const releasePost = mock.calls.find((c) => c.method === 'POST' && /\/releases$/.test(c.url));
      assert.ok(releasePost, 'релиз создан');
      assert.equal(releasePost.body.tag_name, 'catalog');
      const uploads = mock.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://uploads.github.com/'));
      assert.equal(uploads.length, 3, 'три ассета: каталог, .mcpb и portable zip');
      assert.ok(uploads.some((u) => u.url.includes('name=catalog.bundle.json')));
      assert.ok(uploads.some((u) => u.url.includes('name=wb-mcp.mcpb')));
      assert.ok(uploads.some((u) => u.url.includes('name=wb-mcp-portable.zip')));
      const bundleUpload = uploads.find((u) => u.url.includes('name=catalog.bundle.json'));
      assert.ok(bundleUpload.body?.modules?.['01-test'], 'в бандле есть модули');
      assert.equal(bundleUpload.body.index.operations.length, 1);
      const mcpbUpload = uploads.find((u) => u.url.includes('name=wb-mcp.mcpb'));
      assert.ok(Buffer.isBuffer(mcpbUpload.body), '.mcpb отправлен бинарём');
      assert.ok(mcpbUpload.body.length > 1000);
    });

    await test('существующая ветка: коммит с родителем и fast-forward', async () => {
      const mock = makeMock({ repoExists: true, parentSha: 'parent-sha' });
      await publish({ token: TOKEN, dir, repo: 'wb-mcp', fetchImpl: mock.fetchImpl, log: () => {} });
      const commit = mock.calls.find((c) => c.method === 'POST' && /\/git\/commits$/.test(c.url));
      assert.deepEqual(commit.body.parents, ['parent-sha']);
      const tree = mock.calls.find((c) => c.method === 'POST' && /\/git\/trees$/.test(c.url));
      assert.equal(tree.body.base_tree, 'parent-tree', 'дерево строится поверх родителя');
      const patch = mock.calls.find((c) => c.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(c.url));
      assert.ok(patch, 'ветка обновлена fast-forward');
      assert.equal(patch.body.sha, 'commit-1');
    });

    await test('неверный токен: падает до любых записей', async () => {
      const mock = makeMock({ authStatus: 401 });
      await assert.rejects(
        () => publish({ token: TOKEN, dir, repo: 'wb-mcp', fetchImpl: mock.fetchImpl, log: () => {} }),
        /401/,
      );
      assert.equal(mock.calls.filter((c) => c.method !== 'GET').length, 0);
    });

    await test('без токена: понятная ошибка', async () => {
      await assert.rejects(() => publish({ token: null, dir, fetchImpl: makeMock().fetchImpl, log: () => {} }), /токен/i);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
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
