import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ValidationError,
  normalizeCollectionName,
  normalizeCollectionSelector,
  assertDeletableCollection,
  assertClearableCollection,
  normalizeQuery,
  normalizeCount,
  normalizeRoles,
  normalizeBoolean,
  normalizeDateRange,
  validateTurn,
  validateTurns,
  isSafeRelativePath,
} from '../src/validation.js';

describe('normalizeCollectionName', () => {
  it('accepts simple lowercase alpha-numeric', () => {
    assert.strictEqual(normalizeCollectionName('chunks'), 'chunks');
    assert.strictEqual(normalizeCollectionName('proj_2026'), 'proj_2026');
  });

  it('lowercases and slugifies special characters', () => {
    assert.strictEqual(normalizeCollectionName('Foo Bar'), 'foo_bar');
    assert.strictEqual(normalizeCollectionName('A!@#B'), 'a_b');
  });

  it('truncates to 63 chars', () => {
    const long = 'a'.repeat(120);
    assert.strictEqual(normalizeCollectionName(long).length, 63);
  });

  it('rejects null, undefined, empty', () => {
    assert.throws(() => normalizeCollectionName(undefined), ValidationError);
    assert.throws(() => normalizeCollectionName(null), ValidationError);
    assert.throws(() => normalizeCollectionName(''), ValidationError);
    assert.throws(() => normalizeCollectionName('   '), ValidationError);
  });

  it('rejects strings that normalize to only underscores', () => {
    assert.throws(() => normalizeCollectionName('___'), ValidationError);
    assert.throws(() => normalizeCollectionName('!!!'), ValidationError);
  });

  it('rejects the reserved name "all"', () => {
    assert.throws(() => normalizeCollectionName('all'), ValidationError);
    assert.throws(() => normalizeCollectionName('ALL'), ValidationError);
  });

  it('rejects path-traversal-y inputs by slugifying them', () => {
    assert.strictEqual(normalizeCollectionName('../etc/passwd'), 'etc_passwd');
    assert.strictEqual(normalizeCollectionName('..\\..\\boot'), 'boot');
  });

  it('rejects names beginning with separators', () => {
    assert.throws(() => normalizeCollectionName('-'), ValidationError);
    assert.throws(() => normalizeCollectionName('_'), ValidationError);
  });
});

describe('normalizeCollectionSelector', () => {
  it('passes through "all"', () => {
    assert.strictEqual(normalizeCollectionSelector('all'), 'all');
    assert.strictEqual(normalizeCollectionSelector('ALL'), 'all');
  });

  it('defaults to "chunks" when empty', () => {
    assert.strictEqual(normalizeCollectionSelector(undefined), 'chunks');
    assert.strictEqual(normalizeCollectionSelector(''), 'chunks');
    assert.strictEqual(normalizeCollectionSelector(null), 'chunks');
  });

  it('normalizes other names', () => {
    assert.strictEqual(normalizeCollectionSelector('My Project!'), 'my_project');
  });
});

describe('assertDeletableCollection / assertClearableCollection', () => {
  it('refuses to delete protected collections', () => {
    assert.throws(() => assertDeletableCollection('chunks'), ValidationError);
    assert.throws(() => assertDeletableCollection('all'), ValidationError);
    assert.throws(() => assertDeletableCollection('threadshelf_conversations'), ValidationError);
  });

  it('allows clearing a normal collection', () => {
    assert.strictEqual(assertClearableCollection('foo'), 'foo');
  });

  it('rejects clearing "all"', () => {
    assert.throws(() => assertClearableCollection('all'), ValidationError);
    assert.throws(() => assertClearableCollection('threadshelf_conversations'), ValidationError);
  });
});

