import { ingestPptx } from '../src/core/ingest/pptx.js';
import { renderTable } from '../src/core/generate/prompts.js';
const doc = await ingestPptx(process.argv[2]!);
const want = new Set(process.argv.slice(3).map(Number));
for (const b of doc.blocks) {
  if (!want.has(b.ordinal)) continue;
  console.log(`\n===== SLIDE ${b.ordinal} =====`);
  console.log(`HEADING: ${JSON.stringify(b.heading)}`);
  console.log(`BODY:\n${b.body}`);
  if (b.tables?.length) console.log(`TABLES:\n${renderTable(b.tables)}`);
  console.log(`NOTES:\n${(b.speakerNotes ?? '').slice(0, 600)}`);
}
