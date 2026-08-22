import { useEffect, useState } from 'react';
import { api } from '../api';
import type {
  GenerationConfigResponse,
  GenerationModel,
  LlamaAccelerationMode,
  LlamaFlashAttention,
  LlamaSplitMode,
} from '../types';
import { toast } from '../toast';
import { DirectoryPicker } from './DirectoryPicker';
import { GenerationRuntimeBadge } from './GenerationRuntimeBadge';
import { ModelCatalogModal } from './ModelCatalogModal';
import { NumberCombobox } from './NumberCombobox';
import { QuickSetupPanel } from './QuickSetupPanel';

const joinDirectories = (directories: readonly string[]): string => directories.join('\n');

// Presets are a convenience only — the field accepts any size the server allows.
const CONTEXT_SIZE_PRESETS = [4096, 8192, 16_384, 32_768, 65_536, 131_072] as const;
const CONTEXT_SIZE_LABELS: Record<number, string> = {
  4096: '4k · light',
  8192: '8k · balanced',
  16_384: '16k',
  32_768: '32k',
  65_536: '64k · high memory',
  131_072: '128k · very high memory',
};

const ACCELERATION_HELP: Record<LlamaAccelerationMode, string> = {
  auto: 'Recommended. llama.cpp fits as many layers as possible to available accelerators, then uses CPU.',
  cpu: 'CPU only. Most compatible, but usually slower for generation.',
  gpu: 'Single GPU maximum. Loads all possible model layers on the selected GPU.',
  hybrid: 'CPU + GPU. Offloads an exact number of layers and keeps the rest on CPU.',
  'multi-gpu': 'Loads all possible layers and distributes work across multiple GPUs.',
};

