import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MIGRATIONS } from '@core/db/schema.js';

/**
 * Seeds a database the app will open on launch, containing one card that is
 * already accepted and verified.
 *
 * Used by tests that need to exercise the study interface. Generating a card
 * live and hoping the adversarial auditor passes it is not a reliable way to
 * reach that state: whether a given run produces a card the auditor accepts is
 * genuinely non-deterministic, and a test that sometimes starts with an empty
 * deck tests nothing.
 */

export const SEEDED_EXCERPT = 'Normal adult serum potassium is 3.5-5.0 mEq/L.';
export const SEEDED_FRONT = 'What is the normal adult serum potassium range?';
export const SEEDED_BACK = '3.5-5.0 mEq/L';

export async function seedStudiableCard(dataDir: string): Promise<{ lectureId: string; itemId: string }> {
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
  const blockId = randomUUID();
  const itemId = randomUUID();

  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Fluid and Electrolyte Balance', ?)`,
  ).run(sourceId, SEEDED_EXCERPT);

  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Fluid and Electrolyte Balance', 'electrolytes.pptx', 'pptx')`,
  ).run(lectureId, sourceId);

  db.prepare(
    `INSERT INTO blocks (id, lecture_id, ordinal, heading, body)
     VALUES (?, ?, 1, 'Potassium', ?)`,
  ).run(blockId, lectureId, SEEDED_EXCERPT);

  db.prepare(
    `INSERT INTO items (id, lecture_id, kind, status, front, back, client_need)
     VALUES (?, ?, 'flashcard', 'accepted', ?, ?, 'Reduction of Risk Potential')`,
  ).run(itemId, lectureId, SEEDED_FRONT, SEEDED_BACK);

  db.prepare('INSERT INTO item_blocks (item_id, block_id) VALUES (?, ?)').run(itemId, blockId);

  db.prepare(
    `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
     VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
  ).run(randomUUID(), itemId, sourceId, SEEDED_BACK, SEEDED_EXCERPT);

  db.close();
  return { lectureId, itemId };
}

export const SEEDED_QA_FRONT = 'Explain why potassium is never given by IV push.';
export const SEEDED_QA_KEY_POINTS = [
  'A rapid rise in serum potassium stops the heart',
  'Potassium must be diluted and infused slowly',
];

/**
 * Adds a short-answer card and an unverified card to an already-seeded deck.
 *
 * The Q&A card exercises teach-back grading, which needs key points stored on
 * the item. The unverified one exercises bulk verification, which has nothing
 * to do if every card is already verified.
 */
export async function seedExtraCards(dataDir: string, lectureId: string): Promise<{
  qaItemId: string;
  pendingItemId: string;
}> {
  const db = new DatabaseSync(join(dataDir, 'nursedeck.db'));
  db.exec('PRAGMA foreign_keys = ON');

  const sourceRow = db
    .prepare('SELECT source_id FROM lectures WHERE id = ?')
    .get(lectureId) as { source_id: string };
  const sourceId = sourceRow.source_id;

  const qaItemId = randomUUID();
  db.prepare(
    `INSERT INTO items (id, lecture_id, kind, status, front, back, payload)
     VALUES (?, ?, 'qa', 'accepted', ?, ?, ?)`,
  ).run(
    qaItemId,
    lectureId,
    SEEDED_QA_FRONT,
    'IV push potassium causes a lethal rise in serum potassium; it must be diluted and infused slowly.',
    JSON.stringify({ keyPoints: SEEDED_QA_KEY_POINTS }),
  );
  db.prepare(
    `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
     VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
  ).run(randomUUID(), qaItemId, sourceId, 'IV push potassium stops the heart', SEEDED_EXCERPT);

  // Pending AND unverified: the state bulk verification exists to clear.
  const pendingItemId = randomUUID();
  db.prepare(
    `INSERT INTO items (id, lecture_id, kind, status, front, back)
     VALUES (?, ?, 'flashcard', 'pending', 'Which electrolyte is primarily intracellular?', 'Potassium')`,
  ).run(pendingItemId, lectureId);
  db.prepare(
    `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict)
     VALUES (?, ?, ?, ?, ?, 'unverified')`,
  ).run(randomUUID(), pendingItemId, sourceId, 'Potassium is primarily intracellular', SEEDED_EXCERPT);

  db.close();
  return { qaItemId, pendingItemId };
}
