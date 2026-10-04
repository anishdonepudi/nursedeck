import type { Db } from '../db/index.js';
import { makeScheduler, readCardState } from './fsrs.js';

/**
 * Readiness reporting.
 *
 * The honest-number problem drives the design here. A topic answered twice
 * correctly is not "100% mastered", and showing that figure would be actively
 * misleading two weeks before an exam. So every score carries the evidence it
 * rests on, and a credible interval is reported rather than a point estimate.
 */

/** Beta prior. Two pseudo-observations: enough to pull a 2/2 away from 100%. */
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;

/** Below this many reviews a topic score is directional, not a measurement. */
const RELIABLE_REVIEWS = 8;

export interface TopicReadiness {
  topic: string;
  /** Posterior mean accuracy, 0..1. */
  readiness: number;
  /** 90% credible interval on that accuracy. */
  low: number;
  high: number;
  cardCount: number;
  reviewCount: number;
  /** Mean FSRS retrievability across the topic's cards right now. */
  predictedRecall: number;
  reliable: boolean;
}

/**
 * Normal approximation to the Beta posterior interval.
 *
 * Adequate here and dependency-free; the interval only has to communicate
 * "we do not know much yet", which it does well at small n.
 */
function betaInterval(alpha: number, beta: number): { mean: number; low: number; high: number } {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  return {
    mean,
    low: Math.max(0, mean - 1.645 * sd),
    high: Math.min(1, mean + 1.645 * sd),
  };
}

/**
 * Readiness per client-need category.
 *
 * Grouped by client need rather than by lecture because that is the axis the
 * exam is built on, so a weakness here maps directly onto what to revise.
 */
export function topicReadiness(db: Db, opts: { lectureId?: string; now?: Date } = {}): TopicReadiness[] {
  const now = opts.now ?? new Date();
  const scheduler = makeScheduler();
  const params: unknown[] = [];
  const filter = opts.lectureId ? 'AND i.lecture_id = ?' : '';
  if (opts.lectureId) params.push(opts.lectureId);

  const rows = db
    .prepare(
      `SELECT i.id,
              COALESCE(i.client_need, 'Unclassified') AS topic,
              (SELECT COUNT(*) FROM reviews r WHERE r.item_id = i.id) AS reviews,
              (SELECT COUNT(*) FROM reviews r WHERE r.item_id = i.id AND r.rating >= 3) AS good
         FROM items i
         JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
        WHERE i.status = 'accepted' ${filter}
        GROUP BY i.id`,
    )
    .all(...(params as never[])) as Record<string, unknown>[];

  const buckets = new Map<string, { cards: string[]; reviews: number; good: number }>();
  for (const r of rows) {
    const topic = String(r['topic']);
    const b = buckets.get(topic) ?? { cards: [], reviews: 0, good: 0 };
    b.cards.push(String(r['id']));
    b.reviews += Number(r['reviews']);
    b.good += Number(r['good']);
    buckets.set(topic, b);
  }

  const out: TopicReadiness[] = [];
  for (const [topic, b] of buckets) {
    const { mean, low, high } = betaInterval(PRIOR_ALPHA + b.good, PRIOR_BETA + (b.reviews - b.good));

    let recallSum = 0;
    let seen = 0;
    for (const id of b.cards) {
      const state = readCardState(db, id);
      if (!state) continue;
      seen += 1;
      recallSum += Number(
        scheduler.get_retrievability(
          {
            due: state.due,
            stability: state.stability,
            difficulty: state.difficulty,
            elapsed_days: state.elapsedDays,
            scheduled_days: state.scheduledDays,
            reps: state.reps,
            lapses: state.lapses,
            state: state.state,
            learning_steps: state.learningSteps,
            ...(state.lastReview ? { last_review: state.lastReview } : {}),
          },
          now,
          false,
        ),
      );
    }

    out.push({
      topic,
      readiness: mean,
      low,
      high,
      cardCount: b.cards.length,
      reviewCount: b.reviews,
      predictedRecall: seen > 0 ? recallSum / seen : 0,
      reliable: b.reviews >= RELIABLE_REVIEWS,
    });
  }

  return out.sort((a, b) => a.readiness - b.readiness);
}

export interface ForecastDay {
  date: string;
  due: number;
}

/** Cards falling due per day, so a workload spike is visible before it lands. */
export function dueForecast(
  db: Db,
  opts: { days?: number; lectureId?: string; now?: Date } = {},
): ForecastDay[] {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const params: unknown[] = [];
  const filter = opts.lectureId ? 'AND i.lecture_id = ?' : '';
  if (opts.lectureId) params.push(opts.lectureId);

  const rows = db
    .prepare(
      `SELECT cs.due
         FROM card_states cs
         JOIN items i ON i.id = cs.item_id
         JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
        WHERE i.status = 'accepted' ${filter}
        GROUP BY cs.item_id`,
    )
    .all(...(params as never[])) as { due: string }[];

  const counts = new Map<string, number>();
  for (let d = 0; d < days; d++) {
    const date = new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    counts.set(date, 0);
  }

  const todayKey = now.toISOString().slice(0, 10);
  for (const r of rows) {
    // Anything overdue is work for today, not for the day it was scheduled.
    const dueDate = new Date(r.due);
    const key = dueDate <= now ? todayKey : dueDate.toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].map(([date, due]) => ({ date, due }));
}

