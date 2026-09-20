import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for "where does ThreadShelf read and write things".
 *
 * Two kinds of location, deliberately kept apart:
 *
 * - **Package files** (built UI, browser export scripts) live next to the
 *   installed module and are resolved from `import.meta.url`. They must never
 *   be resolved from `process.cwd()`: `npx threadshelf` runs with the user's
 *   shell directory as cwd, which has nothing to do with the package.
 * - **Persistent user data** (LanceDB, uploads, collections, generation config)
 *   lives outside the package entirely. An npm/npx install directory is
 *   disposable — npm may wipe its `_npx` cache at any time — so nothing the
 *   user cares about may be stored there.
 *
 * Running from a repository checkout keeps the historical repo-local layout so
 * development and the existing test harness are unaffected.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * This module lives at `<root>/src/paths.ts` in development and at
 * `<root>/dist/src/paths.js` once compiled, so the package root is one or two
 * levels up depending on which copy is running.
 *
 * The two cases are told apart by which candidate holds the manifest, not by
 * the directory being named `dist`: a repository cloned into a directory that
 * happens to be called `dist` would fool a name check and send every path one
 * level too high. The build must therefore keep `dist/` free of a stray
 * `package.json` — `test/packaging.test.js` asserts that.
 */
const resolvePackageRoot = (dir: string): string => {
  const parent = dirname(dir);
  return existsSync(join(parent, 'package.json')) ? parent : dirname(parent);
};

const PACKAGE_ROOT = resolvePackageRoot(moduleDir);

/** Root of the installed package (or the repo in development). Static assets only. */
export const packageRoot = (): string => PACKAGE_ROOT;

/** Path to a file shipped inside the package, e.g. the built UI or an export script. */
export const packagePath = (...segments: string[]): string => join(PACKAGE_ROOT, ...segments);

/**
 * True when running from a source checkout rather than an installed package.
 * The published tarball ships `dist/` and never `src/`, so an end user's
 * install cannot be mistaken for a checkout. The whole directory is the marker
 * rather than one file inside it, so renaming or splitting an entry point
 * cannot silently move every developer's data out of their repository.
 */
export const isRepoCheckout = (): boolean => existsSync(join(PACKAGE_ROOT, 'src'));

/** Per-user data directory for an installed package. */
export const userDataDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return join(localAppData || join(home, 'AppData', 'Local'), 'ThreadShelf');
  }
  return join(home, '.threadshelf');
};

const explicitDataDir = (): string => process.env.THREADSHELF_DATA_DIR?.trim() || '';

/** Whether persistent files use the repo-local dotfile layout or the flat user-data layout. */
const useRepoLayout = (): boolean => !explicitDataDir() && isRepoCheckout();

/** Root directory for everything persistent. Never inside the package for an installed copy. */
export const dataDir = (): string =>
  resolve(explicitDataDir() || (isRepoCheckout() ? PACKAGE_ROOT : userDataDir()));

/**
 * Repo layout keeps the dotfile names the project has always used; the
 * user-data layout drops the dots because the directory is already dedicated.
 */
const LAYOUT = {
  lancedb: { repo: ['.lancedb'], user: ['lancedb'] },
  uploads: { repo: ['.uploads'], user: ['uploads'] },
  collections: { repo: ['.collections.json'], user: ['collections.json'] },
  generationConfig: { repo: ['.threadshelf', 'generation.json'], user: ['generation.json'] },
  masterPrompts: { repo: ['.threadshelf', 'master-prompts.json'], user: ['master-prompts.json'] },
  generationErrorLog: {
    repo: ['.threadshelf', 'generation-errors.log'],
    user: ['generation-errors.log'],
  },
  models: { repo: ['.threadshelf', 'models'], user: ['models'] },
  tools: { repo: ['.threadshelf', 'tools'], user: ['tools'] },
  modelCache: { repo: ['.threadshelf', 'model-cache'], user: ['model-cache'] },
  env: { repo: ['.env'], user: ['.env'] },
} as const;

export type DataKey = keyof typeof LAYOUT;

/**
 * How the user would invoke one of the bundled CLIs, for usage messages.
 * `npm run search --` is right from a clone and meaningless to somebody who
 * installed the package, so print whichever actually applies.
 */
export const invocation = (command: string): string =>
  isRepoCheckout() ? `npm run ${command} --` : `npx threadshelf ${command}`;

/** Absolute path of a persistent file or directory. Callers still apply their own env overrides. */
export const dataPath = (key: DataKey): string => {
  const entry = LAYOUT[key];
  return resolve(dataDir(), ...(useRepoLayout() ? entry.repo : entry.user));
};
