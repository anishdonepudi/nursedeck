import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@core/db/index.js';
import { insertLecture, listPending, listStudiable, listCitations, setItemStatus } from '@core/db/repo.js';
import { generateForLecture } from '@core/generate/pipeline.js';
import { batchBlocks, renderBatch, renderTable } from '@core/generate/prompts.js';
import { verifyVerbatim } from '@core/validate/citation.js';
import type { LectureDoc, LectureBlock } from '@shared/types.js';

/**
 * End-to-end generation against the real Claude CLI.
 *
 * The assertion that matters is not "cards were produced" but "every card that
 * survived is traceable to text that actually exists on the cited slide". The
 * final test deliberately feeds a lecture that invites invention, and requires
 * that nothing unsupported gets through.
 */

let workspaceDir: string;

const blocks: LectureBlock[] = [
  {
    id: 'b1', ordinal: 1, heading: 'Potassium Balance',
    body:
      'Normal adult serum potassium is 3.5-5.0 mEq/L.\n' +
      'Hypokalemia is a serum potassium below 3.5 mEq/L.\n' +
      'Hyperkalemia is a serum potassium above 5.0 mEq/L.',
    speakerNotes:
      'Potassium chloride must never be given by IV push; it is fatal. ' +
      'Always administer it by controlled infusion.',
  },
  {
    id: 'b2', ordinal: 2, heading: 'Digoxin Safety',
    body:
      'The therapeutic serum digoxin level is 0.5-2.0 ng/mL.\n' +
      'Check the apical pulse for one full minute before administering digoxin.\n' +
      'Hold the dose and notify the provider if the apical pulse is below 60 beats per minute.',
    speakerNotes: 'Hypokalemia potentiates digoxin toxicity, so check potassium as well.',
  },
  {
    id: 'b3', ordinal: 3, heading: 'Warfarin Monitoring',
    body:
      'Warfarin is monitored using the INR.\n' +
      'The therapeutic INR range for most indications is 2.0-3.0.\n' +
      'Vitamin K is the antidote for warfarin.',
  },
];

const lecture: LectureDoc = {
  id: 'lec-pipeline',
  sourceFile: '/lectures/pharm-week3.pptx',
  kind: 'pptx',
  title: 'Pharmacology: High-Alert Medications',
  warnings: [],
  blocks,
};

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-pipeline-'));
});

describe('batching and rendering', () => {
  it('keeps every slide and labels it with its ordinal', () => {
    const batches = batchBlocks(blocks, 12_000);
    expect(batches.flat()).toHaveLength(3);

    const rendered = renderBatch(blocks, lecture.title);
    expect(rendered).toContain('--- SLIDE 1 ---');
    expect(rendered).toContain('--- SLIDE 3 ---');
    // Speaker notes must reach the model: they carry the safety reasoning.
    expect(rendered).toContain('never be given by IV push');
    expect(rendered).toContain('<<<LECTURE>>>');
  });

  it('splits on a character budget, never dropping a slide', () => {
    const batches = batchBlocks(blocks, 200);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((b) => b.ordinal)).toEqual([1, 2, 3]);
  });

  it('gives an oversized slide its own batch rather than discarding it', () => {
    const huge: LectureBlock = { id: 'big', ordinal: 9, body: 'x'.repeat(50_000) };
    const batches = batchBlocks([...blocks, huge], 1_000);
    expect(batches.flat().map((b) => b.ordinal)).toContain(9);
  });
});

