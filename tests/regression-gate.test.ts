import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, type Db } from '@core/db/index.js';
import {
  insertItem, listStudiable, listUnsourced, setCitationVerdict, editItem,
  insertUserCard, insertImportedDeck, vouchItem, deleteItem, listAwaitingVerification,
} from '@core/db/repo.js';
import {
  verifyVerbatim, verifyNumericAgreement, qualifyExcerpt, normalizeForMatch, extractNumbers,
} from '@core/validate/citation.js';
import { slideText } from '@core/generate/prompts.js';
import { orderFragments } from '@core/validate/repair.js';

/**
 * Adversarial regression suite.
 *
 * Every test here is an attempt to get an unsupported claim into the study
 * queue, or to break an invariant that the rest of the app assumes. They are
 * grouped by the route an attacker -- or far more likely, a bad model response
 * or a future refactor -- would take.
 *
 * The invariant under test throughout: NOTHING reaches the study queue without
 * a citation that was verified against text we hold locally.
 */

let db: Db;
let lectureId: string;
let sourceId: string;

const SOURCE_TEXT = [
  'Alterations in Potassium',
  'Hypokalemia (<3.5)',
  '  - S & S',
  '    - Muscle weakness, flat T waves',
  '  - TX: Give oral or IV potassium',
].join('\n');

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  sourceId = randomUUID();
  lectureId = randomUUID();
  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Electrolytes', ?)`,
  ).run(sourceId, SOURCE_TEXT);
  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Electrolytes', 'e.pptx', 'pptx')`,
  ).run(lectureId, sourceId);
});

function addCard(opts: {
  front: string; back: string; excerpt: string;
  verdict?: 'verified' | 'unverified' | 'failed'; accepted?: boolean;
}): string {
  const id = insertItem(
    db,
    { lectureId, kind: 'flashcard', front: opts.front, back: opts.back, blockIds: [] },
    [{ sourceId, claim: `${opts.front} ${opts.back}`, excerpt: opts.excerpt, verdict: opts.verdict ?? 'verified' }],
  );
  if (opts.accepted !== false) {
    db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(id);
  }
  return id;
}

/* ------------------------- the studiable invariant ------------------------- */

