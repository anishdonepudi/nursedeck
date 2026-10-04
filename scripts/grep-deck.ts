/**
 * Searches a lecture deck's extracted text for a term.
 *
 * Used to settle whether a rejected card was a real hallucination (the value
 * is nowhere in the deck) or merely a mis-targeted citation (the value is in
 * the deck, but the model quoted the wrong span).
 *
 * Usage: tsx scripts/grep-deck.ts <file.pptx> <term>...
 */
import { ingestPptx } from '../src/core/ingest/pptx.js';
import { renderTable } from '../src/core/generate/prompts.js';

const [file, ...terms] = process.argv.slice(2);
if (!file || terms.length === 0) {
  console.error('usage: tsx scripts/grep-deck.ts <file.pptx> <term>...');
  process.exit(1);
}

const doc = await ingestPptx(file);

for (const term of terms) {
  const hits: string[] = [];
  for (const b of doc.blocks) {
    const text = [
      b.heading,
      b.body,
      b.tables?.length ? renderTable(b.tables) : undefined,
      b.speakerNotes,
    ].filter(Boolean).join('\n');

    for (const line of text.split('\n')) {
      if (line.toLowerCase().includes(term.toLowerCase())) {
        hits.push(`slide ${b.ordinal}: ${line.trim().slice(0, 120)}`);
      }
    }
  }

  console.log(`\n"${term}" -> ${hits.length === 0 ? 'NOT IN THE DECK' : `${hits.length} hit(s)`}`);
  for (const h of hits.slice(0, 3)) console.log(`   ${h}`);
}
