import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Bulk verification.
 *
 * This runs unattended for minutes and spends money, so the tests are about
 * what happens when it goes wrong: she stops it, it hits its budget, or one
 * card throws. In every case the cards already checked must stay checked and
 * the ones not reached must stay honestly pending.
 */

const runClaude = vi.hoisted(() => vi.fn());
vi.mock('@core/generate/claude.js', () => ({
  runClaude,
  ClaudeError: class extends Error {},
}));

const { verifyPendingItems } = await import('@core/validate/batch.js');
const { openDb } = await import('@core/db/index.js');
const { insertItem, listStudiable, listPending } = await import('@core/db/repo.js');
type Db = ReturnType<typeof openDb>;

let db: Db;
let lectureId: string;
let sourceId: string;

const SOURCE = 'Normal adult serum potassium is 3.5-5.0 mEq/L.';

beforeEach(() => {
  runClaude.mockReset();
  db = openDb({ path: ':memory:' });
  sourceId = randomUUID();
  lectureId = randomUUID();
  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Electrolytes', ?)`,
  ).run(sourceId, SOURCE);
  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Electrolytes', 'e.pptx', 'pptx')`,
  ).run(lectureId, sourceId);
});

function addPending(front: string): string {
  return insertItem(
    db,
    { lectureId, kind: 'flashcard', front, back: '3.5-5.0 mEq/L', blockIds: [] },
    [{ sourceId, claim: `${front} 3.5-5.0 mEq/L`, excerpt: SOURCE, verdict: 'unverified' }],
  );
}

/** Makes the auditor answer `verdict` every time. */
function auditorAlways(verdict: 'supports' | 'insufficient') {
  runClaude.mockResolvedValue({
    data: { verdict, reason: 'because', ...(verdict !== 'supports' ? { unsupportedPart: 'x' } : {}) },
    estimatedCostUsd: 0.01,
  });
}

const OPTS = { workspaceDir: 'ws', allowRepair: false };

describe('verifyPendingItems', () => {
  it('verifies every pending card in one run', async () => {
    for (const n of ['A', 'B', 'C']) addPending(n);
    auditorAlways('supports');

    const r = await verifyPendingItems(db, { ...OPTS, lectureId });
    expect(r.checked).toBe(3);
    expect(r.verified).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('does not make a card studiable until it is ALSO accepted', async () => {
    addPending('A');
    auditorAlways('supports');
    await verifyPendingItems(db, { ...OPTS, lectureId });

    // Verification is one of the two gates, not both. Triage is the other.
    expect(listStudiable(db, { lectureId })).toHaveLength(0);
  });

  it('records a failure rather than silently skipping it', async () => {
    addPending('A');
    auditorAlways('insufficient');

    const r = await verifyPendingItems(db, { ...OPTS, lectureId });
    expect(r.failed).toBe(1);
    expect(r.verified).toBe(0);
    const row = db.prepare('SELECT verdict FROM citations').get() as { verdict: string };
    expect(row.verdict).toBe('failed');
  });

  it('stops when cancelled and keeps what it already checked', async () => {
    for (const n of ['A', 'B', 'C', 'D']) addPending(n);
    const controller = new AbortController();
    let calls = 0;
    runClaude.mockImplementation(async () => {
      calls++;
      if (calls === 2) controller.abort();
      return { data: { verdict: 'supports', reason: 'ok' }, estimatedCostUsd: 0.01 };
    });

    const r = await verifyPendingItems(db, { ...OPTS, lectureId, signal: controller.signal });
    expect(r.stoppedEarly).toBe('cancelled');
    expect(r.checked).toBeGreaterThan(0);
    expect(r.checked).toBeLessThan(4);
    // The work already done survives: those verdicts are written.
    const verified = db
      .prepare("SELECT COUNT(*) AS n FROM citations WHERE verdict = 'verified'")
      .get() as { n: number };
    expect(verified.n).toBe(r.checked);
    // And the rest are still pending, which is their honest state.
    expect(r.remaining).toBe(4 - r.checked);
    expect(listPending(db, lectureId)).toHaveLength(4);
  });

  it('stops at its budget instead of spending without bound', async () => {
    // No digits in the card name: a number in the FRONT becomes part of the
    // claim, and one absent from the excerpt fails the free numeric check
    // before any model call -- which is the gate working, but means nothing is
    // ever spent and the budget is never reached.
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']) {
      addPending(`card ${n}`);
    }
    auditorAlways('supports');

    const r = await verifyPendingItems(db, { ...OPTS, lectureId, maxBudgetUsd: 0.025 });
    expect(r.stoppedEarly).toBe('budget');
    expect(r.checked).toBeLessThan(10);
    expect(r.remaining).toBeGreaterThan(0);
  });

  it('one card that throws does not abandon the rest', async () => {
    for (const n of ['A', 'B', 'C']) addPending(n);
    let calls = 0;
    runClaude.mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error('CLI vanished mid-run');
      return { data: { verdict: 'supports', reason: 'ok' }, estimatedCostUsd: 0.01 };
    });

    const r = await verifyPendingItems(db, { ...OPTS, lectureId });
    expect(r.checked).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('CLI vanished');
    // The other two still got verified.
    expect(r.verified).toBe(2);
  });

  it('skips a card that is already verified instead of paying again', async () => {
    const id = addPending('A');
    db.prepare("UPDATE citations SET verdict = 'verified' WHERE item_id = ?").run(id);
    auditorAlways('supports');

    const r = await verifyPendingItems(db, { ...OPTS, lectureId });
    expect(runClaude).not.toHaveBeenCalled();
    expect(r.verified).toBe(1);
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('spends nothing on a lecture with no pending cards', async () => {
    const r = await verifyPendingItems(db, { ...OPTS, lectureId });
    expect(r.checked).toBe(0);
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('reports progress so a long run is visibly moving', async () => {
    for (const n of ['A', 'B']) addPending(n);
    auditorAlways('supports');
    const seen: number[] = [];

    await verifyPendingItems(db, {
      ...OPTS, lectureId, onProgress: (p) => seen.push(p.item),
    });
    expect(seen).toEqual([1, 2]);
  });
});
