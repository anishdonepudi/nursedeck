/**
 * Generates study material from a sample lecture and prints it with citations,
 * so the output can be inspected rather than only asserted about.
 *
 * Usage:  npm run demo
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db/index.js';
import { insertLecture, listPending, listCitations, listItemBlocks } from '../src/core/db/repo.js';
import { generateForLecture } from '../src/core/generate/pipeline.js';

const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-demo-'));

const lecture = {
  id: 'demo-lecture',
  sourceFile: 'Cardiac Pharmacology Week 5.pptx',
  kind: 'pptx',
  title: 'Cardiac Pharmacology — Week 5',
  warnings: [],
  blocks: [
    {
      id: 'b1', ordinal: 1, heading: 'Digoxin',
      body:
        'Digoxin increases myocardial contractility and slows conduction through the AV node.\n' +
        'The therapeutic serum digoxin level is 0.5-2.0 ng/mL.\n' +
        'Assess the apical pulse for one full minute before each dose.\n' +
        'Hold the dose and notify the primary health care provider if the apical pulse is below 60 beats per minute.',
      speakerNotes:
        'Early signs of digoxin toxicity are anorexia, nausea, vomiting and visual disturbances such as ' +
        'yellow-green halos. Hypokalemia potentiates digoxin toxicity, so monitor serum potassium closely.',
    },
    {
      id: 'b2', ordinal: 2, heading: 'Warfarin',
      body:
        'Warfarin inhibits vitamin K dependent clotting factors II, VII, IX and X.\n' +
        'Monitor warfarin therapy using the INR.\n' +
        'The therapeutic INR range for most indications is 2.0-3.0.\n' +
        'Vitamin K (phytonadione) is the antidote for warfarin.',
      speakerNotes:
        'Teach the client to keep green leafy vegetable intake consistent rather than avoiding it entirely, ' +
        'because sudden changes in vitamin K intake destabilise the INR.',
    },
    {
      id: 'b3', ordinal: 3, heading: 'Heparin',
      body:
        'Heparin potentiates antithrombin III and is monitored with the aPTT.\n' +
        'The therapeutic aPTT is 1.5 to 2.5 times the control value.\n' +
        'Protamine sulfate is the antidote for heparin.\n' +
        'Heparin-induced thrombocytopenia is a serious adverse effect requiring immediate discontinuation.',
    },
  ],
};

const db = openDb({ path: ':memory:' });
const { sourceId } = insertLecture(db, lecture);

console.log(`Generating from "${lecture.title}" (${lecture.blocks.length} slides)...\n`);

const report = await generateForLecture(db, lecture, sourceId, {
  kinds: ['flashcard', 'cloze', 'nclex'],
  workspaceDir,
  model: 'sonnet',
  maxBudgetUsd: 5,
  onProgress: (p) => {
    if (p.phase === 'generating') {
      process.stdout.write(`  ${p.kind}: batch ${p.batch}/${p.totalBatches}\n`);
    }
  },
});

const items = listPending(db, lecture.id);

console.log(`\n${'='.repeat(78)}`);
console.log(`ACCEPTED: ${report.accepted}   REJECTED: ${report.rejected.length}   ` +
  `est. cost $${report.estimatedCostUsd.toFixed(4)}`);
console.log('='.repeat(78));

for (const kind of ['flashcard', 'cloze', 'nclex']) {
  const group = items.filter((i) => i.kind === kind);
  if (group.length === 0) continue;
  console.log(`\n\n######## ${kind.toUpperCase()} (${group.length}) ########`);

  for (const item of group) {
    const cites = listCitations(db, item.id);
    const blocks = listItemBlocks(db, item.id);
    console.log(`\n--- ${item.front}`);

    if (kind === 'nclex' && item.payload?.options) {
      for (const o of item.payload.options) {
        console.log(`    ${o.isKey ? '[*]' : '[ ]'} ${o.text}`);
        console.log(`        ${o.rationale}${o.errorClass ? `  (${o.errorClass})` : ''}`);
      }
      console.log(`    tags: ${item.clientNeed ?? '-'}`);
    } else {
      console.log(`    => ${item.back}`);
    }

    for (const c of cites) {
      console.log(`    CITED slide ${blocks.map((b) => b.ordinal).join(',')}: "${c.excerpt}"`);
    }
  }
}

if (report.rejected.length > 0) {
  console.log(`\n\n######## REJECTED (${report.rejected.length}) ########`);
  for (const r of report.rejected) {
    console.log(`\n--- [${r.stage}] ${r.front.slice(0, 90)}`);
    console.log(`    ${r.reason}`);
  }
}

if (report.errors.length > 0) {
  console.log('\nERRORS:');
  for (const e of report.errors) console.log(`  ${e}`);
}
