import { randomUUID } from 'node:crypto';
import type { Db } from './index.js';
import { transaction } from './index.js';
import type { LectureDoc, LicenseTier } from '@shared/types.js';

/**
 * Data access.
 *
 * The important rule lives in `listStudiable`: an item is only ever returned
 * for study when it has been accepted in triage AND has at least one verified
 * citation. That is enforced here, in SQL, rather than being left to each
 * caller to remember.
 */

export type ItemKind = 'flashcard' | 'cloze' | 'qa' | 'nclex';
export type ItemStatus = 'pending' | 'accepted' | 'rejected' | 'quarantined';
export type CitationVerdict = 'unverified' | 'verified' | 'failed';

export interface SourceRow {
  id: string;
  kind: 'lecture' | 'textbook' | 'guideline' | 'drug_label' | 'article' | 'dataset' | 'user' | 'import';
  licenseTier: LicenseTier;
  groupOrAuthors: string;
  year?: string;
  title: string;
  container?: string;
  edition?: string;
  doiOrUrl?: string;
  licenseUrl?: string;
  retrievedAt?: string;
  fullText?: string;
}

export function insertSource(db: Db, s: Omit<SourceRow, 'id'> & { id?: string }): string {
  const id = s.id ?? randomUUID();
  db.prepare(
    `INSERT INTO sources
       (id, kind, license_tier, group_or_authors, year, title, container, edition,
        doi_or_url, license_url, retrieved_at, full_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, s.kind, s.licenseTier, s.groupOrAuthors, s.year ?? null, s.title,
    s.container ?? null, s.edition ?? null, s.doiOrUrl ?? null, s.licenseUrl ?? null,
    s.retrievedAt ?? null, s.fullText ?? null,
  );
  return id;
}

export function getSourceText(db: Db, sourceId: string): string | undefined {
  const row = db.prepare('SELECT full_text FROM sources WHERE id = ?').get(sourceId) as
    | { full_text: string | null }
    | undefined;
  return row?.full_text ?? undefined;
}

/**
 * Stores a parsed lecture and registers it as a citable source.
 *
 * The lecture's own text becomes a tier-A source, so a card drawn from a slide
 * can be verified against that slide exactly like one drawn from a textbook.
 */
export function insertLecture(db: Db, doc: LectureDoc): { lectureId: string; sourceId: string } {
  return transaction(db, () => {
    const fullText = doc.blocks
      .map((b) => [b.heading, b.body, b.speakerNotes].filter(Boolean).join('\n'))
      .join('\n\n');

    const sourceId = insertSource(db, {
      kind: 'lecture',
      licenseTier: 'A',
      groupOrAuthors: 'Course lecture',
      title: doc.title,
      doiOrUrl: doc.sourceFile,
      retrievedAt: new Date().toISOString(),
      fullText,
    });

    db.prepare(
      `INSERT INTO lectures (id, source_id, title, source_file, kind, warnings)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(doc.id, sourceId, doc.title, doc.sourceFile, doc.kind, JSON.stringify(doc.warnings));

    const stmt = db.prepare(
      `INSERT INTO blocks
         (id, lecture_id, ordinal, heading, body, speaker_notes, tables_json, image_refs, image_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of doc.blocks) {
      stmt.run(
        b.id, doc.id, b.ordinal, b.heading ?? null, b.body,
        b.speakerNotes ?? null,
        b.tables ? JSON.stringify(b.tables) : null,
        b.imageRefs ? JSON.stringify(b.imageRefs) : null,
        b.imageText ?? null,
      );
    }

    return { lectureId: doc.id, sourceId };
  });
}

export interface NewItem {
  id?: string;
  lectureId: string;
  kind: ItemKind;
  front: string;
  back: string;
  payload?: unknown;
  blockIds: string[];
  clientNeed?: string;
  integratedProcess?: string;
  njcmmStep?: string;
  cognitiveLevel?: 'recall' | 'application' | 'analysis';
  generationId?: string;
}

export interface NewCitation {
  sourceId: string;
  claim: string;
  excerpt: string;
  verdict?: CitationVerdict;
  matchedAt?: number;
  failureStage?: string;
  failureDetail?: string;
}

/** Inserts an item together with its citations, atomically. */
export function insertItem(db: Db, item: NewItem, citations: NewCitation[]): string {
  const id = item.id ?? randomUUID();
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO items
         (id, lecture_id, kind, front, back, payload, client_need, integrated_process,
          njcmm_step, cognitive_level, generation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, item.lectureId, item.kind, item.front, item.back,
      item.payload === undefined ? null : JSON.stringify(item.payload),
      item.clientNeed ?? null, item.integratedProcess ?? null,
      item.njcmmStep ?? null, item.cognitiveLevel ?? null, item.generationId ?? null,
    );

    const linkBlock = db.prepare('INSERT OR IGNORE INTO item_blocks (item_id, block_id) VALUES (?, ?)');
    for (const b of item.blockIds) linkBlock.run(id, b);

    const cite = db.prepare(
      `INSERT INTO citations
         (id, item_id, source_id, claim, excerpt, matched_at, verdict, failure_stage, failure_detail, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of citations) {
      cite.run(
        randomUUID(), id, c.sourceId, c.claim, c.excerpt,
        c.matchedAt ?? null, c.verdict ?? 'unverified',
        c.failureStage ?? null, c.failureDetail ?? null,
        c.verdict && c.verdict !== 'unverified' ? new Date().toISOString() : null,
      );
    }
    return id;
  });
}

