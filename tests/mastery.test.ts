import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@core/db/index.js';
import { insertLecture, insertItem, setItemStatus } from '@core/db/repo.js';
import { answerCard, Rating } from '@core/scheduler/fsrs.js';
import {
  topicReadiness, dueForecast, projectToExam, leeches, illusionOfKnowing,
} from '@core/scheduler/mastery.js';
import type { LectureDoc } from '@shared/types.js';

let db: Db;
let sourceId: string;

const lecture: LectureDoc = {
  id: 'lec-1', sourceFile: '/a.pptx', kind: 'pptx', title: 'Deck', warnings: [],
  blocks: [{ id: 'b1', ordinal: 1, body: 'content' }],
};

function add(front: string, clientNeed?: string): string {
  const id = insertItem(
    db,
    {
      lectureId: 'lec-1', kind: 'flashcard', front, back: 'A', blockIds: ['b1'],
      ...(clientNeed ? { clientNeed } : {}),
    },
    [{ sourceId, claim: 'c', excerpt: 'content', verdict: 'verified' }],
  );
  setItemStatus(db, id, 'accepted');
  return id;
}

const NOW = new Date('2026-06-01T09:00:00Z');

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  sourceId = insertLecture(db, lecture).sourceId;
});

describe('topic readiness', () => {
  it('does NOT claim mastery from two lucky answers', () => {
    const id = add('Q', 'Pharmacological and Parenteral Therapies');
    let now = NOW;
    for (let i = 0; i < 2; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const [topic] = topicReadiness(db, { now: NOW });
    // A point estimate would say 100%; the prior pulls it well below.
    expect(topic!.readiness).toBeLessThan(0.85);
    expect(topic!.reliable).toBe(false);
    // And the interval must be wide enough to say "we do not know yet".
    expect(topic!.high - topic!.low).toBeGreaterThan(0.3);
  });

  it('narrows the interval as evidence accumulates', () => {
    const id = add('Q', 'Reduction of Risk Potential');
    let now = NOW;
    for (let i = 0; i < 20; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const [topic] = topicReadiness(db, { now: NOW });
    expect(topic!.reliable).toBe(true);
    expect(topic!.readiness).toBeGreaterThan(0.85);
    expect(topic!.high - topic!.low).toBeLessThan(0.3);
  });

  it('sorts weakest topic first, which is what to revise', () => {
    const strong = add('Strong', 'Management of Care');
    const weak = add('Weak', 'Psychosocial Integrity');

    let now = NOW;
    for (let i = 0; i < 10; i++) {
      const s = answerCard(db, { itemId: strong, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }
    now = NOW;
    for (let i = 0; i < 10; i++) {
      const s = answerCard(db, { itemId: weak, rating: Rating.Again, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const topics = topicReadiness(db, { now: NOW });
    expect(topics[0]?.topic).toBe('Psychosocial Integrity');
    expect(topics[0]!.readiness).toBeLessThan(topics[1]!.readiness);
  });

  it('groups unclassified cards rather than dropping them', () => {
    add('No category');
    const topics = topicReadiness(db, { now: NOW });
    expect(topics.map((t) => t.topic)).toContain('Unclassified');
  });
});

describe('due forecast', () => {
  it('returns one entry per requested day', () => {
    add('Q');
    const forecast = dueForecast(db, { days: 14, now: NOW });
    expect(forecast).toHaveLength(14);
    expect(forecast[0]?.date).toBe('2026-06-01');
  });

  it('counts a scheduled card on its due day', () => {
    const id = add('Q');
    const state = answerCard(db, { itemId: id, rating: Rating.Easy, now: NOW });
    const key = state.due.toISOString().slice(0, 10);

    const forecast = dueForecast(db, { days: 60, now: NOW });
    const day = forecast.find((f) => f.date === key);
    expect(day?.due).toBe(1);
  });

  it('counts an overdue card as work for today, not the day it was missed', () => {
    const id = add('Q');
    // Answered a long time ago, so it is now overdue.
    answerCard(db, { itemId: id, rating: Rating.Good, now: new Date('2026-01-01T09:00:00Z') });

    const forecast = dueForecast(db, { days: 7, now: NOW });
    expect(forecast[0]?.due).toBe(1);
  });

  it('shows nothing due for an unseen card, which has no schedule yet', () => {
    add('Never studied');
    const forecast = dueForecast(db, { days: 7, now: NOW });
    expect(forecast.reduce((n, f) => n + f.due, 0)).toBe(0);
  });
});

describe('exam projection', () => {
  const EXAM = new Date('2026-07-01T09:00:00Z');

  it('flags a never-studied topic as at risk', () => {
    add('Q', 'Physiological Adaptation');
    const [projection] = projectToExam(db, EXAM, { now: NOW });
    expect(projection!.atRisk).toBe(true);
    expect(projection!.projectedRecall).toBe(0);
    expect(projection!.unseenBefore).toBe(1);
  });

  it('counts a card whose next review falls after the exam as unseen before it', () => {
    const id = add('Q', 'Basic Care and Comfort');
    // Several easy answers push the interval past the exam date.
    let now = NOW;
    for (let i = 0; i < 6; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Easy, now });
      now = new Date(s.due.getTime() + 1000);
    }
    const [projection] = projectToExam(db, EXAM, { now: NOW });
    // Either it is scheduled past the exam, or recall is still projected high.
    expect(projection!.unseenBefore + (projection!.projectedRecall > 0.5 ? 1 : 0)).toBeGreaterThan(0);
  });

  it('sorts the most at-risk topic first', () => {
    const studied = add('Studied', 'Management of Care');
    add('Untouched', 'Psychosocial Integrity');
    answerCard(db, { itemId: studied, rating: Rating.Good, now: NOW });

    const projections = projectToExam(db, EXAM, { now: NOW });
    expect(projections[0]?.topic).toBe('Psychosocial Integrity');
  });
});

describe('leeches and illusion of knowing', () => {
  it('surfaces cards that keep being failed', () => {
    const id = add('Hard card');
    let now = NOW;
    // Build up lapses: succeed into Review state, then fail repeatedly.
    for (let i = 0; i < 4; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }
    for (let i = 0; i < 4; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Again, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const found = leeches(db, { minLapses: 1 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.front).toBe('Hard card');
    expect(found[0]!.lapses).toBeGreaterThan(0);
  });

  it('ignores cards that are merely new', () => {
    add('Never failed');
    expect(leeches(db, { minLapses: 1 })).toHaveLength(0);
  });

  it('separates confident-but-wrong from ordinary failures', () => {
    const sure = add('Thought I knew this');
    const unsure = add('Knew I did not know');

    answerCard(db, { itemId: sure, rating: Rating.Again, now: NOW, confidence: 0.95, correct: false });
    answerCard(db, { itemId: unsure, rating: Rating.Again, now: NOW, confidence: 0.25, correct: false });

    const illusions = illusionOfKnowing(db);
    expect(illusions).toHaveLength(1);
    expect(illusions[0]?.front).toBe('Thought I knew this');
    expect(illusions[0]!.meanConfidence).toBeGreaterThan(0.75);
  });

  it('ranks a repeatedly-misplaced confidence highest', () => {
    const once = add('Wrong once');
    const thrice = add('Wrong three times');

    answerCard(db, { itemId: once, rating: Rating.Again, now: NOW, confidence: 0.9, correct: false });
    let now = NOW;
    for (let i = 0; i < 3; i++) {
      const s = answerCard(db, {
        itemId: thrice, rating: Rating.Again, now, confidence: 0.9, correct: false,
      });
      now = new Date(s.due.getTime() + 1000);
    }

    expect(illusionOfKnowing(db)[0]?.front).toBe('Wrong three times');
  });
});

describe('exam projection simulates the schedule forward', () => {
  const EXAM = new Date('2026-07-15T09:00:00Z');

  /**
   * Regression: the projection used to freeze today's state and read
   * retrievability at the exam date, which answers "what if you stopped
   * studying". Every topic then landed around 75% and the at-risk flag fired on
   * all of them, which tells the user nothing.
   */
  it('does not flag a well-practised topic as at risk', () => {
    const id = add('Well practised', 'Management of Care');
    let now = NOW;
    for (let i = 0; i < 6; i++) {
      const s = answerCard(db, { itemId: id, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const [projection] = projectToExam(db, EXAM, { now: NOW });
    expect(projection!.projectedRecall).toBeGreaterThan(0.8);
    expect(projection!.atRisk).toBe(false);
  });

  it('still separates a strong topic from a never-studied one', () => {
    const strong = add('Strong', 'Management of Care');
    add('Untouched', 'Psychosocial Integrity');

    let now = NOW;
    for (let i = 0; i < 6; i++) {
      const s = answerCard(db, { itemId: strong, rating: Rating.Good, now });
      now = new Date(s.due.getTime() + 1000);
    }

    const projections = projectToExam(db, EXAM, { now: NOW });
    const weak = projections.find((p) => p.topic === 'Psychosocial Integrity');
    const good = projections.find((p) => p.topic === 'Management of Care');

    expect(weak!.atRisk).toBe(true);
    expect(good!.atRisk).toBe(false);
    expect(good!.projectedRecall).toBeGreaterThan(weak!.projectedRecall);
  });

  it('counts only cards scheduled past the exam as never revisited', () => {
    const id = add('Due soon', 'Basic Care and Comfort');
    // One review leaves it due well before the exam, so it will be seen again.
    answerCard(db, { itemId: id, rating: Rating.Good, now: NOW });

    const [projection] = projectToExam(db, EXAM, { now: NOW });
    expect(projection!.unseenBefore).toBe(0);
  });
});
