/**
 * Deterministic citation verification.
 *
 * This is the anti-hallucination gate, and it runs without an LLM on purpose.
 * A generated item must quote a `verbatimExcerpt` from a source whose text we
 * already hold locally. If that quote does not actually appear in that source,
 * the citation is fabricated and the item is rejected. No model is asked to
 * grade its own work at this stage, so the check cannot be talked out of a
 * failure.
 *
 * A separate, isolated entailment pass (see entailment.ts) then asks whether
 * the genuine quote actually *supports* the claim. Both must pass.
 */

/**
 * Normalizes text so that typographic drift does not cause false rejections.
 * Models routinely re-case text, swap hyphens for en dashes, and convert
 * straight quotes to curly ones while otherwise quoting faithfully. None of
 * those change meaning, so none should fail verification.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    // Dashes and minus signs -> hyphen.
    .replace(/[‐-―−﹘﹣－]/g, '-')
    // Quotes -> straight.
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    // Zero-width and soft hyphen -> removed.
    .replace(/[​-‍⁠﻿­]/g, '')
    // Any whitespace run (incl. NBSP, newlines) -> single space.
    .replace(/[\s   -   　]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Ellipsis forms a model may use when eliding part of a quote. */
const ELLIPSIS = /\s*(?:\.\s*\.\s*\.|…|\[\s*\.\.\.\s*\]|\[\s*…\s*\])\s*/g;

export type CitationFailureReason =
  | 'empty_excerpt'
  | 'excerpt_too_short'
  | 'source_not_found'
  | 'quote_not_in_source'
  | 'fragments_out_of_order';

export interface VerbatimCheck {
  ok: boolean;
  reason?: CitationFailureReason;
  /** Character offset in the normalized source, for building a deep link. */
  matchedAt?: number;
  /** The fragment that failed, when a multi-part quote breaks. */
  failedFragment?: string;
}

/**
 * Shortest excerpt we will accept. Very short quotes ("potassium") would match
 * almost any source and therefore prove nothing.
 */
const MIN_EXCERPT_CHARS = 24;

/**
 * Confirms that `excerpt` genuinely appears in `sourceText`.
 *
 * Quotes containing an ellipsis are split into fragments; every fragment must
 * appear, and they must appear in the original order, so a model cannot stitch
 * together an unrelated sentence from scattered words.
 */
export function verifyVerbatim(excerpt: string, sourceText: string | undefined): VerbatimCheck {
  if (!excerpt || !excerpt.trim()) return { ok: false, reason: 'empty_excerpt' };
  if (sourceText === undefined) return { ok: false, reason: 'source_not_found' };

  const haystack = normalizeForMatch(sourceText);
  const fragments = excerpt
    .split(ELLIPSIS)
    .map((f) => normalizeForMatch(f))
    .filter((f) => f.length > 0);

  if (fragments.length === 0) return { ok: false, reason: 'empty_excerpt' };

  // Guard against a quote that is technically present but too thin to prove
  // anything. Measured across all fragments so "a ... b ... c" cannot sneak by.
  const totalChars = fragments.reduce((n, f) => n + f.length, 0);
  if (totalChars < MIN_EXCERPT_CHARS) {
    return { ok: false, reason: 'excerpt_too_short' };
  }

  let cursor = 0;
  let firstMatch: number | undefined;
  for (const fragment of fragments) {
    const idx = haystack.indexOf(fragment, cursor);
    if (idx === -1) {
      // Distinguish "absent entirely" from "present but out of order", because
      // the two mean different things when triaging a bad generation.
      const anywhere = haystack.indexOf(fragment);
      return {
        ok: false,
        reason: anywhere === -1 ? 'quote_not_in_source' : 'fragments_out_of_order',
        failedFragment: fragment,
      };
    }
    if (firstMatch === undefined) firstMatch = idx;
    cursor = idx + fragment.length;
  }

  return { ok: true, matchedAt: firstMatch };
}

/* ------------------------------------------------------------------ */
/* Numeric agreement                                                   */
/* ------------------------------------------------------------------ */

