/**
 * NGN scoring.
 *
 * NCLEX scoring is polytomous — partial credit — and which rule applies depends
 * on the item type. Two details are routinely got wrong and are handled
 * explicitly here:
 *
 * 1. Plus/minus scoring floors at zero per COLUMN (matrix) or per GROUP
 *    (grouping), not per item. Flooring the whole item instead quietly inflates
 *    scores.
 * 2. In rationale scoring, a wrong CAUSE scores zero regardless of how many
 *    effects are right. Partial credit only exists once the cause is correct.
 */

export type ScoringRule = '0/1' | '+/-' | 'R';
export type FlooringUnit = 'item' | 'column' | 'group';

export interface ScoreResult {
  earned: number;
  possible: number;
  /** Selections that were correct, incorrect, and keys that were missed. */
  correct: number;
  incorrect: number;
  missed: number;
  /** True when the learner selected far more options than there are keys. */
  overSelected: boolean;
}

/* ------------------------------------------------------------------ */
/* 0/1 — no penalty. Used where selection count is constrained.        */
/* ------------------------------------------------------------------ */

export function scoreZeroOne(keys: Set<string>, selected: Set<string>): ScoreResult {
  let correct = 0;
  for (const s of selected) if (keys.has(s)) correct += 1;
  const incorrect = selected.size - correct;
  return {
    earned: correct,
    possible: keys.size,
    correct,
    incorrect,
    missed: keys.size - correct,
    overSelected: false,
  };
}

/* ------------------------------------------------------------------ */
/* +/- — penalised, because selection is unconstrained.                */
/* ------------------------------------------------------------------ */

/**
 * One scoring unit of a plus/minus item.
 *
 * `keys` and `selected` must be scoped to a single column or group; flooring
 * happens inside this function, which is what makes the unit matter.
 */
export interface PlusMinusUnit {
  keys: Set<string>;
  selected: Set<string>;
}

export function scorePlusMinus(units: PlusMinusUnit[]): ScoreResult {
  let earned = 0;
  let possible = 0;
  let correct = 0;
  let incorrect = 0;
  let missed = 0;

  for (const unit of units) {
    let unitScore = 0;
    for (const s of unit.selected) {
      if (unit.keys.has(s)) { unitScore += 1; correct += 1; }
      else { unitScore -= 1; incorrect += 1; }
    }
    // Floor per unit, never across the whole item.
    earned += Math.max(0, unitScore);
    possible += unit.keys.size;
    for (const k of unit.keys) if (!unit.selected.has(k)) missed += 1;
  }

  const totalKeys = units.reduce((n, u) => n + u.keys.size, 0);
  const totalSelected = units.reduce((n, u) => n + u.selected.size, 0);

  return {
    earned,
    possible,
    correct,
    incorrect,
    missed,
    // Selecting markedly more than there are keys is the behaviour +/- exists
    // to discourage; it is reported so the diagnostic can name it.
    overSelected: totalKeys > 0 && totalSelected > totalKeys * 1.5,
  };
}

/* ------------------------------------------------------------------ */
/* Rationale — all-or-nothing on a linked cause and its effects.        */
/* ------------------------------------------------------------------ */

export interface RationaleUnit {
  causeKey: string;
  causeSelected: string | undefined;
  effectKeys: string[];
  effectsSelected: (string | undefined)[];
}

/**
 * Dyad (one effect) scores 1. Triad (two effects) scores 2.
 * A wrong cause scores 0 no matter how many effects are right.
 */
export function scoreRationale(unit: RationaleUnit): ScoreResult {
  const possible = unit.effectKeys.length >= 2 ? 2 : 1;

  if (unit.causeSelected !== unit.causeKey) {
    return {
      earned: 0,
      possible,
      correct: 0,
      incorrect: 1,
      missed: possible,
      overSelected: false,
    };
  }

  // Cause is right; each correct effect earns a point, capped at `possible`.
  const remaining = [...unit.effectKeys];
  let effectsCorrect = 0;
  for (const chosen of unit.effectsSelected) {
    const at = chosen === undefined ? -1 : remaining.indexOf(chosen);
    if (at >= 0) { remaining.splice(at, 1); effectsCorrect += 1; }
  }

  const earned = possible === 1
    ? (effectsCorrect === 1 ? 1 : 0)
    : effectsCorrect; // triad: 0, 1 or 2

  return {
    earned: Math.min(earned, possible),
    possible,
    correct: effectsCorrect + 1,
    incorrect: unit.effectsSelected.length - effectsCorrect,
    missed: possible - earned,
    overSelected: false,
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export interface ScorableItem {
  rule: ScoringRule;
  /** For 0/1 and +/-: the option ids that are correct. */
  keys?: string[];
  /** For +/-: keys grouped by column or group. Overrides `keys` when present. */
  units?: { keys: string[] }[];
  rationale?: Omit<RationaleUnit, 'causeSelected' | 'effectsSelected'>;
}

export interface Response {
  selected?: string[];
  /** For +/-: selections grouped to match `units`. */
  unitSelections?: string[][];
  causeSelected?: string;
  effectsSelected?: string[];
}

export function scoreItem(item: ScorableItem, response: Response): ScoreResult {
  if (item.rule === 'R') {
    if (!item.rationale) throw new Error('A rationale item needs its cause and effect keys.');
    return scoreRationale({
      ...item.rationale,
      causeSelected: response.causeSelected,
      effectsSelected: response.effectsSelected ?? [],
    });
  }

  if (item.rule === '+/-') {
    const units = item.units
      ? item.units.map((u, i) => ({
          keys: new Set(u.keys),
          selected: new Set(response.unitSelections?.[i] ?? []),
        }))
      : [{ keys: new Set(item.keys ?? []), selected: new Set(response.selected ?? []) }];
    return scorePlusMinus(units);
  }

  return scoreZeroOne(new Set(item.keys ?? []), new Set(response.selected ?? []));
}
