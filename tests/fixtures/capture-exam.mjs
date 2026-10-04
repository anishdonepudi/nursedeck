/**
 * Seeds a database with verified NCLEX items, then drives the app through a
 * practice exam and screenshots the questions and the diagnostic report.
 *
 * Usage: node tests/fixtures/capture-exam.mjs <outDir>
 */
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node capture-exam.mjs <outDir>'); process.exit(1); }

const userData = await mkdtemp(join(tmpdir(), 'nursedeck-exam-'));
const dataDir = join(userData, 'data');
await mkdir(dataDir, { recursive: true });

/* ---- seed a database the app will open on launch ---- */

const { MIGRATIONS } = await import('../../src/core/db/schema.ts');
const db = new DatabaseSync(join(dataDir, 'nursedeck.db'));
db.exec('PRAGMA foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
for (const m of MIGRATIONS) {
  db.exec(m.sql);
  db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
}

const sourceId = randomUUID();
const lectureId = randomUUID();
const SOURCE_TEXT =
  'Hold digoxin and notify the primary health care provider if the apical pulse is below 60 beats per minute. ' +
  'The therapeutic serum digoxin level is 0.5-2.0 ng/mL. ' +
  'Hypokalemia potentiates digoxin toxicity. ' +
  'The therapeutic INR range for most indications is 2.0-3.0. ' +
  'Protamine sulfate is the antidote for heparin. ' +
  'Never give potassium chloride by IV push.';

db.prepare(
  `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
   VALUES (?, 'lecture', 'A', 'Course lecture', 'Cardiac Pharmacology', ?)`,
).run(sourceId, SOURCE_TEXT);

db.prepare(
  `INSERT INTO lectures (id, source_id, title, source_file, kind)
   VALUES (?, ?, 'Cardiac Pharmacology — Week 5', 'pharm.pptx', 'pptx')`,
).run(lectureId, sourceId);

db.prepare(
  `INSERT INTO blocks (id, lecture_id, ordinal, heading, body) VALUES (?, ?, 1, 'Digoxin', ?)`,
).run(randomUUID(), lectureId, SOURCE_TEXT);

const NEEDS = [
  'Pharmacological and Parenteral Therapies',
  'Reduction of Risk Potential',
  'Management of Care',
  'Physiological Adaptation',
  'Safety and Infection Prevention and Control',
  'Basic Care and Comfort',
  'Health Promotion and Maintenance',
  'Psychosocial Integrity',
];
const STEPS = [
  'Recognize Cues', 'Analyze Cues', 'Prioritize Hypotheses',
  'Generate Solutions', 'Take Action', 'Evaluate Outcomes',
];

const QUESTIONS = [
  {
    stem: 'A 68-year-old client with atrial fibrillation is scheduled to receive the morning dose of digoxin. The nurse assesses the apical pulse for one full minute and counts 54 beats per minute. Which action should the nurse take?',
    options: [
      ['Hold the dose and notify the primary health care provider', true, 'The dose is held and the provider notified when the apical pulse is below 60 beats per minute.', ''],
      ['Administer the dose and recheck the pulse in 1 hour', false, 'Giving the drug could further slow AV conduction in a client with bradycardia.', 'unsafe-action-ignoring-parameter'],
      ['Administer half the dose and notify the provider', false, 'Nurses do not alter prescribed doses independently; the dose must be held.', 'exaggeration-of-a-correct-intervention'],
      ['Hold the dose and request a serum INR level', false, 'INR monitors warfarin, not digoxin; a digoxin level would be relevant.', 'wrong-drug-wrong-lab'],
    ],
    excerpt: 'Hold digoxin and notify the primary health care provider if the apical pulse is below 60 beats per minute.',
  },
  {
    stem: 'A client receiving digoxin reports loss of appetite, nausea, and seeing yellow-green halos around lights. The client also takes a loop diuretic. Which laboratory value should the nurse review first?',
    options: [
      ['Serum potassium', true, 'Hypokalemia potentiates digoxin toxicity, and loop diuretics cause potassium loss.', ''],
      ['Serum sodium', false, 'Sodium does not potentiate digoxin toxicity.', 'plausible-but-unrelated-lab'],
      ['International normalised ratio', false, 'INR monitors warfarin, not digoxin.', 'wrong-drug-wrong-lab'],
      ['Serum albumin', false, 'Albumin does not explain these findings.', 'irrelevant-lab'],
    ],
    excerpt: 'Hypokalemia potentiates digoxin toxicity.',
  },
  {
    stem: 'A client taking warfarin for a mechanical heart valve asks whether to stop eating green leafy vegetables. Which response by the nurse is most appropriate?',
    options: [
      ['"Keep your intake of green leafy vegetables consistent from day to day."', true, 'Consistent vitamin K intake keeps the INR stable.', ''],
      ['"Avoid all green leafy vegetables while taking warfarin."', false, 'Complete avoidance is unnecessary; consistency is the goal.', 'exaggeration-of-a-correct-intervention'],
      ['"Eat as much as you like; diet does not affect warfarin."', false, 'Vitamin K intake directly affects warfarin control.', 'reversed-relationship'],
      ['"Stop the warfarin on days you eat salad."', false, 'Clients never self-adjust anticoagulation.', 'unsafe-self-management'],
    ],
    excerpt: 'The therapeutic INR range for most indications is 2.0-3.0.',
  },
  {
    stem: 'A client receiving a heparin infusion develops haematuria and a rapidly falling platelet count. Which medication should the nurse anticipate administering?',
    options: [
      ['Protamine sulfate', true, 'Protamine sulfate reverses heparin.', ''],
      ['Vitamin K (phytonadione)', false, 'Vitamin K reverses warfarin, not heparin.', 'wrong-drug-right-category'],
      ['Calcium gluconate', false, 'Used for hyperkalaemia and magnesium toxicity, not heparin reversal.', 'irrelevant-antidote'],
      ['Naloxone', false, 'Reverses opioids.', 'irrelevant-antidote'],
    ],
    excerpt: 'Protamine sulfate is the antidote for heparin.',
  },
  {
    stem: 'A nurse is preparing to administer prescribed potassium chloride to a client with hypokalaemia. Which action is essential before administration?',
    options: [
      ['Confirm the potassium is prepared for controlled infusion, never IV push', true, 'Potassium chloride by IV push is fatal.', ''],
      ['Warm the solution to body temperature', false, 'Not required and does not address the fatal-route risk.', 'irrelevant-intervention'],
      ['Administer it by rapid IV push to correct the level quickly', false, 'IV push potassium causes cardiac arrest.', 'reversed-safety-instruction'],
      ['Withhold it until the client reports symptoms', false, 'Prescribed replacement is not withheld pending symptoms.', 'passive-action'],
    ],
    excerpt: 'Never give potassium chloride by IV push.',
  },
];

const insertItem = db.prepare(
  `INSERT INTO items (id, lecture_id, kind, status, front, back, payload, client_need, njcmm_step, cognitive_level)
   VALUES (?, ?, 'nclex', 'accepted', ?, ?, ?, ?, ?, 'analysis')`,
);
const insertCitation = db.prepare(
  `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
   VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
);

// 25 items: the five written questions, cycled across needs and steps so the
// report has something to break down.
for (let i = 0; i < 25; i++) {
  const q = QUESTIONS[i % QUESTIONS.length];
  const id = randomUUID();
  const options = q.options.map(([text, isKey, rationale, errorClass]) => ({
    text, isKey, rationale, ...(errorClass ? { errorClass } : {}),
  }));
  insertItem.run(
    id, lectureId, q.stem, options.find((o) => o.isKey).text,
    JSON.stringify({ itemType: 'multiple_choice', options }),
    NEEDS[i % NEEDS.length], STEPS[i % STEPS.length],
  );
  insertCitation.run(randomUUID(), id, sourceId, q.stem, q.excerpt);
}
db.close();

/* ---- drive the app ---- */

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userData}`],
  env: { ...process.env },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 90_000 });

