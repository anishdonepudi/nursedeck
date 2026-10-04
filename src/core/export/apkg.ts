import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Db } from '../db/index.js';
import { listStudiable, listCitations, listItemBlocks, type ItemRow } from '../db/repo.js';
import { readCardState } from '../scheduler/fsrs.js';

/**
 * Anki package (.apkg) export.
 *
 * CSV already gets her cards out of here, but it loses two things that matter:
 * the deck structure, and the scheduling. A .apkg carries both, so moving to
 * Anki does not mean re-learning cards she already knows.
 *
 * What this deliberately does NOT do is export her review history. Anki's own
 * FSRS would then re-optimize weights from logs produced by a different
 * implementation of the same algorithm, and a disagreement there shows up as
 * wrong intervals rather than as an error. Instead the deck ships with her
 * desired retention set, and the cards start fresh in Anki's scheduler. That is
 * an honest, visible reset rather than a silent corruption.
 */

/** Only studiable items leave the app: accepted, and backed by a verified citation. */
export interface ApkgOptions {
  lectureId?: string;
  /** Deck name shown in Anki. Subdecks use "::". */
  deckName?: string;
  /** Appends the cited quote and slide number to the back of each card. */
  includeCitations?: boolean;
  /** 0.7-0.99. Carried into the deck's FSRS preset. */
  desiredRetention?: number;
}

export interface ApkgResult {
  bytes: Uint8Array;
  filename: string;
  cardCount: number;
  /** Accepted items left behind because they are not verified. */
  skipped: number;
}

/** Escapes text that is about to sit inside an Anki field (fields are HTML). */
function htmlField(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

/** The back of a card, including per-option rationales for NCLEX items. */
function renderBack(db: Db, item: ItemRow, includeCitations: boolean): string {
  let back = htmlField(item.back);

  if (item.kind === 'nclex') {
    const payload = item.payload as
      | { options?: { text: string; isKey: boolean; rationale: string }[] }
      | undefined;
    if (payload?.options) {
      back = payload.options
        .map((o) => {
          const mark = o.isKey ? '✓' : '✗';
          return `${mark} ${htmlField(o.text)} — ${htmlField(o.rationale)}`;
        })
        .join('<br>');
    }
  }

  if (includeCitations) {
    const [citation] = listCitations(db, item.id).filter((c) => c.verdict === 'verified');
    if (citation) {
      const blocks = listItemBlocks(db, item.id);
      const where = blocks.length > 0 ? ` (slide ${blocks.map((b) => b.ordinal).join(', ')})` : '';
      // The citation is the whole point of this tool, so it travels with the
      // card. A card that arrives in Anki without its source is unverifiable.
      back += `<br><br><i>Source${where}: "${htmlField(citation.excerpt)}"</i>`;
    }
  }

  return back;
}

/**
 * sql.js ships as CommonJS with a WASM payload beside it. It is loaded through
 * createRequire and fed the wasm bytes explicitly, because the default loader
 * resolves the .wasm relative to the page in a bundled Electron main process
 * and silently fails to find it.
 */
async function initSqlJs(): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const factory = require('sql.js') as (config: {
    wasmBinary: Uint8Array;
  }) => Promise<unknown>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const wasmBinary = await readFile(wasmPath);
  return factory({ wasmBinary });
}

export async function exportApkg(db: Db, opts: ApkgOptions = {}): Promise<ApkgResult> {
  const { Package, Deck, DeckConfig, Note, Notetype } = await import('ankipack');

  const items = listStudiable(db, opts.lectureId ? { lectureId: opts.lectureId } : {});
  const totalAccepted = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE status = 'accepted'
          ${opts.lectureId ? 'AND lecture_id = ?' : ''}`,
      )
      .get(...(opts.lectureId ? [opts.lectureId] : [])) as { n: number }
  ).n;

  const retention = opts.desiredRetention ?? 0.9;
  const deck = new Deck({
    name: opts.deckName ?? 'NurseDeck',
    description:
      'Exported from NurseDeck. Every card carries the lecture quote it came from.',
    config: new DeckConfig({
      name: 'NurseDeck',
      desiredRetention: retention,
      // Her own scheduler counts a lapse against the card, so the leech
      // threshold travels too -- otherwise a card she keeps failing here stops
      // being flagged the moment it moves.
      leechThreshold: 8,
      leechAction: 'tagOnly',
    }),
  });

  const basic = Notetype.basic();
  const cloze = Notetype.cloze();
  const includeCitations = opts.includeCitations !== false;

  for (const item of items) {
    const state = readCardState(db, item.id);
    const tags = [
      `nursedeck::${item.kind}`,
      ...(item.clientNeed ? [`nursedeck::${item.clientNeed.replace(/\s+/g, '-')}`] : []),
      // Marks cards she had already learned here, so a reset interval in Anki
      // is explicable rather than mysterious.
      ...(state ? ['nursedeck::studied-here'] : []),
    ];

    if (item.kind === 'cloze') {
      // Anki's cloze syntax is {{c1::text}}; ours is {{text}}. Numbered
      // sequentially so multiple blanks in one sentence stay separable.
      let n = 0;
      const text = item.front.replace(/\{\{([^}]*)\}\}/g, (_m, inner: string) => {
        n += 1;
        return `{{c${n}::${htmlField(inner)}}}`;
      });
      deck.addNote(
        new Note({
          notetype: cloze,
          fields: [n > 0 ? text : htmlField(item.front), renderBack(db, item, includeCitations)],
          tags,
        }),
      );
      continue;
    }

    deck.addNote(
      new Note({
        notetype: basic,
        fields: [htmlField(item.front), renderBack(db, item, includeCitations)],
        tags,
      }),
    );
  }

  const pkg = new Package();
  pkg.addDeck(deck);

  const SQL = await initSqlJs();
  const bytes = await pkg.toUint8Array(SQL as never);

  return {
    bytes,
    filename: 'nursedeck.apkg',
    cardCount: items.length,
    skipped: Math.max(0, totalAccepted - items.length),
  };
}