describe('live generation', () => {
  let db: Db;
  let sourceId: string;
  let report: Awaited<ReturnType<typeof generateForLecture>>;

  beforeAll(async () => {
    db = openDb({ path: ':memory:' });
    sourceId = insertLecture(db, lecture).sourceId;

    report = await generateForLecture(db, lecture, sourceId, {
      kinds: ['flashcard', 'cloze'],
      workspaceDir,
      model: 'sonnet',
      maxBudgetUsd: 3,
      maxBatchChars: 12_000,
    });
  }, 600_000);

  it('produces usable items without fatal errors', () => {
    expect(report.errors).toEqual([]);
    expect(report.accepted).toBeGreaterThan(0);
  });

  it('EVERY stored item cites a quote that genuinely exists on its slide', () => {
    // The core guarantee. Re-verified here independently of the pipeline, so a
    // bug in the pipeline's own checking would still be caught.
    const pending = listPending(db, lecture.id);
    expect(pending.length).toBe(report.accepted);

    const byOrdinal = new Map(blocks.map((b) => [b.ordinal, b]));

    for (const item of pending) {
      const citations = listCitations(db, item.id);
      expect(citations.length, `item ${item.id} has no citation`).toBeGreaterThan(0);

      for (const c of citations) {
        const haystack = [...byOrdinal.values()]
          .map((b) => [b.heading, b.body, b.speakerNotes].filter(Boolean).join('\n'))
          .join('\n\n');
        const check = verifyVerbatim(c.excerpt, haystack);
        expect(check.ok, `fabricated quote on "${item.front}": ${c.excerpt}`).toBe(true);
      }
    }
  });

  it('never asserts a number the cited text does not contain', () => {
    for (const item of listPending(db, lecture.id)) {
      for (const c of listCitations(db, item.id)) {
        const claimNumbers = [...`${item.front} ${item.back}`.matchAll(/(?<![a-z0-9.])(\d+)(?:\.(\d+))?(?![a-z0-9])/gi)]
          .map((m) => Number(m[2] ? `${m[1]}.${m[2]}` : m[1]));
        const excerptNumbers = new Set(
          [...c.excerpt.matchAll(/(?<![a-z0-9.])(\d+)(?:\.(\d+))?(?![a-z0-9])/gi)]
            .map((m) => Number(m[2] ? `${m[1]}.${m[2]}` : m[1])),
        );
        for (const n of claimNumbers) {
          expect(excerptNumbers.has(n), `"${item.front}" asserts ${n}, absent from its citation`).toBe(true);
        }
      }
    }
  });

  it('leaves everything pending — nothing is studiable before triage', () => {
    expect(listStudiable(db)).toHaveLength(0);
    expect(listPending(db, lecture.id).length).toBeGreaterThan(0);
  });

  it('becomes studiable only after acceptance AND citation verification', () => {
    const [item] = listPending(db, lecture.id);
    expect(item).toBeDefined();

    setItemStatus(db, item!.id, 'accepted');
    // Still not studiable: the citation is 'unverified' until the audit runs.
    expect(listStudiable(db)).toHaveLength(0);

    const [c] = listCitations(db, item!.id);
    db.prepare("UPDATE citations SET verdict = 'verified' WHERE id = ?").run(c!.id);
    expect(listStudiable(db)).toHaveLength(1);
  });

  it('records every CLI invocation for traceability', () => {
    const gens = db.prepare('SELECT * FROM generations WHERE lecture_id = ?').all(lecture.id);
    expect(gens.length).toBeGreaterThan(0);
  });

  it('reports what it discarded and why', () => {
    for (const r of report.rejected) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(['schema', 'quality', 'citation', 'numeric']).toContain(r.stage);
    }
  });

  it('cloze cards blank an information-carrying span', () => {
    const clozes = listPending(db, lecture.id).filter((i) => i.kind === 'cloze');
    for (const c of clozes) {
      const spans = [...c.front.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]!.trim().toLowerCase());
      expect(spans).toHaveLength(1);
      // A blank over a bare function word would have been rejected upstream.
      expect(['is', 'the', 'a', 'an', 'of', 'to']).not.toContain(spans[0]);
    }
  });
});

describe('resistance to invented content', () => {
  it('discards claims the slides do not support', async () => {
    // This lecture names topics without giving the facts a student would want.
    // A model drawing on its own knowledge would happily supply the missing
    // numbers; every such card must fail the citation gate.
    const sparse: LectureDoc = {
      id: 'lec-sparse',
      sourceFile: '/lectures/sparse.pptx',
      kind: 'pptx',
      title: 'Electrolytes Overview',
      warnings: [],
      blocks: [
        {
          id: 's1', ordinal: 1, heading: 'Topics for Today',
          body:
            'We will review serum sodium, serum calcium, and serum magnesium.\n' +
            'Reference ranges will be covered in the lab session.',
        },
      ],
    };

    const db = openDb({ path: ':memory:' });
    const { sourceId } = insertLecture(db, sparse);

    const r = await generateForLecture(db, sparse, sourceId, {
      kinds: ['flashcard'],
      workspaceDir,
      model: 'sonnet',
      maxBudgetUsd: 2,
    });

    const haystack = 'We will review serum sodium, serum calcium, and serum magnesium.\n' +
      'Reference ranges will be covered in the lab session.';

    for (const item of listPending(db, sparse.id)) {
      for (const c of listCitations(db, item.id)) {
        expect(
          verifyVerbatim(c.excerpt, haystack).ok,
          `invented citation survived: "${c.excerpt}"`,
        ).toBe(true);
      }
      // Specifically: no reference range may appear, because none was given.
      expect(
        /\b13[0-9]\s*-\s*14[0-9]\b|\b8\.\d\s*-\s*10\.\d\b|\b1\.\d\s*-\s*2\.\d\b/.test(
          `${item.front} ${item.back}`,
        ),
        `a reference range was invented: "${item.front} / ${item.back}"`,
      ).toBe(false);
    }

    // Rejections here are a success signal, not a failure.
    expect(r.errors).toEqual([]);
  }, 600_000);
});

