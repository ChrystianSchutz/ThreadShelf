import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocalApiStatusQuery } from '../queries';
import type { GenerationConfig } from '../types';
import { copyText } from '../utils';

export type GuideTab = 'status' | 'connect' | 'settings';
type ClientId = 'claude-code' | 'codex' | 'deepseek' | 'other';
type Shell = 'powershell' | 'bash';

const TABS: readonly { readonly id: GuideTab; readonly label: string }[] = [
  { id: 'status', label: 'What works now' },
  { id: 'connect', label: 'Connect an app' },
  { id: 'settings', label: 'Settings explained' },
];

const CLIENTS: readonly { readonly id: ClientId; readonly label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'deepseek', label: 'DeepSeek Harness' },
  { id: 'other', label: 'Any other app' },
];

interface GuideProps {
  /** The tab to show, or null when the guide is closed. */
  readonly tab: GuideTab | null;
  readonly onTab: (tab: GuideTab | null) => void;
  readonly config: GenerationConfig | undefined;
  /** Model id the examples use; defaults to the loaded or first model. */
  readonly model?: string;
}

/** Copyable code block. */
function Snippet({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre className="guide-snippet">
      <code>{code}</code>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          void copyText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </pre>
  );
}

function StatusRow({
  label,
  ok,
  children,
}: {
  readonly label: string;
  readonly ok: boolean | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="guide-status-row" data-ok={ok === null ? 'neutral' : ok}>
      <span className="guide-status-dot" aria-hidden="true" />
      <span className="guide-status-label">{label}</span>
      <span className="guide-status-value">{children}</span>
    </div>
  );
}

const idleText = (minutes: number | undefined): string => {
  if (!minutes) return 'Never. A loaded model stays in memory until another model or Eject.';
  if (minutes % 1440 === 0) return `After ${minutes / 1440} day(s) without requests.`;
  if (minutes % 60 === 0) return `After ${minutes / 60} hour(s) without requests.`;
  return `After ${minutes} minutes without requests.`;
};

/** Environment variables differ only in syntax between shells. */
const envLines = (shell: Shell, vars: readonly (readonly [string, string])[]): string =>
  vars
    .map(([name, value]) =>
      shell === 'powershell' ? `$env:${name} = "${value}"` : `export ${name}="${value}"`,
    )
    .join('\n');

