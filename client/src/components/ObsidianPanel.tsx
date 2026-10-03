import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { VaultApproval, VaultConfig, VaultNote, VaultSearch } from '../types';
import { DirectoryPicker } from './DirectoryPicker';
import { Markdown } from './Markdown';

export const useVaultConfig = () =>
  useQuery({ queryKey: ['obsidian-config'], queryFn: ({ signal }) => api.vaultConfig(signal) });
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Vault operation failed';
export function VaultWriteToggle({ config }: { readonly config: VaultConfig }) {
  const queryClient = useQueryClient();
  const [pendingChoice, setPendingChoice] = useState<boolean | null>(null);
  const mutation = useMutation({
    mutationFn: (allowWrites: boolean) => api.setVaultWritePermission(allowWrites),
    onMutate: (allowWrites) => {
      void queryClient.cancelQueries({ queryKey: ['obsidian-config'] }, { revert: false });
      const previous = queryClient.getQueryData<VaultConfig>(['obsidian-config']);
      queryClient.setQueryData(['obsidian-config'], { ...config, allowWrites });
      return previous;
    },
    onError: (_error, _value, previous) => {
      if (previous) queryClient.setQueryData(['obsidian-config'], previous);
      setPendingChoice(null);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(['obsidian-config'], next);
      setPendingChoice(null);
    },
  });
  return (
    <div>
      <label className="vault-check">
        <input
          id="vaultAllowWrites"
          type="checkbox"
          checked={pendingChoice ?? config.allowWrites}
          disabled={mutation.isPending}
          onChange={(event) => {
            setPendingChoice(event.target.checked);
            mutation.mutate(event.target.checked);
          }}
        />{' '}
        Allow vault writes
      </label>
      {mutation.error && <p className="field-error">{errorText(mutation.error)}</p>}
    </div>
  );
}

export function ObsidianChatControls({
  enabled,
  onChange,
  sending,
  external,
  ephemeral,
}: {
  readonly enabled: boolean;
  readonly onChange: (value: boolean) => void;
  readonly sending: boolean;
  readonly external: boolean;
  readonly ephemeral: boolean;
}) {
  const { data, error } = useVaultConfig();
  return (
    <div className="vault-chat-controls">
      <label className="vault-check">
        <input
          id="chatUseObsidian"
          type="checkbox"
          checked={enabled}
          disabled={sending || !data?.vaultPath}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        Obsidian tools
      </label>
      {data?.vaultPath ? (
        <VaultWriteToggle config={data} />
      ) : (
        <a href="/settings">Connect vault in Settings</a>
      )}
      {enabled && (
        <span className="vault-hint">
          {external
            ? 'Retrieved note text is sent to OpenRouter. '
            : 'Search and note tools run locally. '}
          {ephemeral && 'Private chat does not prevent enabled vault writes. '}
          {data?.allowWrites ? 'Create/edit enabled; deletion always asks.' : 'Read-only.'}
        </span>
      )}
      {error && <span className="field-error">{errorText(error)}</span>}
    </div>
  );
}

export function VaultDeleteApproval({
  approval,
  onDecision,
}: {
  readonly approval: VaultApproval;
  readonly onDecision: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api.decideVaultDeletion(approval, approve, approve && checked);
      onDecision();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="vault-approval" role="group" aria-label="Confirm vault deletion">
      <header>
        <strong title={approval.model}>{approval.model} wants to delete the following files</strong>
        <button
          className="btn sm ghost"
          aria-label="Cancel vault deletion"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          ×
        </button>
      </header>
      <ul>
        {approval.files.map((path) => (
          <li key={path} title={path}>
            {path}
          </li>
        ))}
      </ul>
      <p>Files will move to the vault’s .trash folder. Approval expires after five minutes.</p>
      <label className="vault-check">
        <input
          id="vaultDeleteAcknowledged"
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => setChecked(event.target.checked)}
        />{' '}
        I confirm deletion of these files
      </label>
      {error && <p className="field-error">{error}</p>}
      <footer>
        <button className="btn" disabled={busy} onClick={() => void decide(false)}>
          Cancel
        </button>
        <button
          id="vaultDeleteConfirm"
          className="btn danger"
          disabled={!checked || busy}
          onClick={() => void decide(true)}
        >
          OK — delete files
        </button>
      </footer>
    </section>
  );
}

