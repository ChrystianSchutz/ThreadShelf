# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this
repository. Humans should read this too — it is the short, accurate map of the
project. `CLAUDE.md` simply points here so Claude Code picks up the same rules.

## What this project is

**ThreadShelf** — a local, offline semantic-search and backup tool for AI chat
exports (Google AI Studio, OpenRouter, OpenAI/ChatGPT, Anthropic/Claude, LM Studio,
Grok/xAI). It
parses exported JSON into normalized turns, chunks and embeds them locally
(Xenova/Transformers.js), stores vectors in LanceDB, and exposes search through a
React web UI, an HTTP API, and an MCP stdio server.

Parsing, embeddings, storage, and search run on the user's machine. **By default,
no chat data leaves the device.** The embedding model may be downloaded on first use.
Treat all real chat exports as private.

The optional conversation-generation layer is **Experimental Alpha**. Its
primary `llama.cpp` engine is local and loopback-only. OpenRouter is an explicit,
opt-in external exception: picking the OpenRouter provider tab sends selected
user/assistant thread content, the optional master prompt, and the new prompt
off-device; archived thinking is excluded. There is no longer a per-send consent
checkbox — the `off-device` chip on the model button and the composer hint carry
that signal. New chats are saved locally by default in the protected
`threadshelf_conversations` collection and semantic index. The explicit
ghost-icon private mode is tab-scoped and never persisted.

The **master prompt** is a small collection of user-written system prompts. They
are hand-written and expected to last, so they are stored server-side in
`.threadshelf/master-prompts.json` (`src/generation/master-prompts.ts`, atomic
write, mode 0600, `MASTER_PROMPTS_PATH` override) and served by the loopback-only
`/api/generation/prompts` CRUD routes. The client holds no copy beyond the
react-query cache (`['master-prompts']`). The active prompt is sent as
`systemPrompt` on every generation request and prepended as a leading `system`
message; it is never persisted into a stored thread, so re-reading a chat never
replays a prompt the user has since changed.

## Repository layout

```
src/                Server + core logic (TypeScript, ESM, run via tsx)
  server.ts         Express app entrypoint
  env.ts            Startup loader for the optional, gitignored root `.env`
  load-env.ts       Testable `.env` loading helper (explicit process env wins)
  cli.ts            `npm run parse` CLI
  parser.ts         Provider detection + export -> normalized turns
  chunking.ts       Turn -> embeddable chunks
  embedding.ts      Local Xenova embeddings
  model-label.ts    Portable model labels (strip private local filesystem prefixes)
  ingest.ts         Parse -> chunk -> embed -> store pipeline
  watch.ts          Watch-folder mode (fs.watch + debounced re-ingest)
  store.ts          LanceDB access
  validation.ts     Turn/types + input validation
  routes/           HTTP routes (health, search, thread, collections, files, ingest, insights)
  services/         search, thread, collections, insights business logic
  generation/       Experimental Alpha provider plugins, config, model discovery, llama wrapper
    downloader.ts          Shared resumable, hash-verifying downloader (runtime + models)
    model-catalog.ts       Read-only Hugging Face GGUF browser (public API, no token)
    model-download.ts      Plans and fetches catalog models into the download directory
    hardware.ts            Accelerator/RAM detection and the model "will it fit" verdict
    quick-setup.ts         One-screen setup plan (runtime + model) and its runner
    master-prompts.ts      User system prompts on disk (.threadshelf/master-prompts.json)
    error-log.ts           Optional rotating generation errors (.threadshelf/generation-errors.log)
    filesystem-browser.ts  Loopback-only, directory-only model-root browser
client/             React + Vite + TypeScript web UI (npm workspace)
  src/              Components, pages, store (zustand), queries (react-query)
    components/ModelCombobox.tsx  Searchable generation models + local favorites
    components/ModelCatalogModal.tsx  Hugging Face model browser (search, gating, VRAM fit)
    components/QuickSetupPanel.tsx    One-confirmation llama.cpp + model install
    components/NumberCombobox.tsx Typeable token-budget dropdown (presets + free entry)
    components/MasterPromptMenu.tsx  Master-prompt editor (server-stored, sent with every request)
    components/NotFound.tsx       Router `defaultNotFoundComponent` for unknown URLs
mcp/server.ts       MCP stdio server exposing local search
test/               Node test runner unit tests + fixtures/
  e2e/              API + MCP end-to-end tests (boot a real server)
  playwright/       Browser E2E (see "Known gaps")
docs/               Architecture, getting started, MCP, etc.
public/             Built UI output — GENERATED, do not edit by hand
```

The repo is an **npm workspaces** monorepo: the root and `client/` share a single
`package-lock.json` and a hoisted `node_modules/`. A plain `npm install` at the
root installs both.

## Commands

