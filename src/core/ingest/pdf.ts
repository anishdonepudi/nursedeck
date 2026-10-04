import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import type { LectureDoc, LectureBlock } from '@shared/types.js';

/**
 * PDF ingest.
 *
 * Uses `unpdf` (a maintained pdf.js wrapper) rather than `pdf-parse`, which is
 * unmaintained. One page becomes one block, which matches how lecture PDFs are
 * actually exported from PowerPoint -- so a citation to "page 7" lands on the
 * same content a citation to "slide 7" would.
 */

/** Heuristic: the first short line of a page is usually its heading. */
function splitHeading(pageText: string): { heading?: string; body: string } {
  const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { body: '' };

  const first = lines[0]!;
  const looksLikeHeading =
    first.length <= 80 &&
    !first.endsWith('.') &&
    lines.length > 1;

  return looksLikeHeading
    ? { heading: first, body: lines.slice(1).join('\n') }
    : { body: lines.join('\n') };
}

/**
 * Page furniture that repeats on most pages and is noise, not content.
 * Removed only when it appears on the majority of pages, so a genuine repeated
 * heading in a short document is kept.
 */
function stripRepeatedLines(pages: string[]): string[] {
  if (pages.length < 4) return pages;

  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set(
      page.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 120),
    );
    for (const line of seen) counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const threshold = Math.ceil(pages.length * 0.6);
  const furniture = new Set(
    [...counts.entries()].filter(([, n]) => n >= threshold).map(([line]) => line),
  );
  if (furniture.size === 0) return pages;

  return pages.map((page) =>
    page
      .split('\n')
      .filter((l) => !furniture.has(l.trim()))
      .join('\n'),
  );
}

export async function ingestPdf(filePath: string): Promise<LectureDoc> {
  const warnings: string[] = [];
  const buf = await readFile(filePath);

  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });

  const rawPages = Array.isArray(text) ? text : [String(text)];
  if (rawPages.length === 0) {
    throw new Error('That PDF contains no extractable text.');
  }

  const pages = stripRepeatedLines(rawPages.map((p) => String(p ?? '')));
  const blocks: LectureBlock[] = [];
  let emptyPages = 0;

  for (const [index, pageText] of pages.entries()) {
    const { heading, body } = splitHeading(pageText);
    if (!heading && !body) {
      emptyPages += 1;
      continue;
    }
    const block: LectureBlock = {
      id: `p${index + 1}-${randomUUID().slice(0, 8)}`,
      ordinal: index + 1,
      body,
    };
    if (heading) block.heading = heading;
    blocks.push(block);
  }

  if (emptyPages > 0) {
    warnings.push(
      `${emptyPages} page(s) had no extractable text. If this PDF is a scan, the text is an image ` +
        'and would need to be imported as photos instead.',
    );
  }

  if (blocks.length === 0) {
    throw new Error(
      'No text could be read from that PDF. If it is a scanned document, import it as images instead.',
    );
  }

  let title = basename(filePath, extname(filePath));
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as { Title?: string } | undefined;
    if (info?.Title?.trim()) title = info.Title.trim();
  } catch {
    // Metadata is optional; the filename is a fine fallback.
  }
  if (title === basename(filePath, extname(filePath)) && blocks[0]?.heading) {
    title = blocks[0].heading;
  }

  return {
    id: randomUUID(),
    sourceFile: filePath,
    kind: 'pdf',
    title,
    blocks,
    warnings,
  };
}
