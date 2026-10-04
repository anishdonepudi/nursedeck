import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { ensureDb } from './context.js';
import { listCitations } from '@core/db/repo.js';
import {
  assembleExam, buildReport, type CandidateItem, type ItemOutcome,
} from '@core/exam/blueprint.js';
import { scoreItem } from '@core/exam/scoring.js';
import { CHANNELS } from '@shared/ipc.js';
import type { StartedExam, ExamQuestion, ExamAnswer, ExamResult } from '@shared/ipc.js';

/**
 * Practice exams.
 *
 * The answer key never crosses to the renderer while an exam is in progress:
 * options are sent with positional ids and nothing else, and `isKey`,
 * rationales and citations are only attached once the exam is submitted. That
 * keeps the key out of devtools and out of the page's memory.
 */

interface StoredOption {
  text: string;
  isKey: boolean;
  rationale: string;
  errorClass?: string;
}

const optionId = (i: number): string => `o${i}`;

export function registerExamIpc(): void {
  ipcMain.handle(
    CHANNELS.examStart,
    async (_e, lectureId: unknown, length: unknown): Promise<StartedExam> => {
      const db = await ensureDb();
      const want = typeof length === 'number' && length > 0 ? Math.min(length, 150) : 85;
      const scoped = typeof lectureId === 'string';

      // Same invariant as study: accepted, and backed by a verified citation.
      const rows = db
        .prepare(
          `SELECT i.id, i.client_need, i.njcmm_step, i.cognitive_level, i.elo, i.payload,
                  (SELECT COUNT(*) FROM exam_items ei WHERE ei.item_id = i.id) AS exposure,
                  (SELECT MAX(e.created_at) FROM exam_items ei
                      JOIN exams e ON e.id = ei.exam_id
                     WHERE ei.item_id = i.id) AS last_seen
             FROM items i
             JOIN citations c ON c.item_id = i.id AND c.verdict = 'verified'
            WHERE i.status = 'accepted' AND i.kind = 'nclex'
              ${scoped ? 'AND i.lecture_id = ?' : ''}
            GROUP BY i.id`,
        )
        .all(...(scoped ? [lectureId as string] : [])) as Record<string, unknown>[];

      if (rows.length === 0) {
        throw new Error(
          'No verified NCLEX questions yet. Generate NCLEX questions, review them, and verify their citations first.',
        );
      }

      const pool: CandidateItem[] = rows.map((r) => {
        const payload = r['payload']
          ? (JSON.parse(String(r['payload'])) as { itemType?: string })
          : {};
        return {
          id: String(r['id']),
          ...(r['client_need'] ? { clientNeed: String(r['client_need']) } : {}),
          ...(r['njcmm_step'] ? { njcmmStep: String(r['njcmm_step']) } : {}),
          ...(r['cognitive_level'] ? { cognitiveLevel: String(r['cognitive_level']) } : {}),
          ...(payload.itemType ? { itemType: payload.itemType } : {}),
          elo: Number(r['elo']),
          exposureCount: Number(r['exposure'] ?? 0),
          ...(r['last_seen'] ? { lastSeenAt: String(r['last_seen']) } : {}),
        };
      });

      const assembled = assembleExam(pool, { length: Math.min(want, pool.length) });
      const examId = randomUUID();
      const title = `Practice exam - ${new Date().toLocaleDateString()}`;

      db.prepare(
        `INSERT INTO exams (id, title, started_at, blueprint) VALUES (?, ?, datetime('now'), ?)`,
      ).run(examId, title, JSON.stringify(assembled.blueprint));

      const link = db.prepare(
        'INSERT INTO exam_items (exam_id, item_id, position) VALUES (?, ?, ?)',
      );
      const questions: ExamQuestion[] = [];

      for (const [position, itemId] of assembled.itemIds.entries()) {
        const row = db
          .prepare('SELECT front, payload, client_need FROM items WHERE id = ?')
          .get(itemId) as Record<string, unknown> | undefined;
        if (!row) continue;

        const payload = JSON.parse(String(row['payload'] ?? '{}')) as {
          itemType?: ExamQuestion['itemType'];
          selectN?: number;
          options?: StoredOption[];
        };

        link.run(examId, itemId, position);
        questions.push({
          itemId,
          position,
          stem: String(row['front']),
          itemType: payload.itemType ?? 'multiple_choice',
          ...(payload.selectN !== undefined ? { selectN: payload.selectN } : {}),
          options: (payload.options ?? []).map((o, i) => ({ id: optionId(i), text: o.text })),
          ...(row['client_need'] ? { clientNeed: String(row['client_need']) } : {}),
        });
      }

      return {
        examId,
        title,
        questions,
        blueprint: assembled.blueprint,
        shortfalls: assembled.shortfalls,
        estimatedMinutes: assembled.estimatedMinutes,
      };
    },
  );

  ipcMain.handle(
    CHANNELS.examSubmit,
    async (_e, examId: unknown, answers: unknown): Promise<ExamResult> => {
      if (typeof examId !== 'string') throw new Error('An exam id is required.');
      const db = await ensureDb();

      const given = (Array.isArray(answers) ? answers : []) as ExamAnswer[];
      const byItem = new Map(given.map((a) => [a.itemId, a]));

      const rows = db
        .prepare(
          `SELECT ei.item_id, ei.position, i.front, i.payload,
                  i.client_need, i.njcmm_step, i.cognitive_level
             FROM exam_items ei JOIN items i ON i.id = ei.item_id
            WHERE ei.exam_id = ? ORDER BY ei.position`,
        )
        .all(examId) as Record<string, unknown>[];

      const outcomes: ItemOutcome[] = [];
      const review: ExamResult['review'] = [];
      const record = db.prepare(
        `UPDATE exam_items
            SET response = ?, points_earned = ?, points_possible = ?, duration_ms = ?
          WHERE exam_id = ? AND item_id = ?`,
      );

      for (const r of rows) {
        const itemId = String(r['item_id']);
        const payload = JSON.parse(String(r['payload'] ?? '{}')) as {
          itemType?: string;
          selectN?: number;
          options?: StoredOption[];
        };
        const options = payload.options ?? [];
        const keys = options
          .map((o, i) => (o.isKey ? optionId(i) : ''))
          .filter((id) => id !== '');
        const answer = byItem.get(itemId);
        const selected = answer?.selected ?? [];

        // Constrained selection (single answer, select-N) is 0/1. An
        // unconstrained select-all is +/-, which is what stops selecting
        // everything from being a winning strategy.
        const rule = payload.itemType === 'select_all' ? '+/-' : '0/1';
        const score = scoreItem({ rule, keys }, { selected });

        record.run(
          JSON.stringify(selected), score.earned, score.possible,
          answer?.durationMs ?? null, examId, itemId,
        );

        outcomes.push({
          itemId,
          ...(r['client_need'] ? { clientNeed: String(r['client_need']) } : {}),
          ...(r['njcmm_step'] ? { njcmmStep: String(r['njcmm_step']) } : {}),
          ...(r['cognitive_level'] ? { cognitiveLevel: String(r['cognitive_level']) } : {}),
          ...(payload.itemType ? { itemType: payload.itemType } : {}),
          earned: score.earned,
          possible: score.possible,
          ...(rule === '+/-' ? { overSelected: score.overSelected } : {}),
          ...(answer?.durationMs !== undefined ? { durationMs: answer.durationMs } : {}),
        });

        const [citation] = listCitations(db, itemId).filter((c) => c.verdict === 'verified');
        review.push({
          itemId,
          stem: String(r['front']),
          earned: score.earned,
          possible: score.possible,
          options: options.map((o, i) => ({
            id: optionId(i),
            text: o.text,
            isKey: o.isKey,
            chosen: selected.includes(optionId(i)),
            rationale: o.rationale,
            ...(o.errorClass ? { errorClass: o.errorClass } : {}),
          })),
          ...(citation
            ? { citation: { excerpt: citation.excerpt, sourceTitle: citation.sourceTitle } }
            : {}),
        });
      }

      const report = buildReport(outcomes, rows.length);

      db.prepare(
        `UPDATE exams SET finished_at = datetime('now'), points_earned = ?, points_possible = ?
          WHERE id = ?`,
      ).run(report.pointsEarned, report.pointsPossible, examId);

      return { ...report, review };
    },
  );
}
