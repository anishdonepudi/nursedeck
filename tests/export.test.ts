import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@core/db/index.js';
import { insertLecture, insertItem, setItemStatus } from '@core/db/repo.js';
import { exportDeck } from '@core/export/csv.js';
import type { LectureDoc } from '@shared/types.js';

let db: Db;
let sourceId: string;

const lecture: LectureDoc = {
  id: 'lec-1', sourceFile: '/a.pptx', kind: 'pptx', title: 'Deck', warnings: [],
  blocks: [{ id: 'b1', ordinal: 1, body: 'Normal potassium is 3.5-5.0 mEq/L.' }],
};

function add(
  front: string,
  back: string,
  opts: { kind?: 'flashcard' | 'cloze' | 'nclex'; verdict?: 'verified' | 'unverified'; payload?: unknown } = {},
): string {
  const id = insertItem(
    db,
    {
      lectureId: 'lec-1',
      kind: opts.kind ?? 'flashcard',
      front, back,
      blockIds: ['b1'],
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    },
    [{
      sourceId,
      claim: back,
      excerpt: 'Normal potassium is 3.5-5.0 mEq/L.',
      verdict: opts.verdict ?? 'verified',
    }],
  );
  setItemStatus(db, id, 'accepted');
  return id;
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  sourceId = insertLecture(db, lecture).sourceId;
});

describe('deck export', () => {
  it('exports verified cards as Anki TSV with the right directives', () => {
    add('What is the normal potassium range?', '3.5-5.0 mEq/L');
    const out = exportDeck(db, { format: 'anki-tsv' });

    expect(out.cardCount).toBe(1);
    expect(out.content).toContain('#separator:tab');
    expect(out.content).toContain('#columns:Front\tBack\tTags');
    expect(out.content).toContain('What is the normal potassium range?\t');
  });

  it('EXCLUDES unverified cards, and says how many it withheld', () => {
    add('Verified question?', 'yes');
    add('Unverified question?', 'no', { verdict: 'unverified' });

    const out = exportDeck(db, { format: 'anki-tsv' });
    expect(out.cardCount).toBe(1);
    expect(out.skipped).toBe(1);
    // Unchecked content must not leak into a tool that cannot tell.
    expect(out.content).not.toContain('Unverified question?');
  });

  it('attaches the source quote to the back of each card', () => {
    add('Q?', 'A');
    const out = exportDeck(db, { format: 'anki-tsv' });
    expect(out.content).toContain('Source (slide 1): "Normal potassium is 3.5-5.0 mEq/L."');
  });

  it('can omit citations when asked', () => {
    add('Q?', 'A');
    const out = exportDeck(db, { format: 'anki-tsv', includeCitations: false });
    expect(out.content).not.toContain('Source');
  });

  it('turns a cloze blank into something still answerable', () => {
    add('Normal potassium is {{3.5-5.0 mEq/L}}.', '3.5-5.0 mEq/L', { kind: 'cloze' });
    const out = exportDeck(db, { format: 'anki-tsv' });
    expect(out.content).toContain('Normal potassium is [...]');
    expect(out.content).not.toContain('{{');
  });

  it('flattens an NCLEX item into answer-plus-rationales', () => {
    add('A client is bradycardic. What should the nurse do?', 'Hold the dose', {
      kind: 'nclex',
      payload: {
        itemType: 'multiple_choice',
        options: [
          { text: 'Hold the dose', isKey: true, rationale: 'Correct below 60 bpm.' },
          { text: 'Give the dose', isKey: false, rationale: 'Would worsen bradycardia.' },
        ],
      },
    });
    const out = exportDeck(db, { format: 'anki-tsv' });
    expect(out.content).toContain('✓ Hold the dose — Correct below 60 bpm.');
    expect(out.content).toContain('✗ Give the dose — Would worsen bradycardia.');
  });

  it('tags cards by kind so they can be filtered after import', () => {
    add('Q?', 'A', { kind: 'cloze' });
    expect(exportDeck(db, { format: 'anki-tsv' }).content).toMatch(/\tcloze$/m);
  });
});

describe('field escaping', () => {
  it('quotes CSV fields containing commas, quotes and newlines', () => {
    add('Which values are normal: 3.5, 4.0, or 5.0?', 'He said "yes", then left');
    const out = exportDeck(db, { format: 'quizlet-csv' });

    // A comma inside a field must not become a column break.
    expect(out.content).toContain('"Which values are normal: 3.5, 4.0, or 5.0?"');
    // Embedded quotes are doubled, per RFC 4180.
    expect(out.content).toContain('""yes""');
  });

  it('neutralises tabs and newlines in TSV, which has no escaping', () => {
    add('Line one\nline two', 'has\ta tab');
    const out = exportDeck(db, { format: 'anki-tsv' });

    const dataLines = out.content.split('\n').filter((l) => !l.startsWith('#'));
    // A newline inside a field would otherwise split one card into two records.
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain('Line one<br>line two');
    // Three columns exactly: a stray tab would shift every later column.
    expect(dataLines[0]!.split('\t')).toHaveLength(3);
  });
});
