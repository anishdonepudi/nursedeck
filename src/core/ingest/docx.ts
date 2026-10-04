import { basename, extname } from 'node:path';
import mammoth from 'mammoth';
import { randomUUID } from 'node:crypto';
import type { LectureDoc, LectureBlock } from '@shared/types.js';

/**
 * Word ingest.
 *
 * Uses mammoth's HTML output rather than its raw text, because headings are the
 * only structure a study guide reliably has. Splitting on headings gives
 * citable blocks that correspond to sections a student would recognise, instead
 * of arbitrary page breaks.
 */

interface Section {
  heading?: string;
  lines: string[];
  tables: string[][];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Parses mammoth's HTML into heading-delimited sections. */
function toSections(html: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { lines: [], tables: [] };

  // Each top-level element in document order.
  const elementRe = /<(h[1-6]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(elementRe)) {
    const tag = (match[1] ?? '').toLowerCase();
    const inner = match[2] ?? '';

    if (/^h[1-6]$/.test(tag)) {
      // A heading starts a new section, but only once the previous one has
      // content -- consecutive headings would otherwise produce empty blocks.
      if (current.heading || current.lines.length > 0 || current.tables.length > 0) {
        sections.push(current);
      }
      current = { heading: stripTags(inner), lines: [], tables: [] };
      continue;
    }

    if (tag === 'table') {
      for (const row of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...(row[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
          .map((c) => stripTags(c[1] ?? ''));
        if (cells.some((c) => c.length > 0)) current.tables.push(cells);
      }
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      for (const li of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = stripTags(li[1] ?? '');
        if (text) current.lines.push(`- ${text}`);
      }
      continue;
    }

    const text = stripTags(inner);
    if (text) current.lines.push(text);
  }

  if (current.heading || current.lines.length > 0 || current.tables.length > 0) {
    sections.push(current);
  }
  return sections;
}

/**
 * Very long sections are split so a single block does not become too large to
 * cite precisely -- a citation pointing at twenty pages proves little.
 */
const MAX_BLOCK_CHARS = 4_000;

function splitLongSection(section: Section): Section[] {
  const total = section.lines.join('\n').length;
  if (total <= MAX_BLOCK_CHARS) return [section];

  const out: Section[] = [];
  let lines: string[] = [];
  let size = 0;
  let part = 1;

  for (const line of section.lines) {
    if (size + line.length > MAX_BLOCK_CHARS && lines.length > 0) {
      out.push({
        ...(section.heading ? { heading: `${section.heading} (${part})` } : {}),
        lines,
        tables: [],
      });
      lines = [];
      size = 0;
      part += 1;
    }
    lines.push(line);
    size += line.length;
  }
  if (lines.length > 0) {
    out.push({
      ...(section.heading ? { heading: `${section.heading} (${part})` } : {}),
      lines,
      tables: section.tables,
    });
  }
  return out;
}

export async function ingestDocx(filePath: string): Promise<LectureDoc> {
  const warnings: string[] = [];

  const result = await mammoth.convertToHtml({ path: filePath });
  for (const message of result.messages) {
    if (message.type === 'warning') warnings.push(message.message);
  }

  const sections = toSections(result.value).flatMap(splitLongSection);
  const blocks: LectureBlock[] = [];

  for (const [index, section] of sections.entries()) {
    const body = section.lines.join('\n');
    if (!body && !section.heading && section.tables.length === 0) continue;

    const block: LectureBlock = {
      id: `s${index + 1}-${randomUUID().slice(0, 8)}`,
      ordinal: blocks.length + 1,
      body,
    };
    if (section.heading) block.heading = section.heading;
    if (section.tables.length > 0) block.tables = section.tables;
    blocks.push(block);
  }

  if (blocks.length === 0) {
    throw new Error('No text could be read from that Word document.');
  }

  let title = basename(filePath, extname(filePath));
  if (blocks[0]?.heading) title = blocks[0].heading;

  return {
    id: randomUUID(),
    sourceFile: filePath,
    kind: 'docx',
    title,
    blocks,
    warnings,
  };
}
