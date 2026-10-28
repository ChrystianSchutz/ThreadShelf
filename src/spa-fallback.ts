import type { RequestHandler } from 'express';

/**
 * Serves the UI's `index.html` for client-side routes such as `/settings`.
 * `root` limits send's dotfile check to the file name: the package itself may
 * live under a dot directory (npx's `~/.npm/_npx` cache, a `.claude` worktree),
 * and an absolute path there would be refused as a dotfile.
 */
export const spaFallback =
  (publicDir: string): RequestHandler =>
  (_req, res, next) => {
    res.sendFile('index.html', { root: publicDir }, (err) => {
      if (err) next(err);
    });
  };
