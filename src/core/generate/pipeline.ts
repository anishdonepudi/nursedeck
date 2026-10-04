import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { insertItem, type NewCitation } from '../db/repo.js';
import type { LectureDoc, LectureBlock } from '@shared/types.js';
import { runClaude, ClaudeError } from './claude.js';
import { batchBlocks, renderBatch, FLASHCARD_SYSTEM, CLOZE_SYSTEM, QA_SYSTEM, NCLEX_SYSTEM } from './prompts.js';
import {
  FLASHCARD_SCHEMA, CLOZE_SCHEMA, QA_SCHEMA, NCLEX_SCHEMA,
  type GeneratedFlashcard, type GeneratedCloze, type GeneratedQa, type GeneratedNclex,
  type GeneratedCitation,
} from './schemas.js';
import { checkFlashcard, checkCloze, checkNclex, type QualityIssue } from '../validate/quality.js';
import { verifyVerbatim, verifyNumericAgreement } from '../validate/citation.js';

/**
 * Lecture -> verified study items.
 *
 * Checks run cheapest-first, which is both a cost decision and a correctness
 * one: a card with a fabricated quote is rejected by exact string comparison
 * for free, and never reaches the paid entailment audit. Nothing is marked
 * studiable here — items land as 'pending' for human triage regardless.
 */

export type GenerationKind = 'flashcard' | 'cloze' | 'qa' | 'nclex';

export interface GenerationProgress {
  kind: GenerationKind;
  batch: number;
  totalBatches: number;
  produced: number;
  rejected: number;
  phase: 'generating' | 'validating' | 'done';
}

export interface GenerationOptions {
  kinds: GenerationKind[];
  workspaceDir: string;
  model?: string;
  /** Per-call ceiling, so a runaway batch cannot spend without bound. */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  cliPath?: string;
  onProgress?: (p: GenerationProgress) => void;
  /** Slides per batch, by character budget. */
  maxBatchChars?: number;
}

export interface RejectedItem {
  kind: GenerationKind;
  front: string;
  reason: string;
  stage: 'schema' | 'quality' | 'citation' | 'numeric';
  issues?: QualityIssue[];
}

export interface GenerationReport {
  lectureId: string;
  accepted: number;
  rejected: RejectedItem[];
  estimatedCostUsd: number;
  errors: string[];
  /** Item ids inserted as pending, in creation order. */
  itemIds: string[];
}

/** Everything needed to turn one generated item into a stored row. */
interface Candidate {
  kind: GenerationKind;
  front: string;
  back: string;
  payload?: unknown;
  citation: GeneratedCitation;
  /** The claim the citation must support — usually the answer. */
  claim: string;
  /**
   * The subset of the claim whose NUMBERS must appear in the cited text.
   *
   * This differs from `claim` for clinical vignettes. An NCLEX stem legitimately
   * invents its scenario — "a 72-year-old client", "admitted 2 days ago" — and
   * those numbers will never appear in a lecture slide. Requiring them would
   * reject every well-formed vignette. What must be grounded is the clinical
   * answer: a dose, a threshold, a reference range. So this narrows to the keyed
   * options for NCLEX items, while the full claim still goes to the entailment
   * audit, which can judge the scenario as a whole.
   */
  numericClaim: string;
  clientNeed?: string;
  njcmmStep?: string;
  cognitiveLevel?: 'recall' | 'application' | 'analysis';
  issues: QualityIssue[];
}

function systemFor(kind: GenerationKind): string {
  switch (kind) {
    case 'flashcard': return FLASHCARD_SYSTEM;
    case 'cloze': return CLOZE_SYSTEM;
    case 'qa': return QA_SYSTEM;
    case 'nclex': return NCLEX_SYSTEM;
  }
}

function schemaFor(kind: GenerationKind): unknown {
  switch (kind) {
    case 'flashcard': return FLASHCARD_SCHEMA;
    case 'cloze': return CLOZE_SCHEMA;
    case 'qa': return QA_SCHEMA;
    case 'nclex': return NCLEX_SCHEMA;
  }
}

function instructionFor(kind: GenerationKind, slideCount: number): string {
  const n = Math.max(2, Math.min(10, slideCount * 2));
  switch (kind) {
    case 'flashcard':
      return `Write up to ${n} flashcards from the lecture slides in the message. JSON only.`;
    case 'cloze':
      return `Write up to ${n} cloze-deletion cards from the lecture slides in the message. JSON only.`;
    case 'qa':
      return `Write up to ${Math.max(2, Math.floor(n / 2))} short-answer questions from the lecture slides in the message. JSON only.`;
    case 'nclex':
      return `Write up to ${Math.max(1, Math.floor(n / 2))} NCLEX-RN style questions from the lecture slides in the message. JSON only.`;
  }
}

