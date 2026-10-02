import './env.js';
import express from 'express';
import { join } from 'path';
import apiRouter from './routes/index.js';
import { requireLocalOrigin } from './routes/local-origin.js';
import { createLocalApiRouter } from './routes/local-api.js';
import { startLocalApiNetworkListener } from './local-api-network.js';
import { dataDir, packagePath } from './paths.js';
import { startIndexRecovery } from './store.js';

const app = express();
// Mounted ahead of the app-wide body parser: inference requests carry whole
// conversations (and base64 images), so /v1 parses JSON with its own limit.
app.use('/v1', createLocalApiRouter('local'));
app.use(express.json({ limit: '512kb' }));

// Package assets resolve against the installed module, never process.cwd():
// `npx threadshelf` runs from whatever directory the user happens to be in.
const PUBLIC = packagePath('public');
app.use(express.static(PUBLIC));
// Serve the browser-console export scripts so the UI can offer a "copy script"
// button (e.g. the OpenRouter exporter). Read-only static files.
app.use('/scripts', express.static(packagePath('scripts')));

app.use('/api', requireLocalOrigin);

app.use(apiRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get(/.*/, (_req, res, next) => {
  res.sendFile(join(PUBLIC, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Express error', err);
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err?.message || 'Server error' });
});

const portArg = process.argv[2];
const PORT = Number(portArg ?? process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  startIndexRecovery();
  void startLocalApiNetworkListener(PORT);
  console.log(`Server: http://localhost:${PORT}`);
  console.log('Data directory:', dataDir());
});
