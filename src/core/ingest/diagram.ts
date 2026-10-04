import { mkdir, copyFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { LectureDoc, LectureBlock } from '@shared/types.js';
import { runClaude, ClaudeError } from '../generate/claude.js';

/**
 * Reading the text that is printed inside a slide's pictures.
 *
 * Measured on the student's own four decks, 18 of 96 slides -- and 32% of the
 * acid-base deck -- carry NO text at all: the heading, the content and the
 * nursing note are all baked into a picture. Those slides produced nothing,
 * which meant a third of a lecture was silently missing from her study
 * material. Slide text extraction cannot see any of it.
 *
 * The transcript becomes citable source text, exactly as a photograph of her
 * handwritten notes does (see ingest/image.ts). That is what keeps the
 * anti-hallucination gate intact: a card quoting a diagram is checked by exact
 * string match against the transcript, the same way a card quoting a bullet is
 * checked against the slide.
 *
 * The consequence is that the transcript IS the evidence, so the model is told
 * to transcribe and never to interpret. A model that "helpfully" completes a
 * mnemonic would be manufacturing a claim that then passes verification, which
 * is the one failure this whole design exists to prevent.
 */

const DIAGRAM_SCHEMA = {
  type: 'object',
  properties: {
    isTeachingContent: {
      type: 'boolean',
      description: 'False for decorative clip-art, logos, borders and photographs with no text.',
    },
    transcript: {
      type: 'string',
      description: 'Text visibly printed in the image. Empty when there is none.',
    },
    unreadable: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short notes about anything that could not be read.',
    },
  },
  required: ['isTeachingContent', 'transcript'],
  additionalProperties: false,
} as const;

const DIAGRAM_SYSTEM = `You transcribe the text printed inside an image on a nursing lecture slide.

This transcript becomes the source of record that her study cards are checked
against. Anything you add becomes an unsourced claim that will still pass
verification, so adding is the one thing you must never do.

- Transcribe ONLY text that is visibly printed in the image.
- Do not interpret, explain, complete, summarise, or correct anything.
- Do not supply nursing knowledge that is not written in the image, however
  obvious it is to you.
- Preserve groupings: keep a heading together with the items beneath it, so a
  quoted line still says what it is about.
- Keep arrows and symbols as written (an up arrow stays an up arrow).
- Transcribe a table row by row, separating cells with " | ".
- If a word is genuinely illegible write [illegible] and list it in
  "unreadable" rather than guessing.
- If the image is decorative and teaches nothing -- clip-art, a logo, a border,
  a photograph with no text -- set isTeachingContent to false and leave
  transcript empty.

Respond with JSON only.`;

export interface DiagramOptions {
  /** The only directory the CLI may read. Images are staged into it. */
  workspaceDir: string;
  model?: string;
  cliPath?: string;
  signal?: AbortSignal;
  maxBudgetUsd?: number;
  /**
   * Skip slides that already carry this much text of their own. A picture
   * beside a full slide is usually illustration, and transcribing every one
   * would multiply the cost of a deck for little gain.
   */
  minTextToSkip?: number;
  onProgress?: (p: { slide: number; total: number }) => void;
}

export interface DiagramResult {
  /** Blocks with `imageText` filled in where a transcript was obtained. */
  blocks: LectureBlock[];
  transcribed: number;
  decorative: number;
  estimatedCostUsd: number;
  warnings: string[];
}

const SUPPORTED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Text a slide already has, ignoring speaker notes that are just its number. */
function ownTextLength(b: LectureBlock): number {
  const notes = (b.speakerNotes ?? '').replace(/^\s*\d+\s*$/gm, '');
  return [b.heading, b.body, notes].filter(Boolean).join(' ').trim().length;
}

/**
 * Transcribes the pictures on slides that would otherwise teach nothing.
 *
 * Failures are collected as warnings rather than thrown: one unreadable picture
 * must not cost the whole lecture.
 */
export async function transcribeDiagrams(
  doc: LectureDoc,
  opts: DiagramOptions,
): Promise<DiagramResult> {
  const warnings: string[] = [];
  const blocks = doc.blocks.map((b) => ({ ...b }));
  const minTextToSkip = opts.minTextToSkip ?? 120;

  const candidates = blocks.filter(
    (b) => (b.imageRefs?.length ?? 0) > 0 && ownTextLength(b) < minTextToSkip,
  );

  let transcribed = 0;
  let decorative = 0;
  let estimatedCostUsd = 0;

  const stagedDir = join(opts.workspaceDir, 'diagrams');
  await mkdir(stagedDir, { recursive: true });

  for (const [i, block] of candidates.entries()) {
    opts.onProgress?.({ slide: i + 1, total: candidates.length });

    const parts: string[] = [];

    for (const ref of block.imageRefs ?? []) {
      if (!SUPPORTED.has(extname(ref).toLowerCase())) {
        // EMF/WMF are already reported by the pptx reader; say nothing twice.
        continue;
      }

      // Staged into the workspace so the CLI reads from its one allowed
      // directory rather than wherever the media was extracted.
      const dest = join(stagedDir, basename(ref));
      try {
        await copyFile(ref, dest);
      } catch {
        warnings.push(`Slide ${block.ordinal}: could not open ${basename(ref)}.`);
        continue;
      }

      try {
        const r = await runClaude<{
          isTeachingContent: boolean;
          transcript: string;
          unreadable?: string[];
        }>(`Transcribe the text printed in the image at ${dest}`, {
          schema: DIAGRAM_SCHEMA,
          workspaceDir: opts.workspaceDir,
          // The single place a file-reading tool is allowed, because an image
          // cannot be piped through stdin as text.
          allowReadTool: true,
          appendSystemPrompt: DIAGRAM_SYSTEM,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
        });

        estimatedCostUsd += r.estimatedCostUsd;

        if (!r.data?.isTeachingContent || !r.data.transcript.trim()) {
          decorative++;
          continue;
        }
        parts.push(r.data.transcript.trim());
        for (const u of r.data.unreadable ?? []) {
          warnings.push(`Slide ${block.ordinal}: could not read "${u}".`);
        }
      } catch (e) {
        const message = e instanceof ClaudeError ? e.message : (e as Error).message;
        warnings.push(`Slide ${block.ordinal}: ${message}`);
      }
    }

    if (parts.length > 0) {
      block.imageText = parts.join('\n\n');
      transcribed++;
    }
  }

  return { blocks, transcribed, decorative, estimatedCostUsd, warnings };
}
