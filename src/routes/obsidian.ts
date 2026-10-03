import { Router } from 'express';
import { requireLoopback } from './loopback.js';
import { getVaultConfig, saveVaultConfig, setVaultWritePermission } from '../obsidian/config.js';
import { createVaultNote, readVaultNote, searchVault } from '../obsidian/vault.js';
import { decideVaultDeletion } from '../obsidian/approvals.js';

const router = Router();
router.use('/api/obsidian', requireLoopback);
router.get('/api/obsidian/config', async (_req, res) => {
  res.json(await getVaultConfig());
});
router.put('/api/obsidian/config', async (req, res) => {
  try {
    res.json(await saveVaultConfig(req.body));
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Invalid vault configuration' });
  }
});
router.patch('/api/obsidian/config', async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'allowWrites'))
      throw new Error('Only allowWrites can be changed with PATCH');
    res.json(await setVaultWritePermission(req.body.allowWrites));
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : 'Invalid write policy' });
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
    if (!controller.signal.aborted)
      res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Vault search failed' });
  }
});
router.get('/api/obsidian/note', async (req, res) => {
  try {
    res.json(await readVaultNote(req.query.path));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Cannot read note' });
  }
});
router.post('/api/obsidian/note', async (req, res) => {
  try {
    res.status(201).json(await createVaultNote(req.body?.path, req.body?.content));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Cannot create note' });
  }
});
router.post('/api/obsidian/approvals/:id', async (req, res) => {
  try {
    await decideVaultDeletion(req.params.id, req.body);
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Confirmation failed' });
  }
});
export default router;
