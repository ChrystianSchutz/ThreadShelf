import type { Request, Response } from 'express';

/**
 * Aborts long-running streamed work when the client goes away.
 *
 * Both events are needed: `req`'s `aborted` covers a dropped connection, while
 * `res`'s `close` is what actually fires when a browser stops reading a streamed
 * response (an `AbortController` on the fetch caller). Listening to only one of
 * them leaves the server downloading gigabytes after the user pressed Cancel.
 */
export const abortOnDisconnect = (
  req: Request,
  res: Response,
  message = 'Client disconnected',
): AbortController => {
  const controller = new AbortController();
  const stop = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException(message, 'AbortError'));
    }
  };
  req.once('aborted', stop);
  res.once('close', () => {
    if (!res.writableEnded) stop();
  });
  return controller;
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
