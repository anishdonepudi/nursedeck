import type { Db } from '../db/index.js';
import {
  listPending, listCitations, getSourceText, setCitationVerdict, getItemBlockText,
} from '../db/repo.js';
import { verifyClaim, type EntailmentOptions } from './entailment.js';

/**
 * Verifying a whole lecture's worth of cards in one go.
 *
 * Verification was per-card, driven from the triage screen. The gate worked,
 * but reaching it did not: after generating fifty cards she would have had to
 * click verify fifty times to discover which eleven were studiable. A correct
 * guarantee nobody has the patience to reach is not a working product.
 *
 * Three things this has to get right, because they are what make a long
 * unattended run safe to start:
 *
 * - CANCELLABLE. She can stop it, and stopping leaves every card already
 *   checked correctly recorded rather than rolling back.
 * - BOUNDED. A budget stops the run rather than silently spending; the cards
 *   not reached stay pending, which is their honest state.
 * - FAULT-TOLERANT. One card that errors does not abandon the other forty-nine.
 *   Errors are collected and reported, never swallowed.
 */

export interface VerifyAllOptions extends EntailmentOptions {
  lectureId: string;
  /** Hard ceiling for the whole run. */
  maxBudgetUsd?: number;
  onProgress?: (p: VerifyProgress) => void;
}

export interface VerifyProgress {
  item: number;
  totalItems: number;
  verified: number;
  failed: number;
}

export interface VerifyAllReport {
  checked: number;
  verified: number;
  failed: number;
  /** Items not reached because the run was cancelled or hit its budget. */
  remaining: number;
  estimatedCostUsd: number;
  errors: string[];
  stoppedEarly?: 'cancelled' | 'budget';
}

/**
 * Verifies one citation and records the outcome.
 *
 * Exported because the single-card path in triage must behave identically to
 * the bulk path. Two copies of this logic would drift, and the drift would be
 * in what counts as verified.
 */
export async function verifyOneCitation(
  db: Db,
  citation: { id: string; sourceId: string; claim: string; excerpt: string; licenseTier: 'A' | 'B' | 'C' | 'D' },
  opts: EntailmentOptions,
  itemId?: string,
): Promise<{ ok: boolean; estimatedCostUsd: number }> {
  // A citation names a SLIDE, so it is checked against that slide rather than
  // against the whole lecture concatenated together. Using the whole lecture
  // let citation repair stitch fragments from different slides into a quote
  // that verified against the concatenation and appeared on no single slide --
  // five such quotes turned up in an audit of the acid-base deck. Falls back to
  // the source for citations with no slide: her own cards, imported ones, and
  // drug labels.
  const sourceText =
    (itemId ? getItemBlockText(db, itemId) : undefined) ?? getSourceText(db, citation.sourceId);
  const result = await verifyClaim(
    { claim: citation.claim, excerpt: citation.excerpt, sourceText, tier: citation.licenseTier },
    opts,
  );

  // A widened citation is written back. The audit that passed ran against the
  // wider quote, so storing the original would show her a quote that was never
  // the one verified.
  if (result.ok && result.repairedExcerpt) {
    db.prepare('UPDATE citations SET excerpt = ? WHERE id = ?').run(result.repairedExcerpt, citation.id);
  }

  setCitationVerdict(
    db,
    citation.id,
    result.ok ? 'verified' : 'failed',
    result.failure
      ? { stage: result.failure.stage, detail: 'detail' in result.failure ? result.failure.detail : undefined }
      : undefined,
  );

  return { ok: result.ok, estimatedCostUsd: result.estimatedCostUsd };
}

export async function verifyPendingItems(
  db: Db,
  opts: VerifyAllOptions,
): Promise<VerifyAllReport> {
  const items = listPending(db, opts.lectureId);
  const report: VerifyAllReport = {
    checked: 0, verified: 0, failed: 0, remaining: items.length,
    estimatedCostUsd: 0, errors: [],
  };

  for (const [index, item] of items.entries()) {
    if (opts.signal?.aborted) {
      report.stoppedEarly = 'cancelled';
      break;
    }
    if (opts.maxBudgetUsd !== undefined && report.estimatedCostUsd >= opts.maxBudgetUsd) {
      report.stoppedEarly = 'budget';
      break;
    }

    const citations = listCitations(db, item.id);
    // Nothing to re-check on a card that is already verified.
    const outstanding = citations.filter((c) => c.verdict !== 'verified');
    if (outstanding.length === 0) {
      report.checked++;
      report.verified++;
      report.remaining--;
      continue;
    }

    let allOk = true;
    for (const c of outstanding) {
      try {
        const r = await verifyOneCitation(db, c, opts, item.id);
        report.estimatedCostUsd += r.estimatedCostUsd;
        if (!r.ok) allOk = false;
      } catch (e) {
        // One bad card must not cost the rest of the run.
        allOk = false;
        report.errors.push(`${item.front.slice(0, 60)}: ${(e as Error).message}`);
      }
    }

    report.checked++;
    report.remaining--;
    if (allOk) report.verified++;
    else report.failed++;

    opts.onProgress?.({
      item: index + 1,
      totalItems: items.length,
      verified: report.verified,
      failed: report.failed,
    });
  }

  return report;
}
