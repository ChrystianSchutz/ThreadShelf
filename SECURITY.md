# Security And Privacy

ThreadShelf is designed for local private archives. It does not require a cloud vector database or external embedding API for the main search path.

## Private Data

Do not commit:

- Real chat exports.
- Uploaded source files.
- LanceDB databases.
- `.collections.json`.
- `.threadshelf/` (generation settings and optional llama.cpp tools).
- Logs.
- Temp folders.
- Screenshots containing private conversations.

The repo's committed fixtures should be synthetic and anonymized.

## Local Server Exposure

By default the server binds only to `127.0.0.1`. Keep that default for private
single-machine use:

```bash
$env:HOST='127.0.0.1'
npm start
```

Setting `HOST=0.0.0.0` exposes the unauthenticated API to the local network. Do
not do this on an untrusted network.

The browser UI uses same-origin API requests and does not enable cross-origin
access by default.

## Experimental Generation Boundary

Conversation generation is **Experimental Beta**. Managed `llama-server`
processes bind to an ephemeral `127.0.0.1` port, configured llama.cpp URLs must
be loopback-only, and selected GGUF files must be under configured model roots.

OpenRouter is an explicit external exception to the local data path. Sending a
continuation transmits the selected archive's user/assistant turns and prompt to
OpenRouter and its routed provider; archived thinking is excluded. The UI
marks the provider as **OpenRouter · external**, adds an `off-device` chip to the
model button, and repeats the boundary in the composer. ZDR-only routing and
provider data-collection denial are optional controls, but users must still treat
every OpenRouter request as disclosure to an external service.

Prefer `OPENROUTER_API_KEY`. Keys entered in Settings remain in process memory
only and are never returned by the API or persisted to generation config.

## MCP Exposure

The MCP server gives connected MCP clients access to indexed local chat data. Only configure it in clients you trust.

## Reporting Issues

If you find a vulnerability or privacy leak:

- Do not include real private exports in the report.
- Describe the issue with synthetic examples.
- Include affected routes/tools and reproduction steps.

## Dependency Notes

The app uses:

- Express for the local HTTP server.
- Multer for uploads.
- LanceDB for local vector storage.
- Xenova Transformers for local embeddings.
- Playwright for browser tests.

Review dependency updates before publishing public releases.
