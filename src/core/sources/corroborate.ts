import type { Db } from '../db/index.js';
import { insertSource, listCitations } from '../db/repo.js';
import { randomUUID } from 'node:crypto';
import { lookupDrugReference, type ReferenceDocument } from './drugs.js';
import { verifyVerbatim, verifyNumericAgreement } from '../validate/citation.js';
import { checkEntailment } from '../validate/entailment.js';
import type { FetchOptions } from './http.js';

/**
 * Corroboration: checking a lecture's claim against an independent authority.
 *
 * This runs AFTER a card is already grounded in her lecture, and answers a
 * different question. The lecture citation proves "the slide says this"; a
 * corroborating citation proves "the FDA label says this too". Those come
 * apart more often than you would like -- slides are written in a hurry, copied
 * between years, and occasionally wrong.
 *
 * So a disagreement is the valuable output, not a failure. It is surfaced as a
 * conflict for her to look at rather than silently resolved, because we cannot
 * know whether the slide is outdated or the matching is simply off.
 */

export type CorroborationOutcome =
  | 'confirmed'      // an authority states the same thing
  | 'conflict'       // an authority appears to contradict the lecture
  | 'not_found'      // no authoritative source covers this
  | 'inconclusive';  // a source was found but does not settle the claim

export interface CorroborationResult {
  outcome: CorroborationOutcome;
  /** The source consulted, when one was found. */
  source?: { id: string; title: string; url: string };
  /** The passage that confirms or contradicts the claim. */
  excerpt?: string;
  detail?: string;
  estimatedCostUsd: number;
}

/**
 * Pulls candidate drug names out of a claim.
 *
 * Deliberately conservative: a false positive wastes a lookup and may attach an
 * unrelated label, which is worse than finding nothing. Capitalised words and
 * common nursing vocabulary are excluded, and a name is only accepted if RxNorm
 * recognises it.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'client', 'nurse', 'patient', 'dose', 'level',
  'serum', 'blood', 'normal', 'range', 'should', 'before', 'after', 'administer',
  'assess', 'monitor', 'check', 'hold', 'notify', 'provider', 'therapy', 'rate',
  'pulse', 'heart', 'minute', 'daily', 'oral', 'intravenous', 'injection',
]);

export function candidateDrugNames(claim: string): string[] {
  const words = claim
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOPWORDS.has(w));

  // Drug names in nursing material are overwhelmingly single tokens; the
  // suffixes below are the common generic-stem endings.
  const likely = words.filter((w) =>
    /(?:in|ol|ide|ine|ate|one|pam|cillin|mycin|statin|pril|sartan|azole|oxacin|parin|dipine)$/.test(w),
  );

  return [...new Set(likely)].slice(0, 3);
}

export interface CorroborateOptions extends FetchOptions {
  workspaceDir: string;
  model?: string;
  cliPath?: string;
  /** Skips the paid entailment step; deterministic checks only. */
  skipEntailment?: boolean;
}

async function findReference(
  claim: string,
  opts: CorroborateOptions,
): Promise<ReferenceDocument | undefined> {
  for (const name of candidateDrugNames(claim)) {
    const doc = await lookupDrugReference(name, opts).catch(() => undefined);
    if (doc) return doc;
  }
  return undefined;
}

/**
 * Checks one claim against an authoritative source and records the result.
 *
 * The source text is stored locally, so the corroborating citation can later be
 * re-verified by exact match exactly like a lecture citation -- a citation that
 * cannot be re-checked offline is not really evidence.
 */
