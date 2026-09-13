# Experimental Beta: conversation generation

Conversation generation is an opt-in **Experimental Beta**. It adds a plugin
contract above two engines:

- `llama.cpp`, the primary and local engine;
- OpenRouter, an optional external API.

**New chat** creates a locally saved ThreadShelf conversation by default. A
separate ghost-icon action starts a **Private conversation** whose history exists
only in browser `sessionStorage`, is never written to LanceDB or `__threads`, and
is removed when the tab session ends. Original export files are never modified.

## Privacy boundary

Archive ingestion, embeddings, storage, search, and `llama.cpp` inference stay
local. The OpenRouter option is different: selecting the
**OpenRouter · external** tab is the explicit off-device choice. The model button
shows an `off-device` chip and the composer repeats that boundary. Sending then
transmits the selected archive's or created chat's complete `user` and
`assistant` turns plus the prompt to OpenRouter. Imported and locally generated
`thinking` turns are deliberately omitted.

Two further network surfaces exist, and neither carries conversation content:

- **GitHub Releases** (`ggml-org/llama.cpp`) — release metadata; archives only
  after an explicit `--install`/`--url` or a confirmed setup plan.
- **Hugging Face Hub** — catalog metadata and GGUF downloads, on request.

Both are opt-in, both are described below, and neither sees a single turn of a
conversation.

## Created chats

The **New chat** action opens a saved-by-default draft without creating an empty
database row. The first send materializes the server-side conversation. The
adjacent ghost icon is the explicit private alternative; its ephemeral generation
request accepts bounded browser-session history but returns no persistence status
and emits no `saving` phase. For a saved chat, the server:

1. loads the saved turns instead of trusting browser-supplied history;
2. acquires a per-chat generation lease so two responses cannot overwrite one
   another;
3. streams tokens to the browser;
4. updates the stored row under the thread-store write lock only after generation
   completes.

Stopped, failed, and partial responses are not stored. Provider reasoning is
stored locally as a `thinking` turn when returned, displayed behind a disclosure,
and excluded from subsequent provider prompts. Saved chats live in the
**ThreadShelf conversations** collection (`threadshelf_conversations`) and in
the normalized `__threads` store; they do not create fake export files. They can
be deleted individually together with their generated search chunks. Collection
UI counts these rows as conversations, including saved chats with zero chunks.
Entering the Chats page leaves the global Search/Insights collection unchanged.
The files API unions normalized thread rows with legacy chunk-only sources, so an
empty chat appears immediately before its first embedding exists. Chat rows and
headers display the most recently used model; an empty chat explicitly says that
no model has been used yet.

The response limit defaults to 4,096 tokens. Its numeric field suggests common
presets while accepting custom whole values up to the smaller of the known model
context window and the API safety cap of 32,768 tokens.

Completed ThreadShelf questions, reasoning, and answers are embedded locally.
Only ThreadShelf-authored chunks are replaced during a retry, so imported chunks
are not re-embedded. Imported-thread continuations remain in their original
collection. Per-turn `createdInThreadShelf`, backend, model, and timestamp fields
drive the restrained emerald provenance marker and the **All / ThreadShelf /
Clean archive** origin filter. Only mixed imported threads show the ThreadShelf
checkbox; created chats do not repeat their origin or model on every message.

Restrictive OpenRouter routing is off by default so ordinary models do not fail
with "No endpoints found matching your data policy". The compact send area has a
per-request **ZDR-only routing** option, and Settings can enable it as a saved
default. When selected, the request adds:

```json
{
  "provider": {
    "zdr": true
  }
}
```

Data-collection denial is a separate, opt-in saved setting. These constraints
reduce the eligible routes and do not turn an external request
into a local one. Review the current [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection),
[Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr), and
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
documentation before sending private material.

Generation config schema 2 changes both routing restrictions to opt-in. Older,
unversioned config files created while these flags defaulted to `true` are migrated
to `false`; a user can explicitly enable either policy again in Settings.

## Guided setup

**Settings → Conversation generation → Set up local generation** resolves one
plan covering both halves of a first run — a `llama.cpp` build for the detected
platform/accelerator and a GGUF model sized for it — and shows every URL,
SHA-256 digest, size, and destination before anything is fetched. One
confirmation runs the plan; Cancel aborts an in-flight transfer.

