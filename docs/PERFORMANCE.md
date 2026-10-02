# Performance and tuning

How fast local models run in ThreadShelf, which settings matter, and how to
measure your own machine. The numbers below are one real benchmark, not a
promise: they depend on the GPU, the quantization, the llama.cpp build and the
text being generated.

## Reference machine

Measured on 28 September and 2 October 2026:

- **GPU:** NVIDIA GeForce RTX 3090 Ti, 24 GiB VRAM (driver 591.86)
- **CPU / RAM:** AMD Ryzen 7 8700F (8 cores / 16 threads), 96 GiB
- **Runtime:** llama.cpp b10809 CUDA on Windows (`llama-bench` and
  `llama-server`), one model and one slot at a time
- **Models**, 11 to 17 GiB on disk:

| Short name  | GGUF file                                            | Type                                    | Native context |     Size |
| ----------- | ---------------------------------------------------- | --------------------------------------- | -------------: | -------: |
| Gemma       | `gemma-4-26B-A4B-it-Q4_K_M.gguf`                     | MoE, about 3.8B active params per token |        262,144 | 15.6 GiB |
| Qwen 3.8    | `Qwen3.8-27B-UD-Q4_K_M.gguf` (unsloth)               | dense 27B with an MTP head              |        262,144 | 15.3 GiB |
| Qwen3-Coder | `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf` (unsloth) | MoE, about 3B active params per token   |        262,144 | 17.3 GiB |
| Muse        | `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`           | dense 30B                               |        131,072 | 15.6 GiB |
| Bielik      | `Bielik-11B-v3.0-Instruct.Q8_0.gguf` (SpeakLeash)    | dense 11B, made for Polish              |         32,768 | 11.1 GiB |

All runs used full GPU offload (`-ngl 99`) and Flash Attention. `pp` is prompt
processing (reading input), `tg` is token generation (writing output), both in
tokens per second.

## Short context

512 and 2,048 input tokens, 128 output tokens, Q8 KV cache:

| Model       | `pp 512` | `pp 2048` |  `tg 128` |
| ----------- | -------: | --------: | --------: |
| Qwen3-Coder |    4,217 |     4,330 | **185.8** |
| Gemma       |    4,917 |     4,877 |     142.7 |
| Bielik      |    3,846 |     3,740 |      64.4 |
| Muse        |    1,778 |     1,756 |      44.8 |
| Qwen 3.8    |    1,563 |     1,568 |      44.5 |

The two Mixture-of-Experts models (Qwen3-Coder, Gemma) write three to four
times faster than the dense 27–30B models, because only about 3–4B of their
parameters work on each token. Bielik is dense too, but at 11B it has less to
compute per token.

## Long context

Speed **after** the cache is filled to the given depth, Q4 KV cache:

| Model       | Filled context |  `pp` |  `tg` | Note                                          |
| ----------- | -------------: | ----: | ----: | --------------------------------------------- |
| Gemma       |             8K | 4,276 | 128.3 |                                               |
| Gemma       |            32K | 3,186 | 109.5 |                                               |
| Gemma       |            64K | 2,310 |  89.8 |                                               |
| Gemma       |           128K | 1,501 |  68.5 |                                               |
| Gemma       |           256K |   886 |  45.8 | about 21.5 GiB VRAM                           |
| Qwen3-Coder |             8K | 3,042 | 126.4 |                                               |
| Qwen3-Coder |            32K | 1,724 |  61.4 |                                               |
| Qwen3-Coder |            64K | 1,105 |  38.0 |                                               |
| Qwen3-Coder |           128K |   556 |  19.4 |                                               |
| Qwen3-Coder |           256K |     — |     — | does not fit in 24 GB, spills into system RAM |
| Qwen 3.8    |             8K | 1,428 |  42.5 |                                               |
| Qwen 3.8    |            32K | 1,147 |  36.5 |                                               |
| Qwen 3.8    |            64K |   897 |  31.3 | about 20 GiB VRAM                             |
| Qwen 3.8    |           128K |   635 |  23.8 | about 21.3 GiB VRAM                           |
| Qwen 3.8    |           256K |   396 |  16.4 | about 24 GiB VRAM, almost nothing spare       |
| Muse        |            32K | 1,463 |  37.2 |                                               |
| Muse        |            64K | 1,271 |  34.6 |                                               |
| Muse        |           128K | 1,011 |  28.8 |                                               |
| Bielik      |             8K | 2,732 |  54.5 |                                               |
| Bielik      |            16K | 2,230 |  47.8 |                                               |
| Bielik      |            30K | 1,628 |  38.8 | just under its 32K limit                      |