describe('normalizeQuery', () => {
  it('trims and returns string', () => {
    assert.strictEqual(normalizeQuery('  hello world  '), 'hello world');
  });

  it('rejects empty / whitespace-only', () => {
    assert.throws(() => normalizeQuery(''), ValidationError);
    assert.throws(() => normalizeQuery('   '), ValidationError);
    assert.throws(() => normalizeQuery(undefined), ValidationError);
  });

  it('rejects non-string input', () => {
    assert.throws(() => normalizeQuery(123), ValidationError);
    assert.throws(() => normalizeQuery({}), ValidationError);
    assert.throws(() => normalizeQuery([]), ValidationError);
  });

  it('rejects queries above max length', () => {
    assert.throws(() => normalizeQuery('a'.repeat(5000)), ValidationError);
  });

  it('preserves unicode characters', () => {
    assert.strictEqual(normalizeQuery('zażółć 中文 🚀'), 'zażółć 中文 🚀');
  });
});

describe('normalizeCount', () => {
  it('accepts integer numbers and strings', () => {
    assert.strictEqual(normalizeCount(15), 15);
    assert.strictEqual(normalizeCount('15'), 15);
  });

  it('uses the default when missing', () => {
    assert.strictEqual(normalizeCount(undefined, { defaultValue: 10 }), 10);
    assert.strictEqual(normalizeCount('', { defaultValue: 5 }), 5);
  });

  it('rejects non-numeric / NaN / Infinity / floats', () => {
    assert.throws(() => normalizeCount('abc'), ValidationError);
    assert.throws(() => normalizeCount(NaN), ValidationError);
    assert.throws(() => normalizeCount(Infinity), ValidationError);
    assert.throws(() => normalizeCount(1.5), ValidationError);
  });

  it('enforces min/max', () => {
    assert.throws(() => normalizeCount(0), ValidationError);
    assert.throws(() => normalizeCount(-1), ValidationError);
    assert.throws(() => normalizeCount(51), ValidationError);
    assert.strictEqual(normalizeCount(50), 50);
    assert.strictEqual(normalizeCount(1), 1);
  });
});

describe('normalizeRoles', () => {
  it('returns null when no filter is provided', () => {
    assert.strictEqual(normalizeRoles(undefined), null);
    assert.strictEqual(normalizeRoles(''), null);
    assert.strictEqual(normalizeRoles([]), null);
  });

  it('accepts comma-separated and array forms', () => {
    assert.deepStrictEqual(normalizeRoles('user,ai'), ['user', 'ai']);
    assert.deepStrictEqual(normalizeRoles(['User', 'AI']), ['user', 'ai']);
  });

  it('deduplicates and ignores blanks', () => {
    assert.deepStrictEqual(normalizeRoles('user, user , , ai '), ['user', 'ai']);
  });

  it('rejects unknown roles', () => {
    assert.throws(() => normalizeRoles('user,system'), ValidationError);
    assert.throws(() => normalizeRoles(['developer']), ValidationError);
  });
});

describe('normalizeBoolean', () => {
  it('accepts canonical truthy and falsy strings', () => {
    for (const v of ['1', 'true', 'YES', 'on']) assert.strictEqual(normalizeBoolean(v), true);
    for (const v of ['0', 'false', 'no', 'OFF']) assert.strictEqual(normalizeBoolean(v), false);
  });

  it('rejects garbage', () => {
    assert.throws(() => normalizeBoolean('maybe'), ValidationError);
    assert.throws(() => normalizeBoolean({}), ValidationError);
  });

  it('honours default when empty', () => {
    assert.strictEqual(normalizeBoolean(undefined), false);
    assert.strictEqual(normalizeBoolean(undefined, { defaultValue: true }), true);
  });
});

describe('normalizeDateRange', () => {
  it('accepts date-only bounds and expands them to ISO strings', () => {
    assert.deepStrictEqual(normalizeDateRange('2026-01-02', '2026-01-03'), {
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T23:59:59.999Z',
    });
  });

  it('rejects invalid dates and reversed ranges', () => {
    assert.throws(() => normalizeDateRange('not-a-date', undefined), ValidationError);
    assert.throws(() => normalizeDateRange('2026-02-01', '2026-01-01'), ValidationError);
  });
});