export function setCitationVerdict(
  db: Db,
  citationId: string,
  verdict: CitationVerdict,
  detail?: { stage?: string; detail?: string; matchedAt?: number },
): void {
  db.prepare(
    `UPDATE citations
        SET verdict = ?, failure_stage = ?, failure_detail = ?, matched_at = COALESCE(?, matched_at),
            checked_at = ?
      WHERE id = ?`,
  ).run(
    verdict, detail?.stage ?? null, detail?.detail ?? null,
    detail?.matchedAt ?? null, new Date().toISOString(), citationId,
  );
}

export function setItemStatus(db: Db, itemId: string, status: ItemStatus): void {
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, itemId);
}

export interface ItemRow {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  front: string;
  back: string;
  payload: unknown;
  clientNeed?: string;
  cognitiveLevel?: string;
  elo: number;
  verifiedCitations: number;
  failedCitations: number;
}

function mapItemRow(r: Record<string, unknown>): ItemRow {
  const out: ItemRow = {
    id: String(r['id']),
    kind: r['kind'] as ItemKind,
    status: r['status'] as ItemStatus,
    front: String(r['front']),
    back: String(r['back']),
    payload: r['payload'] ? JSON.parse(String(r['payload'])) : undefined,
    elo: Number(r['elo']),
    verifiedCitations: Number(r['verified_citations'] ?? 0),
    failedCitations: Number(r['failed_citations'] ?? 0),
  };
  if (r['client_need']) out.clientNeed = String(r['client_need']);
  if (r['cognitive_level']) out.cognitiveLevel = String(r['cognitive_level']);
  return out;
}

// `i.rowid` is selected explicitly: `i.*` omits it, and wrapping this in a
// subquery would then lose the column that FTS joins and ordering depend on.
const ITEM_WITH_CITATION_COUNTS = `
  SELECT i.rowid AS rowid, i.*,
         (SELECT COUNT(*) FROM citations c WHERE c.item_id = i.id AND c.verdict = 'verified') AS verified_citations,
         (SELECT COUNT(*) FROM citations c WHERE c.item_id = i.id AND c.verdict = 'failed')   AS failed_citations,
         (SELECT COUNT(*) FROM citations c WHERE c.item_id = i.id)                            AS total_citations
    FROM items i
`;