| Command                                              | Use                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm install`                                        | Install server + client deps (workspaces).                                              |
| `npm start`                                          | Run server on :3000 (`npm start -- 3001` for another port).                             |
| `npm run dev`                                        | Server with watch mode.                                                                 |
| `npm run dev:client`                                 | Vite dev server (UI hot reload on :5173, API proxied to :3000).                         |
| `npm run build:client`                               | Build the UI into `public/`.                                                            |
| `npm run docs:screenshots`                           | Generate README screenshots from repo-safe mock data into `docs/assets/`.               |
| `npm test`                                           | Fast unit/regression tests (node test runner via tsx).                                  |
| `npm run test:e2e`                                   | API + MCP E2E (spawns a temp server + temp LanceDB).                                    |
| `npm run test:playwright`                            | Browser E2E (needs Playwright browsers).                                                |
| `npm run check:repo`                                 | Reject private artifacts, secrets, and user-specific home paths from commit candidates. |
| `npm run lint`                                       | ESLint over `src/` and `mcp/`.                                                          |
| `npm run check`                                      | repo hygiene + lint + tsc + unit + API/MCP E2E + client build + Playwright. Full gate.  |
| `npm run parse -- <file> -- [flags]`                 | Parse one export to normalized JSON; the second `--` is required before flags.          |
| `npm run ingest -- <folder> [collection] -- [flags]` | Ingest a folder (`--clear`; `--watch`; `--debounce`).                                   |
| `npm run search -- "<query>" -- [flags]`             | Search from the CLI (`--mode keyword`, `--collection`, `--n`, `--json`).                |
| `npm run setup:llama`                                | Local discovery only; `-- -- --check` reads metadata; install needs explicit consent.   |

**Before opening a PR / finishing a task, run `npm run check`.** If you only
touched the parser/ingest/search, `npm test && npm run test:e2e` is the minimum.

## Conventions

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), Node 20.19+. Server
  code runs directly through `tsx` — there is no separate server build step.
- **Imports:** use `.js` extensions in relative imports (ESM + tsx requirement),
  e.g. `import { Turn } from './validation.js'`.
- **Style:** Prettier + ESLint are the source of truth. Run `npm run format`
  rather than hand-formatting. Match the surrounding functional style in `src/`
  (small pure functions, `readonly` types, no classes for parsing logic).
- **UI type scale:** small labels use the `--fs-micro` (11px) / `--fs-meta`
  (11.5px) tokens from `_tokens.scss` — do not hand-pick sizes below them. The
  UI is dense with mono metadata, and anything smaller stops being readable.
  Titles wrap and also carry the full value in a `title` attribute; only
  secondary metadata may ellipsise, and it must keep the `title` attribute too.
- **Narrow-screen text:** wrapping text that can contain unbreakable tokens
  (URLs, long file names) uses `overflow-wrap: anywhere`, **not** `break-word` —
  only `anywhere` lowers the intrinsic min-content width, so `break-word` still
  lets one long token widen its container. Grid rows that hold such text use
  `minmax(0, 1fr)` tracks; a bare `1fr` cannot shrink below min-content and the
  content escapes the card. `test/playwright/result-title.spec.js` guards both.
- **No new runtime dependencies** without a clear reason — a goal of the project
  is to stay light and fully local. Never add anything that phones home.

## Data model (mental model)

```
JSON export -> parser (detectProvider) -> normalized Turn[]
            -> chunking -> local embeddings -> LanceDB collection
            -> UI / HTTP API / MCP search

stored thread -> generation registry -> llama.cpp (local) OR OpenRouter (external, explicit consent)
                                      -> provider SSE -> NDJSON progress/token stream -> UI
