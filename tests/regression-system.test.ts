import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, type Db } from '@core/db/index.js';
import { insertItem, listStudiable } from '@core/db/repo.js';
import { answerCard, readCardState, dueQueue, deckStats, previewIntervals } from '@core/scheduler/fsrs.js';
import { topicReadiness, illusionOfKnowing, leeches } from '@core/scheduler/mastery.js';
import { checkPolicy, DENIED_HOSTS, ALLOWED_HOSTS } from '@core/sources/http.js';
import { scoreItem } from '@core/exam/scoring.js';
import { parseDeckText } from '@core/import/deck.js';
import { toSpokenText } from '@shared/spoken.js';
import { ratingForCoverage } from '@core/study/teachback.js';

/**
 * Regression suite for everything that is not the citation gate: scheduling,
 * fetch policy, exam scoring, import parsing, and the small pure helpers.
 *
 * Bias here is toward the inputs that actually occur -- her decks, her answers,
 * an empty database on day one -- and toward the edges where a wrong result
 * would be believed rather than noticed.
 */

let db: Db;
let lectureId: string;
let sourceId: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  sourceId = randomUUID();
  lectureId = randomUUID();
  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Electrolytes', 'Potassium 3.5-5.0 mEq/L')`,
  ).run(sourceId);
  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Electrolytes', 'e.pptx', 'pptx')`,
  ).run(lectureId, sourceId);
});

function studiableCard(front = 'Q', back = 'A'): string {
  const id = insertItem(
    db,
    { lectureId, kind: 'flashcard', front, back, blockIds: [] },
    [{ sourceId, claim: `${front} ${back}`, excerpt: 'Potassium 3.5-5.0 mEq/L', verdict: 'verified' }],
  );
  db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(id);
  return id;
}

/* -------------------------------- scheduling ------------------------------- */

describe('REGRESSION: scheduling', () => {
  it('an empty deck reports zeros rather than throwing', () => {
    const stats = deckStats(db, { lectureId });
    expect(stats.total).toBe(0);
    expect(dueQueue(db, { lectureId })).toHaveLength(0);
  });

  it('a new card is due immediately', () => {
    studiableCard();
    expect(dueQueue(db, { lectureId })).toHaveLength(1);
  });

  it('answering Good pushes the card out of today', () => {
    const id = studiableCard();
    answerCard(db, { itemId: id, rating: 3 });
    const state = readCardState(db, id)!;
    expect(new Date(state.due).getTime()).toBeGreaterThan(Date.now());
  });

  it('counts a lapse only once a REVIEW card is forgotten', () => {
    const id = studiableCard();
    // A lapse is forgetting something already learned. A card still in learning
    // has not been learned yet, so Again there is not a lapse -- it just repeats
    // the step. Two Goods graduate it to review; the Again after that is the
    // lapse, and that is what leech detection counts.
    answerCard(db, { itemId: id, rating: 3 });
    answerCard(db, { itemId: id, rating: 3 });
    expect(readCardState(db, id)!.lapses).toBe(0);

    answerCard(db, { itemId: id, rating: 1 });
    expect(readCardState(db, id)!.lapses).toBe(1);
    expect(leeches(db, { minLapses: 1, limit: 10 }).map((l) => l.itemId)).toContain(id);
  });

  it('does not double-count a second Again while relearning', () => {
    const id = studiableCard();
    answerCard(db, { itemId: id, rating: 3 });
    answerCard(db, { itemId: id, rating: 3 });
    answerCard(db, { itemId: id, rating: 1 });
    answerCard(db, { itemId: id, rating: 1 });
    // Still one lapse: she forgot it once and is working back, not twice.
    // Counting each failed relearning step would inflate the leech list with
    // cards she is actively fixing.
    expect(readCardState(db, id)!.lapses).toBe(1);
  });

  it('every review is kept, because mastery is derived from the log', () => {
    const id = studiableCard();
    answerCard(db, { itemId: id, rating: 3 });
    answerCard(db, { itemId: id, rating: 2 });
    const n = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE item_id = ?').get(id) as { n: number };
    expect(n.n).toBe(2);
  });

  it('shows four distinct intervals, increasing with the rating', () => {
    const id = studiableCard();
    const p = previewIntervals(readCardState(db, id));
    const t = (d: Date | string) => new Date(d).getTime();
    expect(t(p.again)).toBeLessThanOrEqual(t(p.hard));
    expect(t(p.hard)).toBeLessThanOrEqual(t(p.good));
    expect(t(p.good)).toBeLessThanOrEqual(t(p.easy));
  });

  it('keeps confidence separate from correctness', () => {
    const id = studiableCard();
    // Confident and wrong is the most valuable signal in the system, and it is
    // unrecoverable if the two are conflated.
    answerCard(db, { itemId: id, rating: 1, confidence: 0.95, correct: false });
    const row = db
      .prepare('SELECT confidence, correct FROM reviews WHERE item_id = ?')
      .get(id) as { confidence: number; correct: number };
    expect(row.confidence).toBeCloseTo(0.95);
    expect(row.correct).toBe(0);
    expect(illusionOfKnowing(db, 10).map((i) => i.itemId)).toContain(id);
  });

  it('reports readiness with an interval, never a bare number on no data', () => {
    studiableCard();
    const topics = topicReadiness(db, { lectureId });
    for (const t of topics) {
      // A credible interval that collapsed to a point from one review would be
      // a lie she plans her studying around.
      expect(t.high).toBeGreaterThanOrEqual(t.low);
    }
  });
});