/** Items awaiting triage, newest lecture first. */
export function listPending(db: Db, lectureId: string): ItemRow[] {
  const rows = db
    .prepare(`${ITEM_WITH_CITATION_COUNTS} WHERE i.lecture_id = ? AND i.status = 'pending' ORDER BY i.rowid`)
    .all(lectureId) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

/**
 * Items that may actually be studied.
 *
 * Both conditions are required and are enforced here rather than by callers:
 * accepted in triage, and backed by at least one verified citation. This is the
 * query that makes "every claim is sourced" true in practice.
 */
export function listStudiable(db: Db, opts: { lectureId?: string; limit?: number } = {}): ItemRow[] {
  const where = ["i.status = 'accepted'", 'verified_citations > 0'];
  const params: unknown[] = [];
  if (opts.lectureId) {
    where.push('i.lecture_id = ?');
    params.push(opts.lectureId);
  }
  const sql = `
    SELECT * FROM (${ITEM_WITH_CITATION_COUNTS}) AS i
     WHERE ${where.join(' AND ')}
     ORDER BY rowid
     ${opts.limit ? 'LIMIT ?' : ''}
  `;
  if (opts.limit) params.push(opts.limit);
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

/**
 * Accepted items that can never become studiable as they stand: either no
 * citation row at all, or every citation already checked and FAILED.
 *
 * Both need a human. An orphan is a genuine bug, since insertItem writes an
 * item and its citations in one transaction. An all-failed card is a claim her
 * own lecture does not support, which she accepted in triage before the audit
 * caught up.
 *
 * What this deliberately no longer matches is a card merely AWAITING its audit.
 * That is an ordinary state -- she keeps a card, verification runs separately --
 * and counting it here meant the "this should never happen" alarm was lit
 * during normal use. An alarm that is always on is one nobody reads.
 */
export function listUnsourced(db: Db): ItemRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM (${ITEM_WITH_CITATION_COUNTS}) AS i
        WHERE i.status = 'accepted'
          AND verified_citations = 0
          AND (total_citations = 0 OR failed_citations = total_citations)`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

/**
 * Accepted items whose citations exist but none has been verified yet.
 *
 * Normal and expected, not a fault: these are cards she kept in triage that
 * have not been through the audit. They are not studiable, so this is the list
 * behind "N cards still need checking".
 */
export function listAwaitingVerification(db: Db, opts: { lectureId?: string } = {}): ItemRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM (${ITEM_WITH_CITATION_COUNTS}) AS i
        WHERE i.status = 'accepted'
          AND verified_citations = 0
          AND total_citations > failed_citations
          ${opts.lectureId ? 'AND i.lecture_id = ?' : ''}`,
    )
    .all(...(opts.lectureId ? [opts.lectureId] : [])) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

export interface CitationRow {
  id: string;
  sourceId: string;
  claim: string;
  excerpt: string;
  verdict: CitationVerdict;
  matchedAt?: number;
  failureStage?: string;
  failureDetail?: string;
  sourceTitle: string;
  licenseTier: LicenseTier;
  doiOrUrl?: string;
}

export function listCitations(db: Db, itemId: string): CitationRow[] {
  const rows = db
    .prepare(
      `SELECT c.*, s.title AS source_title, s.license_tier, s.doi_or_url
         FROM citations c JOIN sources s ON s.id = c.source_id
        WHERE c.item_id = ?`,
    )
    .all(itemId) as Record<string, unknown>[];

  return rows.map((r) => {
    const out: CitationRow = {
      id: String(r['id']),
      sourceId: String(r['source_id']),
      claim: String(r['claim']),
      excerpt: String(r['excerpt']),
      verdict: r['verdict'] as CitationVerdict,
      sourceTitle: String(r['source_title']),
      licenseTier: r['license_tier'] as LicenseTier,
    };
    if (r['matched_at'] !== null && r['matched_at'] !== undefined) out.matchedAt = Number(r['matched_at']);
    if (r['failure_stage']) out.failureStage = String(r['failure_stage']);
    if (r['failure_detail']) out.failureDetail = String(r['failure_detail']);
    if (r['doi_or_url']) out.doiOrUrl = String(r['doi_or_url']);
    return out;
  });
}

/** The slides an item was drawn from, for the "where did this come from" link. */
export function listItemBlocks(db: Db, itemId: string): { id: string; ordinal: number; heading?: string }[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.ordinal, b.heading
         FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
        WHERE ib.item_id = ? ORDER BY b.ordinal`,
    )
    .all(itemId) as Record<string, unknown>[];
  return rows.map((r) => {
    const out: { id: string; ordinal: number; heading?: string } = {
      id: String(r['id']),
      ordinal: Number(r['ordinal']),
    };
    if (r['heading']) out.heading = String(r['heading']);
    return out;
  });
}

export function searchItems(db: Db, query: string, limit = 50): ItemRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM (${ITEM_WITH_CITATION_COUNTS}) AS i
        WHERE rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
        LIMIT ?`,
    )
    .all(query, limit) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

export function listLectures(db: Db): { id: string; title: string; importedAt: string; itemCount: number }[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.title, l.imported_at,
              (SELECT COUNT(*) FROM items i WHERE i.lecture_id = l.id) AS item_count
         FROM lectures l ORDER BY l.imported_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    title: String(r['title']),
    importedAt: String(r['imported_at']),
    itemCount: Number(r['item_count']),
  }));
}

/* ------------------------------------------------------------------ */
/* Cards the student writes or edits herself                           */
/* ------------------------------------------------------------------ */

/**
 * The source row representing the student herself.
 *
 * Her own cards still need a citation, because the FK is what makes
 * "unsourced content cannot be studied" structurally true. The honest answer
 * for a hand-written card is that she is the author, so it is recorded as such
 * rather than being attached to a lecture that never said it.
 */
