import { ingestPptx } from '../src/core/ingest/pptx.js';
import { renderTable } from '../src/core/generate/prompts.js';
import { verifyNumericAgreement, verifyVerbatim } from '../src/core/validate/citation.js';
import type { LectureBlock } from '../src/shared/types.js';

const doc = await ingestPptx(process.argv[2]!);
const text = (b: LectureBlock) =>
  [b.heading, b.body, b.tables?.length ? renderTable(b.tables) : undefined, b.speakerNotes]
    .filter(Boolean).join('\n');

for (const b of doc.blocks) {
  const t = text(b);
  if (!/275/.test(t)) continue;
  console.log(`--- slide ${b.ordinal} heading=${JSON.stringify(b.heading)}`);
  for (const p of t.split(/(?<=[.;:])\s+|\n/).map((x) => x.trim()).filter(Boolean)) {
    if (!/275/.test(p)) continue;
    console.log(`  len=${p.length} ${JSON.stringify(p)}`);
    console.log(`    has 275+295: ${verifyNumericAgreement('275 295', p).ok}  verbatim: ${verifyVerbatim(p, t).ok}`);
  }
}
