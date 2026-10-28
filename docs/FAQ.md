# FAQ

## Is my data sent to a cloud service?

No for the core search flow. Exports are parsed locally, embeddings are generated locally, and vectors are stored locally in LanceDB.

The first embedding model load may download model files through the Transformers/Xenova stack if they are not already cached. After that, search/indexing uses the local model cache.

The optional OpenRouter generation provider is the explicit exception: selecting
**OpenRouter · external** sends the selected user/assistant context and new prompt
off-device. Local `llama.cpp` generation remains on loopback.

## What problem is this trying to solve?

The practical problem is archive recovery. AI tools can accumulate hundreds or thousands of useful conversations, article drafts, research notes, and backup snippets, but provider search/export workflows are often limited or missing. ThreadShelf focuses on making services like Google AI Studio and OpenRouter easier to back up, normalize, index, and use later from one local place.

## What files should never be committed?

Do not commit:

- Real chat exports.
- `.lancedb/`
- `.uploads/`
- `.collections.json`
- Logs.
- Temp folders.
- Screenshots with private chats.

See [Security And Privacy](https://github.com/ChrystianSchutz/ThreadShelf/blob/main/SECURITY.md).

## What is a collection?

A collection is a LanceDB table. It is the main boundary for indexed data.

Use collections to separate:

- Providers.
- Projects.
- Time periods.
- Test data versus real data.

## Should I use `All`?

Use `All` when you do not know where something is. Use a specific collection when:

- You want faster, narrower search.
- You are testing a provider parser.
- You want to avoid exposing unrelated results to an MCP client.

## Why are there chunks instead of full conversations in search results?

Embeddings work better on focused pieces of text than on very long full conversations. ThreadShelf stores chunks for search, then reconstructs the full source thread when you open a result.

## How do I find an exact ID, filename, or error string?

Switch the search mode from **Semantic** to **Exact**. Exact mode performs a
case-insensitive substring search and is intended for identifiers, filenames,
package names, code fragments, and error messages.

## Why is first indexing slow?

The local embedding model may need to download and initialize. Large exports also require parsing, chunking, embedding, and LanceDB writes.

## Can I index multiple providers in one folder?

Yes. The parser detects supported formats per file. For real testing, separate collections are easier to debug, but mixed-provider folders are supported.

## What does the OpenRouter script do?

It runs in the browser DevTools Console on OpenRouter. The bulk script walks
sidebar chats, scrolls each thread to load its history, extracts user/assistant
text, and downloads one JSON file per chat. The single-chat script exports the
currently open conversation.

See [OpenRouter Export](OPENROUTER.md).

## Does MCP create another database?

No. MCP reads the same local LanceDB collections used by the web UI.

## Can I host ThreadShelf for multiple users?

That is not the supported deployment model. ThreadShelf is a single-user local
application with no account system or API authentication. Keep the default
`127.0.0.1` binding. LAN exposure is intended only for a trusted network and
requires deliberate `HOST`/`ALLOWED_HOSTS` configuration.
