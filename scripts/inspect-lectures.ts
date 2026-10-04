/**
 * Ingests real lecture decks and reports what was extracted.
 *
 * The speaker notes figure is the one that matters most: the student says the
 * notes in the bottom pane are where the exam content actually lives, so a
 * parser that silently drops them would miss the point of the whole tool.
 *
 * Usage: npm run inspect -- <file.pptx>...
 */
import { ingestPptx } from '../src/core/ingest/pptx.js';
import { batchBlocks } from '../src/core/generate/prompts.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx scripts/inspect-lectures.ts <file.pptx>...');
  process.exit(1);
}

let grandTotalNotes = 0;
let grandTotalSlides = 0;

for (const file of files) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(file.split(/[\\/]/).pop());
  console.log('='.repeat(78));

  try {
    const doc = await ingestPptx(file);
    const withNotes = doc.blocks.filter((b) => b.speakerNotes?.trim());
    const withTables = doc.blocks.filter((b) => b.tables?.length);
    const empty = doc.blocks.filter((b) => !b.body.trim() && !b.heading);
    const notesChars = withNotes.reduce((n, b) => n + (b.speakerNotes?.length ?? 0), 0);
    const bodyChars = doc.blocks.reduce((n, b) => n + b.body.length, 0);

    grandTotalNotes += withNotes.length;
    grandTotalSlides += doc.blocks.length;

    console.log(`title        : ${doc.title}`);
    console.log(`slides       : ${doc.blocks.length}`);
    console.log(`with notes   : ${withNotes.length}  (${notesChars.toLocaleString()} chars)`);
    console.log(`body text    : ${bodyChars.toLocaleString()} chars`);
    console.log(`with tables  : ${withTables.length}`);
    console.log(`image-only   : ${empty.length}`);
    console.log(`batches      : ${batchBlocks(doc.blocks, 12_000).length}`);
    if (doc.warnings.length) {
      console.log(`warnings     :`);
      for (const w of doc.warnings.slice(0, 4)) console.log(`  - ${w}`);
      if (doc.warnings.length > 4) console.log(`  ... and ${doc.warnings.length - 4} more`);
    }

    // Show the richest notes slide verbatim, so the extraction can be eyeballed
    // rather than merely counted.
    const richest = [...withNotes].sort(
      (a, b) => (b.speakerNotes?.length ?? 0) - (a.speakerNotes?.length ?? 0),
    )[0];
    if (richest) {
      console.log(`\n--- richest notes, slide ${richest.ordinal}: ${richest.heading ?? '(no heading)'}`);
      console.log(`    BODY : ${richest.body.replace(/\n/g, ' | ').slice(0, 200)}`);
      console.log(`    NOTES: ${richest.speakerNotes?.replace(/\n/g, ' ').slice(0, 600)}`);
    }

    const firstTable = withTables[0];
    if (firstTable?.tables) {
      console.log(`\n--- first table, slide ${firstTable.ordinal}`);
      for (const row of firstTable.tables.slice(0, 4)) {
        console.log(`    | ${row.join(' | ')}`);
      }
    }
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(`TOTAL: ${grandTotalSlides} slides, ${grandTotalNotes} carrying speaker notes`);