describe('validateTurn / validateTurns', () => {
  it('accepts a minimal user turn', () => {
    const turn = { user: 'Hi' };
    assert.deepStrictEqual(validateTurn(turn, { index: 0 }), {
      role: 'user',
      text: 'Hi',
      model: undefined,
    });
  });

  it('rejects turn with multiple role fields', () => {
    assert.throws(() => validateTurn({ user: 'Hi', ai: 'Yo' }, { index: 0 }), ValidationError);
  });

  it('rejects turn with no role fields', () => {
    assert.throws(() => validateTurn({}, { index: 0 }), ValidationError);
    assert.throws(() => validateTurn({ model: 'gpt' }, { index: 0 }), ValidationError);
  });

  it('rejects empty role string', () => {
    assert.throws(() => validateTurn({ user: '' }, { index: 0 }), ValidationError);
  });

  it('rejects non-object turns', () => {
    assert.throws(() => validateTurn(null, { index: 0 }), ValidationError);
    assert.throws(() => validateTurn('hi', { index: 0 }), ValidationError);
    assert.throws(() => validateTurn([], { index: 0 }), ValidationError);
  });

  it('rejects non-string role values', () => {
    assert.throws(() => validateTurn({ user: 42 }, { index: 0 }), ValidationError);
  });

  it('rejects empty/blank model string when present', () => {
    assert.throws(() => validateTurn({ ai: 'hi', model: '' }, { index: 0 }), ValidationError);
    assert.throws(() => validateTurn({ ai: 'hi', model: '   ' }, { index: 0 }), ValidationError);
  });

  it('validates a list', () => {
    const turns = [{ user: 'Hi' }, { ai: 'Hello', model: 'gpt' }, { thinking: '...' }];
    assert.strictEqual(validateTurns(turns), turns);
  });

  it('accepts ThreadShelf turn provenance', () => {
    const turns = [
      {
        user: 'Local prompt',
        model: 'model.gguf',
        createdInThreadShelf: true,
        generationProvider: 'llama-cpp',
      },
      {
        ai: 'Remote answer',
        model: 'provider/model',
        createdInThreadShelf: true,
        generationProvider: 'openrouter',
      },
    ];
    assert.strictEqual(validateTurns(turns), turns);
  });

  it('rejects malformed ThreadShelf turn provenance', () => {
    assert.throws(
      () => validateTurn({ user: 'Hi', createdInThreadShelf: 'yes' }, { index: 2 }),
      /createdInThreadShelf.*boolean/,
    );
    assert.throws(
      () => validateTurn({ ai: 'Hi', generationProvider: 'unknown' }, { index: 3 }),
      /generationProvider.*llama-cpp, openrouter or strata/,
    );
  });

  it('throws on first bad turn in list', () => {
    assert.throws(() => validateTurns([{ user: 'ok' }, {}]), ValidationError);
  });
});

describe('isSafeRelativePath', () => {
  it('accepts simple relative paths', () => {
    assert.strictEqual(isSafeRelativePath('a/b/c.json'), true);
    assert.strictEqual(isSafeRelativePath('foo.json'), true);
  });

  it('rejects absolute and traversal paths', () => {
    assert.strictEqual(isSafeRelativePath('/etc/passwd'), false);
    assert.strictEqual(isSafeRelativePath('C:\\Windows\\system32'), false);
    assert.strictEqual(isSafeRelativePath('a/../b'), false);
    assert.strictEqual(isSafeRelativePath('..'), false);
  });

  it('rejects nullbytes and absurdly long inputs', () => {
    assert.strictEqual(isSafeRelativePath('a\0b'), false);
    assert.strictEqual(isSafeRelativePath('a'.repeat(2000)), false);
  });

  it('rejects empty / non-string', () => {
    assert.strictEqual(isSafeRelativePath(''), false);
    assert.strictEqual(isSafeRelativePath(null), false);
    assert.strictEqual(isSafeRelativePath(123), false);
  });
});