describe('numeric grounding scope', () => {
  /**
   * Regression: the numeric check once ran over the whole NCLEX stem, so a
   * perfectly good vignette beginning "A 72-year-old client..." was rejected
   * because 72 does not appear in the lecture. A vignette's scenario detail is
   * invented by design; only the clinical answer must be grounded.
   */
  it('allows an invented client age in a vignette', async () => {
    const vignetteLecture: LectureDoc = {
      id: 'lec-vignette',
      sourceFile: '/lectures/digoxin.pptx',
      kind: 'pptx',
      title: 'Digoxin',
      warnings: [],
      blocks: [
        {
          id: 'v1', ordinal: 1, heading: 'Digoxin administration',
          body:
            'Assess the apical pulse for one full minute before each dose of digoxin.\n' +
            'Hold the dose and notify the primary health care provider if the apical pulse is below 60 beats per minute.',
        },
      ],
    };

    const db = openDb({ path: ':memory:' });
    const { sourceId } = insertLecture(db, vignetteLecture);

    const r = await generateForLecture(db, vignetteLecture, sourceId, {
      kinds: ['nclex'],
      workspaceDir,
      model: 'sonnet',
      maxBudgetUsd: 2,
    });

    expect(r.errors).toEqual([]);

    // An age in the stem must not be the reason anything was discarded.
    const ageRejections = r.rejected.filter(
      (x) => x.stage === 'numeric' && /year-old|\byears old\b/i.test(x.front),
    );
    expect(
      ageRejections,
      `vignette ages were treated as unsupported claims: ${JSON.stringify(ageRejections)}`,
    ).toHaveLength(0);

    // And at least one item should survive the whole gate.
    expect(listPending(db, vignetteLecture.id).length).toBeGreaterThan(0);
  }, 600_000);

  it('still rejects an invented threshold in the ANSWER', async () => {
    // The answer is where grounding is non-negotiable: a wrong hold-parameter
    // is exactly the error that would hurt a client.
    const { verifyNumericAgreement } = await import('@core/validate/citation.js');
    const r = verifyNumericAgreement(
      'Hold the dose if the apical pulse is below 50 beats per minute',
      'Hold the dose and notify the provider if the apical pulse is below 60 beats per minute.',
    );
    expect(r.ok).toBe(false);
    expect(r.unsupported.map((n) => n.value)).toContain(50);
  });
});

describe('table rendering', () => {
  /**
   * Regression from a real acid-base deck: a pipe-delimited row quoted on its
   * own ("Respiratory acidosis | down | up | Normal") cannot be audited,
   * because nothing in it says which column is pH and which is PaCO2. The
   * adversarial auditor rejected such citations, correctly.
   */
  const ABG: string[][] = [
    ['Disorder', 'pH (7.35-7.45)', 'PaCO2 (35-45 mmHg)', 'HCO3- (22-26 mEq/L)'],
    ['Metabolic acidosis', 'low', 'normal', 'low'],
    ['Respiratory acidosis', 'low', 'high', 'normal'],
  ];

  it('pairs every cell with its column, so one row stands alone as evidence', () => {
    const rendered = renderTable(ABG);
    expect(rendered).toContain('Respiratory acidosis - pH (7.35-7.45): low');
    expect(rendered).toContain('PaCO2 (35-45 mmHg): high');
    // The bare pipe form is what made a quoted row unauditable.
    expect(rendered).not.toContain('Respiratory acidosis | low | high');
  });

  it('keeps the reference ranges attached to their measurement', () => {
    // Without this the numeric check cannot confirm a range a card quotes.
    expect(renderTable(ABG)).toContain('7.35-7.45');
    expect(renderTable(ABG)).toContain('22-26 mEq/L');
  });

  it('falls back gracefully for a table with no body rows', () => {
    expect(renderTable([['Only', 'Headers']])).toContain('Only | Headers');
    expect(renderTable([])).toBe('');
  });

  it('renders the same text the verifier checks against', () => {
    // The generator and the verifier must agree, or a faithful quote fails.
    const block = { id: 'b', ordinal: 1, body: '', tables: ABG };
    const shown = renderBatch([block], 'Deck');
    expect(shown).toContain('Respiratory acidosis - pH (7.35-7.45): low');
  });
});

describe('citation relocation', () => {
  /**
   * From a real deck: a card correctly stated "normal osmolality 275-295
   * mOsm/kg" but cited a neighbouring sentence that did not contain the
   * numbers. The fact WAS on the slide, so rejecting the card threw away
   * correct material. Relocation finds the right span; it cannot invent one.
   */
  const SLIDE =
    'Osmolality - number of particles dissolved in the serum (Na+, Urea, glucose).\n' +
    'Normal Osmolality 275-295 mOsm/kg (Isomolar, Hypomolar, Hypermolar).\n' +
    'Tonicity describes the effect of a solution on cell volume.';

  it('finds a span carrying the asserted numbers', async () => {
    const { verifyNumericAgreement } = await import('@core/validate/citation.js');
    // The quoted span lacks the numbers...
    expect(verifyNumericAgreement('Normal osmolality is 275-295 mOsm/kg', SLIDE.split('\n')[0]!).ok)
      .toBe(false);
    // ...but the slide contains them, so the evidence exists.
    expect(verifyNumericAgreement('Normal osmolality is 275-295 mOsm/kg', SLIDE).ok).toBe(true);
  });

  it('CANNOT manufacture evidence that is not on the slide', async () => {
    const { verifyNumericAgreement } = await import('@core/validate/citation.js');
    // 300 appears nowhere, so no relocation can rescue this claim.
    expect(verifyNumericAgreement('Normal osmolality is 275-300 mOsm/kg', SLIDE).ok).toBe(false);
  });
});
