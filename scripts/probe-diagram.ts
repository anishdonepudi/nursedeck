import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runClaude } from '../src/core/generate/claude.js';

const SCHEMA = {
  type: 'object',
  properties: {
    isTeachingContent: { type: 'boolean' },
    transcript: { type: 'string' },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['isTeachingContent', 'transcript'],
  additionalProperties: false,
} as const;

const SYSTEM = `You transcribe text out of a nursing lecture slide's image.

This transcript becomes the source of record her study cards are checked
against, so anything you add becomes an unsourced claim.
- Transcribe ONLY text that is visibly printed in the image.
- Do not interpret, explain, complete, or correct anything.
- Do not add nursing knowledge that is not written in the image.
- Preserve groupings: keep a heading with the items under it.
- If the image is decorative with no teaching text, set isTeachingContent false
  and leave transcript empty.
Respond with JSON only.`;

const ws = await mkdtemp(join(tmpdir(), 'nursedeck-probe-'));
await mkdir(join(ws, 'images'), { recursive: true });

for (const src of process.argv.slice(2)) {
  const dest = join(ws, 'images', basename(src));
  await copyFile(src, dest);

  const r = await runClaude<{ isTeachingContent: boolean; transcript: string }>(
    `Transcribe the text in the image at ${dest}`,
    { schema: SCHEMA, workspaceDir: ws, allowReadTool: true, model: 'sonnet', appendSystemPrompt: SYSTEM },
  );
  console.log(`\n===== ${basename(src)}  ($${r.estimatedCostUsd.toFixed(4)})`);
  console.log(`teaching: ${r.data?.isTeachingContent}`);
  console.log(r.data?.transcript ?? '(none)');
}
