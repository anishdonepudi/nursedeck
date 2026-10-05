import { ipcMain, dialog, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { ensureDb, getWorkspaceDir, getCli, getDataDir } from './context.js';
import {
  insertLecture, listLectures, listPending, listStudiable, listCitations,
  listItemBlocks, setItemStatus, setCitationVerdict, getSourceText,
} from '@core/db/repo.js';
import { ingestPptx } from '@core/ingest/pptx.js';
import { transcribeDiagrams } from '@core/ingest/diagram.js';
import { ingestPdf } from '@core/ingest/pdf.js';
import { ingestDocx } from '@core/ingest/docx.js';
import { ingestImages } from '@core/ingest/image.js';
import { extname } from 'node:path';
import { generateForLecture, type GenerationKind } from '@core/generate/pipeline.js';
import { verifyPendingItems, verifyOneCitation } from '@core/validate/batch.js';
import { CHANNELS } from '@shared/ipc.js';
import type {
  ImportResult, LectureSummary, GenSummary, TriageItem, TriageCitation, GenProgress,
  VerifyAllSummary,
} from '@shared/ipc.js';

/**
 * Study-side IPC.
 *
 * All file parsing, generation and verification happens here in the main
 * process. The renderer only ever receives plain data, and never a file path it
 * could ask the main process to read back.
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Held so the UI can cancel an in-flight generation run. */
let generationAbort: AbortController | undefined;
/** Held so the UI can cancel a bulk verification run. */
let verifyAbort: AbortController | undefined;

export function registerStudyIpc(): void {

  ipcMain.handle(CHANNELS.pickLecture, async (): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose lecture files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Lecture files', extensions: ['pptx', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'] },
        { name: 'PowerPoint', extensions: ['pptx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word', extensions: ['docx'] },
        { name: 'Photos of notes', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(CHANNELS.importLecture, async (event, filePath: unknown): Promise<ImportResult> => {
    if (typeof filePath !== 'string') throw new Error('A file path is required.');
    const database = await ensureDb();

    const mediaOutDir = join(getDataDir(), 'media');
    const ext = extname(filePath).toLowerCase();

    // Routed by extension. Photographs are the only path that needs the model,
    // because transcription is a vision task; the rest parse locally.
    const doc =
      ext === '.pdf' ? await ingestPdf(filePath)
      : ext === '.docx' ? await ingestDocx(filePath)
      : IMAGE_EXTENSIONS.has(ext)
        ? await ingestImages([filePath], {
            workspaceDir: getWorkspaceDir(),
            mediaOutDir,
            model: 'sonnet',
            ...(getCli() ? { cliPath: getCli()!.path } : {}),
          })
      : await ingestPptx(filePath, { mediaOutDir });

    // Slides whose entire content is a picture. On her own decks this is 18 of
    // 96 slides -- a third of the acid-base lecture -- which produced nothing
    // at all before the pictures were read. Costs a model call per such slide,
    // so it runs only where the slide has little text of its own.
    if (doc.blocks.some((b) => (b.imageRefs?.length ?? 0) > 0)) {
      try {
        const transcribed = await transcribeDiagrams(doc, {
          workspaceDir: getWorkspaceDir(),
          model: 'sonnet',
          ...(getCli() ? { cliPath: getCli()!.path } : {}),
          // One model call per image-only slide, so a deck like hers can sit
          // here for minutes. Without this the window says "Importing..." and
          // never moves, which reads as hung.
          onProgress: (p) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(CHANNELS.importProgress, {
                phase: 'reading-images', slide: p.slide, totalSlides: p.total,
              });
            }
          },
        });
        doc.blocks = transcribed.blocks;
        doc.warnings = [...doc.warnings, ...transcribed.warnings];
      } catch (e) {
        // Never lose the lecture over its pictures: the slide text is already
        // parsed and is the more reliable half.
        doc.warnings = [...doc.warnings, `Could not read the slide images: ${(e as Error).message}`];
      }
    }

    insertLecture(database, doc);

    return {
      lectureId: doc.id,
      title: doc.title,
      blockCount: doc.blocks.length,
      warnings: doc.warnings,
    };
  });

  ipcMain.handle(CHANNELS.listLectures, async (): Promise<LectureSummary[]> => {
    const database = await ensureDb();
    return listLectures(database).map((l) => ({
      ...l,
      pendingCount: listPending(database, l.id).length,
      studiableCount: listStudiable(database, { lectureId: l.id }).length,
    }));
  });

  ipcMain.handle(
    CHANNELS.generate,
    async (event, lectureId: unknown, kinds: unknown): Promise<GenSummary> => {
      if (typeof lectureId !== 'string') throw new Error('A lecture id is required.');
      const database = await ensureDb();

      const row = database
        .prepare('SELECT source_id, title, source_file, kind FROM lectures WHERE id = ?')
        .get(lectureId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('That lecture is no longer in the library.');

      const blocks = database
        .prepare('SELECT * FROM blocks WHERE lecture_id = ? ORDER BY ordinal')
        .all(lectureId) as Record<string, unknown>[];

      const doc = {
        id: lectureId,
        sourceFile: String(row['source_file']),
        kind: row['kind'] as 'pptx',
        title: String(row['title']),
        warnings: [],
        blocks: blocks.map((b) => ({
          id: String(b['id']),
          ordinal: Number(b['ordinal']),
          ...(b['heading'] ? { heading: String(b['heading']) } : {}),
          body: String(b['body'] ?? ''),
          ...(b['speaker_notes'] ? { speakerNotes: String(b['speaker_notes']) } : {}),
          ...(b['tables_json'] ? { tables: JSON.parse(String(b['tables_json'])) as string[][] } : {}),
          // Must be carried through, or an image-only slide reaches the
          // generator empty and the transcript paid for at import is wasted.
          ...(b['image_text'] ? { imageText: String(b['image_text']) } : {}),
        })),
      };

      generationAbort?.abort();
      generationAbort = new AbortController();

      const report = await generateForLecture(database, doc, String(row['source_id']), {
        kinds: (Array.isArray(kinds) ? kinds : ['flashcard']) as GenerationKind[],
        workspaceDir: getWorkspaceDir(),
        model: 'sonnet',
        maxBudgetUsd: 5,
        signal: generationAbort.signal,
        ...(getCli() ? { cliPath: getCli()!.path } : {}),
        onProgress: (p: GenProgress) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.generateProgress, p);
        },
      });

      return {
        accepted: report.accepted,
        rejected: report.rejected.map((r) => ({
          kind: r.kind, front: r.front, reason: r.reason, stage: r.stage,
        })),
        estimatedCostUsd: report.estimatedCostUsd,
        errors: report.errors,
      };
    },
  );

  ipcMain.handle(CHANNELS.generateCancel, () => {
    generationAbort?.abort();
    generationAbort = undefined;
  });

  ipcMain.handle(CHANNELS.listTriage, async (_e, lectureId: unknown): Promise<TriageItem[]> => {
    if (typeof lectureId !== 'string') throw new Error('A lecture id is required.');
    const database = await ensureDb();

    return listPending(database, lectureId).map((item) => ({
      id: item.id,
      kind: item.kind,
      front: item.front,
      back: item.back,
      payload: item.payload,
      ...(item.clientNeed ? { clientNeed: item.clientNeed } : {}),
      citations: listCitations(database, item.id).map(toTriageCitation),
      blocks: listItemBlocks(database, item.id).map((b) => ({
        ordinal: b.ordinal,
        ...(b.heading ? { heading: b.heading } : {}),
      })),
    }));
  });

  ipcMain.handle(CHANNELS.setItemStatus, async (_e, itemId: unknown, status: unknown) => {
    if (typeof itemId !== 'string') throw new Error('An item id is required.');
    if (status !== 'accepted' && status !== 'rejected') throw new Error('Invalid status.');
    const database = await ensureDb();
    setItemStatus(database, itemId, status);
  });

  /**
   * Runs the adversarial entailment audit for one item.
   *
   * Kept separate from generation so triage stays fast: the deterministic
   * checks already ran, and this costs a model call per item.
   */
  ipcMain.handle(CHANNELS.verifyItem, async (_e, itemId: unknown): Promise<TriageCitation[]> => {
    if (typeof itemId !== 'string') throw new Error('An item id is required.');
    const database = await ensureDb();

    for (const c of listCitations(database, itemId)) {
      if (c.verdict === 'verified') continue;
      // The SAME function the bulk run uses. Two copies of this would drift,
      // and the drift would be in what counts as verified.
      await verifyOneCitation(database, c, {
        workspaceDir: getWorkspaceDir(),
        ...(getCli() ? { cliPath: getCli()!.path } : {}),
      });
    }
    return listCitations(database, itemId).map(toTriageCitation);
  });

  /**
   * Verifies every pending card in a lecture.
   *
   * Costs a model call per card, so it reports progress, is cancellable, and
   * stops at a budget rather than spending without bound.
   */
  ipcMain.handle(CHANNELS.verifyAll, async (event, lectureId: unknown): Promise<VerifyAllSummary> => {
    if (typeof lectureId !== 'string') throw new Error('A lecture id is required.');
    const database = await ensureDb();

    verifyAbort?.abort();
    verifyAbort = new AbortController();

    const report = await verifyPendingItems(database, {
      lectureId,
      workspaceDir: getWorkspaceDir(),
      model: 'sonnet',
      maxBudgetUsd: 5,
      signal: verifyAbort.signal,
      ...(getCli() ? { cliPath: getCli()!.path } : {}),
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.verifyProgress, p);
      },
    });

    return {
      checked: report.checked,
      verified: report.verified,
      failed: report.failed,
      remaining: report.remaining,
      estimatedCostUsd: report.estimatedCostUsd,
      errors: report.errors,
      ...(report.stoppedEarly ? { stoppedEarly: report.stoppedEarly } : {}),
    };
  });

  ipcMain.handle(CHANNELS.verifyAllCancel, () => {
    verifyAbort?.abort();
    verifyAbort = undefined;
  });
}

