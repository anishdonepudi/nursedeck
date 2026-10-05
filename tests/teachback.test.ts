import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ratingForCoverage } from '@core/study/teachback.js';

/**
 * Teach-back grading.
 *
 * The grader is mocked here on purpose. What needs testing is not whether the
 * model marks well -- that is measured against real decks -- but whether this
 * code can be talked into showing her something the item never claimed.
 */

const runClaude = vi.hoisted(() => vi.fn());
vi.mock('@core/generate/claude.js', () => ({
  runClaude,
  ClaudeError: class extends Error {},
}));

const { gradeTeachBack } = await import('@core/study/teachback.js');

const QUESTION = 'Explain how the kidneys compensate for respiratory acidosis.';
const KEY_POINTS = [
  'The kidneys retain bicarbonate',
  'They excrete hydrogen ions',
  'Compensation takes hours to days',
];
const ANSWER = 'The kidneys hold onto bicarb and dump hydrogen ions, but it takes a couple of days.';

function reply(data: unknown) {
  runClaude.mockResolvedValue({ data, estimatedCostUsd: 0.002 });
}

beforeEach(() => runClaude.mockReset());

describe('gradeTeachBack', () => {
  it('credits a point she made in her own words', async () => {
    reply({
      points: [{ index: 0, covered: true, evidence: 'hold onto bicarb' }],
      feedback: 'Good.',
    });
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    expect(r.points[0]!.covered).toBe(true);
    expect(r.points[0]!.evidence).toBe('hold onto bicarb');
  });

  it('DROPS a criterion the item never listed', async () => {
    reply({
      points: [
        { index: 0, covered: true },
        // Invented: there are only three key points, indexes 0-2.
        { index: 7, covered: false, note: 'You did not mention the anion gap.' },
      ],
      feedback: 'x',
    });
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    // Marked against the item's scheme only. She is never shown a rule she was
    // not given, however reasonable it sounds.
    expect(r.points).toHaveLength(3);
    expect(r.total).toBe(3);
    expect(r.points.some((p) => p.note?.includes('anion gap'))).toBe(false);
  });

  it('does not credit a point the grader said nothing about', async () => {
    reply({ points: [{ index: 0, covered: true }], feedback: 'x' });
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    // A truncated response must not quietly award marks.
    expect(r.points[1]!.covered).toBe(false);
    expect(r.points[2]!.covered).toBe(false);
    expect(r.covered).toBe(1);
  });

  it('refuses evidence that is not actually in her answer', async () => {
    reply({
      points: [{ index: 0, covered: true, evidence: 'the kidneys reabsorb HCO3- in the proximal tubule' }],
      feedback: 'x',
    });
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    // She never wrote that. Showing it back as her words would misrepresent her
    // own answer to her.
    expect(r.points[0]!.covered).toBe(true);
    expect(r.points[0]!.evidence).toBeUndefined();
  });

  it('grades a blank answer without spending a model call', async () => {
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: '   ' }, {
      workspaceDir: 'ws',
    });
    expect(runClaude).not.toHaveBeenCalled();
    expect(r.covered).toBe(0);
    expect(r.suggestedRating).toBe(1);
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('handles an item with no marking scheme instead of pretending to grade', async () => {
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: [], answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    expect(runClaude).not.toHaveBeenCalled();
    expect(r.total).toBe(0);
    expect(r.feedback).toMatch(/cannot be graded/i);
  });

  it('ignores a duplicate verdict for the same point', async () => {
    reply({
      points: [
        { index: 1, covered: true, evidence: 'dump hydrogen ions' },
        { index: 1, covered: false, note: 'contradicts itself' },
      ],
      feedback: 'x',
    });
    const r = await gradeTeachBack({ question: QUESTION, keyPoints: KEY_POINTS, answer: ANSWER }, {
      workspaceDir: 'ws',
    });
    expect(r.points[1]!.covered).toBe(true);
    expect(r.points[1]!.note).toBeUndefined();
  });
});

describe('ratingForCoverage', () => {
  it('maps coverage to an FSRS button', () => {
    expect(ratingForCoverage(4, 4)).toBe(4);
    expect(ratingForCoverage(3, 4)).toBe(3);
    expect(ratingForCoverage(2, 4)).toBe(2);
    expect(ratingForCoverage(0, 4)).toBe(1);
  });

  it('reserves Easy for a complete answer', () => {
    // "Easy" tells FSRS she will still know this in months. A partial
    // explanation has not shown that.
    expect(ratingForCoverage(9, 10)).toBe(3);
    expect(ratingForCoverage(10, 10)).toBe(4);
  });

  it('makes Good reachable for a three-point item', () => {
    // Banding by ratio put 2-of-3 at 0.67, below any sensible Good threshold,
    // so the commonest item could only ever score Again, Hard or Easy.
    expect(ratingForCoverage(2, 3)).toBe(3);
    expect(ratingForCoverage(1, 3)).toBe(1);
  });

  it('does not divide by zero', () => {
    expect(ratingForCoverage(0, 0)).toBe(3);
  });
});
