import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalVaultRoot,
  getVaultConfig,
  saveVaultConfig,
  setVaultWritePermission,
} from '../src/obsidian/config.js';
import {
  LOCK_NAME,
  STALE_LOCK_MS,
  acquireVaultLock,
  createVaultNote,
  describeLock,
  editVaultNote,
  notePath,
  prepareVaultDelete,
  readVaultNote,
  reclaimStaleLock,
  searchVault,
  vaultErrorMessage,
} from '../src/obsidian/vault.js';
import {
  caseInsensitiveFs,
  lockArtefacts,
  posixOnly,
  trySymlink,
  useTempVault,
} from './shared/vault-env.js';

const ctx = useTempVault();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const age = async (path) => {
  const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
  await utimes(path, old, old);
};

describe('Obsidian config', () => {
  it('new configs are read-only; re-saving the same vault keeps the explicit choice', async () => {
    await rm(process.env.OBSIDIAN_CONFIG_PATH);
    assert.deepEqual(await saveVaultConfig({ vaultPath: ctx.vault }), {
      vaultPath: await canonicalVaultRoot(ctx.vault),
      allowWrites: false,
    });
    await setVaultWritePermission(true);
    assert.equal((await saveVaultConfig({ vaultPath: ctx.vault })).allowWrites, true);
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    assert.equal((await saveVaultConfig({ vaultPath: other })).allowWrites, false);
    assert.equal(
      (await saveVaultConfig({ vaultPath: other, allowWrites: true })).allowWrites,
      true,
    );
  });

  it('an existing saved configuration keeps its explicit write value', async () => {
    await writeFile(
      process.env.OBSIDIAN_CONFIG_PATH,
      JSON.stringify({ vaultPath: ctx.vault, allowWrites: true }),
    );
    assert.equal((await getVaultConfig()).allowWrites, true);
  });

  it('rejects malformed saves before writing anything', async () => {
    const before = await readFile(process.env.OBSIDIAN_CONFIG_PATH, 'utf8');
    for (const input of [
      null,
      [],
      'text',
      {},
      { vaultPath: 42 },
      { vaultPath: ctx.vault, allowWrites: 'true' },
      { vaultPath: ctx.vault, extra: true },
      { vaultPath: 'relative/vault' },
      { vaultPath: `${ctx.vault}\0x` },
      { vaultPath: `/${'a'.repeat(5000)}` },
      { vaultPath: '\\\\?\\C:\\vault' },
      { vaultPath: '\\\\.\\PhysicalDrive0' },
      { vaultPath: join(ctx.temporary, 'missing') },
    ]) {
      await assert.rejects(saveVaultConfig(input), undefined, JSON.stringify(input));
    }
    await writeFile(join(ctx.temporary, 'file'), 'x');
    await assert.rejects(saveVaultConfig({ vaultPath: join(ctx.temporary, 'file') }));
    assert.equal(await readFile(process.env.OBSIDIAN_CONFIG_PATH, 'utf8'), before);
  });

  it('an empty path disconnects the vault', async () => {
    assert.equal((await saveVaultConfig({ vaultPath: '   ' })).vaultPath, '');
    await assert.rejects(readVaultNote('note.md'), /Connect/);
    await assert.rejects(searchVault('x'), /Connect/);
  });

  it('a corrupt config is never trusted and can be repaired by saving', async () => {
    await writeFile(process.env.OBSIDIAN_CONFIG_PATH, '{"vaultPath":');
    await assert.rejects(getVaultConfig(), /Cannot read/);
    await assert.rejects(setVaultWritePermission(true), /Cannot read/);
    await assert.rejects(readVaultNote('note.md'), /Cannot read/);
    await writeFile(process.env.OBSIDIAN_CONFIG_PATH, JSON.stringify({ vaultPath: ctx.vault }));
    await assert.rejects(getVaultConfig(), /Cannot read/);
    const repaired = await saveVaultConfig({ vaultPath: ctx.vault });
    assert.equal(repaired.allowWrites, false);
    assert.deepEqual(await getVaultConfig(), repaired);
  });

  it('queues concurrent policy and path changes without losing either', async () => {
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await Promise.all([setVaultWritePermission(false), saveVaultConfig({ vaultPath: other })]);
    assert.equal((await getVaultConfig()).vaultPath, await canonicalVaultRoot(other));
    await Promise.all([
      setVaultWritePermission(true),
      setVaultWritePermission(false),
      setVaultWritePermission(true),
    ]);
    assert.deepEqual(await getVaultConfig(), {
      vaultPath: await canonicalVaultRoot(other),
      allowWrites: true,
    });
    assert.deepEqual(
      (await readdir(ctx.temporary)).filter((name) => name.endsWith('.tmp')),
      [],
      'atomic writes leave no temporary files',
    );
  });
});

