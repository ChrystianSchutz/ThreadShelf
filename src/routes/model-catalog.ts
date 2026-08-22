import { Router, type Response } from 'express';
import { requireLoopback } from './loopback.js';
import { abortOnDisconnect, isAbortError } from './stream-abort.js';
import { inspectHardware, judgeFit } from '../generation/hardware.js';
import {
  CatalogError,
  getCatalogModel,
  huggingFaceToken,
  searchCatalogModels,
  type CatalogSort,
} from '../generation/model-catalog.js';
import { downloadModel, planModelDownload } from '../generation/model-download.js';
import {
  buildQuickSetupPlan,
  quickSetupFingerprint,
  runQuickSetupPlan,
  type QuickSetupPlan,
} from '../generation/quick-setup.js';
import type { LlamaVariant } from '../generation/llama-install.js';

const router = Router();
const sorts = new Set<CatalogSort>(['downloads', 'likes', 'trending', 'recent']);
const variants = new Set<LlamaVariant>(['cpu', 'vulkan', 'cuda', 'rocm', 'sycl']);

const fail = (res: Response, error: unknown): void => {
  if (error instanceof CatalogError) {
    res.status(error.status && error.status < 600 ? error.status : 502).json({
      error: error.message,
    });
    return;
  }
  console.error('[/api/generation/catalog]', error);
  res.status(502).json({ error: error instanceof Error ? error.message : 'Catalog request failed' });
};

/** NDJSON, matching the ingest and chat streams the client already consumes. */
const openStream = (res: Response): ((event: unknown) => void) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return (event: unknown) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
};

router.get('/api/generation/hardware', requireLoopback, async (_req, res) => {
  try {
    res.json(await inspectHardware());
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/generation/catalog/search', requireLoopback, async (req, res) => {
  try {
    const sort = String(req.query.sort || 'downloads') as CatalogSort;
    const [result, hardware] = await Promise.all([
      searchCatalogModels({
        query: typeof req.query.q === 'string' ? req.query.q : '',
        sort: sorts.has(sort) ? sort : 'downloads',
        limit: Number(req.query.limit) || 24,
        author: typeof req.query.author === 'string' ? req.query.author : undefined,
      }),
      inspectHardware(),
    ]);
    res.json({ ...result, hardware });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/api/generation/catalog/model', requireLoopback, async (req, res) => {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const [detail, hardware] = await Promise.all([getCatalogModel(id), inspectHardware()]);
    res.json({
      model: {
        ...detail,
        // Fit is judged server-side so every surface agrees on one verdict.
        quants: detail.quants.map((quant) => ({
          ...quant,
          fit: judgeFit(quant.totalBytes, hardware),
        })),
      },
      hardware,
      tokenConfigured: Boolean(huggingFaceToken()),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/generation/catalog/download', requireLoopback, async (req, res) => {
  const controller = abortOnDisconnect(req, res, 'Download cancelled');
  try {
    const plan = await planModelDownload({
      repoId: String(req.body?.repoId ?? ''),
      quant: req.body?.quant ? String(req.body.quant) : undefined,
      includeProjector: req.body?.includeProjector === true,
    });
    const send = openStream(res);
    send({ type: 'plan', plan });
    await downloadModel(plan, {
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'progress', ...progress }),
    });
    send({ type: 'done', primaryPath: plan.primaryPath, directory: plan.directory });
    res.end();
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      res.end();
      return;
    }
    if (res.headersSent) {
      res.write(
        `${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Download failed' })}\n`,
      );
      res.end();
      return;
    }
    fail(res, error);
  }
});

router.get('/api/generation/setup/plan', requireLoopback, async (req, res) => {
  try {
    const variant = String(req.query.variant || '') as LlamaVariant;
    res.json(
      await buildQuickSetupPlan({
        variant: variants.has(variant) ? variant : undefined,
        repoId: typeof req.query.model === 'string' ? req.query.model : undefined,
        quant: typeof req.query.quant === 'string' ? req.query.quant : undefined,
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});

router.post('/api/generation/setup/run', requireLoopback, async (req, res) => {
  const controller = abortOnDisconnect(req, res, 'Setup cancelled');
  try {
    // The confirmation flag is the recorded consent for this download.
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: 'Setup requires explicit confirmation' });
      return;
    }
    const variant = String(req.body?.variant || '') as LlamaVariant;
    // Re-resolved server-side rather than taken from the request: a client must
    // never be able to hand the server a URL to fetch and execute. The pins keep
    // that resolution deterministic, so it lands on what the user approved.
    const plan: QuickSetupPlan = await buildQuickSetupPlan({
      variant: variants.has(variant) ? variant : undefined,
      repoId: typeof req.body?.model === 'string' ? req.body.model : undefined,
      quant: typeof req.body?.quant === 'string' ? req.body.quant : undefined,
      releaseTag: typeof req.body?.releaseTag === 'string' ? req.body.releaseTag : undefined,
    });

    // The approved plan is identified by its digests, sizes and versions. If a
    // nightly build moved, the catalog returned different files, or free VRAM
    // changed the recommendation, the user is shown the new plan to approve
    // rather than handed a download they never agreed to.
    const approved = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';
    const current = quickSetupFingerprint(plan);
    if (approved && approved !== current) {
      res.status(409).json({
        error: 'The setup plan changed since it was shown. Review the new plan and confirm again.',
        plan,
        fingerprint: current,
      });
      return;
    }

    const send = openStream(res);
    send({ type: 'plan', plan });
    const result = await runQuickSetupPlan(plan, {
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'progress', ...progress }),
    });
    send({ type: 'done', ...result });
    res.end();
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      res.end();
      return;
    }
    if (res.headersSent) {
      res.write(
        `${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Setup failed' })}\n`,
      );
      res.end();
      return;
    }
    fail(res, error);
  }
});

export default router;
