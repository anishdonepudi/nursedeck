import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, transaction, type Db } from '@core/db/index.js';
import {
  insertSource, insertLecture, insertItem, setItemStatus, setCitationVerdict,
  listPending, listStudiable, listUnsourced, listCitations, listItemBlocks,
  searchItems, listLectures, getSourceText,
} from '@core/db/repo.js';
import type { LectureDoc } from '@shared/types.js';

/**
 * The central assertion in this file is that an item cannot become studiable
 * without a verified citation. That is the accuracy guarantee expressed as a
 * database invariant, so it is tested as one.
 */

let db: Db;

const lecture: LectureDoc = {
  id: 'lec-1',
  sourceFile: '/lectures/week3.pptx',
  kind: 'pptx',
  title: 'Fluid and Electrolyte Balance',
  warnings: ['one slide had no text'],
  blocks: [
    {
      id: 'blk-1',
      ordinal: 1,
      heading: 'Potassium',
      body: 'Normal adult serum potassium is 3.5-5.0 mEq/L.',
      speakerNotes: 'Stress that IV push potassium is fatal.',
    },
    { id: 'blk-2', ordinal: 2, heading: 'Sodium', body: 'Normal serum sodium is 135-145 mEq/L.' },
  ],
};

beforeEach(() => {
  db = openDb({ path: ':memory:' });
});

describe('migrations', () => {
  it('applies on open and is idempotent', () => {
    // openDb already migrated; a second run must apply nothing.
    expect(migrate(db)).toBe(0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ['sources', 'lectures', 'blocks', 'items', 'citations', 'reviews', 'exams']) {
      expect(names).toContain(t);
    }
  });

  it('enforces foreign keys, so citations cannot outlive their item', () => {
    insertLecture(db, lecture);
    const id = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['blk-1'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e' }],
    );
    expect(listCitations(db, id)).toHaveLength(1);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    expect(listCitations(db, id)).toHaveLength(0);
  });
});

function sourceIdOf(): string {
  const r = db.prepare('SELECT source_id FROM lectures WHERE id = ?').get('lec-1') as
    | { source_id: string }
    | undefined;
  return r!.source_id;
}

