import { fetchJson, type FetchOptions } from './http.js';
import type { LicenseTier } from '@shared/types.js';

/**
 * Drug reference sources, all free and requiring no API key.
 *
 * Chain: a free-text drug name is resolved to an RxCUI by RxNorm, which is what
 * makes the other sources joinable; then openFDA (CC0, best licence of any
 * source here) and DailyMed (the actual FDA-approved labelling) supply the text
 * a claim can be checked against.
 */

export interface ReferenceDocument {
  /** Stable id for the stored source row. */
  externalId: string;
  title: string;
  groupOrAuthors: string;
  container?: string;
  year?: string;
  url: string;
  licenseTier: LicenseTier;
  licenseUrl?: string;
  /** The text citations are verified against. */
  fullText: string;
  retrievedAt: string;
}

/* ------------------------------------------------------------------ */
/* RxNorm -- name resolution                                            */
/* ------------------------------------------------------------------ */

interface RxcuiResponse {
  idGroup?: { rxnormId?: string[] };
}

interface ApproxResponse {
  approximateGroup?: { candidate?: { rxcui?: string; name?: string; score?: string }[] };
}

/**
 * Resolves a drug name to an RxCUI, falling back to approximate matching.
 *
 * The fallback matters because lecture slides abbreviate and misspell drug
 * names constantly, and an exact-match-only lookup would silently find nothing
 * for most real input.
 */
export async function resolveDrug(
  name: string,
  opts: FetchOptions = {},
): Promise<{ rxcui: string; matchedName: string; exact: boolean } | undefined> {
  const term = name.trim();
  if (!term) return undefined;

  const exact = await fetchJson<RxcuiResponse>(
    `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(term)}&search=1`,
    opts,
  ).catch(() => undefined);

  const hit = exact?.idGroup?.rxnormId?.[0];
  if (hit) return { rxcui: hit, matchedName: term, exact: true };

  const approx = await fetchJson<ApproxResponse>(
    `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=1`,
    opts,
  ).catch(() => undefined);

  const candidate = approx?.approximateGroup?.candidate?.[0];
  if (!candidate?.rxcui) return undefined;

  // A weak approximate match is worse than none: it would attach an
  // authoritative-looking label for the wrong drug.
  const score = Number(candidate.score ?? 0);
  if (score < 50) return undefined;

  return {
    rxcui: candidate.rxcui,
    matchedName: candidate.name ?? term,
    exact: false,
  };
}

/* ------------------------------------------------------------------ */
/* openFDA -- structured label sections, CC0                            */
/* ------------------------------------------------------------------ */

interface OpenFdaLabelResult {
  results?: {
    effective_time?: string;
    indications_and_usage?: string[];
    dosage_and_administration?: string[];
    contraindications?: string[];
    warnings_and_cautions?: string[];
    boxed_warning?: string[];
    adverse_reactions?: string[];
    drug_interactions?: string[];
    pregnancy?: string[];
    nursing_mothers?: string[];
    pediatric_use?: string[];
    geriatric_use?: string[];
    openfda?: { brand_name?: string[]; generic_name?: string[]; spl_set_id?: string[] };
  }[];
}

/** Label sections worth studying, in the order a nurse would want them. */
const LABEL_SECTIONS: [keyof NonNullable<OpenFdaLabelResult['results']>[number], string][] = [
  ['boxed_warning', 'BOXED WARNING'],
  ['indications_and_usage', 'INDICATIONS AND USAGE'],
  ['dosage_and_administration', 'DOSAGE AND ADMINISTRATION'],
  ['contraindications', 'CONTRAINDICATIONS'],
  ['warnings_and_cautions', 'WARNINGS AND PRECAUTIONS'],
  ['drug_interactions', 'DRUG INTERACTIONS'],
  ['adverse_reactions', 'ADVERSE REACTIONS'],
  ['pregnancy', 'PREGNANCY'],
  ['nursing_mothers', 'NURSING MOTHERS'],
  ['pediatric_use', 'PEDIATRIC USE'],
  ['geriatric_use', 'GERIATRIC USE'],
];

/** Label text runs to tens of thousands of characters; trim per section. */
const MAX_SECTION_CHARS = 4_000;

