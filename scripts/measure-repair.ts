/**
 * Does citation repair recover cards, and does it ever launder a bad one?
 *
 * Runs the SAME items through the gate twice -- repair off, then on -- so the
 * difference is attributable. Every recovered card is then re-checked
 * independently: its final quote must be verbatim on its slide, and must
 * actually carry every number the card asserts.
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
import { verifyClaim } from '../src/core/validate/entailment.js';

const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-repair-'));
let baseOk = 0, repairOk = 0, recovered = 0, cost = 0;
// Recovery splits two ways and the difference matters: a widened quote is the
// repair working, while an unchanged quote that passes on a second ask is just
// auditor variance and must not be credited to this feature.
let byWidening = 0, byVariance = 0;
const recoveredCards: { front: string; before: string; after: string; slide: number }[] = [];
const violations: string[] = [];

for (const file of process.argv.slice(2)) {
  const name = file.split(/[\/]/).pop()!;
  const db = openDb({ path: ':memory:' });
  const doc = await ingestPptx(file);
  const { sourceId } = insertLecture(db, doc);

  const report = await generateForLecture(db, doc, sourceId, {
    kinds: ['flashcard'], workspaceDir, model: 'sonnet', maxBudgetUsd: 6,
  });
  cost += report.estimatedCostUsd;
  console.log(`\n### ${name}: ${report.accepted} accepted`);

  const byOrdinal = new Map(doc.blocks.map((b) => [b.ordinal, b]));
  const items = listPending(db, doc.id);

  for (const item of items) {
    const [c] = listCitations(db, item.id);
    if (!c) continue;
    const ordinal = listItemBlocks(db, item.id)[0]?.ordinal ?? 0;
    const block = byOrdinal.get(ordinal);
    if (!block) continue;
    const text = slideText(block);
    const claim = c.claim;

    const off = await verifyClaim(
      { claim, excerpt: c.excerpt, sourceText: text, tier: 'A' },
      { workspaceDir, model: 'sonnet', allowRepair: false },
    );
    cost += off.estimatedCostUsd;
    if (off.ok) { baseOk++; repairOk++; continue; }

    const on = await verifyClaim(
      { claim, excerpt: c.excerpt, sourceText: text, tier: 'A' },
      { workspaceDir, model: 'sonnet', allowRepair: true },
    );
    cost += on.estimatedCostUsd;
    if (!on.ok) continue;

    repairOk++;
    recovered++;
    const final = on.repairedExcerpt ?? c.excerpt;
    if (on.repairedExcerpt) byWidening++; else byVariance++;

    // Independent re-check of anything repair rescued.
    if (!verifyVerbatim(final, text).ok) {
      violations.push(`NOT ON SLIDE ${ordinal}: "${final.slice(0, 90)}"`);
    }
    if (!verifyNumericAgreement(`${item.front} ${item.back}`, final).ok) {
      violations.push(`NUMBERS NOT IN QUOTE, slide ${ordinal}: ${item.front.slice(0, 70)}`);
    }
    if (recoveredCards.length < 5) {
      recoveredCards.push({ front: item.front, before: c.excerpt, after: final, slide: ordinal });
    }
  }
}

console.log(`\n${'='.repeat(74)}`);
console.log(`verified WITHOUT repair : ${baseOk}`);
console.log(`verified WITH repair    : ${repairOk}  (+${recovered})`);
console.log(`  of which widened quote : ${byWidening}`);
console.log(`  of which audit variance: ${byVariance}`);
console.log(`integrity violations    : ${violations.length}`);
for (const v of violations) console.log(`  ${v}`);

for (const r of recoveredCards) {
  console.log(`\n--- recovered [slide ${r.slide}] ${r.front.slice(0, 80)}`);
  console.log(`    was : "${r.before.slice(0, 110)}"`);
  console.log(`    now : "${r.after.slice(0, 190)}"`);
}
console.log(`\nest. $${cost.toFixed(3)}`);
