import { describe, it, expect } from 'vitest';
import {
  assembleExam, buildReport, CLIENT_NEED_WEIGHTS, BLUEPRINT_VERSION,
  type CandidateItem, type ItemOutcome,
} from '@core/exam/blueprint.js';

/** A pool with `per` items in every client-need category. */
function pool(per: number): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const w of CLIENT_NEED_WEIGHTS) {
    for (let i = 0; i < per; i++) {
      items.push({
        id: `${w.clientNeed}-${i}`,
        clientNeed: w.clientNeed,
        itemType: 'multiple_choice',
        elo: 1200,
        exposureCount: 0,
      });
    }
  }
  return items;
}

/** Deterministic "random" so assembly is reproducible in tests. */
const fixedRandom = () => 0.5;

describe('blueprint constants', () => {
  it('pins the test plan version alongside the weights', () => {
    expect(BLUEPRINT_VERSION).toBe('2026-04-01');
  });

  it('targets sum to 100%', () => {
    expect(CLIENT_NEED_WEIGHTS.reduce((n, w) => n + w.target, 0)).toBe(100);
  });

  it('every target sits inside its published band', () => {
    for (const w of CLIENT_NEED_WEIGHTS) {
      expect(w.target).toBeGreaterThanOrEqual(w.min);
      expect(w.target).toBeLessThanOrEqual(w.max);
    }
  });

  it('uses the current subcategory name', () => {
    const names = CLIENT_NEED_WEIGHTS.map((w) => w.clientNeed);
    expect(names).toContain('Safety and Infection Prevention and Control');
    // The pre-2026 wording must not linger.
    expect(names).not.toContain('Safety and Infection Control');
  });
});

describe('exam assembly', () => {
  it('produces an exam of the requested length', () => {
    const exam = assembleExam(pool(20), { length: 85, random: fixedRandom });
    expect(exam.itemIds).toHaveLength(85);
    expect(new Set(exam.itemIds).size).toBe(85); // no duplicates
  });

  it('lands every category inside its published band', () => {
    const exam = assembleExam(pool(20), { length: 85, random: fixedRandom });
    for (const b of exam.blueprint) {
      expect(b.inBand, `${b.clientNeed} at ${b.actual}% is outside its band`).toBe(true);
    }
    expect(exam.shortfalls).toEqual([]);
  });

  it('holds the blueprint across many exam lengths', () => {
    for (const length of [85, 100, 120, 150]) {
      const exam = assembleExam(pool(30), { length, random: fixedRandom });
      expect(exam.itemIds).toHaveLength(length);
      const outOfBand = exam.blueprint.filter((b) => !b.inBand);
      expect(outOfBand, `length ${length}: ${JSON.stringify(outOfBand)}`).toEqual([]);
    }
  });

  it('reports a shortfall rather than silently skewing the blueprint', () => {
    // Only one category is well stocked.
    const thin: CandidateItem[] = [
      ...pool(1),
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `pharm-extra-${i}`,
        clientNeed: 'Pharmacological and Parenteral Therapies',
        itemType: 'multiple_choice',
        elo: 1200,
        exposureCount: 0,
      })),
    ];
    const exam = assembleExam(thin, { length: 85, random: fixedRandom });

    // Items cannot be invented, so a 58-item pool yields 58 items — but the
    // shortfall is reported rather than the blueprint being quietly skewed.
    expect(exam.shortfalls.length).toBeGreaterThan(0);
    expect(exam.shortfalls.join(' ')).toContain('Management of Care');
    expect(exam.itemIds).toHaveLength(thin.length);
    expect(new Set(exam.itemIds).size).toBe(thin.length);
  });

  it('backfills to full length when the pool is large enough', () => {
    // Every category thin except one, but 200 items overall.
    const lopsided: CandidateItem[] = [
      ...pool(2),
      ...Array.from({ length: 200 }, (_, i) => ({
        id: `pharm-${i}`,
        clientNeed: 'Pharmacological and Parenteral Therapies',
        itemType: 'multiple_choice',
        elo: 1200,
        exposureCount: 0,
      })),
    ];
    const exam = assembleExam(lopsided, { length: 85, random: fixedRandom });
    expect(exam.itemIds).toHaveLength(85);
    expect(new Set(exam.itemIds).size).toBe(85);
    expect(exam.shortfalls.length).toBeGreaterThan(0);
  });

  it('prefers the least-exposed items', () => {
    const items = pool(2).map((i, idx) => ({ ...i, exposureCount: idx % 2 === 0 ? 0 : 9 }));
    const exam = assembleExam(items, { length: 8, random: fixedRandom });
    const chosen = new Set(exam.itemIds);
    const fresh = items.filter((i) => i.exposureCount === 0 && chosen.has(i.id)).length;
    const stale = items.filter((i) => i.exposureCount === 9 && chosen.has(i.id)).length;
    expect(fresh).toBeGreaterThan(stale);
  });

  it('pushes back items served inside the cooldown window', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
    const items: CandidateItem[] = [
      { id: 'recent', clientNeed: 'Management of Care', elo: 1200, exposureCount: 0, lastSeenAt: yesterday },
      { id: 'old', clientNeed: 'Management of Care', elo: 1200, exposureCount: 0 },
    ];
    const exam = assembleExam(items, { length: 1, cooldownDays: 14, now, random: fixedRandom });
    expect(exam.itemIds).toEqual(['old']);
  });

  it('estimates a sitting time from per-type budgets', () => {
    const exam = assembleExam(pool(20), { length: 85, random: fixedRandom });
    // 85 single-response items at 1 minute each.
    expect(exam.estimatedMinutes).toBe(85);
  });

  it('costs more time for bowtie and calculation items', () => {
    const items: CandidateItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `bt-${i}`,
      clientNeed: 'Management of Care',
      itemType: 'bowtie',
      elo: 1200,
      exposureCount: 0,
    }));
    const exam = assembleExam(items, { length: 10, random: fixedRandom });
    expect(exam.estimatedMinutes).toBe(25); // 10 x 150s
  });
});