await page.locator('.lecture').first().click();
await page.getByRole('button', { name: 'Practice exam' }).click();
await page.waitForSelector('.lengths');
await page.getByRole('button', { name: '10 questions' }).click();
await page.screenshot({ path: join(outDir, 'exam-setup.png') });

await page.getByRole('button', { name: 'Start exam' }).click();
await page.waitForSelector('.option-pick', { timeout: 60_000 });
await page.locator('.option-pick').first().click();
await page.screenshot({ path: join(outDir, 'exam-question.png') });

// Answer every question: first option on even indices, second on odd, so the
// report has a mix of right and wrong.
for (let i = 0; ; i++) {
  const picks = await page.locator('.option-pick').count();
  if (picks === 0) break;
  await page.locator('.option-pick').nth(i % 2 === 0 ? 0 : 1).click();
  await page.getByRole('button', { name: /Next|Finish/ }).click();
  await page.waitForTimeout(80);
  if ((await page.getByRole('button', { name: 'Submit exam' }).count()) > 0) break;
}

await page.getByRole('button', { name: 'Submit exam' }).click();
await page.waitForSelector('.subscores', { timeout: 60_000 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, 'exam-report.png') });

const score = await page.locator('.score').textContent();
console.log('score line:', score?.replace(/\s+/g, ' ').trim());
console.log('subscore sections:', await page.locator('.subscores h3').allTextContents());

await app.close();
console.log('done');
