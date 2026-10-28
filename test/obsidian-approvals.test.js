import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveVaultConfig, setVaultWritePermission } from '../src/obsidian/config.js';
import {
  APPROVAL_TTL_MS,
  decideVaultDeletion,
  requestVaultDeletion,
} from '../src/obsidian/approvals.js';
import { deleteTestHooks } from '../src/obsidian/vault.js';
import { lockArtefacts, trySymlink, useTempVault } from './shared/vault-env.js';

const ctx = useTempVault();

const proposal = async (paths, events = []) => {
  const controller = new AbortController();
  let emitApproval;
  const ready = new Promise((resolve) => {
    emitApproval = resolve;
  });
  const result = requestVaultDeletion(
    paths,
    'Synthetic Model X',
    (event) => {
      events.push(event);
      emitApproval(event.approval);
    },
    controller.signal,
  );
  // A failed preparation rejects `result` before any approval is emitted.
  const approval = await Promise.race([ready, result.then(() => undefined)]);
  return { approval, result, controller };
};
const approve = (approval, extra = {}) =>
  decideVaultDeletion(approval.id, {
    token: approval.token,
    approve: true,
    acknowledged: true,
    ...extra,
  });
const note = (name, text = name) => writeFile(join(ctx.vault, name), text);
const exists = (name) =>
  readFile(join(ctx.vault, name)).then(
    () => true,
    () => false,
  );

