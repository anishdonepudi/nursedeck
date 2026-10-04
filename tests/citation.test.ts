import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  verifyVerbatim,
  extractNumbers,
  verifyNumericAgreement,
  verifyLicenseUse,
  qualifyExcerpt,
} from '@core/validate/citation.js';

/**
 * These tests encode the anti-hallucination contract. They are deliberately
 * adversarial: each one represents a way a model has a realistic chance of
 * producing a citation that looks right but is not.
 */

// A short stand-in for stored source text, written the way real guideline
// prose is: curly quotes, en dashes, line wrapping.
const SOURCE = `Potassium is the major intracellular cation. The normal adult
serum potassium concentration is 3.5–5.0 mEq/L. Hypokalemia is defined as a
serum potassium below 3.5 mEq/L, and may cause cardiac dysrhythmias, muscle
weakness, and ileus. Administer potassium replacement only via a controlled
infusion; never give potassium chloride by IV push, which is fatal.`;

describe('normalizeForMatch', () => {
  it('folds typographic variants that do not change meaning', () => {
    expect(normalizeForMatch('3.5–5.0')).toBe(normalizeForMatch('3.5-5.0'));
    expect(normalizeForMatch('“quoted”')).toBe(normalizeForMatch('"quoted"'));
    expect(normalizeForMatch('it’s')).toBe(normalizeForMatch("it's"));
    expect(normalizeForMatch('a  b')).toBe('a b');
    expect(normalizeForMatch('  Mixed   CASE\n\tspacing ')).toBe('mixed case spacing');
  });

  it('strips zero-width characters used to disguise text', () => {
    expect(normalizeForMatch('pot​assium')).toBe('potassium');
  });
});

