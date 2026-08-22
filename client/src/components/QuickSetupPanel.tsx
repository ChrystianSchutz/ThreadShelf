import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { QuickSetupPlan } from '../types';
import { toast } from '../toast';
import { fmtBytes } from '../utils';

interface QuickSetupPanelProps {
  readonly onCompleted?: () => void;
}

const VARIANTS = [
  { value: '', label: 'Detect automatically' },
  { value: 'cpu', label: 'CPU (most compatible)' },
  { value: 'cuda', label: 'NVIDIA CUDA' },
  { value: 'vulkan', label: 'Vulkan (AMD / Intel)' },
  { value: 'rocm', label: 'AMD ROCm' },
] as const;

const shortHash = (hash: string | undefined): string =>
  hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : 'no digest';

/**
 * Everything the setup will fetch is listed before anything is fetched: source
 * URLs, digests, sizes and the destination folder. One button then covers the
 * whole plan, so the consent is single but still informed.
 */
export function QuickSetupPanel({ onCompleted }: QuickSetupPanelProps) {
  const [variant, setVariant] = useState('');
  const [plan, setPlan] = useState<QuickSetupPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [percent, setPercent] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPlan = useCallback(
    (signal?: AbortSignal) =>
      api
        .quickSetupPlan(variant || undefined, signal)
        .then((next) => {
          setPlan(next);
          setError('');
        })
        .catch((cause: unknown) => {
          if (signal?.aborted) return;
          setError(cause instanceof Error ? cause.message : 'Could not build a setup plan.');
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [variant],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchPlan(controller.signal);
    return () => controller.abort();
  }, [fetchPlan]);

  const recheck = useCallback(() => {
    setLoading(true);
    void fetchPlan();
  }, [fetchPlan]);

  const run = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setStatus('Starting…');
    setPercent(0);
    try {
      await api.runQuickSetup(
        { variant: variant || undefined },
        (event) => {
          if (event.type === 'progress') {
            const where = event.step === 'runtime' ? 'llama.cpp' : 'Model';
            setStatus(`${where}: ${event.phase ?? ''}${event.file ? ` · ${event.file}` : ''}`);
            setPercent(event.percent ?? 0);
          }
          if (event.type === 'done') setStatus('Finished.');
        },
        controller.signal,
      );
      toast.success('Local generation is ready.');
      onCompleted?.();
      recheck();
    } catch (cause) {
      if (!controller.signal.aborted) {
        toast.error(cause instanceof Error ? cause.message : 'Setup failed.');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [variant, onCompleted, recheck]);

  const nothingToDo = plan?.runtime.action === 'reuse' && !plan.model;

  return (
    <div className="panel generation-panel">
      <div className="panel-head">
        <h3>Set up local generation</h3>
        <span className="sub">one screen · one confirmation</span>
      </div>
      <div className="panel-body quick-setup">
        <label className="quick-setup-variant">
          <span>Accelerator</span>
          <select
            value={variant}
            onChange={(event) => setVariant(event.target.value)}
            disabled={running}
          >
            {VARIANTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {loading && <p className="catalog-empty">Checking your hardware and the latest release…</p>}
        {error && <p className="catalog-error">{error}</p>}

        {plan && (
          <>
            <p className="quick-setup-detected">
              Detected:{' '}
              <b>
                {plan.hardware.devices[0]?.name ?? 'no accelerator'}
                {plan.hardware.devices[0] ? ` · ${fmtBytes(plan.hardware.modelBudgetBytes)}` : ''}
              </b>{' '}
              → llama.cpp <b>{plan.runtime.variant}</b> build
            </p>

            <ol className="quick-setup-steps">
              <li data-action={plan.runtime.action}>
                <span className="quick-setup-step-title">
                  llama.cpp {plan.runtime.tag} ({plan.runtime.variant})
                  {plan.runtime.action === 'reuse' && <em>already installed</em>}
                </span>
                {plan.runtime.action === 'install' && (
                  <span className="quick-setup-step-meta" title={plan.runtime.url}>
                    {plan.runtime.url} · {fmtBytes(plan.runtime.sizeBytes)} · sha256{' '}
                    {shortHash(plan.runtime.sha256)}
                  </span>
                )}
                {plan.runtime.companions.map((companion) => (
                  <span
                    className="quick-setup-step-meta"
                    key={companion.url}
                    title={companion.url}
                  >
                    runtime companion · {fmtBytes(companion.sizeBytes)} · sha256{' '}
                    {shortHash(companion.sha256)}
                  </span>
                ))}
              </li>

              {plan.model ? (
                <li data-action={plan.model.action}>
                  <span className="quick-setup-step-title">
                    {plan.model.repoId} · {plan.model.quant}
                    <em>{fmtBytes(plan.model.totalBytes)}</em>
                  </span>
                  <span className="quick-setup-step-meta">
                    {plan.model.files.length} file{plan.model.files.length === 1 ? '' : 's'} ·
                    sha256 {shortHash(plan.model.files[0]?.sha256)}
                    {plan.model.license ? ` · ${plan.model.license}` : ''}
                  </span>
                </li>
              ) : (
                <li data-action="none">
                  <span className="quick-setup-step-title">
                    No model selected automatically
                    <em>pick one in the model browser</em>
                  </span>
                </li>
              )}
            </ol>

            <p className="quick-setup-destination">
              Destination: <code>{plan.runtime.destination}</code>
              {plan.model && (
                <>
                  {' '}
                  and <code>{plan.model.directory}</code>
                </>
              )}
            </p>

            {plan.warnings.map((warning) => (
              <p className="quick-setup-warning" key={warning}>
                {warning}
              </p>
            ))}

            {running && (
              <div className="catalog-progress">
                <div className="catalog-progress-track">
                  <div className="catalog-progress-fill" style={{ width: `${percent}%` }} />
                </div>
                <span>{status}</span>
              </div>
            )}

            <div className="generation-actions">
              <button
                className="btn primary"
                onClick={() => void run()}
                disabled={running || nothingToDo}
              >
                {running
                  ? 'Working…'
                  : nothingToDo
                    ? 'Everything is already installed'
                    : `Download and install${
                        plan.totalDownloadBytes ? ` · ${fmtBytes(plan.totalDownloadBytes)}` : ''
                      }`}
              </button>
              {running && (
                <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              )}
              {!running && (
                <button className="btn ghost" onClick={recheck}>
                  Re-check
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
