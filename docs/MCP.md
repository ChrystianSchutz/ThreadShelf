# MCP Setup

ThreadShelf includes a stdio MCP server so local AI tools can query indexed conversations.

MCP is useful when you want Cursor, Claude Desktop, or another MCP-aware client to search your local AI chat archive without manually opening the web UI.

## Server metadata

- Transport: stdio
- Authentication: none
- Language: TypeScript
- License: MIT
- Runtime: Node.js 20.19+
- Install: clone the repository and run `npm ci`
- Start: `npm run mcp`
- Data location: local LanceDB / ThreadShelf archive
- Network service required for archive search: no
- MCP tools: 5

The tools are:

- `list_collections`
- `list_files`
- `get_stats`
- `search`
- `read_thread`

## What MCP Uses

The MCP server does not create a separate index. It reads the same local data as the web app:

- LanceDB path from `LANCEDB_PATH`, default `.lancedb`.
- Uploaded/source files from paths stored during ingest.
- The same collections created by the UI/API.

Index data first with the web UI or API. Then connect an MCP client.

The stdio server defaults to MCP protocol `2024-11-05` for broad Claude Desktop
compatibility, and negotiates `2025-03-26` or `2025-06-18` when a client requests
one of those versions during `initialize`.

## Install and start

From a clean clone:

```bash
git clone https://github.com/ChrystianSchutz/ThreadShelf.git
cd ThreadShelf
npm ci
npm run mcp
```

If ThreadShelf is already installed, start the server from the repository root:

```bash
npm run mcp
```

The server communicates over stdio. It is not an HTTP server and should not be opened in a browser.

## Tested MCP clients

The automated compatibility test starts the real ThreadShelf process over stdio,
initializes an MCP session, confirms that `tools/list` returns all five tools, and
calls `list_collections` and `get_stats` against an isolated LanceDB directory.

Claude Desktop and Cursor are documented configuration targets. Claude Desktop,
Cursor, Codex, and VS Code MCP are protocol-compatible, but are not currently
included in the project's manual compatibility test matrix. This documentation
does not mark a client as tested based only on protocol compatibility.

## Client Command

Most MCP clients need:

```bash
npm run mcp --silent
```

The `--silent` flag keeps npm's lifecycle banner off the MCP stdout channel. Set
the working directory to the repository root.

If your database lives somewhere else, pass environment variables in the MCP client config:

```json
{
  "LANCEDB_PATH": "D:\\threadshelf\\.lancedb",
  "UPLOADS_DIR": "D:\\threadshelf\\.uploads"
}
```

Use your real local paths.

## Example MCP Config Shape

Different clients use slightly different config files, but the shape usually looks like this:

```json
{
  "mcpServers": {
    "threadshelf": {
      "command": "npm",
      "args": ["run", "mcp", "--silent"],
      "cwd": "C:\\Users\\you\\path\\to\\threadshelf",
      "env": {
        "LANCEDB_PATH": "C:\\Users\\you\\path\\to\\threadshelf\\.lancedb"
      }
    }
  }
}
```

If a client does not support `cwd`, use an absolute repository path and run `tsx mcp/server.ts`.

## Tools

Current tools:

`list_collections`

- Lists local LanceDB collections.
- Use first to understand what can be searched.

`list_files`

- Arguments: `collection`.
- Lists indexed source files in one collection or across `all`.
- `collection` defaults to `all`.
- Useful before asking for a full thread.

`get_stats`

- Optional argument: `collection`.
- Returns the same stats as `/api/collections/all/stats` or
  `/api/collections/:name/stats`.
- `collection` defaults to `all`.
- Useful before broad searches so agents can see whether anything is indexed.

`search`

- Required argument: `query`.
- Optional arguments: `collection`, `n`, `roles`, `mode`, `keywordBoost`, `model`, `from`, `to`.
- Returns ranked snippets with source metadata.
- `collection` defaults to `all`; pass a collection name to narrow the search.
- `roles` can include `user`, `thinking`, and `ai`.
- `mode` is `semantic` (default, embedding similarity) or `keyword` (exact
  case-insensitive substring match — use for identifiers, error strings, code).
- `model` performs a case-insensitive substring filter.
- `from` and `to` accept ISO timestamps or `YYYY-MM-DD` date bounds.

Example arguments:

```json
{
  "query": "where did I discuss OpenRouter export automation?",
  "collection": "all",
  "n": 10,
  "roles": ["user", "ai"],
  "keywordBoost": true,
  "from": "2026-01-01"
}
```

`read_thread`

- Arguments: `sourceFile`, optional `collection` and `conversationKey`.
- Loads and parses the full source conversation.
- `collection` defaults to `all`.
- Pass the `conversationKey` returned by `search` when one export file contains
  multiple conversations.
- Use after `search` returns a promising source file.

## Resources

The server also declares resource templates:

- `threadshelf://collections`
- `threadshelf://collections/{collection}/files`
- `threadshelf://thread?path={absolutePath}`

Tools are usually easier for agents. Resources are useful for clients that expose MCP resources directly.

## Recommended Agent Workflow

Ask the MCP client to:

1. Call `list_collections`.
2. Call `get_stats` to check indexed volume.
3. Call `search` with `collection: "all"` or a specific collection.
4. Inspect returned snippets and metadata.
5. Call `read_thread` only for the most relevant result.
6. Use the full thread as context.

This avoids dumping huge conversations into context unnecessarily.

## Manual Verification

After configuring an MCP client:

- List collections.
- Search a known query in a real test collection.
- Retrieve one thread.
- Confirm the response contains source file, collection, role, turn index, and useful snippet text.

You can also run:

```bash
npm run test:e2e
```

The E2E suite includes a stdio MCP smoke test.

## Safety

MCP exposes your local indexed chat archive to the connected client. Only connect clients you trust.

Practical safety rules:

- Do not index archives you do not want the MCP client to access.
- Prefer separate collections for sensitive projects.
- Use `collection`-scoped searches when possible.
- Do not expose the local app or MCP process to untrusted users.