export function ensureUserSource(db: Db): string {
  const existing = db
    .prepare("SELECT id FROM sources WHERE kind = 'user' LIMIT 1")
    .get() as { id: string } | undefined;
  if (existing) return existing.id;

  return insertSource(db, {
    kind: 'user',
    licenseTier: 'A',
    groupOrAuthors: 'Written by you',
    title: 'Your own notes',
    fullText: '',
  });
}

export interface UserCardInput {
  lectureId: string;
  kind: 'flashcard' | 'cloze' | 'qa';
  front: string;
  back: string;
  clientNeed?: string;
  /** Optional: the slide she was looking at when she wrote it. */
  blockIds?: string[];
}

/**
 * Creates a card the student wrote.
 *
 * It is accepted and studiable immediately: there is nothing to triage, since
 * she is the author and reviewing her own card against itself would be theatre.
 */
export function insertUserCard(db: Db, input: UserCardInput): string {
  const id = randomUUID();
  const sourceId = ensureUserSource(db);

  return transaction(db, () => {
    db.prepare(
      `INSERT INTO items (id, lecture_id, kind, status, front, back, client_need, authored_by)
       VALUES (?, ?, ?, 'accepted', ?, ?, ?, 'user')`,
    ).run(id, input.lectureId, input.kind, input.front, input.back, input.clientNeed ?? null);

    const link = db.prepare('INSERT OR IGNORE INTO item_blocks (item_id, block_id) VALUES (?, ?)');
    for (const b of input.blockIds ?? []) link.run(id, b);

    db.prepare(
      `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
       VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
    ).run(randomUUID(), id, sourceId, input.back, 'Written by you.');

    return id;
  });
}

export interface EditCardInput {
  itemId: string;
  front?: string;
  back?: string;
  clientNeed?: string;
}

/**
 * Edits a card's wording.
 *
 * Editing a GENERATED card invalidates its verification: the citation was
 * checked against the original wording, and the new wording may say something
 * the source does not. Rather than silently keeping a stale verdict, the
 * citation is reset to unverified so she can re-check it — and the card drops
 * out of the study queue until she does.
 */
export function editItem(db: Db, input: EditCardInput): { requiresReverification: boolean } {
  return transaction(db, () => {
    const row = db
      .prepare('SELECT authored_by, front, back FROM items WHERE id = ?')
      .get(input.itemId) as { authored_by: string; front: string; back: string } | undefined;
    if (!row) throw new Error('That card no longer exists.');

    const front = input.front ?? row.front;
    const back = input.back ?? row.back;
    const contentChanged = front !== row.front || back !== row.back;

    db.prepare(
      `UPDATE items
          SET front = ?, back = ?, client_need = COALESCE(?, client_need),
              edited_at = datetime('now')
        WHERE id = ?`,
    ).run(front, back, input.clientNeed ?? null, input.itemId);

    const isUserCard = row.authored_by === 'user';
    if (!contentChanged || isUserCard) {
      // Her own card's citation is "written by you", which stays true however
      // she rewords it.
      if (isUserCard && contentChanged) {
        db.prepare('UPDATE citations SET claim = ? WHERE item_id = ?').run(back, input.itemId);
      }
      return { requiresReverification: false };
    }

    db.prepare(
      `UPDATE citations
          SET verdict = 'unverified', claim = ?, failure_stage = NULL, failure_detail = NULL
        WHERE item_id = ?`,
    ).run(back, input.itemId);

    return { requiresReverification: true };
  });
}

export function deleteItem(db: Db, itemId: string): void {
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
}

export interface DeckCard {
  id: string;
  kind: ItemKind;
  front: string;
  back: string;
  status: ItemStatus;
  authoredBy: 'generated' | 'user' | 'imported';
  /** The file an imported card came from, so its provenance is visible. */
  importedFrom?: string;
  edited: boolean;
  verified: boolean;
  lectureTitle: string;
}

/** Every card in a deck, for browsing and editing. */
export function listDeck(db: Db, opts: { lectureId?: string; limit?: number } = {}): DeckCard[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.front, i.back, i.status, i.authored_by, i.edited_at,
              i.imported_from,
              l.title AS lecture_title,
              (SELECT COUNT(*) FROM citations c
                WHERE c.item_id = i.id AND c.verdict = 'verified') AS verified
         FROM items i
         JOIN lectures l ON l.id = i.lecture_id
        WHERE i.status IN ('accepted','pending')
          ${opts.lectureId ? 'AND i.lecture_id = ?' : ''}
        ORDER BY i.created_at DESC
        LIMIT ?`,
    )
    .all(...(opts.lectureId ? [opts.lectureId] : []), opts.limit ?? 500) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r['id']),
    kind: r['kind'] as ItemKind,
    front: String(r['front']),
    back: String(r['back']),
    status: r['status'] as ItemStatus,
    authoredBy:
      r['imported_from'] != null ? 'imported' : r['authored_by'] === 'user' ? 'user' : 'generated',
    ...(r['imported_from'] != null ? { importedFrom: String(r['imported_from']) } : {}),
    edited: r['edited_at'] !== null && r['edited_at'] !== undefined,
    verified: Number(r['verified']) > 0,
    lectureTitle: String(r['lecture_title']),
  }));
}

