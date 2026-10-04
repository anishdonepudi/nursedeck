import { describe, it, expect } from 'vitest';
import { toSpokenText } from '@shared/spoken.js';

/**
 * Read-aloud is useless if the voice spells out nursing shorthand, so the
 * expansion rules are tested directly. She asked for this feature to answer out
 * loud; hearing "m E q slash L" would defeat it.
 */

describe('spoken text', () => {
  it('expands lab units into words', () => {
    expect(toSpokenText('Normal potassium is 3.5-5.0 mEq/L'))
      .toBe('Normal potassium is 3.5 to 5.0 milliequivalents per liter');
  });

  it('reads a range as "to", not as a minus sign', () => {
    expect(toSpokenText('135-145')).toBe('135 to 145');
  });

  it('expands electrolyte symbols', () => {
    expect(toSpokenText('Low K+ causes toxicity')).toContain('potassium');
    expect(toSpokenText('Check Na+ first')).toContain('sodium');
  });

  it('expands blood-gas and route abbreviations a voice would mangle', () => {
    expect(toSpokenText('Review the ABG')).toContain('arterial blood gas');
    expect(toSpokenText('Give IV fluids')).toContain('I V');
    expect(toSpokenText('Keep the client NPO')).toContain('nothing by mouth');
    expect(toSpokenText('PaCO2 is 48 mmHg')).toContain('millimeters of mercury');
  });

  it('expands a dosing frequency', () => {
    expect(toSpokenText('Give q6h')).toContain('every 6 hours');
  });

  it('reads a cloze blank as a pause rather than punctuation', () => {
    expect(toSpokenText('Normal potassium is {{3.5-5.0 mEq/L}}.')).toContain('blank');
    expect(toSpokenText('Normal potassium is {{3.5-5.0 mEq/L}}.')).not.toContain('{{');
    // The masked form used in the study UI must also be spoken as a pause.
    expect(toSpokenText('Normal potassium is ______.')).toContain('blank');
  });

  it('collapses whitespace so the voice does not pause oddly', () => {
    expect(toSpokenText('Too   many\n\nspaces')).toBe('Too many spaces');
  });

  it('leaves ordinary prose alone', () => {
    const plain = 'Assess the client before administering the medication';
    expect(toSpokenText(plain)).toBe(plain);
  });
});