function toTriageCitation(c: ReturnType<typeof listCitations>[number]): TriageCitation {
  return {
    id: c.id,
    excerpt: c.excerpt,
    sourceTitle: c.sourceTitle,
    licenseTier: c.licenseTier,
    verdict: c.verdict,
    ...(c.failureStage ? { failureStage: c.failureStage } : {}),
    ...(c.failureDetail ? { failureDetail: c.failureDetail } : {}),
  };
}

/* -------------------------------- studying -------------------------------- */

import { dueQueue, deckStats, previewIntervals, readCardState, answerCard } from '@core/scheduler/fsrs.js';
import type { Grade } from 'ts-fsrs';
import type { StudyCard, StudyStats, AnswerPayload } from '@shared/ipc.js';

/** Masks the cloze blank so the answer is not visible in the prompt. */
function promptFor(kind: string, front: string): string {
  if (kind !== 'cloze') return front;
  return front.replace(/\{\{[^}]*\}\}/g, '______');
}

export function registerStudyModeIpc(): void {
  ipcMain.handle(CHANNELS.studyQueue, async (_e, lectureId: unknown): Promise<StudyCard[]> => {
    const database = await ensureDb();
    const queue = dueQueue(database, {
      ...(typeof lectureId === 'string' ? { lectureId } : {}),
      limit: 60,
      newLimit: 20,
    });

    const out: StudyCard[] = [];
    for (const q of queue) {
      const row = database
        .prepare('SELECT id, kind, front, back FROM items WHERE id = ?')
        .get(q.itemId) as Record<string, unknown> | undefined;
      if (!row) continue;

      const preview = previewIntervals(readCardState(database, q.itemId));
      const [citation] = listCitations(database, q.itemId).filter((c) => c.verdict === 'verified');

      out.push({
        id: String(row['id']),
        kind: row['kind'] as StudyCard['kind'],
        prompt: promptFor(String(row['kind']), String(row['front'])),
        expectedAnswer: String(row['back']),
        isNew: q.isNew,
        blocks: listItemBlocks(database, q.itemId).map((b) => ({
          ordinal: b.ordinal,
          ...(b.heading ? { heading: b.heading } : {}),
        })),
        ...(citation ? { citation: { excerpt: citation.excerpt, sourceTitle: citation.sourceTitle } } : {}),
        preview: {
          again: preview.again.toISOString(),
          hard: preview.hard.toISOString(),
          good: preview.good.toISOString(),
          easy: preview.easy.toISOString(),
        },
      });
    }
    return out;
  });

  ipcMain.handle(CHANNELS.studyStats, async (_e, lectureId: unknown): Promise<StudyStats> => {
    const database = await ensureDb();
    return deckStats(database, typeof lectureId === 'string' ? { lectureId } : {});
  });

  ipcMain.handle(CHANNELS.answerCard, async (_e, payload: unknown): Promise<void> => {
    const p = payload as AnswerPayload;
    if (!p || typeof p.itemId !== 'string') throw new Error('An item id is required.');
    if (!Number.isInteger(p.rating) || p.rating < 1 || p.rating > 4) {
      throw new Error('Rating must be 1-4.');
    }
    const database = await ensureDb();
    answerCard(database, {
      itemId: p.itemId,
      rating: p.rating as Grade,
      ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      ...(p.correct !== undefined ? { correct: p.correct } : {}),
      ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      ...(p.mode ? { mode: p.mode } : {}),
    });
  });
}

