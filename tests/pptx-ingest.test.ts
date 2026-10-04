import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestPptx } from '@core/ingest/pptx.js';
import { buildTestPptx, type BuiltDeck } from './fixtures/make-pptx.js';
import type { LectureDoc } from '@shared/types.js';

let deck: BuiltDeck;
let doc: LectureDoc;
let mediaDir: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nursedeck-pptx-'));
  mediaDir = join(dir, 'media');
  deck = await buildTestPptx(join(dir, 'week3.pptx'));
  doc = await ingestPptx(deck.path, { mediaOutDir: mediaDir });
});

describe('ingestPptx — slide ordering', () => {
  it('orders slides by presentation.xml rIds, NOT by filename', () => {
    // The fixture names its parts slide1/2/3 but lists them as 3, 2, 1.
    // A filename-sorting parser returns the reverse of this.
    expect(doc.blocks.map((b) => b.heading)).toEqual(deck.expectedOrder);
    expect(doc.blocks[0]?.heading).toBe('Course Introduction');
    expect(doc.blocks[2]?.heading).toBe('Hypokalemia Management');
  });

  it('numbers blocks 1..n in presentation order', () => {
    expect(doc.blocks.map((b) => b.ordinal)).toEqual([1, 2, 3]);
  });

  it('gives every block a unique, stable id for citation provenance', () => {
    const ids = doc.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
});

describe('ingestPptx — text extraction', () => {
  it('separates the title placeholder from body content', () => {
    const block = doc.blocks.find((b) => b.heading === 'Potassium Reference Ranges');
    expect(block).toBeDefined();
    expect(block!.body).toContain('3.5-5.0 mEq/L');
    // The heading must not be duplicated into the body.
    expect(block!.body).not.toContain('Potassium Reference Ranges');
  });

  it('preserves bullet indent level as structure', () => {
    const block = doc.blocks.find((b) => b.heading === 'Hypokalemia Management');
    expect(block!.body).toMatch(/^\s+- Never administer potassium chloride by IV push$/m);
  });

  it('NEVER leaks slide layout or master placeholder text', () => {
    // The fixture ships a layout containing "Click to add title".
    const all = JSON.stringify(doc);
    expect(all).not.toContain('Click to add title');
  });
});

describe('ingestPptx — speaker notes', () => {
  it('captures speaker notes, the richest field in a lecture deck', () => {
    const block = doc.blocks.find((b) => b.heading === 'Hypokalemia Management');
    expect(block!.speakerNotes).toContain('IV push potassium is fatal');
  });

  it('excludes the slide-number placeholder from the notes text', () => {
    const block = doc.blocks.find((b) => b.heading === 'Hypokalemia Management');
    // The notes part carries a title placeholder holding "3".
    expect(block!.speakerNotes?.trim().startsWith('3')).toBe(false);
  });

  it('leaves speakerNotes undefined on slides that have none', () => {
    const block = doc.blocks.find((b) => b.heading === 'Course Introduction');
    expect(block!.speakerNotes).toBeUndefined();
  });
});

describe('ingestPptx — tables', () => {
  it('extracts table rows as cell arrays', () => {
    const block = doc.blocks.find((b) => b.heading === 'Potassium Reference Ranges');
    expect(block!.tables).toBeDefined();
    expect(block!.tables).toEqual([
      ['Analyte', 'Low', 'High', 'Unit'],
      ['Potassium', '3.5', '5.0', 'mEq/L'],
      ['Sodium', '135', '145', 'mEq/L'],
    ]);
  });
});

describe('ingestPptx — media', () => {
  it('extracts a raster image and maps it to the citing slide', async () => {
    const block = doc.blocks.find((b) => b.heading === 'Potassium Reference Ranges');
    expect(block!.imageRefs).toHaveLength(1);
    expect(block!.imageRefs![0]).toMatch(/slide2-\d+\.png$/);
    const files = await readdir(mediaDir);
    expect(files.some((f) => f.endsWith('.png'))).toBe(true);
  });

  it('skips EMF/WMF vector images with a warning instead of failing silently', () => {
    const block = doc.blocks.find((b) => b.heading === 'Course Introduction');
    expect(block!.imageRefs).toBeUndefined();
    expect(doc.warnings.some((w) => /vector image \(\.emf\)/.test(w))).toBe(true);
  });
});

describe('ingestPptx — document metadata', () => {
  it('prefers the core property title over the filename', () => {
    expect(doc.title).toBe('Fluid and Electrolyte Balance - Week 3');
  });

  it('records the source file and kind', () => {
    expect(doc.kind).toBe('pptx');
    expect(doc.sourceFile).toBe(deck.path);
  });
});

describe('ingestPptx — error handling', () => {
  it('rejects a file that is not a PowerPoint package with an actionable message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nursedeck-bad-'));
    const bad = join(dir, 'notes.pptx');
    const { writeFile } = await import('node:fs/promises');
    // A valid zip that is not an OOXML presentation.
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('hello.txt', 'not a deck');
    await writeFile(bad, await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(ingestPptx(bad)).rejects.toThrow(/not a valid powerpoint/i);
  });
});
