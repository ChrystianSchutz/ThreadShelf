import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  CatalogFit,
  CatalogModelDetail,
  CatalogModelSummary,
  CatalogSort,
  HardwareProfile,
} from '../types';
import { toast } from '../toast';
import { fmtBytes, fmtCount } from '../utils';

interface ModelCatalogModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDownloaded?: (path: string) => void;
}

const SORTS: readonly { readonly value: CatalogSort; readonly label: string }[] = [
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'trending', label: 'Trending' },
  { value: 'likes', label: 'Most liked' },
  { value: 'recent', label: 'Recently updated' },
];

const FIT_LABEL: Record<CatalogFit, string> = {
  fits: 'fits in VRAM',
  tight: 'partly on CPU',
  'too-large': 'too large',
};

const hardwareSummary = (hardware: HardwareProfile | null): string => {
  if (!hardware) return 'detecting hardware…';
  const device = hardware.devices[0];
  return device
    ? `${device.name} · ${fmtBytes(hardware.modelBudgetBytes)} usable`
    : `CPU only · ${fmtBytes(hardware.modelBudgetBytes)} usable RAM`;
};

export function ModelCatalogModal({ open, onClose, onDownloaded }: ModelCatalogModalProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CatalogSort>('downloads');
  const [models, setModels] = useState<readonly CatalogModelSummary[]>([]);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogModelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, file: '' });
  const abortRef = useRef<AbortController | null>(null);

  // Typing should not fire a request per keystroke against a public API.
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError('');
        void api
          .catalogSearch({ q: query, sort }, controller.signal)
          .then((response) => {
            setModels(response.models);
            setHardware(response.hardware);
            setTokenConfigured(response.tokenConfigured);
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted) return;
            setError(cause instanceof Error ? cause.message : 'Could not reach the model catalog.');
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 350 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, sort]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    setExpanded(null);
    setDetail(null);
    onClose();
  }, [onClose]);

  const toggle = useCallback(
    (id: string) => {
      if (expanded === id) {
        setExpanded(null);
        setDetail(null);
        return;
      }
      setExpanded(id);
      setDetail(null);
      setDetailLoading(true);
      void api
        .catalogModel(id)
        .then((response) => {
          setDetail(response.model);
          setHardware(response.hardware);
        })
        .catch((cause: unknown) =>
          toast.error(cause instanceof Error ? cause.message : 'Could not load model files.'),
        )
        .finally(() => setDetailLoading(false));
    },
    [expanded],
  );

  const download = useCallback(
    async (repoId: string, quant: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setDownloading(`${repoId}:${quant}`);
      setProgress({ done: 0, total: 0, file: '' });
      try {
        let saved = '';
        await api.catalogDownload(
          { repoId, quant },
          (event) => {
            if (event.type === 'progress' && event.phase === 'downloading') {
              setProgress({
                done: event.downloadedBytes ?? 0,
                total: event.totalBytes ?? 0,
                file: event.file ?? '',
              });
            }
            if (event.type === 'done') saved = event.primaryPath;
          },
          controller.signal,
        );
        toast.success(`Downloaded ${repoId} (${quant}).`);
        if (saved) onDownloaded?.(saved);
      } catch (cause) {
        if (!controller.signal.aborted) {
          toast.error(cause instanceof Error ? cause.message : 'Download failed.');
        }
      } finally {
        setDownloading(null);
        abortRef.current = null;
      }
    },
    [onDownloaded],
  );

  if (!open) return null;

  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="scrim" onClick={close}>
      <div
        className="modal-card catalog-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Download a model"
      >
        <div className="modal-head catalog-head">
          <div>
            <h3>Download a model</h3>
            <p>
              GGUF models from the Hugging Face Hub, matched against your hardware. Only search
              terms leave this machine — no chat content is ever sent.
            </p>
          </div>
          <span className="catalog-origin" title="Catalog metadata is fetched from huggingface.co">
            catalog · huggingface.co
          </span>
        </div>

        <div className="catalog-controls">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models — e.g. qwen, coder, heretic, uncensored…"
            aria-label="Search models"
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as CatalogSort)}
            aria-label="Sort models"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="catalog-hardware">
          <b>Your machine:</b> {hardwareSummary(hardware)}
          {!tokenConfigured && (
            <span className="catalog-token-hint">
              No HF_TOKEN set — gated models are marked and cannot be downloaded.
            </span>
          )}
        </div>

        <div className="catalog-body">
          {error && <p className="catalog-error">{error}</p>}
          {loading && models.length === 0 && <p className="catalog-empty">Loading catalog…</p>}
          {!loading && !error && models.length === 0 && (
            <p className="catalog-empty">No GGUF models matched that search.</p>
          )}

          {models.map((model) => {
            const isOpen = expanded === model.id;
            return (
              <div className="catalog-item" key={model.id} data-open={isOpen}>
                <button
                  type="button"
                  className="catalog-item-head"
                  onClick={() => toggle(model.id)}
                  aria-expanded={isOpen}
                >
                  <span className="catalog-item-title" title={model.id}>
                    <b>{model.name}</b>
                    <em>{model.author}</em>
                  </span>
                  <span className="catalog-item-meta">
                    <span title={`${model.downloads.toLocaleString()} downloads`}>
                      ↓ {fmtCount(model.downloads)}
                    </span>
                    <span title={`${model.likes.toLocaleString()} likes`}>
                      ♥ {fmtCount(model.likes)}
                    </span>
                    {model.trustedPublisher && (
                      <span className="catalog-badge trusted" title="Known-good GGUF publisher">
                        trusted
                      </span>
                    )}
                    {model.gated !== false && (
                      <span
                        className="catalog-badge gated"
                        title="This repository is gated on Hugging Face. Accept its licence there and set HF_TOKEN in the server .env."
                      >
                        needs HF login
                      </span>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div className="catalog-quants">
                    {detailLoading && <p className="catalog-empty">Reading files…</p>}
                    {detail && detail.gated !== false && (
                      <p className="catalog-gated-note">
                        {detail.id} is gated. Accept the licence on Hugging Face, then set{' '}
                        <code>HF_TOKEN</code> in the server <code>.env</code> to download it here.
                      </p>
                    )}
                    {detail?.quants.map((quant) => {
                      const busy = downloading === `${detail.id}:${quant.label}`;
                      const blocked = detail.gated !== false && !tokenConfigured;
                      return (
                        <div className="catalog-quant" key={quant.label} data-fit={quant.fit}>
                          <span className="catalog-quant-name">
                            {quant.label}
                            {quant.recommended && <em title="Balanced default">recommended</em>}
                            {quant.shards > 1 && <i>{quant.shards} shards</i>}
                          </span>
                          <span className="catalog-quant-size">{fmtBytes(quant.totalBytes)}</span>
                          <span className="catalog-quant-fit" data-fit={quant.fit}>
                            {FIT_LABEL[quant.fit]}
                          </span>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy || Boolean(downloading) || blocked}
                            onClick={() => void download(detail.id, quant.label)}
                            title={blocked ? 'Gated repository — HF_TOKEN required' : undefined}
                          >
                            {busy ? `${percent}%` : 'Download'}
                          </button>
                        </div>
                      );
                    })}
                    {busyBar(downloading, detail?.id, percent, progress.file)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="modal-foot">
          {downloading ? (
            <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
              Cancel download
            </button>
          ) : (
            <button className="btn ghost" onClick={close}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const busyBar = (
  downloading: string | null,
  modelId: string | undefined,
  percent: number,
  file: string,
) => {
  if (!downloading || !modelId || !downloading.startsWith(`${modelId}:`)) return null;
  return (
    <div className="catalog-progress">
      <div className="catalog-progress-track">
        <div className="catalog-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span title={file}>
        {percent}% · {file || 'starting…'}
      </span>
    </div>
  );
};
