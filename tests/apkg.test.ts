import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import { exportApkg } from '@core/export/apkg.js';
import { openDb } from '@core/db/index.js';
import { insertItem } from '@core/db/repo.js';
import type { Db } from '@core/db/index.js';
import { randomUUID } from 'node:crypto';

/**
 * Anki package export.
 *
 * The test opens the produced file rather than trusting the writer: an .apkg is
 * a zip with a SQLite collection inside, so a malformed one looks fine from the
 * outside and fails only in Anki, where she would be the one to discover it.
 */

let db: Db;
let sourceId: string;
let lectureId: string;

function addItem(
  kind: 'flashcard' | 'cloze' | 'nclex',
  front: string,
  back: string,
  verdict: 'verified' | 'unverified',
  payload?: unknown,
): string {
  const id = insertItem(
    db,
    {
      lectureId,
      kind,
      front,
      back,
      blockIds: [],
      ...(payload !== undefined ? { payload } : {}),
    },
    [
      {
        sourceId,
        claim: `${front} ${back}`,
        excerpt: 'Normal adult serum potassium is 3.5-5.0 mEq/L.',
        verdict,
      },
    ],
  );
  // Items land as 'pending' for triage; these are the ones she kept.
  db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(id);
  return id;
}

beforeAll(() => {
  db = openDb({ path: ':memory:' });
  sourceId = randomUUID();
  lectureId = randomUUID();

  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Fluid and Electrolyte Balance', ?)`,
  ).run(sourceId, 'Normal adult serum potassium is 3.5-5.0 mEq/L.');

  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Fluid and Electrolyte Balance', 'fluid.pptx', 'pptx')`,
  ).run(lectureId, sourceId);

  addItem('flashcard', 'What is the normal adult serum potassium range?', '3.5-5.0 mEq/L', 'verified');
  addItem('cloze', 'Normal adult serum potassium is {{3.5-5.0 mEq/L}}.', '3.5-5.0 mEq/L', 'verified');
  addItem('nclex', 'A client has a potassium of 2.9 mEq/L. Which action is first?', 'Hold the digoxin', 'verified', {
    options: [
      { text: 'Hold the digoxin', isKey: true, rationale: 'Hypokalemia potentiates digoxin toxicity.' },
      { text: 'Give the digoxin', isKey: false, rationale: 'This risks dysrhythmia.' },
    ],
  });
  // Accepted but unverified: must be left behind.
  addItem('flashcard', 'Unsourced claim', 'Should not be exported', 'unverified');
});

describe('exportApkg', () => {
  it('produces a readable zip containing an Anki collection', async () => {
    const result = await exportApkg(db, { lectureId });

    expect(result.filename).toBe('nursedeck.apkg');
    const zip = await JSZip.loadAsync(result.bytes);
    const names = Object.keys(zip.files);

    // Anki accepts collection.anki2 (schema 11) or collection.anki21/b.
    expect(names.some((n) => /^collection\.anki2/.test(n))).toBe(true);
    expect(names).toContain('media');
  });

  it('exports only verified cards and reports what it left behind', async () => {
    const result = await exportApkg(db, { lectureId });
    expect(result.cardCount).toBe(3);
    // The unverified card is accounted for, not silently dropped.
    expect(result.skipped).toBe(1);
  });

  it('never carries an unverified claim into another tool', async () => {
    const result = await exportApkg(db, { lectureId });
    const zip = await JSZip.loadAsync(result.bytes);
    const entry = Object.keys(zip.files).find((n) => /^collection\.anki2/.test(n))!;
    const raw = await zip.files[entry]!.async('uint8array');
    // Scan the raw collection bytes: an exporter bug that wrote the row anyway
    // would still leave the text in the file, whatever the row count says.
    const text = Buffer.from(raw).toString('latin1');
    expect(text).not.toContain('Unsourced claim');
  });

  it('carries the citation with the card', async () => {
    const result = await exportApkg(db, { lectureId });
    const zip = await JSZip.loadAsync(result.bytes);
    const entry = Object.keys(zip.files).find((n) => /^collection\.anki2/.test(n))!;
    const text = Buffer.from(await zip.files[entry]!.async('uint8array')).toString('latin1');
    expect(text).toContain('Normal adult serum potassium is 3.5-5.0 mEq/L.');
  });

  it('rewrites our cloze syntax into Anki cloze syntax', async () => {
    const result = await exportApkg(db, { lectureId });
    const zip = await JSZip.loadAsync(result.bytes);
    const entry = Object.keys(zip.files).find((n) => /^collection\.anki2/.test(n))!;
    const text = Buffer.from(await zip.files[entry]!.async('uint8array')).toString('latin1');
    // {{text}} would render as an Anki field reference and break the card.
    expect(text).toContain('{{c1::3.5-5.0 mEq/L}}');
  });

  it('keeps the per-option rationales that make an NCLEX item teach', async () => {
    const result = await exportApkg(db, { lectureId });
    const zip = await JSZip.loadAsync(result.bytes);
    const entry = Object.keys(zip.files).find((n) => /^collection\.anki2/.test(n))!;
    const text = Buffer.from(await zip.files[entry]!.async('uint8array')).toString('latin1');
    expect(text).toContain('Hypokalemia potentiates digoxin toxicity.');
    expect(text).toContain('This risks dysrhythmia.');
  });
});
