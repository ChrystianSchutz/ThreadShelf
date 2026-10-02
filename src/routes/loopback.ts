import type { Request, RequestHandler } from 'express';
import { isLoopbackRequest } from '../generation/filesystem-browser.js';

/** True when the request, and every proxy hop it names, comes from this machine. */
export const isLoopbackHttpRequest = (req: Request): boolean => {
  const forwardedFor = [req.headers['x-forwarded-for'], req.headers['x-real-ip']]
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .map(String);
  return isLoopbackRequest(
    req.socket.remoteAddress,
    forwardedFor,
    req.headers.forwarded,
    req.hostname,
  );
};

/**
 * Local generation controls — installing runtimes, browsing the filesystem,
 * downloading models — are never exposed beyond the machine running the server.
 */
export const requireLoopback: RequestHandler = (req, res, next) => {
  if (!isLoopbackHttpRequest(req)) {
    res.status(403).json({ error: 'Local generation controls are available only from localhost' });
    return;
  }
  next();
};