export function ObsidianPanel() {
  const { data: config, error: configError } = useVaultConfig();
  const queryClient = useQueryClient();
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VaultSearch | null>(null);
  const [note, setNote] = useState<VaultNote | null>(null);
  const [newPath, setNewPath] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const path = draftPath ?? config?.vaultPath ?? '';
  const operation = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel vault-panel" id="obsidianPanel">
      <div className="panel-head">
        <h3>Obsidian vault</h3>
        <span className="sub">Local Markdown · live keyword search</span>
      </div>
      <div className="panel-body">
        <p>
          Connect your existing vault to search notes here or enable Obsidian tools in a
          conversation. Notes stay in their original folders.
        </p>
        <label htmlFor="obsidianVaultPath">Vault directory</label>
        <input
          id="obsidianVaultPath"
          value={path}
          onChange={(event) => setDraftPath(event.target.value)}
          placeholder="Absolute path to your vault"
        />
        <DirectoryPicker initialPath={path} onSelect={setDraftPath} label="Browse vault folders…" />
        <div className="vault-actions">
          <button
            className="btn"
            disabled={busy || !config}
            onClick={() =>
              void operation(async () => {
                const next = await api.saveVaultConfig({
                  vaultPath: path,
                  allowWrites: config?.allowWrites ?? true,
                });
                queryClient.setQueryData(['obsidian-config'], next);
                setDraftPath(null);
                setResults(null);
                setNote(null);
                setNotice(next.vaultPath ? 'Vault connected.' : 'Vault disconnected.');
              })
            }
          >
            Save vault
          </button>
          {config?.vaultPath && (
            <button className="btn ghost" disabled={busy} onClick={() => setDraftPath('')}>
              Disconnect (then Save)
            </button>
          )}
        </div>
        {config && <VaultWriteToggle config={config} />}
        <p className="vault-hint">
          Writes are enabled by default. Turn them off to block creation, editing and deletion for
          every agent. Hidden folders, attachments and symlinks are excluded. Deletion requires a
          separate checkbox and confirmation in chat.
        </p>
        {config?.vaultPath && (
          <>
            <form
              className="vault-search"
              onSubmit={(event) => {
                event.preventDefault();
                void operation(async () => {
                  setResults(await api.searchVault(query));
                  setNote(null);
                });
              }}
            >
              <input
                id="obsidianSearchInput"
                aria-label="Search Obsidian notes"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Words in note text or paths"
                maxLength={1000}
              />
              <button className="btn" disabled={busy || !query.trim()}>
                Search vault
              </button>
            </form>
            {results && (
              <div className="vault-results">
                <p>
                  {results.hits.length} results · {results.scanned} notes scanned
                  {results.truncated && ' · scan limit reached; use a smaller vault'}
                </p>
                {results.hits.map((hit) => (
                  <button
                    type="button"
                    className="vault-result"
                    key={hit.path}
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => setNote(await api.readVaultNote(hit.path)))
                    }
                  >
                    <strong title={hit.title}>{hit.title}</strong>
                    <span title={hit.path}>
                      {hit.path}:{hit.line}
                    </span>
                    <pre>{hit.snippet}</pre>
                  </button>
                ))}
              </div>
            )}
            {note && (
              <article className="vault-note">
                <header>
                  <strong title={note.path}>{note.path}</strong>
                  <a
                    className="btn sm"
                    href={`obsidian://open?path=${encodeURIComponent(`${config.vaultPath.replace(/\\/g, '/')}/${note.path}`)}`}
                  >
                    Open in Obsidian
                  </a>
                </header>
                <Markdown text={note.content} />
              </article>
            )}
            <details>
              <summary>Create a Markdown note</summary>
              <label htmlFor="obsidianNewPath">Relative note path (.md)</label>
              <input
                id="obsidianNewPath"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder="new-note.md"
              />
              <label htmlFor="obsidianNewContent">Markdown</label>
              <textarea
                id="obsidianNewContent"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={6}
              />
              <button
                className="btn"
                disabled={busy || !config.allowWrites || !newPath.trim()}
                onClick={() =>
                  void operation(async () => {
                    setNote(await api.createVaultNote(newPath, content));
                    setNewPath('');
                    setContent('');
                    setNotice('Markdown note created.');
                  })
                }
              >
                Create note
              </button>
            </details>
          </>
        )}
        {(error || configError) && (
          <p className="field-error" role="alert">
            {error || errorText(configError)}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </section>
  );
}
