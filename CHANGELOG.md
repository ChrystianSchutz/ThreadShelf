# Changelog

All notable changes to ThreadShelf are documented here.

## 1.2.3 — 2026-09-20

### Fixed

- Stop `test/packaging.test.js` asserting that `dist/` is built. `npm test`
  runs before `build:client` in `npm run check`, and a fresh clone has no
  `dist/` at all, so the check failed on CI and on any machine that had not
  already built. The emitted-file assertions moved into the suite that skips
  when `dist/` is absent, and the `process.cwd()` guard is now scoped by
  extension per tree (`.ts` under `src/` and `mcp/`, `.js` under `bin/`) so
  stale build output cannot fail it.

The published package is unchanged from 1.2.2: both fixes are to test files,
which the `files` allow-list does not ship.

## 1.2.2 — 2026-09-20

### Packaging review follow-ups

- Resolve the package root by looking for the manifest rather than for a
  directory named `dist`, so a repository cloned into a directory called `dist`
  no longer anchors every path one level too high. `dist/` must stay free of a
  stray `package.json` for this, which `test/packaging.test.js` now asserts.
- Detect a checkout by the presence of `src/` rather than of `src/server.ts`,
  so renaming or splitting an entry point cannot silently move a developer's
  archive out of the repository.
- Add `npx threadshelf mcp` next to the existing `threadshelf-mcp` executable.
  It starts the server explicitly instead of relying on the MCP module's own
  entry-point detection, which compares URLs in a way that is fragile on
  Windows.
- Widen the `process.cwd()` guard in `test/packaging.test.js` to cover `bin/`
  (the npx entry point) and `src/paths.ts`. It previously scanned only `.ts`
  files and exempted `paths.ts` outright, so it would have passed while the two
  files most able to break every path did the wrong thing.
- Exercise the compiled `dist/src/paths.js` from `npm test`, and the `mcp`
  subcommand from `npm run pack:verify`. Both were previously covered only by
  the five-minute packaging run, or not at all.

## 1.2.1 — 2026-09-20

### Install with `npx threadshelf`

- Publish ThreadShelf to npm as the unscoped `threadshelf` package, with the
  prebuilt web UI included. `npx threadshelf` downloads, starts and serves on
  <http://localhost:3000> with no clone and no build step.
- Add the `threadshelf` and `threadshelf-mcp` executables. Both are plain
  JavaScript and run the compiled server in `dist/`, so the published package
  needs neither `tsx` nor `typescript` at runtime.
- Compile the server and MCP server to distributable JavaScript
  (`tsconfig.build.json`), wired into `prepack` so a published tarball can never
  contain a stale build. `files` is an allow-list: no sources, tests, docs
  screenshots, `.env` or user data are published.
- Separate application files from persistent data. Package assets now resolve
  against the installed module instead of `process.cwd()`, which was wrong for
  any `npx` run, and persistent data moves out of the disposable install
  directory into a per-user location: `%LOCALAPPDATA%\ThreadShelf` on Windows,
  `~/.threadshelf` on macOS and Linux. Clearing the npm cache or upgrading no
  longer risks the archive.
- Cache the downloaded embedding model with the user's data rather than inside
  `node_modules`, so an `npx` upgrade does not re-download it.
- Add `THREADSHELF_DATA_DIR` / `--data-dir` to relocate everything, and
  `--where` to print the resolved package and data directories. The existing
  narrower overrides (`LANCEDB_PATH`, `UPLOADS_DIR`, `COLLECTIONS_PATH`,
  `MASTER_PROMPTS_PATH`, …) continue to take precedence.
- A repository checkout keeps the previous repo-local layout, so development and
  the existing test harness are unchanged.
- Add `npm run pack:verify`: packs the tarball, installs it into a temporary
  directory, boots the CLI from an unrelated working directory and asserts that
  the UI is served, data lands in the data directory, and nothing is written
  into the package or the working directory.
- Add `.github/workflows/publish.yml`: tag-driven release on `v*` that runs the
  test suite and publishes through npm Trusted Publishing (OIDC), with no npm
  token stored in the repository.
- Reach the bundled CLIs from an installed package:
  `npx threadshelf search|ingest|parse`. They were compiled into the tarball but
  had no entry point, so only a clone could run them. Their usage messages now
  name the invocation that applies — `npm run search --` from a checkout,
  `npx threadshelf search` from an install.

## 1.2.0 — 2026-09-13

### Archive durability

- Replace imported and ThreadShelf-authored rows with a single LanceDB merge
  commit instead of delete-then-add, so a failed write no longer leaves a thread
  or collection half-deleted.
- Keep local continuations when an export is imported again, including branches
  whose conversation key disappeared or was rewritten; exports that parse to zero
  conversations are skipped and never delete archived rows.
- `clearFirst` stages the whole folder and its embeddings before committing. An
  invalid or empty file, or a cancellation, keeps the old collection and reports
  `replacementSkipped` ("Nothing was saved…") instead of an empty collection.
- Track pending index work durably in `__threads.indexPending`. The HTTP server,
  the MCP server and the `ingest`/`search` CLIs recover it on start, with
  15 s–1 h backoff, a pause after 8 failures, and quarantine of undecodable rows
  that keeps their raw data.
- Embed outside the global thread-table lock and re-check the snapshot before
  committing, so a long import no longer blocks saving a chat answer elsewhere.
- Rename changes only the title, and appending an answer reads the current turns
  under the lock, so neither can overwrite the other.
- Open LanceDB with `readConsistencyInterval: 0`, so the server, MCP and CLIs see
  each other's commits.
- Share one embedding model load between concurrent callers and log its progress
  to stderr, keeping the MCP stdout protocol clean.