`pp` here reads 512 or 2,048 new tokens on top of the filled context.

What this means:

- **Long contexts work, within VRAM.** `llama-server` started and answered
  with the full native window (262,144 for Gemma and Qwen 3.8, 131,072 for
  Muse) on a 24 GB GPU with the Q4 KV cache. Qwen3-Coder needs more cache per
  token: 128K fits, 256K does not.
- **Every token gets slower as the context fills.** Gemma drops from 143 tok/s
  with an empty context to 110 at 32K, 69 at 128K and 46 at 256K; Muse from
  45 to 37 at 32K and 29 at 128K.
- **The fastest empty model is not the fastest full one.** Qwen3-Coder starts
  at 186 tok/s but is down to 61 at 32K and 19 at 128K, below the dense
  Qwen 3.8 (24). Gemma keeps its speed best in long agent sessions.
- **Filling a huge context takes minutes.** Reading 256K tokens took Gemma
  about 170 s, so the first answer to a very long new prompt is slow.
- These are speed tests. They do not measure how well a model recalls
  something from the start of a long context.

## KV cache: Q8 or Q4

The KV cache holds the conversation the model is working on. Compared at the
same 32K fill, 512 tokens in and 64 out:

| Model        | Q8 `pp` / `tg` | Q4 `pp` / `tg` |
| ------------ | -------------: | -------------: |
| Gemma        |  2,981 / 100.5 |  3,099 / 107.4 |
| Qwen3-Coder  |   1,603 / 62.6 |   1,710 / 61.5 |
| Qwen 3.8     |   1,166 / 38.0 |   1,151 / 36.8 |
| Muse         |   1,467 / 39.1 |   1,463 / 37.2 |
| Bielik (30K) |   1,631 / 40.2 |   1,628 / 38.8 |

Speed is nearly the same. Q4 halves the cache's memory again, which is what
makes 128K and 256K fit in 24 GB; it can cost a little accuracy. With a short
context Q4 changes almost nothing (Gemma 139.8 vs 142.7 tok/s, Qwen 3.8 44.3
vs 44.5, Bielik 64.4 vs 64.4).

## Speculative decoding (MTP and DFlash)

A small draft guesses several tokens ahead and the main model checks them in
one pass. Accepted guesses are free speed; the answer is the same as without
drafting. Measured on a running `llama-server`, 8K context, 256 generated
tokens, two prompts (a list and Python code):

| Model and setting      | List, tok/s | Code, tok/s |
| ---------------------- | ----------: | ----------: |
| Qwen 3.8, no draft     |        43.6 |        43.8 |
| Qwen 3.8, MTP 2 tokens |    **71.6** |    **76.0** |
| Qwen 3.8, MTP 3 tokens |        71.2 |           — |
| Muse, no draft         |        44.1 |        44.1 |
| Muse, DFlash 3 tokens  |        57.2 |           — |
| Muse, DFlash 8 tokens  |       106.2 |           — |
| Muse, DFlash 16 tokens |   **121.4** |   **178.5** |

For comparison, without drafting on the same test: Qwen3-Coder 168.6 / 175.6
and Bielik 63.1 / 63.6 tok/s (Bielik 63.2 on a Polish prompt). Neither has an
MTP head.

- The gain depends on the text: predictable output such as code gains most.
- MTP on Qwen 3.8 is what ThreadShelf's **Auto** turns on: about 1.7× faster,
  with 69–77% of the drafted tokens accepted. Drafting 3 tokens gained nothing
  over 2, so Auto drafts 2.
- A longer draft paid off for Muse's separate DFlash drafter (16 beat 8 and 3).
- Drafting was measured with a short context. Do not expect the same factor
  with a 32K-full context.

## Recommended settings

Map these to **Settings → Conversation generation → llama.cpp wrapper**:

| Goal                   | Context window | KV cache          | Speculative (MTP)  | Expect                                                                |
| ---------------------- | -------------: | ----------------- | ------------------ | --------------------------------------------------------------------- |
| Everyday, 24 GB GPU    |            32K | Quality · Q8      | Auto · draft 2     | Qwen3-Coder about 185, Gemma about 140, Qwen 3.8 with MTP 72–76 tok/s |
| Long threads           |            64K | Memory saver · Q4 | Auto · draft 2     | Gemma about 90, Qwen3-Coder 38, Qwen 3.8 31 tok/s once 64K is full    |
| Maximum context, 24 GB |           256K | Memory saver · Q4 | Auto               | Gemma 46, Qwen 3.8 16 tok/s once full; Qwen3-Coder stops at 128K      |
| Polish (Bielik)        |            32K | Quality · Q8      | Auto (no MTP head) | about 64 tok/s; 32K is the model's limit                              |
| Smaller GPU            |      8K to 16K | Memory saver · Q4 | Auto               | Fewer layers spill to the CPU                                         |

