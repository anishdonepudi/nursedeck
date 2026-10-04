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
      const fmt = format === 'quizlet-csv' ? 'quizlet-csv' : 'anki-tsv';
      const result = exportDeck(db, {
        format: fmt,
        ...(typeof lectureId === 'string' ? { lectureId } : {}),
      });

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