/* --------------------------- teach-back grading --------------------------- */

import { gradeTeachBack } from '@core/study/teachback.js';
import type { TeachBackGrade } from '@shared/ipc.js';

/**
 * Marks a typed explanation against the key points stored on the item.
 *
 * The key points come from the DATABASE, never from the renderer, so the thing
 * she is graded against is the item's own marking scheme and cannot be
 * substituted by whatever the window happened to send.
 */
export function registerGradingIpc(): void {
  ipcMain.handle(
    CHANNELS.gradeAnswer,
    async (_e, itemId: unknown, answer: unknown): Promise<TeachBackGrade> => {
      if (typeof itemId !== 'string') throw new Error('A card id is required.');
      if (typeof answer !== 'string') throw new Error('An answer is required.');

      const database = await ensureDb();
      const row = database
        .prepare('SELECT front, payload FROM items WHERE id = ?')
        .get(itemId) as { front: string; payload: string | null } | undefined;
      if (!row) throw new Error('That card is no longer in your deck.');

      const payload = row.payload ? (JSON.parse(row.payload) as { keyPoints?: string[] }) : {};

      const result = await gradeTeachBack(
        { question: row.front, keyPoints: payload.keyPoints ?? [], answer },
        {
          workspaceDir: getWorkspaceDir(),
          model: 'sonnet',
          maxBudgetUsd: 1,
          ...(getCli() ? { cliPath: getCli()!.path } : {}),
        },
      );

      return {
        points: result.points.map((p) => ({
          keyPoint: p.keyPoint,
          covered: p.covered,
          ...(p.evidence ? { evidence: p.evidence } : {}),
          ...(p.note ? { note: p.note } : {}),
        })),
        covered: result.covered,
        total: result.total,
        feedback: result.feedback,
        suggestedRating: result.suggestedRating,
      };
    },
  );
}
