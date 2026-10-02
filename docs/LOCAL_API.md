# Local model API (OpenAI and Anthropic compatible)

ThreadShelf serves the GGUF models it manages over the same HTTP API as
**LM Studio** and **Ollama**. Any tool built on the OpenAI or Anthropic SDKs can
use them: Open WebUI, Continue, Cline, LangChain, LlamaIndex or your own
scripts.

```text
Base URL (OpenAI SDKs):    http://localhost:3000/v1
Base URL (Anthropic SDKs): http://localhost:3000
API key:                   any value, unless you set one in Settings
```

The API is part of the normal ThreadShelf server and is on by default, the way
LM Studio and Ollama work out of the box: any program on this computer can use
it without a key. Nothing else needs to be started. **Settings → Conversation
generation → Local model API** shows the URL, your model ids and ready-to-copy
examples, a plain-language guide to every setting, and the optional
[access settings](#access): an API key,
network access and an off switch.

> Part of the generation layer. See [Conversation generation](GENERATION.md)
> for installing llama.cpp and downloading models, and
> [Performance](PERFORMANCE.md) for choosing settings.

## Endpoints

| Method | Path                        | Format                                   |
| ------ | --------------------------- | ---------------------------------------- |
| GET    | `/v1/models`                | OpenAI model list                        |
| GET    | `/v1/models/{id}`           | OpenAI model object                      |
| POST   | `/v1/chat/completions`      | OpenAI Chat Completions                  |
| POST   | `/v1/completions`           | OpenAI legacy text completion            |
| POST   | `/v1/responses`             | OpenAI Responses API                     |
| POST   | `/v1/messages`              | Anthropic Messages API                   |
| POST   | `/v1/messages/count_tokens` | Anthropic token counting                 |
| POST   | `/v1/models/unload`         | ThreadShelf: free the model's memory now |

Every inference endpoint accepts `"stream": true` and answers with server-sent
events in that API's own event format.

## Models

`GET /v1/models` lists every GGUF file ThreadShelf can find in its model
directories and download folder, the same set as the chat model picker. A
model's id is its file name without `.gguf`:

```json
{
  "object": "list",
  "data": [
    {
      "id": "Bielik-11B-v3.0-Instruct.Q8_0",
      "object": "model",
      "owned_by": "threadshelf",
      "loaded": true
    }
  ]
}
```

- **Loaded on demand.** The first request for a model starts `llama-server` with
  it, which can take from a few seconds to a minute or two for a large model.
  Later requests reuse it.
- **Switching models.** Send a different `model` and ThreadShelf swaps it in,
  like just-in-time loading in LM Studio. There is no separate "load" call.
- **`loaded`** is `true` for the model currently in memory (or loading). It is a
  ThreadShelf addition; SDKs ignore unknown fields.
- **Ids are case-insensitive** when that still picks out a single model.
- **Duplicate file names** in different folders get the folder as a prefix,
  e.g. `vendor-a/model.Q4_K_M`. Only the colliding files are renamed.
- **Paths are never exposed.** The API shows ids, not locations on disk.
- **An existing llama-server.** If **Existing local server URL** is set in
  Settings, `/v1` forwards to that server and lists its model ids unchanged
  (all reported as loaded). Unloading is then up to that server.

Runtime settings from **Settings → Conversation generation** apply to models
loaded through the API as well: context size, GPU offload, flash attention,
KV cache and speculative decoding.

## Memory (VRAM)

ThreadShelf runs **one** `llama-server` process with **one** model at a time,
shared by the ThreadShelf chat and the API.

- **Switching frees the old model first.** Before a different model starts, the
  previous `llama-server` is stopped and ThreadShelf waits for the process to
  exit, so its VRAM and RAM are released before the new model is loaded. Two
  models are never in memory at once. A process that ignores the stop request
  for 5 seconds is killed.
- **Switching costs a full load.** Clients that alternate between two models
  reload on every switch. Point them at the same model when you can.
- **A loaded model stays loaded** until another model is requested, it is
  unloaded, or ThreadShelf exits. Closing ThreadShelf always stops it.
- **Unload after idle time.** **Settings → llama.cpp wrapper → Unload model
  from memory** stops the model once no chat or API request has used it for
  the chosen time (5 minutes to 1 day), like Ollama's `keep_alive`. The default
  is **Never**. The next request loads it again. The same setting is available
  as `LLAMA_CPP_IDLE_UNLOAD_MINUTES` (`0` = never).
- **Unload now.** Click **Eject** in ThreadShelf, or call the API:

```bash
curl -X POST http://localhost:3000/v1/models/unload
# {"unloaded": true, "model": "Bielik-11B-v3.0-Instruct.Q8_0"}
```

`POST /v1/models/unload` takes an optional body `{"model": "<id>"}`. With it,
only that model is unloaded; if a different model is in memory, nothing
happens and the response says `"unloaded": false` and names the loaded model.
Without a body, whatever is loaded is unloaded. Calling it when nothing is
loaded is harmless (`{"unloaded": false, "model": null}`). While a model is
generating, the call returns **503** `model_busy`; it never interrupts a
response.

## Examples

### curl

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Bielik-11B-v3.0-Instruct.Q8_0",
    "messages": [
      {"role": "system", "content": "Odpowiadaj zwięźle po polsku."},
      {"role": "user", "content": "Jaka jest stolica Polski?"}
    ]
  }'
