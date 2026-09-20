import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  dataDir,
  dataPath,
  invocation,
  isRepoCheckout,
  packagePath,
  packageRoot,
  userDataDir,
} from '../src/paths.js';

const originalDataDir = process.env.THREADSHELF_DATA_DIR;

const restoreEnv = () => {
  if (originalDataDir === undefined) delete process.env.THREADSHELF_DATA_DIR;
  else process.env.THREADSHELF_DATA_DIR = originalDataDir;
};

const sampleRoot = () => (process.platform === 'win32' ? 'D:\\shelf-data' : '/var/shelf-data');

describe('userDataDir', () => {
  it('uses LOCALAPPDATA\\ThreadShelf on Windows', () => {
    assert.equal(
      userDataDir(
        { LOCALAPPDATA: 'D:\\Users\\example\\AppData\\Local' },
        'win32',
        'D:\\Users\\example',
      ),
      join('D:\\Users\\example\\AppData\\Local', 'ThreadShelf'),
    );
  });

  it('falls back to the home AppData path when LOCALAPPDATA is unavailable', () => {
    assert.equal(
      userDataDir({}, 'win32', 'D:\\Users\\example'),
      join('D:\\Users\\example', 'AppData', 'Local', 'ThreadShelf'),
    );
  });

  it('ignores a blank LOCALAPPDATA', () => {
    assert.equal(
      userDataDir({ LOCALAPPDATA: '   ' }, 'win32', 'D:\\Users\\example'),
      join('D:\\Users\\example', 'AppData', 'Local', 'ThreadShelf'),
    );
  });

  it('uses ~/.threadshelf on Linux and macOS', () => {
    assert.equal(userDataDir({}, 'linux', '/home/example'), join('/home/example', '.threadshelf'));
    assert.equal(
      userDataDir({}, 'darwin', '/Users/example'),
      join('/Users/example', '.threadshelf'),
    );
  });

  it('never points inside the installed package', () => {
    const outside = userDataDir({ LOCALAPPDATA: 'D:\\Local' }, 'win32', 'D:\\Users\\example');
    assert.ok(!outside.startsWith(packageRoot()));
  });
});

describe('package assets', () => {
  it('resolves against the module, not the working directory', () => {
    assert.ok(isAbsolute(packageRoot()));
    assert.equal(packagePath('public', 'index.html'), join(packageRoot(), 'public', 'index.html'));
    assert.ok(existsSync(join(packageRoot(), 'package.json')));
  });

  it('detects a repository checkout', () => {
    assert.equal(isRepoCheckout(), true);
  });
});

describe('invocation', () => {
  it('names the form that applies to the caller', () => {
    // A checkout is what the test suite runs from; the published package
    // reports the npx form instead.
    assert.equal(invocation('search'), 'npm run search --');
  });
});

describe('dataPath', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('keeps the historical repo layout when run from a checkout', () => {
    delete process.env.THREADSHELF_DATA_DIR;
    assert.equal(dataDir(), packageRoot());
    assert.equal(dataPath('lancedb'), join(packageRoot(), '.lancedb'));
    assert.equal(dataPath('collections'), join(packageRoot(), '.collections.json'));
    assert.equal(
      dataPath('masterPrompts'),
      join(packageRoot(), '.threadshelf', 'master-prompts.json'),
    );
  });

  it('uses a flat layout under an explicit THREADSHELF_DATA_DIR', () => {
    const root = sampleRoot();
    process.env.THREADSHELF_DATA_DIR = root;
    assert.equal(dataDir(), root);
    assert.equal(dataPath('lancedb'), join(root, 'lancedb'));
    assert.equal(dataPath('collections'), join(root, 'collections.json'));
    assert.equal(dataPath('masterPrompts'), join(root, 'master-prompts.json'));
    assert.equal(dataPath('uploads'), join(root, 'uploads'));
    assert.equal(dataPath('modelCache'), join(root, 'model-cache'));
  });

  it('keeps every persistent path under the data directory', () => {
    const root = sampleRoot();
    process.env.THREADSHELF_DATA_DIR = root;
    const keys = [
      'lancedb',
      'uploads',
      'collections',
      'generationConfig',
      'masterPrompts',
      'generationErrorLog',
      'models',
      'tools',
      'modelCache',
      'env',
    ];
    for (const key of keys) {
      assert.ok(dataPath(key).startsWith(root), `${key} escaped the data directory`);
    }
  });
});
