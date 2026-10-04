import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

/**
 * Database access.
 *
 * Uses `node:sqlite`, which ships inside Node (and therefore Electron), rather
 * than a native module like better-sqlite3. That single choice is what keeps
 * the dependency tree free of compiled code, which in turn is what makes a
 * universal macOS build possible without cross-compilation.
 */

export type Db = DatabaseSync;

export interface OpenOptions {
  /** ':memory:' for tests. */
  path: string;
}

export function openDb(opts: OpenOptions): Db {
  const db = new DatabaseSync(opts.path);

  // WAL lets reads proceed during writes, which matters because generation
  // writes while the UI reads. Not available for in-memory databases.
  if (opts.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  // Off by default in SQLite; without it the ON DELETE CASCADE rules that keep
  // citations attached to items would silently not fire.
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  return db;
}

/** Applies any migrations the database has not yet seen, in order. */
export function migrate(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));

  let count = 0;
  // Sorted by id rather than trusting array order: a migration appended in the
  // wrong position would otherwise run before one it depends on.
  for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    // Each migration is atomic: a failure half-way leaves no partial schema.
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
      db.exec('COMMIT');
      count += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
  return count;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * node:sqlite has no `.transaction()` helper, and getting this wrong is how
 * half-written decks happen, so every multi-statement write goes through here.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw err;
  }
}
