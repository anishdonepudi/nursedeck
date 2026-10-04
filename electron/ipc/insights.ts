import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDb, getWorkspaceDir, getCli, getDataDir } from './context.js';
import { deckStats } from '@core/scheduler/fsrs.js';
import {
  topicReadiness, dueForecast, projectToExam, leeches, illusionOfKnowing,
} from '@core/scheduler/mastery.js';
import { corroborateClaim } from '@core/sources/corroborate.js';
import { exportDeck } from '@core/export/csv.js';
import { CHANNELS } from '@shared/ipc.js';
import type { Dashboard, CorroborationReport } from '@shared/ipc.js';

/**
 * Dashboard, corroboration and export.
 *
 * Grouped together because they are the three things that look outward: what
 * she knows, whether an authority agrees, and getting her cards out of the app.
 */

export function registerInsightsIpc(): void {
  ipcMain.handle(
    CHANNELS.dashboard,
    async (_e, lectureId: unknown, examDate: unknown): Promise<Dashboard> => {
      const db = await ensureDb();
      const scope = typeof lectureId === 'string' ? { lectureId } : {};

      const dashboard: Dashboard = {
        stats: deckStats(db, scope),
        topics: topicReadiness(db, scope),
        forecast: dueForecast(db, { ...scope, days: 30 }),
        leeches: leeches(db, { minLapses: 2, limit: 10 }).map((l) => ({
          itemId: l.itemId, front: l.front, lapses: l.lapses,
        })),
        illusions: illusionOfKnowing(db, 10).map((i) => ({
          itemId: i.itemId, front: i.front,
          occurrences: i.occurrences, meanConfidence: i.meanConfidence,
        })),
      };

      if (typeof examDate === 'string' && examDate) {
        const when = new Date(examDate);
        if (!Number.isNaN(when.getTime())) {
          dashboard.projection = projectToExam(db, when, scope);
        }
      }
      return dashboard;
    },
  );

  ipcMain.handle(
    CHANNELS.corroborate,
    async (_e, itemId: unknown): Promise<CorroborationReport> => {
      if (typeof itemId !== 'string') throw new Error('An item id is required.');
      const db = await ensureDb();

      const row = db.prepare('SELECT front, back FROM items WHERE id = ?').get(itemId) as
        | { front: string; back: string }
        | undefined;
      if (!row) throw new Error('That card no longer exists.');

      const result = await corroborateClaim(db, itemId, `${row.front} ${row.back}`, {
        workspaceDir: getWorkspaceDir(),
        cacheDir: join(getDataDir(), 'reference-cache'),
        model: 'sonnet',
        ...(getCli() ? { cliPath: getCli()!.path } : {}),
      });

      return {
        itemId,
        outcome: result.outcome,
        ...(result.source ? { sourceTitle: result.source.title, sourceUrl: result.source.url } : {}),
        ...(result.excerpt ? { excerpt: result.excerpt } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
      };
    },
  );

  ipcMain.handle(
    CHANNELS.exportDeck,
    async (_e, lectureId: unknown, format: unknown) => {
      const db = await ensureDb();
      const scope = typeof lectureId === 'string' ? { lectureId } : {};

      // .apkg is binary and carries the deck and scheduler preset, so it goes
      // out through its own writer rather than the text path below.
      if (format === 'apkg') {
        const { exportApkg } = await import('@core/export/apkg.js');
        const pkg = await exportApkg(db, scope);

        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const chosen = await dialog.showSaveDialog(win!, {
          title: 'Export to Anki',
          defaultPath: pkg.filename,
          filters: [{ name: 'Anki package', extensions: ['apkg'] }],
        });

        if (chosen.canceled || !chosen.filePath) {
          return { saved: false, cardCount: pkg.cardCount, skipped: pkg.skipped };
        }
        await writeFile(chosen.filePath, pkg.bytes);
        return {
          saved: true,
          path: chosen.filePath,
          cardCount: pkg.cardCount,
          skipped: pkg.skipped,
        };
      }

      const fmt = format === 'quizlet-csv' ? 'quizlet-csv' : 'anki-tsv';
      const result = exportDeck(db, { format: fmt, ...scope });

      // Built as a plain value rather than inline. An inline ternary of nested
      // object/array literals here made the bundler emit a truncated chunk,
      // which surfaced as "unterminated string literal" at an unrelated line.
      const fileFilters: { name: string; extensions: string[] }[] =
        fmt === 'anki-tsv'
          ? [{ name: 'Anki import', extensions: ['txt'] }]
          : [{ name: 'CSV', extensions: ['csv'] }];

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const chosen = await dialog.showSaveDialog(win!, {
        title: 'Export deck',
        defaultPath: result.filename,
        filters: fileFilters,
      });

      if (chosen.canceled || !chosen.filePath) {
        return { saved: false, cardCount: result.cardCount, skipped: result.skipped };
      }

      await writeFile(chosen.filePath, result.content, 'utf8');
      return {
        saved: true,
        path: chosen.filePath,
        cardCount: result.cardCount,
        skipped: result.skipped,
      };
    },
  );
}

/* --------------------------- her own cards -------------------------------- */

import { insertUserCard, editItem, deleteItem, listDeck } from '@core/db/repo.js';
import type { DeckCardRow, NewUserCard, CardEdit } from '@shared/ipc.js';

export function registerDeckIpc(): void {
  ipcMain.handle(CHANNELS.listDeck, async (_e, lectureId: unknown): Promise<DeckCardRow[]> => {
    const db = await ensureDb();
    return listDeck(db, typeof lectureId === 'string' ? { lectureId } : {}) as DeckCardRow[];
  });

  ipcMain.handle(CHANNELS.addCard, async (_e, card: unknown): Promise<string> => {
    const c = card as NewUserCard;
    if (!c || typeof c.lectureId !== 'string') throw new Error('A lecture is required.');
    if (!c.front?.trim() || !c.back?.trim()) {
      throw new Error('A card needs both a question and an answer.');
    }
    const db = await ensureDb();
    return insertUserCard(db, {
      lectureId: c.lectureId,
      kind: c.kind === 'cloze' || c.kind === 'qa' ? c.kind : 'flashcard',
      front: c.front.trim(),
      back: c.back.trim(),
      ...(c.clientNeed ? { clientNeed: c.clientNeed } : {}),
    });
  });

  ipcMain.handle(CHANNELS.editCard, async (_e, edit: unknown) => {
    const e2 = edit as CardEdit;
    if (!e2 || typeof e2.itemId !== 'string') throw new Error('A card id is required.');
    const db = await ensureDb();
    return editItem(db, {
      itemId: e2.itemId,
      ...(e2.front !== undefined ? { front: e2.front.trim() } : {}),
      ...(e2.back !== undefined ? { back: e2.back.trim() } : {}),
      ...(e2.clientNeed ? { clientNeed: e2.clientNeed } : {}),
    });
  });

  ipcMain.handle(CHANNELS.deleteCard, async (_e, itemId: unknown): Promise<void> => {
    if (typeof itemId !== 'string') throw new Error('A card id is required.');
    const db = await ensureDb();
    deleteItem(db, itemId);
  });
}

/* ------------------------- imported decks -------------------------------- */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { insertImportedDeck, vouchItem } from '@core/db/repo.js';
import { parseDeckText, dedupeRows } from '@core/import/deck.js';
import type { ImportDeckSummary } from '@shared/ipc.js';

/** Largest deck file accepted, so a mis-picked file cannot exhaust memory. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function registerImportIpc(): void {
  ipcMain.handle(CHANNELS.importDeck, async (_e, lectureId: unknown): Promise<ImportDeckSummary> => {
    if (typeof lectureId !== 'string') throw new Error('A lecture is required.');

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Import a deck',
      properties: ['openFile'],
      filters: [
        { name: 'Deck export', extensions: ['txt', 'tsv', 'csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (picked.canceled || picked.filePaths.length === 0) {
      return { chosen: false, imported: 0, duplicates: 0, unreadable: 0 };
    }

    const path = picked.filePaths[0]!;
    const raw = await readFile(path);
    if (raw.byteLength > MAX_IMPORT_BYTES) {
      throw new Error('That file is larger than 20 MB. It is probably not a deck export.');
    }

    const text = raw.toString('utf8');
    const parsed = parseDeckText(text);
    const { rows, duplicates: inFile } = dedupeRows(parsed.rows);

    if (rows.length === 0) {
      throw new Error(
        'No cards were found in that file. A deck export needs a question and an answer on each line.',
      );
    }

    const db = await ensureDb();
    const result = insertImportedDeck(db, {
      lectureId,
      filename: basename(path),
      rawText: text,
      cards: rows.map((r) => ({ front: r.front, back: r.back, tags: r.tags })),
    });

    return {
      chosen: true,
      filename: basename(path),
      imported: result.imported,
      // Duplicates within the file and against what she already has are the
      // same thing to her: cards that were not added.
      duplicates: inFile + result.duplicates,
      unreadable: parsed.skipped.length,
    };
  });

  ipcMain.handle(CHANNELS.vouchCard, async (_e, itemId: unknown): Promise<void> => {
    if (typeof itemId !== 'string') throw new Error('A card id is required.');
    const db = await ensureDb();
    // Throws on a generated card. The citation gate is not optional.
    vouchItem(db, itemId);
  });
}