describe('REGRESSION: what may be studied', () => {
  it('accepted + verified is studiable', () => {
    addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness, flat T waves' });
    expect(listStudiable(db, { lectureId })).toHaveLength(1);
  });

  it('accepted but UNVERIFIED is not studiable', () => {
    addCard({ front: 'Q', back: 'A', excerpt: 'x', verdict: 'unverified' });
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('accepted but FAILED is not studiable', () => {
    addCard({ front: 'Q', back: 'A', excerpt: 'x', verdict: 'failed' });
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('verified but still PENDING is not studiable', () => {
    addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness', accepted: false });
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('a card with NO citation row at all is not studiable', () => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO items (id, lecture_id, kind, status, front, back)
       VALUES (?, ?, 'flashcard', 'accepted', 'Orphan', 'No citation')`,
    ).run(id, lectureId);
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
    // And it is findable as a bug rather than silently present.
    expect(listUnsourced(db).map((i) => i.id)).toContain(id);
  });

  it('listUnsourced stays empty for a card merely awaiting verification', () => {
    addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness, flat T waves' });
    addCard({ front: 'Q2', back: 'A2', excerpt: 'x', verdict: 'unverified' });
    // Accepted-but-unverified is an ORDINARY state: she kept the card in triage
    // and the audit has not run. It used to trip the "this should never happen"
    // alarm, which made that alarm useless because it was always on.
    expect(listUnsourced(db)).toHaveLength(0);
    expect(listAwaitingVerification(db, { lectureId })).toHaveLength(1);
  });

  it('a verdict downgrade removes a card from study immediately', () => {
    const id = addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness, flat T waves' });
    const [c] = db.prepare('SELECT id FROM citations WHERE item_id = ?').all(id) as { id: string }[];
    setCitationVerdict(db, c!.id, 'failed', { stage: 'entailment', detail: 'recheck' });
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('deleting a card takes its citations with it', () => {
    const id = addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness, flat T waves' });
    deleteItem(db, id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM citations WHERE item_id = ?').get(id) as { n: number };
    expect(left.n).toBe(0);
  });
});

/* --------------------------- editing a card -------------------------------- */

describe('REGRESSION: editing cannot smuggle a claim past the gate', () => {
  it('rewording a GENERATED card drops it out of study', () => {
    const id = addCard({ front: 'What is seen in hypokalemia?', back: 'Flat T waves', excerpt: 'Muscle weakness, flat T waves' });
    expect(listStudiable(db, { lectureId })).toHaveLength(1);

    const r = editItem(db, { itemId: id, back: 'Tall peaked T waves' });
    expect(r.requiresReverification).toBe(true);
    // The quote was checked against the old wording and proves nothing about
    // the new one.
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('editing HER OWN card does not require re-verification', () => {
    const id = insertUserCard(db, { lectureId, kind: 'flashcard', front: 'Mine', back: 'Answer' });
    const r = editItem(db, { itemId: id, back: 'Better answer' });
    expect(r.requiresReverification).toBe(false);
    expect(listStudiable(db, { lectureId })).toHaveLength(1);
  });

  it('a no-op edit does not invalidate a verified card', () => {
    const id = addCard({ front: 'Q', back: 'A', excerpt: 'Muscle weakness, flat T waves' });
    const r = editItem(db, { itemId: id, back: 'A' });
    expect(r.requiresReverification).toBe(false);
    expect(listStudiable(db, { lectureId })).toHaveLength(1);
  });
});

/* --------------------------- imported decks -------------------------------- */

describe('REGRESSION: imported cards', () => {
  function importOne() {
    return insertImportedDeck(db, {
      lectureId,
      filename: 'classmate.txt',
      rawText: 'Hypokalemia\tLow potassium',
      cards: [{ front: 'Hypokalemia', back: 'Low potassium' }],
    });
  }

  it('cannot be studied on import', () => {
    importOne();
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('cannot be studied by accepting the item alone', () => {
    importOne();
    db.prepare("UPDATE items SET status = 'accepted' WHERE imported_from IS NOT NULL").run();
    // Status is not the gate. The citation verdict is.
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('becomes studiable only through vouching', () => {
    importOne();
    const [row] = db.prepare('SELECT id FROM items WHERE imported_from IS NOT NULL').all() as { id: string }[];
    vouchItem(db, row!.id);
    expect(listStudiable(db, { lectureId })).toHaveLength(1);
  });

  it('vouching is refused for a generated card', () => {
    const id = addCard({ front: 'Q', back: 'A', excerpt: 'x', verdict: 'unverified' });
    expect(() => vouchItem(db, id)).toThrow(/imported/i);
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('vouching an unknown id throws rather than doing nothing', () => {
    expect(() => vouchItem(db, randomUUID())).toThrow();
  });
});

/* ------------------------- the verbatim checker ---------------------------- */

describe('REGRESSION: quotes that must not pass', () => {
  const SLIDE = 'Normal adult serum potassium is 3.5-5.0 mEq/L. Hypokalemia is below 3.5.';

  it('rejects a quote that is simply not there', () => {
    expect(verifyVerbatim('Potassium is 3.5-5.3 mEq/L', SLIDE).ok).toBe(false);
  });

  it('rejects elided fragments stitched out of order', () => {
    // Both halves are present; the claim they make together is not.
    const r = verifyVerbatim('Hypokalemia ... Normal adult serum potassium', SLIDE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('fragments_out_of_order');
  });

  it('rejects a quote too short to prove anything', () => {
    expect(verifyVerbatim('potassium', SLIDE).reason).toBe('excerpt_too_short');
  });

  it('rejects an elided quote whose fragments are individually trivial', () => {
    expect(verifyVerbatim('is ... is ... is', SLIDE).reason).toBe('excerpt_too_short');
  });

  it('rejects everything when the source text is missing', () => {
    expect(verifyVerbatim('Normal adult serum potassium is 3.5-5.0 mEq/L', undefined).ok).toBe(false);
  });

  it('still accepts honest typographic drift', () => {
    // Curly quotes, en dash and case are re-rendered constantly by models and
    // change no meaning. Failing these would reject good cards.
    expect(verifyVerbatim('NORMAL ADULT SERUM POTASSIUM IS 3.5–5.0 mEq/L', SLIDE).ok).toBe(true);
  });
});

/* ------------------------- numeric agreement ------------------------------- */

describe('REGRESSION: numbers', () => {
  it('catches a shifted range', () => {
    expect(verifyNumericAgreement('potassium 3.5-5.3', 'potassium is 3.5-5.0').ok).toBe(false);
  });

  it('catches a shifted dose even when the sentence looks right', () => {
    expect(verifyNumericAgreement('Give 40 mEq', 'Give 20 mEq of potassium').ok).toBe(false);
  });

  it('sees numbers glued to letters, which pptx run-splitting produces', () => {
    // "Osmolality275-295mOsm" was the real text after a trimming bug. If these
    // are invisible to the extractor, a wrong value passes unchecked.
    expect(extractNumbers('Osmolality 275-295 mOsm/kg').map((n) => n.value)).toContain(275);
  });

  it('does not treat an identifier as a measurement', () => {
    expect(extractNumbers('COVID19 and T2DM').map((n) => n.value)).not.toContain(19);
  });

  it('passes a claim with no numbers at all', () => {
    expect(verifyNumericAgreement('Hypokalemia causes weakness', 'anything').ok).toBe(true);
  });
});

/* ------------------------ citation qualification --------------------------- */

describe('REGRESSION: qualification cannot invent context', () => {
  it('a qualified quote is still verbatim on its slide', () => {
    const q = qualifyExcerpt('Muscle weakness, flat T waves', SOURCE_TEXT);
    expect(verifyVerbatim(q, SOURCE_TEXT).ok).toBe(true);
  });

  it('does not attach ancestry from a DIFFERENT condition', () => {
    const twoConditions = [
      'Alterations in Potassium',
      'Hypokalemia (<3.5)',
      '  - Flat T waves',
      'Hyperkalemia (>5.0)',
      '  - Tall peaked T waves',
    ].join('\n');
    const q = qualifyExcerpt('Tall peaked T waves', twoConditions);
    expect(q).toContain('Hyperkalemia');
    expect(q).not.toContain('Hypokalemia (<3.5)');
  });

  it('leaves an unlocatable quote untouched rather than guessing', () => {
    expect(qualifyExcerpt('text that is not on this slide', SOURCE_TEXT))
      .toBe('text that is not on this slide');
  });

  it('never qualifies with a structural marker this code wrote', () => {
    const imageOnly = slideText({
      id: 'b', ordinal: 1, body: '',
      imageText: 'METABOLIC ACIDOSIS\nKussmaul Respirations',
    });
    const q = qualifyExcerpt('Kussmaul Respirations', imageOnly);
    expect(q).toContain('METABOLIC ACIDOSIS');
    expect(q.startsWith('Text in the image')).toBe(false);
  });
});

/* ----------------------------- repair safety ------------------------------- */

describe('REGRESSION: repair cannot manufacture evidence', () => {
  it('discards a fragment that is not on the slide', () => {
    expect(orderFragments(['Give oral or IV potassium', 'Give calcium gluconate'], SOURCE_TEXT))
      .toEqual(['Give oral or IV potassium']);
  });

  it('produces fragments that pass the verbatim checker in order', () => {
    const ordered = orderFragments(
      ['Give oral or IV potassium', 'Hypokalemia (<3.5)'],
      SOURCE_TEXT,
    );
    expect(verifyVerbatim(ordered.join(' ... '), SOURCE_TEXT).ok).toBe(true);
  });
});

/* -------------------------- text-rendering agreement ----------------------- */

describe('REGRESSION: one definition of slide text', () => {
  it('normalisation is stable under repeated application', () => {
    const once = normalizeForMatch(SOURCE_TEXT);
    expect(normalizeForMatch(once)).toBe(once);
  });

  it('renders a table row so a citation to it proves something', () => {
    const text = slideText({
      id: 'b', ordinal: 1, body: '',
      tables: [['Disorder', 'pH'], ['Respiratory acidosis', 'down']],
    });
    // "Respiratory acidosis | down" quoted alone cannot say which column is pH.
    expect(text).toContain('Respiratory acidosis - pH: down');
  });

  it('includes speaker notes, which carry most of her exam content', () => {
    const text = slideText({
      id: 'b', ordinal: 1, body: 'Bullet', speakerNotes: 'NEVER GIVE POTASSIUM IV PUSH',
    });
    expect(text).toContain('NEVER GIVE POTASSIUM IV PUSH');
  });
});
