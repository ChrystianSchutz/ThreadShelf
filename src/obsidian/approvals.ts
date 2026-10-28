import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  executeApprovedDelete,
  prepareVaultDelete,
  vaultErrorMessage,
  PartialDeleteError,
  type DeleteSnapshot,
} from './vault.js';

export const APPROVAL_TTL_MS = 5 * 60_000;
const MAX_PENDING = 100;

export interface VaultApproval {
  readonly id: string;
  readonly token: string;
  readonly model: string;
  readonly files: readonly string[];
  readonly expiresAt: string;
}
interface Pending {
  readonly signal: AbortSignal;
  readonly token: string;
  readonly snapshot: DeleteSnapshot;
  readonly finish: (result: unknown) => void;
  /**
   * Stops the expiry timer and abort listener once execution starts, so neither can
   * report a false cancellation while notes are being moved.
   */
  readonly claim: () => void;
}
const pending = new Map<string, Pending>();

export const requestVaultDeletion = async (
  paths: unknown,
  model: string,
  emit: (event: Readonly<Record<string, unknown>>) => void,
  signal: AbortSignal,
): Promise<unknown> => {
  signal.throwIfAborted();
  const snapshot = await prepareVaultDelete(paths);
  signal.throwIfAborted();
  if (pending.size >= MAX_PENDING) throw new Error('Too many pending deletion requests');
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    const finish = (result: unknown): void => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = (): void => finish({ cancelled: true, deleted: [] });
    const timer = setTimeout(cancel, APPROVAL_TTL_MS);
    timer.unref?.();
    const claim = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    pending.set(id, { token, snapshot, finish, signal, claim });
    signal.addEventListener('abort', cancel, { once: true });
    emit({
      type: 'vault-approval',
      approval: {
        id,
        token,
        model,
        files: snapshot.files.map((file) => file.path),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      },
    });
    if (signal.aborted) cancel();
  });
};

/** The capability is browser-only. A model's textual consent or tool argument cannot approve. */
export const decideVaultDeletion = async (id: unknown, input: unknown): Promise<void> => {
  const body = input as { token?: unknown; approve?: unknown; acknowledged?: unknown } | null;
  const item = typeof id === 'string' ? pending.get(id) : undefined;
  if (
    !item ||
    typeof body?.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.token) ||
    !timingSafeEqual(Buffer.from(item.token), Buffer.from(body.token))
  ) {
    throw new Error('Deletion request expired or its confirmation token is invalid');
  }
  if (typeof body.approve !== 'boolean')
    throw new Error('An explicit approval decision is required');
  if (!body.approve) {
    item.finish({ cancelled: true, deleted: [] });
    return;
  }
  if (body.acknowledged !== true) throw new Error('Check the confirmation box before deleting');
  // Claim once: duplicate clicks can never execute the snapshot twice.
  pending.set(id as string, { ...item, token: randomBytes(32).toString('hex') });
  item.claim();
  try {
    item.signal.throwIfAborted();
    item.finish(await executeApprovedDelete(item.snapshot, item.signal));
  } catch (error) {
    const message = vaultErrorMessage(error, 'Deletion failed');
    item.finish({
      error: message,
      deleted: error instanceof PartialDeleteError ? [...error.deleted] : [],
    });
    // Never forward raw filesystem errors (absolute paths) to the browser.
    throw new Error(message, { cause: error });
  }
};