export async function fetchDrugLabel(
  genericName: string,
  opts: FetchOptions = {},
): Promise<ReferenceDocument | undefined> {
  const query = encodeURIComponent(`openfda.generic_name:"${genericName}"`);
  const data = await fetchJson<OpenFdaLabelResult>(
    `https://api.fda.gov/drug/label.json?search=${query}&limit=1`,
    opts,
  ).catch(() => undefined);

  const label = data?.results?.[0];
  if (!label) return undefined;

  const parts: string[] = [];
  for (const [key, heading] of LABEL_SECTIONS) {
    const value = label[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    const text = value.join('\n').trim();
    if (!text) continue;
    parts.push(`${heading}\n${text.slice(0, MAX_SECTION_CHARS)}`);
  }
  if (parts.length === 0) return undefined;

  const brand = label.openfda?.brand_name?.[0];
  const generic = label.openfda?.generic_name?.[0] ?? genericName;
  const setId = label.openfda?.spl_set_id?.[0];
  const year = label.effective_time?.slice(0, 4);

  return {
    externalId: `openfda:${setId ?? generic}`,
    title: brand ? `${generic} (${brand}) -- FDA label` : `${generic} -- FDA label`,
    groupOrAuthors: 'U.S. Food and Drug Administration',
    container: 'openFDA',
    ...(year ? { year } : {}),
    url: setId
      ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`
      : `https://api.fda.gov/drug/label.json?search=${query}`,
    // openFDA is dedicated to the public domain under CC0.
    licenseTier: 'A' as LicenseTier,
    licenseUrl: 'https://open.fda.gov/license',
    fullText: parts.join('\n\n'),
    retrievedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* DailyMed -- the authoritative SPL record                             */
/* ------------------------------------------------------------------ */

interface DailyMedNameResponse {
  data?: { drug_name?: string }[];
}

interface DailyMedSplResponse {
  data?: { setid?: string; title?: string; published_date?: string }[];
}

/**
 * Confirms a drug exists in FDA labelling and returns its SPL record.
 *
 * Used alongside openFDA rather than instead of it: openFDA gives clean
 * per-section text, while DailyMed is the record of origin and the right thing
 * to link a student to.
 */
export async function fetchDailyMedRecord(
  drugName: string,
  opts: FetchOptions = {},
): Promise<{ setId: string; title: string; url: string; publishedYear?: string } | undefined> {
  const names = await fetchJson<DailyMedNameResponse>(
    `https://dailymed.nlm.nih.gov/dailymed/services/v2/drugnames.json?drug_name=${encodeURIComponent(drugName)}`,
    opts,
  ).catch(() => undefined);

  if (!names?.data?.length) return undefined;

  const spls = await fetchJson<DailyMedSplResponse>(
    `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(drugName)}&pagesize=1`,
    opts,
  ).catch(() => undefined);

  const spl = spls?.data?.[0];
  if (!spl?.setid) return undefined;

  return {
    setId: spl.setid,
    title: spl.title ?? drugName,
    url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${spl.setid}`,
    ...(spl.published_date ? { publishedYear: spl.published_date.slice(0, 4) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Best available authoritative document for a drug name.
 *
 * Resolution runs first so that a misspelling on a slide still finds the right
 * label, and so the generic name is used for the label lookup.
 */
export async function lookupDrugReference(
  name: string,
  opts: FetchOptions = {},
): Promise<ReferenceDocument | undefined> {
  const resolved = await resolveDrug(name, opts);
  const lookupName = resolved?.matchedName ?? name;

  // RxNorm returns names like "metformin 500 MG Oral Tablet"; the label lookup
  // wants the ingredient alone.
  const ingredient = lookupName.split(/\s+\d/)[0]?.trim() ?? lookupName;

  const label = await fetchDrugLabel(ingredient, opts);
  if (!label) return undefined;

  const dailymed = await fetchDailyMedRecord(ingredient, opts).catch(() => undefined);
  if (dailymed) {
    return {
      ...label,
      url: dailymed.url,
      ...(dailymed.publishedYear ? { year: dailymed.publishedYear } : {}),
    };
  }
  return label;
}
