import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';

/**
 * Builds a minimal but genuinely valid .pptx for tests.
 *
 * The important trick: the slide parts are deliberately named so that
 * FILENAME ORDER DISAGREES WITH PRESENTATION ORDER. presentation.xml lists
 * rId-referenced slides in the order slide3, slide1, slide2. Any parser that
 * sorts `slideN.xml` numerically will therefore produce the wrong sequence and
 * fail the ordering assertion — which is the whole point of the fixture.
 */

const CT_OVERRIDE_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_OVERRIDE_NOTES =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

interface SlideSpec {
  /** Part name, e.g. 'slide1.xml'. */
  part: string;
  title: string;
  /**
   * A bullet is either plain text, or an explicit list of <a:t> runs.
   *
   * Runs matter: PowerPoint splits one visible line at every formatting
   * change, and the inter-word space often sits at the end of a run or in a
   * run of its own. Trimming runs before joining welds words to numbers, so a
   * fixture that only ever emits one run per line cannot catch that bug.
   */
  bullets: { text?: string; runs?: string[]; level?: number }[];
  notes?: string;
  table?: string[][];
  /** Adds an image relationship pointing at this media part. */
  image?: { part: string; bytes: Buffer };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(text: string, level = 0): string {
  return paragraphRuns([text], level);
}

/** Emits one <a:p> whose visible text is split across several <a:t> runs. */
function paragraphRuns(runs: string[], level = 0): string {
  const pPr = level > 0 ? `<a:pPr lvl="${level}"/>` : '';
  const body = runs
    .map((r) => `<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(r)}</a:t></a:r>`)
    .join('');
  return `<a:p>${pPr}${body}</a:p>`;
}

function tableXml(rows: string[][]): string {
  const trs = rows
    .map(
      (row) =>
        `<a:tr h="0">${row
          .map((cell) => `<a:tc><a:txBody><a:bodyPr/>${paragraph(cell)}</a:txBody></a:tc>`)
          .join('')}</a:tr>`,
    )
    .join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(spec: SlideSpec): string {
  const titleShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraph(spec.title)}</p:txBody></p:sp>`;

  const bodyShape =
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    spec.bullets.map((b) => paragraphRuns(b.runs ?? [b.text ?? ''], b.level ?? 0)).join('') +
    `</p:txBody></p:sp>`;

  const pic = spec.image
    ? `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch/></p:blipFill><p:spPr/></p:pic>`
    : '';

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    titleShape +
    bodyShape +
    (spec.table ? tableXml(spec.table) : '') +
    pic +
    `</p:spTree></p:cSld></p:sld>`
  );
}

function notesXml(notes: string, slideNumber: number): string {
  // Includes a title placeholder carrying the slide number, exactly as
  // PowerPoint does. The parser must exclude it from the notes text.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="7" name="Slide Number"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraph(String(slideNumber))}</p:txBody></p:sp>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="8" name="Notes"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraph(notes)}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:notes>`
  );
}

/** A 1x1 transparent PNG — enough to prove media extraction works. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** A fake EMF: the parser must skip it with a warning rather than fail. */
export const FAKE_EMF = Buffer.from('010000006c000000', 'hex');

export interface BuiltDeck {
  path: string;
  /** Slide titles in true presentation order. */
  expectedOrder: string[];
}

export async function buildTestPptx(outPath: string): Promise<BuiltDeck> {
  const slides: SlideSpec[] = [
    {
      // Named slide1 but listed THIRD in presentation.xml.
      part: 'slide1.xml',
      title: 'Hypokalemia Management',
      bullets: [
        { text: 'Replace potassium by controlled infusion only' },
        { text: 'Never administer potassium chloride by IV push', level: 1 },
      ],
      notes: 'Emphasize that IV push potassium is fatal. This is a classic NCLEX safety item.',
    },
    {
      // Named slide2 but listed SECOND... by coincidence; still resolved by rId.
      part: 'slide2.xml',
      title: 'Potassium Reference Ranges',
      bullets: [
        { text: 'Normal adult serum potassium is 3.5-5.0 mEq/L' },
        // Run split copied verbatim from the user's own deck (slide 10 of
        // "Fluid and Electrolyte Balance"), where underlining the value put
        // the surrounding spaces into runs of their own.
        { runs: ['Normal Osmolality ', '275-295', ' ', 'mOsm', '/kg'] },
      ],
      table: [
        ['Analyte', 'Low', 'High', 'Unit'],
        ['Potassium', '3.5', '5.0', 'mEq/L'],
        ['Sodium', '135', '145', 'mEq/L'],
      ],
      image: { part: 'image1.png', bytes: TINY_PNG },
    },
    {
      // Named slide3 but listed FIRST.
      part: 'slide3.xml',
      title: 'Course Introduction',
      bullets: [{ text: 'Fluid and electrolyte balance' }],
      image: { part: 'image2.emf', bytes: FAKE_EMF },
    },
  ];

  // THE TRAP: presentation order is slide3, slide2, slide1.
  const presentationOrder = ['slide3.xml', 'slide2.xml', 'slide1.xml'];

  const zip = new JSZip();

  const slideOverrides = slides
    .map((s) => `<Override PartName="/ppt/slides/${s.part}" ContentType="${CT_OVERRIDE_SLIDE}"/>`)
    .join('');
  const notesOverrides = slides
    .filter((s) => s.notes)
    .map(
      (s) =>
        `<Override PartName="/ppt/notesSlides/notes-${s.part}" ContentType="${CT_OVERRIDE_NOTES}"/>`,
    )
    .join('');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Default Extension="emf" ContentType="image/x-emf"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      slideOverrides +
      notesOverrides +
      `</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:title>Fluid and Electrolyte Balance - Week 3</dc:title>` +
      `</cp:coreProperties>`,
  );

  // presentation.xml: rIds listed in the intended presentation order.
  const sldIds = presentationOrder
    .map((part, i) => {
      const rid = `rIdS${i + 1}`;
      return `<p:sldId id="${256 + i}" r:id="${rid}"/>`;
    })
    .join('');
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`,
  );

  const presRels = presentationOrder
    .map(
      (part, i) =>
        `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${part}"/>`,
    )
    .join('');
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels}</Relationships>`,
  );

  // A slide layout containing placeholder prompt text. The parser must never
  // read this, or every slide would pick up "Click to add title".
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="PH"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr/><p:txBody><a:bodyPr/>${paragraph('Click to add title')}</p:txBody></p:sp>` +
      `</p:spTree></p:cSld></p:sldLayout>`,
  );

  for (const spec of slides) {
    zip.file(`ppt/slides/${spec.part}`, slideXml(spec));

    const rels: string[] = [];
    if (spec.notes) {
      rels.push(
        `<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes-${spec.part}"/>`,
      );
      const slideNumber = presentationOrder.indexOf(spec.part) + 1;
      zip.file(`ppt/notesSlides/notes-${spec.part}`, notesXml(spec.notes, slideNumber));
    }
    if (spec.image) {
      rels.push(
        `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${spec.image.part}"/>`,
      );
      zip.file(`ppt/media/${spec.image.part}`, spec.image.bytes);
    }
    if (rels.length > 0) {
      zip.file(
        `ppt/slides/_rels/${spec.part}.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
      );
    }
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await writeFile(outPath, buf);

  const byPart = new Map(slides.map((s) => [s.part, s.title]));
  return {
    path: outPath,
    expectedOrder: presentationOrder.map((p) => byPart.get(p)!),
  };
}
