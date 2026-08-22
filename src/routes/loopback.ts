import type { RequestHandler } from 'express';
import { isLoopbackRequest } from '../generation/filesystem-browser.js';

/**
 * Local generation controls — installing runtimes, browsing the filesystem,
 * downloading models — are never exposed beyond the machine running the server.
 */
export const requireLoopback: RequestHandler = (req, res, next) => {
  const forwardedFor = [req.headers['x-forwarded-for'], req.headers['x-real-ip']]
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .map(String);
  if (
    !isLoopbackRequest(req.socket.remoteAddress, forwardedFor, req.headers.forwarded, req.hostname)
  ) {
    res.status(403).json({ error: 'Local generation controls are available only from localhost' });
    return;
  }
  next();
};
