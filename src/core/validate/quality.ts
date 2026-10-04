import { normalizeForMatch } from './citation.js';
import type { GeneratedFlashcard, GeneratedCloze, GeneratedNclex } from '../generate/schemas.js';

/**
 * Card and item quality screening.
 *
 * LLM-written study material is reliably bad without hard constraints, and a
 * nursing certification board reports that up to 60% of items written by HUMAN
 * subject experts never reach usable status -- usually from unclear stems or
 * implausible distractors. So the NBME and PNCB rule sets are implemented as a
 * checker that runs before anything is shown, rather than as prose in a prompt
 * that the model may or may not honour.
 *
 * Severity matters: 'reject' kills the item outright, 'warn' flags it for the
 * triage screen so a human decides.
 */

export type Severity = 'reject' | 'warn';

export interface QualityIssue {
  rule: string;
  severity: Severity;
  message: string;
}

export interface QualityResult {
  ok: boolean;
  issues: QualityIssue[];
}

function result(issues: QualityIssue[]): QualityResult {
  return { ok: !issues.some((i) => i.severity === 'reject'), issues };
}

/** Answers longer than this stop being a flashcard and become a paragraph. */
const MAX_ANSWER_WORDS = 20;
const MAX_FRONT_WORDS = 60;

const ABSOLUTE_TERMS = /\b(always|never|all|none|every|must always|only ever)\b/i;
const VAGUE_TERMS = /\b(usually|often|frequently|sometimes|commonly|generally|typically|may be|might be)\b/i;
const NEGATIVE_STEM = /\b(not|except|least likely|incorrect|false|contraindicated|avoid)\b/i;
const ALL_NONE_OF_ABOVE = /\b(all|none|both) of the (above|following)\b/i;

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Flashcards                                                          */
/* ------------------------------------------------------------------ */

export function checkFlashcard(card: GeneratedFlashcard): QualityResult {
  const issues: QualityIssue[] = [];
  const front = card.front.trim();
  const back = card.back.trim();

  if (!front) issues.push({ rule: 'empty_front', severity: 'reject', message: 'The question is empty.' });
  if (!back) issues.push({ rule: 'empty_back', severity: 'reject', message: 'The answer is empty.' });

  if (words(back).length > MAX_ANSWER_WORDS) {
    issues.push({
      rule: 'answer_too_long',
      severity: 'reject',
      message: `The answer is ${words(back).length} words; a card should hold one fact in ${MAX_ANSWER_WORDS} or fewer.`,
    });
  }

  if (words(front).length > MAX_FRONT_WORDS) {
    issues.push({
      rule: 'question_too_long',
      severity: 'warn',
      message: 'The question is long enough that it may be testing reading speed.',
    });
  }

  // The giveaway: the answer is sitting in the question.
  const nf = normalizeForMatch(front);
  const nb = normalizeForMatch(back);
  if (nb.length >= 8 && nf.includes(nb)) {
    issues.push({
      rule: 'answer_in_question',
      severity: 'reject',
      message: 'The answer appears verbatim in the question, so the card tests nothing.',
    });
  }

  // Two facts joined by "and" usually want to be two cards.
  if (/\band\b/i.test(back) && back.includes(';')) {
    issues.push({
      rule: 'multiple_facts',
      severity: 'warn',
      message: 'The answer looks like more than one fact; consider splitting the card.',
    });
  }

  if (!/[?:]$/.test(front) && !/^(what|which|when|where|why|how|who|name|list|define|state)\b/i.test(front)) {
    issues.push({
      rule: 'undirected_question',
      severity: 'warn',
      message: 'The question does not read as a question, which makes the expected answer ambiguous.',
    });
  }

  return result(issues);
}

/* ------------------------------------------------------------------ */
/* Cloze                                                               */
/* ------------------------------------------------------------------ */

const CLOZE_SPAN = /\{\{([^}]*)\}\}/g;

