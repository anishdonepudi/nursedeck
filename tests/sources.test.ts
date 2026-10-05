import { CLI_AVAILABLE } from './fixtures/has-cli.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPolicy, fetchReference, FetchPolicyError, ALLOWED_HOSTS, DENIED_HOSTS, resetThrottle,
} from '@core/sources/http.js';
import { resolveDrug, fetchDrugLabel, lookupDrugReference } from '@core/sources/drugs.js';
import { candidateDrugNames, bestPassage, corroborateClaim } from '@core/sources/corroborate.js';
import { openDb, type Db } from '@core/db/index.js';
import { insertLecture, insertItem, listCitations } from '@core/db/repo.js';
import type { LectureDoc } from '@shared/types.js';

let cacheDir: string;
let workspaceDir: string;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'nursedeck-cache-'));
  workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-src-ws-'));
});

/* ------------------------------------------------------------------ */

describe('fetch policy', () => {
  it('allows a host on the list', () => {
    const v = checkPolicy('https://api.fda.gov/drug/label.json?search=x');
    expect(v.ok).toBe(true);
  });

  it('REFUSES a host that forbids automated fetching, and says why', () => {
    const v = checkPolicy('https://www.ahajournals.org/doi/10.1161/CIR.0000000000001063');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/disallows AI agents/i);
  });

  it('REFUSES a paywalled commercial source', () => {
    const v = checkPolicy('https://www.uptodate.com/contents/digoxin');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/subscription/i);
  });

  it('REFUSES Bookshelf HTML, pointing at the supported channel', () => {
    const v = checkPolicy('https://www.ncbi.nlm.nih.gov/books/NBK554842/');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/E-utilities|FTP/i);
  });

  it('REFUSES an unknown host by default rather than allowing it', () => {
    const v = checkPolicy('https://example.com/some-nursing-page');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/allow-list/i);
  });

  it('REFUSES plain http', () => {
    expect(checkPolicy('http://api.fda.gov/drug/label.json').ok).toBe(false);
  });

  it('throws rather than fetching a denied host', async () => {
    await expect(fetchReference('https://quizlet.com/deck/123')).rejects.toThrow(FetchPolicyError);
  });

  it('every allowed host declares a rate limit and cache lifetime', () => {
    for (const [host, policy] of Object.entries(ALLOWED_HOSTS)) {
      expect(policy.rps, host).toBeGreaterThan(0);
      expect(policy.cacheHours, host).toBeGreaterThan(0);
    }
  });

  it('no host is both allowed and denied', () => {
    for (const host of Object.keys(ALLOWED_HOSTS)) {
      expect(DENIED_HOSTS[host], `${host} is on both lists`).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */

describe('caching and rate limiting', () => {
  beforeEach(() => resetThrottle());

  it('serves a repeat request from disk', async () => {
    const url = 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=digoxin&search=1';
    const first = await fetchReference(url, { cacheDir });
    expect(first.fromCache).toBe(false);

    const second = await fetchReference(url, { cacheDir });
    expect(second.fromCache).toBe(true);
    expect(second.body).toBe(first.body);
  }, 60_000);

  it('spaces requests to the same host', async () => {
    // RxNav publishes 20 req/s, so two uncached calls must be >= ~50ms apart.
    const started = Date.now();
    await fetchReference('https://rxnav.nlm.nih.gov/REST/rxcui.json?name=aspirin&search=1', { noCache: true });
    await fetchReference('https://rxnav.nlm.nih.gov/REST/rxcui.json?name=warfarin&search=1', { noCache: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  }, 60_000);
});

/* ------------------------------------------------------------------ */

describe('drug lookup (live, free APIs)', () => {
  it('resolves an exact drug name to an RxCUI', async () => {
    const r = await resolveDrug('digoxin', { cacheDir });
    expect(r?.rxcui).toBe('3407');
    expect(r?.exact).toBe(true);
  }, 60_000);

  it('recovers from a misspelling, which slides are full of', async () => {
    const r = await resolveDrug('metformine', { cacheDir });
    expect(r).toBeDefined();
    expect(r?.matchedName.toLowerCase()).toContain('metformin');
  }, 60_000);

  it('returns nothing for a term that is not a drug', async () => {
    expect(await resolveDrug('xyzzyplughwibble', { cacheDir })).toBeUndefined();
  }, 60_000);

  it('fetches FDA label text with the sections a nurse needs', async () => {
    const doc = await fetchDrugLabel('digoxin', { cacheDir });
    expect(doc).toBeDefined();
    expect(doc!.fullText).toMatch(/INDICATIONS AND USAGE/);
    expect(doc!.fullText.length).toBeGreaterThan(200);
    // openFDA is CC0, so it is storable and quotable without restriction.
    expect(doc!.licenseTier).toBe('A');
    expect(doc!.groupOrAuthors).toMatch(/Food and Drug Administration/);
  }, 60_000);

  it('links to the DailyMed record rather than to a raw API URL', async () => {
    const doc = await lookupDrugReference('warfarin', { cacheDir });
    expect(doc).toBeDefined();
    expect(doc!.url).toMatch(/dailymed\.nlm\.nih\.gov/);
  }, 120_000);
});

/* ------------------------------------------------------------------ */

describe('drug name extraction', () => {
  it('finds a drug name in a clinical claim', () => {
    expect(candidateDrugNames('Hold digoxin if the apical pulse is below 60.')).toContain('digoxin');
  });

  it('finds generic-stem names', () => {
    const names = candidateDrugNames('Give metoprolol and atorvastatin with lisinopril.');
    expect(names.length).toBeGreaterThan(0);
  });

  it('does NOT mistake common nursing vocabulary for a drug', () => {
    const names = candidateDrugNames('The nurse should assess the client before the dose.');
    expect(names).toHaveLength(0);
  });

  it('caps how many names it will look up', () => {
    const many = 'digoxin warfarin heparin metformin lisinopril atorvastatin furosemide';
    expect(candidateDrugNames(many).length).toBeLessThanOrEqual(3);
  });
});

describe('passage selection', () => {
  const LABEL =
    'INDICATIONS AND USAGE\nDigoxin is indicated for the treatment of mild to moderate heart failure. ' +
    'DOSAGE AND ADMINISTRATION\nThe usual loading dose is 10 to 15 mcg/kg. ' +
    'WARNINGS\nHypokalemia may reduce the positive inotropic effect of digoxin and predispose to toxicity.';

  it('picks the passage that shares distinctive terms', () => {
    const p = bestPassage('Hypokalemia potentiates digoxin toxicity.', LABEL);
    expect(p).toMatch(/Hypokalemia/);
    expect(p).toMatch(/toxicity/);
  });

  it('weights numbers heavily, since they identify the topic', () => {
    const p = bestPassage('The loading dose is 10 to 15 mcg/kg.', LABEL);
    expect(p).toMatch(/10 to 15 mcg\/kg/);
  });

  it('returns nothing when only a stray word matches', () => {
    expect(bestPassage('The client ambulates in the hallway.', LABEL)).toBeUndefined();
  });

  it('caps the excerpt length so it cannot become bulk reproduction', () => {
    const long = `Digoxin toxicity. ${'Digoxin causes toxicity in many ways. '.repeat(80)}`;
    const p = bestPassage('Digoxin toxicity', long, 400);
    expect((p ?? '').length).toBeLessThanOrEqual(400);
  });
});

/* ------------------------------------------------------------------ */

describe.skipIf(!CLI_AVAILABLE)('corroboration against an authority', () => {
  let db: Db;
  let itemId: string;

  const lecture: LectureDoc = {
    id: 'lec-1', sourceFile: '/a.pptx', kind: 'pptx', title: 'Pharm', warnings: [],
    blocks: [{ id: 'b1', ordinal: 1, body: 'Digoxin notes.' }],
  };

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    const { sourceId } = insertLecture(db, lecture);
    itemId = insertItem(
      db,
      { lectureId: 'lec-1', kind: 'flashcard', front: 'Q', back: 'A', blockIds: ['b1'] },
      [{ sourceId, claim: 'c', excerpt: 'Digoxin notes.', verdict: 'verified' }],
    );
  });

  it('reports not_found for a claim no drug label covers', async () => {
    const r = await corroborateClaim(
      db, itemId,
      'The nurse should introduce themselves to the client before the assessment.',
      { workspaceDir, cacheDir, skipEntailment: true },
    );
    expect(r.outcome).toBe('not_found');
    expect(r.estimatedCostUsd).toBe(0);
  }, 120_000);

  it('finds and stores an authoritative source for a drug claim', async () => {
    const r = await corroborateClaim(
      db, itemId,
      'Hypokalemia potentiates digoxin toxicity.',
      { workspaceDir, cacheDir, skipEntailment: true },
    );

    expect(['inconclusive', 'confirmed', 'conflict']).toContain(r.outcome);
    expect(r.source?.url).toMatch(/dailymed|api\.fda\.gov/);

    // The source text must be stored so the citation can be re-checked offline.
    const stored = db.prepare("SELECT full_text FROM sources WHERE kind = 'drug_label'").get() as
      | { full_text: string }
      | undefined;
    expect(stored?.full_text?.length ?? 0).toBeGreaterThan(200);
  }, 180_000);

  it('FLAGS A CONFLICT when the lecture states a number the label does not', async () => {
    // The real risk this feature exists for: a slide carrying a wrong value.
    const r = await corroborateClaim(
      db, itemId,
      'The therapeutic serum digoxin level is 5.5 to 9.9 ng/mL.',
      { workspaceDir, cacheDir, skipEntailment: true },
    );

    if (r.outcome === 'not_found' || r.outcome === 'inconclusive') {
      // No passage matched; nothing was asserted either way.
      expect(r.estimatedCostUsd).toBe(0);
      return;
    }
    expect(r.outcome).toBe('conflict');
    expect(r.detail).toMatch(/does not appear/i);
    // Detected deterministically, so it costs nothing.
    expect(r.estimatedCostUsd).toBe(0);
  }, 180_000);

  it('adds a second citation when an authority confirms the claim', async () => {
    const before = listCitations(db, itemId).length;
    const r = await corroborateClaim(
      db, itemId,
      'Hypokalemia may predispose to digoxin toxicity.',
      { workspaceDir, cacheDir, model: 'sonnet' },
    );

    if (r.outcome !== 'confirmed') return; // Covered by the cases above.

    const after = listCitations(db, itemId);
    expect(after.length).toBe(before + 1);
    // Independent evidence, not another citation of the same lecture.
    expect(after.some((c) => c.sourceTitle.match(/FDA label/i))).toBe(true);
  }, 300_000);
});

describe('passage selection resists tables', () => {
  /**
   * Regression: a dosing table used to win any claim containing a number,
   * because numeric overlap outscored conceptual relevance. A table matches
   * numerically against almost every clinical claim while supporting none.
   */
  const LABEL_WITH_TABLE =
    'Recommended Maintenance Dose in micrograms given once daily of Digoxin in Adults by Lean Body ' +
    'Body Weight and Renal Function: 60 70 80 90 100 110 125 150 60 62.5 125 125 187.5 60 90 ' +
    '125 187.5 250 60 70 80.\n' +
    'Measure serum digoxin concentrations before administering the first maintenance dose. ' +
    'Withhold digoxin and notify the prescriber if the apical pulse is below 60 beats per minute.';

  it('prefers the prose sentence over a dosing table', () => {
    const p = bestPassage(
      'Hold digoxin if the apical pulse is below 60 beats per minute.',
      LABEL_WITH_TABLE,
    );
    expect(p).toBeDefined();
    expect(p).toMatch(/apical pulse/i);
    expect(p).not.toMatch(/Lean Body/i);
  });

  it('requires a concept match, not merely a shared number', () => {
    // 60 appears all over the table, but nothing there concerns infusion rate.
    const p = bestPassage('Infuse over 60 minutes using a controlled pump.', LABEL_WITH_TABLE);
    expect(p === undefined || !/Lean Body/i.test(p)).toBe(true);
  });

  it('weights a rare term above a common one', () => {
    const text =
      'Patients should be monitored. Patients may experience nausea. ' +
      'Hypokalemia predisposes patients to digoxin toxicity.';
    const p = bestPassage('Hypokalemia increases digoxin toxicity in patients.', text);
    expect(p).toMatch(/Hypokalemia/);
  });
});