function ConnectInstructions({
  client,
  shell,
  origin,
  model,
  apiKey,
  keyRequired,
}: {
  readonly client: ClientId;
  readonly shell: Shell;
  readonly origin: string;
  readonly model: string;
  readonly apiKey: string;
  readonly keyRequired: boolean;
}) {
  switch (client) {
    case 'claude-code':
      return (
        <>
          <ol className="guide-steps">
            <li>Load a model with a long context: 32K at least, 64K is better for agents.</li>
            <li>
              Run these lines in the terminal where you start Claude Code. They last until you close
              the terminal.
            </li>
          </ol>
          <Snippet
            code={`${envLines(shell, [
              ['ANTHROPIC_BASE_URL', origin],
              ['ANTHROPIC_AUTH_TOKEN', apiKey],
              ['ANTHROPIC_MODEL', model],
              ['ANTHROPIC_DEFAULT_HAIKU_MODEL', model],
            ])}\nclaude`}
          />
          <ul className="guide-notes">
            <li>
              The base URL has <b>no</b> <code>/v1</code>: Claude Code adds it and calls{' '}
              <code>/v1/messages</code>.
            </li>
            <li>
              Both model variables use the <b>same</b> id. ThreadShelf keeps one model in memory, so
              a second model for background tasks would reload models all the time.
            </li>
            <li>
              {keyRequired
                ? 'Use your ThreadShelf API key as the token.'
                : 'No key is set in ThreadShelf, so any token works.'}
            </li>
          </ul>
        </>
      );
    case 'codex':
      return (
        <>
          <ol className="guide-steps">
            <li>
              Open <code>~/.codex/config.toml</code> (on Windows{' '}
              <code>%USERPROFILE%\.codex\config.toml</code>) and add:
            </li>
          </ol>
          <Snippet
            code={`model = "${model}"
model_provider = "threadshelf"

[model_providers.threadshelf]
name = "ThreadShelf"
base_url = "${origin}/v1"
wire_api = "responses"${keyRequired ? '\nenv_key = "THREADSHELF_API_KEY"' : ''}`}
          />
          {keyRequired && (
            <>
              <ol className="guide-steps" start={2}>
                <li>Put the key where Codex can read it, then start Codex:</li>
              </ol>
              <Snippet code={`${envLines(shell, [['THREADSHELF_API_KEY', apiKey]])}\ncodex`} />
            </>
          )}
          <ul className="guide-notes">
            <li>
              <code>wire_api = "responses"</code> is required: current Codex versions refuse to
              start with <code>"chat"</code>. ThreadShelf serves <code>/v1/responses</code>.
            </li>
            <li>Codex is an agent: give the model 32K or more of context.</li>
          </ul>
        </>
      );
    case 'deepseek':
      return (
        <>
          <ol className="guide-steps">
            <li>
              In DeepSeek Harness open <b>Settings → Models → Add a custom provider</b> and enter
              the values below. Or add the same block to <code>$DSH_HOME/settings.yaml</code>:
            </li>
          </ol>
          <Snippet
            code={`llm-pi-ai:
  providers:
    threadshelf:
      displayName: ThreadShelf
      apiKeyEnv: THREADSHELF_API_KEY
      api: openai-completions
      baseURL: ${origin}/v1
      models:
        - id: ${model}`}
          />
          <ol className="guide-steps" start={2}>
            <li>
              The harness reads the key from an environment variable, so set it even when
              ThreadShelf has no key, then start the harness from that terminal:
            </li>
          </ol>
          <Snippet
            code={`${envLines(shell, [['THREADSHELF_API_KEY', apiKey]])}\nnpx @deepseek-ai/dsh web`}
          />
          <ul className="guide-notes">
            <li>
              Pick <b>ThreadShelf</b> and the model in the session's model picker.
            </li>
            <li>
              If your harness version names the fields differently, the values are: base URL{' '}
              <code>{origin}/v1</code>, protocol OpenAI-compatible (chat completions), model id{' '}
              <code>{model}</code>.
            </li>
          </ul>
        </>
      );
    case 'other':
      return (
        <>
          <p className="guide-text">
            Choose the app's <b>OpenAI-compatible</b> (or "custom OpenAI") provider, not an Ollama
            preset, and fill in:
          </p>
          <div className="guide-fields">
            <span>Base URL</span>
            <code>{origin}/v1</code>
            <span>API key</span>
            <code>{keyRequired ? 'your ThreadShelf key' : 'anything, e.g. threadshelf'}</code>
            <span>Model</span>
            <code>{model}</code>
          </div>
          <p className="guide-text">
            Apps built on the Anthropic SDK use the base URL <code>{origin}</code>, without{' '}
            <code>/v1</code>.
          </p>
          <ul className="guide-notes">
            <li>
              An app in Docker, a VM or on another device cannot reach this address. Turn on{' '}
              <b>Serve on the local network</b> and use the network URL instead.
            </li>
            <li>
              A "connection refused" error means ThreadShelf is not running; 401 means the key is
              wrong; 403 means the app is not on this computer (or the API is off).
            </li>
          </ul>
        </>
      );
  }
}

