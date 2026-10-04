/**
 * Generates study content from real lecture decks and audits every item.
 *
 * This is the acceptance check: not "did it produce cards" but "is every card
 * traceable to text that actually exists in the deck, and does the cited text
 * actually support it". Each surviving item is re-verified here independently
 * of the pipeline, so a bug in the pipeline's own checking would still show up.
 *
 * Usage: npm run validate:real -- <file.pptx>...
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPptx } from '../src/core/ingest/pptx.js';
import { openDb } from '../src/core/db/index.js';
import { insertLecture, listPending, listCitations, listItemBlocks } from '../src/core/db/repo.js';
import { generateForLecture } from '../src/core/generate/pipeline.js';
import { slideText } from '../src/core/generate/prompts.js';
import { verifyVerbatim, verifyNumericAgreement } from '../src/core/validate/citation.js';
import { checkEntailment } from '../src/core/validate/entailment.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx scripts/validate-real.ts <file.pptx>...');
  process.exit(1);
}

const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-validate-'));
const db = openDb({ path: ':memory:' });

/** Audit outcome for one stored item. */
interface Audit {
  deck: string;
  kind: string;
  front: string;
  back: string;
  slide: number;
  excerpt: string;
  /** What the citation is asked to support. For NCLEX this is the keyFact. */
  claim: string;
  verbatimOk: boolean;
  numericOk: boolean;
  entailment?: string;
  entailmentWhy?: string;
}

const audits: Audit[] = [];
let totalAccepted = 0;
let totalRejected = 0;
let cost = 0;

for (const file of files) {
  const name = file.split(/[\\/]/).pop() ?? file;
  console.log(`\n### ${name}`);

  const doc = await ingestPptx(file);
  const { sourceId } = insertLecture(db, doc);
  console.log(`  ${doc.blocks.length} slides, ${doc.blocks.filter((b) => b.speakerNotes).length} with notes`);

  const report = await generateForLecture(db, doc, sourceId, {
    kinds: ['flashcard', 'nclex'],
    workspaceDir,
    model: 'sonnet',
    maxBudgetUsd: 8,
    onProgress: (p) => {
      if (p.phase === 'generating') process.stdout.write(`  ${p.kind} batch ${p.batch}/${p.totalBatches}\r`);
    },
  });

  totalAccepted += report.accepted;
  totalRejected += report.rejected.length;
  cost += report.estimatedCostUsd;
  console.log(`  accepted ${report.accepted}, rejected ${report.rejected.length}            `);
  for (const e of report.errors) console.log(`  ERROR: ${e}`);

  // Rejections are the gate working, so show why rather than only counting.
  const byStage = new Map<string, number>();
  for (const r of report.rejected) byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + 1);
  if (byStage.size > 0) {
    const summary = [...byStage].map(([stage, n]) => `${stage} ${n}`).join(', ');
    console.log(`  rejected by stage: ${summary}`);
    for (const r of report.rejected.slice(0, 4)) {
      console.log(`    [${r.stage}] ${r.front.slice(0, 95)}`);
      console.log(`        ${r.reason.slice(0, 150)}`);
    }
  }

  // Independent re-verification of everything that survived.
  const byOrdinal = new Map(doc.blocks.map((b) => [b.ordinal, b]));
  for (const item of listPending(db, doc.id)) {
    for (const c of listCitations(db, item.id)) {
      const blocks = listItemBlocks(db, item.id);
      const ordinal = blocks[0]?.ordinal ?? 0;
      const block = byOrdinal.get(ordinal);
      // The SAME function the generator and the pipeline use. Rebuilding slide
      // text here instead once reported six legitimate table citations as
      // fabricated -- an artefact of this script, not of the generator.
      const text = block ? slideText(block) : '';

      audits.push({
        deck: name,
        kind: item.kind,
        front: item.front,
        back: item.back,
        slide: ordinal,
        excerpt: c.excerpt,
        claim: c.claim,
        verbatimOk: verifyVerbatim(c.excerpt, text).ok,
        numericOk: verifyNumericAgreement(
          item.kind === 'nclex' ? item.back : `${item.front} ${item.back}`,
          c.excerpt,
        ).ok,
      });
    }
  }
}

/* ---------------------- deterministic audit ---------------------- */

console.log(`\n${'='.repeat(78)}`);
console.log('DETERMINISTIC AUDIT');
console.log('='.repeat(78));

const badQuote = audits.filter((a) => !a.verbatimOk);
const badNumber = audits.filter((a) => !a.numericOk);

console.log(`items audited            : ${audits.length}`);
console.log(`quote NOT in the deck    : ${badQuote.length}`);
console.log(`asserts absent numbers   : ${badNumber.length}`);

for (const a of badQuote.slice(0, 5)) {
  console.log(`\n  FABRICATED QUOTE [${a.deck} slide ${a.slide}]`);
  console.log(`    card : ${a.front}`);
  console.log(`    quote: "${a.excerpt.slice(0, 150)}"`);
}
for (const a of badNumber.slice(0, 5)) {
  console.log(`\n  UNSUPPORTED NUMBER [${a.deck} slide ${a.slide}]`);
  console.log(`    card : ${a.front} => ${a.back}`);
  console.log(`    quote: "${a.excerpt.slice(0, 150)}"`);
}

/* ------------------- adversarial entailment audit ------------------- */

// Sampled rather than exhaustive: each check is a model call, and a random
// sample is enough to detect a systemic problem.
const SAMPLE = Math.min(14, audits.length);
const sample = [...audits].sort(() => Math.random() - 0.5).slice(0, SAMPLE);

console.log(`\n${'='.repeat(78)}`);
console.log(`ADVERSARIAL AUDIT (${SAMPLE} sampled, judged against the quote alone)`);
console.log('='.repeat(78));

let supports = 0;
for (const a of sample) {
  const claim = a.claim;
  const r = await checkEntailment(claim, a.excerpt, { workspaceDir, model: 'sonnet' });
  a.entailment = r.verdict;
  a.entailmentWhy = r.reason;
  cost += r.estimatedCostUsd;
  if (r.verdict === 'supports') supports += 1;
  else {
    console.log(`\n  ${r.verdict.toUpperCase()} [${a.deck} slide ${a.slide}]`);
    console.log(`    card : ${a.front.slice(0, 120)}`);
    console.log(`    => ${a.back.slice(0, 120)}`);
    console.log(`    quote: "${a.excerpt.slice(0, 180)}"`);
    console.log(`    why  : ${r.reason.slice(0, 220)}`);
  }
}

console.log(`\nsupported by their own citation: ${supports}/${SAMPLE}`);

/* ------------------------------ sample ------------------------------ */

console.log(`\n${'='.repeat(78)}`);
console.log('SAMPLE OF WHAT WAS PRODUCED');
console.log('='.repeat(78));
for (const a of audits.filter((x) => x.kind === 'flashcard').slice(0, 8)) {
  console.log(`\n[${a.deck} slide ${a.slide}]`);
  console.log(`  Q: ${a.front}`);
  console.log(`  A: ${a.back}`);
  console.log(`  cited: "${a.excerpt.slice(0, 160)}"`);
}

console.log(`\n${'='.repeat(78)}`);
console.log(`TOTAL accepted ${totalAccepted}, rejected ${totalRejected}, est. $${cost.toFixed(3)}`);
