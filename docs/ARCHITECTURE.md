# Architecture

ThreadShelf is intentionally small: one Node.js server, reusable core modules,
local embedding, local vector storage, and a React browser UI.

Conversation generation is a separately marked **Experimental Alpha**. The
`llama.cpp` path is local; the explicitly selected OpenRouter path is external.

## High-Level Flow

```text
Export folder
  -> src/ingest.ts
  -> src/parser.ts
  -> src/chunking.ts
  -> src/embedding.ts
  -> src/store.ts
  -> LanceDB
  -> src/server.ts API
  -> public/ UI
  -> mcp/server.ts

Indexed thread -> generation provider registry -> llama.cpp loopback OR OpenRouter
Created chat -> internal __threads namespace -> generation provider -> persisted exchange
```

## Modules

`src/server.ts`

- Express app.
- Serves the web UI.
- Exposes collection, ingest, search, thread, upload, stats, and health routes.
- Mounts HTTP routes from `src/routes/`.

`src/routes/`

- Own HTTP-specific validation, upload handling, and NDJSON progress streams.
- Delegate reusable behavior to `src/services/` and `src/store.ts`.
- Wrap every long download in `abortOnDisconnect` (`stream-abort.ts`), which
  listens for both `req`'s `aborted` and `res`'s `close` — a browser cancelling a
  `fetch` only fires the latter, and missing it leaves the server downloading
  gigabytes after the user pressed Cancel.

`src/services/`

- Shared business logic used by HTTP routes and MCP.
- Keeps collection, search, and thread loading behavior consistent across surfaces.

`src/ingest.ts`

- Finds likely export files recursively.
- Skips known metadata/account files.
- Parses files, chunks turns, embeds chunks, and writes rows to storage.

`src/parser.ts`

- Detects provider format.
- Converts provider-specific JSON into normalized turns, including Google AI
  Studio text chats and Imagen prompt histories.
- Supported providers: Google AI Studio, OpenRouter, LM Studio, Grok/xAI,
  ChatGPT/OpenAI, and Claude/Anthropic.

`src/chunking.ts`

- Splits long turn text into searchable chunks.
- Preserves `sourceFile`, `role`, and `turnIndex` metadata.

`src/embedding.ts`

- Loads the local multilingual Xenova embedding model.
- Produces vectors for chunks and search queries.

`src/store.ts`

- Manages LanceDB tables as collections.
- Writes chunk rows.
- Runs vector search.
- Lists files and collection stats.
- Persists normalized conversation turns in the internal `__threads` table at
  ingest time, so the thread view and the conversation listing keep working
  after a source file is moved, rewritten, or deleted. Table names starting
  with `__` are internal and never listed as collections.

`src/validation.ts`

- Normalizes and validates API inputs.
- Keeps route behavior predictable and testable.

`src/generation/`

- Defines the plugin contract shared by generation providers.
- Discovers current GGUF files under default and user-configured roots.
- Manages one loopback-only `llama-server` process for the selected model.
- Wraps the OpenAI-compatible llama.cpp and OpenRouter chat APIs.
- Converts provider SSE into redacted NDJSON progress and token events for the UI.
- Reports whether a GGUF is discovered, loading, or active in the managed runtime.
- Maps validated CPU/GPU/hybrid/multi-GPU profiles to upstream llama.cpp flags.
- Provides a loopback-only, directory-only filesystem browser for model roots.
- Keeps OpenRouter API keys in environment/session memory, never persisted config.
- Contains the explicit-consent llama.cpp release installer primitives, including
  the `nightly-tag.txt` resolution that finds the release actually carrying
  binaries (`llama-install.ts`).
- Owns created-chat lifecycle and per-thread generation leases in
  `src/generation/threads.ts`.
- Browses the public Hugging Face GGUF catalog read-only, without a token, and
  detects gated repositories up front (`model-catalog.ts`).
- Plans and fetches catalog models into `downloadDirectory`, verifying each file
  against its LFS `oid` before moving it into place (`model-download.ts`).
- Shares one resumable, hash-verifying downloader between runtime archives and
  models; a cancelled transfer keeps its `.part` file, any other failure deletes
  it (`downloader.ts`).
- Detects accelerators and RAM and turns a byte size into a single
  fits/tight/too-large verdict used by every surface (`hardware.ts`).
- Builds the one-screen setup plan, fingerprints exactly what it would fetch, and
  runs it (`quick-setup.ts`). The plan is always rebuilt server-side and matched
  against the approved fingerprint, so a client can never hand the server a URL
  to fetch and execute.

`mcp/server.ts`

- Exposes indexed local data to MCP clients over stdio.
- Reuses the same service layer as the web app.

`client/src/`

- React frontend built with Vite into `public/`.
- Handles collection selection, ingest, upload, search, role filters, file tree,
  thread reader, and the persistent New chat workspace.

## Data Model

Parser output is normalized into turns shaped like:

```js
{
  user: '...',
  thinking: '...',
  ai: '...',
  model: 'optional-model-name'
}
```

