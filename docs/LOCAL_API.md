# Local model API (OpenAI and Anthropic compatible)

ThreadShelf serves the GGUF models it manages over the same HTTP API as
**LM Studio** and **Ollama**. Any tool built on the OpenAI or Anthropic SDKs can
use them: Open WebUI, Continue, Cline, LangChain, LlamaIndex or your own
scripts.

```text
Base URL (OpenAI SDKs):    http://localhost:3000/v1
Base URL (Anthropic SDKs): http://localhost:3000
API key:                   any value; none is checked
```

The API is part of the normal ThreadShelf server. Nothing else needs to be
started, and **Settings → Conversation generation → Local model API** shows the
URL, your model ids and ready-to-copy examples.

> Part of the **Experimental Beta** generation layer. See
> [Experimental Generation](GENERATION_BETA.md) for installing llama.cpp and
> downloading models.

## Endpoints

| Method | Path                        | Format                        |
| ------ | --------------------------- | ----------------------------- |
| GET    | `/v1/models`                | OpenAI model list             |
| GET    | `/v1/models/{id}`           | OpenAI model object           |
| POST   | `/v1/chat/completions`      | OpenAI Chat Completions       |
| POST   | `/v1/completions`           | OpenAI legacy text completion |
| POST   | `/v1/responses`             | OpenAI Responses API          |
| POST   | `/v1/messages`              | Anthropic Messages API        |
| POST   | `/v1/messages/count_tokens` | Anthropic token counting      |

Every POST endpoint accepts `"stream": true` and answers with server-sent
events in that API's own event format.

## Models

`GET /v1/models` lists every GGUF file ThreadShelf can find in its model
directories and download folder, the same set as the chat model picker. A
model's id is its file name without `.gguf`:

```json
{
  "object": "list",
  "data": [{ "id": "Bielik-11B-v3.0-Instruct.Q8_0", "object": "model", "owned_by": "threadshelf" }]
}
```

- **Loaded on demand.** The first request for a model starts `llama-server` with
  it, which can take from a few seconds to a minute or two for a large model.
  Later requests reuse it. A request for a different model swaps it in, like
  just-in-time loading in LM Studio.
- **Ids are case-insensitive** when that still picks out a single model.
- **Duplicate file names** in different folders get the folder as a prefix,
  e.g. `vendor-a/model.Q4_K_M`. Only the colliding files are renamed.
- **Paths are never exposed.** The API shows ids, not locations on disk.
- **An existing llama-server.** If **Existing local server URL** is set in
  Settings, `/v1` forwards to that server and lists its model ids unchanged.

Runtime settings from **Settings → Conversation generation** apply to models
loaded through the API as well: context size, GPU offload, flash attention,
KV cache and speculative decoding.

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

### Tools

Use a tool's **OpenAI-compatible** (or "custom OpenAI") provider, not an
Ollama preset. Ollama presets call Ollama's own `/api/*` routes.

| Tool                     | Setting                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Open WebUI (run locally) | Connections → OpenAI API → `http://localhost:3000/v1`, any key |
| Continue / Cline         | Provider "OpenAI compatible", base `http://localhost:3000/v1`  |
| Anthropic-based tools    | Base URL `http://localhost:3000`, any key, model = a model id  |

The tool must run directly on this machine. A client inside a Docker container
or VM connects from a different address and is refused (see [Access](#access)).

## Behavior

- **Everything llama.cpp supports.** ThreadShelf forwards each request to
  `llama-server` unchanged and only rewrites `model` from the public id. Tool
  and function calling, `response_format` / JSON schema, sampling parameters
  (`temperature`, `top_p`, `seed`, `stop`, …) and logprobs all work as
  llama.cpp implements them. The llama.cpp-specific `timings` field is passed
  through too. Tool calls and `json_schema` output also depend on the model's
  chat template: a model whose template has no tool support answers in plain
  text, and when llama.cpp cannot build a grammar for a template it returns
  400. `{"type": "json_object"}` is the most portable option.
- **Nothing is saved.** API calls are not written to the archive or to
  ThreadShelf chats, and the master prompt is not added. Send your own system
  message.
- **One model at a time.** If another model is generating, whether from the
  ThreadShelf UI or the API, the request gets **503** with the code
  `model_busy`. Official SDKs retry 503 on their own. Requests for the model
  that is already loaded run normally.
- **Cancellation.** If the client disconnects, for example by stopping a
  stream, `llama-server` stops generating right away.
- **Request size.** Bodies may be up to 32 MB, enough for long conversations.
- **Not served:** embeddings (`/v1/embeddings`), image input (models are
  loaded without a vision projector), audio, image generation, and the
  Ollama-native `/api/*` routes.

## Errors

Errors come back in the calling SDK's own format, so the SDK raises its usual
exception types (`NotFoundError`, `BadRequestError`, …).

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
| 403    | `forbidden`            | Request from another machine, host or browser origin          |
| 404    | `model_not_found`      | No model has that id; the message lists the available ones    |
| 404    | `unknown_endpoint`     | The path is not one of the endpoints above                    |
| 500    | `model_load_failed`    | llama-server could not load the model (see the runtime log)   |
| 502    | `upstream_unavailable` | llama-server or the configured external server did not answer |
| 503    | `model_busy`           | Another model is generating; retry                            |

Errors raised by llama.cpp itself, such as a prompt longer than the context
window, are passed through with llama.cpp's status and message.

## Access

The API follows the same rules as ThreadShelf's other generation controls:

- **This machine only.** Requests must come from the loopback interface, even
  if ThreadShelf is exposed on the network with `HOST` / `ALLOWED_HOSTS`, and
  the `Host` header must name `localhost` or a loopback address.
- **Checks on `Host` and `Origin`.** A web page on another site cannot call the
  API from your browser, and neither can a DNS-rebinding attack. No CORS
  headers are sent.
- **No API key.** Any process on this machine can already reach the model
  runtime, so a key would add nothing. SDKs that insist on a key accept any
  string.
- **Local inference only.** The API never reaches OpenRouter or any other
  external provider.