export interface NumericToken {
  raw: string;
  value: number;
}

/**
 * Pulls numbers out of text, including those inside ranges and decimals.
 * Deliberately ignores digits glued to letters (e.g. "COVID19", "T2DM") and
 * ordinals, which are not measurements.
 */
export function extractNumbers(text: string): NumericToken[] {
  const out: NumericToken[] = [];
  const normalized = normalizeForMatch(text);
  // A number, optionally with thousands separators and a decimal part, not
  // immediately preceded or followed by a letter.
  const re = /(?<![a-z0-9.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![a-z0-9])/g;
  for (const m of normalized.matchAll(re)) {
    const intPart = (m[1] ?? '').replace(/,/g, '');
    const frac = m[2];
    const raw = frac ? `${intPart}.${frac}` : intPart;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

export interface NumericCheck {
  ok: boolean;
  /** Numbers asserted by the claim that the cited excerpt does not contain. */
  unsupported: NumericToken[];
}

/**
 * Every number a claim asserts must also appear in the text cited for it.
 *
 * This matters more here than in most domains: the dangerous nursing
 * hallucination is not a wrong concept, it is a wrong dose or a shifted lab
 * range. A claim saying "3.5-5.0 mEq/L" cited to a passage saying "3.5-5.3"
 * fails, even though the sentences look alike.
 */
export function verifyNumericAgreement(claim: string, excerpt: string): NumericCheck {
  const claimNumbers = extractNumbers(claim);
  if (claimNumbers.length === 0) return { ok: true, unsupported: [] };

  const excerptValues = new Set(extractNumbers(excerpt).map((n) => n.value));
  const unsupported = claimNumbers.filter((n) => !excerptValues.has(n.value));
  return { ok: unsupported.length === 0, unsupported };
}

/* ------------------------------------------------------------------ */
/* Licence-tier enforcement                                            */
/* ------------------------------------------------------------------ */

import type { LicenseTier } from '@shared/types.js';

export type LicenseViolation =
  | 'tier_b_paraphrased'
  | 'tier_c_bulk_stored'
  | 'tier_d_content_used'
  | 'missing_excerpt';

export interface LicenseCheck {
  ok: boolean;
  violation?: LicenseViolation;
  detail?: string;
}

/** Tier C excerpts are for citation context only, never bulk reproduction. */
const TIER_C_MAX_EXCERPT_CHARS = 300;

/**
 * Enforces what we are allowed to do with each source.
 *
 * Tier B (CC BY-NC-ND) is the subtle one: "no derivatives" means we may quote
 * it but must not paraphrase it, so the rendered claim has to be the quote
 * itself rather than a reworded version of it.
 */
export function verifyLicenseUse(args: {
  tier: LicenseTier;
  claim: string;
  excerpt?: string;
}): LicenseCheck {
  const { tier, claim, excerpt } = args;

  if (tier === 'D') {
    return {
      ok: false,
      violation: 'tier_d_content_used',
      detail: 'Tier D sources may be named but never used as content.',
    };
  }

  if (tier === 'B') {
    if (!excerpt?.trim()) {
      return {
        ok: false,
        violation: 'missing_excerpt',
        detail: 'Tier B (CC BY-NC-ND) requires a verbatim excerpt.',
      };
    }
    // The claim must be the quote, not a rewording of it.
    const a = normalizeForMatch(claim);
    const b = normalizeForMatch(excerpt);
    if (!b.includes(a) && !a.includes(b)) {
      return {
        ok: false,
        violation: 'tier_b_paraphrased',
        detail:
          'Tier B forbids derivatives: present the source wording verbatim rather than paraphrasing it.',
      };
    }
  }

  if (tier === 'C' && excerpt && excerpt.length > TIER_C_MAX_EXCERPT_CHARS) {
    return {
      ok: false,
      violation: 'tier_c_bulk_stored',
      detail: `Tier C excerpts are capped at ${TIER_C_MAX_EXCERPT_CHARS} characters.`,
    };
  }

  return { ok: true };
}
