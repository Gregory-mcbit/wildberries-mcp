#!/usr/bin/env node
// Validates and publishes the package to npm.
//
// The MCP Registry verifies ownership through `mcpName` in package.json, so the
// package and server.json must stay in sync: this script checks that before
// every publish.
//
// Usage:
//   node publish-npm.mjs --dry-run                  # validate + npm publish --dry-run
//   NPM_TOKEN=npm_... node publish-npm.mjs          # real publish (public)
//   node publish-npm.mjs --otp 123456

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
const has = (name) => ARGV.includes(name);
const get = (name) => {
  const i = ARGV.indexOf(name);
  return i >= 0 ? ARGV[i + 1] : undefined;
};

export async function loadReleaseMeta(dir = HERE) {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const server = JSON.parse(await readFile(path.join(dir, 'server.json'), 'utf8'));
  return { pkg, server };
}

// Everything the registry and npm care about, checked offline.
export async function validateRelease(dir = HERE) {
  const problems = [];
  const { pkg, server } = await loadReleaseMeta(dir);
  const add = (message) => problems.push(message);

  if (!pkg.name) add('package.json: нет name');
  if (!pkg.version) add('package.json: нет version');
  if (!pkg.mcpName) add('package.json: нет mcpName (нужен для MCP Registry)');
  if (pkg.mcpName !== server.name) add(`mcpName (${pkg.mcpName}) не совпадает с server.json name (${server.name})`);
  if (!server.name?.startsWith('io.github.')) add('server.json: name должен начинаться с io.github.');
  if ((server.description ?? '').length > 100) add(`server.json: description длиннее 100 символов (${server.description.length})`);
  if (server.version !== pkg.version) add(`версии не совпадают: package.json ${pkg.version} vs server.json ${server.version}`);
  if (!server.repository?.url) add('server.json: нет repository.url');
  if (!Array.isArray(server.packages) || !server.packages.length) add('server.json: нет packages');
  for (const entry of server.packages ?? []) {
    if (entry.registryType === 'npm' && entry.identifier !== pkg.name) {
      add(`server.json npm identifier (${entry.identifier}) не совпадает с package.json name (${pkg.name})`);
    }
    if (entry.version !== pkg.version) add(`пакет ${entry.registryType}: версия ${entry.version} != ${pkg.version}`);
  }
  const tokenEnv = (server.packages?.[0]?.environmentVariables ?? []).find((v) => v.name === 'WB_API_TOKEN');
  if (!tokenEnv?.isSecret) add('server.json: WB_API_TOKEN должен быть isSecret: true');
  if (pkg.license !== 'MIT') add('package.json: ожидается license MIT');
  if (!existsSync(path.join(dir, 'LICENSE'))) add('нет файла LICENSE');
  for (const file of pkg.files ?? []) {
    if (!existsSync(path.join(dir, file))) add(`files: ${file} не существует`);
  }
  return { problems, pkg, server };
}

export async function publishNpm({ dir = HERE, dryRun = false, otp, npmBinary = 'npm', env = process.env, log = console.log } = {}) {
  const { problems, pkg } = await validateRelease(dir);
  if (problems.length) throw new Error(`release validation failed:\n- ${problems.join('\n- ')}`);
  log(`· ${pkg.name}@${pkg.version} · mcpName ${pkg.mcpName}`);

  const args = ['publish', '--access', 'public'];
  if (dryRun) args.push('--dry-run');
  if (otp) args.push('--otp', String(otp));
  const childEnv = { ...env };
  const token = env.NPM_TOKEN ?? env.NODE_AUTH_TOKEN;
  if (token) childEnv.npm_config_//registry.npmjs.org/:_authToken = token;

  log(`· npm ${args.join(' ')}`);
  const binary = process.platform === 'win32' && npmBinary === 'npm' ? 'npm.cmd' : npmBinary;
  const result = spawnSync(binary, args, { cwd: dir, encoding: 'utf8', env: childEnv });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output) log(output);
  if (result.status !== 0) throw new Error(`npm publish exited with ${result.status}`);
  return { dryRun, name: pkg.name, version: pkg.version };
}

async function main() {
  try {
    const result = await publishNpm({
      dryRun: has('--dry-run'),
      otp: get('--otp'),
    });
    console.log(result.dryRun ? '\n✔ dry-run: пакет валиден' : `\n✔ опубликовано: https://www.npmjs.com/package/${result.name}/v/${result.version}`);
    if (!result.dryRun) {
      console.log('\nДальше — MCP Registry:');
      console.log('  mcp-publisher login github     # один раз, device flow в браузере');
      console.log('  mcp-publisher validate         # проверка server.json');
      console.log('  mcp-publisher publish          # публикация карточки');
    }
  } catch (err) {
    console.error(`publish-npm failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
