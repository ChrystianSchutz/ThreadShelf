import { Router, type Response } from 'express';
import { requireLoopback } from './loopback.js';
import { getVaultConfig, saveVaultConfig, setVaultWritePermission } from '../obsidian/config.js';
import {
  createVaultNote,
  readVaultNote,
  searchVault,
  vaultErrorMessage,
} from '../obsidian/vault.js';
import { decideVaultDeletion } from '../obsidian/approvals.js';

const router = Router();
router.use('/api/obsidian', requireLoopback);

/** Raw filesystem errors carry absolute paths; only sanitized messages leave the server. */
const fail = (res: Response, status: number, error: unknown, fallback: string): void => {
  res.status(status).json({ error: vaultErrorMessage(error, fallback) });
};

router.get('/api/obsidian/config', async (_req, res) => {
  try {
    res.json(await getVaultConfig());
  } catch (error) {
    fail(res, 500, error, 'Cannot read Obsidian configuration');
  }
});
router.put('/api/obsidian/config', async (req, res) => {
  try {
    res.json(await saveVaultConfig(req.body));
  } catch (error) {
    fail(res, 400, error, 'Invalid vault configuration');
  }
});
router.patch('/api/obsidian/config', async (req, res) => {
  try {
    const body: unknown = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'allowWrites')
    )
      throw new Error('Only allowWrites can be changed with PATCH');
    res.json(await setVaultWritePermission((body as { allowWrites?: unknown }).allowWrites));
  } catch (error) {
    fail(res, 400, error, 'Invalid write policy');
  }
});
router.get('/api/obsidian/search', async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    res.json(
      await searchVault(
        req.query.q,
        req.query.limit === undefined ? 10 : Number(req.query.limit),
        controller.signal,
      ),
    );
  } catch (error) {
    if (!controller.signal.aborted) fail(res, 400, error, 'Vault search failed');
  }
});
router.get('/api/obsidian/note', async (req, res) => {
  try {
    res.json(await readVaultNote(req.query.path));
  } catch (error) {
    fail(res, 400, error, 'Cannot read note');
  }
});
router.post('/api/obsidian/note', async (req, res) => {
  try {
    res.status(201).json(await createVaultNote(req.body?.path, req.body?.content));
  } catch (error) {
    fail(res, 400, error, 'Cannot create note');
  }
});
router.post('/api/obsidian/approvals/:id', async (req, res) => {
  try {
    await decideVaultDeletion(req.params.id, req.body);
    res.json({ ok: true });
  } catch (error) {
    fail(res, 409, error, 'Confirmation failed');
  }
});
export default router;
