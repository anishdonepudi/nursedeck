import { fsrs, generatorParameters, createEmptyCard, Rating, State, type Card, type Grade } from 'ts-fsrs';
import type { Db } from '../db/index.js';

/**
 * Spaced repetition, FSRS-6 via ts-fsrs.
 *
 * Two decisions worth stating:
 *
 * - `reviews` is the source of truth and is append-only; `card_states` is a
 *   cache of the current scheduling position derived from it. That means the
 *   algorithm can be re-tuned later and replayed over real history.
 * - Fuzz is ON, against the library default. Without it, cards generated in one
 *   batch stay clumped together forever and resurface on the same day in a
 *   lump, which is exactly the review experience that makes people quit.
 */

export const DEFAULT_RETENTION = 0.9;

export function makeScheduler(requestRetention = DEFAULT_RETENTION) {
  return fsrs(
    generatorParameters({
      request_retention: requestRetention,
      enable_fuzz: true,
      enable_short_term: true,
    }),
  );
}

export interface CardState {
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: State;
  learningSteps: number;
  lastReview?: Date;
}

function toFsrsCard(s: CardState | undefined): Card {
  if (!s) return createEmptyCard();
  const card: Card = {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsedDays,
    scheduled_days: s.scheduledDays,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    learning_steps: s.learningSteps,
  };
  if (s.lastReview) card.last_review = s.lastReview;
  return card;
}

function fromFsrsCard(c: Card): CardState {
  const out: CardState = {
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    learningSteps: c.learning_steps,
  };
  if (c.last_review) out.lastReview = c.last_review;
  return out;
}

