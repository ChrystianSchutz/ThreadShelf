import { useCallback, useState } from 'react';
import { useLocalApiStatusQuery } from '../queries';
import type { GenerationConfig } from '../types';
import { LocalApiGuide, type GuideTab } from './LocalApiGuide';
import { copyText } from '../utils';

type ExampleId = 'curl' | 'openai' | 'anthropic';

const EXAMPLES: readonly { readonly id: ExampleId; readonly label: string }[] = [
  { id: 'curl', label: 'curl' },
  { id: 'openai', label: 'OpenAI SDK' },
  { id: 'anthropic', label: 'Anthropic SDK' },
];

const ENDPOINTS = [
  'GET /v1/models',
  'POST /v1/chat/completions',
  'POST /v1/completions',
  'POST /v1/responses',
  'POST /v1/messages',
  'POST /v1/models/unload',
];

/** Unsaved edits to the local API settings, owned by the settings form. */
export interface LocalApiDraft {
  readonly enabled: boolean;
  /** A new key to save; empty keeps the current one. */
  readonly apiKey: string;
  readonly clearApiKey: boolean;
  readonly networkAccess: boolean;
  readonly networkPort: string;
}

export const localApiDraftFrom = (config: GenerationConfig['localApi']): LocalApiDraft => ({
  enabled: config?.enabled ?? true,
  apiKey: '',
  clearApiKey: false,
  networkAccess: config?.networkAccess ?? false,
  networkPort: String(config?.networkPort ?? 3001),
});

export const isValidNetworkPort = (value: string): boolean =>
  /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535;

const generateKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `ts-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const example = (id: ExampleId, origin: string, model: string, key: string): string => {
  switch (id) {
    case 'curl':
      return `curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\${key ? `\n  -H "Authorization: Bearer ${key}" \\` : ''}
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    case 'openai':
      return `from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="${key || 'threadshelf'}")
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;
    case 'anthropic':
      // Anthropic SDKs append /v1 themselves, so their base URL is the origin.
      return `from anthropic import Anthropic