describe('vault deletion approvals', () => {
  it('reports the notes already moved when a batch fails after the first move', async () => {
    await note('one.md');
    await note('two.md');
    const pending = await proposal(['one.md', 'two.md']);
    deleteTestHooks.afterMove = async () => {
      throw new Error('disk failure');
    };
    try {
      await assert.rejects(approve(pending.approval), /already moved/);
    } finally {
      delete deleteTestHooks.afterMove;
    }
    const outcome = await pending.result;
    assert.deepEqual(outcome.deleted, ['one.md']);
    assert.match(outcome.error, /already moved/);
    assert.equal(await exists('one.md'), false);
    assert.equal(await exists('two.md'), true);
  });
  it('emits only the model, files, expiry and a capability; never the root or revisions', async () => {
    await note('a.md');
    const events = [];
    const pending = await proposal(['a.md'], events);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'vault-approval');
    assert.deepEqual(Object.keys(event.approval).sort(), [
      'expiresAt',
      'files',
      'id',
      'model',
      'token',
    ]);
    assert.match(event.approval.token, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(event.approval.expiresAt) > Date.now());
    assert.equal(JSON.stringify(event).includes(ctx.vault), false);
    pending.controller.abort();
    assert.deepEqual(await pending.result, { cancelled: true, deleted: [] });
  });

  it('rejects unknown ids and malformed or wrong tokens without consuming the request', async () => {
    await note('a.md');
    const pending = await proposal(['a.md']);
    const { id, token } = pending.approval;
    for (const [badId, body] of [
      [undefined, { token, approve: true, acknowledged: true }],
      [42, { token, approve: true, acknowledged: true }],
      ['00000000-0000-4000-8000-000000000000', { token, approve: true, acknowledged: true }],
      [id, null],
      [id, {}],
      [id, { token: 42, approve: true, acknowledged: true }],
      [id, { token: token.toUpperCase(), approve: true, acknowledged: true }],
      [id, { token: token.slice(1), approve: true, acknowledged: true }],
      [id, { token: `${token}0`, approve: true, acknowledged: true }],
      [id, { token: 'f'.repeat(64), approve: true, acknowledged: true }],
    ])
      await assert.rejects(decideVaultDeletion(badId, body), /expired|invalid/);
    await assert.rejects(decideVaultDeletion(id, { token }), /explicit/);
    await assert.rejects(decideVaultDeletion(id, { token, approve: 'yes' }), /explicit/);
    await assert.rejects(decideVaultDeletion(id, { token, approve: true }), /box/);
    await assert.rejects(
      decideVaultDeletion(id, { token, approve: true, acknowledged: 'true' }),
      /box/,
    );
    assert.equal(await exists('a.md'), true);
    await approve(pending.approval);
    assert.deepEqual((await pending.result).deleted, ['a.md']);
  });

  it('a rejection preserves the notes and invalidates the capability', async () => {
    await note('a.md');
    const pending = await proposal(['a.md']);
    await decideVaultDeletion(pending.approval.id, {
      token: pending.approval.token,
      approve: false,
    });
    assert.deepEqual(await pending.result, { cancelled: true, deleted: [] });
    await assert.rejects(approve(pending.approval), /expired/);
    assert.equal(await exists('a.md'), true);
  });

  it('concurrent double approval executes the snapshot exactly once', async () => {
    await note('a.md', 'keep a copy in trash');
    const pending = await proposal(['a.md']);
    const results = await Promise.allSettled([
      approve(pending.approval),
      approve(pending.approval),
      approve(pending.approval),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const outcome = await pending.result;
    assert.deepEqual(outcome.deleted, ['a.md']);
    assert.deepEqual(await readdir(join(ctx.vault, '.trash')), [outcome.trash.split('/')[1]]);
    assert.equal(
      await readFile(join(ctx.vault, outcome.trash, '0-a.md'), 'utf8'),
      'keep a copy in trash',
    );
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('approval after the stream aborted is rejected and preserves notes', async () => {
    await note('a.md');
    const pending = await proposal(['a.md']);
    pending.controller.abort();
    assert.equal((await pending.result).cancelled, true);
    await assert.rejects(approve(pending.approval), /expired/);
    assert.equal(await exists('a.md'), true);
  });

  it('an abort while the deletion runs reports the real outcome, not a false cancellation', async () => {
    await note('a.md');
    const pending = await proposal(['a.md']);
    const decision = approve(pending.approval);
    pending.controller.abort();
    await assert.rejects(decision, /cancelled/);
    const outcome = await pending.result;
    assert.equal(outcome.cancelled, undefined);
    assert.match(outcome.error, /cancelled/);
    assert.equal(await exists('a.md'), true);
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('expires after the TTL and then rejects the capability', async () => {
    await note('a.md');
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = await proposal(['a.md']);
      mock.timers.tick(APPROVAL_TTL_MS - 1);
      let settled = false;
      void pending.result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      assert.equal(settled, false);
      mock.timers.tick(1);
      assert.deepEqual(await pending.result, { cancelled: true, deleted: [] });
      await assert.rejects(approve(pending.approval), /expired/);
    } finally {
      mock.timers.reset();
    }
    assert.equal(await exists('a.md'), true);
  });

  it('rejects requests for missing, unsafe or too many notes before asking the user', async () => {
    const events = [];
    for (const paths of [['missing.md'], ['../x.md'], [], 'a.md'])
      await assert.rejects(proposal(paths, events).then(({ result }) => result));
    assert.deepEqual(events, []);
  });

  it('an aborted signal never emits a request', async () => {
    await note('a.md');
    const controller = new AbortController();
    controller.abort();
    const events = [];
    await assert.rejects(
      requestVaultDeletion(['a.md'], 'model', (event) => events.push(event), controller.signal),
      { name: 'AbortError' },
    );
    assert.deepEqual(events, []);
  });

  it('caps pending requests at 100', async () => {
    await note('a.md');
    const all = [];
    try {
      for (let i = 0; i < 100; i++) all.push(await proposal(['a.md']));
      await assert.rejects(
        requestVaultDeletion(['a.md'], 'model', () => {}, new AbortController().signal),
        /Too many/,
      );
    } finally {
      for (const pending of all) pending.controller.abort();
      await Promise.all(all.map((pending) => pending.result));
    }
  });

  it('read-only, vault switch and note changes after the request all block deletion', async () => {
    await note('a.md', 'one');
    await note('b.md', 'two');
    let pending = await proposal(['a.md', 'b.md']);
    await setVaultWritePermission(false);
    await assert.rejects(approve(pending.approval), /read-only/);
    assert.match((await pending.result).error, /read-only/);
    await setVaultWritePermission(true);

    pending = await proposal(['a.md', 'b.md']);
    await note('b.md', 'changed');
    await assert.rejects(approve(pending.approval), /changed/);
    await pending.result;

    pending = await proposal(['a.md']);
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other, allowWrites: true });
    await assert.rejects(approve(pending.approval), /Vault changed/);
    await pending.result;
    assert.equal(await readFile(join(ctx.vault, 'a.md'), 'utf8'), 'one');
    assert.equal(await readFile(join(ctx.vault, 'b.md'), 'utf8'), 'changed');
  });

  it('a note removed after the request stops the batch before moving anything', async () => {
    await note('a.md');
    await note('b.md');
    const pending = await proposal(['a.md', 'b.md']);
    await rm(join(ctx.vault, 'b.md'));
    await assert.rejects(approve(pending.approval), /unavailable/);
    await pending.result;
    assert.equal(await exists('a.md'), true);
  });

  it('moves several notes into one unique batch and reuses an existing trash folder', async () => {
    await mkdir(join(ctx.vault, '.trash'));
    await writeFile(join(ctx.vault, '.trash', 'older.md'), 'older');
    await mkdir(join(ctx.vault, 'Projects', 'Sub'));
    await note('Projects/Sub/same.md', 'nested');
    await note('same.md', 'root');
    const pending = await proposal(['Projects/Sub/same.md', 'same.md']);
    await approve(pending.approval);
    const outcome = await pending.result;
    assert.deepEqual(outcome.deleted, ['Projects/Sub/same.md', 'same.md']);
    assert.match(outcome.trash, /^\.trash\/threadshelf-[0-9a-f-]{36}$/);
    assert.equal(await readFile(join(ctx.vault, outcome.trash, '0-same.md'), 'utf8'), 'nested');
    assert.equal(await readFile(join(ctx.vault, outcome.trash, '1-same.md'), 'utf8'), 'root');
    assert.equal(await readFile(join(ctx.vault, '.trash', 'older.md'), 'utf8'), 'older');
  });

  it('refuses a trash folder that is a link outside the vault', async (t) => {
    const outside = join(ctx.temporary, 'outside-trash');
    await mkdir(outside);
    if (
      !(await trySymlink(
        outside,
        join(ctx.vault, '.trash'),
        process.platform === 'win32' ? 'junction' : 'dir',
      ))
    )
      return t.skip('directory links are not permitted');
    await note('a.md');
    const pending = await proposal(['a.md']);
    await assert.rejects(approve(pending.approval), /Unsafe trash/);
    assert.match((await pending.result).error, /Unsafe trash/);
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await exists('a.md'), true);
  });

  it('a trash path occupied by a file fails without leaking paths or moving notes', async () => {
    await writeFile(join(ctx.vault, '.trash'), 'not a folder');
    await note('a.md');
    const pending = await proposal(['a.md']);
    const error = await approve(pending.approval).catch((cause) => cause);
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(ctx.vault), false);
    assert.equal((await pending.result).error.includes(ctx.vault), false);
    assert.equal(await exists('a.md'), true);
  });
});
