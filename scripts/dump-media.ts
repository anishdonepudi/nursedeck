import { ingestPptx } from '../src/core/ingest/pptx.js';
const doc = await ingestPptx(process.argv[2]!, { mediaOutDir: process.argv[3]! });
for (const b of doc.blocks) {
  if (b.imageRefs?.length) console.log(`slide ${b.ordinal}: ${b.imageRefs.join(', ')}  heading=${JSON.stringify(b.heading)}`);
}
