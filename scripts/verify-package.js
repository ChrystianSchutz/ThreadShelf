#!/usr/bin/env node
/**
 * Packs the real tarball, installs it into a throwaway directory, and boots it
 * from an unrelated working directory.
 *
 * This is the check that `npx threadshelf` actually works. Unit tests can only
 * assert intent; the failure modes that matter here — a file missing from the
 * `files` allow-list, an asset resolved from process.cwd(), user data written
 * into the disposable install directory — only show up against a real install.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (args, cwd) => {
  const result = spawnSync(npm, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return result.stdout.trim();
};

const listFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
};

const get = async (url) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
};

const waitForHealth = async (baseUrl, child, log) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (${child.exitCode})\n${log.join('')}`);
    }
    try {
      if ((await get(`${baseUrl}/api/health`)).status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server never became healthy\n${log.join('')}`);
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const verify = async (workspace) => {
  const installDir = join(workspace, 'install');
  const dataDir = join(workspace, 'data');
  const cwdDir = join(workspace, 'elsewhere');
  await mkdir(installDir, { recursive: true });
  await mkdir(cwdDir, { recursive: true });

  console.log('Packing the tarball (runs prepack: client + server build)...');
  const tarball = join(
    workspace,
    run(['pack', '--pack-destination', workspace], repoRoot).split('\n').pop().trim(),
  );
  check('npm pack produced a tarball', existsSync(tarball), relative(workspace, tarball));

  console.log('Installing the tarball into a clean directory...');
  run(['init', '-y'], installDir);
  run(['install', tarball, '--no-audit', '--no-fund'], installDir);

  const packageDir = join(installDir, 'node_modules', 'threadshelf');
  const bin = join(
    installDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'threadshelf.cmd' : 'threadshelf',
  );
  check('the threadshelf bin was linked', existsSync(bin));

  for (const asset of [
    ['public', 'index.html'],
    ['dist', 'src', 'server.js'],
    ['dist', 'mcp', 'server.js'],
    ['scripts', 'openrouter-export-browser.js'],
  ]) {
    check(`shipped: ${asset.join('/')}`, existsSync(join(packageDir, ...asset)));
  }
  check('no TypeScript sources shipped', !existsSync(join(packageDir, 'src')));
  check('no tests shipped', !existsSync(join(packageDir, 'test')));

  const filesBeforeRun = await listFiles(packageDir);

  const port = 3900 + Math.floor(Math.random() * 90);
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = [];

  console.log(`Starting the installed CLI on ${baseUrl} from an unrelated directory...`);
  const child = spawn(bin, [String(port)], {
    cwd: cwdDir,
    shell: process.platform === 'win32',
    env: { ...process.env, THREADSHELF_DATA_DIR: dataDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => log.push(String(chunk)));
  child.stderr.on('data', (chunk) => log.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, log);
    check('CLI starts and answers /api/health', true);

    const index = await get(`${baseUrl}/`);
    check(
      'serves the built UI',
      index.status === 200 && index.body.includes('<div id="root">'),
      `status ${index.status}`,
    );

    const assets = await readdir(join(packageDir, 'public', 'assets'));
    const bundle = assets.find((name) => name.endsWith('.js'));
    check(
      'serves the built client bundle',
      (await get(`${baseUrl}/assets/${bundle}`)).status === 200,
      bundle,
    );

    const exporter = await get(`${baseUrl}/scripts/openrouter-export-browser.js`);
    check('serves the browser export scripts', exporter.status === 200);

    const collections = await get(`${baseUrl}/api/collections`);
    check('API responds', collections.status === 200, collections.body.slice(0, 80));
  } finally {
    await stopChild(child);
  }

  // A compiled CLI that ships without a reachable entry point is invisible to
  // every other check here, so exercise the dispatch itself.

  // The MCP server has no usage output, so speak the protocol at it: one
  // initialize request on stdin should come back with a serverInfo result.
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify', version: '1' },
    },
  });
  const mcp = spawnSync(bin, ['mcp'], {
    cwd: cwdDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, THREADSHELF_DATA_DIR: dataDir },
    input: `${initialize}\n`,
  });
  check(
    'subcommand reachable: mcp',
    (mcp.stdout || '').includes('"serverInfo"'),
    (mcp.stdout || '').slice(0, 60),
  );

  // Running each of the others with no arguments prints its usage, which also
  // proves the usage text names the npx invocation rather than `npm run`.
  for (const subcommand of ['parse', 'ingest', 'search']) {
    const result = spawnSync(bin, [subcommand], {
      cwd: cwdDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, THREADSHELF_DATA_DIR: dataDir },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    check(
      `subcommand reachable: ${subcommand}`,
      output.includes(`npx threadshelf ${subcommand}`),
      output.split('\n')[0]?.slice(0, 70),
    );
  }

  check(
    'persistent data landed in the data directory',
    existsSync(join(dataDir, 'lancedb')),
    join(dataDir, 'lancedb'),
  );

  const added = (await listFiles(packageDir)).filter((file) => !filesBeforeRun.includes(file));
  check('nothing was written into the installed package', added.length === 0, added.join(', '));

  const strays = await readdir(cwdDir);
  check(
    'nothing was written into the working directory',
    strays.length === 0,
    strays.join(', ') || 'clean',
  );
};

const workspace = await mkdtemp(join(tmpdir(), 'threadshelf-verify-'));
try {
  await verify(workspace);
} finally {
  // On Windows the shell wrapper that launched the CLI keeps a handle on its
  // working directory for a moment after exit, so a straight rmdir can fail
  // with EBUSY. Cleanup of a temp directory is housekeeping, never a reason to
  // fail a verification run that already passed.
  try {
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`Could not remove ${workspace}: ${error.message}`);
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error(`Package verification failed: ${failed.map((entry) => entry.name).join(', ')}`);
  process.exitCode = 1;
}