```

With an API key set, add `-H "Authorization: Bearer YOUR_KEY"`.

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="threadshelf")

stream = client.chat.completions.create(
    model="Bielik-11B-v3.0-Instruct.Q8_0",
    messages=[{"role": "user", "content": "Napisz haiku o Wiśle."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### OpenAI SDK (JavaScript)

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:3000/v1', apiKey: 'threadshelf' });
const reply = await client.chat.completions.create({
  model: 'Bielik-11B-v3.0-Instruct.Q8_0',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(reply.choices[0].message.content);
```

### Anthropic SDK (Python)

Anthropic SDKs add `/v1` themselves, so their base URL has no `/v1`:

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://localhost:3000", api_key="threadshelf")
message = client.messages.create(
    model="Bielik-11B-v3.0-Instruct.Q8_0",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

In every example, `"threadshelf"` stands for "any value". Once you set an API
key, pass that key instead.

### Coding agents

The same steps, filled in with your address and model, are in the app:
**Settings → Local model API → Guide: status & connect an app**. Agents read
files and keep long histories, so give the model at least 32K of context (64K
with the Memory saver KV cache works well on 24 GB). See
[Performance](PERFORMANCE.md) for what speed to expect.

**Claude Code** uses the Anthropic API. Set these before starting `claude`
(PowerShell: `$env:NAME = "value"`):

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_AUTH_TOKEN="threadshelf"        # or your ThreadShelf key
export ANTHROPIC_MODEL="<model id>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<model id>"
claude
```

The base URL has no `/v1`. Use the same id for both models: ThreadShelf keeps
one model in memory, and a separate background model would swap models all the
time.

**Codex CLI** uses the Responses API. Add to `~/.codex/config.toml`:

```toml
model = "<model id>"
model_provider = "threadshelf"

[model_providers.threadshelf]
name = "ThreadShelf"
base_url = "http://localhost:3000/v1"
wire_api = "responses"
# env_key = "THREADSHELF_API_KEY"   # only when a ThreadShelf key is set
```

Current Codex versions refuse `wire_api = "chat"`. With a key set, uncomment
`env_key` and export `THREADSHELF_API_KEY` before running `codex`.

**DeepSeek Harness** takes OpenAI-compatible providers in **Settings → Models →
Add a custom provider**, or in `$DSH_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    threadshelf:
      displayName: ThreadShelf
      apiKeyEnv: THREADSHELF_API_KEY
      api: openai-completions
      baseURL: http://localhost:3000/v1
      models:
        - id: <model id>
```

The harness reads the key from `THREADSHELF_API_KEY`, so set that variable
(any value when ThreadShelf has no key) before `npx @deepseek-ai/dsh web`.

### Tools

Use a tool's **OpenAI-compatible** (or "custom OpenAI") provider, not an
Ollama preset. Ollama presets call Ollama's own `/api/*` routes.

| Tool                     | Setting                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Open WebUI (run locally) | Connections → OpenAI API → `http://localhost:3000/v1`, any key |
| Continue / Cline         | Provider "OpenAI compatible", base `http://localhost:3000/v1`  |
| Anthropic-based tools    | Base URL `http://localhost:3000`, any key, model = a model id  |

Some tools refuse to save a provider without a key. Type any value, or set a
real key in Settings and use it.

A tool inside a Docker container, a VM or on another device connects from a
different address, so ThreadShelf's own port refuses it. Turn on
[network access](#network-access) and point the tool at the network URL shown
in Settings, e.g. `http://192.168.1.50:3001/v1`.

## Behavior

- **Everything llama.cpp supports.** ThreadShelf forwards each request to
  `llama-server` unchanged and only rewrites `model` from the public id. Tool
  and function calling, `response_format` / JSON schema, sampling parameters
  (`temperature`, `top_p`, `seed`, `stop`, …) and logprobs all work as
  llama.cpp implements them. The llama.cpp-specific `timings` field is passed
  through too. Tool calls and `json_schema` output also depend on the model's
  chat template: a model whose template has no tool support answers in plain
  text, and when llama.cpp cannot build a grammar for a template it returns 400. `{"type": "json_object"}` is the most portable option.
- **Nothing is saved.** API calls are not written to the archive or to
  ThreadShelf chats, and the master prompt is not added. Send your own system
  message.
- **One model at a time.** If another model is generating, whether from the
  ThreadShelf UI or the API, the request gets **503** with the code
  `model_busy`. Official SDKs retry 503 on their own. Requests for the model
  that is already loaded run normally. See [Memory](#memory-vram).
- **Cancellation.** If the client disconnects, for example by stopping a
  stream, `llama-server` stops generating right away.
- **Request size.** Bodies may be up to 32 MB, enough for long conversations.
- **Not served:** embeddings (`/v1/embeddings`), image input (models are
  loaded without a vision projector), audio, image generation, and the
  Ollama-native `/api/*` routes.

## Errors

Errors come back in the calling SDK's own format, so the SDK raises its usual
exception types (`AuthenticationError`, `NotFoundError`, `BadRequestError`, …).

OpenAI format, used by every endpoint except `/v1/messages`:

```json
{
  "error": {
    "message": "The model \"nope\" does not exist. Available models: …",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

Anthropic format, used by `/v1/messages*` and by any request that sends an
`anthropic-version` header:

```json
{ "type": "error", "error": { "type": "not_found_error", "message": "…" } }
```

| Status | `code`                 | Meaning                                                       |
| ------ | ---------------------- | ------------------------------------------------------------- |
| 400    | `invalid_request`      | Missing `model`, or the body is not a JSON object             |
| 401    | `invalid_api_key`      | A key is set and the request sent none or a wrong one         |
| 403    | `forbidden`            | Refused by the host, origin or this-machine-only check        |
| 403    | `api_disabled`         | The API is turned off in Settings                             |
| 404    | `model_not_found`      | No model has that id; the message lists the available ones    |
| 404    | `unknown_endpoint`     | The path is not one of the endpoints above                    |
| 500    | `model_load_failed`    | llama-server could not load the model (see the runtime log)   |
| 502    | `upstream_unavailable` | llama-server or the configured external server did not answer |
| 503    | `model_busy`           | Another model is generating; retry                            |

Errors raised by llama.cpp itself, such as a prompt longer than the context
window, are passed through with llama.cpp's status and message.

## Access

The defaults match LM Studio and Ollama: on, this computer only, no key.
Everything else is opt-in under **Settings → Conversation generation → Local
model API** and takes effect when you save, without a restart.

| Setting                    | Default | Effect                                              |
| -------------------------- | ------- | --------------------------------------------------- |
| Serve the local model API  | on      | Off: every `/v1` request gets 403 `api_disabled`    |
| API key                    | empty   | Set: every request must send it, on every port      |
| Serve on the local network | off     | On: other devices can use `/v1` on the network port |
| Network port               | 3001    | Port of the network listener                        |

### Default: this computer only

- Requests to ThreadShelf's own port must come from the loopback interface,
  even if ThreadShelf itself is exposed with `HOST` / `ALLOWED_HOSTS`, and the
  `Host` header must name `localhost` or a loopback address.
- **Checks on `Host` and `Origin`.** A web page on another site cannot call the
  API from your browser, and neither can a DNS-rebinding attack. No CORS
  headers are sent.
- With no key set, any key a client sends is accepted, so SDKs that insist on
  a key work unchanged.

### API key

Type a key or click **Generate**, copy it, then save. The key is checked on
every `/v1` request: OpenAI SDKs send it as `Authorization: Bearer <key>`,
Anthropic SDKs as `x-api-key: <key>`, and both headers are accepted. Wrong or
missing keys get **401** in the SDK's format (`AuthenticationError`).

- The key is saved in `.threadshelf/generation.json` (file mode `0600`) and is
  never sent back by ThreadShelf's API, so Settings shows only that a key is
  set. Copy a new key before saving. To change it, type a new one; to remove
  it, tick **Remove the saved key**.
- `THREADSHELF_API_KEY` in the environment or `.env` overrides the saved key and
  locks the field in Settings.
- Keys may use any visible ASCII characters, up to 512.
- The ThreadShelf UI does not need the key: it reads the model list through
  its own settings API.

### Network access

**Serve on the local network** starts a second listener on all network
interfaces, port **3001** by default, like LM Studio's "Serve on local
network". Settings then lists the URLs other devices can use, one per network
address, e.g. `http://192.168.1.50:3001/v1`.

- **Only `/v1` is served there.** The archive, the ThreadShelf UI and its
  settings API stay on the loopback port. Any other path on the network port
  answers 404.
- **Without a key**, anyone on your network can use your models. The network
  port then accepts requests addressed to an IP address, to this computer's
  name (`my-pc`, `my-pc.local`, `my-pc.lan`) or to a name in `ALLOWED_HOSTS`,
  and refuses browser requests from other sites, which blocks DNS rebinding.
- **With a key**, the key alone decides, so any host name works, for example
  behind a reverse proxy.
- If the port is taken, Settings shows the error and ThreadShelf keeps running.
  Turning the API off also closes the network port.
- Your firewall may ask whether Node.js may accept connections. Allow it on
  private networks only.
- Set a key whenever you turn this on outside a network you trust.

### Always

- **Local inference only.** The API never reaches OpenRouter or any other
  external provider.
- The model runtime itself (`llama-server`) listens on `127.0.0.1` with a
  random port and is never exposed.