/**
 * Words that carry no information payload. A blank over one of these is
 * answerable from sentence grammar alone and therefore teaches nothing -- the
 * single most common failure in auto-generated cloze cards.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these',
  'those', 'it', 'its', 'as', 'from', 'can', 'may', 'will', 'should', 'would', 'patient', 'client',
]);

export function checkCloze(card: GeneratedCloze): QualityResult {
  const issues: QualityIssue[] = [];
  const spans = [...card.text.matchAll(CLOZE_SPAN)].map((m) => (m[1] ?? '').trim());

  if (spans.length === 0) {
    issues.push({
      rule: 'no_blank',
      severity: 'reject',
      message: 'The sentence contains no {{blank}}.',
    });
    return result(issues);
  }

  if (spans.length > 1) {
    issues.push({
      rule: 'multiple_blanks',
      severity: 'reject',
      message: 'More than one blank in a sentence makes the card test several facts at once.',
    });
  }

  const span = spans[0] ?? '';
  const normalizedSpan = normalizeForMatch(span);

  if (!normalizedSpan) {
    issues.push({ rule: 'empty_blank', severity: 'reject', message: 'The blank is empty.' });
    return result(issues);
  }

  if (normalizeForMatch(card.answer) !== normalizedSpan) {
    issues.push({
      rule: 'answer_mismatch',
      severity: 'reject',
      message: 'The stated answer does not match the text inside the braces.',
    });
  }

  // A blank over a function word is guessable from grammar.
  const spanWords = normalizedSpan.split(/\s+/);
  if (spanWords.every((w) => FUNCTION_WORDS.has(w))) {
    issues.push({
      rule: 'low_information_blank',
      severity: 'reject',
      message: `Blanking "${span}" tests grammar, not knowledge. Blank the value, drug, or finding instead.`,
    });
  }

  const remaining = card.text.replace(CLOZE_SPAN, '').trim();
  if (words(remaining).length < 4) {
    issues.push({
      rule: 'insufficient_context',
      severity: 'reject',
      message: 'Too little sentence remains around the blank to make it answerable.',
    });
  }

  return result(issues);
}

/* ------------------------------------------------------------------ */
/* NCLEX items                                                         */
/* ------------------------------------------------------------------ */

