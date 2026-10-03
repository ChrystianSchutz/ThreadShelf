# Obsidian vault integration

Connect an existing vault under **Settings → Obsidian vault**. Choose its absolute
directory, save it, and search or create a Markdown note directly in the panel.
Search results include relative paths, headings and line numbers; **Open in
Obsidian** opens the original note. Search reads current files, so changes made
in Obsidian are visible on the next query without reimporting.

In a conversation, check **Obsidian tools** to give the selected model these
scoped tools:

| Tool | Purpose |
| --- | --- |
| `obsidian_search` | Live keyword search of note paths and Markdown text; all query words must match |
| `obsidian_read` | Read a note and its revision, including original frontmatter and wikilinks |
| `obsidian_create` | Create a new `.md` file without overwriting an existing note |
| `obsidian_edit` | Replace note text only if its revision still matches the last read |
| `obsidian_delete` | Pause the conversation for browser confirmation of a specific file list |

For example: “Search my vault for the project decisions, read the relevant notes,
and create `project-summary.md` with a summary and links to the source notes.”
The agent can try several queries and read the results before answering. Local
llama.cpp models must support function calling through their chat template.
The agent is bounded to eight model rounds and sixteen tool calls per message.
Opaque provider reasoning state is retained in memory between tool rounds, following
the [OpenRouter tool-calling requirements](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning),
and is excluded from stored conversation history.

## Write control and deletion

**Allow vault writes** is **on by default**, and is available in Settings and
beside the conversation composer. Turn it off to make the vault read-only for
every ThreadShelf agent, including MCP. Reading and searching remain available.
Changing the vault during an agent run stops access to the previous vault.
Creation requires an existing parent directory. Tools cannot create folders,
access attachments, run commands, or operate outside the configured vault.

Deletion always needs a separate user decision, even when writes are enabled:

1. The conversation displays the requesting model and the exact note paths.
2. Check **I confirm deletion of these files** and click **OK — delete files**.
3. The server checks that the vault, write permission and note revisions still
   match, then moves the notes into a unique batch under the vault's `.trash`.

**Cancel** or **×** preserves the notes. Requests expire after five minutes and
are cancelled when the chat connection closes. Browser confirmation tokens are
never sent to the model. Text such as “confirmed” in a tool call cannot approve
deletion. Restarting the server cancels pending confirmations. A changed note
requires a new request. If a filesystem error interrupts a batch, the tool reports
which notes have already moved; recover them from `.trash` if necessary.

## Privacy and scope

Vault search is local and does not use an external embedding service. This
version provides live **keyword** search; semantic note indexing, automatic
project export and backlink graph traversal are future work. Original Markdown
is retained when reading; the model is instructed to preserve frontmatter and
links when editing. Review the resulting edits in Obsidian or your vault's Git
history.

Only regular `.md` files are accessible. Hidden path segments (including
`.obsidian`, `.git`, `.trash` and sync-history directories), symlinks, junctions,
hard links, absolute note paths, traversal and Windows alternate data streams
are rejected. Files are limited to 512 KiB, agent reads to 60,000 characters,
search scans to 20,000 filesystem entries / 64 MiB, and deletion batches to twenty
notes. Agent reads larger than their limit are marked incomplete and do not
return an edit revision. These tools are not a sandbox for other programs:
Obsidian and sync clients can still change files independently.

With **llama.cpp**, retrieved note text stays on the machine. Enabling tools
while using **OpenRouter** sends retrieved note text and relative note paths to
that external provider; the composer states this before sending. An external
MCP model may also send retrieved content off-device.

Private conversations remain outside the chat archive, but explicitly enabled
vault tools can still write notes. Disabling **Allow vault writes** also prevents
these writes. Tool traces and confirmation tokens are not saved in chat history.

Configuration is stored in the local, gitignored
`.threadshelf/obsidian.json` in a checkout, or the normal ThreadShelf user-data
directory for an installed package. `OBSIDIAN_CONFIG_PATH` overrides its location.
The configured vault path is never included in model tool results.

## HTTP API and MCP

All `/api/obsidian` routes are guarded for loopback access and the application's
Host/Origin checks. They are not exposed by the optional network `/v1` listener.

| Method / route | Purpose |
| --- | --- |
| `GET /api/obsidian/config` | Read configuration |
| `PUT /api/obsidian/config` | Save `{ "vaultPath": "…", "allowWrites": true }` |
| `PATCH /api/obsidian/config` | Toggle `{ "allowWrites": false }` without changing the connected vault |
| `GET /api/obsidian/search?q=…&limit=10` | Search notes |
| `GET /api/obsidian/note?path=…` | Read a note |
| `POST /api/obsidian/note` | Create `{ "path": "new-note.md", "content": "…" }` |
| `POST /api/obsidian/approvals/:id` | Browser decision with capability, `approve` and `acknowledged` |

Streaming generation accepts `useObsidian: true` and emits `vault-tool` progress
and `vault-approval` events alongside the ordinary token stream. The client posts
its decision separately while the generation stream waits.

The stdio MCP server exposes `obsidian_search`, `obsidian_read`,
`obsidian_create` and `obsidian_edit` using the same configuration and policy.
MCP has no deletion or approval tool: use an interactive ThreadShelf conversation
for deletion so its confirmation cannot be bypassed by another agent.
