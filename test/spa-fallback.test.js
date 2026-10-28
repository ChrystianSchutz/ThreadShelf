import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { spaFallback } from '../src/spa-fallback.ts';

describe('SPA fallback', () => {
  let root;
  let server;
  let baseUrl;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'threadshelf-spa-'));
    // Same shape as npx's cache: the package lives below a dot directory.
    const publicDir = join(root, '.npm', '_npx', 'abc', 'node_modules', 'threadshelf', 'public');
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>ThreadShelf</title>');
    const app = express();
    app.get(/.*/, spaFallback(publicDir));
    app.use((err, _req, res, _next) => {
      res.status(err.status ?? 500).send(err.message);
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it('serves index.html for deep links when the package sits under a dot directory', async () => {
    for (const path of ['/settings', '/chat/abc', '/']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /<title>ThreadShelf<\/title>/, path);
    }
  });
});