/* ------------------------------ imported decks ------------------------------ */

export interface ImportDeckInput {
  /** Lecture the imported cards are filed under. */
  lectureId: string;
  /** File the deck came from, shown to her verbatim. */
  filename: string;
  /** Raw file text, stored so an imported card's quote remains checkable. */
  rawText: string;
  cards: { front: string; back: string; tags?: string[] }[];
}

export interface ImportDeckResult {
  sourceId: string;
  imported: number;
  /** Cards already present with the same wording. */
  duplicates: number;
}

/**
 * Stores cards from someone else's deck.
 *
 * They land PENDING and UNVERIFIED, so nothing imported can be studied until
 * she has looked at it. The citation records the card's own text against the
 * raw file, which proves the import is faithful -- not that the card is true.
 * Only `vouchItem` can promote one, and only she can trigger that.
 */
export function insertImportedDeck(db: Db, input: ImportDeckInput): ImportDeckResult {
  return transaction(db, () => {
    const sourceId = insertSource(db, {
      kind: 'import',
      // Tier A covers only our handling of it: the text is hers to keep on her
      // own machine. It says nothing about whether the content is correct.
      licenseTier: 'A',
      groupOrAuthors: 'Imported deck',
      title: input.filename,
      fullText: input.rawText,
    });

    const existing = new Set(
      (
        db
          .prepare('SELECT front, back FROM items WHERE lecture_id = ?')
          .all(input.lectureId) as { front: string; back: string }[]
      ).map((r) => `${r.front.toLowerCase().trim()}|${r.back.toLowerCase().trim()}`),
    );

    const insertRow = db.prepare(
      `INSERT INTO items (id, lecture_id, kind, status, front, back, authored_by, imported_from)
       VALUES (?, ?, 'flashcard', 'pending', ?, ?, 'generated', ?)`,
    );
    const insertCite = db.prepare(
      `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict)
       VALUES (?, ?, ?, ?, ?, 'unverified')`,
    );

    let imported = 0;
    let duplicates = 0;

    for (const card of input.cards) {
      const key = `${card.front.toLowerCase().trim()}|${card.back.toLowerCase().trim()}`;
      if (existing.has(key)) {
        duplicates++;
        continue;
      }
      existing.add(key);

      const id = randomUUID();
      insertRow.run(id, input.lectureId, card.front, card.back, input.filename);
      insertCite.run(randomUUID(), id, sourceId, `${card.front} ${card.back}`, card.back);
      imported++;
    }

    return { sourceId, imported, duplicates };
  });
}

/**
 * Records that she personally stands behind an imported card.
 *
 * This is the only way an imported card becomes studiable, and it is a
 * deliberate transfer of responsibility rather than a verification: no evidence
 * has been produced, she has simply decided the card is right. The citation
 * says exactly that, so a card promoted this way can never be mistaken later
 * for one a lecture backed.
 */
export function vouchItem(db: Db, itemId: string): void {
  const row = db
    .prepare('SELECT imported_from FROM items WHERE id = ?')
    .get(itemId) as { imported_from: string | null } | undefined;
  if (!row) throw new Error('That card does not exist.');
  if (!row.imported_from) {
    // Generated cards must pass the gate, not be waved through it.
    throw new Error('Only an imported card can be vouched for.');
  }

  transaction(db, () => {
    const sourceId = ensureUserSource(db);
    db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(itemId);
    db.prepare(
      `INSERT INTO citations (id, item_id, source_id, claim, excerpt, verdict, checked_at)
       VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'))`,
    ).run(
      randomUUID(),
      itemId,
      sourceId,
      (db.prepare('SELECT back FROM items WHERE id = ?').get(itemId) as { back: string }).back,
      'Checked and kept by you, from an imported deck.',
    );
  });
}