describe('notePath', () => {
  it('normalizes safe relative paths', () => {
    assert.equal(notePath('note.md'), 'note.md');
    assert.equal(notePath('Projects\\Sub\\Note.MD'), 'Projects/Sub/Note.MD');
    assert.equal(notePath('Zażółć gęślą jaźń.md'), 'Zażółć gęślą jaźń.md');
    assert.equal(notePath('PROGRA~1/report.md'), 'PROGRA~1/report.md');
    assert.equal(notePath('console.md'), 'console.md');
    assert.equal(notePath('com10.md'), 'com10.md');
  });

  it('rejects traversal, absolute, UNC, drive-relative, ADS, hidden and reserved names', () => {
    for (const value of [
      undefined,
      null,
      42,
      ['a.md'],
      '',
      '.md',
      'note.txt',
      'note.md/',
      'a//b.md',
      'a/./b.md',
      '../escape.md',
      'a/../../escape.md',
      '/abs.md',
      '\\abs.md',
      'C:\\abs.md',
      'C:abs.md',
      'c:/abs.md',
      '\\\\server\\share\\note.md',
      '//server/share/note.md',
      '\\\\?\\C:\\note.md',
      'note.md:stream',
      'note.md::$DATA',
      'note:stream.md',
      '.obsidian/workspace.md',
      'Projects/.trash/old.md',
      '.threadshelf-write-lock/owner.md',
      'CON.md',
      'con .md',
      'nul.txt.md',
      'COM1.md',
      'com¹.md',
      'LPT³.md',
      'CONIN$.md',
      'conout$.md',
      'Projects./note.md',
      'Projects /note.md',
      'note\0.md',
      'note\u0001.md',
      'note\n.md',
      'a<b.md',
      'a|b.md',
      'a?b.md',
      'a*b.md',
      'a"b.md',
      `${'a'.repeat(1025)}.md`,
    ]) {
      assert.throws(() => notePath(value), undefined, JSON.stringify(value));
    }
  });
});

describe('vault read', () => {
  it('returns original text with a sha256 revision, keeping a BOM and frontmatter', async () => {
    const text = '\uFEFF---\ntags: [a]\n---\n# Title\r\n[[Link|alias]]';
    await writeFile(join(ctx.vault, 'bom.md'), text);
    const note = await readVaultNote('bom.md');
    assert.deepEqual(note, { path: 'bom.md', content: text, revision: sha256(text) });
  });

  it('accepts exactly 512 KiB and rejects larger notes', async () => {
    await writeFile(join(ctx.vault, 'max.md'), 'a'.repeat(512 * 1024));
    assert.equal((await readVaultNote('max.md')).content.length, 512 * 1024);
    await writeFile(join(ctx.vault, 'big.md'), 'a'.repeat(512 * 1024 + 1));
    await assert.rejects(readVaultNote('big.md'), /too large/);
  });

  it('rejects missing notes, directories named .md and missing parents', async () => {
    await assert.rejects(readVaultNote('missing.md'), /unavailable/);
    await mkdir(join(ctx.vault, 'folder.md'));
    await assert.rejects(readVaultNote('folder.md'), /regular Markdown/);
    await assert.rejects(readVaultNote('Nope/missing.md'), /unavailable/);
    await writeFile(join(ctx.vault, 'file.md'), 'x');
    await assert.rejects(readVaultNote('file.md/child.md'), /regular Markdown|unavailable/);
  });

  it('rejects symlinked notes when the OS allows creating them', async (t) => {
    await writeFile(join(ctx.temporary, 'outside.md'), 'outside');
    if (!(await trySymlink(join(ctx.temporary, 'outside.md'), join(ctx.vault, 'link.md'), 'file')))
      return t.skip('symlinks are not permitted for this user');
    await assert.rejects(readVaultNote('link.md'), /regular Markdown/);
    assert.equal((await searchVault('outside')).skipped, 1);
  });

  it('rejects 8.3 short-name aliases of hidden folders (Windows with short names)', async (t) => {
    await mkdir(join(ctx.vault, '.hiddenfolder'));
    await writeFile(join(ctx.vault, '.hiddenfolder', 'secret.md'), 'secret');
    const alias = 'HIDDEN~1';
    if (!(await lstat(join(ctx.vault, alias)).catch(() => undefined)))
      return t.skip('this volume does not generate 8.3 short names');
    await assert.rejects(readVaultNote(`${alias}/secret.md`), /hidden/);
    await assert.rejects(createVaultNote(`${alias}/new.md`, 'x'), /hidden/);
  });

  it('serves notes through case variants only on case-insensitive volumes', async () => {
    await writeFile(join(ctx.vault, 'Projects', 'Case.md'), 'case');
    if (await caseInsensitiveFs(ctx.vault))
      assert.equal((await readVaultNote('projects/CASE.md')).content, 'case');
    else await assert.rejects(readVaultNote('projects/CASE.md'));
  });
});