/* ------------------------------- fetch policy ------------------------------ */

describe('REGRESSION: what may be fetched', () => {
  it('refuses every commercial test-prep vendor', () => {
    for (const host of ['www.uworld.com', 'www.atitesting.com', 'www.kaptest.com',
      'www.archerreview.com', 'www.hesiinet.com', 'quizlet.com']) {
      expect(checkPolicy(`https://${host}/x`).ok).toBe(false);
    }
  });

  it('refuses a host that is simply not on the list', () => {
    expect(checkPolicy('https://example.com/nursing').ok).toBe(false);
  });

  it('refuses plain http even for an allowed host', () => {
    expect(checkPolicy('http://dailymed.nlm.nih.gov/x').ok).toBe(false);
  });

  it('refuses a lookalike subdomain of an allowed host', () => {
    // Allow-listing is exact-host, so this must not slip through.
    expect(checkPolicy('https://api.fda.gov.evil.com/drug').ok).toBe(false);
  });

  it('allows the free public sources it is supposed to', () => {
    expect(checkPolicy('https://dailymed.nlm.nih.gov/x').ok).toBe(true);
    expect(checkPolicy('https://api.fda.gov/drug/label.json').ok).toBe(true);
  });

  it('gives a reason for every denial, so nobody re-adds one blindly', () => {
    for (const [host, reason] of Object.entries(DENIED_HOSTS)) {
      expect(reason.length, host).toBeGreaterThan(10);
    }
  });

  it('never lists a host as both allowed and denied', () => {
    for (const host of Object.keys(ALLOWED_HOSTS)) {
      expect(DENIED_HOSTS[host], host).toBeUndefined();
    }
  });

  it('rejects a malformed URL rather than throwing', () => {
    expect(checkPolicy('not a url').ok).toBe(false);
  });
});

/* ------------------------------- exam scoring ------------------------------ */

describe("REGRESSION: polytomous scoring", () => {
  it("+/- floors at zero PER COLUMN, so select-everything gains nothing", () => {
    // One right and one wrong in each of two columns nets zero, not two. This
    // is the rule that stops a select-everything strategy from scoring well.
    const r = scoreItem(
      { rule: "+/-", units: [{ keys: ["a"] }, { keys: ["c"] }] },
      { unitSelections: [["a", "b"], ["c", "d"]] },
    );
    expect(r.earned).toBe(0);
  });

  it("+/- floors at zero rather than going negative", () => {
    const r = scoreItem({ rule: "+/-", keys: ["a"] }, { selected: ["b", "c", "d"] });
    expect(r.earned).toBe(0);
    expect(r.earned).toBeGreaterThanOrEqual(0);
  });

  it("0/1 never penalises a wrong selection", () => {
    const r = scoreItem({ rule: "0/1", keys: ["a", "b"] }, { selected: ["a", "c"] });
    expect(r.earned).toBe(1);
  });

  it("a Rationale triad scores ZERO when the cause is wrong", () => {
    // The rule implementations most often get wrong, and the one that would
    // quietly inflate her predicted score.
    const r = scoreItem(
      { rule: "R", rationale: { causeKey: "c1", effectKeys: ["e1", "e2"] } },
      { causeSelected: "c2", effectsSelected: ["e1", "e2"] },
    );
    expect(r.earned).toBe(0);
  });

  it("a Rationale triad scores fully when cause and effects are right", () => {
    const r = scoreItem(
      { rule: "R", rationale: { causeKey: "c1", effectKeys: ["e1", "e2"] } },
      { causeSelected: "c1", effectsSelected: ["e1", "e2"] },
    );
    expect(r.earned).toBe(r.possible);
    expect(r.earned).toBeGreaterThan(0);
  });

  it("scores nothing for an empty answer", () => {
    expect(scoreItem({ rule: "0/1", keys: ["a"] }, {}).earned).toBe(0);
    expect(scoreItem({ rule: "+/-", keys: ["a"] }, {}).earned).toBe(0);
  });

  it("never awards more than the item is worth", () => {
    const r = scoreItem({ rule: "0/1", keys: ["a", "b"] }, { selected: ["a", "b", "c", "d"] });
    expect(r.earned).toBeLessThanOrEqual(r.possible);
  });

  it("flags over-selection, which needs different advice from not knowing", () => {
    const r = scoreItem({ rule: "+/-", keys: ["a"] }, { selected: ["a", "b", "c", "d", "e"] });
    expect(r.overSelected).toBe(true);
  });
});