Other settings:

- **Acceleration: Auto-fit.** Puts as many layers on the GPU as fit. Every
  layer that spills to the CPU slows generation a lot, so if a model does not
  fit, a smaller quantization or a smaller context usually beats offloading.
- **Flash Attention: Auto.** Required for the quantized KV cache; ThreadShelf
  turns it on when you pick Q8 or Q4.
- **Speculative: Auto** drafts 2 tokens with the model's own MTP/NextN head
  when the GGUF has one (Qwen 3.8 does) and stays off otherwise (Gemma,
  Qwen3-Coder, Muse and Bielik have none).
  **Aggressive** drafts 3: faster on very predictable text, more rejected
  guesses elsewhere.
- **Reasoning effort.** Thinking tokens are generated tokens: at 40 tok/s,
  2,000 tokens of thinking cost 50 seconds before the answer starts. Use Low
  or Off for quick questions.
- **Unload model from memory.** If you also game or render on the same GPU,
  set an idle time so the model frees its VRAM when you stop chatting.

### DFlash and other draft models

ThreadShelf's managed runtime uses only the model's built-in MTP head; it has no
field for a separate draft model. To get Muse's 121–178 tok/s, run your own
`llama-server` on loopback and point ThreadShelf at it:

```powershell
$server = '.\.threadshelf\tools\llama.cpp\<build>\llama-server.exe'
& $server -m <Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf> `
  -md <dflash-Muse-Glimmer-30B-Q4_K_M.gguf> -ngld 99 --spec-draft-n-max 16 `
  -c 32768 -np 1 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 --jinja --host 127.0.0.1 --port 8080
```

Then set **Existing local server URL** to `http://127.0.0.1:8080`. The chat and
the [local model API](LOCAL_API.md) both use that server. For 128K and longer
use `-ctk q4_0 -ctv q4_0`; always give K and V the same type.

The same route works for vision: start `llama-server` with `--mmproj <file>`
and the `/v1` API forwards image messages to it unchanged. One Gemma test read
a screenshot (682 tokens) in about 1 s and answered at about 125 tok/s; that
llama.cpp build needed `-b 4096 -ub 4096` with the projector loaded.

## What tokens per second means for an agent

Tokens per second is writing speed, not task time. Time to write 1,000 tokens
with a short context, from the server tests:

| Model and setting        | 1,000 tokens |
| ------------------------ | -----------: |
| Qwen3-Coder, no drafting |    about 6 s |
| Gemma, no drafting       |    about 7 s |
| Muse, DFlash 16          |        6–8 s |
| Qwen 3.8, MTP 2          |      13–14 s |
| Bielik, no drafting      |   about 16 s |

Once the history reaches 32K, without drafting: Gemma about 10 s, Qwen3-Coder
about 16 s, Bielik (30K) about 25 s, Qwen 3.8 and Muse about 26 s per 1,000
tokens. A coding agent (Claude Code, Codex, …)
also reads files, runs commands and tests, and re-reads its growing history at
every step, so a full task takes minutes. Agents need a large context window:
start at 32K and use 64K with the Q4 cache if the agent runs out of room.

## Measure your own machine

`llama-bench` ships with llama.cpp next to `llama-server`. Close ThreadShelf's
chat first (or click **Eject**) so the model is not loaded twice.

Short test, like the first table:

```powershell
$bench = '.\.threadshelf\tools\llama.cpp\<build>\llama-bench.exe'
& $bench -m <model.gguf> -p 512,2048 -n 128 -r 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0
```

Speed with a filled 32K context (`-d` fills the cache first; long depths take
minutes):

```powershell
& $bench -m <model.gguf> -d 32768 -p 512 -n 64 -r 1 -ngl 99 -fa on -ctk q4_0 -ctv q4_0
```

On Linux the flags are the same: `~/llama.cpp/build/bin/llama-bench -m model.gguf …`.
Replace `<build>` with the folder name under `.threadshelf/tools/llama.cpp/`
(for example `b10809-cuda`). The runtime log in **Settings** shows which flags
ThreadShelf actually used, and how many layers went to the GPU.
