import { ingestPptx } from '../src/core/ingest/pptx.js';

/** How much of each deck is taught only inside a picture. */
for (const file of process.argv.slice(2)) {
  const doc = await ingestPptx(file, { mediaOutDir: process.env['MEDIA_DIR']! });
  const name = file.split(/[\/]/).pop();
  let imageOnly = 0, withImages = 0, textChars = 0;

  for (const b of doc.blocks) {
    const text = [b.heading, b.body, b.speakerNotes].filter(Boolean).join('\n').trim();
    // Speaker notes on these decks are often just the slide number.
    const real = text.replace(/^\d+$/gm, '').trim();
    if (b.imageRefs?.length) withImages++;
    if (b.imageRefs?.length && real.length < 25) imageOnly++;
    textChars += real.length;
  }
  console.log(
    `${name}: ${doc.blocks.length} slides, ${withImages} with images, ` +
    `${imageOnly} IMAGE-ONLY (${Math.round((imageOnly / doc.blocks.length) * 100)}%)`,
  );
}
