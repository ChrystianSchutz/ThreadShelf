import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  shortPath,
  fmtModel,
  fmtTime,
  fmtDate,
  fmtDateShort,
  fmtRelative,
  escapeRegex,
  isPotentialExport,
  buildThreadMarkdown,
  slugify,
  copyText,
} from '../client/src/utils.ts';

describe('fmtRelative', () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();

  it('returns "just now" for very recent timestamps', () => {
    assert.strictEqual(fmtRelative(ago(10_000), now), 'just now');
  });

  it('formats minutes and hours', () => {
    assert.strictEqual(fmtRelative(ago(5 * 60_000), now), '5 min ago');
    assert.strictEqual(fmtRelative(ago(3 * 3_600_000), now), '3 h ago');
  });

  it('formats days within a week', () => {
    assert.strictEqual(fmtRelative(ago(2 * 86_400_000), now), '2 d ago');
  });

  it('falls back to a calendar date beyond a week', () => {
    const out = fmtRelative(ago(30 * 86_400_000), now);
    assert.ok(!/ago|just now/.test(out));
    assert.ok(out.length > 0);
  });

  it('returns empty string for missing or invalid input', () => {
    assert.strictEqual(fmtRelative(undefined, now), '');
    assert.strictEqual(fmtRelative('not-a-date', now), '');
  });
});

describe('fmtDateShort', () => {
  const iso = '2026-02-16T01:05:09.000Z';

  it('uses the local date format without the seconds fmtDate carries', () => {
    const date = new Date(iso);
    const options = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    };
    const withoutSeconds = new Intl.DateTimeFormat(undefined, options);
    const withSeconds = new Intl.DateTimeFormat(undefined, { ...options, second: '2-digit' });

    assert.strictEqual(fmtDateShort(iso), withoutSeconds.format(date));
    assert.strictEqual(fmtDate(iso), withSeconds.format(date));
    assert.notStrictEqual(fmtDateShort(iso), fmtDate(iso));
  });

  it('returns empty string for missing or invalid input', () => {
    assert.strictEqual(fmtDateShort(undefined), '');
    assert.strictEqual(fmtDateShort('not-a-date'), '');
  });
});

describe('client utility extra boundaries', () => {
  it('keeps exactly two path segments unchanged', () => {
    assert.strictEqual(shortPath('folder/file.json'), 'folder/file.json');
  });

  it('keeps original separators for paths with exactly two segments', () => {
    assert.strictEqual(shortPath('folder\\file.json'), 'folder\\file.json');
  });

  it('formats zero and sub-second durations as zero seconds', () => {
    assert.strictEqual(fmtTime(0), '0s');
    assert.strictEqual(fmtTime(999), '0s');
  });

  it('formats negative durations according to floor semantics', () => {
    assert.strictEqual(fmtTime(-1), '-1s');
  });

  it('only strips a leading lowercase models prefix', () => {
    assert.strictEqual(fmtModel('models/models/demo'), 'models/demo');
    assert.strictEqual(fmtModel('Models/demo'), 'Models/demo');
  });

  it('removes private filesystem paths from local GGUF model labels', () => {
    assert.strictEqual(
      fmtModel('C:\\Users\\private-user\\.lmstudio\\models\\Bielik.Q4_K_M.gguf'),
      'Bielik.Q4_K_M',
    );
    assert.strictEqual(fmtModel('/home/private/models/local-model.gguf'), 'local-model');
    assert.strictEqual(fmtModel('google/gemini-2.0'), 'google/gemini-2.0');
  });

  it('escapes every JavaScript regex metacharacter', () => {
    const literal = '^$\\.*+?()[]{}|';
    assert.strictEqual(new RegExp(`^${escapeRegex(literal)}$`).test(literal), true);
  });

  it('recognizes provider-style JSON export names case-insensitively', () => {
    for (const path of [
      'conversations.json',
      'chatgpt/conversations-000.json',
      'Claude/EXPORT.JSON',
      'openrouter/history.json',
      'gemini/conversation',
    ]) {
      assert.strictEqual(isPotentialExport(path), true, path);
    }
  });

  it('rejects all known metadata names in nested paths and mixed case', () => {
    for (const path of [
      'takeout/USERS.JSON',
      'x/projects.json',
      'x/user.json',
      'x/message_feedback.json',
      'x/shared_conversations.json',
      'x/sora.json',
    ]) {
      assert.strictEqual(isPotentialExport(path), false, path);
    }
  });

  it('rejects provider asset names but allows similarly prefixed JSON', () => {
    assert.strictEqual(isPotentialExport('assets/file_abc.webp'), false);
    assert.strictEqual(isPotentialExport('assets/FILE-123.jpeg'), false);
    assert.strictEqual(isPotentialExport('file-123.json'), true);
  });

  it('rejects ordinary non-JSON files and dotted extensionless lookalikes', () => {
    assert.strictEqual(isPotentialExport('conversation.txt'), false);
    assert.strictEqual(isPotentialExport('.hidden'), false);
    assert.strictEqual(isPotentialExport('archive.tar'), false);
  });

  it('slugifies repeated separators and truncates after normalization', () => {
    assert.strictEqual(slugify('One___Two   Three'), 'one-two-three');
    assert.strictEqual(slugify(`${'a'.repeat(59)} b`), `${'a'.repeat(59)}-`);
  });
});