describe('lecture import', () => {
  it('stores blocks in order and registers the lecture as a citable source', () => {
    const { sourceId } = insertLecture(db, lecture);

    const blocks = db.prepare('SELECT * FROM blocks ORDER BY ordinal').all() as Record<string, unknown>[];
    expect(blocks.map((b) => b['ordinal'])).toEqual([1, 2]);
    expect(blocks[0]?.['speaker_notes']).toContain('IV push potassium is fatal');

    // The lecture's own text must be citable, or cards drawn from a slide
    // could never be verified.
    const text = getSourceText(db, sourceId);
    expect(text).toContain('3.5-5.0 mEq/L');
    expect(text).toContain('IV push potassium is fatal');
  });

  it('round-trips warnings and lists lectures', () => {
    insertLecture(db, lecture);
    const list = listLectures(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe('Fluid and Electrolyte Balance');
    expect(list[0]?.itemCount).toBe(0);
  });

  it('removes blocks when the lecture is deleted', () => {
    insertLecture(db, lecture);
    db.prepare('DELETE FROM lectures WHERE id = ?').run('lec-1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM blocks').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('the studiable invariant', () => {
  function addItem(verdict: 'unverified' | 'verified' | 'failed', front = 'Q') {
    return insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front, back: 'A', blockIds: ['blk-1'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e', verdict }],
    );
  }

  beforeEach(() => {
    insertLecture(db, lecture);
  });

  it('generated items start pending, not studiable', () => {
    addItem('verified');
    expect(listPending(db, 'lec-1')).toHaveLength(1);
    expect(listStudiable(db)).toHaveLength(0);
  });

  it('accepting an item with a verified citation makes it studiable', () => {
    const id = addItem('verified');
    setItemStatus(db, id, 'accepted');
    const studiable = listStudiable(db);
    expect(studiable).toHaveLength(1);
    expect(studiable[0]?.verifiedCitations).toBe(1);
  });

  it('REFUSES to study an accepted item whose citation is unverified', () => {
    const id = addItem('unverified');
    setItemStatus(db, id, 'accepted');
    expect(listStudiable(db)).toHaveLength(0);
  });

  it('REFUSES to study an accepted item whose citation FAILED verification', () => {
    const id = addItem('failed');
    setItemStatus(db, id, 'accepted');
    expect(listStudiable(db)).toHaveLength(0);
  });

  it('surfaces accepted-but-unsourced items so the bug is detectable', () => {
    const id = addItem('failed');
    setItemStatus(db, id, 'accepted');
    const unsourced = listUnsourced(db);
    expect(unsourced).toHaveLength(1);
    expect(unsourced[0]?.id).toBe(id);
  });

  it('listUnsourced is empty in the healthy case', () => {
    const id = addItem('verified');
    setItemStatus(db, id, 'accepted');
    expect(listUnsourced(db)).toHaveLength(0);
  });

  it('a rejected item is never studiable even when fully verified', () => {
    const id = addItem('verified');
    setItemStatus(db, id, 'rejected');
    expect(listStudiable(db)).toHaveLength(0);
  });

  it('becomes studiable once a pending citation is later verified', () => {
    const id = addItem('unverified');
    setItemStatus(db, id, 'accepted');
    expect(listStudiable(db)).toHaveLength(0);

    const [citation] = listCitations(db, id);
    setCitationVerdict(db, citation!.id, 'verified', { matchedAt: 42 });

    expect(listStudiable(db)).toHaveLength(1);
    expect(listCitations(db, id)[0]?.matchedAt).toBe(42);
  });
});

describe('provenance', () => {
  beforeEach(() => insertLecture(db, lecture));

  it('links an item back to the slides it came from', () => {
    const id = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['blk-2', 'blk-1'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e', verdict: 'verified' }],
    );
    const blocks = listItemBlocks(db, id);
    // Returned in slide order regardless of the order supplied.
    expect(blocks.map((b) => b.ordinal)).toEqual([1, 2]);
    expect(blocks[0]?.heading).toBe('Potassium');
  });

  it('exposes the licence tier alongside each citation', () => {
    const tierB = insertSource(db, {
      kind: 'article',
      licenseTier: 'B',
      groupOrAuthors: 'StatPearls',
      title: 'Hypokalemia',
      fullText: 'some text',
    });
    const id = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['blk-1'] },
      [{ sourceId: tierB, claim: 'c', excerpt: 'some text', verdict: 'verified' }],
    );
    expect(listCitations(db, id)[0]?.licenseTier).toBe('B');
  });

  it('records the failure stage when verification fails', () => {
    const id = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['blk-1'] },
      [{
        sourceId: sourceIdOf(), claim: 'c', excerpt: 'e',
        verdict: 'failed', failureStage: 'numeric', failureDetail: 'Not present: 5.3',
      }],
    );
    const c = listCitations(db, id)[0];
    expect(c?.verdict).toBe('failed');
    expect(c?.failureStage).toBe('numeric');
    expect(c?.failureDetail).toContain('5.3');
  });
});

describe('search', () => {
  beforeEach(() => insertLecture(db, lecture));

  it('finds items by full-text match', () => {
    insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Normal potassium range?', back: '3.5-5.0 mEq/L', blockIds: ['blk-1'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e', verdict: 'verified' }],
    );
    insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Normal sodium range?', back: '135-145 mEq/L', blockIds: ['blk-2'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e', verdict: 'verified' }],
    );

    expect(searchItems(db, 'potassium')).toHaveLength(1);
    expect(searchItems(db, 'sodium')[0]?.back).toContain('135-145');
  });

  it('keeps the index in step when an item is deleted', () => {
    const id = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'magnesium range', back: '1.3-2.1', blockIds: ['blk-1'] },
      [{ sourceId: sourceIdOf(), claim: 'c', excerpt: 'e', verdict: 'verified' }],
    );
    expect(searchItems(db, 'magnesium')).toHaveLength(1);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    expect(searchItems(db, 'magnesium')).toHaveLength(0);
  });
});

describe('transactions', () => {
  it('rolls back every write when the body throws', () => {
    insertLecture(db, lecture);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

    expect(() =>
      transaction(db, () => {
        db.prepare(
          "INSERT INTO items (id, lecture_id, kind, front, back) VALUES ('x','lec-1','flashcard','f','b')",
        ).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const after = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('rolls back a partially-written item when a citation is invalid', () => {
    insertLecture(db, lecture);
    expect(() =>
      insertItem(
        db,
        { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['blk-1'] },
        // Source does not exist: the FK must reject it.
        [{ sourceId: 'no-such-source', claim: 'c', excerpt: 'e' }],
      ),
    ).toThrow();
    // The item must not survive its failed citation.
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 0 });
  });
});