Not every turn has every role. A user-only or assistant-only message is valid.

Chunk rows stored in LanceDB include:

- Vector embedding.
- Text.
- Role: `user`, `thinking`, or `ai`.
- Source file.
- Turn index.
- Collection name.
- Model metadata when available.

## Collections

Each collection maps to a LanceDB table. A shared internal `__threads` table
additionally stores the normalized turns of every ingested conversation, keyed
by `(collection, sourceFile, conversationKey)`; it is replaced per file on
re-ingest and cleared alongside its collection. Collections are used to isolate
archives:

- One provider per collection.
- One project per collection.
- One time range per collection.
- Throwaway collections for real-data testing.

The special `all` selector is not a table. It searches across available collections.

Chats created inside ThreadShelf share the same normalized turn representation
and use the dedicated `threadshelf_conversations` collection plus `__threads`.
Their rows and turns set `createdInThreadShelf=true` and retain creation time,
generation backend, and model metadata. They never pretend to be source export
files. Imported threads keep thread-level archive provenance while appended
ThreadShelf turns carry per-turn provenance. After a complete response, the API
updates normalized storage and idempotently replaces only ThreadShelf-authored
search chunks. Generation is serialized per thread.

## Uploads

Browser folder uploads are stored under `.uploads/` by default. The path can be changed with:

```bash
UPLOADS_DIR=path/to/uploads npm start
```

On Windows PowerShell:

```powershell
$env:UPLOADS_DIR='D:\threadshelf-uploads'
npm start
```

Upload paths are normalized and checked to reduce path traversal risk.
Incoming multipart files are staged on disk rather than buffered fully in
memory. Deleting a collection removes its LanceDB table and copies stored below
`.uploads/<collection>`; it never deletes files from the original folder chosen
by the user.

## Embeddings

The app uses:

```text
Xenova/paraphrase-multilingual-MiniLM-L12-v2
```

This is a local multilingual model. The first run may be slower because model files need to download/cache.

## API Surface

Core routes:

- `GET /api/health`
- `GET /api/collections`
- `POST /api/collections`
- `DELETE /api/collections/:name`
- `POST /api/collections/:name/clear`
- `GET /api/collections/:name/stats`
- `GET /api/files`
- `GET /api/ingest-preview`
- `POST /api/ingest-progress`
- `POST /api/ingest-upload`
- `GET /api/search`
- `GET /api/thread`
- `GET /api/generation/config` (**Experimental Alpha**, loopback only)
- `PUT /api/generation/config` (**Experimental Alpha**, loopback only)
- `GET /api/generation/models` (**Experimental Alpha**, loopback only)
- `GET /api/generation/runtime` (**Experimental Alpha**, redacted runtime status)
- `GET /api/generation/runtime/logs` / `POST /api/generation/runtime/eject` (**Experimental Alpha**, loopback only)
- `GET /api/generation/directories` (**Experimental Alpha**, loopback only)
- `/api/generation/prompts` CRUD and active selection (**Experimental Alpha**, loopback only)
- `/api/generation/threads` list/create/get/rename/delete (**Experimental Alpha**, loopback only)
- `POST /api/generation/chat` (**Experimental Alpha**, loopback only)
- `POST /api/generation/chat/stream` (**Experimental Alpha**, loopback-only NDJSON)
- `GET /api/generation/hardware` (**Experimental Alpha**, loopback only)
- `GET /api/generation/catalog/search` / `GET /api/generation/catalog/model` (**Experimental Alpha**, loopback only)
- `POST /api/generation/catalog/download` (**Experimental Alpha**, loopback-only NDJSON, cancellable)
- `GET /api/generation/setup/plan` (**Experimental Alpha**, loopback only)
- `POST /api/generation/setup/run` (**Experimental Alpha**, loopback-only NDJSON; needs `confirm` plus the approved `fingerprint`)

## Testing Layers

Unit/regression:

```bash
npm test
```

API/LanceDB/MCP integration:

```bash
npm run test:e2e
```

Browser workflows:

```bash
npm run test:playwright
```

The full `npm run check` gate also verifies repository privacy hygiene,
documentation links, lint, TypeScript, and the production client build.

## Extension Points

Add a generation provider:

1. Implement `GenerationProvider` under `src/generation/providers/`.
2. Register it in `src/generation/registry.ts`.
3. Keep model discovery dynamic and declare whether requests are local/external.
4. Add provider contract tests and an API E2E stub; never call a live paid API in tests.

Add a provider:

1. Add format detection and parser logic in `src/parser.ts`.
2. Add a synthetic fixture under `test/fixtures/`.
3. Add parser tests.
4. Add an ingest or E2E case if the structure is unusual.

Improve search:

1. Add store-level behavior in `src/store.ts`.
2. Keep API response shape backward-compatible when possible.
3. Add tests for ranking, role filters, and cross-collection behavior.

Improve UI:

1. Update the React components and styles under `client/src/`.
2. Add or update Playwright tests.
3. Verify empty states, role filters, collection switching, and modal behavior.