export function checkNclex(item: GeneratedNclex): QualityResult {
  const issues: QualityIssue[] = [];
  const stem = item.stem.trim();
  const keys = item.options.filter((o) => o.isKey);

  /* --- stem --- */

  // PNCB bans negatively worded stems, with one exception: contraindication
  // items, where the negative IS the clinically relevant knowledge.
  const leadIn = stem.split(/(?<=[.?])\s+/).at(-1) ?? stem;
  const isContraindication = /\bcontraindicat/i.test(leadIn);
  if (NEGATIVE_STEM.test(leadIn) && !isContraindication) {
    issues.push({
      rule: 'negative_stem',
      severity: 'warn',
      message: 'The lead-in is negatively worded; readers routinely miss "not"/"except".',
    });
  }

  if (/\bthe nurse should\b/i.test(leadIn) && !/\?$/.test(leadIn)) {
    issues.push({
      rule: 'undirected_stem',
      severity: 'warn',
      message: 'The lead-in does not pose a closed question.',
    });
  }

  if (words(stem).length < 12) {
    issues.push({
      rule: 'no_vignette',
      severity: 'warn',
      message: 'The stem is too short to be a clinical vignette; this tests recall, not judgement.',
    });
  }

  // NCLEX terminology.
  if (/\bpatient\b/i.test(stem)) {
    issues.push({
      rule: 'terminology_patient',
      severity: 'warn',
      message: 'NCLEX uses "client", not "patient".',
    });
  }

  /* --- answer key --- */

  if (keys.length === 0) {
    issues.push({ rule: 'no_key', severity: 'reject', message: 'No option is marked correct.' });
  }

  if (item.itemType === 'multiple_choice' && keys.length > 1) {
    issues.push({
      rule: 'multiple_keys',
      severity: 'reject',
      message: 'A single-answer item has more than one correct option.',
    });
  }

  if (item.itemType === 'select_n') {
    if (item.selectN === undefined) {
      issues.push({
        rule: 'missing_select_n',
        severity: 'reject',
        message: 'A select-N item does not say how many to select.',
      });
    } else if (keys.length !== item.selectN) {
      issues.push({
        rule: 'select_n_mismatch',
        severity: 'reject',
        message: `The stem asks for ${item.selectN} but ${keys.length} options are keyed.`,
      });
    }
  }

  if (item.itemType === 'select_all' && keys.length === item.options.length) {
    issues.push({
      rule: 'all_options_keyed',
      severity: 'reject',
      message: 'Every option is correct, so the item discriminates nothing.',
    });
  }

  /* --- options --- */

  for (const o of item.options) {
    if (ALL_NONE_OF_ABOVE.test(o.text)) {
      issues.push({
        rule: 'all_or_none_of_above',
        severity: 'reject',
        message: '"All/none of the above" turns the item into a true-false test.',
      });
      break;
    }
  }

  if (item.options.some((o) => ABSOLUTE_TERMS.test(o.text))) {
    issues.push({
      rule: 'absolute_terms',
      severity: 'warn',
      message: 'An option contains an absolute ("always"/"never"), which test-wise readers discard.',
    });
  }

  if (item.options.some((o) => VAGUE_TERMS.test(o.text))) {
    issues.push({
      rule: 'vague_terms',
      severity: 'warn',
      message: 'An option uses a vague frequency term that even experts read differently.',
    });
  }

  const texts = item.options.map((o) => normalizeForMatch(o.text));
  if (new Set(texts).size !== texts.length) {
    issues.push({
      rule: 'duplicate_options',
      severity: 'reject',
      message: 'Two options are the same.',
    });
  }

  // "Correct option stands out": a key noticeably longer than every distractor
  // is a giveaway independent of content.
  const keyLens = keys.map((k) => words(k.text).length);
  const distractorLens = item.options.filter((o) => !o.isKey).map((o) => words(o.text).length);
  if (keyLens.length > 0 && distractorLens.length > 0) {
    const minKey = Math.min(...keyLens);
    const maxDistractor = Math.max(...distractorLens);
    if (minKey > maxDistractor * 1.8 && minKey - maxDistractor >= 4) {
      issues.push({
        rule: 'key_stands_out',
        severity: 'warn',
        message: 'The correct option is much longer than every distractor, which cues the answer.',
      });
    }
  }

  // Clang clue: a distinctive stem word reappearing only in the key.
  const stemWords = new Set(
    normalizeForMatch(stem).split(/\s+/).filter((w) => w.length > 6),
  );
  for (const key of keys) {
    const keyWords = normalizeForMatch(key.text).split(/\s+/);
    const shared = keyWords.filter((w) => stemWords.has(w));
    const inDistractors = item.options
      .filter((o) => !o.isKey)
      .some((o) => shared.some((w) => normalizeForMatch(o.text).includes(w)));
    if (shared.length > 0 && !inDistractors) {
      issues.push({
        rule: 'clang_clue',
        severity: 'warn',
        message: `"${shared[0]}" appears in both the stem and only the correct option, cueing it.`,
      });
      break;
    }
  }

  // Every option needs a rationale; that is what makes the item teach.
  if (item.options.some((o) => !o.rationale?.trim())) {
    issues.push({
      rule: 'missing_rationale',
      severity: 'reject',
      message: 'An option has no rationale, so a wrong answer teaches nothing.',
    });
  }

  // The schema already restricts this to application/analysis, so this is
  // belt-and-braces: it keeps working if the schema is ever widened, and
  // guards against output that reached us without schema validation.
  if (String(item.cognitiveLevel) === 'recall') {
    issues.push({
      rule: 'recall_level',
      severity: 'warn',
      message: 'NCLEX items should sit at application or analysis level.',
    });
  }

  return result(issues);
}