Two properties make that single button press safe:

- The plan is rebuilt **server-side** on `POST /api/generation/setup/run`. The
  client sends a variant, model id, quantization, and release tag — never a URL
  to fetch and execute.
- The rebuilt plan is compared against `quickSetupFingerprint`, the digest of
  exactly what the user approved (versions, digests, sizes). A mismatch — a
  moved nightly build, a changed catalog, a different VRAM reading — returns
  `409` with the new plan instead of downloading something else.

A step whose artifact is already present is reported as `reuse` rather than
`download`, so re-running setup after a partial run does not refetch what is
there.

## llama.cpp discovery and installation

ThreadShelf looks for `llama-server` in configured environment variables, `PATH`,
and `.threadshelf/tools`. Run local-only discovery with:

```bash
npm run setup:llama
```

`--check` requests release metadata from GitHub but does not download an archive:

```bash
npm run setup:llama -- -- --check
```

An official install always selects the current GitHub release at runtime rather
than relying on a stale hard-coded version. It requires typed confirmation or
the explicit non-interactive `--yes`, verifies GitHub's published SHA-256, and
stores the upstream MIT license and source metadata with the binary:

```bash
npm run setup:llama -- -- --install
npm run setup:llama -- -- --install --yes
```

The default CPU build is the broadest compatibility choice. macOS builds use
Metal automatically. Optional `vulkan`, `cuda`, `rocm`, and `sycl` release
variants require compatible host drivers/runtimes. Official Linux assets target
Ubuntu-compatible systems; use a trusted custom build or compile from source on
incompatible distributions.

Official variants install side-by-side (`<release>-cpu`, `<release>-vulkan`,
etc.). Installing an accelerator variant does not replace a working CPU build;
select its printed executable path in Settings.

### Updating llama.cpp

Nothing is pinned. ThreadShelf follows the latest **stable** upstream release
(`/releases/latest`, e.g. `v0.4.0`) to the `bNNNNN` build it points at, rather than
chasing the newest nightly. Nothing updates automatically:

```bash
npm run setup:llama -- -- --check --variant cuda   # compares installed vs latest stable
npm run setup:llama -- -- --install --variant cuda # installs the new build side by side
```

`--check` prints either `Installed managed build b10809-cuda is up to date.` or
`Update available: <installed> → <latest>` with the exact install command.
Autodiscovery prefers the highest build number, so the new build is used after the
next model load unless `LLAMA_CPP_SERVER`, `LLAMA_SERVER_PATH`, or the Settings path
point elsewhere. Older build directories are kept; delete them manually once the new
build works. `--release bNNNNN` pins a specific build when a regression appears.

On Windows, official CUDA builds require both the `llama-...cuda...zip` server
archive and its matching `cudart-...zip` runtime archive. ThreadShelf downloads
and verifies both after explicit CUDA install approval. Re-running the CUDA install
repairs a matching existing managed directory by adding missing runtime files only.
Managed autodiscovery prefers the newest release, then an accelerator build for an
equal release; `LLAMA_CPP_SERVER`, `LLAMA_SERVER_PATH`, and the Settings path retain
explicit priority.

A custom URL is explicit download consent:

```bash
npm run setup:llama -- -- --url https://host/build.zip --sha256 64_HEX_DIGEST --tag my-build
```

Only `.zip`, `.tar.gz`, and `.tgz` archives are accepted. A missing custom
checksum produces a warning. Nothing in this flow downloads a GGUF model.

### How a release is resolved

Upstream publishes stable semver releases (`v0.2.0`) that carry **no binaries**
and mark the nightly build in a `nightly-tag.txt` asset, while the archives live
in `bNNNNN` releases flagged as pre-releases. GitHub's `/releases/latest`
therefore points at a release with nothing to install. `resolveLlamaRelease`
follows the `nightly-tag.txt` pointer to the real build and falls back to a scan
of recent releases if that asset is missing or malformed. An explicit `--tag`
pins the lookup and is rejected if that release carries no llama.cpp binaries.

Release metadata is fetched anonymously. Set `GITHUB_TOKEN` (or `GH_TOKEN`) to
raise the rate limit; a limited response reports that explicitly instead of
failing opaquely.

