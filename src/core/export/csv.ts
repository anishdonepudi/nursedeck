import type { Db } from '../db/index.js';
import { listStudiable, listCitations, listItemBlocks } from '../db/repo.js';

/**
 * Deck export.
 *
 * Her cards should never be trapped in this app. CSV/TSV is the universal
 * format -- Anki, Quizlet and every other tool import it -- and needs no
 * dependency, so it cannot rot.
 *
 * Only studiable items are exported: accepted, and backed by a verified
 * citation. Exporting unverified content would push unchecked claims into a
 * tool that has no idea they were never verified.
 */

export type ExportFormat = 'anki-tsv' | 'quizlet-csv';

export interface ExportOptions {
  lectureId?: string;
  format: ExportFormat;
  /** Appends the source quote to the back of each card. */
  includeCitations?: boolean;
}

/** RFC 4180 quoting: double the quotes, wrap if the field needs it. */
function csvField(value: string): string {
  const needsQuote = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

/**
 * TSV has no escape mechanism, so tabs and newlines are replaced rather than
 * quoted. Anki treats a literal newline as a record separator, and a stray tab
 * would silently shift every later column.
 */
function tsvField(value: string): string {
  return value.replace(/\t/g, '    ').replace(/\r?\n/g, '<br>');
}

export interface ExportResult {
  content: string;
  filename: string;
  cardCount: number;
  /** Items skipped because they are not verified, so nothing goes missing silently. */
  skipped: number;
}

export function exportDeck(db: Db, opts: ExportOptions): ExportResult {
  const items = listStudiable(db, opts.lectureId ? { lectureId: opts.lectureId } : {});

  const totalAccepted = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items WHERE status = 'accepted'
          ${opts.lectureId ? 'AND lecture_id = ?' : ''}`,
      )
      .get(...(opts.lectureId ? [opts.lectureId] : [])) as { n: number }
  ).n;

  const tsv = opts.format === 'anki-tsv';
  const sep = tsv ? '\t' : ',';
  const field = tsv ? tsvField : csvField;
  const rows: string[] = [];

  // Anki reads these directives; other importers ignore the comment lines.
  if (tsv) {
    rows.push('#separator:tab');
    rows.push('#html:true');
    rows.push('#columns:Front\tBack\tTags');
  } else {
    rows.push(['Front', 'Back', 'Tags'].join(sep));
  }

  for (const item of items) {
    // A cloze blank must survive as something the reader can still answer.
    const front = item.kind === 'cloze'
      ? item.front.replace(/\{\{([^}]*)\}\}/g, '[...]')
      : item.front;

    let back = item.back;

    if (item.kind === 'nclex') {
      const payload = item.payload as {
        options?: { text: string; isKey: boolean; rationale: string }[];
      } | undefined;
      if (payload?.options) {
        back = payload.options
          // Written as escapes rather than literal glyphs: this is the one
          // place non-ASCII reaches a user-facing file, and escapes keep the
          // source byte length equal to its character length.
          .map((o) => `${o.isKey ? '✓' : '✗'} ${o.text} — ${o.rationale}`)
          .join(tsv ? '<br>' : '\n');
      }
    }

    if (opts.includeCitations !== false) {
      const [citation] = listCitations(db, item.id).filter((c) => c.verdict === 'verified');
      const blocks = listItemBlocks(db, item.id);
      if (citation) {
        const where = blocks.length > 0 ? ` (slide ${blocks.map((b) => b.ordinal).join(', ')})` : '';
        back += `${tsv ? '<br><br>' : '\n\n'}Source${where}: "${citation.excerpt}"`;
      }
    }

    const tags = [item.kind, item.clientNeed?.replace(/\s+/g, '-')].filter(Boolean).join(' ');
    rows.push([field(front), field(back), field(tags)].join(sep));
  }

  return {
    content: rows.join('\n'),
    filename: tsv ? 'nursedeck-anki.txt' : 'nursedeck.csv',
    cardCount: items.length,
    skipped: Math.max(0, totalAccepted - items.length),
  };
}
