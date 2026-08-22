# Changelog

All notable changes to ThreadShelf are documented here.

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
