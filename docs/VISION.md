# Vision with llama.cpp

Vision is available through the local inference API (`/v1`), including streaming.
The chat composer currently accepts text; send images from an API client. No image
or inference exchange is added to the conversation archive by `/v1`.

## Load the matching projector

A multimodal GGUF needs both its text weights and its model-specific `mmproj` GGUF.
Text weights alone do not enable vision. Use a projector published for the exact
model; ThreadShelf cannot establish compatibility from the filename.

The catalog's **include projector** option downloads one projector next to the
model (F16 when the repository has several precisions, then BF16, F32 or the
smallest), so the folder keeps a unique match.
ThreadShelf automatically adds `--mmproj` only when that directory contains one
primary model (excluding later shards and DFlash companions) and one projector.
It never picks the first projector from an ambiguous/shared directory. A file whose
name contains `mmproj` as a separate token (`mmproj-model.gguf`,
`model-mmproj-f16.gguf`) is a projector and is never listed as a chat model.
If the installed `llama-server` has no `--mmproj` flag, the model still starts
for text, the runtime log says the projector was skipped, and image requests
fail upstream; update llama.cpp for image input.

For shared folders or a projector in another configured model directory, save an
explicit model-to-projector mapping using `PUT /api/generation/config`:

```json
{"llamaCpp":{"projectorPaths":{
  "C:/Models/Glimmer/model.gguf":"C:/Models/Glimmer/mmproj-model.gguf"
}}}
```

Replace paths with your actual absolute paths; Linux paths work too. The model
must be discovered in a configured model directory. Projectors must resolve to
local GGUF files inside those directories, including after symlink resolution.
Mapping keys match the model path case-insensitively on Windows. A mapping whose
projector file is missing is reported when the model loads; model listings then
show that model without `vision` instead of failing.
This update restarts the managed runtime. An empty mapping `{}` restores automatic
discovery. Nothing is downloaded automatically when a chat is sent.

With an **external local server**, ThreadShelf forwards images but does not change
its launch flags. Start it with `llama-server -m model.gguf --mmproj mmproj-model.gguf
--jinja --host 127.0.0.1 --port 4781`. Check `/props`: `modalities.vision` must be
`true`. `/v1/models` reports `vision` when known; missing means unknown. A local
projector being present is a configuration signal, not an inference test.

## Send a local image

```python
import base64, json, urllib.request

models = json.load(urllib.request.urlopen("http://127.0.0.1:3000/v1/models"))
model = next(item["id"] for item in models["data"] if item.get("vision"))
with open("screenshot.png", "rb") as image:
    encoded = base64.b64encode(image.read()).decode("ascii")
body = {"model": model, "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Read the chart and explain its result."},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64," + encoded}}
]}], "max_tokens": 4096}
request = urllib.request.Request("http://127.0.0.1:3000/v1/chat/completions",
    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(request))["choices"][0]["message"]["content"])
```

When an API key is configured, add `Authorization: Bearer YOUR_KEY` to both calls.
OpenAI Responses `input_image` and Anthropic base64 `image` blocks are accepted
as supported by the upstream runtime. Only inline PNG/JPEG/WebP/GIF inputs are accepted, and the bytes must match
the declared type:
remote URLs and file paths are rejected before model loading, so an API caller
cannot make the model server fetch a private host or external image. Maximum:
four images, 8 MiB each, 16 MiB decoded in total, within the existing 32 MiB JSON
body limit. Model/runtime errors remain visible; a text-only model is rejected
with a clear projector hint. This does not sandbox the native image decoder.

## Glimmer

Muse Glimmer supports vision using `mmproj-Muse-Glimmer-30B-Q4_K_M.gguf` (~1.4 GB)
alongside its text GGUF. Use llama.cpp b10353 or newer and `--jinja`. Keep
`chat_template_kwargs: {"reasoning_strength":"low"}` in benchmark requests; its
reasoning cannot be disabled. The projector adds memory use; choose context and
the optional DFlash drafter to fit your GPU.

Sources: [official Glimmer GGUF model card](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF),
[llama.cpp multimodal documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md).

## Measured local check (2026-10-07)

Glimmer Q4_K_M with the matching projector, llama.cpp b10809 CUDA, 64k context,
q8 KV and DFlash16: three unseen screenshots passed through an isolated ThreadShelf
API instance to the real model. Exact chart label, blue count and raster-only code:
**9/9 facts**, **2.68–3.00 s per image**. A text-only control returned null for all
answers. This verifies image transport and these fixtures, not general vision quality.
Swarm's reproducible fixture/benchmark: `scripts/benchmark-vision.ts`;
artifacts: `data/bench-vision/` in the Swarm checkout.

Validation: `npm run check` passed (514 unit tests, 20 API/MCP E2E, 72 browser E2E,
lint, typecheck and client build).