```

- A **Turn** is one of `{ user }`, `{ thinking }`, or `{ ai }` (+ optional
  `model`, `createdAt`). See `src/validation.ts`.
- A **collection** is a LanceDB table (think folder/project: `chatgpt`,
  `work_2026`). Table names starting with `__` are internal — `__threads`
  stores normalized turns per `(collection, sourceFile, conversationKey)` so
  thread view and `/api/files` survive moved/rewritten/deleted source files.
- A **thread** is the full source conversation reconstructed around a search
  hit — served from `__threads` first, falling back to re-parsing the source
  file for collections indexed before threads storage existed.
- A **ThreadShelf-created chat** is also normalized into turns, but is stored in
  the protected `threadshelf_conversations` collection with
  `createdInThreadShelf: true`. It has no fake export file. Completed exchanges
  and imported-thread continuations are persisted by `src/generation/threads.ts`
  and only their ThreadShelf-authored chunks are refreshed in semantic search.
- Supported providers live in `src/parser.ts` (`detectProvider`): `google-ai-studio`,
  `anthropic`, `openai`, `openrouter`, `lm-studio`, `grok`. Adding a provider = add a detector + a
  `build…Conversations` function + a fixture + tests.

## Privacy & git hygiene (important)

- **Never commit real chat exports, `.lancedb/`, `.uploads/`, `.collections.json`,
  `.threadshelf/`, logs, or anything under `DO_NOT_COMMIT/`, `private/`, `exports/`.** These are
  already in `.gitignore` — do not weaken those rules.
- `.gitignore` ignores `*.json` by default and re-allows specific files
  (`package.json`, fixtures, configs). When you add a JSON file that _should_ be
  tracked, add a matching `!` allow-rule.
- Test fixtures in `test/fixtures/` are **synthetic and anonymized**. If a real
  export breaks parsing, reproduce it with a tiny anonymized fixture of the same
  shape — never paste real content.
- Before a public push, verify the intended release branch contains only public
  files and run `npm run check:repo`; never assume `.gitignore` can protect data
  that was already added to a commit.

## Testing

Three layers, all runnable offline:

1. **Unit / logic** — `test/*.test.js` (node:test via tsx). Fast, deterministic,
   no server. Parser, chunking, validation, etc. Run with `npm test`.
2. **API + MCP E2E** — `test/e2e/*.test.js`. `startApiServer` (in
   `test/e2e/helpers.js`) spawns a real `src/server.ts` on a random port with an
   **isolated temp LanceDB + uploads dir**, then drives it over HTTP
   (`ingestViaNdjson`, `/api/search`, …). The MCP test spawns the stdio server.
   Run with `npm run test:e2e`.
3. **Browser E2E** — `test/playwright/*.spec.js` + `test/playwright/fixtures.js`.
   Each worker boots a server (serving the built UI from `public/`) with isolated
   storage, ingests the bundled fixtures into a `pw_fixture` collection, then
   tests the real UI (search, thread reader, role filters). Run with
   `npm run test:playwright`. **Requires** `npm run build:client` first and
   `npx playwright install chromium`.

Test commands must be shell-independent on Windows and Linux and work on the
minimum supported Node.js version. Do not rely on shell glob expansion in npm
scripts; enumerate matching files in JavaScript and pass them as explicit
arguments. Tests for `Intl` date/time output must not assume a locale-specific
field order, punctuation, prefix relationship, or time zone. Compare against an
equivalently configured formatter or inspect `formatToParts()`; set an explicit
locale or time zone only when that behavior is what the test is meant to verify.

### Rules for E2E

- Never point E2E at a user's real LanceDB/uploads — always use the temp dirs the
  helpers create. They are removed on teardown. Any script that spawns
  `src/server.ts` must also set `COLLECTIONS_PATH` (the manual-collections
  registry defaults to `.collections.json` in the cwd and would otherwise be
  shared across servers and polluted with test collections).
- `test/shared/helpers.js` builds the "mixed folder" from `test/fixtures/*.json`
  (one subfolder per provider). E2E and Playwright import that helper, so add new
  provider fixtures there once.
- UI selectors are stable IDs/classes (`#searchInput`, `#collection-<name>`,
  `.result`, `#threadOverlay`, `#threadContent`). Prefer those over text matches.
- Embeddings run locally; the first E2E run downloads the model and is slow.
  Subsequent runs are cached.

### Adding a provider (checklist)

1. Detector + `build…Conversations` in `src/parser.ts` (+ `parse<Provider>` export
   and a `Provider` union entry).
2. Anonymized snapshot fixture in `test/fixtures/`.
3. Case in `test/fixtures.test.js` and a `detectProvider` assertion in
   `test/parser-more.test.js`.
4. Add the fixture to the mixed folder provider list in `test/shared/helpers.js`.
5. Add UI provider metadata in `client/src/constants.ts`, provider color tokens
   in `client/src/styles/_tokens.scss`, and IndexingView support copy.
6. Document it in `README.md` and `docs/ARCHITECTURE.md` (incl. a "tested on version X, format not
   guaranteed" note for undocumented formats — AI Studio, OpenRouter, LM Studio).

## External network surfaces

Three, all opt-in and none of them carrying chat content:

1. **OpenRouter** — the only surface that sends conversation text off-device.
2. **GitHub Releases** (`ggml-org/llama.cpp`) — release metadata; archives only
   after explicit `--install`/`--url` consent or the setup screen's confirmation.
   Upstream's `/releases/latest` points at a semver release with no binaries, so
   `resolveLlamaRelease` follows the `nightly-tag.txt` pointer to the real
   `bNNNNN` build. `GITHUB_TOKEN` raises the anonymous rate limit.
3. **Hugging Face Hub** — catalog metadata and GGUF downloads. The public API
   needs no token; `HF_TOKEN` is only required for *gated* repositories, which
   are detected up front and marked in the UI. Every file is verified against the
   LFS `oid` (its SHA-256) before it is moved into place.

Model downloads land in `downloadDirectory` (default `.threadshelf/models`,
override `THREADSHELF_MODELS_PATH`), which is always part of
`effectiveModelDirectories` so discovery finds them without extra configuration.

## Known gaps (as of this writing)

- Real-data, per-provider validation is still being built out (see
  `docs/REAL_DATA_TESTING.md`). Fixtures are synthetic snapshots, not full
  coverage of every export quirk.
- Undocumented formats (Google AI Studio, OpenRouter, LM Studio) have no schema
  contract; a vendor update can break parsing. Keep version notes in README.

When you finish a task, update this file if you changed commands, layout, or
conventions.
