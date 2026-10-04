import { describe, it, expect } from 'vitest';
import {
  scoreZeroOne, scorePlusMinus, scoreRationale, scoreItem,
} from '@core/exam/scoring.js';

/**
 * Worked examples taken from the published NGN scoring guidance.
 *
 * The two cases implementations get wrong are covered explicitly: plus/minus
 * floors per column rather than per item, and a wrong cause in a rationale
 * triad scores zero regardless of the effects.
 */

const s = (...ids: string[]) => new Set(ids);

describe('0/1 scoring — no penalty', () => {
  it('awards a point per correct selection and ignores wrong ones', () => {
    // "Which 3 are viruses?" with influenza, hep B, varicella keyed, and
    // chlamydia also selected: 2 of the keys found, no deduction.
    const r = scoreZeroOne(s('influenza', 'hepB', 'varicella'), s('influenza', 'hepB', 'chlamydia'));
    expect(r.earned).toBe(2);
    expect(r.possible).toBe(3);
    expect(r.incorrect).toBe(1);
    expect(r.missed).toBe(1);
  });

  it('is full marks for a perfect answer', () => {
    const r = scoreZeroOne(s('a', 'b', 'c'), s('a', 'b', 'c'));
    expect(r.earned).toBe(3);
    expect(r.missed).toBe(0);
  });

  it('never goes negative', () => {
    const r = scoreZeroOne(s('a'), s('x', 'y', 'z'));
    expect(r.earned).toBe(0);
  });
});

describe('plus/minus scoring — penalised', () => {
  it('deducts for each incorrect selection', () => {
    // Same selections as the 0/1 case, but under +/-: 3 right, 1 wrong = 2.
    const r = scorePlusMinus([
      { keys: s('influenza', 'hepB', 'varicella'), selected: s('influenza', 'hepB', 'varicella', 'chlamydia') },
    ]);
    expect(r.earned).toBe(2);
    expect(r.possible).toBe(3);
  });

  it('floors at zero rather than going negative', () => {
    const r = scorePlusMinus([{ keys: s('a'), selected: s('w', 'x', 'y', 'z') }]);
    expect(r.earned).toBe(0);
  });

  it('floors PER COLUMN, not across the whole item', () => {
    // The published worked example: 8 keys across 3 columns.
    //   col 1: +3 -1 = 2
    //   col 2: +1 -1 = 0
    //   col 3: +2 -0 = 2
    // Total 4 of 8. Flooring the item as a whole would give 5, which is the
    // classic implementation error.
    const r = scorePlusMinus([
      { keys: s('a1', 'a2', 'a3'), selected: s('a1', 'a2', 'a3', 'x') },
      { keys: s('b1', 'b2'), selected: s('b1', 'y') },
      { keys: s('c1', 'c2', 'c3'), selected: s('c1', 'c2') },
    ]);
    expect(r.earned).toBe(4);
    expect(r.possible).toBe(8);
  });

  it('a column floored at zero cannot drag down another column', () => {
    const r = scorePlusMinus([
      { keys: s('a1'), selected: s('a1') },                   // +1
      { keys: s('b1'), selected: s('x', 'y', 'z') },          // -3 -> floored to 0
    ]);
    expect(r.earned).toBe(1);
  });

  it('flags over-selection, which the rule exists to discourage', () => {
    const r = scorePlusMinus([{ keys: s('a', 'b'), selected: s('a', 'b', 'c', 'd', 'e') }]);
    expect(r.overSelected).toBe(true);
  });

  it('does not flag a measured answer as over-selection', () => {
    const r = scorePlusMinus([{ keys: s('a', 'b'), selected: s('a', 'b') }]);
    expect(r.overSelected).toBe(false);
  });
});

describe('rationale scoring — all-or-nothing on the link', () => {
  it('a correct dyad scores 1', () => {
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: 'septic shock',
      effectKeys: ['falling blood pressure'],
      effectsSelected: ['falling blood pressure'],
    });
    expect(r.earned).toBe(1);
    expect(r.possible).toBe(1);
  });

  it('a dyad with the right cause but wrong effect scores 0', () => {
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: 'septic shock',
      effectKeys: ['falling blood pressure'],
      effectsSelected: ['oxygen saturation'],
    });
    expect(r.earned).toBe(0);
  });

  it('a fully correct triad scores 2', () => {
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: 'septic shock',
      effectKeys: ['falling blood pressure', 'white cell count'],
      effectsSelected: ['falling blood pressure', 'white cell count'],
    });
    expect(r.earned).toBe(2);
    expect(r.possible).toBe(2);
  });

  it('a triad with the right cause and one right effect scores 1', () => {
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: 'septic shock',
      effectKeys: ['falling blood pressure', 'white cell count'],
      effectsSelected: ['falling blood pressure', 'oxygen saturation'],
    });
    expect(r.earned).toBe(1);
  });

  it('A WRONG CAUSE SCORES 0 even when both effects are right', () => {
    // The rule implementations most often miss: there is no partial credit for
    // correct evidence attached to the wrong conclusion.
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: 'hypovolemic shock',
      effectKeys: ['falling blood pressure', 'white cell count'],
      effectsSelected: ['falling blood pressure', 'white cell count'],
    });
    expect(r.earned).toBe(0);
    expect(r.possible).toBe(2);
  });

  it('scores 0 when no cause was chosen at all', () => {
    const r = scoreRationale({
      causeKey: 'septic shock',
      causeSelected: undefined,
      effectKeys: ['falling blood pressure'],
      effectsSelected: ['falling blood pressure'],
    });
    expect(r.earned).toBe(0);
  });

  it('does not double-count the same effect chosen twice', () => {
    const r = scoreRationale({
      causeKey: 'c',
      causeSelected: 'c',
      effectKeys: ['e1', 'e2'],
      effectsSelected: ['e1', 'e1'],
    });
    expect(r.earned).toBe(1);
  });
});

describe('scoreItem dispatch', () => {
  it('routes a select-N item to 0/1', () => {
    const r = scoreItem(
      { rule: '0/1', keys: ['a', 'b', 'c'] },
      { selected: ['a', 'b', 'x'] },
    );
    expect(r.earned).toBe(2); // no deduction
  });

  it('routes a matrix item to per-column plus/minus', () => {
    const r = scoreItem(
      { rule: '+/-', units: [{ keys: ['a1'] }, { keys: ['b1', 'b2'] }] },
      { unitSelections: [['a1', 'x'], ['b1', 'b2']] },
    );
    // col 1: +1 -1 = 0 ; col 2: +2 = 2
    expect(r.earned).toBe(2);
    expect(r.possible).toBe(3);
  });

  it('routes a rationale item to all-or-nothing scoring', () => {
    const r = scoreItem(
      { rule: 'R', rationale: { causeKey: 'c', effectKeys: ['e1'] } },
      { causeSelected: 'wrong', effectsSelected: ['e1'] },
    );
    expect(r.earned).toBe(0);
  });

  it('refuses a rationale item with no keys rather than scoring it wrongly', () => {
    expect(() => scoreItem({ rule: 'R' }, { causeSelected: 'c' })).toThrow();
  });
});