export function readCardState(db: Db, itemId: string): CardState | undefined {
  const r = db.prepare('SELECT * FROM card_states WHERE item_id = ?').get(itemId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return undefined;
  const out: CardState = {
    due: new Date(String(r['due'])),
    stability: Number(r['stability']),
    difficulty: Number(r['difficulty']),
    elapsedDays: Number(r['elapsed_days']),
    scheduledDays: Number(r['scheduled_days']),
    reps: Number(r['reps']),
    lapses: Number(r['lapses']),
    state: Number(r['state']) as State,
    learningSteps: Number(r['learning_steps'] ?? 0),
  };
  if (r['last_review']) out.lastReview = new Date(String(r['last_review']));
  return out;
}

function writeCardState(db: Db, itemId: string, s: CardState): void {
  db.prepare(
    `INSERT INTO card_states
       (item_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state,
        learning_steps, last_review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       due = excluded.due, stability = excluded.stability, difficulty = excluded.difficulty,
       elapsed_days = excluded.elapsed_days, scheduled_days = excluded.scheduled_days,
       reps = excluded.reps, lapses = excluded.lapses, state = excluded.state,
       learning_steps = excluded.learning_steps,
       last_review = excluded.last_review`,
  ).run(
    itemId, s.due.toISOString(), s.stability, s.difficulty, s.elapsedDays,
    s.scheduledDays, s.reps, s.lapses, s.state, s.learningSteps,
    s.lastReview?.toISOString() ?? null,
  );
}

/** Predicted next interval for each of the four buttons, shown on the UI. */
export interface IntervalPreview {
  again: Date;
  hard: Date;
  good: Date;
  easy: Date;
}

export function previewIntervals(
  state: CardState | undefined,
  now = new Date(),
  retention = DEFAULT_RETENTION,
): IntervalPreview {
  const scheduler = makeScheduler(retention);
  const log = scheduler.repeat(toFsrsCard(state), now);
  return {
    again: log[Rating.Again].card.due,
    hard: log[Rating.Hard].card.due,
    good: log[Rating.Good].card.due,
    easy: log[Rating.Easy].card.due,
  };
}

export interface AnswerInput {
  itemId: string;
  rating: Grade;
  /** Pre-answer confidence 0..1, kept separate from the outcome. */
  confidence?: number;
  correct?: boolean;
  durationMs?: number;
  mode?: 'review' | 'type' | 'cloze' | 'exam' | 'match';
  now?: Date;
  retention?: number;
}

/** Records one answer and advances the schedule. */
export function answerCard(db: Db, input: AnswerInput): CardState {
  const now = input.now ?? new Date();
  const before = readCardState(db, input.itemId);
  const scheduler = makeScheduler(input.retention ?? DEFAULT_RETENTION);

  const { card } = scheduler.next(toFsrsCard(before), now, input.rating);
  const after = fromFsrsCard(card);

  db.prepare(
    `INSERT INTO reviews (item_id, reviewed_at, rating, confidence, correct, duration_ms, mode, state_before)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.itemId, now.toISOString(), input.rating,
    input.confidence ?? null,
    input.correct === undefined ? null : input.correct ? 1 : 0,
    input.durationMs ?? null,
    input.mode ?? 'review',
    before ? JSON.stringify(before) : null,
  );

  writeCardState(db, input.itemId, after);
  updateElo(db, input.itemId, input.rating);
  return after;
}

/**
 * Elo difficulty per item.
 *
 * FSRS already models how well SHE knows a card. Elo models how hard the CARD
 * is, which is a different question and the one that surfaces junk: an item
 * everyone answers instantly is trivial, one everyone fails is probably broken
 * or miskeyed. With no pre-calibrated bank — exactly our situation with freshly
 * generated items — Elo is the right tool.
 */
const ELO_K = 24;
/** Nominal learner rating the item is scored against. */
const LEARNER_RATING = 1200;

function updateElo(db: Db, itemId: string, rating: Grade): void {
  const row = db.prepare('SELECT elo FROM items WHERE id = ?').get(itemId) as
    | { elo: number }
    | undefined;
  if (!row) return;

  // Standard Elo from the ITEM's perspective: the item "wins" when the learner
  // fails it. So failing a card raises its rating (it is harder than assumed),
  // and answering it easily lowers it.
  const learnerWon = rating === Rating.Good || rating === Rating.Easy ? 1 : 0;
  const itemScore = 1 - learnerWon;
  // Expected item score against a nominal learner rating of 1200.
  const expectedItemScore = 1 / (1 + 10 ** ((LEARNER_RATING - row.elo) / 400));
  const next = row.elo + ELO_K * (itemScore - expectedItemScore);
  db.prepare('UPDATE items SET elo = ? WHERE id = ?').run(
    Math.max(400, Math.min(2400, next)),
    itemId,
  );
}

export interface DueCard {
  itemId: string;
  due: Date;
  isNew: boolean;
}

/**
 * The review queue: cards due now, then unseen cards.
 *
 * Only ever drawn from items that are accepted AND have a verified citation —
 * the invariant lives in SQL so it cannot be bypassed from here.
 */
export function dueQueue(
  db: Db,
  opts: { lectureId?: string; limit?: number; newLimit?: number; now?: Date } = {},
): DueCard[] {
  const now = (opts.now ?? new Date()).toISOString();
  const params: unknown[] = [];
  const lectureFilter = opts.lectureId ? 'AND i.lecture_id = ?' : '';
  if (opts.lectureId) params.push(opts.lectureId);

  const studiable = `
    SELECT i.id, cs.due
      FROM items i
      JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
      LEFT JOIN card_states cs ON cs.item_id = i.id
     WHERE i.status = 'accepted' ${lectureFilter}
     GROUP BY i.id
  `;

  const due = db
    .prepare(`SELECT id, due FROM (${studiable}) WHERE due IS NOT NULL AND due <= ? ORDER BY due LIMIT ?`)
    .all(...(params as never[]), now, opts.limit ?? 50) as { id: string; due: string }[];

  const fresh = db
    .prepare(`SELECT id FROM (${studiable}) WHERE due IS NULL LIMIT ?`)
    .all(...(params as never[]), opts.newLimit ?? 20) as { id: string }[];

  return [
    ...due.map((r) => ({ itemId: r.id, due: new Date(r.due), isNew: false })),
    ...fresh.map((r) => ({ itemId: r.id, due: new Date(), isNew: true })),
  ];
}

export interface DeckStats {
  total: number;
  dueNow: number;
  unseen: number;
  /** Mean predicted recall across seen cards, 0..1. */
  averageRetrievability: number;
  /** mean(confidence) - proportion(correct). Positive means overconfident. */
  calibrationGap?: number;
  /** Items answered confidently but wrongly — the highest-value review target. */
  illusionOfKnowing: number;
}

export function deckStats(db: Db, opts: { lectureId?: string; now?: Date } = {}): DeckStats {
  const now = opts.now ?? new Date();
  const scheduler = makeScheduler();
  const params: unknown[] = [];
  const lectureFilter = opts.lectureId ? 'AND i.lecture_id = ?' : '';
  if (opts.lectureId) params.push(opts.lectureId);

  const rows = db
    .prepare(
      `SELECT i.id, cs.due, cs.stability, cs.difficulty, cs.elapsed_days, cs.scheduled_days,
              cs.reps, cs.lapses, cs.state, cs.learning_steps, cs.last_review
         FROM items i
         JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
         LEFT JOIN card_states cs ON cs.item_id = i.id
        WHERE i.status = 'accepted' ${lectureFilter}
        GROUP BY i.id`,
    )
    .all(...(params as never[])) as Record<string, unknown>[];

  let dueNow = 0;
  let unseen = 0;
  let retrievabilitySum = 0;
  let seen = 0;

  for (const r of rows) {
    if (r['due'] === null || r['due'] === undefined) {
      unseen += 1;
      continue;
    }
    seen += 1;
    if (new Date(String(r['due'])) <= now) dueNow += 1;
    const card = toFsrsCard({
      due: new Date(String(r['due'])),
      stability: Number(r['stability']),
      difficulty: Number(r['difficulty']),
      elapsedDays: Number(r['elapsed_days']),
      scheduledDays: Number(r['scheduled_days']),
      reps: Number(r['reps']),
      lapses: Number(r['lapses']),
      state: Number(r['state']) as State,
      learningSteps: Number(r['learning_steps'] ?? 0),
      ...(r['last_review'] ? { lastReview: new Date(String(r['last_review'])) } : {}),
    });
    retrievabilitySum += Number(scheduler.get_retrievability(card, now, false));
  }

  const calib = db
    .prepare(
      `SELECT AVG(confidence) AS mean_conf, AVG(CAST(correct AS REAL)) AS mean_correct, COUNT(*) AS n
         FROM reviews
        WHERE confidence IS NOT NULL AND correct IS NOT NULL`,
    )
    .get() as { mean_conf: number | null; mean_correct: number | null; n: number };

  const illusion = db
    .prepare(
      `SELECT COUNT(DISTINCT item_id) AS n FROM reviews
        WHERE confidence >= 0.75 AND correct = 0`,
    )
    .get() as { n: number };

  const stats: DeckStats = {
    total: rows.length,
    dueNow,
    unseen,
    averageRetrievability: seen > 0 ? retrievabilitySum / seen : 0,
    illusionOfKnowing: illusion.n,
  };
  // Below a handful of rated answers the gap is noise, so it is withheld
  // rather than shown as a confident-looking number.
  if (calib.n >= 5 && calib.mean_conf !== null && calib.mean_correct !== null) {
    stats.calibrationGap = calib.mean_conf - calib.mean_correct;
  }
  return stats;
}

export { Rating, State };
