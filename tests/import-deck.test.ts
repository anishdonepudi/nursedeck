import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseDeckText, dedupeRows, splitDelimited } from '@core/import/deck.js';
import { openDb, type Db } from '@core/db/index.js';
import { insertImportedDeck, vouchItem, listStudiable, listDeck } from '@core/db/repo.js';

describe('parseDeckText', () => {
  it('honours Anki\'s own separator directive instead of guessing', () => {
    const text = [
      '#separator:tab',
      '#html:true',
      '#columns:Front\tBack\tTags',
      'What is the normal serum potassium?\t3.5-5.0 mEq/L\tlabs',
    ].join('\n');

    const r = parseDeckText(text);
    expect(r.dialect).toBe('anki-tsv');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({
      front: 'What is the normal serum potassium?',
      back: '3.5-5.0 mEq/L',
      tags: ['labs'],
    });
  });

  it('reads a Quizlet-style CSV with quoted commas', () => {
    const text = 'Front,Back\n"Signs of hypokalemia","Weakness, cramps, flat T waves"';
    const r = parseDeckText(text);
    expect(r.rows).toHaveLength(1);
    // The quoted comma must not split the field, or every such card is mangled.
    expect(r.rows[0]!.back).toBe('Weakness, cramps, flat T waves');
  });

  it('strips the HTML that Anki puts in its fields', () => {
    const text = '#separator:tab\nWhat is ADH?<br>Hint<b>!</b>\tRetains water &amp; raises BP';
    const r = parseDeckText(text);
    expect(r.rows[0]!.front).toBe('What is ADH?\nHint!');
    expect(r.rows[0]!.back).toBe('Retains water & raises BP');
  });

  it('drops a header row rather than importing it as a card', () => {
    const r = parseDeckText('Term,Definition\nHypokalemia,Low potassium');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.front).toBe('Hypokalemia');
  });

  it('reports lines it could not read instead of dropping them silently', () => {
    const r = parseDeckText('#separator:tab\nGood question\tGood answer\nLonely line with no answer');
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toBe('no answer');
  });

  it('handles doubled quotes inside a quoted field', () => {
    expect(splitDelimited('"she said ""never"" push K+",ok', ',')).toEqual([
      'she said "never" push K+',
      'ok',
    ]);
  });
});

describe('dedupeRows', () => {
  it('collapses the same card appearing twice', () => {
    const { rows, duplicates } = dedupeRows([
      { front: 'A', back: 'B', tags: [] },
      { front: 'a', back: ' b ', tags: [] },
      { front: 'C', back: 'D', tags: [] },
    ]);
    expect(rows).toHaveLength(2);
    expect(duplicates).toBe(1);
  });
});

describe('insertImportedDeck', () => {
  let db: Db;
  let lectureId: string;

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    const sourceId = randomUUID();
    lectureId = randomUUID();
    db.prepare(
      `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
       VALUES (?, 'lecture', 'A', 'Course lecture', 'Fluids', '')`,
    ).run(sourceId);
    db.prepare(
      `INSERT INTO lectures (id, source_id, title, source_file, kind)
       VALUES (?, ?, 'Fluids', 'fluids.pptx', 'pptx')`,
    ).run(lectureId, sourceId);
  });

  const RAW = 'Hypokalemia\tLow potassium\nHyperkalemia\tHigh potassium';

  function importTwo() {
    return insertImportedDeck(db, {
      lectureId,
      filename: 'classmate-deck.txt',
      rawText: RAW,
      cards: [
        { front: 'Hypokalemia', back: 'Low potassium' },
        { front: 'Hyperkalemia', back: 'High potassium' },
      ],
    });
  }

  it('imports the cards', () => {
    const r = importTwo();
    expect(r.imported).toBe(2);
    expect(r.duplicates).toBe(0);
  });

  it('NEVER makes an imported card studiable on its own', () => {
    importTwo();
    // This is the whole point. A classmate's deck carries no evidence, so it
    // must not reach the study queue just because it was imported.
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('shows where an imported card came from', () => {
    importTwo();
    const cards = listDeck(db, { lectureId });
    expect(cards).toHaveLength(2);
    expect(cards[0]!.authoredBy).toBe('imported');
    expect(cards[0]!.importedFrom).toBe('classmate-deck.txt');
    expect(cards[0]!.verified).toBe(false);
  });

  it('skips a card it already has', () => {
    importTwo();
    const again = importTwo();
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(2);
  });

  it('becomes studiable only once she vouches for it', () => {
    importTwo();
    const [card] = listDeck(db, { lectureId });
    vouchItem(db, card!.id);

    const studiable = listStudiable(db, { lectureId });
    expect(studiable).toHaveLength(1);
    expect(studiable[0]!.id).toBe(card!.id);
  });

  it('records that SHE vouched, not that a lecture backed it', () => {
    importTwo();
    const [card] = listDeck(db, { lectureId });
    vouchItem(db, card!.id);

    const citation = db
      .prepare("SELECT excerpt FROM citations WHERE item_id = ? AND verdict = 'verified'")
      .get(card!.id) as { excerpt: string };
    // A promoted card must never be mistakable later for a verified one.
    expect(citation.excerpt).toMatch(/kept by you/i);
  });

  it('refuses to vouch for a generated card', () => {
    const itemId = randomUUID();
    db.prepare(
      `INSERT INTO items (id, lecture_id, kind, status, front, back)
       VALUES (?, ?, 'flashcard', 'pending', 'Generated', 'Card')`,
    ).run(itemId, lectureId);

    // Generated cards must pass the citation gate. Letting this through would
    // make the gate optional, which is the same as not having one.
    expect(() => vouchItem(db, itemId)).toThrow(/imported card/i);
  });
});