client = Anthropic(base_url="${origin}", api_key="${key || 'threadshelf'}")
message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)`;
  }
};

interface LocalApiPanelProps {
  readonly generationConfig: GenerationConfig | undefined;
  /** Open guide tab, owned by the settings page so other panels can open it. */
  readonly guide: GuideTab | null;
  readonly onGuide: (tab: GuideTab | null) => void;
  readonly draft: LocalApiDraft;
  readonly onChange: (patch: Partial<LocalApiDraft>) => void;
}

/** Connection details and access settings for the OpenAI/Anthropic-compatible API at /v1. */
export function LocalApiPanel({
  generationConfig,
  guide,
  onGuide,
  draft,
  onChange,
}: LocalApiPanelProps) {
  const config = generationConfig?.localApi;
  const { data: status, error, isLoading } = useLocalApiStatusQuery();
  const [selectedModel, setSelectedModel] = useState('');
  const [exampleId, setExampleId] = useState<ExampleId>('curl');
  const [copied, setCopied] = useState('');

  const models = status?.models ?? undefined;
  const origin = window.location.origin;
  const baseUrl = `${origin}/v1`;
  const model =
    models?.find((candidate) => candidate.id === selectedModel)?.id ??
    models?.[0]?.id ??
    'your-model-id';
  const keyRequired = draft.apiKey
    ? true
    : Boolean(config?.apiKeyConfigured) &&
      !(draft.clearApiKey && config?.apiKeySource === 'settings');
  const exampleKey = draft.apiKey || (keyRequired ? 'YOUR_API_KEY' : '');
  const code = example(exampleId, origin, model, exampleKey);
  const network = status?.network;
  const portValid = isValidNetworkPort(draft.networkPort);

  const copy = useCallback((key: string, text: string) => {
    void copyText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1400);
  }, []);

  return (
    <div className="panel generation-panel">
      <div className="panel-head">
        <h3>Local model API</h3>
        <span className="sub">OpenAI · Anthropic compatible</span>
        <button
          type="button"
          className="btn sm panel-head-action"
          onClick={() => onGuide('status')}
        >
          Guide: status &amp; connect an app
        </button>
      </div>
      <LocalApiGuide
        tab={guide}
        onTab={onGuide}
        config={generationConfig}
        model={models?.some((candidate) => candidate.id === model) ? model : undefined}
      />
      <div className="panel-body local-api">
        <p className="setup-note">
          Use your local models from any app that speaks the OpenAI or Anthropic API, the same way
          you would with LM Studio or Ollama. The model named in a request loads on first use and
          replaces the one in memory. These requests are not saved to your archive, and the master
          prompt is not added to them.
        </p>

        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          Serve the local model API at /v1
        </label>

        <div className="local-api-row">
          <span className="local-api-label">Base URL</span>
          <code className="local-api-value">{baseUrl}</code>
          <button type="button" className="btn sm ghost" onClick={() => copy('url', baseUrl)}>
            {copied === 'url' ? 'copied' : 'copy'}
          </button>
        </div>

        {network?.state === 'listening' &&
          network.urls.map((url) => (
            <div className="local-api-row" key={url}>
              <span className="local-api-label">Network URL</span>
              <code className="local-api-value">{url}</code>
              <button type="button" className="btn sm ghost" onClick={() => copy(url, url)}>
                {copied === url ? 'copied' : 'copy'}
              </button>
            </div>
          ))}

        <div className="local-api-row">
          <label className="local-api-label" htmlFor="local-api-model">
            Model id
          </label>
          {models && models.length > 0 ? (
            <select
              id="local-api-model"
              value={model}
              onChange={(event) => setSelectedModel(event.target.value)}
            >
              {models.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id}
                  {candidate.loaded ? ' · loaded' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="local-api-value muted">
              {isLoading
                ? 'Loading models…'
                : error
                  ? error.message
                  : (status?.modelsError ??
                    'No GGUF models found yet. Download one or add a model directory.')}
            </span>
          )}
          <button
            type="button"
            className="btn sm ghost"
            disabled={!models?.length}
            onClick={() => copy('model', model)}
          >
            {copied === 'model' ? 'copied' : 'copy'}
          </button>
        </div>

        <div className="generation-form local-api-access">
          <label>
            <span>API key (optional)</span>
            <div className="local-api-key">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.apiKey}
                disabled={config?.apiKeySource === 'env'}
                onChange={(event) => onChange({ apiKey: event.target.value, clearApiKey: false })}
                placeholder={
                  config?.apiKeySource === 'env'
                    ? 'Set by THREADSHELF_API_KEY'
                    : config?.apiKeyConfigured
                      ? 'A key is configured · type to replace it'
                      : 'Empty · no key required'
                }
              />
              {config?.apiKeySource !== 'env' && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => onChange({ apiKey: generateKey(), clearApiKey: false })}
                >
                  Generate
                </button>
              )}
              {draft.apiKey && (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => copy('key', draft.apiKey)}
                >
                  {copied === 'key' ? 'copied' : 'copy'}
                </button>
              )}
            </div>
            <small>
              {keyRequired
                ? 'Requests must send the key as "Authorization: Bearer <key>" or "x-api-key". Copy a new key before saving: it is not shown again.'
                : 'No key: any program on this computer can use the API, as with LM Studio and Ollama. Set one if a client insists on a key or other devices connect.'}
            </small>
          </label>
          {config?.apiKeySource === 'settings' && !draft.apiKey && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.clearApiKey}
                onChange={(event) => onChange({ clearApiKey: event.target.checked })}
              />
              Remove the saved key
            </label>
          )}

          <label className="check-field">
            <input
              type="checkbox"
              checked={draft.networkAccess}
              onChange={(event) => onChange({ networkAccess: event.target.checked })}
            />
            Serve on the local network
          </label>
          {draft.networkAccess && (
            <label>
              <span>Network port</span>
              <input
                type="number"
                min={1}
                max={65_535}
                value={draft.networkPort}
                aria-invalid={!portValid}
                onChange={(event) => onChange({ networkPort: event.target.value })}
              />
              <small>
                Other devices connect to this port, which serves only /v1. Your archive and settings
                stay reachable from this computer only.
                {!keyRequired && ' Without a key, anyone on your network can use your models.'}
              </small>
            </label>
          )}
          {network?.state === 'error' && <div className="banner err">{network.error}</div>}
        </div>

        <div className="local-api-endpoints" aria-label="Endpoints">
          {ENDPOINTS.map((endpoint) => (
            <code key={endpoint}>{endpoint}</code>
          ))}
        </div>

        <div className="local-api-example">
          <div className="local-api-tabs" role="tablist" aria-label="Example client">
            {EXAMPLES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={exampleId === option.id}
                data-active={exampleId === option.id}
                onClick={() => setExampleId(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <pre>
            <code>{code}</code>
            <button type="button" className="btn sm ghost" onClick={() => copy('code', code)}>
              {copied === 'code' ? 'copied' : 'copy'}
            </button>
          </pre>
        </div>
      </div>
    </div>
  );
}