const SETTINGS_HELP: readonly {
  readonly group: string;
  readonly items: readonly {
    readonly name: string;
    readonly what: string;
    readonly pick: string;
  }[];
}[] = [
  {
    group: 'Local model API',
    items: [
      {
        name: 'Serve the local model API',
        what: 'Lets other programs on this computer use your models through the /v1 address, like LM Studio or Ollama.',
        pick: 'Leave on. Turn off if you never use other apps with ThreadShelf models.',
      },
      {
        name: 'API key',
        what: 'A password other apps must send. Empty means no password: any program on this computer may use the models.',
        pick: 'Leave empty for use on this computer. Set one (Generate) when an app insists on a key or other devices connect.',
      },
      {
        name: 'Serve on the local network',
        what: 'Opens a second port so phones, laptops or Docker containers can use your models. Only the model API is shared, never your archive.',
        pick: 'Off unless another device needs it. When on, also set an API key.',
      },
      {
        name: 'Network port',
        what: 'The port other devices connect to, e.g. http://192.168.1.50:3001/v1.',
        pick: '3001, unless something else already uses it.',
      },
    ],
  },
  {
    group: 'Memory',
    items: [
      {
        name: 'Unload model from memory',
        what: 'Frees the GPU memory (VRAM) once nobody has used the model for this long. The next message loads it again, which takes a few seconds to a minute.',
        pick: 'Never if the computer is only for AI. 15–30 minutes if you also game or edit video on the same GPU.',
      },
      {
        name: 'Eject',
        what: 'Unloads the model right now. Same as POST /v1/models/unload.',
        pick: 'Use before starting a game or another GPU-heavy program.',
      },
    ],
  },
  {
    group: 'llama.cpp model settings',
    items: [
      {
        name: 'Context window',
        what: 'How much text the model can keep in mind at once: the conversation, files an agent reads, and the answer. Bigger needs more VRAM and gets slower as it fills.',
        pick: '32K on a 24 GB GPU. 64K for coding agents (with the Memory saver KV cache). 8–16K on smaller GPUs.',
      },
      {
        name: 'KV cache',
        what: 'How precisely that context is stored. Q8 is near lossless; Q4 uses half the memory so a longer context fits.',
        pick: 'Quality · Q8. Memory saver · Q4 for 64K and more.',
      },
      {
        name: 'Acceleration profile',
        what: 'Where the model runs. Layers that do not fit on the GPU run on the much slower CPU.',
        pick: 'Auto-fit. Change only if the runtime log shows a problem.',
      },
      {
        name: 'Flash Attention',
        what: 'A faster way to compute attention that also saves memory. Needed for the Q8/Q4 KV cache.',
        pick: 'Auto.',
      },
      {
        name: 'Speculative decoding (MTP)',
        what: 'Lets the model guess a few words ahead with its own built-in helper and check them in one step. Same answers, faster. Only models with an MTP head (e.g. Qwen 3.8) use it.',
        pick: 'Auto · draft 2. In tests Qwen 3.8 went from 44 to 72–76 tokens per second; it turns itself off for models without an MTP head.',
      },
      {
        name: 'Reasoning effort',
        what: 'How long thinking models think before answering. Thinking is written text too, so it takes time.',
        pick: 'Medium. Low or Off for quick questions.',
      },
      {
        name: 'CPU threads',
        what: 'CPU cores used for the parts that run on the CPU.',
        pick: '-1 (automatic).',
      },
      {
        name: 'Existing local server URL',
        what: 'Use a llama-server you started yourself instead of the one ThreadShelf manages, e.g. for a draft model or vision.',
        pick: 'Empty, unless you know you need it.',
      },
    ],
  },
];

