import { useCallback, useState } from 'react';
import { useLocalApiModelsQuery } from '../queries';
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
];

const example = (id: ExampleId, origin: string, model: string): string => {
  switch (id) {
    case 'curl':
      return `curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    case 'openai':
      return `from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="threadshelf")
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;
    case 'anthropic':
      // Anthropic SDKs append /v1 themselves, so their base URL is the origin.
      return `from anthropic import Anthropic

client = Anthropic(base_url="${origin}", api_key="threadshelf")
message = client.messages.create(
    model="${model}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)`;
  }
};

/** Connection details for the OpenAI/Anthropic-compatible API served at /v1. */
export function LocalApiPanel() {
  const { data: models, error, isLoading } = useLocalApiModelsQuery();
  const [selectedModel, setSelectedModel] = useState('');
  const [exampleId, setExampleId] = useState<ExampleId>('curl');
  const [copied, setCopied] = useState('');

  const origin = window.location.origin;
  const baseUrl = `${origin}/v1`;
  const model =
    models?.find((candidate) => candidate.id === selectedModel)?.id ??
    models?.[0]?.id ??
    'your-model-id';
  const code = example(exampleId, origin, model);

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
      </div>
      <div className="panel-body local-api">
        <p className="setup-note">
          Use your local models from any app that speaks the OpenAI or Anthropic API, the same way
          you would with LM Studio or Ollama. The model named in a request loads on first use. No
          API key is checked, so send any value. Only this machine can connect. These requests are
          not saved to your archive, and the master prompt is not added to them.
        </p>

        <div className="local-api-row">
          <span className="local-api-label">Base URL</span>
          <code className="local-api-value">{baseUrl}</code>
          <button type="button" className="btn sm ghost" onClick={() => copy('url', baseUrl)}>
            {copied === 'url' ? 'copied' : 'copy'}
          </button>
        </div>

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
                </option>
              ))}
            </select>
          ) : (
            <span className="local-api-value muted">
              {isLoading
                ? 'Loading models…'
                : error
                  ? error.message
                  : 'No GGUF models found yet. Download one or add a model directory.'}
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