export interface ExamProjection {
  topic: string;
  readinessNow: number;
  /** Predicted recall on the exam date if the current schedule is followed. */
  projectedRecall: number;
  cardCount: number;
  /** Cards that will not have been seen again before the exam. */
  unseenBefore: number;
  atRisk: boolean;
}

/**
 * Projects each topic forward to an exam date.
 *
 * Deliberately pessimistic in one respect: cards whose next review falls AFTER
 * the exam are counted as at risk, because an interval that steps over the exam
 * means the card will not be refreshed before it matters.
 */
export function projectToExam(
  db: Db,
  examDate: Date,
  opts: { lectureId?: string; now?: Date; riskThreshold?: number } = {},
): ExamProjection[] {
  const now = opts.now ?? new Date();
  const threshold = opts.riskThreshold ?? 0.8;
  const scheduler = makeScheduler();
  const params: unknown[] = [];
  const filter = opts.lectureId ? 'AND i.lecture_id = ?' : '';
  if (opts.lectureId) params.push(opts.lectureId);

  const rows = db
    .prepare(
      `SELECT i.id, COALESCE(i.client_need, 'Unclassified') AS topic
         FROM items i
         JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
        WHERE i.status = 'accepted' ${filter}
        GROUP BY i.id`,
    )
    .all(...(params as never[])) as { id: string; topic: string }[];

  const buckets = new Map<string, { recall: number[]; unseen: number; cards: number }>();

  for (const r of rows) {
    const b = buckets.get(r.topic) ?? { recall: [], unseen: 0, cards: 0 };
    b.cards += 1;

    const state = readCardState(db, r.id);
    if (!state) {
      // Never studied, so it will not be known on the day unless it is seen.
      b.unseen += 1;
      b.recall.push(0);
    } else {
      if (state.due > examDate) b.unseen += 1;
      b.recall.push(
        Number(
          scheduler.get_retrievability(
            {
              due: state.due,
              stability: state.stability,
              difficulty: state.difficulty,
              elapsed_days: state.elapsedDays,
              scheduled_days: state.scheduledDays,
              reps: state.reps,
              lapses: state.lapses,
              state: state.state,
              learning_steps: state.learningSteps,
              ...(state.lastReview ? { last_review: state.lastReview } : {}),
            },
            examDate,
            false,
          ),
        ),
      );
    }
    buckets.set(r.topic, b);
  }

  const readiness = new Map(topicReadiness(db, { ...opts, now }).map((t) => [t.topic, t.readiness]));

  return [...buckets.entries()]
    .map(([topic, b]) => {
      const projectedRecall = b.recall.length > 0
        ? b.recall.reduce((n, x) => n + x, 0) / b.recall.length
        : 0;
      return {
        topic,
        readinessNow: readiness.get(topic) ?? 0,
        projectedRecall,
        cardCount: b.cards,
        unseenBefore: b.unseen,
        atRisk: projectedRecall < threshold,
      };
    })
    .sort((a, b) => a.projectedRecall - b.projectedRecall);
}

export interface LeechCard {
  itemId: string;
  front: string;
  lapses: number;
  elo: number;
  /** Answered confidently and still wrong -- the highest-value review target. */
  confidentlyWrong: number;
}

/**
 * Cards that keep failing.
 *
 * Badly generated cards concentrate here, so this doubles as a quality signal:
 * a card nobody can answer is as likely to be ambiguous as to be hard.
 */
export function leeches(db: Db, opts: { minLapses?: number; limit?: number } = {}): LeechCard[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.front, i.elo, COALESCE(cs.lapses, 0) AS lapses,
              (SELECT COUNT(*) FROM reviews r
                WHERE r.item_id = i.id AND r.confidence >= 0.75 AND r.correct = 0) AS confidently_wrong
         FROM items i
         LEFT JOIN card_states cs ON cs.item_id = i.id
        WHERE i.status = 'accepted' AND COALESCE(cs.lapses, 0) >= ?
        ORDER BY lapses DESC, confidently_wrong DESC
        LIMIT ?`,
    )
    .all(opts.minLapses ?? 3, opts.limit ?? 20) as Record<string, unknown>[];

  return rows.map((r) => ({
    itemId: String(r['id']),
    front: String(r['front']),
    lapses: Number(r['lapses']),
    elo: Number(r['elo']),
    confidentlyWrong: Number(r['confidently_wrong']),
  }));
}

export interface IllusionCard {
  itemId: string;
  front: string;
  occurrences: number;
  meanConfidence: number;
}

/**
 * Cards she was sure about and got wrong.
 *
 * Worth separating from ordinary failures: she has no idea these are gaps, so
 * they will not be revised unless something points at them.
 */
export function illusionOfKnowing(db: Db, limit = 20): IllusionCard[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.front, COUNT(*) AS n, AVG(r.confidence) AS mean_conf
         FROM reviews r JOIN items i ON i.id = r.item_id
        WHERE r.confidence >= 0.75 AND r.correct = 0
        GROUP BY i.id
        ORDER BY n DESC, mean_conf DESC
        LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    itemId: String(r['id']),
    front: String(r['front']),
    occurrences: Number(r['n']),
    meanConfidence: Number(r['mean_conf']),
  }));
}