- Report embedding progress per batch during indexing instead of stalling at 100%.

### llama.cpp performance tuning

- New Settings for the KV cache (Quality Q8 / Memory saver Q4 / F16), MTP
  speculative decoding (Auto draft 2 / Aggressive draft 3 / Off) and reasoning
  effort. Each option is applied only when `llama-server --help` and the GGUF
  header support it, and is otherwise logged as skipped with a reason.
- Read GGUF metadata (architecture, native context, NextN/MTP layers) with a
  bounded, cached header parser instead of guessing from file names.
- Run a single server slot (`--parallel 1`) so concurrent local chats queue.
- Show the effective runtime profile in the llama.cpp log and the Settings
  status badge, with skip reasons in its tooltip; warn above 64K context.
- `setup:llama --check` compares an installed managed build with the latest
  stable release and prints the update command for the installed variant.

### Tests

- Archive recovery regressions (`test/archive-recovery.test.js`), a fake
  `llama-server` E2E for launch flags, diagnostics and restart on settings
  change, GGUF parser hardening and cache tests, `setup:llama --check` output,
  and Playwright coverage for the tuning settings and runtime badge.

## 1.1.0 — 2026-08-22

### Guided setup and model catalog

- Resolve `llama.cpp` and a fitting GGUF model in one plan, showing every URL,
  digest, size, and destination before a single confirmation runs it.
- Browse Hugging Face GGUF repositories read-only over the public API: search,
  popularity, per-quantization sizes, shard grouping, and multimodal projectors.
  No account or token is needed for public repositories.
- Judge memory fit server-side from detected VRAM/RAM, so the catalog, the setup
  plan, and the UI agree on one fits/tight/too-large verdict per quantization.
- Detect gated repositories up front and mark them in the UI, reporting a missing
  `HF_TOKEN` before a download starts rather than as a 401 midway.
- Download models into `downloadDirectory` (default `.threadshelf/models`,
  override `THREADSHELF_MODELS_PATH`), always part of the searched model roots so
  a new model appears without further configuration.
- Open the catalog from Settings or the chat model menu; a freshly downloaded
  model is selected automatically.

### llama.cpp release resolution

- Follow the upstream `nightly-tag.txt` pointer to the release that actually
  carries binaries. Upstream's move to semver releases had made every install and
  `--check` fail with "No official binary exists in release v0.2.0".
- Pin an exact upstream build with `--release bNNNNN`.
- Sort accelerator assets by toolkit version, so `cuda-13.3` wins over
  `cuda-12.4` instead of losing an alphabetical comparison.
- Raise the anonymous GitHub API rate limit with `GITHUB_TOKEN`/`GH_TOKEN`, and
  report clearly when the limit is hit.
- Treat reinstalling an identical build as a no-op instead of an error.

### Downloads and consent

- Share one resumable, hash-verifying downloader between runtime archives and
  models, computing the digest in the same pass as the write instead of reading a
  large archive back off disk. Range-based resume, retry with backoff, and a
  stall timeout are built in; a digest mismatch deletes the partial file so it
  can never poison a later resume.
- Make Cancel actually cancel. The streamed routes now watch the response's
  `close` as well as the request's `aborted`, so a cancelled browser fetch stops
  the transfer instead of leaving the server downloading in the background.
- Keep the `.part` file of a cancelled transfer so the next attempt resumes;
  only a genuine failure deletes it. Interrupted runtime installs resume too.
- Bind a setup run to the plan the user approved. Plans carry a fingerprint of
  versions, digests, and sizes; the server re-resolves everything itself and
  returns `409` with the replacement plan when that fingerprint moved.
- Report an already-installed model as reuse rather than offering it as a fresh
  multi-gigabyte download.

### Fixes

- Restore model roots on other Windows drives: `path.relative()` between drives
  returns an absolute path with no `..` prefix, which the containment check read
  as nested and silently dropped.
- Rank automatic quantization choice by quality tier rather than size, so a
  legacy `Q4_1` no longer beats `Q4_K_M`, and `Q8_0` is no longer misread as
  legacy.
- Read the `gated` flag from expanded Hub responses; list responses omit it,
  which would have left the gating warning permanently invisible.
- Match runtime data roots by glob in `.gitignore` and `check-repo-hygiene.ts`. A
  130 MB `.threadshelf-demo/` LanceDB tree had reached the index because the rule
  was exactly `.threadshelf/`.
- Point the repository, homepage, issue, and CI badge links at
  `ChrystianSchutz/ThreadShelf`.

## 1.0.0 — 2026-07-26

Initial public release.

### Archive and search

- Normalize exports from Google AI Studio, ChatGPT/OpenAI, Claude/Anthropic,
  OpenRouter, LM Studio, and Grok/xAI.
- Generate multilingual embeddings locally and store vectors plus normalized
  thread snapshots in LanceDB.
- Search semantically or by exact substring, filter roles/dates/models/origin,
  browse complete conversations, pin threads, and save searches.
- Ingest from the UI or CLI, including cancellable runs and watch-folder mode.
- Query the same local index through the HTTP API, CLI, or MCP stdio server.

### Experimental generation

- Start local chats or continue imported threads through managed, loopback-only
  `llama.cpp` with streamed output and runtime diagnostics.
- Optionally use the clearly marked external OpenRouter provider with live model
  discovery and routing controls.
- Persist completed chats locally by default; provide a separate tab-scoped
  private mode and unsaved recovery cards for failed/stopped streams.

### Safety and quality

- Keep generation control, filesystem browsing, and saved-chat routes
  loopback-only.
- Store OpenRouter session keys in process memory and exclude archived thinking
  from provider context.
- Cover parser, API, MCP, production UI, repository hygiene, and documentation
  links in the automated test gate.
