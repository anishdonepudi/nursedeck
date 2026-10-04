import { ipcMain, dialog, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { ensureDb, getWorkspaceDir, getCli, getDataDir } from './context.js';
import {
  insertLecture, listLectures, listPending, listStudiable, listCitations,
  listItemBlocks, setItemStatus, setCitationVerdict, getSourceText,
} from '@core/db/repo.js';
import { ingestPptx } from '@core/ingest/pptx.js';
import { generateForLecture, type GenerationKind } from '@core/generate/pipeline.js';
import { verifyClaim } from '@core/validate/entailment.js';
import { CHANNELS } from '@shared/ipc.js';
import type {
  ImportResult, LectureSummary, GenSummary, TriageItem, TriageCitation, GenProgress,
} from '@shared/ipc.js';

/**
 * Study-side IPC.
 *
 * All file parsing, generation and verification happens here in the main
 * process. The renderer only ever receives plain data, and never a file path it
 * could ask the main process to read back.
 */

/** Held so the UI can cancel an in-flight generation run. */
let generationAbort: AbortController | undefined;

export function registerStudyIpc(): void {

  ipcMain.handle(CHANNELS.pickLecture, async (): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose lecture files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Lecture files', extensions: ['pptx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(CHANNELS.importLecture, async (_e, filePath: unknown): Promise<ImportResult> => {
    if (typeof filePath !== 'string') throw new Error('A file path is required.');
    const database = await ensureDb();

    const mediaOutDir = join(getDataDir(), 'media');
    const doc = await ingestPptx(filePath, { mediaOutDir });
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
      const sourceText = getSourceText(database, c.sourceId);
      const result = await verifyClaim(
        { claim: c.claim, excerpt: c.excerpt, sourceText, tier: c.licenseTier },
        { workspaceDir: getWorkspaceDir(), ...(getCli() ? { cliPath: getCli()!.path } : {}) },
      );
      setCitationVerdict(
        database,
        c.id,
        result.ok ? 'verified' : 'failed',
        result.failure
          ? { stage: result.failure.stage, detail: 'detail' in result.failure ? result.failure.detail : undefined }
          : undefined,
      );
    }
    return listCitations(database, itemId).map(toTriageCitation);
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
