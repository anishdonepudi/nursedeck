import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LectureDoc, LectureBlock } from '@shared/types.js';

/**
 * PowerPoint ingest, written against the OOXML package directly.
 *
 * We own this rather than delegating entirely to a library because three things
 * matter here and are routinely got wrong:
 *
 * 1. SLIDE ORDER. Slides must be ordered by the rIds in
 *    ppt/presentation.xml <p:sldIdLst>, resolved through
 *    ppt/_rels/presentation.xml.rels. Sorting slide1..slideN by filename is
 *    wrong: PowerPoint reuses and reorders those part names freely, so a
 *    reordered deck parses in the wrong sequence and every "slide N" citation
 *    then points at the wrong content.
 * 2. SPEAKER NOTES. Usually the richest prose in a lecture deck and the thing
 *    most converters drop.
 * 3. LAYOUT/MASTER TEXT. Must be excluded, or every deck yields placeholder
 *    noise like "Click to add title".
 */

const A_NS_TEXT = 'a:t';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Keep single elements as objects; we normalise with toArray() below.
  isArray: () => false,
  parseTagValue: false,
  // MUST stay false. PowerPoint splits a single visible line into many <a:t>
  // runs at every formatting change, and the space between words frequently
  // lands at the end of one run or in a run of its own:
  //   <a:t>Normal Osmolality </a:t><a:t>275-295</a:t><a:t> </a:t><a:t>mOsm</a:t>
  // Trimming each run concatenates that to "Normal Osmolality275-295mOsm",
  // which silently corrupts the lecture text. It cost a real card: the numeric
  // verifier could not see "275" glued to a letter, so a correct osmolality
  // card was rejected as unsupported. Lines are trimmed as whole lines below.
  trimValues: false,
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Depth-first collection of every <a:t> text run under a node, in document order. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === A_NS_TEXT) {
      for (const t of toArray(value)) {
        const s = typeof t === 'string' ? t : String((t as Record<string, unknown>)?.['#text'] ?? '');
        if (s) out.push(s);
      }
    } else if (key.startsWith('@')) {
      continue;
    } else {
      collectText(value, out);
    }
  }
  return out;
}

/** Paragraph-aware extraction: one output line per <a:p>, preserving indent level. */
function collectParagraphs(node: unknown, out: { text: string; level: number }[] = []): typeof out {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) collectParagraphs(c, out);
    return out;
  }
  const rec = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(rec)) {
    if (key === 'a:p') {
      for (const para of toArray(value)) {
        const runs = collectText(para).join('').trim();
        const pPr = (para as Record<string, unknown>)?.['a:pPr'] as
          | Record<string, unknown>
          | undefined;
        const level = Number(pPr?.['@lvl'] ?? 0);
        if (runs) out.push({ text: runs, level: Number.isFinite(level) ? level : 0 });
      }
    } else if (!key.startsWith('@')) {
      collectParagraphs(value, out);
    }
  }
  return out;
}

/** True when a shape is the slide's title placeholder. */
function isTitleShape(shape: Record<string, unknown>): boolean {
  const nvSpPr = shape['p:nvSpPr'] as Record<string, unknown> | undefined;
  const nvPr = nvSpPr?.['p:nvPr'] as Record<string, unknown> | undefined;
  const ph = nvPr?.['p:ph'] as Record<string, unknown> | undefined;
  const type = String(ph?.['@type'] ?? '');
  return type === 'title' || type === 'ctrTitle';
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

function parseRels(xml: string | undefined): Relationship[] {
  if (!xml) return [];
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rels = (doc['Relationships'] as Record<string, unknown> | undefined)?.['Relationship'];
  return toArray(rels).map((r) => {
    const rec = r as Record<string, unknown>;
    return {
      id: String(rec['@Id'] ?? ''),
      type: String(rec['@Type'] ?? ''),
      target: String(rec['@Target'] ?? ''),
    };
  });
}

/** Resolves a relationship target (often "../media/x.png") against a part's directory. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const dir = fromPart.split('/').slice(0, -1).join('/');
  const segments = `${dir}/${target}`.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

function extractTables(slideNode: unknown): string[][] {
  const tables: string[][] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    const rec = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'a:tbl') {
        for (const tbl of toArray(value)) {
          const rows = toArray((tbl as Record<string, unknown>)['a:tr']);
          for (const row of rows) {
            const cells = toArray((row as Record<string, unknown>)['a:tc']);
            const rowText = cells.map((c) => collectText(c).join('').trim());
            if (rowText.some((t) => t.length > 0)) tables.push(rowText);
          }
        }
      } else if (!key.startsWith('@')) {
        walk(value);
      }
    }
  };
  walk(slideNode);
  return tables;
}

export interface PptxIngestOptions {
  /** When set, slide media is written here and referenced by the blocks. */
  mediaOutDir?: string;
}

