import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@core/db/index.js';
import { insertLecture, insertItem, setItemStatus } from '@core/db/repo.js';
import {
  answerCard, readCardState, previewIntervals, dueQueue, deckStats, Rating,
} from '@core/scheduler/fsrs.js';
import type { LectureDoc } from '@shared/types.js';

let db: Db;
let sourceId: string;

const lecture: LectureDoc = {
  id: 'lec-1', sourceFile: '/a.pptx', kind: 'pptx', title: 'Deck', warnings: [],
  blocks: [{ id: 'b1', ordinal: 1, body: 'Normal potassium is 3.5-5.0 mEq/L.' }],
};

/** Adds a studiable item: accepted with a verified citation. */
function addStudiable(front = 'Q'): string {
  const id = insertItem(
    db,
    { lectureId: 'lec-1', kind: 'flashcard', front, back: 'A', blockIds: ['b1'] },
    [{ sourceId, claim: 'c', excerpt: 'e', verdict: 'verified' }],
  );
  setItemStatus(db, id, 'accepted');
  return id;
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  sourceId = insertLecture(db, lecture).sourceId;
});

describe('scheduling', () => {
  it('schedules a new card further out for a better rating', () => {
    const preview = previewIntervals(undefined, new Date('2026-01-01T10:00:00Z'));
    expect(preview.again.getTime()).toBeLessThan(preview.hard.getTime());
    expect(preview.hard.getTime()).toBeLessThan(preview.good.getTime());
    expect(preview.good.getTime()).toBeLessThan(preview.easy.getTime());
  });

  it('advances the due date and records the review', () => {
    const id = addStudiable();
    const now = new Date('2026-01-01T10:00:00Z');

    const state = answerCard(db, { itemId: id, rating: Rating.Good, now });
    expect(state.due.getTime()).toBeGreaterThan(now.getTime());
    expect(state.reps).toBe(1);

    const reviews = db.prepare('SELECT * FROM reviews WHERE item_id = ?').all(id) as Record<string, unknown>[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.['rating']).toBe(Rating.Good);
  });

  it('intervals grow over successive correct answers', () => {
    const id = addStudiable();
    let now = new Date('2026-01-01T10:00:00Z');
    const gaps: number[] = [];

    for (let i = 0; i < 5; i++) {
      const state = answerCard(db, { itemId: id, rating: Rating.Good, now });
      gaps.push(state.due.getTime() - now.getTime());
      now = new Date(state.due.getTime() + 1000);
    }

    // Later intervals must exceed the first; FSRS fuzz makes strict
    // monotonicity between adjacent steps unsafe to assert.
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0]!);
  });

  it('collapses the interval on a lapse', () => {
    const id = addStudiable();
    let now = new Date('2026-01-01T10:00:00Z');

    for (let i = 0; i < 4; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }
    const beforeLapse = readCardState(db, id)!;
    const after = answerCard(db, { itemId: id, rating: Rating.Again, now });

    expect(after.lapses).toBeGreaterThan(beforeLapse.lapses);
    expect(after.due.getTime() - now.getTime())
      .toBeLessThan(beforeLapse.due.getTime() - beforeLapse.lastReview!.getTime());
  });

  it('keeps reviews append-only across many answers', () => {
    const id = addStudiable();
    let now = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      const s = answerCard(db, { itemId: id, rating: i % 3 === 0 ? Rating.Again : Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE item_id = ?').get(id) as { n: number };
    expect(n.n).toBe(10);
    // Exactly one current state row, however many reviews there were.
    const states = db.prepare('SELECT COUNT(*) AS n FROM card_states WHERE item_id = ?').get(id) as { n: number };
    expect(states.n).toBe(1);
  });
});

