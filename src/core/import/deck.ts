/**
 * Importing a deck somebody else made.
 *
 * The point of this tool is that every claim is checkable. An imported card
 * fails that by construction: a classmate's Quizlet set carries no evidence,
 * and shared user-generated decks are exactly the unreliable source this app
 * exists to replace.
 *
 * So the import is honest about what it has. Cards arrive as PENDING with an
 * UNVERIFIED citation and cannot be studied. What the citation does prove is
 * narrower but real: the source row holds the raw file, and the excerpt is the
 * card's own text, so the verbatim check confirms the import did not mangle
 * anything. Making a card studiable requires her to vouch for it in triage,
 * which records HER as the party standing behind it -- the same honest footing
 * as a card she wrote.
 */

export type DeckDialect = 'anki-tsv' | 'quizlet-csv' | 'auto';

export interface ParsedRow {
  front: string;
  back: string;
  tags: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  dialect: Exclude<DeckDialect, 'auto'>;
  /** Lines that could not be read as a card, so nothing vanishes quietly. */
  skipped: { line: number; text: string; reason: string }[];
}

/** Splits one delimited line, honouring RFC 4180 double-quote quoting. */
export function splitDelimited(line: string, sep: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is a literal quote; a single one closes the field.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === sep) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Anki's text export puts directives in leading comment lines. "#separator:tab"
 * is the one that matters: guessing the delimiter from a file that declares it
 * would be choosing to be wrong.
 */
function readDirectives(lines: string[]): { sep?: string; consumed: number } {
  let consumed = 0;
  let sep: string | undefined;

  for (const line of lines) {
    if (!line.startsWith('#')) break;
    consumed++;
    const m = /^#separator:(.+)$/i.exec(line.trim());
    if (m) {
      const value = m[1]!.trim().toLowerCase();
      if (value === 'tab' || value === '\\t') sep = '\t';
      else if (value === 'comma') sep = ',';
      else if (value === 'semicolon') sep = ';';
      else if (value.length === 1) sep = value;
    }
  }
  return { ...(sep ? { sep } : {}), consumed };
}

/** Picks the delimiter that yields the most consistent column count. */
function sniffSeparator(sampleLines: string[]): string {
  const candidates = ['\t', ',', ';'];
  let best = '\t';
  let bestScore = -1;

  for (const sep of candidates) {
    const counts = sampleLines.map((l) => splitDelimited(l, sep).length);
    const multi = counts.filter((n) => n >= 2).length;
    // Prefer the separator that produces >= 2 columns on the most lines, and
    // break ties toward a stable column count rather than a large one.
    const spread = new Set(counts).size;
    const score = multi * 10 - spread;
    if (score > bestScore) {
      bestScore = score;
      best = sep;
    }
  }
  return best;
}

/** Anki fields are HTML; study text is not. */
function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|p|li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Last, or it would un-escape the entities above into new entities.
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Recognises a header row so column titles do not become a card. */
function looksLikeHeader(cells: string[]): boolean {
  const [a, b] = cells.map((c) => c.trim().toLowerCase());
  return (
    (a === 'front' && (b === 'back' || b === 'answer')) ||
    (a === 'question' && (b === 'answer' || b === 'back')) ||
    (a === 'term' && b === 'definition')
  );
}

export function parseDeckText(text: string, dialect: DeckDialect = 'auto'): ParseResult {
  const skipped: ParseResult['skipped'] = [];
  const allLines = text.replace(/^﻿/, '').split(/\r?\n/);

  const { sep: declared, consumed } = readDirectives(allLines);
  const body = allLines.slice(consumed);

  const sep =
    dialect === 'anki-tsv'
      ? '\t'
      : dialect === 'quizlet-csv'
        ? ','
        : (declared ?? sniffSeparator(body.filter((l) => l.trim()).slice(0, 20)));

  const rows: ParsedRow[] = [];
  let first = true;

  for (let i = 0; i < body.length; i++) {
    const raw = body[i]!;
    if (!raw.trim()) continue;

    const cells = splitDelimited(raw, sep).map(stripHtml);
    if (first && looksLikeHeader(cells)) {
      first = false;
      continue;
    }
    first = false;

    const front = cells[0] ?? '';
    const back = cells[1] ?? '';

    if (!front || !back) {
      skipped.push({
        line: consumed + i + 1,
        text: raw.slice(0, 120),
        reason: !front && !back ? 'no question or answer' : !back ? 'no answer' : 'no question',
      });
      continue;
    }

    const tags = (cells[2] ?? '')
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    rows.push({ front, back, tags });
  }

  return {
    rows,
    dialect: sep === '\t' ? 'anki-tsv' : 'quizlet-csv',
    skipped,
  };
}

/**
 * Collapses rows that are the same card twice.
 *
 * Shared decks are routinely assembled from other shared decks, so duplicates
 * are the normal case rather than the exception.
 */
export function dedupeRows(rows: ParsedRow[]): { rows: ParsedRow[]; duplicates: number } {
  const seen = new Map<string, ParsedRow>();
  let duplicates = 0;

  // Trimmed as well as whitespace-collapsed. A trailing space does not make a
  // different card, and shared decks are full of them.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const r of rows) {
    const key = `${norm(r.front)}|${norm(r.back)}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.set(key, r);
  }

  return { rows: [...seen.values()], duplicates };
}