Upstream references: [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases),
[MIT license](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE), and
[`llama-server` documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## Model discovery

The server recursively discovers `.gguf` files under configured roots. It skips
`mmproj` projector files and all but the first file of a multi-shard model. Default
roots include:

- `~/.lmstudio/models` and `~/.lmstudio`;
- `~/.cache/lm-studio/models`;
- `~/.cache/llama.cpp`;
- `~/.cache/huggingface/hub`;
- roots from `LLAMA_MODEL_PATHS`.

This includes `%USERPROFILE%\.lmstudio` on Windows. Add or remove custom paths
from **Settings → Conversation generation**. Symbolic-link directories are not
followed during recursive scans. Set
`THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS=1` when only explicitly configured roots
should be scanned. Default and environment-derived roots are returned separately
from editable roots and are never copied into `.threadshelf/generation.json` by a
settings save.

OpenRouter models are queried live from `/api/v1/models`; ThreadShelf does not
ship a model allowlist that will become stale.

The searchable model combobox stores favorites in the current browser's
localStorage (separately for llama.cpp and OpenRouter) and keeps them at the top.
OpenRouter sorting is delegated to the documented server-side `sort` parameter:
`most-popular` uses tokens processed in the last week and `newest` uses the
catalog addition date. **Free only** retains `:free`, `openrouter/free`, and
zero-priced catalog entries. Availability and rate limits can still change.

References: [OpenRouter model sorting](https://openrouter.ai/docs/guides/overview/models),
[free variants](https://openrouter.ai/docs/guides/routing/model-variants/free).

## Model catalog and downloads

The catalog is a read-only browser over the **public** Hugging Face API
(`https://huggingface.co`). It lists GGUF repositories, their quantizations, file
sizes, licence, and context length. No token is needed for public repositories;
requests are cached briefly and time out rather than hanging.

Each quantization carries a server-side fit verdict from `judgeFit`, so the UI
and the setup plan always agree on one answer:

| Verdict     | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `fits`      | Within the detected accelerator budget.                       |
| `tight`     | Above that budget but within system RAM headroom; partly CPU. |
| `too-large` | Beyond RAM headroom.                                          |

Repositories from `unsloth`, `lmstudio-community`, `bartowski`, `ggml-org`,
`Qwen`, `google`, and `mistralai` are flagged as known publishers. The flag is
informational; it grants no extra trust to the download path.

Downloads land in `downloadDirectory` — `.threadshelf/models` by default,
override with `THREADSHELF_MODELS_PATH`. That directory is always part of
`effectiveModelDirectories`, so a downloaded model is discoverable without any
further configuration, and it is gitignored.

Every file is fetched by the shared resumable downloader and verified against the
repository's LFS `oid` (its SHA-256) **before** it is moved into place. A
cancelled transfer keeps its `.part` file so the next attempt resumes; any other
failure deletes it.

Gated repositories are detected up front, marked in the UI, and refused with a
clear message unless `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) is set in the
server `.env` — accept the repository's licence on Hugging Face first. When a
token is configured it is sent with every Hugging Face request; without one,
public repositories still work.

Both streaming routes (`/catalog/download`, `/setup/run`) are wrapped in
`abortOnDisconnect`. Listening only for `req`'s `aborted` is not enough: a
browser cancelling a `fetch` fires `res`'s `close`, and missing it leaves the
server downloading gigabytes after the user pressed Cancel.

No conversation content is ever sent to Hugging Face — only catalog metadata
requests and file downloads.

## OpenRouter API key

For a key that survives server restarts, copy `.env.example` to `.env` and set:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-your-key
```

ThreadShelf loads the root `.env` when the server starts. Variables explicitly
set by the parent process take precedence, so deployment secrets can still be
injected normally. The `.env` file is gitignored; never commit it.

A key entered in Settings overrides the environment key for the current server
process only. It is not written to `.threadshelf/generation.json`. Neither the
UI key nor the environment key is included in API responses; the API exposes
only the `apiKeyConfigured` boolean. Restart the server after editing `.env`.

## Runtime behavior

When no existing llama.cpp URL is configured, ThreadShelf launches one managed
`llama-server` for the selected GGUF file, binds it to `127.0.0.1` on an ephemeral
port, waits for health, and stops it when switching models or stopping the app.
The executable name is restricted to `llama-server` (`llama-server.exe` on
Windows), and selected models must come from configured discovery roots.

An existing server may be configured with `LLAMA_CPP_BASE_URL` or the Settings
UI, but only loopback hosts are accepted. Its live `/v1/models` response is used.
While a managed model is serving one or more chats, a request for a different
GGUF receives HTTP 409 instead of stopping the process underneath an active stream.

### Acceleration profiles

Settings exposes common profiles while persisting explicit values:

- **Auto-fit (recommended):** `--n-gpu-layers auto --fit on`;
- **CPU only:** `--n-gpu-layers 0`;
- **Single GPU:** the maximum safe automatic offload to one selected GPU;
- **CPU + GPU:** an exact number of offloaded layers;
- **Multi-GPU:** all possible layers with `layer` or `row` splitting and optional
  per-GPU proportions.

CPU threads, context presets, main GPU, and Flash Attention remain separately
configurable. GPU profiles require an upstream build compatible with the host
(CUDA, Vulkan, ROCm, SYCL, or Metal). Current flag semantics come from the
[llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#common-params).
Before launching a managed process, ThreadShelf reads `llama-server --help`.
Builds that predate `--fit`, `--n-gpu-layers auto`, or the three-state
`--flash-attn` option receive the older compatible form (`--n-gpu-layers 999`
and no unsupported automatic flags). Explicit CPU mode remains the broadest
compatibility option.

For modern builds, Auto, Single GPU, and Multi-GPU profiles use
`--n-gpu-layers auto --fit on`. This lets llama.cpp reduce offload instead of
forcing an avoidable out-of-memory failure when the model and context do not fit
entirely in VRAM. An explicit hybrid layer count remains explicit.

### Performance tuning

Three Settings selects cover the runtime options that matter most for modern
models such as Qwen3.8-27B on a 24 GB GPU. They change speed and memory only;
temperature, top-p, and top-k are never altered by these presets.

| Setting | Options (default first) | llama-server flags |
| --- | --- | --- |
| KV cache | Quality · Memory saver · Default | `-ctk q8_0 -ctv q8_0` · `q4_0/q4_0` · none (f16) |
| Speculative decoding (MTP) | Auto · Aggressive · Off | `--spec-type draft-mtp --spec-draft-n-max 2` · `3` · none |
| Reasoning effort | Medium · Low · High · XHigh · Off · Template default | `--reasoning-effort <level>` · `--reasoning off` |

Every option is gated before launch, so an unsupported choice is skipped and
logged instead of preventing startup:

- **Runtime capabilities** come from `llama-server --help` (`--cache-type-k`, the
  `--spec-type` value list, `--reasoning-effort`, `--parallel`).
- **Model capabilities** come from the GGUF header, not the file name
  (`src/generation/gguf-metadata.ts`). MTP is used only when
  `<arch>.nextn_predict_layers` is at least 1; Qwen3.8-27B reports 1, Gemma 4 reports none.
- **KV cache pairs are symmetric only.** Stock CUDA builds compile Flash Attention
  kernels for `q8_0/q8_0` and `q4_0/q4_0`; mixed pairs can fall back to slow paths.
  A quantized cache turns Flash Attention on (it is required) and is skipped when
  Flash Attention is explicitly Off.
- `--parallel 1` is always passed when supported: a local single-user server
  should not split memory across idle slots. Concurrent chats on one model queue.

Context presets label 32K as recommended for 24 GB GPUs and 128K/262K as
experimental; sizes above 64K show a warning because current CUDA builds have
reported severe decode slowdowns at very long positions. Environment overrides:
`LLAMA_CPP_KV_CACHE`, `LLAMA_CPP_SPECULATIVE`, `LLAMA_CPP_REASONING_EFFORT`.

The launch log contains a resolved profile line, for example:

```text
[ThreadShelf] Runtime profile for qwen35: ctx 64K (settings) · FA on (threadshelf: required by
the quantized KV cache) · KV q8_0×q8_0 (settings) · MTP 2 (settings: 1 NextN layer(s) in the
GGUF) · reasoning medium (settings) · slots 1 (threadshelf: single local user; concurrent chats queue)
```

The detailed Settings badge shows the applied values as one status line
(`GPU · CUDA · ctx 64K · FA on · KV q8_0×q8_0 · MTP 2 · … · GPU weights 15.8 GiB`),
with skipped options and their reasons in its tooltip.

ThreadShelf runs `llama-server --list-devices` and uses the memory values reported
by llama.cpp. The response panel labels actual placement as CPU, GPU, or hybrid by
parsing llama.cpp's `offloaded X/Y layers to GPU` output; where available, per-device
model-buffer sizes are also shown. If the selected GGUF file is larger than total
reported free VRAM, the UI warns before generation. File size is only a conservative
preflight signal because context/KV and compute buffers also consume memory. If an
older/custom executable does not expose device memory, ThreadShelf reports the
diagnostic as unavailable rather than guessing.

The expandable **llama.cpp process logs** panel contains the exact managed launch
command and captured stdout/stderr. Logs are retained for the latest managed process,
including after eject; the oldest output is truncated only after 4 MiB and the UI
marks that condition. Logs of an independently managed external server are not
available to ThreadShelf.
They intentionally do not record prompts, generated answers, or reasoning:
llama.cpp returns those through the separate HTTP stream, and silently duplicating
private chat content into a process log would be surprising.

Invalid `LLAMA_CPP_*` tuning overrides are logged with their environment-variable
name and ignored in favor of the saved value or built-in default. A typo therefore
does not make the generation settings and status endpoints unavailable.

The system-folder picker lists directories only and is available only when the
browser connects from loopback. This avoids exposing filesystem names over an
optional LAN binding. It never uploads or modifies a selected directory.

The continuation UI selects the active loaded model ahead of discovery order and
distinguishes discovered models from the active model. A
local model marked **Selected · loads on send** is a GGUF file found on disk but
not yet in memory; **Loaded now** means the managed llama-server is ready with
that model. Runtime feedback follows these phases:

1. loading the archived thread or locally saved ThreadShelf chat;
2. loading the local GGUF or connecting to OpenRouter;
3. processing the prompt after the model is ready, then streaming generated tokens;
4. completion, error, or user cancellation.

The sidebar and Settings runtime badge additionally says **CPU**, **GPU** with the
detected backend (CUDA, Vulkan, Metal, or SYCL), or **Hybrid** with the GPU offload
percentage. The adjacent `?` tooltip contains the exact selected executable and npm
install commands for CPU/CUDA/Vulkan. A CUDA-named directory is not enough to claim
GPU use: the badge relies on devices and actual offload reported by llama.cpp.

Upstream OpenAI-compatible SSE is parsed by the provider wrapper and forwarded
to the browser as NDJSON. Content and available reasoning deltas are displayed
incrementally. The completed response retains usage metadata when the provider
supplies it. llama.cpp `timings.predicted_per_second` is exposed as output
`tok/s`; when a compatible endpoint omits timings but reports completion tokens,
ThreadShelf labels a wall-clock fallback as measured throughput.

For a managed llama.cpp process, ThreadShelf passes the configured context as
`--ctx-size` and reports that effective value back from the running process.
The response limit is configured separately in the chat details: it defaults to
4,096 tokens for the default 8K window instead of silently imposing a 1,024-token
cap. Each completed answer shows the provider-reported prompt and answer token
counts, total context used, remaining context, and `tok/s` when those values are
available. External llama.cpp servers can omit their effective window, in which
case the UI labels it unknown rather than guessing.

Streamed output uses immutable display blocks: only the current final block is
updated, so selecting or copying earlier text is not disrupted by every token.
There is also a **Copy current output** action during generation. If the backend
exits, the stream fails, or the user presses Stop, ThreadShelf keeps the prompt,
partial answer, and partial reasoning in a tab-session recovery card. Recovery
cards are explicitly **not saved**, are excluded from later model context and
LanceDB, and can be copied, dismissed, or restored to the composer with **Retry
prompt**. They disappear when the tab session ends.

## HTTP API

All routes are **Experimental Beta**:

- `GET /api/generation/hardware` — detected accelerators, RAM, and model budget;
- `GET /api/generation/catalog/search?q=&sort=downloads|likes|trending|recent&limit=&author=` — Hugging Face GGUF search plus the hardware profile;
- `GET /api/generation/catalog/model?id=<owner/repo>` — one repository, its quantizations with fit verdicts, and whether a token is configured;
- `POST /api/generation/catalog/download` — NDJSON `plan`, `progress`, `done`, and `error` events; cancelling the request aborts the transfer;
- `GET /api/generation/setup/plan?variant=&model=&quant=` — the resolved one-click plan and its fingerprint;
- `POST /api/generation/setup/run` — runs a plan; requires `confirm: true` and the approved `fingerprint`, returns `409` with a new plan on mismatch;
- `GET /api/generation/config` — redacted settings and provider availability;
- `PUT /api/generation/config` — update paths, privacy flags, and a session key;
- `GET /api/generation/models?provider=llama-cpp|openrouter` — dynamic models and runtime state;
- `GET /api/generation/runtime` — current backend and loaded model;
- `GET /api/generation/runtime/logs` — localhost-only llama.cpp process/device diagnostics;
- `POST /api/generation/runtime/eject` — unload memory, never delete GGUF files;
- `GET /api/generation/directories` — localhost-only directory browser;
- `/api/generation/prompts` CRUD plus active selection — localhost-only master prompts;
- `GET /api/generation/threads` — list chats created in ThreadShelf;
- `POST /api/generation/threads` — create and persist a new local chat;
- `GET /api/generation/threads/:id` — load one local chat and its turns;
- `PATCH /api/generation/threads/:id` — rename a saved local chat;
- `DELETE /api/generation/threads/:id` — delete one saved chat and its chunks;
- `POST /api/generation/chat` — non-streaming compatibility route;
- `POST /api/generation/chat/stream` — NDJSON status, delta, done, and error events.

The directory browser, config/model discovery, every created-chat route, and
every mutating generation route (`PUT /config`, eject, and both chat routes)
require a direct loopback
client. Forwarded client-address headers and the request hostname are also checked, so a normal reverse proxy on
the same machine does not turn these controls into a remote API. A proxy must not
erase all client-address metadata and rewrite an external hostname to a loopback
literal. This remains true when the main read/search UI is intentionally exposed
with `HOST` and `ALLOWED_HOSTS`. Executable and model paths supplied through the
API also reject UNC/network paths.

Managed GGUF processes use a filename-only `--alias`; provider responses and
legacy read paths normalize absolute GGUF values before turns, search results, or
exports leave the backend. Active generation leases also block eject and llama
configuration transitions with HTTP 409. Stored-archive continuations re-read and
merge the latest row under the thread-store write lock. Failed semantic indexing
is retried in-process with bounded exponential backoff.

Example continuation:

```json
{
  "provider": "llama-cpp",
  "model": "C:\\models\\model.Q4_K_M.gguf",
  "sourceFile": "C:\\exports\\thread.json",
  "collection": "lmstudio",
  "conversationKey": "optional-key",
  "prompt": "Continue from here",
  "continuation": []
}
```

Example send within a created chat (history is loaded on the server):

```json
{
  "provider": "llama-cpp",
  "model": "C:\\models\\model.Q4_K_M.gguf",
  "threadId": "00000000-0000-4000-8000-000000000000",
  "prompt": "Start from first principles"
}
```

Example anonymous send (history remains browser-session data and is not stored):

```json
{
  "provider": "llama-cpp",
  "model": "C:\\models\\model.Q4_K_M.gguf",
  "ephemeral": true,
  "continuation": [],
  "prompt": "Start from first principles"
}
```

The route reloads the indexed thread on the server and validates that the source
belongs to the selected collection. Request size, message count, temperature,
token count, paths, and provider IDs are bounded.

## Known Beta limitations

- One managed local model is active at a time; a different model cannot load until
  all active chats using the current model finish.
- Ejecting an existing external llama.cpp server requires its `/models/unload`
  endpoint and a model reported by `/v1/models`; managed ThreadShelf servers are
  always supported.
- Prompt fit and final truncation are still delegated to the selected
  model/server; ThreadShelf now exposes the managed window, answer cap, and
  provider-reported usage separately.
- GPU compatibility depends on upstream release artifacts and local drivers.
- A failed embedding update does not discard the saved exchange; the response
  reports a local indexing warning so it can be retried.