describe('diagnostic report', () => {
  const outcomes: ItemOutcome[] = [
    ...Array.from({ length: 20 }, (_, i) => ({
      itemId: `cue-${i}`,
      njcmmStep: 'Recognize Cues',
      clientNeed: 'Reduction of Risk Potential',
      cognitiveLevel: 'application',
      itemType: 'multiple_choice',
      earned: i < 17 ? 1 : 0,
      possible: 1,
      durationMs: 60_000,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      itemId: `pri-${i}`,
      njcmmStep: 'Prioritize Hypotheses',
      clientNeed: 'Management of Care',
      cognitiveLevel: 'analysis',
      itemType: 'matrix',
      earned: i < 8 ? 1 : 0,
      possible: 1,
      overSelected: i % 4 === 0,
      durationMs: 90_000,
    })),
  ];

  it('reports points, not percentage of items', () => {
    const r = buildReport(outcomes, 40);
    expect(r.pointsEarned).toBe(25);
    expect(r.pointsPossible).toBe(40);
    expect(r.percent).toBeCloseTo(62.5, 1);
  });

  it('localises weakness to a reasoning stage', () => {
    const r = buildReport(outcomes, 40);
    // Sorted worst-first, so the weakest step leads.
    expect(r.byNjcmmStep[0]?.label).toBe('Prioritize Hypotheses');
    expect(r.byNjcmmStep[0]?.percent).toBe(40);
    expect(r.byNjcmmStep.find((s) => s.label === 'Recognize Cues')?.percent).toBe(85);
  });

  it('marks a subscore unreliable when there are too few items', () => {
    const sparse: ItemOutcome[] = [
      { itemId: 'a', njcmmStep: 'Take Action', earned: 0, possible: 1 },
      { itemId: 'b', njcmmStep: 'Take Action', earned: 1, possible: 1 },
    ];
    const r = buildReport(sparse, 2);
    expect(r.byNjcmmStep[0]?.reliable).toBe(false);
    expect(r.byNjcmmStep[0]?.n).toBe(2);
  });

  it('marks a subscore reliable once there is enough evidence', () => {
    const r = buildReport(outcomes, 40);
    expect(r.byNjcmmStep.every((s) => s.reliable)).toBe(true);
  });

  it('separates format unfamiliarity from knowledge gaps', () => {
    const r = buildReport(outcomes, 40);
    const matrix = r.byItemType.find((s) => s.label === 'matrix');
    const mc = r.byItemType.find((s) => s.label === 'multiple_choice');
    expect(matrix?.percent).toBeLessThan(mc!.percent);
  });

  it('reports the over-selection rate, which +/- scoring punishes', () => {
    const r = buildReport(outcomes, 40);
    // 5 of the 20 matrix items over-selected; the 20 MC items are not scorable
    // that way and are excluded from the denominator.
    expect(r.overSelectionRate).toBeCloseTo(0.25, 2);
  });

  it('omits the over-selection rate when no item could over-select', () => {
    const r = buildReport(
      [{ itemId: 'a', earned: 1, possible: 1 }],
      1,
    );
    expect(r.overSelectionRate).toBeUndefined();
  });

  it('compares actual pace against the budget', () => {
    const r = buildReport(outcomes, 40);
    expect(r.estimatedMinutes).toBe(40);
    expect(r.actualMinutes).toBe(50); // 20x1min + 20x1.5min
  });
});
