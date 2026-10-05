/**
 * The whole pipeline on a real deck, measured end to end.
 *
 * Earlier validation scripts skipped two things that now matter: slide pictures
 * are never read, and the entailment audit ran without citation repair. So the
 * numbers they produced no longer describe what the app actually does.
 *
 * This runs the real path -- ingest, transcribe pictures, generate, then bulk
 * verify exactly as the Check-all button does -- and then audits the survivors
 * INDEPENDENTLY of the pipeline, so a bug in the pipeline's own checking still
 * shows up here.
 *
 * Usage: tsx scripts/validate-full.ts <file.pptx>...
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPptx } from '../src/core/ingest/pptx.js';
import { transcribeDiagrams } from '../src/core/ingest/diagram.js';
import { openDb } from '../src/core/db/index.js';
import {
  insertLecture, listPending, listStudiable, listCitations, listItemBlocks,
  listUnsourced, setItemStatus,
} from '../src/core/db/repo.js';
import { generateForLecture } from '../src/core/generate/pipeline.js';
import { verifyPendingItems } from '../src/core/validate/batch.js';
import { slideText } from '../src/core/generate/prompts.js';
import { verifyVerbatim, verifyNumericAgreement } from '../src/core/validate/citation.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx scripts/validate-full.ts <file.pptx>...');
  process.exit(1);
}

const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-full-'));
const mediaOutDir = await mkdtemp(join(tmpdir(), 'nursedeck-full-media-'));

let grandCost = 0;
const problems: string[] = [];

for (const file of files) {
  const name = file.split(/[\\/]/).pop()!;
  console.log(`\n${'='.repeat(74)}\n### ${name}`);

  const db = openDb({ path: ':memory:' });
  const doc = await ingestPptx(file, { mediaOutDir });

  const imageOnly = doc.blocks.filter(
    (b) =>
      (b.imageRefs?.length ?? 0) > 0 &&
      [b.heading, b.body, (b.speakerNotes ?? '').replace(/^\s*\d+\s*$/gm, '')]
        .filter(Boolean).join(' ').trim().length < 25,
  ).length;

  const diagrams = await transcribeDiagrams(doc, { workspaceDir, model: 'sonnet' });
  doc.blocks = diagrams.blocks;
  grandCost += diagrams.estimatedCostUsd;
  console.log(
    `  ${doc.blocks.length} slides, ${imageOnly} text-free; ` +
    `${diagrams.transcribed} pictures read ($${diagrams.estimatedCostUsd.toFixed(3)})`,
  );

  const { sourceId } = insertLecture(db, doc);
  const gen = await generateForLecture(db, doc, sourceId, {
    kinds: ['flashcard', 'nclex'], workspaceDir, model: 'sonnet', maxBudgetUsd: 8,
  });
  grandCost += gen.estimatedCostUsd;
  console.log(`  generated ${gen.accepted}, rejected ${gen.rejected.length} by the cheap checks`);

  // Exactly what the Check-all button does.
  const verify = await verifyPendingItems(db, {
    lectureId: doc.id, workspaceDir, model: 'sonnet', maxBudgetUsd: 10,
  });
  grandCost += verify.estimatedCostUsd;
  console.log(
    `  verified ${verify.verified} of ${verify.checked} ` +
    `(${Math.round((verify.verified / Math.max(1, verify.checked)) * 100)}% yield, ` +
    `$${verify.estimatedCostUsd.toFixed(3)})`,
  );
  for (const e of verify.errors.slice(0, 3)) console.log(`    error: ${e}`);

  // Accept everything so the studiable gate is exercised on real data.
  for (const item of listPending(db, doc.id)) setItemStatus(db, item.id, 'accepted');

  const studiable = listStudiable(db, { lectureId: doc.id });
  console.log(`  studiable after triage: ${studiable.length}`);

  /* ------------------ independent audit of what survived ------------------ */

  const byOrdinal = new Map(doc.blocks.map((b) => [b.ordinal, b]));
  let badQuote = 0;
  let badNumber = 0;

  for (const item of studiable) {
    const ordinal = listItemBlocks(db, item.id)[0]?.ordinal ?? 0;
    const block = byOrdinal.get(ordinal);
    const text = block ? slideText(block) : '';

    for (const c of listCitations(db, item.id).filter((x) => x.verdict === 'verified')) {
      if (!verifyVerbatim(c.excerpt, text).ok) {
        badQuote++;
        problems.push(`${name} slide ${ordinal}: quote not on slide -- "${c.excerpt.slice(0, 80)}"`);
      }
      const claim = item.kind === 'nclex' ? item.back : `${item.front} ${item.back}`;
      if (!verifyNumericAgreement(claim, c.excerpt).ok) {
        badNumber++;
        problems.push(`${name} slide ${ordinal}: numbers absent -- ${item.front.slice(0, 70)}`);
      }
    }
  }

  const orphans = listUnsourced(db);
  console.log(`  AUDIT: ${badQuote} fabricated quotes, ${badNumber} unsupported numbers, ${orphans.length} unsourced`);
  if (orphans.length > 0) {
    problems.push(`${name}: ${orphans.length} accepted items have no usable citation`);
  }

  for (const s of studiable.slice(0, 2)) {
    const [c] = listCitations(db, s.id).filter((x) => x.verdict === 'verified');
    console.log(`\n    Q: ${s.front.slice(0, 100)}`);
    console.log(`    A: ${s.back.slice(0, 100)}`);
    console.log(`    cited: "${(c?.excerpt ?? '').slice(0, 130)}"`);
  }
}

console.log(`\n${'='.repeat(74)}`);
if (problems.length === 0) {
  console.log(`NO INTEGRITY PROBLEMS across ${files.length} decks.`);
} else {
  console.log(`${problems.length} INTEGRITY PROBLEMS:`);
  for (const p of problems) console.log(`  ${p}`);
}
console.log(`total est. $${grandCost.toFixed(2)}`);
