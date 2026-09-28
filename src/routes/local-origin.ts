import type { Request, RequestHandler } from 'express';

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

/**
 * Why a request must be refused as not addressed to this local server, or
 * undefined when it is acceptable. Checking `Host` and `Origin` defeats DNS
 * rebinding and cross-site pages driving the API from a user's browser.
 */
export const localOriginRejection = (req: Request): string | undefined => {
  const allowedHosts = localHosts();
  if (!allowedHosts.has(normalizeRequestHost(req.headers.host))) return 'Forbidden host';

  const origin = req.headers.origin;
  if (!origin) return undefined;
  try {
    const originHost = normalizeRequestHost(new URL(origin).host);
    return allowedHosts.has(originHost) ? undefined : 'Forbidden origin';
  } catch {
    return 'Invalid origin';
  }
};

export const requireLocalOrigin: RequestHandler = (req, res, next) => {
  const rejection = localOriginRejection(req);
  if (rejection) {
    res.status(403).json({ error: rejection });
    return;
  }
  next();
};
