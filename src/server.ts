import './env.js';
import express from 'express';
import { join } from 'path';
import apiRouter from './routes/index.js';
import { dataDir, packagePath } from './paths.js';
import { startIndexRecovery } from './store.js';

const app = express();
app.use(express.json({ limit: '512kb' }));

// Package assets resolve against the installed module, never process.cwd():
// `npx threadshelf` runs from whatever directory the user happens to be in.
const PUBLIC = packagePath('public');
app.use(express.static(PUBLIC));
// Serve the browser-console export scripts so the UI can offer a "copy script"
// button (e.g. the OpenRouter exporter). Read-only static files.
app.use('/scripts', express.static(packagePath('scripts')));

const normalizeRequestHost = (value: string | undefined): string => {
  const host = String(value || '')
    .trim()
    .toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) return host.replace(/]:\d+$/, ']').replace(/^\[(.*)]$/, '$1');
  return host.replace(/:\d+$/, '');
};

const localHosts = (): Set<string> => {
  const configuredHost = normalizeRequestHost(process.env.HOST || '127.0.0.1');
  const configuredAllowedHosts = (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => normalizeRequestHost(host))
    .filter(Boolean);
  return new Set(
    ['localhost', '127.0.0.1', '::1', configuredHost, ...configuredAllowedHosts].filter(
      (host) => host && host !== '0.0.0.0' && host !== '::',
    ),
  );
};

app.use('/api', (req, res, next) => {
  const allowedHosts = localHosts();
  const host = normalizeRequestHost(req.headers.host);
  if (!allowedHosts.has(host)) {
    return res.status(403).json({ error: 'Forbidden host' });
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      const originHost = normalizeRequestHost(new URL(origin).host);
      if (!allowedHosts.has(originHost)) {
        return res.status(403).json({ error: 'Forbidden origin' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid origin' });
    }
  }

  next();
});

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
  console.log(`Server: http://localhost:${PORT}`);
  console.log('Data directory:', dataDir());
});
