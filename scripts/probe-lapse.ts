/**
 * Prints FSRS state after a sequence of ratings, to settle whether "Again"
 * counts a lapse at the point a test expects it to.
 */
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/core/db/index.js';
import { insertItem } from '../src/core/db/repo.js';
import { answerCard, readCardState } from '../src/core/scheduler/fsrs.js';

const db = openDb({ path: ':memory:' });
const sourceId = randomUUID();
const lectureId = randomUUID();

db.prepare(
  `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
   VALUES (?, 'lecture', 'A', 'x', 'y', 'z')`,
).run(sourceId);
db.prepare(
  `INSERT INTO lectures (id, source_id, title, source_file, kind)
   VALUES (?, ?, 'y', 'f.pptx', 'pptx')`,
).run(lectureId, sourceId);

const id = insertItem(
  db,
  { lectureId, kind: 'flashcard', front: 'Q', back: 'A', blockIds: [] },
  [{ sourceId, claim: 'c', excerpt: 'z', verdict: 'verified' }],
);
db.prepare("UPDATE items SET status='accepted' WHERE id=?").run(id);

function show(label: string): void {
  const s = readCardState(db, id);
  console.log(`${label}: state=${s?.state} reps=${s?.reps} lapses=${s?.lapses}`);
}

show('new');
const sequence: (1 | 2 | 3 | 4)[] = [3, 3, 3, 1, 1];
for (const [i, rating] of sequence.entries()) {
  answerCard(db, { itemId: id, rating });
  show(`after #${i + 1} rating=${rating}`);
}