describe('verifyVerbatim', () => {
  it('accepts a faithful quote despite dash and case drift', () => {
    const res = verifyVerbatim(
      'The normal adult serum potassium concentration is 3.5-5.0 mEq/L',
      SOURCE,
    );
    expect(res.ok).toBe(true);
    expect(res.matchedAt).toBeGreaterThanOrEqual(0);
  });

  it('accepts an elided quote when fragments appear in order', () => {
    const res = verifyVerbatim(
      'Hypokalemia is defined as ... below 3.5 mEq/L',
      SOURCE,
    );
    expect(res.ok).toBe(true);
  });

  it('REJECTS a fabricated quote that was never in the source', () => {
    const res = verifyVerbatim(
      'The normal adult serum potassium concentration is 3.5-5.3 mEq/L',
      SOURCE,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('quote_not_in_source');
  });

  it('REJECTS fragments stitched together out of order', () => {
    // Both fragments exist, but reversing them invents a claim the source
    // never makes. This is the subtle failure a naive "contains" check misses.
    const res = verifyVerbatim(
      'never give potassium chloride by IV push ... Potassium is the major intracellular cation',
      SOURCE,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('fragments_out_of_order');
  });

  it('REJECTS a quote too short to prove anything', () => {
    expect(verifyVerbatim('potassium', SOURCE).reason).toBe('excerpt_too_short');
  });

  it('REJECTS an empty excerpt and a missing source', () => {
    expect(verifyVerbatim('', SOURCE).reason).toBe('empty_excerpt');
    expect(verifyVerbatim('a sufficiently long excerpt here', undefined).reason)
      .toBe('source_not_found');
  });
});

describe('extractNumbers', () => {
  it('pulls decimals and ranges', () => {
    expect(extractNumbers('3.5-5.0 mEq/L').map((n) => n.value)).toEqual([3.5, 5.0]);
  });

  it('handles thousands separators', () => {
    expect(extractNumbers('platelets 150,000 to 400,000').map((n) => n.value))
      .toEqual([150000, 400000]);
  });

  it('ignores digits glued to letters, which are not measurements', () => {
    expect(extractNumbers('COVID19 and T2DM').map((n) => n.value)).toEqual([]);
  });
});

describe('verifyNumericAgreement', () => {
  it('passes when every asserted number is present in the citation', () => {
    const res = verifyNumericAgreement(
      'Normal serum potassium is 3.5 to 5.0 mEq/L.',
      'The normal adult serum potassium concentration is 3.5-5.0 mEq/L.',
    );
    expect(res.ok).toBe(true);
  });

  it('CATCHES a shifted lab range — the dangerous nursing hallucination', () => {
    const res = verifyNumericAgreement(
      'Normal serum potassium is 3.5 to 5.3 mEq/L.',
      'The normal adult serum potassium concentration is 3.5-5.0 mEq/L.',
    );
    expect(res.ok).toBe(false);
    expect(res.unsupported.map((n) => n.value)).toEqual([5.3]);
  });

  it('CATCHES an invented dose', () => {
    const res = verifyNumericAgreement(
      'Administer 40 mEq of potassium chloride.',
      'Administer potassium replacement only via a controlled infusion.',
    );
    expect(res.ok).toBe(false);
    expect(res.unsupported.map((n) => n.value)).toEqual([40]);
  });

  it('is vacuously true for claims asserting no numbers', () => {
    expect(
      verifyNumericAgreement('Never give potassium chloride by IV push.', 'anything').ok,
    ).toBe(true);
  });
});

describe('verifyLicenseUse', () => {
  it('blocks any content use of a tier D (proprietary) source', () => {
    const res = verifyLicenseUse({ tier: 'D', claim: 'Risk for decreased cardiac output' });
    expect(res.ok).toBe(false);
    expect(res.violation).toBe('tier_d_content_used');
  });

  it('allows tier A content freely', () => {
    expect(verifyLicenseUse({ tier: 'A', claim: 'anything at all' }).ok).toBe(true);
  });

  it('requires a verbatim excerpt for tier B (no-derivatives)', () => {
    const res = verifyLicenseUse({ tier: 'B', claim: 'Sepsis is a dysregulated host response.' });
    expect(res.ok).toBe(false);
    expect(res.violation).toBe('missing_excerpt');
  });

  it('REJECTS a tier B paraphrase, because ND forbids derivatives', () => {
    const res = verifyLicenseUse({
      tier: 'B',
      claim: 'Sepsis happens when the body overreacts to an infection.',
      excerpt: 'Sepsis is life-threatening organ dysfunction caused by a dysregulated host response to infection.',
    });
    expect(res.ok).toBe(false);
    expect(res.violation).toBe('tier_b_paraphrased');
  });

  it('accepts a tier B claim that is the quote itself', () => {
    const quote =
      'Sepsis is life-threatening organ dysfunction caused by a dysregulated host response to infection.';
    expect(verifyLicenseUse({ tier: 'B', claim: quote, excerpt: quote }).ok).toBe(true);
  });

  it('caps tier C excerpt length to prevent bulk reproduction', () => {
    const res = verifyLicenseUse({ tier: 'C', claim: 'x', excerpt: 'y'.repeat(301) });
    expect(res.ok).toBe(false);
    expect(res.violation).toBe('tier_c_bulk_stored');
  });
});

describe('qualifyExcerpt — outline ancestry', () => {
  /**
   * Verbatim text from the user's Alterations in Sodium slide. The bullet the
   * model quoted is true but never names hyponatremia; the condition is the
   * parent bullet. An adversarial audit failed 9 of 14 items this way.
   */
  const SODIUM = [
    'Alterations in Sodium',
    'Hyponatremia (<136mEq/L)',
    '  - Related to sodium loss or water gain',
    '  - S & S',
    '    - Poor skin turgor, dry mucous membranes, Headache',
    'Hypernatremia (>145mEq/L)',
    '  - Related to sodium gain or water loss',
  ].join('\n');

  it('prepends the parent bullet that names the condition', () => {
    const q = qualifyExcerpt('Related to sodium loss or water gain', SODIUM);
    expect(q).toContain('Hyponatremia');
    expect(q).toContain('Related to sodium loss or water gain');
    // Still a real quote: every fragment must be on the slide, in order.
    expect(verifyVerbatim(q, SODIUM).ok).toBe(true);
  });

  it('distinguishes the two conditions on the same slide', () => {
    // The hyper- bullet must inherit the hyper- parent, not the hypo- one.
    const q = qualifyExcerpt('Related to sodium gain or water loss', SODIUM);
    expect(q).toContain('Hypernatremia');
    expect(q).not.toContain('Hyponatremia');
    expect(verifyVerbatim(q, SODIUM).ok).toBe(true);
  });

  it('walks more than one level up for a nested finding', () => {
    const q = qualifyExcerpt('Poor skin turgor, dry mucous membranes, Headache', SODIUM);
    expect(q).toContain('Hyponatremia');
    expect(q).toContain('S & S');
    expect(verifyVerbatim(q, SODIUM).ok).toBe(true);
  });

  it('uses the heading when the quote is already top-level', () => {
    const adh = 'Antidiuretic Hormone\nIs a "water retainer" or vasopressin\nIt is made in the hypothalamus';
    const q = qualifyExcerpt('Is a "water retainer" or vasopressin', adh);
    expect(q).toContain('Antidiuretic Hormone');
    expect(verifyVerbatim(q, adh).ok).toBe(true);
  });

  it('keeps the original quote intact when it already carries its subject', () => {
    // The slide title may still be prepended -- harmless, and it is on the
    // slide -- but the quoted text itself must survive unaltered.
    const q = qualifyExcerpt('Hyponatremia (<136mEq/L)', SODIUM);
    expect(q).toContain('Hyponatremia (<136mEq/L)');
    expect(verifyVerbatim(q, SODIUM).ok).toBe(true);
  });

  it('cannot attach ancestry to a quote that is not on the slide', () => {
    const q = qualifyExcerpt('Related to potassium loss', SODIUM);
    expect(q).toBe('Related to potassium loss');
  });
});

describe('qualifyExcerpt — the heading is never dropped', () => {
  /**
   * Verbatim from the user's Fluid Volume Deficit slide. "Labs:" is an
   * indent-0 parent, and stopping the ancestry walk there dropped the slide
   * title -- the only line naming the condition. The citation then read
   * "Labs: ... Osmolarity: (> 295 mOsm/kg)", which proves a number but not
   * what it is a number FOR.
   */
  const DEFICIT = [
    'Fluid Volume Deficit',
    'Clinical Manifestations',
    '  - Tachycardia, weak thready pulse, hypotension',
    'Labs:',
    '  - Osmolarity: up (> 295 mOsm/kg)',
    '  - Urine specific gravity over 1.030',
  ].join('\n');

  it('includes the slide title even when an indent-0 parent exists', () => {
    const q = qualifyExcerpt('Osmolarity: up (> 295 mOsm/kg)', DEFICIT);
    expect(q).toContain('Fluid Volume Deficit');
    expect(q).toContain('Labs:');
    expect(verifyVerbatim(q, DEFICIT).ok).toBe(true);
  });

  it('puts the ancestry in outermost-first order', () => {
    const q = qualifyExcerpt('Osmolarity: up (> 295 mOsm/kg)', DEFICIT);
    expect(q.indexOf('Fluid Volume Deficit')).toBeLessThan(q.indexOf('Labs:'));
    expect(q.indexOf('Labs:')).toBeLessThan(q.indexOf('Osmolarity'));
  });

  it('does not repeat the heading when it is already an ancestor', () => {
    const q = qualifyExcerpt('Tachycardia, weak thready pulse, hypotension', DEFICIT);
    expect(q.match(/Fluid Volume Deficit/g)).toHaveLength(1);
    expect(verifyVerbatim(q, DEFICIT).ok).toBe(true);
  });

  it('still carries the numbers it quoted', async () => {
    const { verifyNumericAgreement } = await import('@core/validate/citation.js');
    const q = qualifyExcerpt('Osmolarity: up (> 295 mOsm/kg)', DEFICIT);
    expect(verifyNumericAgreement('Osmolarity above 295 mOsm/kg', q).ok).toBe(true);
  });
});