export function GenerationSettings() {
  const [data, setData] = useState<GenerationConfigResponse | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [executablePath, setExecutablePath] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [directories, setDirectories] = useState('');
  const [contextSize, setContextSize] = useState('8192');
  const [acceleration, setAcceleration] = useState<LlamaAccelerationMode>('auto');
  const [gpuLayers, setGpuLayers] = useState(20);
  const [splitMode, setSplitMode] = useState<LlamaSplitMode>('layer');
  const [mainGpu, setMainGpu] = useState(0);
  const [tensorSplit, setTensorSplit] = useState('');
  const [threads, setThreads] = useState(-1);
  const [flashAttention, setFlashAttention] = useState<LlamaFlashAttention>('auto');
  const [apiKey, setApiKey] = useState('');
  const [enforceZdr, setEnforceZdr] = useState(false);
  const [denyDataCollection, setDenyDataCollection] = useState(false);
  const [persistErrorLogs, setPersistErrorLogs] = useState(true);
  const [models, setModels] = useState<GenerationModel[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const applyData = (next: GenerationConfigResponse) => {
    setData(next);
    setExecutablePath(next.config.llamaCpp.executablePath ?? '');
    setBaseUrl(next.config.llamaCpp.baseUrl ?? '');
    // Only user-configured roots are editable. Conventional and env roots remain runtime-only.
    setDirectories(joinDirectories(next.config.llamaCpp.modelDirectories));
    setContextSize(String(next.config.llamaCpp.contextSize));
    setAcceleration(next.config.llamaCpp.acceleration);
    setGpuLayers(next.config.llamaCpp.gpuLayers);
    setSplitMode(next.config.llamaCpp.splitMode);
    setMainGpu(next.config.llamaCpp.mainGpu);
    setTensorSplit(next.config.llamaCpp.tensorSplit ?? '');
    setThreads(next.config.llamaCpp.threads);
    setFlashAttention(next.config.llamaCpp.flashAttention);
    setEnforceZdr(next.config.openRouter.enforceZdr);
    setDenyDataCollection(next.config.openRouter.denyDataCollection);
    setPersistErrorLogs(next.config.diagnostics?.persistErrorLogs ?? true);
  };

  useEffect(() => {
    const controller = new AbortController();
    void api
      .generationConfig(controller.signal)
      .then(applyData)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Could not load generation settings.');
      });
    return () => controller.abort();
  }, []);

  const parsedContextSize = Number(contextSize);
  const contextSizeValid =
    /^\d+$/.test(contextSize) && parsedContextSize >= 512 && parsedContextSize <= 1_048_576;

  const save = async () => {
    if (!contextSizeValid) {
      setError('Context window must be a whole number from 512 to 1,048,576 tokens.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const next = await api.updateGenerationConfig({
        llamaCpp: {
          executablePath,
          baseUrl,
          modelDirectories: directories
            .split(/\r?\n/)
            .map((path) => path.trim())
            .filter(Boolean),
          contextSize: parsedContextSize,
          acceleration,
          gpuLayers,
          splitMode,
          mainGpu,
          tensorSplit,
          threads,
          flashAttention,
        },
        openRouter: {
          apiKey: apiKey || undefined,
          enforceZdr,
          denyDataCollection,
        },
        diagnostics: { persistErrorLogs },
      });
      applyData(next);
      setApiKey('');
      setModels(null);
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      toast.success('Generation settings saved.');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not save settings.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const scanModels = async () => {
    setModels(null);
    setError('');
    try {
      const response = await api.generationModels('llama-cpp');
      setModels(response.models);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Model scan failed.');
    }
  };

  const addDirectory = (path: string) => {
    const current = directories
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!current.includes(path)) setDirectories([...current, path].join('\n'));
  };

  return (
    <section className="generation-settings" aria-labelledby="generation-settings-title">
      <div className="section-h">
        <h2 id="generation-settings-title">Conversation generation</h2>
      </div>

      <div className="banner warn">
        llama.cpp stays local. OpenRouter sends the selected archived conversation and new prompts
        to OpenRouter and its downstream provider.
      </div>

      {error && <div className="banner err">{error}</div>}

      <GenerationRuntimeBadge detailed />

      <QuickSetupPanel onCompleted={() => void scanModels()} />

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>llama.cpp wrapper</h3>
          <span className="sub">local · primary engine</span>
        </div>
        <div className="panel-body generation-form">
          <label>
            <span>llama-server executable</span>
            <input
              value={executablePath}
              onChange={(event) => setExecutablePath(event.target.value)}
              placeholder="Auto-detect from PATH or .threadshelf/tools"
            />
          </label>
          <label>
            <span>Existing local server URL (optional)</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:8080"
            />
          </label>
          <label>
            <span>Model directories — one absolute path per line</span>
            <textarea
              value={directories}
              onChange={(event) => setDirectories(event.target.value)}
              rows={6}
            />
            <DirectoryPicker
              initialPath={directories.split(/\r?\n/).find((path) => path.trim())}
              onSelect={addDirectory}
            />
            {data?.config.llamaCpp.defaultModelDirectories.length ? (
              <small>
                Also scanning {data.config.llamaCpp.defaultModelDirectories.length} default or
                environment-provided model roots. These are not saved in this field.
              </small>
            ) : null}
          </label>
          <div className="llama-runtime-config">
            <label>
              <span>Acceleration profile</span>
              <select
                value={acceleration}
                onChange={(event) => setAcceleration(event.target.value as LlamaAccelerationMode)}
              >
                <option value="auto">Auto-fit (recommended)</option>
                <option value="cpu">CPU only</option>
                <option value="gpu">Single GPU · maximum offload</option>
                <option value="hybrid">CPU + GPU · selected layers</option>
                <option value="multi-gpu">Multi-GPU</option>
              </select>
              <small>{ACCELERATION_HELP[acceleration]}</small>
            </label>
            <label>
              <span>Context window</span>
              <NumberCombobox
                id="llamaContextSize"
                label="Context window in tokens"
                value={contextSize}
                onChange={setContextSize}
                options={CONTEXT_SIZE_PRESETS}
                optionLabel={(value) => CONTEXT_SIZE_LABELS[value] ?? value.toLocaleString()}
                invalid={!contextSizeValid}
                title="Pick a preset or type any whole number from 512 to 1,048,576 tokens"
              />
              <small>
                {contextSizeValid
                  ? `${Number(contextSize).toLocaleString()} tokens`
                  : 'Enter a whole number from 512 to 1,048,576.'}
              </small>
            </label>
            {acceleration === 'hybrid' && (
              <label>
                <span>GPU layers</span>
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={gpuLayers}
                  onChange={(event) => setGpuLayers(Number(event.target.value))}
                />
              </label>
            )}
            {(acceleration === 'gpu' || (acceleration === 'multi-gpu' && splitMode === 'row')) && (
              <label>
                <span>Main GPU index</span>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={mainGpu}
                  onChange={(event) => setMainGpu(Number(event.target.value))}
                />
              </label>
            )}
            {acceleration === 'multi-gpu' && (
              <>
                <label>
                  <span>Multi-GPU split</span>
                  <select
                    value={splitMode}
                    onChange={(event) => setSplitMode(event.target.value as LlamaSplitMode)}
                  >
                    <option value="layer">Layer · balanced default</option>
                    <option value="row">Row · parallel weights</option>
                  </select>
                </label>
                <label>
                  <span>GPU proportions (optional)</span>
                  <input
                    value={tensorSplit}
                    onChange={(event) => setTensorSplit(event.target.value)}
                    placeholder="1,1 or 3,1"
                  />
                </label>
              </>
            )}
            <label>
              <span>CPU threads</span>
              <input
                type="number"
                min={-1}
                max={1024}
                value={threads}
                onChange={(event) => setThreads(Number(event.target.value))}
              />
              <small>-1 lets llama.cpp choose automatically.</small>
            </label>
            <label>
              <span>Flash Attention</span>
              <select
                value={flashAttention}
                onChange={(event) => setFlashAttention(event.target.value as LlamaFlashAttention)}
              >
                <option value="auto">Auto (recommended)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          <div className="setup-note">
            Safe discovery: <code>npm run setup:llama</code>. Check latest release:{' '}
            <code>npm run setup:llama -- -- --check</code>. Nothing downloads until explicit{' '}
            <code>--install</code> or <code>--url</code> approval.
            <br />
            GPU profiles require a compatible build. Install explicitly with{' '}
            <code>--variant cuda</code>, <code>vulkan</code>, <code>rocm</code>, or{' '}
            <code>sycl</code>; Metal is automatic on supported Macs.
          </div>
          <div className="generation-actions">
            <button className="btn primary" onClick={() => setCatalogOpen(true)}>
              Download a model…
            </button>
            <button className="btn" onClick={() => void scanModels()}>
              Scan GGUF models
            </button>
            {models && <span>{models.length.toLocaleString()} model files found</span>}
          </div>
        </div>
      </div>

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>OpenRouter API</h3>
          <span className="sub">external · opt-in</span>
        </div>
        <div className="panel-body generation-form">
          <label>
            <span>Session API key (or set OPENROUTER_API_KEY in the server .env)</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                data?.config.openRouter.apiKeyConfigured ? 'A key is configured' : 'sk-or-v1-…'
              }
            />
          </label>
          <p className="sub">
            A key entered here stays in server-process memory only. A key in the gitignored .env
            persists across restarts. Neither value is returned by the API.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={enforceZdr}
              onChange={(event) => setEnforceZdr(event.target.checked)}
            />
            Use ZDR-only routing by default (can exclude many endpoints)
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={denyDataCollection}
              onChange={(event) => setDenyDataCollection(event.target.checked)}
            />
            Use only providers that deny data collection/training
          </label>
        </div>
      </div>

      <div className="panel generation-panel">
        <div className="panel-head">
          <h3>Diagnostics</h3>
          <span className="sub">local error log</span>
        </div>
        <div className="panel-body generation-form">
          <label className="check-field">
            <input
              type="checkbox"
              checked={persistErrorLogs}
              onChange={(event) => setPersistErrorLogs(event.target.checked)}
            />
            Save generation errors to .threadshelf/generation-errors.log
          </label>
          <p className="sub">
            ThreadShelf writes provider/model errors without adding prompts, answers, or reasoning.
            Private tab-scoped chats are never written, regardless of this setting.
          </p>
        </div>
      </div>

      <div className="generation-actions">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save generation settings'}
        </button>
        {data?.providers.map((provider) => (
          <span key={provider.id} className="provider-status" data-ready={provider.available}>
            {provider.label}: {provider.available ? 'ready' : 'not configured'}
          </span>
        ))}
      </div>
      <ModelCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onDownloaded={() => void scanModels()}
      />
    </section>
  );
}
