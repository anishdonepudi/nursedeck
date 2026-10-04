/**
 * Seeds a database with study history, then screenshots the readiness
 * dashboard. Usage: node tests/fixtures/capture-dashboard.mjs <outDir>
 */
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node capture-dashboard.mjs <outDir>'); process.exit(1); }

const userData = await mkdtemp(join(tmpdir(), 'nursedeck-dash-'));
const dataDir = join(userData, 'data');
await mkdir(dataDir, { recursive: true });

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
db.prepare(
  `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
   VALUES (?, 'lecture', 'A', 'Course lecture', 'Pharmacology', 'Study notes.')`,
).run(sourceId);
db.prepare(
  `INSERT INTO lectures (id, source_id, title, source_file, kind)
   VALUES (?, ?, 'Pharmacology - Weeks 1-5', 'pharm.pptx', 'pptx')`,
).run(lectureId, sourceId);
const blockId = randomUUID();
db.prepare(`INSERT INTO blocks (id, lecture_id, ordinal, body) VALUES (?, ?, 1, 'Study notes.')`)
  .run(blockId, lectureId);

/**
 * Topics with deliberately different evidence levels, so the dashboard has to
 * show both a confident score and a "not enough data yet".
 */
const TOPICS = [
  { need: 'Pharmacological and Parenteral Therapies', cards: 14, accuracy: 0.45, reviewsEach: 4 },
  { need: 'Reduction of Risk Potential', cards: 10, accuracy: 0.62, reviewsEach: 3 },
  { need: 'Management of Care', cards: 9, accuracy: 0.88, reviewsEach: 4 },
  { need: 'Safety and Infection Prevention and Control', cards: 7, accuracy: 0.95, reviewsEach: 3 },
  { need: 'Psychosocial Integrity', cards: 4, accuracy: 1.0, reviewsEach: 1 }, // too little evidence
];

const insertItem = db.prepare(
  `INSERT INTO items (id, lecture_id, kind, status, front, back, client_need, elo)
   VALUES (?, ?, 'flashcard', 'accepted', ?, ?, ?, 1200)`,
);
const insertCite = db.prepare(
  `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
   VALUES (?, ?, ?, ?, 'Study notes.', 'verified', datetime('now'))`,
);
const insertState = db.prepare(
  `INSERT INTO card_states (item_id, due, stability, difficulty, elapsed_days, scheduled_days,
     reps, lapses, state, learning_steps, last_review)
   VALUES (?, ?, ?, ?, 0, ?, ?, ?, 2, 0, datetime('now'))`,
);
const insertReview = db.prepare(
  `INSERT INTO reviews (item_id, reviewed_at, rating, confidence, correct, mode)
   VALUES (?, datetime('now'), ?, ?, ?, 'type')`,
);

const now = Date.now();
let n = 0;
for (const topic of TOPICS) {
  for (let i = 0; i < topic.cards; i++) {
    const id = randomUUID();
    insertItem.run(id, lectureId, `${topic.need} question ${i + 1}?`, 'Answer', topic.need);
    insertCite.run(randomUUID(), id, sourceId, 'claim');

    // Spread due dates over the next few weeks so the forecast has shape.
    const dueIn = 1 + ((i * 3 + n) % 24);
    insertState.run(id, new Date(now + dueIn * 86_400_000).toISOString(),
      5 + (i % 9), 5, dueIn, topic.reviewsEach, Math.floor(i / 4));

    for (let r = 0; r < topic.reviewsEach; r++) {
      const correct = Math.random() < topic.accuracy;
      // Overconfident on the weakest topic, so "thought you knew these" fills.
      const confidence = topic.accuracy < 0.5 ? 0.9 : 0.7;
      insertReview.run(id, correct ? 3 : 1, confidence, correct ? 1 : 0);
    }
    n += 1;
  }
}
db.close();

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userData}`],
  env: { ...process.env },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 90_000 });

await page.locator('.lecture').first().click();
await page.getByRole('button', { name: 'Progress' }).click();
await page.waitForSelector('.topics', { timeout: 60_000 });

// Set an exam date six weeks out so the projection section renders.
const exam = new Date(now + 42 * 86_400_000).toISOString().slice(0, 10);
await page.locator('#exam-date').fill(exam);
await page.waitForTimeout(1200);

await page.screenshot({ path: join(outDir, 'dashboard.png'), fullPage: true });
console.log('topics:', await page.locator('.topics li').count());
console.log('saved dashboard.png');
await app.close();
