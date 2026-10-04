/**
 * NCLEX-RN test blueprint and exam assembly.
 *
 * Percentages are from the 2026 RN test plan, effective 2026-04-01. They are
 * pinned here with their effective date rather than scattered through the code,
 * because NCSBN revises the plan every three years and a stale blueprint
 * silently produces mock exams that no longer resemble the real one.
 *
 * Note the current-cycle rename: the subcategory is now "Safety and Infection
 * Prevention and Control".
 */

export const BLUEPRINT_VERSION = '2026-04-01';

export interface CategoryWeight {
  clientNeed: string;
  /** Published tolerance band. */
  min: number;
  max: number;
  /** Midpoint -- the assembly target. */
  target: number;
}

export const CLIENT_NEED_WEIGHTS: CategoryWeight[] = [
  { clientNeed: 'Management of Care', min: 15, max: 21, target: 18 },
  { clientNeed: 'Safety and Infection Prevention and Control', min: 10, max: 16, target: 13 },
  { clientNeed: 'Health Promotion and Maintenance', min: 6, max: 12, target: 9 },
  { clientNeed: 'Psychosocial Integrity', min: 6, max: 12, target: 9 },
  { clientNeed: 'Basic Care and Comfort', min: 6, max: 12, target: 9 },
  { clientNeed: 'Pharmacological and Parenteral Therapies', min: 13, max: 19, target: 16 },
  { clientNeed: 'Reduction of Risk Potential', min: 9, max: 15, target: 12 },
  { clientNeed: 'Physiological Adaptation', min: 11, max: 17, target: 14 },
];

/** Per-item time budgets in seconds, by item type. */
export const TIME_BUDGET_SECONDS: Record<string, number> = {
  multiple_choice: 60,
  select_all: 60,
  select_n: 60,
  matrix: 90,
  cloze: 90,
  highlight: 90,
  bowtie: 150,
  calculation: 150,
};

export interface CandidateItem {
  id: string;
  clientNeed?: string;
  njcmmStep?: string;
  cognitiveLevel?: string;
  itemType?: string;
  elo: number;
  /** Times this item has been served, for exposure control. */
  exposureCount: number;
  lastSeenAt?: string;
}

export interface AssemblyOptions {
  length: number;
  /** Items seen within this window are deprioritised. */
  cooldownDays?: number;
  now?: Date;
  /** Deterministic selection for tests. */
  random?: () => number;
}

export interface AssembledExam {
  itemIds: string[];
  /** Observed share per client need, and whether it lands in the published band. */
  blueprint: {
    clientNeed: string;
    target: number;
    actual: number;
    inBand: boolean;
  }[];
  /** Categories that could not be filled from the available pool. */
  shortfalls: string[];
  estimatedMinutes: number;
}

/**
 * Builds a blueprint-faithful fixed-form exam.
 *
 * Fixed-form rather than adaptive, deliberately: an adaptive exam needs a
 * pre-calibrated item pool, which freshly generated items do not have. A fixed
 * form is also comparable between attempts, which is what makes a mock exam
 * useful for tracking readiness.
 */
