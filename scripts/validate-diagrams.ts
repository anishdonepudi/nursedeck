/**
 * Does reading the slide pictures actually produce verifiable study material
 * from slides that previously produced nothing?
 *
 * Usage: tsx scripts/validate-diagrams.ts <file.pptx>
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPptx } from '../src/core/ingest/pptx.js';
import { transcribeDiagrams } from '../src/core/ingest/diagram.js';
import { openDb } from '../src/core/db/index.js';
import { insertLecture, listPending, listCitations, listItemBlocks } from '../src/core/db/repo.js';
import { generateForLecture } from '../src/core/generate/pipeline.js';
import { slideText } from '../src/core/generate/prompts.js';
import { verifyVerbatim } from '../src/core/validate/citation.js';
import { checkEntailment } from '../src/core/validate/entailment.js';

const file = process.argv[2]!;
const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-diag-'));
const mediaOutDir = await mkdtemp(join(tmpdir(), 'nursedeck-media-'));

const doc = await ingestPptx(file, { mediaOutDir });
const ownText = (b: typeof doc.blocks[number]) =>
  [b.heading, b.body, (b.speakerNotes ?? '').replace(/^\s*\d+\s*$/gm, '')]
    .filter(Boolean).join(' ').trim().length;

const imageOnly = new Set(
  doc.blocks.filter((b) => (b.imageRefs?.length ?? 0) > 0 && ownText(b) < 25).map((b) => b.ordinal),
);
console.log(`${doc.blocks.length} slides, ${imageOnly.size} with no text of their own`);

const r = await transcribeDiagrams(doc, { workspaceDir, model: 'sonnet' });
doc.blocks = r.blocks;
console.log(`transcribed ${r.transcribed}, decorative ${r.decorative}, $${r.estimatedCostUsd.toFixed(3)}`);
for (const w of r.warnings.slice(0, 5)) console.log(`  warn: ${w}`);

const recovered = doc.blocks.filter((b) => imageOnly.has(b.ordinal) && b.imageText);
console.log(`\nslides recovered: ${recovered.length}/${imageOnly.size}`);
for (const b of recovered.slice(0, 3)) {
  console.log(`\n--- slide ${b.ordinal} now reads:`);
  console.log(b.imageText!.split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'));
}

const db = openDb({ path: ':memory:' });
const { sourceId } = insertLecture(db, doc);
const report = await generateForLecture(db, doc, sourceId, {
  kinds: ['flashcard'], workspaceDir, model: 'sonnet', maxBudgetUsd: 6,
});
console.log(`\naccepted ${report.accepted}, rejected ${report.rejected.length}`);

// The question that matters: are cards from image-only slides verifiable?
const byOrdinal = new Map(doc.blocks.map((b) => [b.ordinal, b]));
let fromImages = 0, quoteOk = 0;
const sample: { front: string; back: string; excerpt: string; claim: string; slide: number }[] = [];

for (const item of listPending(db, doc.id)) {
  const ordinal = listItemBlocks(db, item.id)[0]?.ordinal ?? 0;
  if (!imageOnly.has(ordinal)) continue;
  for (const c of listCitations(db, item.id)) {
    fromImages++;
    if (verifyVerbatim(c.excerpt, slideText(byOrdinal.get(ordinal)!)).ok) quoteOk++;
    if (sample.length < 6) {
      sample.push({ front: item.front, back: item.back, excerpt: c.excerpt, claim: c.claim, slide: ordinal });
    }
  }
}

console.log(`\ncards from previously-empty slides: ${fromImages}`);
console.log(`whose quote is genuinely in the transcript: ${quoteOk}/${fromImages}`);

let supported = 0;
for (const s of sample) {
  const v = await checkEntailment(s.claim, s.excerpt, { workspaceDir, model: 'sonnet' });
  if (v.verdict === 'supports') supported++;
  console.log(`\n[slide ${s.slide}] ${v.verdict.toUpperCase()}`);
  console.log(`  Q: ${s.front}`);
  console.log(`  A: ${s.back}`);
  console.log(`  cited: "${s.excerpt.slice(0, 140)}"`);
  if (v.verdict !== 'supports') console.log(`  why: ${v.reason.slice(0, 180)}`);
}
console.log(`\nsupported by their own citation: ${supported}/${sample.length}`);
