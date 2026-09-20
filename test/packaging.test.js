import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../src/paths.js';

const root = packageRoot();
const readPackageJson = async () => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

describe('npm package manifest', () => {
  it('is publishable and exposes the threadshelf bin', async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.private, undefined, 'private:true would block npm publish');
    assert.equal(pkg.name, 'threadshelf');
    assert.equal(pkg.bin.threadshelf, './bin/threadshelf.js');
    assert.equal(pkg.bin['threadshelf-mcp'], './bin/threadshelf-mcp.js');
    for (const entry of Object.values(pkg.bin)) {
      assert.ok(existsSync(join(root, entry)), `missing bin file ${entry}`);
    }
  });

  it('allow-lists the runtime assets and nothing else', async () => {
    const pkg = await readPackageJson();
    for (const required of ['bin/', 'dist/', 'public/']) {
      assert.ok(pkg.files.includes(required), `files must include ${required}`);
    }
    const forbidden = ['src/', 'test/', 'client/', '.env', '.lancedb/', 'docs/', 'TODO.md'];
    for (const entry of forbidden) {
      assert.ok(!pkg.files.includes(entry), `files must not include ${entry}`);
    }
  });

  it('builds the distributable JavaScript through prepack', async () => {
    const pkg = await readPackageJson();
    assert.match(pkg.scripts.prepack, /build:package/);
    assert.match(pkg.scripts['build:server'], /tsc -p tsconfig\.build\.json/);
    assert.match(pkg.scripts['build:package'], /build:client/);
  });

  it('does not need tsx or typescript at runtime', async () => {
    const pkg = await readPackageJson();
    assert.ok(!Object.keys(pkg.dependencies).includes('tsx'));
    assert.ok(!Object.keys(pkg.dependencies).includes('typescript'));
    for (const entry of Object.values(pkg.bin)) {
      const source = await readFile(join(root, entry), 'utf8');
      assert.ok(!/\.ts['"]/.test(source), `${entry} must not import TypeScript sources`);
      assert.ok(source.startsWith('#!/usr/bin/env node'), `${entry} needs a node shebang`);
    }
  });
});

describe('bundled CLIs', () => {
  it('exposes every compiled CLI through a subcommand', async () => {
    const cli = await readFile(join(root, 'bin', 'threadshelf.js'), 'utf8');
    for (const [subcommand, entry] of [
      ['parse', 'dist/src/cli.js'],
      ['ingest', 'dist/src/ingest-cli.js'],
      ['search', 'dist/src/search-cli.js'],
    ]) {
      assert.ok(
        cli.includes(`${subcommand}: '../${entry}'`),
        `bin/threadshelf.js must dispatch "${subcommand}" to ${entry}`,
      );
    }
  });

  it('dispatches mcp explicitly rather than through an entrypoint guess', async () => {
    // dist/mcp/server.js self-starts only when it believes it is the process
    // entry point, and that comparison is brittle on Windows, so the
    // subcommand must call runServer() itself.
    const cli = await readFile(join(root, 'bin', 'threadshelf.js'), 'utf8');
    assert.match(cli, /arg === 'mcp'/);
    assert.match(cli, /dist\/mcp\/server\.js/);
    assert.match(cli, /runServer\(\)/);
  });

  it('has a source for every subcommand, and ships the build output', async () => {
    // Assert on the sources, not on dist/: `npm test` runs before any build in
    // `npm run check`, and a fresh clone has no dist/ at all. Whether the build
    // actually emitted these files belongs to the "compiled distribution"
    // suite below, which skips when dist/ is absent.
    const pkg = await readPackageJson();
    assert.ok(pkg.files.includes('dist/'));
    for (const source of ['cli.ts', 'ingest-cli.ts', 'search-cli.ts']) {
      assert.ok(existsSync(join(root, 'src', source)), `src/${source} is missing`);
    }
  });
});

describe('runtime filesystem discipline', () => {
  // Match the extension each tree is actually written in. Scanning for .js
  // under src/ would also pick up stale output from an older build config and
  // fail the guard on a file nobody ships.
  const listSources = async (dir, extension) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return listSources(full, extension);
        return entry.isFile() && entry.name.endsWith(extension) ? [full] : [];
      }),
    );
    return files.flat();
  };

  /**
   * Blank out comments rather than skipping whole files. Several of these
   * modules explain in prose why process.cwd() is wrong here, and an earlier
   * version of this guard exempted src/paths.ts outright to tolerate that —
   * which also exempted the one file most able to break every path at once.
   */
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/\/\/.*$/gm, '');

  it('never resolves persistent or package paths from process.cwd()', async () => {
    // bin/ is the npx entry point, so it matters at least as much as src/.
    const sources = [
      ...(await listSources(join(root, 'src'), '.ts')),
      ...(await listSources(join(root, 'mcp'), '.ts')),
      ...(await listSources(join(root, 'bin'), '.js')),
    ];
    assert.ok(
      sources.some((file) => file.includes(`${sep}bin${sep}`)),
      'the scan must cover bin/',
    );
    assert.ok(
      sources.some((file) => file.endsWith('paths.ts')),
      'the scan must cover src/paths.ts',
    );

    const offenders = [];
    for (const file of sources) {
      const lines = stripComments(await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (line.includes('process.cwd()')) offenders.push(`${relative(root, file)}:${index + 1}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `process.cwd() is unsafe for npx installs: ${offenders.join(', ')}`,
    );
  });
});

describe('compiled distribution', () => {
  const distPaths = join(root, 'dist', 'src', 'paths.js');

  it('keeps dist/ free of a stray package.json', () => {
    // src/paths.ts finds the package root by looking for the manifest, so a
    // package.json emitted into dist/ (a JSON import is enough to cause one)
    // would silently anchor every package path at dist/ instead.
    assert.ok(
      !existsSync(join(root, 'dist', 'package.json')),
      'dist/package.json would shadow the real package root',
    );
  });

  it('emits every entry point the bin files import', async (t) => {
    if (!existsSync(distPaths)) {
      t.skip('dist/ is not built; npm run build:server covers this');
      return;
    }
    for (const entry of [
      ['src', 'server.js'],
      ['src', 'cli.js'],
      ['src', 'ingest-cli.js'],
      ['src', 'search-cli.js'],
      ['mcp', 'server.js'],
    ]) {
      assert.ok(existsSync(join(root, 'dist', ...entry)), `dist/${entry.join('/')} is missing`);
    }
  });

  it('resolves the same paths once compiled', async (t) => {
    if (!existsSync(distPaths)) {
      t.skip('dist/ is not built; npm run build:server covers this');
      return;
    }
    // npm test runs the TypeScript sources through tsx, so without this the
    // compiled copy that the published package actually executes is only ever
    // exercised by the five-minute pack:verify run.
    const compiled = await import(pathToFileURL(distPaths).href);
    assert.equal(compiled.packageRoot(), packageRoot());
    assert.equal(compiled.isRepoCheckout(), true);
    assert.equal(compiled.dataPath('lancedb'), join(root, '.lancedb'));
    assert.equal(compiled.invocation('search'), 'npm run search --');
  });
});