export function assembleExam(pool: CandidateItem[], opts: AssemblyOptions): AssembledExam {
  const now = opts.now ?? new Date();
  const random = opts.random ?? Math.random;
  const cooldownMs = (opts.cooldownDays ?? 14) * 86_400_000;

  // Exposure control: least-seen first, with recently-served items pushed back,
  // then a shuffle within the tier so the same ordering is not served twice.
  const rank = (i: CandidateItem): number => {
    const recent = i.lastSeenAt && now.getTime() - new Date(i.lastSeenAt).getTime() < cooldownMs;
    return i.exposureCount * 10 + (recent ? 100 : 0) + random();
  };

  const byNeed = new Map<string, CandidateItem[]>();
  for (const item of pool) {
    const key = item.clientNeed ?? 'Unclassified';
    const list = byNeed.get(key) ?? [];
    list.push(item);
    byNeed.set(key, list);
  }
  for (const list of byNeed.values()) list.sort((a, b) => rank(a) - rank(b));

  const chosen: string[] = [];
  const shortfalls: string[] = [];

  // Largest-remainder apportionment, so rounding does not systematically
  // starve the smallest categories.
  const quotas = CLIENT_NEED_WEIGHTS.map((w) => {
    const exact = (w.target / 100) * opts.length;
    return { ...w, exact, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let allocated = quotas.reduce((n, q) => n + q.floor, 0);
  const byRemainder = [...quotas].sort((a, b) => b.remainder - a.remainder);
  const counts = new Map(quotas.map((q) => [q.clientNeed, q.floor]));
  for (let i = 0; allocated < opts.length && i < byRemainder.length; i++) {
    const need = byRemainder[i]!.clientNeed;
    counts.set(need, (counts.get(need) ?? 0) + 1);
    allocated += 1;
  }

  for (const weight of CLIENT_NEED_WEIGHTS) {
    const want = counts.get(weight.clientNeed) ?? 0;
    const available = byNeed.get(weight.clientNeed) ?? [];
    const take = available.slice(0, want);
    chosen.push(...take.map((i) => i.id));
    if (take.length < want) {
      shortfalls.push(
        `${weight.clientNeed}: wanted ${want}, pool has ${available.length}`,
      );
    }
  }

  // Backfill any gap from whatever remains, so a thin pool still yields a
  // full-length exam rather than a short one.
  if (chosen.length < opts.length) {
    const used = new Set(chosen);
    const rest = pool
      .filter((i) => !used.has(i.id))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, opts.length - chosen.length);
    chosen.push(...rest.map((i) => i.id));
  }

  const final = chosen.slice(0, opts.length);
  const total = final.length || 1;
  const poolById = new Map(pool.map((i) => [i.id, i]));

  const blueprint = CLIENT_NEED_WEIGHTS.map((w) => {
    const n = final.filter((id) => poolById.get(id)?.clientNeed === w.clientNeed).length;
    const actual = (n / total) * 100;
    return {
      clientNeed: w.clientNeed,
      target: w.target,
      actual: Math.round(actual * 10) / 10,
      inBand: actual >= w.min && actual <= w.max,
    };
  });

  const estimatedSeconds = final.reduce((sum, id) => {
    const type = poolById.get(id)?.itemType ?? 'multiple_choice';
    return sum + (TIME_BUDGET_SECONDS[type] ?? 60);
  }, 0);

  return {
    itemIds: final,
    blueprint,
    shortfalls,
    estimatedMinutes: Math.round(estimatedSeconds / 60),
  };
}

/* ------------------------------------------------------------------ */
/* Diagnostic reporting                                                */
/* ------------------------------------------------------------------ */

export interface ItemOutcome {
  itemId: string;
  clientNeed?: string;
  njcmmStep?: string;
  cognitiveLevel?: string;
  itemType?: string;
  earned: number;
  possible: number;
  overSelected?: boolean;
  durationMs?: number;
}

export interface Subscore {
  label: string;
  earned: number;
  possible: number;
  percent: number;
  n: number;
  /**
   * Subscores need roughly 15-20 items before they are stable. Below that the
   * percentage is reported but flagged, so the UI can show a direction rather
   * than a confident-looking number.
   */
  reliable: boolean;
}

export interface ExamReport {
  pointsEarned: number;
  pointsPossible: number;
  percent: number;
  byClientNeed: Subscore[];
  byNjcmmStep: Subscore[];
  byCognitiveLevel: Subscore[];
  byItemType: Subscore[];
  /** Fraction of +/- items where far more options were selected than keyed. */
  overSelectionRate?: number;
  estimatedMinutes: number;
  actualMinutes: number;
}

const RELIABLE_N = 15;

function group(outcomes: ItemOutcome[], key: (o: ItemOutcome) => string | undefined): Subscore[] {
  const buckets = new Map<string, ItemOutcome[]>();
  for (const o of outcomes) {
    const k = key(o);
    if (!k) continue;
    const list = buckets.get(k) ?? [];
    list.push(o);
    buckets.set(k, list);
  }
  return [...buckets.entries()]
    .map(([label, list]) => {
      const earned = list.reduce((n, o) => n + o.earned, 0);
      const possible = list.reduce((n, o) => n + o.possible, 0);
      return {
        label,
        earned,
        possible,
        percent: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : 0,
        n: list.length,
        reliable: list.length >= RELIABLE_N,
      };
    })
    .sort((a, b) => a.percent - b.percent);
}

/**
 * Builds the score report.
 *
 * Reported in POINTS, not percentage of items: NGN items are polytomous, so
 * "12 of 20 questions" would be wrong whenever partial credit applies.
 */
export function buildReport(outcomes: ItemOutcome[], estimatedMinutes: number): ExamReport {
  const pointsEarned = outcomes.reduce((n, o) => n + o.earned, 0);
  const pointsPossible = outcomes.reduce((n, o) => n + o.possible, 0);
  const overSelectable = outcomes.filter((o) => o.overSelected !== undefined);

  const report: ExamReport = {
    pointsEarned,
    pointsPossible,
    percent: pointsPossible > 0 ? Math.round((pointsEarned / pointsPossible) * 1000) / 10 : 0,
    byClientNeed: group(outcomes, (o) => o.clientNeed),
    // The highest-value NGN diagnostic: it localises a weakness to a reasoning
    // stage rather than to a content area.
    byNjcmmStep: group(outcomes, (o) => o.njcmmStep),
    byCognitiveLevel: group(outcomes, (o) => o.cognitiveLevel),
    // Separates a knowledge gap from unfamiliarity with an item format.
    byItemType: group(outcomes, (o) => o.itemType),
    estimatedMinutes,
    actualMinutes: Math.round(
      outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0) / 60_000,
    ),
  };

  if (overSelectable.length > 0) {
    report.overSelectionRate =
      overSelectable.filter((o) => o.overSelected).length / overSelectable.length;
  }
  return report;
}
