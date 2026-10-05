import { CLI_AVAILABLE } from './fixtures/has-cli.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { ingestPdf } from '@core/ingest/pdf.js';
import { ingestDocx } from '@core/ingest/docx.js';
import { ingestImages } from '@core/ingest/image.js';
import { openDb } from '@core/db/index.js';
import { insertLecture, listPending, listCitations } from '@core/db/repo.js';
import { generateForLecture } from '@core/generate/pipeline.js';
import { verifyVerbatim } from '@core/validate/citation.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nursedeck-formats-'));
});

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

/** Builds a minimal but genuine .docx. */
async function makeDocx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );

  const p = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      p('Electrolyte Study Guide', 'Heading1') +
      p('Normal adult serum potassium is 3.5-5.0 mEq/L.') +
      p('Hypokalemia is a potassium below 3.5 mEq/L.') +
      p('Digoxin Safety', 'Heading1') +
      p('Hold digoxin if the apical pulse is below 60 beats per minute.') +
      `</w:body></w:document>`,
  );

  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('Word ingest', () => {
  it('splits into citable sections on headings', async () => {
    const path = join(dir, 'guide.docx');
    await makeDocx(path);
    const doc = await ingestDocx(path);

    expect(doc.kind).toBe('docx');
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    expect(doc.blocks.map((b) => b.heading)).toContain('Electrolyte Study Guide');
    expect(doc.blocks.map((b) => b.heading)).toContain('Digoxin Safety');

    const electrolytes = doc.blocks.find((b) => b.heading === 'Electrolyte Study Guide');
    expect(electrolytes?.body).toContain('3.5-5.0 mEq/L');
    // Content must land under its own heading, not the next one.
    expect(electrolytes?.body).not.toContain('apical pulse');
  });

  it('numbers blocks from 1 in document order', async () => {
    const path = join(dir, 'guide2.docx');
    await makeDocx(path);
    const doc = await ingestDocx(path);
    expect(doc.blocks.map((b) => b.ordinal)).toEqual(
      doc.blocks.map((_, i) => i + 1),
    );
  });

  it('takes the title from the first heading', async () => {
    const path = join(dir, 'guide3.docx');
    await makeDocx(path);
    expect((await ingestDocx(path)).title).toBe('Electrolyte Study Guide');
  });

  it('rejects a document with no readable text', async () => {
    const path = join(dir, 'empty.docx');
    const zip = new JSZip();
    zip.file('hello.txt', 'not a document');
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(ingestDocx(path)).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/** A minimal two-page PDF with real text operators. */
async function makePdf(path: string): Promise<void> {
  const page = (text: string[]) =>
    `BT /F1 14 Tf 50 700 Td ${text
      .map((l, i) => `${i === 0 ? '' : '0 -20 Td '}(${l.replace(/([()\\])/g, '\\$1')}) Tj`)
      .join(' ')} ET`;

  const contents = [
    page(['Potassium Balance', 'Normal adult serum potassium is 3.5-5.0 mEq/L.']),
    page(['Digoxin Safety', 'Hold digoxin if the apical pulse is below 60 beats per minute.']),
  ];

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>`;
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>';
  objects[5] = `<< /Length ${contents[0]!.length} >>\nstream\n${contents[0]}\nendstream`;
  objects[6] = `<< /Length ${contents[1]!.length} >>\nstream\n${contents[1]}\nendstream`;
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  await writeFile(path, Buffer.from(pdf, 'latin1'));
}

describe('PDF ingest', () => {
  it('makes one citable block per page, in order', async () => {
    const path = join(dir, 'slides.pdf');
    await makePdf(path);
    const doc = await ingestPdf(path);

    expect(doc.kind).toBe('pdf');
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks.map((b) => b.ordinal)).toEqual([1, 2]);
    // Page numbering must line up with what a citation will claim.
    expect(`${doc.blocks[0]?.heading} ${doc.blocks[0]?.body}`).toContain('3.5-5.0');
    expect(`${doc.blocks[1]?.heading} ${doc.blocks[1]?.body}`).toContain('60 beats per minute');
  });

  it('separates a short leading line as the page heading', async () => {
    const path = join(dir, 'slides2.pdf');
    await makePdf(path);
    const doc = await ingestPdf(path);
    expect(doc.blocks[0]?.heading).toBe('Potassium Balance');
    expect(doc.blocks[0]?.body).not.toContain('Potassium Balance');
  });

  it('explains what to do when a PDF has no text layer', async () => {
    const path = join(dir, 'broken.pdf');
    await writeFile(path, Buffer.from('%PDF-1.4\nnot really a pdf\n'));
    await expect(ingestPdf(path)).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Photographs — transcribed by the Claude CLI                         */
/* ------------------------------------------------------------------ */

describe.skipIf(!CLI_AVAILABLE)('photo ingest', () => {
  let imagePath: string;
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-img-ws-'));
    imagePath = join(dir, 'notes.png');
    // Renders a page of notes as a PNG, so no photograph has to be committed.
    execFileSync(process.execPath, ['tests/fixtures/make-note-image.mjs', imagePath]);
  });

  it('transcribes handwriting-style notes through the CLI', async () => {
    const doc = await ingestImages([imagePath], { workspaceDir, model: 'sonnet' });

    expect(doc.kind).toBe('image');
    expect(doc.blocks.length).toBeGreaterThan(0);

    const all = doc.blocks.map((b) => `${b.heading ?? ''} ${b.body}`).join('\n').toUpperCase();
    // The values on the page must survive transcription verbatim: they are what
    // every downstream citation will be checked against.
    expect(all).toContain('3.5');
    expect(all).toContain('5.0');
    expect(all).toMatch(/HYPOKALEMIA/);
    expect(all).toMatch(/IV PUSH/);
  }, 300_000);

  it('rejects a file that is not an image', async () => {
    const txt = join(dir, 'notes.txt');
    await writeFile(txt, 'hello', 'utf8');
    await expect(ingestImages([txt], { workspaceDir })).rejects.toThrow(
      /are images NurseDeck can read/i,
    );
  });

  it('generates cards grounded in the transcript, not in prior knowledge', async () => {
    const doc = await ingestImages([imagePath], { workspaceDir, model: 'sonnet' });

    const db = openDb({ path: ':memory:' });
    const { sourceId } = insertLecture(db, doc);

    const report = await generateForLecture(db, doc, sourceId, {
      kinds: ['flashcard'],
      workspaceDir,
      model: 'sonnet',
      maxBudgetUsd: 2,
    });
    expect(report.errors).toEqual([]);

    // The transcript is the source of record, so every quote must appear in it.
    const transcript = doc.blocks
      .map((b) => [b.heading, b.body].filter(Boolean).join('\n'))
      .join('\n\n');

    for (const item of listPending(db, doc.id)) {
      for (const c of listCitations(db, item.id)) {
        expect(
          verifyVerbatim(c.excerpt, transcript).ok,
          `quote not in the transcript: "${c.excerpt}"`,
        ).toBe(true);
      }
    }
  }, 600_000);
});