/** Plain-language help for the local model API: status, client setup, settings. */
export function LocalApiGuide({ tab, onTab, config, model: chosenModel }: GuideProps) {
  const { data: status } = useLocalApiStatusQuery();
  const open = tab !== null;
  const onClose = useCallback(() => onTab(null), [onTab]);
  const [client, setClient] = useState<ClientId>('claude-code');
  const [shell, setShell] = useState<Shell>(() =>
    /windows/i.test(navigator.userAgent) ? 'powershell' : 'bash',
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  if (!open) return null;

  const api = config?.localApi;
  const enabled = api?.enabled ?? true;
  const keyRequired = Boolean(api?.apiKeyConfigured);
  const origin = window.location.origin;
  const models = status?.models ?? [];
  const loaded = models.find((model) => model.loaded);
  const model = chosenModel ?? loaded?.id ?? models[0]?.id ?? 'your-model-id';
  const key = keyRequired ? 'YOUR_THREADSHELF_KEY' : 'threadshelf';
  const network = status?.network;
  const external = config?.llamaCpp.baseUrl;

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal-card guide-modal"
        role="dialog"
        aria-label="Local model API guide"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head guide-head">
          <div>
            <h3>Local model API guide</h3>
            <p>Use the models in ThreadShelf from coding agents and other apps.</p>
          </div>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="local-api-tabs guide-tabs" role="tablist">
          {TABS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={tab === option.id}
              data-active={tab === option.id}
              onClick={() => onTab(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="guide-body">
          {tab === 'status' && (
            <>
              <div className="guide-status">
                <StatusRow label="API" ok={enabled}>
                  {enabled
                    ? `On at ${origin}/v1`
                    : 'Off. Apps get "403 api_disabled". Turn it on in Local model API.'}
                </StatusRow>
                <StatusRow label="Who can use it" ok={null}>
                  {network?.state === 'listening'
                    ? `This computer, and other devices at ${network.urls.join(', ') || `port ${network.port}`}`
                    : 'Only programs on this computer.'}
                </StatusRow>
                <StatusRow label="API key" ok={null}>
                  {api?.apiKeySource === 'env'
                    ? 'Required. Set by THREADSHELF_API_KEY.'
                    : keyRequired
                      ? 'Required. Apps must send the key you saved.'
                      : 'Not required. Apps may send any key, or none.'}
                </StatusRow>
                {network?.state === 'error' && (
                  <StatusRow label="Network port" ok={false}>
                    {network.error}
                  </StatusRow>
                )}
                <StatusRow label="Model in memory" ok={null}>
                  {loaded
                    ? `${loaded.id}. Requests for it answer right away.`
                    : 'None. The first request loads the model it names.'}
                </StatusRow>
                <StatusRow label="Unload when idle" ok={null}>
                  {idleText(config?.llamaCpp.idleUnloadMinutes)}
                </StatusRow>
                <StatusRow label="Engine" ok={null}>
                  {external
                    ? `Your own llama-server at ${external}.`
                    : 'llama.cpp managed by ThreadShelf, one model at a time.'}
                </StatusRow>
                <StatusRow label="Models available" ok={models.length > 0}>
                  {models.length > 0
                    ? `${models.length}: ${models
                        .slice(0, 4)
                        .map((entry) => entry.id)
                        .join(', ')}${models.length > 4 ? ', …' : ''}`
                    : (status?.modelsError ?? 'None yet. Download one in Settings.')}
                </StatusRow>
              </div>

              <h4 className="guide-subhead">What the API can do</h4>
              <table className="guide-table">
                <tbody>
                  <tr>
                    <td>
                      <code>GET /v1/models</code>
                    </td>
                    <td>List your models; the loaded one has "loaded": true.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/chat/completions</code>
                    </td>
                    <td>Chat, OpenAI style. Used by most apps.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/responses</code>
                    </td>
                    <td>OpenAI Responses API. Used by Codex.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/messages</code>
                    </td>
                    <td>Chat, Anthropic style. Used by Claude Code.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/completions</code>
                    </td>
                    <td>Plain text completion (older apps).</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/models/unload</code>
                    </td>
                    <td>Free the GPU memory now.</td>
                  </tr>
                </tbody>
              </table>
              <p className="guide-text">
                Streaming, tool calls and JSON output work as llama.cpp supports them. Not
                available: embeddings, images, audio and Ollama's own <code>/api</code> routes.
                Requests from apps are never saved to your archive.
              </p>
              <p className="guide-text">
                <b>One model at a time.</b> Asking for another model swaps it in, freeing the old
                one's memory first. While one model is answering, a request for a different model
                gets "503 model_busy" and apps retry.
              </p>
            </>
          )}

          {tab === 'connect' && (
            <>
              <div className="guide-pickers">
                <div className="local-api-tabs" role="tablist" aria-label="App">
                  {CLIENTS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="tab"
                      aria-selected={client === option.id}
                      data-active={client === option.id}
                      onClick={() => setClient(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {client !== 'other' && (
                  <div className="local-api-tabs" role="tablist" aria-label="Shell">
                    {(['powershell', 'bash'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="tab"
                        aria-selected={shell === option}
                        data-active={shell === option}
                        onClick={() => setShell(option)}
                      >
                        {option === 'powershell' ? 'Windows PowerShell' : 'macOS / Linux'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!enabled && (
                <div className="banner warn">The API is off. Turn it on before connecting.</div>
              )}
              <p className="guide-text">
                Filled in with <code>{model}</code>
                {loaded?.id === model ? ' (loaded now)' : ''}. Pick another model id in the Local
                model API panel to change the examples.
              </p>
              <ConnectInstructions
                client={client}
                shell={shell}
                origin={origin}
                model={model}
                apiKey={key}
                keyRequired={keyRequired}
              />
            </>
          )}

          {tab === 'settings' &&
            SETTINGS_HELP.map((section) => (
              <section key={section.group} className="guide-settings">
                <h4 className="guide-subhead">{section.group}</h4>
                <dl>
                  {section.items.map((item) => (
                    <div key={item.name} className="guide-setting">
                      <dt>{item.name}</dt>
                      <dd>
                        {item.what}
                        <span className="guide-pick">If unsure: {item.pick}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
