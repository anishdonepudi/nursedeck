/**
 * Demonstrates corroboration against an authoritative source.
 *
 * The lecture here deliberately contains one WRONG value, of the kind that
 * really does end up on a slide that was copied forward a few years. The run
 * shows the card passing verification against the lecture (the slide does say
 * it) and then being flagged when checked against the FDA label.
 *
 * Usage: npm run demo:corroborate
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db/index.js';
import { insertLecture, listPending, listCitations } from '../src/core/db/repo.js';
import { generateForLecture } from '../src/core/generate/pipeline.js';
import { corroborateClaim } from '../src/core/sources/corroborate.js';
import type { LectureDoc } from '../src/shared/types.js';

const workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-corr-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'nursedeck-corr-cache-'));

const lecture: LectureDoc = {
  id: 'demo-corroborate',
  sourceFile: 'Cardiac Pharmacology.pptx',
  kind: 'pptx',
  title: 'Cardiac Pharmacology',
  warnings: [],
  blocks: [
    {
      id: 'c1', ordinal: 1, heading: 'Digoxin',
      body:
        // Correct.
        'Hold digoxin and notify the primary health care provider if the apical pulse is below 60 beats per minute.\n' +
        // WRONG on purpose: the real therapeutic range is 0.5-2.0 ng/mL.
        'The therapeutic serum digoxin level is 5.5 to 9.9 ng/mL.\n' +
        'Hypokalemia potentiates digoxin toxicity.',
    },
  ],
};

const db = openDb({ path: ':memory:' });
const { sourceId } = insertLecture(db, lecture);

console.log('Generating cards from a lecture containing one incorrect value...\n');

const report = await generateForLecture(db, lecture, sourceId, {
  kinds: ['flashcard'],
  workspaceDir,
  model: 'sonnet',
  maxBudgetUsd: 2,
});

console.log(`Generated ${report.accepted} card(s), ${report.rejected.length} rejected.\n`);
console.log('='.repeat(78));
console.log('Each card passed verification AGAINST THE LECTURE. Now checking the');
console.log('same claims against the FDA drug label.');
console.log('='.repeat(78));

for (const item of listPending(db, lecture.id)) {
  const claim = `${item.front} ${item.back}`;
  const result = await corroborateClaim(db, item.id, claim, {
    workspaceDir,
    cacheDir,
    model: 'sonnet',
  });

  const mark =
    result.outcome === 'confirmed' ? 'CONFIRMED  '
    : result.outcome === 'conflict' ? '** CONFLICT'
    : result.outcome === 'not_found' ? 'no source  '
    : 'unresolved ';

  console.log(`\n[${mark}] ${item.front}`);
  console.log(`              ${item.back}`);
  if (result.source) console.log(`   source   : ${result.source.title}`);
  if (result.excerpt) console.log(`   label    : "${result.excerpt.slice(0, 160)}"`);
  if (result.detail) console.log(`   note     : ${result.detail}`);
}

console.log(`\n${'='.repeat(78)}`);
const withTwo = listPending(db, lecture.id).filter((i) => listCitations(db, i.id).length > 1);
console.log(`${withTwo.length} card(s) now carry independent corroborating evidence.`);