describe('the due queue', () => {
  it('offers unseen cards and excludes ones scheduled for later', () => {
    const a = addStudiable('A');
    addStudiable('B');

    const now = new Date('2026-01-01T10:00:00Z');
    expect(dueQueue(db, { now }).map((c) => c.isNew)).toEqual([true, true]);

    answerCard(db, { itemId: a, rating: Rating.Easy, now });
    const queue = dueQueue(db, { now });
    expect(queue.map((c) => c.itemId)).not.toContain(a);
  });

  it('brings a card back once it is due', () => {
    const id = addStudiable();
    const now = new Date('2026-01-01T10:00:00Z');
    const state = answerCard(db, { itemId: id, rating: Rating.Good, now });

    expect(dueQueue(db, { now }).map((c) => c.itemId)).not.toContain(id);
    const later = new Date(state.due.getTime() + 60_000);
    expect(dueQueue(db, { now: later }).map((c) => c.itemId)).toContain(id);
  });

  it('NEVER offers an item that is unverified or unaccepted', () => {
    // Accepted but citation not verified.
    const unverified = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'U', back: 'A', blockIds: ['b1'] },
      [{ sourceId, claim: 'c', excerpt: 'e', verdict: 'unverified' }],
    );
    setItemStatus(db, unverified, 'accepted');

    // Verified but still pending triage.
    insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'P', back: 'A', blockIds: ['b1'] },
      [{ sourceId, claim: 'c', excerpt: 'e', verdict: 'verified' }],
    );

    expect(dueQueue(db)).toHaveLength(0);
  });
});

describe('item difficulty (Elo)', () => {
  it('rises when a card is repeatedly failed', () => {
    const id = addStudiable();
    const start = (db.prepare('SELECT elo FROM items WHERE id = ?').get(id) as { elo: number }).elo;

    let now = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Again, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const end = (db.prepare('SELECT elo FROM items WHERE id = ?').get(id) as { elo: number }).elo;
    expect(end).toBeGreaterThan(start);
  });

  it('falls for a card answered easily every time', () => {
    const id = addStudiable();
    const start = (db.prepare('SELECT elo FROM items WHERE id = ?').get(id) as { elo: number }).elo;

    let now = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Easy, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const end = (db.prepare('SELECT elo FROM items WHERE id = ?').get(id) as { elo: number }).elo;
    expect(end).toBeLessThan(start);
  });
});

describe('deck statistics', () => {
  it('counts unseen, due and total correctly', () => {
    addStudiable('A');
    addStudiable('B');
    const c = addStudiable('C');

    const now = new Date('2026-01-01T10:00:00Z');
    let stats = deckStats(db, { now });
    expect(stats.total).toBe(3);
    expect(stats.unseen).toBe(3);

    answerCard(db, { itemId: c, rating: Rating.Good, now });
    stats = deckStats(db, { now });
    expect(stats.unseen).toBe(2);
    expect(stats.dueNow).toBe(0);
  });

  it('withholds a calibration gap until there is enough evidence', () => {
    const id = addStudiable();
    const now = new Date('2026-01-01T10:00:00Z');
    answerCard(db, { itemId: id, rating: Rating.Good, now, confidence: 0.9, correct: true });
    // One rated answer is noise, not a measurement.
    expect(deckStats(db, { now }).calibrationGap).toBeUndefined();
  });

  it('measures overconfidence once there is enough evidence', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    // Six answers, all highly confident, all wrong.
    for (let i = 0; i < 6; i++) {
      const id = addStudiable(`Q${i}`);
      answerCard(db, { itemId: id, rating: Rating.Again, now, confidence: 0.9, correct: false });
    }
    const stats = deckStats(db, { now });
    expect(stats.calibrationGap).toBeCloseTo(0.9, 1);
    // Confident-but-wrong is the highest-value review target, so it is counted.
    expect(stats.illusionOfKnowing).toBe(6);
  });

  it('reports good calibration as a gap near zero', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      const id = addStudiable(`Q${i}`);
      const correct = i < 8; // 80% correct, stated confidence 0.8
      answerCard(db, {
        itemId: id,
        rating: correct ? Rating.Good : Rating.Again,
        now, confidence: 0.8, correct,
      });
    }
    expect(Math.abs(deckStats(db, { now }).calibrationGap!)).toBeLessThan(0.05);
  });
});
