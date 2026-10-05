import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orderFragments } from '@core/validate/repair.js';
import { verifyVerbatim } from '@core/validate/citation.js';

/**
 * Citation repair.
 *
 * The thing under test is not whether the model finds good spans. It is that
 * nothing it returns can become evidence unless that text is genuinely on the
 * slide the card already cites.
 */

const runClaude = vi.hoisted(() => vi.fn());
vi.mock('@core/generate/claude.js', () => ({
  runClaude,
  ClaudeError: class extends Error {},
}));

const { repairCitation } = await import('@core/validate/repair.js');

/** Verbatim from her Alterations in Sodium slide. */
const SLIDE = [
  'Alterations in Sodium',
  'Hyponatremia (<136mEq/L)',
  '  - Related to sodium loss or water gain',
  '  - S & S',
  '    - Confusion, lethargy, seizures/coma',
].join('\n');

function reply(data: unknown) {
  runClaude.mockResolvedValue({ data, estimatedCostUsd: 0.004 });
}

beforeEach(() => runClaude.mockReset());

const BASE = {
  claim: 'Hyponatremia causes confusion, lethargy and seizures',
  unsupportedPart: 'hyponatremia',
  excerpt: 'Confusion, lethargy, seizures/coma',
  slideText: SLIDE,
};

describe('repairCitation', () => {
  it('widens a citation with a span that really is on the slide', async () => {
    reply({ found: true, fragments: ['Hyponatremia (<136mEq/L)'] });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });

    expect(r.excerpt).toBeDefined();
    expect(r.excerpt).toContain('Hyponatremia (<136mEq/L)');
    expect(r.excerpt).toContain('Confusion, lethargy, seizures/coma');
    // The result must still be a real quote of that slide.
    expect(verifyVerbatim(r.excerpt!, SLIDE).ok).toBe(true);
  });

  it('REFUSES a span that is not on the slide', async () => {
    // True of hyponatremia, absent from this slide. This is the whole hazard:
    // a repair that invents evidence would launder a claim through the gate.
    reply({ found: true, fragments: ['Caused by SIADH and excess free water intake'] });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });

    expect(r.excerpt).toBeUndefined();
    expect(r.addedFragments).toEqual([]);
  });

  it('refuses a span that was altered rather than copied', async () => {
    // Plausible paraphrase of a line that IS on the slide.
    reply({ found: true, fragments: ['Hyponatremia (less than 136 mEq/L)'] });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });
    expect(r.excerpt).toBeUndefined();
  });

  it('keeps only the real span when some are invented', async () => {
    reply({
      found: true,
      fragments: ['Hyponatremia (<136mEq/L)', 'Treat with hypertonic saline'],
    });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });

    expect(r.excerpt).toContain('Hyponatremia (<136mEq/L)');
    expect(r.excerpt).not.toContain('hypertonic saline');
    expect(verifyVerbatim(r.excerpt!, SLIDE).ok).toBe(true);
  });

  it('accepts that the slide may simply not say it', async () => {
    reply({ found: false });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });
    expect(r.excerpt).toBeUndefined();
  });

  it('spends nothing when the auditor named no missing part', async () => {
    const r = await repairCitation({ ...BASE, unsupportedPart: '  ' }, { workspaceDir: 'ws' });
    expect(runClaude).not.toHaveBeenCalled();
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('puts fragments in document order, which the checker requires', async () => {
    // Returned bottom-up. Left as given, the quote would read out of order and
    // fail verification despite every fragment being genuine.
    reply({ found: true, fragments: ['Hyponatremia (<136mEq/L)', 'Alterations in Sodium'] });
    const r = await repairCitation(BASE, { workspaceDir: 'ws' });

    expect(r.excerpt!.indexOf('Alterations in Sodium'))
      .toBeLessThan(r.excerpt!.indexOf('Hyponatremia'));
    expect(verifyVerbatim(r.excerpt!, SLIDE).ok).toBe(true);
  });
});

describe('orderFragments', () => {
  it('sorts by position in the slide', () => {
    const out = orderFragments(['Confusion, lethargy', 'Alterations in Sodium'], SLIDE);
    expect(out[0]).toBe('Alterations in Sodium');
  });

  it('drops a fragment contained in another', () => {
    const out = orderFragments(['Hyponatremia', 'Hyponatremia (<136mEq/L)'], SLIDE);
    expect(out).toEqual(['Hyponatremia (<136mEq/L)']);
  });

  it('drops anything not present at all', () => {
    expect(orderFragments(['not on this slide'], SLIDE)).toEqual([]);
  });
});