describe('buildThreadMarkdown extra shapes', () => {
  it('renders a valid createdAt timestamp below the role heading', () => {
    const markdown = buildThreadMarkdown('Dated', [
      { user: 'hello', createdAt: '2026-06-15T10:20:30.000Z' },
    ]);
    assert.match(markdown, /### .+ User\n\*.+\*\n\nhello/);
  });

  it('omits the timestamp line for invalid createdAt values', () => {
    const markdown = buildThreadMarkdown('Undated', [{ ai: 'answer', createdAt: 'not-a-date' }]);
    assert.ok(!markdown.includes('*not-a-date*'));
    assert.match(markdown, /Response\n\nanswer/);
  });

  it('renders a thinking-only thread without response or user headings', () => {
    const markdown = buildThreadMarkdown('Thinking', [{ thinking: 'internal reasoning' }]);
    assert.ok(markdown.includes('Reasoning'));
    assert.ok(!markdown.includes(' User'));
    assert.ok(!markdown.includes('Response'));
  });

  it('renders an ai-only thread and trims turn text', () => {
    const markdown = buildThreadMarkdown('Answer', [{ ai: '  final answer  ' }]);
    assert.ok(markdown.includes('Response'));
    assert.ok(markdown.includes('\nfinal answer\n'));
    assert.ok(!markdown.includes('  final answer  '));
  });

  it('uses role field presence even when the selected text is empty', () => {
    const markdown = buildThreadMarkdown('Empty user', [{ user: '', ai: 'ignored' }]);
    assert.ok(markdown.includes('User'));
    assert.ok(!markdown.includes('Response'));
    assert.ok(!markdown.includes('ignored'));
  });

  it('escapes neither markdown title nor source metadata', () => {
    const markdown = buildThreadMarkdown('# Raw', [], { sourceFile: 'a`b.json' });
    assert.ok(markdown.startsWith('# # Raw'));
    assert.ok(markdown.includes('`a`b.json`'));
  });
});

describe('copyText', () => {
  it('returns true when clipboard writing succeeds', async () => {
    const originalNavigator = globalThis.navigator;
    const written = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (text) => written.push(text) } },
    });
    try {
      assert.strictEqual(await copyText('hello'), true);
      assert.deepStrictEqual(written, ['hello']);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it('returns false when clipboard access fails', async () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error('denied');
          },
        },
      },
    });
    try {
      assert.strictEqual(await copyText('hello'), false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }
  });
});