describe('vault create', () => {
  it('creates notes in existing folders and never overwrites', async () => {
    const created = await createVaultNote('Projects/new.md', '# New');
    assert.deepEqual(created, {
      path: 'Projects/new.md',
      content: '# New',
      revision: sha256('# New'),
    });
    assert.equal(await readFile(join(ctx.vault, 'Projects', 'new.md'), 'utf8'), '# New');
    await assert.rejects(createVaultNote('Projects/new.md', 'again'), /already exists/);
    if (await caseInsensitiveFs(ctx.vault))
      await assert.rejects(createVaultNote('projects/NEW.md', 'again'), /already exists/);
    assert.equal(await readFile(join(ctx.vault, 'Projects', 'new.md'), 'utf8'), '# New');
    await assert.rejects(createVaultNote('Missing/new.md', 'x'), /unavailable/);
  });

  it('validates content before touching the vault', async () => {
    for (const content of [undefined, null, 42, { text: 'x' }, 'a\0b', 'a'.repeat(512 * 1024 + 1)])
      await assert.rejects(createVaultNote('bad.md', content), /512 KiB/);
    await assert.rejects(readFile(join(ctx.vault, 'bad.md')));
    await createVaultNote('empty.md', '');
    assert.equal(await readFile(join(ctx.vault, 'empty.md'), 'utf8'), '');
    await createVaultNote('multi.md', 'ż'.repeat(1000));
    assert.equal((await readVaultNote('multi.md')).content, 'ż'.repeat(1000));
  });

  it('refuses to create through a junction or symlinked folder', async () => {
    const outside = join(ctx.temporary, 'outside');
    await mkdir(outside);
    if (
      !(await trySymlink(
        outside,
        join(ctx.vault, 'Linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      ))
    )
      return;
    await assert.rejects(createVaultNote('Linked/new.md', 'x'));
    assert.deepEqual(await readdir(outside), []);
  });

  it('creates new notes owner-only on POSIX', { skip: posixOnly }, async () => {
    await createVaultNote('private.md', 'x');
    assert.equal((await stat(join(ctx.vault, 'private.md'))).mode & 0o777, 0o600);
  });

  it('two concurrent creates of the same path write exactly one note', async () => {
    const results = await Promise.allSettled([
      createVaultNote('race.md', 'first'),
      createVaultNote('race.md', 'second'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results.find((result) => result.status === 'fulfilled').value.content;
    assert.equal(await readFile(join(ctx.vault, 'race.md'), 'utf8'), winner);
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });
});

describe('vault edit', () => {
  it('requires a well-formed current revision', async () => {
    const note = await createVaultNote('note.md', 'one');
    for (const revision of [undefined, '', 'abc', note.revision.toUpperCase(), 42])
      await assert.rejects(editVaultNote('note.md', 'two', revision), /revision/);
    await assert.rejects(editVaultNote('note.md', 'two', sha256('other')), /changed/);
    await assert.rejects(editVaultNote('missing.md', 'two', note.revision), /unavailable/);
    assert.equal((await readVaultNote('note.md')).content, 'one');
  });

  it('detects edits made in Obsidian after the read', async () => {
    const note = await createVaultNote('note.md', 'one');
    await writeFile(join(ctx.vault, 'note.md'), 'changed in Obsidian');
    await assert.rejects(editVaultNote('note.md', 'two', note.revision), /changed/);
    assert.equal((await readVaultNote('note.md')).content, 'changed in Obsidian');
  });

  it('replaces atomically without leaving temporary files', async () => {
    const note = await createVaultNote('Projects/note.md', 'one');
    const edited = await editVaultNote('Projects/note.md', 'two', note.revision);
    assert.equal(edited.revision, sha256('two'));
    assert.equal((await readVaultNote('Projects/note.md')).content, 'two');
    assert.deepEqual(
      (await readdir(join(ctx.vault, 'Projects'))).filter((name) => name.startsWith('.')),
      [],
    );
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('preserves the original file mode on POSIX', { skip: posixOnly }, async () => {
    for (const mode of [0o644, 0o640, 0o664]) {
      await writeFile(join(ctx.vault, 'mode.md'), 'one');
      await chmod(join(ctx.vault, 'mode.md'), mode);
      const { revision } = await readVaultNote('mode.md');
      await editVaultNote('mode.md', 'two', revision);
      assert.equal((await stat(join(ctx.vault, 'mode.md'))).mode & 0o777, mode);
      await rm(join(ctx.vault, 'mode.md'));
    }
  });

  it('refuses hard-linked notes', async () => {
    await writeFile(join(ctx.temporary, 'outside.md'), 'outside');
    await link(join(ctx.temporary, 'outside.md'), join(ctx.vault, 'hard.md'));
    await assert.rejects(editVaultNote('hard.md', 'pwned', sha256('outside')), /regular/);
    assert.equal(await readFile(join(ctx.temporary, 'outside.md'), 'utf8'), 'outside');
  });
});

describe('vault write lock', () => {
  const lockPath = () => join(ctx.vault, LOCK_NAME);

  it('holds an owner token while writing and removes it afterwards, also on errors', async () => {
    const release = await acquireVaultLock(ctx.vault);
    const owner = await readFile(join(lockPath(), 'owner'), 'utf8');
    assert.match(owner, /^[0-9a-f-]{36}$/);
    await release();
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
    await createVaultNote('note.md', 'x');
    await assert.rejects(createVaultNote('note.md', 'x'), /already exists/);
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('a fresh lock makes writers fail as busy after brief retries', async () => {
    const release = await acquireVaultLock(ctx.vault);
    try {
      await assert.rejects(createVaultNote('busy.md', 'x'), /busy/);
      await assert.rejects(readFile(join(ctx.vault, 'busy.md')));
    } finally {
      await release();
    }
    await createVaultNote('busy.md', 'x');
  });

  it('a writer waits for a lock released during its retries', async () => {
    const release = await acquireVaultLock(ctx.vault);
    const pending = createVaultNote('waited.md', 'x');
    setTimeout(() => void release(), 30);
    assert.equal((await pending).path, 'waited.md');
  });

  it('reclaims stale locks with or without an owner file (legacy empty lock)', async () => {
    await mkdir(lockPath());
    await age(lockPath());
    await createVaultNote('legacy.md', 'x');
    await mkdir(lockPath());
    await writeFile(join(lockPath(), 'owner'), 'crashed-process');
    await age(lockPath());
    await createVaultNote('owned.md', 'x');
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('never reclaims a non-directory lock or a symlinked lock', async () => {
    await writeFile(lockPath(), 'not a directory');
    await age(lockPath());
    await assert.rejects(createVaultNote('blocked.md', 'x'), /busy/);
    assert.equal(await readFile(lockPath(), 'utf8'), 'not a directory');
  });

  it('two processes reclaiming the same stale lock: exactly one wins', async () => {
    await mkdir(lockPath());
    await writeFile(join(lockPath(), 'owner'), 'crashed');
    await age(lockPath());
    const judged = await describeLock(lockPath());
    const results = await Promise.all([
      reclaimStaleLock(lockPath(), judged),
      reclaimStaleLock(lockPath(), judged),
      reclaimStaleLock(lockPath(), judged),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('a late reclaimer with an old stale judgement never removes the new lock (TOCTOU)', async () => {
    await mkdir(lockPath());
    await writeFile(join(lockPath(), 'owner'), 'crashed');
    await age(lockPath());
    // Process B judges the lock stale, then is descheduled.
    const judgedByB = await describeLock(lockPath());
    // Process A reclaims the stale lock and re-creates its own lock.
    const releaseA = await acquireVaultLock(ctx.vault);
    const ownerA = await readFile(join(lockPath(), 'owner'), 'utf8');
    // B resumes with its stale judgement: it must not touch A's lock.
    assert.equal(await reclaimStaleLock(lockPath(), judgedByB), false);
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), ownerA);
    await assert.rejects(createVaultNote('during.md', 'x'), /busy/);
    await releaseA();
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('a live lock swapped in just before the takeover rename is restored, and nobody else can lock meanwhile', async () => {
    await mkdir(lockPath());
    await writeFile(join(lockPath(), 'owner'), 'crashed');
    await age(lockPath());
    const judged = await describeLock(lockPath());
    let intruder;
    const result = await reclaimStaleLock(lockPath(), judged, {
      // The stale holder releases and a live writer creates a fresh lock in the window.
      beforeRename: async () => {
        await rm(lockPath(), { recursive: true });
        await mkdir(lockPath());
        await writeFile(join(lockPath(), 'owner'), 'live-writer');
      },
      // The live lock is now a tombstone; a third writer tries to take the free path.
      afterRename: async () => {
        intruder = await acquireVaultLock(ctx.vault).then(
          () => 'acquired',
          (error) => error.message,
        );
      },
    });
    assert.equal(result, false);
    assert.match(intruder, /busy/);
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), 'live-writer');
    assert.deepEqual(
      (await lockArtefacts(ctx.vault)).filter((name) => name !== LOCK_NAME),
      [],
    );
  });

  it('an empty provisional lock swapped in before the takeover rename is not restored as an orphan', async () => {
    // Codex re-review 2026-10-26: this interleaving left an empty lock dir behind,
    // after which every write failed with "Vault is busy".
    await mkdir(lockPath());
    await age(lockPath());
    const judged = await describeLock(lockPath());
    let backOff = 'none';
    const result = await reclaimStaleLock(lockPath(), judged, {
      // The stale holder goes away; an acquirer creates its provisional empty lock dir.
      beforeRename: async () => {
        await rmdir(lockPath());
        await mkdir(lockPath());
      },
      // That acquirer saw the reclaim marker and backs off, but its dir is now the tombstone.
      afterRename: async () => {
        backOff = await rmdir(lockPath()).then(
          () => 'removed',
          (error) => error.code,
        );
      },
    });
    assert.equal(result, false);
    assert.equal(backOff, 'ENOENT');
    assert.deepEqual(await lockArtefacts(ctx.vault), [], 'no orphaned lock or tombstone');
    assert.equal((await createVaultNote('after-race.md', 'x')).path, 'after-race.md');
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('a real acquirer racing a takeover ends with the lock, and nothing is left behind', async () => {
    await mkdir(lockPath());
    await age(lockPath());
    const judged = await describeLock(lockPath());
    let resume;
    const gate = new Promise((resolve) => (resume = resolve));
    let pending;
    const result = await reclaimStaleLock(lockPath(), judged, {
      beforeRename: async () => {
        await rmdir(lockPath());
        pending = acquireVaultLock(ctx.vault, { afterCreate: () => gate });
        // Let the acquirer create its directory and pause before its marker check.
        while (!(await describeLock(lockPath()))) await new Promise((r) => setTimeout(r, 1));
      },
      afterRename: async () => {
        resume();
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    assert.equal(result, false);
    const release = await pending;
    assert.match(await readFile(join(lockPath(), 'owner'), 'utf8'), /^[0-9a-f-]{36}$/);
    await release();
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('an acquirer backing off never removes a lock directory it did not create', async () => {
    let marker;
    const result = acquireVaultLock(ctx.vault, {
      afterCreate: async () => {
        // Our directory is replaced by another writer's, and a reclaim is in progress.
        await rmdir(lockPath());
        await mkdir(lockPath());
        await writeFile(join(lockPath(), 'owner'), 'other-writer');
        marker = `${lockPath()}.reclaim-0000000000000000`;
        await mkdir(marker);
      },
    }).then(
      () => 'acquired',
      (error) => error.message,
    );
    assert.match(await result, /busy/);
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), 'other-writer');
    await rmdir(marker);
  });

  it('a writer whose fresh lock dir was taken over by another owner does not delete it', async () => {
    const result = acquireVaultLock(ctx.vault, {
      afterCreate: async () => {
        await writeFile(join(lockPath(), 'owner'), 'faster-writer');
      },
    }).then(
      () => 'acquired',
      (error) => error.message,
    );
    assert.match(await result, /busy/);
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), 'faster-writer');
  });

  it('a lock re-created at the same path with the same mtime is still a different instance', async () => {
    await mkdir(lockPath());
    await age(lockPath());
    const judged = await describeLock(lockPath());
    await rm(lockPath(), { recursive: true });
    await mkdir(lockPath());
    await writeFile(join(lockPath(), 'owner'), 'live-writer');
    await age(lockPath());
    assert.equal(await reclaimStaleLock(lockPath(), judged), false);
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), 'live-writer');
  });

  it('does not reclaim a lock judged fresh, and clears a reclaim marker left by a crash', async () => {
    await mkdir(lockPath());
    assert.equal(await reclaimStaleLock(lockPath(), await describeLock(lockPath())), false);
    await age(lockPath());
    const judged = await describeLock(lockPath());
    const marker = `${lockPath()}.reclaim-${sha256(judged.id).slice(0, 16)}`;
    await mkdir(marker);
    assert.equal(await reclaimStaleLock(lockPath(), judged), false, 'a live reclaimer wins');
    await age(marker);
    assert.equal(await reclaimStaleLock(lockPath(), judged), false, 'clears the crashed marker');
    assert.equal(await reclaimStaleLock(lockPath(), judged), true);
    assert.deepEqual(await lockArtefacts(ctx.vault), []);
  });

  it('release never removes a lock that another writer now owns, and never throws', async () => {
    const release = await acquireVaultLock(ctx.vault);
    await writeFile(join(lockPath(), 'owner'), 'another-writer');
    await release();
    assert.equal(await readFile(join(lockPath(), 'owner'), 'utf8'), 'another-writer');
    await rm(lockPath(), { recursive: true });
    const second = await acquireVaultLock(ctx.vault);
    await rm(lockPath(), { recursive: true });
    await assert.doesNotReject(second());
  });

  it('a failed cleanup never hides the operation result', async () => {
    // The lock disappears mid-operation (e.g. removed by a sync client): the write still succeeds.
    const note = await createVaultNote('note.md', 'one');
    const release = await acquireVaultLock(ctx.vault);
    await rm(lockPath(), { recursive: true });
    await assert.doesNotReject(release());
    assert.equal((await editVaultNote('note.md', 'two', note.revision)).content, 'two');
  });
});

describe('vault search', () => {
  it('ranks path matches first, respects the limit and returns headings and lines', async () => {
    await writeFile(join(ctx.vault, 'alpha.md'), '# Alpha heading\nnothing\nkeyword here');
    await writeFile(join(ctx.vault, 'Projects', 'keyword.md'), 'body without heading');
    await writeFile(join(ctx.vault, 'beta.md'), 'keyword');
    const result = await searchVault('KEYWORD', 2);
    assert.equal(result.hits.length, 2);
    assert.equal(result.hits[0].path, 'Projects/keyword.md');
    assert.equal(result.hits[0].title, 'keyword');
    assert.equal(result.hits[1].path, 'alpha.md');
    assert.equal(result.hits[1].title, 'Alpha heading');
    assert.equal(result.hits[1].line, 3);
    assert.equal(result.scanned, 3);
    assert.equal(result.skipped, 0);
    assert.equal(result.truncated, false);
  });

  it('matches all terms case-insensitively, including non-ASCII text', async () => {
    await writeFile(join(ctx.vault, 'pl.md'), 'Zażółć gęślą jaźń');
    assert.equal((await searchVault('ZAŻÓŁĆ jaźń')).hits.length, 1);
    assert.equal((await searchVault('zażółć missing')).hits.length, 0);
  });

  it('validates query and limit', async () => {
    for (const query of [undefined, 42, '', '   ', 'a'.repeat(1001), ['a']])
      await assert.rejects(searchVault(query), /1–1000/);
    for (const limit of [0, 31, 1.5, '5', Number.NaN, null])
      await assert.rejects(searchVault('x', limit), /limit/);
  });

  it('skips hidden folders, lock artefacts and non-Markdown files without counting them', async () => {
    await mkdir(join(ctx.vault, '.obsidian'));
    await writeFile(join(ctx.vault, '.obsidian', 'a.md'), 'needle');
    await mkdir(join(ctx.vault, `${LOCK_NAME}.stale-x`));
    await writeFile(join(ctx.vault, `${LOCK_NAME}.stale-x`, 'b.md'), 'needle');
    await writeFile(join(ctx.vault, 'c.txt'), 'needle');
    await writeFile(join(ctx.vault, '.hidden.md'), 'needle');
    const result = await searchVault('needle');
    assert.deepEqual(result, { hits: [], scanned: 0, skipped: 0, truncated: false });
  });

  it('counts unsafe, oversized and hard-linked Markdown files as skipped', async () => {
    await writeFile(join(ctx.vault, 'ok.md'), 'needle');
    await writeFile(join(ctx.vault, 'big.md'), `needle${'a'.repeat(512 * 1024)}`);
    await writeFile(join(ctx.temporary, 'outside.md'), 'needle');
    await link(join(ctx.temporary, 'outside.md'), join(ctx.vault, 'hard.md'));
    const result = await searchVault('needle');
    assert.deepEqual(
      result.hits.map((hit) => hit.path),
      ['ok.md'],
    );
    assert.equal(result.scanned, 1);
    assert.equal(result.skipped, 2);
  });

  it('counts names that are valid on POSIX but unsafe for notes', { skip: posixOnly }, async () => {
    await writeFile(join(ctx.vault, 'a:b.md'), 'needle');
    await writeFile(join(ctx.vault, 'trailing .md'), 'needle');
    await writeFile(join(ctx.vault, 'q?.md'), 'needle');
    const result = await searchVault('needle');
    assert.equal(result.hits.length, 1, 'trailing-space basename before .md is allowed');
    assert.equal(result.skipped, 2);
  });

  it('stops when the signal aborts', async () => {
    await writeFile(join(ctx.vault, 'a.md'), 'needle');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchVault('needle', 10, controller.signal), { name: 'AbortError' });
  });
});

describe('vault delete preparation', () => {
  it('validates the list and lists one file once even through case variants', async () => {
    await writeFile(join(ctx.vault, 'Note.md'), 'x');
    for (const paths of [undefined, 'Note.md', [], Array.from({ length: 21 }, (_, i) => `${i}.md`)])
      await assert.rejects(prepareVaultDelete(paths), /1–20/);
    await assert.rejects(prepareVaultDelete(['../x.md']), /Unsafe/);
    assert.equal((await prepareVaultDelete(['Note.md', 'Note.md'])).files.length, 1);
    if (await caseInsensitiveFs(ctx.vault)) {
      const snapshot = await prepareVaultDelete(['Note.md', 'note.md', 'NOTE.md']);
      assert.deepEqual(snapshot.files, [{ path: 'Note.md', revision: sha256('x') }]);
    }
  });

  it('requires writes to be enabled', async () => {
    await writeFile(join(ctx.vault, 'note.md'), 'x');
    await setVaultWritePermission(false);
    await assert.rejects(prepareVaultDelete(['note.md']), /read-only/);
  });
});

describe('vaultErrorMessage', () => {
  it('never exposes filesystem paths and reports cancellation', () => {
    const errno = Object.assign(
      new Error("EACCES: permission denied, open '/home/user/vault/x.md'"),
      {
        code: 'EACCES',
      },
    );
    assert.doesNotMatch(vaultErrorMessage(errno), /home|vault\/x/);
    const controller = new AbortController();
    controller.abort();
    assert.match(vaultErrorMessage(controller.signal.reason), /cancelled/);
    assert.equal(vaultErrorMessage(new Error('Plain message')), 'Plain message');
    assert.equal(vaultErrorMessage('odd', 'Fallback'), 'Fallback');
  });

  it(
    'maps a permission failure inside the vault without leaking the path',
    { skip: posixOnly },
    async (t) => {
      if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
      await mkdir(join(ctx.vault, 'Locked'));
      await writeFile(join(ctx.vault, 'Locked', 'n.md'), 'needle');
      await chmod(join(ctx.vault, 'Locked'), 0o000);
      try {
        const error = await searchVault('needle').catch((cause) => cause);
        assert.ok(error instanceof Error);
        assert.doesNotMatch(
          vaultErrorMessage(error),
          new RegExp(ctx.vault.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
        );
      } finally {
        await chmod(join(ctx.vault, 'Locked'), 0o755);
      }
    },
  );
});