/* ------------------------------ import parsing ----------------------------- */

describe('REGRESSION: deck import parsing', () => {
  it('survives CRLF line endings', () => {
    const r = parseDeckText('#separator:tab\r\nFront\tBack\r\nQ2\tA2');
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('survives a UTF-8 BOM', () => {
    const r = parseDeckText('﻿Term,Definition\nHypokalemia,Low potassium');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.front).toBe('Hypokalemia');
  });

  it('does not crash on an empty file', () => {
    expect(parseDeckText('').rows).toHaveLength(0);
  });

  it('does not crash on a file of only comments', () => {
    expect(parseDeckText('#separator:tab\n#html:true').rows).toHaveLength(0);
  });
});

/* -------------------------------- read aloud ------------------------------- */

describe('REGRESSION: spoken text', () => {
  it('expands nursing shorthand rather than spelling it out', () => {
    const spoken = toSpokenText('K+ 3.5-5.0 mEq/L');
    expect(spoken).not.toContain('mEq/L');
    expect(spoken.toLowerCase()).toContain('potassium');
  });

  it('reads a range as a range, not a subtraction', () => {
    expect(toSpokenText('3.5-5.0')).toMatch(/to/);
  });

  it('does not read a cloze blank as punctuation', () => {
    expect(toSpokenText('Normal potassium is {{3.5-5.0}}')).not.toContain('{{');
  });

  it('returns empty for empty input instead of throwing', () => {
    expect(toSpokenText('')).toBe('');
  });
});

/* ------------------------------- teach-back -------------------------------- */

describe('REGRESSION: coverage to rating', () => {
  it('never returns a rating outside 1-4', () => {
    for (let total = 0; total <= 8; total++) {
      for (let covered = 0; covered <= total; covered++) {
        const r = ratingForCoverage(covered, total);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(4);
      }
    }
  });

  it('is monotonic: covering more never scores worse', () => {
    for (let total = 1; total <= 8; total++) {
      for (let covered = 1; covered <= total; covered++) {
        expect(ratingForCoverage(covered, total)).toBeGreaterThanOrEqual(
          ratingForCoverage(covered - 1, total),
        );
      }
    }
  });

  it('only a complete answer earns Easy', () => {
    for (let total = 1; total <= 8; total++) {
      for (let covered = 0; covered < total; covered++) {
        expect(ratingForCoverage(covered, total)).toBeLessThan(4);
      }
    }
  });
});

/* ----------------------------- the studiable gate -------------------------- */

describe('REGRESSION: study queue respects the gate under load', () => {
  it('returns only verified cards when the deck is mixed', () => {
    studiableCard('Verified 1', 'A');
    studiableCard('Verified 2', 'B');
    const unverified = insertItem(
      db,
      { lectureId, kind: 'flashcard', front: 'Unverified', back: 'C', blockIds: [] },
      [{ sourceId, claim: 'x', excerpt: 'Potassium 3.5-5.0 mEq/L', verdict: 'unverified' }],
    );
    db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(unverified);

    expect(listStudiable(db, { lectureId })).toHaveLength(2);
    expect(dueQueue(db, { lectureId }).map((q) => q.itemId)).not.toContain(unverified);
  });
});