/* ------------------------------------------------------------------ */
/* Normalising each content type into a common candidate shape         */
/* ------------------------------------------------------------------ */

function toCandidates(kind: GenerationKind, data: unknown): Candidate[] {
  const out: Candidate[] = [];

  if (kind === 'flashcard') {
    for (const c of (data as { cards?: GeneratedFlashcard[] }).cards ?? []) {
      const q = checkFlashcard(c);
      const cand: Candidate = {
        kind, front: c.front, back: c.back, citation: c.citation,
        claim: `${c.front} ${c.back}`,
        numericClaim: `${c.front} ${c.back}`,
        issues: q.issues,
      };
      if (c.cognitiveLevel) cand.cognitiveLevel = c.cognitiveLevel;
      out.push(cand);
    }
    return out;
  }

  if (kind === 'cloze') {
    for (const c of (data as { cards?: GeneratedCloze[] }).cards ?? []) {
      const q = checkCloze(c);
      out.push({
        kind, front: c.text, back: c.answer, citation: c.citation,
        claim: c.text.replace(/\{\{|\}\}/g, ''),
        numericClaim: c.text.replace(/\{\{|\}\}/g, ''),
        payload: { answer: c.answer }, issues: q.issues,
      });
    }
    return out;
  }

  if (kind === 'qa') {
    for (const c of (data as { items?: GeneratedQa[] }).items ?? []) {
      const issues: QualityIssue[] = [];
      if (!c.keyPoints?.length) {
        issues.push({
          rule: 'no_key_points',
          severity: 'reject',
          message: 'A short-answer question with no key points cannot be graded.',
        });
      }
      out.push({
        kind, front: c.question, back: c.modelAnswer, citation: c.citation,
        claim: c.modelAnswer,
        numericClaim: c.modelAnswer,
        payload: { keyPoints: c.keyPoints }, issues,
      });
    }
    return out;
  }

  for (const c of (data as { items?: GeneratedNclex[] }).items ?? []) {
    const q = checkNclex(c);
    const keys = c.options.filter((o) => o.isKey).map((o) => o.text);
    const cand: Candidate = {
      kind,
      front: c.stem,
      back: keys.join('; '),
      citation: c.citation,
      // The claim under test is the keyed answer, in the context of the stem.
      claim: `${c.stem} Correct: ${keys.join('; ')}`,
      // Only the clinical answer, never the invented vignette.
      numericClaim: keys.join('; '),
      payload: { itemType: c.itemType, selectN: c.selectN, options: c.options },
      clientNeed: c.clientNeed,
      njcmmStep: c.njcmmStep,
      issues: q.issues,
    };
    if (c.cognitiveLevel) cand.cognitiveLevel = c.cognitiveLevel;
    out.push(cand);
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** The text a citation is checked against: the slide it names. */
function blockText(b: LectureBlock): string {
  return [b.heading, b.body, b.tables?.map((r) => r.join(' | ')).join('\n'), b.speakerNotes]
    .filter(Boolean)
    .join('\n');
}

export async function generateForLecture(
  db: Db,
  doc: LectureDoc,
  sourceId: string,
  opts: GenerationOptions,
): Promise<GenerationReport> {
  const report: GenerationReport = {
    lectureId: doc.id,
    accepted: 0,
    rejected: [],
    estimatedCostUsd: 0,
    errors: [],
    itemIds: [],
  };

  const byOrdinal = new Map(doc.blocks.map((b) => [b.ordinal, b]));
  const batches = batchBlocks(doc.blocks, opts.maxBatchChars ?? 12_000);

  for (const kind of opts.kinds) {
    for (const [index, batch] of batches.entries()) {
      if (opts.signal?.aborted) {
        report.errors.push('Generation cancelled.');
        return report;
      }

      opts.onProgress?.({
        kind, batch: index + 1, totalBatches: batches.length,
        produced: report.accepted, rejected: report.rejected.length, phase: 'generating',
      });

      const generationId = randomUUID();
      let data: unknown;

      try {
        const res = await runClaude<unknown>(instructionFor(kind, batch.length), {
          schema: schemaFor(kind),
          workspaceDir: opts.workspaceDir,
          input: renderBatch(batch, doc.title),
          appendSystemPrompt: systemFor(kind),
          ...(opts.model ? { model: opts.model } : { model: 'sonnet' }),
          maxBudgetUsd: opts.maxBudgetUsd ?? 2,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
        });
        data = res.data;
        report.estimatedCostUsd += res.estimatedCostUsd;

        db.prepare(
          `INSERT INTO generations (id, lecture_id, kind, model, finished_at, ok, cost_usd, raw_output)
           VALUES (?, ?, ?, ?, datetime('now'), 1, ?, ?)`,
        ).run(generationId, doc.id, kind, opts.model ?? 'sonnet', res.estimatedCostUsd,
          JSON.stringify(res.data).slice(0, 100_000));
      } catch (err) {
        const message = err instanceof ClaudeError
          ? `${kind} batch ${index + 1}: ${err.message}`
          : `${kind} batch ${index + 1}: ${(err as Error).message}`;
        report.errors.push(message);
        db.prepare(
          `INSERT INTO generations (id, lecture_id, kind, model, finished_at, ok, error)
           VALUES (?, ?, ?, ?, datetime('now'), 0, ?)`,
        ).run(generationId, doc.id, kind, opts.model ?? 'sonnet', message);
        continue;
      }

      opts.onProgress?.({
        kind, batch: index + 1, totalBatches: batches.length,
        produced: report.accepted, rejected: report.rejected.length, phase: 'validating',
      });

      for (const cand of toCandidates(kind, data)) {
        // 1. Quality rules. Free, and catches the bulk of bad generation.
        const fatal = cand.issues.filter((i) => i.severity === 'reject');
        if (fatal.length > 0) {
          report.rejected.push({
            kind, front: cand.front, stage: 'quality',
            reason: fatal.map((f) => f.message).join(' '), issues: cand.issues,
          });
          continue;
        }

        // 2. The cited slide must exist. A hallucinated slide number is itself
        //    a fabricated citation.
        const block = byOrdinal.get(cand.citation.blockOrdinal);
        if (!block) {
          report.rejected.push({
            kind, front: cand.front, stage: 'citation',
            reason: `Cited slide ${cand.citation.blockOrdinal}, which does not exist in this lecture.`,
          });
          continue;
        }

        // 3. The quote must genuinely appear on that slide.
        const verbatim = verifyVerbatim(cand.citation.excerpt, blockText(block));
        if (!verbatim.ok) {
          report.rejected.push({
            kind, front: cand.front, stage: 'citation',
            reason: `Citation failed verbatim check (${verbatim.reason}).`,
          });
          continue;
        }

        // 4. Every number asserted must be present in the quote. This is the
        //    check that catches a shifted dose or lab range.
        const numeric = verifyNumericAgreement(cand.numericClaim, cand.citation.excerpt);
        if (!numeric.ok) {
          report.rejected.push({
            kind, front: cand.front, stage: 'numeric',
            reason: `States ${numeric.unsupported.map((n) => n.raw).join(', ')}, which the cited text does not contain.`,
          });
          continue;
        }

        const citation: NewCitation = {
          sourceId,
          claim: cand.claim,
          excerpt: cand.citation.excerpt,
          // Deterministic checks passed. The entailment audit runs separately
          // and promotes this to 'verified'.
          verdict: 'unverified',
        };
        if (verbatim.matchedAt !== undefined) citation.matchedAt = verbatim.matchedAt;

        const id = insertItem(
          db,
          {
            lectureId: doc.id,
            kind,
            front: cand.front,
            back: cand.back,
            ...(cand.payload !== undefined ? { payload: cand.payload } : {}),
            blockIds: [block.id],
            ...(cand.clientNeed ? { clientNeed: cand.clientNeed } : {}),
            ...(cand.njcmmStep ? { njcmmStep: cand.njcmmStep } : {}),
            ...(cand.cognitiveLevel ? { cognitiveLevel: cand.cognitiveLevel } : {}),
            generationId,
          },
          [citation],
        );
        report.itemIds.push(id);
        report.accepted += 1;
      }
    }
  }

  opts.onProgress?.({
    kind: opts.kinds[0] ?? 'flashcard',
    batch: batches.length,
    totalBatches: batches.length,
    produced: report.accepted,
    rejected: report.rejected.length,
    phase: 'done',
  });

  return report;
}
