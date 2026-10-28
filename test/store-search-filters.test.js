import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '@lancedb/lancedb';

// Filters used to run over a fixed candidate window (at most 200 rows), so a
// match outside it vanished. These tables are bigger than that window and put
// the only match as far from the query (or as late in storage) as possible.
const root = await mkdtemp(join(tmpdir(), 'threadshelf-search-filters-'));
process.env.LANCEDB_PATH = join(root, '.lancedb');

const { searchCollection, keywordSearchCollection } = await import('../src/store.ts');

const ROWS = 600;
const QUERY = [1, 0];
// Row i sits at angle i/ROWS * 3 rad from the query, so its cosine distance
// grows with i and the last row is the farthest one.
const vectorAt = (i) => {
  const angle = (i / ROWS) * 3;
  return [Math.cos(angle), Math.sin(angle)];
};

const chunk = (i, overrides = {}) => ({
  id: `row-${i}`,
  vector: vectorAt(i),
  document: `Ordinary archived answer number ${i}`,
  sourceFile: 'synthetic.json',
  provider: 'openai',
  conversationKey: `conversation:${i}`,
  title: 'Synthetic thread',
  role: 'ai',
  turnIndex: String(i),
  model: 'gpt-4o',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdInThreadShelf: false,
  generationProvider: '',
  ...overrides,
});

const rowsWith = (overridesFor) =>
  Array.from({ length: ROWS }, (_, i) => chunk(i, overridesFor(i) ?? {}));

let db;
let vectorSearchCalls = 0;

before(async () => {
  db = await connect(process.env.LANCEDB_PATH);
  await db.createTable(
    'far_model',
    rowsWith((i) => (i === ROWS - 1 ? { model: 'C:\\models\\Special-Model.gguf' } : undefined)),
  );
  await db.createTable(
    'far_role',
    rowsWith((i) => (i === ROWS - 1 ? { role: 'thinking' } : undefined)),
  );
  // The raw path of the near rows contains "special", so the SQL prefilter
  // keeps them; only the exact portable-label check rejects them.
  await db.createTable(
    'superset_model',
    rowsWith((i) =>
      i === ROWS - 1
        ? { model: 'special-x' }
        : i < 300
          ? { model: '/opt/special/other.gguf' }
          : undefined,
    ),
  );
  await db.createTable(
    'unsearchable_near',
    rowsWith((i) => (i < 40 ? { document: 'short' } : undefined)),
  );
  const keywordTable = await db.createTable(
    'keyword_late',
    rowsWith((i) => ({
      document:
        i === ROWS - 1
          ? 'needle needle needle at the very end'
          : `archived needle mention number ${i}`,
      ...(i === 550 ? { model: 'rare-model' } : {}),
    })),
  );
  await db.createTable(
    'legacy_no_model',
    Array.from({ length: 30 }, (_, i) => ({
      id: `legacy-${i}`,
      vector: vectorAt(i),
      document: `Legacy archived needle answer ${i}`,
      sourceFile: 'legacy.json',
      role: 'ai',
      turnIndex: String(i),
    })),
  );

  const prototype = Object.getPrototypeOf(keywordTable);
  const vectorSearch = prototype.vectorSearch;
  prototype.vectorSearch = function (...args) {
    vectorSearchCalls++;
    return vectorSearch.apply(this, args);
  };
});

after(async () => {
  db?.close();
  await rm(root, { recursive: true, force: true });
});

const ids = (rows) => rows.map((row) => row.id);

describe('semantic search filters cover the whole collection', () => {
  it('finds the only row of the selected model even when it is the farthest one', async () => {
    const rows = await searchCollection('far_model', 'q', { n: 5, model: 'special-model' }, QUERY);
    assert.deepStrictEqual(ids(rows), [`row-${ROWS - 1}`]);
    assert.strictEqual(rows[0].metadata.model, 'Special-Model');
  });

  it('accepts a model filter given as a local path, matching on its portable label', async () => {
    const rows = await searchCollection(
      'far_model',
      'q',
      { n: 5, model: String.raw`D:\elsewhere\Special-Model.gguf` },
      QUERY,
    );
    assert.deepStrictEqual(ids(rows), [`row-${ROWS - 1}`]);
  });

  it('keeps the exact portable-label model semantics', async () => {
    // "models" is part of the private path, not of the portable label.
    const rows = await searchCollection('far_model', 'q', { n: 5, model: 'models' }, QUERY);
    assert.deepStrictEqual(rows, []);
  });

  it('finds the only row of the selected role even when it is the farthest one', async () => {
    const rows = await searchCollection('far_role', 'q', { n: 5, roles: ['thinking'] }, QUERY);
    assert.deepStrictEqual(ids(rows), [`row-${ROWS - 1}`]);
  });

  it('widens the window when the exact model check rejects prefiltered rows', async () => {
    const rows = await searchCollection('superset_model', 'q', { n: 5, model: 'special' }, QUERY);
    assert.deepStrictEqual(ids(rows), [`row-${ROWS - 1}`]);
  });

  it('widens the window when nearby rows are not searchable documents', async () => {
    const rows = await searchCollection('unsearchable_near', 'q', { n: 3 }, QUERY);
    assert.deepStrictEqual(ids(rows), ['row-40', 'row-41', 'row-42']);
  });

  it('returns the nearest rows in distance order with one query when nothing is filtered', async () => {
    const before = vectorSearchCalls;
    const rows = await searchCollection('far_role', 'q', { n: 4 }, QUERY);
    assert.strictEqual(vectorSearchCalls - before, 1);
    assert.deepStrictEqual(ids(rows), ['row-0', 'row-1', 'row-2', 'row-3']);
    const distances = rows.map((row) => row.distance);
    assert.deepStrictEqual(
      distances,
      [...distances].sort((a, b) => a - b),
    );
  });

  it('does not throw for a model filter on a table indexed before the model column', async () => {
    assert.deepStrictEqual(
      await searchCollection('legacy_no_model', 'q', { n: 5, model: 'gpt' }, QUERY),
      [],
    );
    const rows = await searchCollection('legacy_no_model', 'q', { n: 2 }, QUERY);
    assert.deepStrictEqual(ids(rows), ['legacy-0', 'legacy-1']);
  });
});

describe('keyword search ranks every match', () => {
  it('ranks the row with the most occurrences first even when it is stored last', async () => {
    const rows = await keywordSearchCollection('keyword_late', 'NEEDLE', { n: 3 });
    // Equal counts and dates keep storage order behind the best match.
    assert.deepStrictEqual(ids(rows), [`row-${ROWS - 1}`, 'row-0', 'row-1']);
  });

  it('applies the model filter beyond the first 200 matches', async () => {
    const rows = await keywordSearchCollection('keyword_late', 'needle', { n: 5, model: 'rare' });
    assert.deepStrictEqual(ids(rows), ['row-550']);
  });

  it('does not throw for a model filter on a table indexed before the model column', async () => {
    assert.deepStrictEqual(
      await keywordSearchCollection('legacy_no_model', 'needle', { n: 5, model: 'gpt' }),
      [],
    );
    const rows = await keywordSearchCollection('legacy_no_model', 'needle', { n: 2 });
    assert.deepStrictEqual(ids(rows), ['legacy-0', 'legacy-1']);
  });
});
