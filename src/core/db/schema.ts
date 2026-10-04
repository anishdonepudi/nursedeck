/**
 * SQLite schema, applied as ordered migrations.
 *
 * Two invariants drive the design:
 *
 * 1. CITATIONS ARE STRUCTURAL. Every generated item carries a foreign key to at
 *    least one citation, and `citations` records the verbatim excerpt plus the
 *    verification verdict. An item that has no verified citation can be found
 *    with a query, so "unsourced content reached the deck" is a detectable bug
 *    rather than a silent one.
 *
 * 2. `reviews` IS APPEND-ONLY. Scheduling state in `card_states` is derived
 *    from it, never the other way round. That means the scheduling algorithm
 *    can be changed or re-tuned later and replayed over real history without
 *    losing anything she has done.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
-- ---------------------------------------------------------------- sources --

-- Reference material we are allowed to cite, with the licence tier that
-- governs what may be done with its text.
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('lecture','textbook','guideline','drug_label','article','dataset')),
  license_tier   TEXT NOT NULL CHECK (license_tier IN ('A','B','C','D')),
  group_or_authors TEXT NOT NULL,
  year           TEXT,
  title          TEXT NOT NULL,
  container      TEXT,
  edition        TEXT,
  doi_or_url     TEXT,
  license_url    TEXT,
  retrieved_at   TEXT,
  -- Local copy of the source text. Required for deterministic quote checking:
  -- without it a citation cannot be verified at all.
  full_text      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sources_tier ON sources (license_tier);

-- --------------------------------------------------------------- lectures --

CREATE TABLE lectures (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  source_file  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('pptx','pdf','docx','image')),
  imported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  warnings     TEXT NOT NULL DEFAULT '[]'
);

-- One row per slide / page. Every generated item points back here, which is
-- what lets the UI jump from a card to the slide that taught it.
CREATE TABLE blocks (
  id             TEXT PRIMARY KEY,
  lecture_id     TEXT NOT NULL REFERENCES lectures (id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  heading        TEXT,
  body           TEXT NOT NULL DEFAULT '',
  speaker_notes  TEXT,
  tables_json    TEXT,
  image_refs     TEXT,
  UNIQUE (lecture_id, ordinal)
);

CREATE INDEX idx_blocks_lecture ON blocks (lecture_id, ordinal);

-- ----------------------------------------------------------------- topics --

CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  lecture_id  TEXT REFERENCES lectures (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- NCLEX client-need subcategory, when the topic maps onto one.
  client_need TEXT
);

CREATE INDEX idx_topics_lecture ON topics (lecture_id);

-- ------------------------------------------------------------------ items --

-- All generated study content lives in one table, discriminated by "kind".
-- A single table keeps citation enforcement, triage, scheduling and search
-- uniform instead of repeating them per content type.
CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  lecture_id    TEXT NOT NULL REFERENCES lectures (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('flashcard','cloze','qa','nclex')),

  -- Triage state. Nothing is studiable until a human has accepted it.
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','quarantined')),

  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  -- Type-specific payload: cloze spans, NCLEX options/scoring, Q&A rubric.
  payload       TEXT,

  -- Blueprint tags, used for exam assembly and the diagnostic report.
  client_need      TEXT,
  integrated_process TEXT,
  njcmm_step       TEXT,
  cognitive_level  TEXT CHECK (cognitive_level IN ('recall','application','analysis')),

  -- Elo difficulty, so trivial or broken generated items surface themselves.
  elo           REAL NOT NULL DEFAULT 1200,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  generation_id TEXT
);

CREATE INDEX idx_items_lecture_status ON items (lecture_id, status);
CREATE INDEX idx_items_kind ON items (kind, status);

-- Which slides an item came from. Many-to-many: one card may synthesise two
-- adjacent slides.
CREATE TABLE item_blocks (
  item_id   TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  block_id  TEXT NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, block_id)
);

CREATE TABLE item_topics (
  item_id   TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  topic_id  TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, topic_id)
);

-- -------------------------------------------------------------- citations --

-- The evidence for one claim. 'verdict' records the outcome of the four-stage
-- gate; only 'verified' may be presented as fact.
CREATE TABLE citations (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  claim       TEXT NOT NULL,
  excerpt     TEXT NOT NULL,
  -- Character offset of the excerpt within sources.full_text, for deep links.
  matched_at  INTEGER,
  verdict     TEXT NOT NULL DEFAULT 'unverified'
              CHECK (verdict IN ('unverified','verified','failed')),
  failure_stage  TEXT,
  failure_detail TEXT,
  checked_at  TEXT
);

CREATE INDEX idx_citations_item ON citations (item_id);
CREATE INDEX idx_citations_verdict ON citations (verdict);

-- ------------------------------------------------------------- scheduling --

-- Current FSRS state. Derived from "reviews"; safe to rebuild from scratch.
CREATE TABLE card_states (
  item_id     TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  due         TEXT NOT NULL,
  stability   REAL NOT NULL,
  difficulty  REAL NOT NULL,
  elapsed_days INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  state       INTEGER NOT NULL DEFAULT 0,
  last_review TEXT
);

CREATE INDEX idx_card_states_due ON card_states (due);

-- Append-only event log. Never updated, never deleted.
CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  -- Pre-answer confidence, 0..1. Kept separate from the outcome so that
  -- calibration (and the 'confident but wrong' queue) can be computed.
  confidence  REAL,
  correct     INTEGER,
  duration_ms INTEGER,
  mode        TEXT NOT NULL DEFAULT 'review'
              CHECK (mode IN ('review','type','cloze','exam','match')),
  -- FSRS state at the moment of review, so history can be replayed.
  state_before TEXT
);

CREATE INDEX idx_reviews_item ON reviews (item_id, reviewed_at);
CREATE INDEX idx_reviews_time ON reviews (reviewed_at);

-- ------------------------------------------------------------------ exams --

CREATE TABLE exams (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT,
  blueprint    TEXT,
  points_earned   REAL,
  points_possible REAL
);

CREATE TABLE exam_items (
  exam_id    TEXT NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  response   TEXT,
  points_earned   REAL,
  points_possible REAL,
  duration_ms INTEGER,
  PRIMARY KEY (exam_id, item_id)
);

CREATE INDEX idx_exam_items_order ON exam_items (exam_id, position);

-- ------------------------------------------------------------ generation --

-- One row per headless CLI invocation, so a bad card can be traced back to the
-- exact request that produced it.
CREATE TABLE generations (
  id          TEXT PRIMARY KEY,
  lecture_id  TEXT REFERENCES lectures (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  model       TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  ok          INTEGER,
  error       TEXT,
  cost_usd    REAL,
  prompt      TEXT,
  raw_output  TEXT
);

CREATE INDEX idx_generations_lecture ON generations (lecture_id);

-- ---------------------------------------------------------------- search --

-- Full-text search over accepted items.
CREATE VIRTUAL TABLE items_fts USING fts5 (
  front, back,
  content = 'items',
  content_rowid = 'rowid'
);

CREATE TRIGGER items_fts_ins AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, front, back) VALUES (new.rowid, new.front, new.back);
END;

CREATE TRIGGER items_fts_del AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, front, back)
  VALUES ('delete', old.rowid, old.front, old.back);
END;

CREATE TRIGGER items_fts_upd AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, front, back)
  VALUES ('delete', old.rowid, old.front, old.back);
  INSERT INTO items_fts (rowid, front, back) VALUES (new.rowid, new.front, new.back);
END;
`,
  },
  {
    id: 2,
    name: 'persist_learning_steps',
    sql: `
-- FSRS tracks how far a card has progressed through the learning steps.
-- Without persisting it, every reload resets the card to step 0, so it never
-- graduates to Review, and lapses are therefore never counted. Found by a test
-- asserting that failing a mature card increments its lapse count.
ALTER TABLE card_states ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 3,
    name: 'user_authored_cards',
    sql: `
-- Cards the student writes herself.
--
-- These still need a source row, because every item carries a citation FK and
-- that invariant is what makes "unsourced content cannot be studied" true. The
-- honest answer is that SHE is the source: the card is marked 'user' so the UI
-- can say "your own card" rather than implying a lecture backed it, and so a
-- hand-written card is never mistaken for a verified generated one.
--
-- SQLite cannot alter a CHECK constraint, so the sources table is rebuilt.
CREATE TABLE sources_new (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('lecture','textbook','guideline','drug_label','article','dataset','user')),
  license_tier   TEXT NOT NULL CHECK (license_tier IN ('A','B','C','D')),
  group_or_authors TEXT NOT NULL,
  year           TEXT,
  title          TEXT NOT NULL,
  container      TEXT,
  edition        TEXT,
  doi_or_url     TEXT,
  license_url    TEXT,
  retrieved_at   TEXT,
  full_text      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sources_new SELECT * FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX idx_sources_tier ON sources (license_tier);

-- Distinguishes a card she wrote from one the model produced. Generated cards
-- must pass verification; hers are hers.
ALTER TABLE items ADD COLUMN authored_by TEXT NOT NULL DEFAULT 'generated'
  CHECK (authored_by IN ('generated','user'));

-- Records that an item was edited, so a card she reworded is not silently
-- presented as the model's original wording.
ALTER TABLE items ADD COLUMN edited_at TEXT;
`,
  },
  {
    id: 4,
    name: 'imported_decks',
    sql: `
-- Importing a classmate's deck.
--
-- An imported card has no evidence behind it. The file it came from proves
-- only that the card was copied faithfully, not that it is true, and a shared
-- Quizlet set is exactly the unreliable source this tool exists to replace.
--
-- So imports land as 'pending' with an UNVERIFIED citation and cannot be
-- studied. The citation's excerpt is the card's own imported text and the
-- source holds the raw file, which means the verbatim check still means
-- something real: it proves the import did not mangle the card. Turning it
-- into something studiable requires her to vouch for it in triage, which
-- records HER as the party standing behind the claim -- the same honest
-- position as a card she wrote herself.
--
-- SQLite cannot alter a CHECK constraint, so sources is rebuilt again.
CREATE TABLE sources_new (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('lecture','textbook','guideline','drug_label','article','dataset','user','import')),
  license_tier   TEXT NOT NULL CHECK (license_tier IN ('A','B','C','D')),
  group_or_authors TEXT NOT NULL,
  year           TEXT,
  title          TEXT NOT NULL,
  container      TEXT,
  edition        TEXT,
  doi_or_url     TEXT,
  license_url    TEXT,
  retrieved_at   TEXT,
  full_text      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sources_new SELECT * FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX idx_sources_tier ON sources (license_tier);

-- Where an imported card came from, so the UI can name the file and never show
-- a classmate's card as though a lecture backed it.
--
-- Deliberately a new nullable column rather than a third value in the
-- authored_by CHECK: changing that constraint means rebuilding the items table, and six
-- tables hold foreign keys into it. SQLite rewrites a child table's FK clause
-- when the parent is renamed, so the 12-step rebuild would silently leave
-- citations, card_states and reviews pointing at the dropped items_old. An
-- additive column cannot do that.
ALTER TABLE items ADD COLUMN imported_from TEXT;
CREATE INDEX idx_items_imported ON items (imported_from);
`,
  },
];