const RELTYPE_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const RELTYPE_NOTES =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const RELTYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** Formats PowerPoint lacks text for; they fail silently if handed to a decoder. */
const VECTOR_IMAGE_EXT = new Set(['.emf', '.wmf', '.emz', '.wmz']);

export async function ingestPptx(
  filePath: string,
  opts: PptxIngestOptions = {},
): Promise<LectureDoc> {
  const warnings: string[] = [];
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);

  const readText = async (part: string): Promise<string | undefined> => {
    const f = zip.file(part);
    return f ? await f.async('string') : undefined;
  };

  // --- Slide order: authoritative, via presentation.xml rIds ---
  const presentationXml = await readText('ppt/presentation.xml');
  if (!presentationXml) {
    throw new Error(
      'Not a valid PowerPoint file: ppt/presentation.xml is missing. ' +
        'If this is an old .ppt file, re-save it as .pptx.',
    );
  }
  const presRels = parseRels(await readText('ppt/_rels/presentation.xml.rels'));
  const relById = new Map(presRels.map((r) => [r.id, r]));

  const presDoc = parser.parse(presentationXml) as Record<string, unknown>;
  const presentation = presDoc['p:presentation'] as Record<string, unknown> | undefined;
  const sldIdLst = presentation?.['p:sldIdLst'] as Record<string, unknown> | undefined;
  const sldIds = toArray(sldIdLst?.['p:sldId']);

  const orderedSlideParts: string[] = [];
  for (const sldId of sldIds) {
    const rid = String((sldId as Record<string, unknown>)['@r:id'] ?? '');
    const rel = relById.get(rid);
    if (!rel || rel.type !== RELTYPE_SLIDE) {
      warnings.push(`Slide reference ${rid} could not be resolved and was skipped.`);
      continue;
    }
    orderedSlideParts.push(resolveTarget('ppt/presentation.xml', rel.target));
  }

  if (orderedSlideParts.length === 0) {
    warnings.push('No slides found via presentation.xml; falling back to filename order.');
    const fallback = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml/.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    orderedSlideParts.push(...fallback);
  }

  const blocks: LectureBlock[] = [];
  let mediaCount = 0;

  for (const [index, slidePart] of orderedSlideParts.entries()) {
    const slideXml = await readText(slidePart);
    if (!slideXml) {
      warnings.push(`Slide part ${slidePart} is missing from the package.`);
      continue;
    }

    const slideDoc = parser.parse(slideXml) as Record<string, unknown>;
    const sld = slideDoc['p:sld'] as Record<string, unknown> | undefined;
    const cSld = sld?.['p:cSld'] as Record<string, unknown> | undefined;
    const spTree = cSld?.['p:spTree'] as Record<string, unknown> | undefined;

    // Only shapes on the slide itself. Layouts and masters are never read,
    // which is what keeps placeholder prompts out of the output.
    const shapes = toArray(spTree?.['p:sp']) as Record<string, unknown>[];

    let heading: string | undefined;
    const bodyLines: string[] = [];

    for (const shape of shapes) {
      const paragraphs = collectParagraphs(shape);
      if (paragraphs.length === 0) continue;
      const text = paragraphs
        .map((p) => (p.level > 0 ? `${'  '.repeat(p.level)}- ${p.text}` : p.text))
        .join('\n');

      if (isTitleShape(shape) && heading === undefined) {
        heading = paragraphs.map((p) => p.text).join(' ').trim();
      } else {
        bodyLines.push(text);
      }
    }

    // --- Speaker notes, via the slide's own relationships ---
    const slideRels = parseRels(
      await readText(slidePart.replace(/\/([^/]+)$/, '/_rels/$1.rels')),
    );
    let speakerNotes: string | undefined;
    const notesRel = slideRels.find((r) => r.type === RELTYPE_NOTES);
    if (notesRel) {
      const notesPart = resolveTarget(slidePart, notesRel.target);
      const notesXml = await readText(notesPart);
      if (notesXml) {
        const notesDoc = parser.parse(notesXml) as Record<string, unknown>;
        const notesSld = notesDoc['p:notes'] as Record<string, unknown> | undefined;
        const notesTree = (notesSld?.['p:cSld'] as Record<string, unknown> | undefined)?.[
          'p:spTree'
        ];
        // Exclude the slide-image placeholder, which carries the slide number.
        const noteShapes = toArray(
          (notesTree as Record<string, unknown> | undefined)?.['p:sp'],
        ) as Record<string, unknown>[];
        const text = noteShapes
          .filter((s) => !isTitleShape(s))
          .map((s) => collectParagraphs(s).map((p) => p.text).join('\n'))
          .join('\n')
          .trim();
        if (text) speakerNotes = text;
      }
    }

    // --- Images, mapped to the slide that references them ---
    const imageRefs: string[] = [];
    if (opts.mediaOutDir) {
      for (const rel of slideRels.filter((r) => r.type === RELTYPE_IMAGE)) {
        const mediaPart = resolveTarget(slidePart, rel.target);
        const ext = extname(mediaPart).toLowerCase();
        if (VECTOR_IMAGE_EXT.has(ext)) {
          // Pasted Office diagrams. No raster decoder handles these, and they
          // would otherwise fail silently later in the vision pass.
          warnings.push(
            `Slide ${index + 1}: skipped a vector image (${ext}) that cannot be read as a bitmap.`,
          );
          continue;
        }
        const file = zip.file(mediaPart);
        if (!file) {
          warnings.push(`Slide ${index + 1}: referenced image ${mediaPart} is missing.`);
          continue;
        }
        await mkdir(opts.mediaOutDir, { recursive: true });
        const outName = `slide${index + 1}-${mediaCount++}${ext}`;
        const outPath = join(opts.mediaOutDir, outName);
        await writeFile(outPath, await file.async('nodebuffer'));
        imageRefs.push(outPath);
      }
    }

    const tables = extractTables(spTree);

    const block: LectureBlock = {
      id: `b${index + 1}-${randomUUID().slice(0, 8)}`,
      ordinal: index + 1,
      body: bodyLines.join('\n').trim(),
    };
    if (heading) block.heading = heading;
    if (speakerNotes) block.speakerNotes = speakerNotes;
    if (tables.length > 0) block.tables = tables;
    if (imageRefs.length > 0) block.imageRefs = imageRefs;

    blocks.push(block);
  }

  // Deck title: the core property if it says anything, else the first slide's
  // heading, else the filename.
  //
  // PowerPoint leaves a placeholder in dc:title on decks exported from some
  // tools, and real lecture decks do carry it — two of four test decks were
  // literally titled "PowerPoint Presentation". A generic value is worse than
  // the filename, which at least names the topic.
  const GENERIC_TITLES = new Set([
    'powerpoint presentation',
    'presentation',
    'untitled presentation',
    'slide 1',
  ]);

  let title = basename(filePath, extname(filePath));
  const coreXml = await readText('docProps/core.xml');
  if (coreXml) {
    const core = parser.parse(coreXml) as Record<string, unknown>;
    const props = core['cp:coreProperties'] as Record<string, unknown> | undefined;
    const dcTitle = props?.['dc:title'];
    const t = typeof dcTitle === 'string' ? dcTitle : String(
      (dcTitle as Record<string, unknown> | undefined)?.['#text'] ?? '',
    );
    if (t.trim() && !GENERIC_TITLES.has(t.trim().toLowerCase())) title = t.trim();
  }
  if (title === basename(filePath, extname(filePath)) && blocks[0]?.heading) {
    title = blocks[0].heading;
  }

  const empty = blocks.filter((b) => !b.body && !b.heading && !b.speakerNotes).length;
  if (empty > 0) {
    warnings.push(`${empty} slide(s) contained no extractable text (likely image-only).`);
  }

  return {
    id: randomUUID(),
    sourceFile: filePath,
    kind: 'pptx',
    title,
    blocks,
    warnings,
  };
}
