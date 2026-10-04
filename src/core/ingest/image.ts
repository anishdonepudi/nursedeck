import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LectureDoc, LectureBlock } from '@shared/types.js';
import { runClaude } from '../generate/claude.js';

/**
 * Photographs of handwritten notes and whiteboards.
 *
 * Transcription is a vision task, so unlike the other ingest paths this one
 * needs the model. Two consequences shape the design:
 *
 * - The transcript becomes the citable source text. Everything downstream then
 *   works unchanged: a card quoting her notes is checked against the transcript
 *   by exact string match, exactly as a card quoting a slide is.
 * - Because the transcript IS the evidence, the model is told to transcribe and
 *   never to interpret, complete, or correct. An "improved" transcript would
 *   quietly become an unsourced claim that still passes verification.
 */

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          text: { type: 'string' },
          unreadable: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short descriptions of anything that could not be read.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages'],
  additionalProperties: false,
} as const;

const SYSTEM = `You transcribe photographs of a nursing student's study notes.

Transcribe EXACTLY what is written. This transcript becomes the source of
record that her study cards are checked against, so anything you add becomes an
unsourced claim.

- Do not correct spelling, expand abbreviations, fix terminology, or complete a
  half-finished sentence.
- Do not add any fact that is not visibly written, however obvious.
- Keep the writer's own abbreviations (K+, pt, SOB, c/o) as written.
- Preserve line breaks, bullets and indentation where you can.
- Transcribe tables row by row, separating cells with " | ".
- If a word is genuinely illegible, write [illegible] and note it in
  "unreadable" rather than guessing.
- If part of the image is a diagram rather than text, describe it briefly in
  square brackets, e.g. [diagram: heart with labelled chambers].

Respond with JSON only.`;

interface TranscribedPage {
  heading?: string;
  text: string;
  unreadable?: string[];
}

export interface ImageIngestOptions {
  workspaceDir: string;
  /** Where to copy the images so the app owns a stable copy. */
  mediaOutDir?: string;
  model?: string;
  cliPath?: string;
  signal?: AbortSignal;
}

const SUPPORTED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * Transcribes one or more images into a single document.
 *
 * Images are passed by path: the CLI reads them itself, which avoids
 * base64-inflating a multi-megabyte photo through stdin.
 */
export async function ingestImages(
  filePaths: string[],
  opts: ImageIngestOptions,
): Promise<LectureDoc> {
  const warnings: string[] = [];
  if (filePaths.length === 0) throw new Error('No images were given.');

  const usable: string[] = [];
  for (const p of filePaths) {
    if (SUPPORTED.has(extname(p).toLowerCase())) usable.push(p);
    else warnings.push(`Skipped ${basename(p)}: not a supported image format.`);
  }
  if (usable.length === 0) {
    throw new Error('None of those files are images NurseDeck can read (PNG, JPEG, WebP or GIF).');
  }

  // Copy into the workspace so the CLI can read them from its one allowed
  // directory, rather than being pointed at wherever her photos live.
  const stagedDir = join(opts.workspaceDir, 'images');
  await mkdir(stagedDir, { recursive: true });

  const staged: string[] = [];
  for (const [i, src] of usable.entries()) {
    const dest = join(stagedDir, `note-${i + 1}${extname(src).toLowerCase()}`);
    await writeFile(dest, await readFile(src));
    staged.push(dest);
  }

  const blocks: LectureBlock[] = [];

  // One call per image: a failed transcription then costs one photo, not the
  // whole batch, and page numbering stays unambiguous.
  for (const [index, image] of staged.entries()) {
    try {
      const res = await runClaude<{ pages: TranscribedPage[] }>(
        `Transcribe the image at ${basename(image)} in the working directory. JSON only.`,
        {
          schema: TRANSCRIBE_SCHEMA,
          workspaceDir: stagedDir,
          appendSystemPrompt: SYSTEM,
          model: opts.model ?? 'sonnet',
          maxBudgetUsd: 1,
          // Transcription needs to read the image, so unlike text generation
          // this call is allowed the Read tool.
          allowReadTool: true,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
        },
      );

      for (const page of res.data.pages ?? []) {
        if (!page.text?.trim()) continue;
        const block: LectureBlock = {
          id: `img${index + 1}-${randomUUID().slice(0, 8)}`,
          ordinal: blocks.length + 1,
          body: page.text.trim(),
          imageRefs: [image],
        };
        if (page.heading) block.heading = page.heading;
        blocks.push(block);

        for (const u of page.unreadable ?? []) {
          warnings.push(`Image ${index + 1}: could not read "${u}".`);
        }
      }
    } catch (err) {
      warnings.push(
        `Image ${index + 1} (${basename(usable[index] ?? image)}) could not be transcribed: ${(err as Error).message}`,
      );
    }
  }

  if (blocks.length === 0) {
    throw new Error(
      'Nothing could be transcribed from those images. Check they are in focus and the writing is legible.',
    );
  }

  if (opts.mediaOutDir) {
    await mkdir(opts.mediaOutDir, { recursive: true });
    for (const [i, src] of staged.entries()) {
      const dest = join(opts.mediaOutDir, `note-${randomUUID().slice(0, 8)}${extname(src)}`);
      await writeFile(dest, await readFile(src));
      const block = blocks[i];
      if (block) block.imageRefs = [dest];
    }
  }

  const title = blocks[0]?.heading ?? `Notes · ${basename(usable[0] ?? '', extname(usable[0] ?? ''))}`;

  return {
    id: randomUUID(),
    sourceFile: usable.join(', '),
    kind: 'image',
    title,
    blocks,
    warnings,
  };
}