export async function corroborateClaim(
  db: Db,
  itemId: string,
  claim: string,
  opts: CorroborateOptions,
): Promise<CorroborationResult> {
  const reference = await findReference(claim, opts);
  if (!reference) {
    return {
      outcome: 'not_found',
      estimatedCostUsd: 0,
      detail: 'No free authoritative source covers this claim. It remains cited to your lecture only.',
    };
  }

  // Store the document so its text is available for re-verification offline.
  const existing = db
    .prepare('SELECT id FROM sources WHERE doi_or_url = ? AND kind = ?')
    .get(reference.url, 'drug_label') as { id: string } | undefined;

  const sourceId = existing?.id ?? insertSource(db, {
    kind: 'drug_label',
    licenseTier: reference.licenseTier,
    groupOrAuthors: reference.groupOrAuthors,
    title: reference.title,
    ...(reference.container ? { container: reference.container } : {}),
    ...(reference.year ? { year: reference.year } : {}),
    doiOrUrl: reference.url,
    ...(reference.licenseUrl ? { licenseUrl: reference.licenseUrl } : {}),
    retrievedAt: reference.retrievedAt,
    fullText: reference.fullText,
  });

  const sourceInfo = { id: sourceId, title: reference.title, url: reference.url };

  // Find the most relevant passage: the sentence sharing the most distinctive
  // vocabulary with the claim.
  const excerpt = bestPassage(claim, reference.fullText);
  if (!excerpt) {
    return {
      outcome: 'inconclusive',
      source: sourceInfo,
      estimatedCostUsd: 0,
      detail: 'The label was found but contains no passage addressing this claim.',
    };
  }

  // A numeric disagreement is detectable for free and is the failure that
  // matters most, so it is checked before spending a model call.
  const numeric = verifyNumericAgreement(claim, excerpt);
  if (!numeric.ok) {
    return {
      outcome: 'conflict',
      source: sourceInfo,
      excerpt,
      estimatedCostUsd: 0,
      detail:
        `Your lecture states ${numeric.unsupported.map((n) => n.raw).join(', ')}, which does not ` +
        'appear in the manufacturer\'s labelling for this drug. Worth checking which is current.',
    };
  }

  if (opts.skipEntailment) {
    return { outcome: 'inconclusive', source: sourceInfo, excerpt, estimatedCostUsd: 0 };
  }

  const entailment = await checkEntailment(claim, excerpt, {
    workspaceDir: opts.workspaceDir,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
  });

  if (entailment.verdict === 'supports') {
    // Record it as a second, independent citation on the same item.
    db.prepare(
      `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
       VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
    ).run(randomUUID(), itemId, sourceId, claim, excerpt);

    return {
      outcome: 'confirmed',
      source: sourceInfo,
      excerpt,
      estimatedCostUsd: entailment.estimatedCostUsd,
    };
  }

  if (entailment.verdict === 'contradicts') {
    return {
      outcome: 'conflict',
      source: sourceInfo,
      excerpt,
      estimatedCostUsd: entailment.estimatedCostUsd,
      detail: entailment.reason,
    };
  }

  return {
    outcome: 'inconclusive',
    source: sourceInfo,
    excerpt,
    estimatedCostUsd: entailment.estimatedCostUsd,
    detail: entailment.reason,
  };
}

/**
 * Picks the passage of `text` most likely to address `claim`.
 *
 * Scored on shared distinctive words rather than embeddings, which keeps this
 * dependency-free and, more usefully, predictable: a passage is chosen because
 * it shares specific terms, not because a model felt it was related.
 */
export function bestPassage(claim: string, text: string, windowChars = 400): string | undefined {
  const claimWords = [
    ...new Set(
      claim.toLowerCase().replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ];
  if (claimWords.length === 0) return undefined;

  const claimNumbers = new Set(claim.match(/\d+(?:\.\d+)?/g) ?? []);

  const sentences = text
    .split(/(?<=[.;])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30);

  /**
   * A passage that is mostly figures is a dosing or interval table. Those match
   * numerically against almost any clinical claim while supporting none of
   * them, so they are scored down rather than excluded -- a genuine prose
   * sentence quoting a value should still win on its own merits.
   */
  const tabularPenalty = (s: string): number => {
    const tokens = s.split(/\s+/);
    if (tokens.length === 0) return 0;
    const numeric = tokens.filter((t) => /^[\d.,%()-]+$/.test(t)).length;
    return numeric / tokens.length > 0.3 ? 4 : 0;
  };

  /**
   * Rarer words identify a topic better than common ones. "hypokalemia"
   * matching is strong evidence; "patients" matching is none.
   */
  const rarity = new Map<string, number>();
  for (const w of claimWords) {
    const occurrences = text.toLowerCase().split(w).length - 1;
    rarity.set(w, occurrences === 0 ? 0 : 1 + 2 / Math.sqrt(occurrences));
  }

  let best: { score: number; at: number } | undefined;

  for (const [i, sentence] of sentences.entries()) {
    const lower = sentence.toLowerCase();

    let conceptScore = 0;
    let conceptHits = 0;
    for (const w of claimWords) {
      if (!lower.includes(w)) continue;
      conceptHits += 1;
      conceptScore += rarity.get(w) ?? 1;
    }

    // Numbers corroborate a concept match; they cannot substitute for one.
    // Without this, a dosing table wins every claim that mentions a figure.
    if (conceptHits === 0) continue;

    let numericScore = 0;
    for (const n of claimNumbers) if (sentence.includes(n)) numericScore += 1.5;

    const score = conceptScore + numericScore - tabularPenalty(sentence);
    if (score > (best?.score ?? 0)) best = { score, at: i };
  }

  // One weak shared word is coincidence, not relevance.
  if (!best || best.score < 2.5) return undefined;

  // A little following context, capped so a Tier-C excerpt could never become
  // bulk reproduction.
  const parts = [sentences[best.at]!];
  const next = sentences[best.at + 1];
  if (next && parts.join(' ').length + next.length <= windowChars) parts.push(next);

  return parts.join(' ').slice(0, windowChars);
}
