import { runClaude } from '../generate/claude.js';

/**
 * Grading a typed explanation against the key points of a Q&A item.
 *
 * Why this exists: Q&A items are generated WITH a list of key points -- the
 * schema describes them as "used to grade a typed response" -- but study was
 * grading every answer with a normalised string comparison. That is right for a
 * flashcard whose answer is "3.5-5.0 mEq/L" and useless for a question asking
 * her to explain compensation, where a correct three-sentence answer scores
 * wrong. The content type was being produced and could not really be studied.
 *
 * This is a different kind of model call from the rest of the app, and the
 * difference matters. Everywhere else a model's output becomes study content
 * and must be pinned to a citation. Here the output is feedback about HER
 * answer: it cannot inject a false nursing fact into her deck. What it CAN do
 * is invent a criterion she was never told about, so the one hard rule is that
 * the grader may only judge the key points stored on the item. Anything it
 * returns that does not line up with one of them is dropped before she sees it.
 */

export interface KeyPointVerdict {
  /** Index into the item's own keyPoints. */
  index: number;
  keyPoint: string;
  covered: boolean;
  /** Which part of her answer covered it, quoted from what she typed. */
  evidence?: string;
  /** Said only when it is missing, and phrased as what to add. */
  note?: string;
}

export interface TeachBackResult {
  points: KeyPointVerdict[];
  covered: number;
  total: number;
  /** One or two sentences, addressed to her. */
  feedback: string;
  /** Suggested FSRS button, derived from coverage rather than guessed. */
  suggestedRating: 1 | 2 | 3 | 4;
  estimatedCostUsd: number;
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Index of the key point being judged.' },
          covered: { type: 'boolean' },
          evidence: { type: 'string', description: 'Words from HER answer that cover it.' },
          note: { type: 'string', description: 'What is missing. Only when not covered.' },
        },
        required: ['index', 'covered'],
        additionalProperties: false,
      },
    },
    feedback: { type: 'string' },
  },
  required: ['points', 'feedback'],
  additionalProperties: false,
} as const;

const GRADE_SYSTEM = `You mark a nursing student's typed explanation against a fixed marking scheme.

You are given a question, the key points a complete answer must contain, and
what she wrote. Judge ONLY whether each key point is present in her answer.

- Judge meaning, not wording. Her own phrasing, abbreviations and synonyms count:
  "the kidneys hold onto bicarb" covers "the kidneys retain bicarbonate".
- Mark a point covered only if she actually said it. Do not give credit for
  something she nearly said, implied, or would probably know.
- NEVER introduce a criterion of your own. The key points you were given are the
  entire marking scheme, even if her answer is missing something else important.
- "evidence" must be words SHE wrote, copied exactly. Never your own paraphrase.
- "note" says what is missing, addressed to her, in one short sentence.
- Do not correct her nursing facts here and do not teach. Only mark.
- feedback is one or two sentences: what she got, then the single most useful
  thing to add. Encouraging and specific, never effusive.

Respond with JSON only.`;

export interface TeachBackOptions {
  workspaceDir: string;
  model?: string;
  cliPath?: string;
  signal?: AbortSignal;
  maxBudgetUsd?: number;
}

/**
 * Maps coverage to an FSRS button.
 *
 * Deliberately strict at the top: "Easy" means she would still know this in
 * months, which a partially complete explanation does not demonstrate. Exported
 * so the mapping is testable without a model call.
 */
export function ratingForCoverage(covered: number, total: number): 1 | 2 | 3 | 4 {
  if (total === 0) return 3;
  if (covered >= total) return 4;

  // Banded by points MISSED rather than by ratio. Most items have three key
  // points, and a ratio scale puts 2-of-3 at 0.67 -- below any sensible "Good"
  // threshold -- so "Good" was unreachable for the commonest case and a nearly
  // complete answer scored Hard. Missing exactly one point is a good answer.
  const missed = total - covered;
  if (missed === 1) return 3;
  if (covered >= total / 2) return 2;
  return 1;
}

/** An empty or near-empty answer is a lapse, and needs no model call to say so. */
function isBlank(answer: string): boolean {
  return answer.trim().length < 2;
}

export async function gradeTeachBack(
  args: { question: string; keyPoints: string[]; answer: string },
  opts: TeachBackOptions,
): Promise<TeachBackResult> {
  const keyPoints = args.keyPoints.filter((k) => k.trim().length > 0);

  if (isBlank(args.answer) || keyPoints.length === 0) {
    return {
      points: keyPoints.map((keyPoint, index) => ({ index, keyPoint, covered: false })),
      covered: 0,
      total: keyPoints.length,
      feedback: isBlank(args.answer)
        ? 'Nothing to mark yet. Say what you can, even partially -- a half answer is worth more than skipping it.'
        : 'This question has no marking scheme, so it cannot be graded.',
      suggestedRating: 1,
      estimatedCostUsd: 0,
    };
  }

  // Her answer goes over stdin inside explicit delimiters. She could type
  // anything, including something instruction-shaped; it is content to mark.
  const payload = [
    '<<<QUESTION>>>',
    args.question.trim(),
    '<<<END QUESTION>>>',
    '',
    '<<<KEY POINTS>>>',
    ...keyPoints.map((k, i) => `${i}. ${k}`),
    '<<<END KEY POINTS>>>',
    '',
    '<<<STUDENT ANSWER>>>',
    args.answer.trim(),
    '<<<END STUDENT ANSWER>>>',
  ].join('\n');

  const res = await runClaude<{
    points: { index: number; covered: boolean; evidence?: string; note?: string }[];
    feedback: string;
  }>('Mark the student answer in the message against the key points. JSON only.', {
    schema: GRADE_SCHEMA,
    workspaceDir: opts.workspaceDir,
    input: payload,
    appendSystemPrompt: GRADE_SYSTEM,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
  });

  // Only the item's own key points may be graded. A returned index that is not
  // one of them is an invented criterion, and is dropped rather than shown.
  const byIndex = new Map<number, { covered: boolean; evidence?: string; note?: string }>();
  for (const p of res.data?.points ?? []) {
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= keyPoints.length) continue;
    if (byIndex.has(p.index)) continue;
    byIndex.set(p.index, p);
  }

  const points: KeyPointVerdict[] = keyPoints.map((keyPoint, index) => {
    const graded = byIndex.get(index);
    const verdict: KeyPointVerdict = {
      index,
      keyPoint,
      // A point the grader said nothing about is not credited. Silence is not a
      // pass, or a truncated response would quietly award marks.
      covered: graded?.covered === true,
    };
    // Evidence must be her words. Anything not actually in her answer is the
    // grader paraphrasing, which would misrepresent what she wrote back to her.
    if (graded?.evidence && args.answer.toLowerCase().includes(graded.evidence.trim().toLowerCase())) {
      verdict.evidence = graded.evidence.trim();
    }
    if (!verdict.covered && graded?.note) verdict.note = graded.note.trim();
    return verdict;
  });

  const covered = points.filter((p) => p.covered).length;

  return {
    points,
    covered,
    total: keyPoints.length,
    feedback: res.data?.feedback?.trim() || `You covered ${covered} of ${keyPoints.length}.`,
    suggestedRating: ratingForCoverage(covered, keyPoints.length),
    estimatedCostUsd: res.estimatedCostUsd,
  };
}
