import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * Concept maps.
 *
 * What matters here is not the drawing. It is that a map can only say what a
 * verified card already said: a wrong arrow is worse than a wrong flashcard,
 * because it reshapes how she organises a whole topic.
 */

const runClaude = vi.hoisted(() => vi.fn());
vi.mock('@core/generate/claude.js', () => ({
  runClaude,
  ClaudeError: class extends Error {},
}));

const { buildConceptMap } = await import('@core/study/conceptmap.js');
const { openDb } = await import('@core/db/index.js');
const { insertItem } = await import('@core/db/repo.js');
type Db = ReturnType<typeof openDb>;

let db: Db;
let lectureId: string;
let sourceId: string;

function addCard(front: string, back: string, verdict: 'verified' | 'unverified' = 'verified') {
  const id = insertItem(
    db,
    { lectureId, kind: 'flashcard', front, back, blockIds: [] },
    [{ sourceId, claim: `${front} ${back}`, excerpt: 'Hypokalemia causes flat T waves on ECG.', verdict }],
  );
  db.prepare("UPDATE items SET status = 'accepted' WHERE id = ?").run(id);
  return id;
}

function reply(relations: unknown[]) {
  runClaude.mockResolvedValue({ data: { relations }, estimatedCostUsd: 0.003 });
}

beforeEach(() => {
  runClaude.mockReset();
  db = openDb({ path: ':memory:' });
  sourceId = randomUUID();
  lectureId = randomUUID();
  db.prepare(
    `INSERT INTO sources (id, kind, license_tier, group_or_authors, title, full_text)
     VALUES (?, 'lecture', 'A', 'Course lecture', 'Electrolytes', 'Hypokalemia causes flat T waves on ECG.')`,
  ).run(sourceId);
  db.prepare(
    `INSERT INTO lectures (id, source_id, title, source_file, kind)
     VALUES (?, ?, 'Electrolytes', 'e.pptx', 'pptx')`,
  ).run(lectureId, sourceId);
});

describe('buildConceptMap', () => {
  it('builds an edge from a verified card and carries its quote', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    reply([{ cardIndex: 0, from: 'hypokalemia', relation: 'causes', to: 'Flat T waves' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]!.relation).toBe('causes');
    // An arrow must be checkable exactly like a card.
    expect(map.edges[0]!.excerpt).toContain('flat T waves');
  });

  it('REFUSES an edge whose concept is not in the card', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    // "digoxin toxicity" is true of hypokalemia and is NOT on this card. An
    // unsourced relationship wearing a verified card's citation is the exact
    // failure this design exists to prevent.
    reply([{ cardIndex: 0, from: 'hypokalemia', relation: 'predisposes to', to: 'digoxin toxicity' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges).toHaveLength(0);
  });

  it('never maps a card that failed the citation gate', async () => {
    addCard('Unverified claim', 'Something unchecked', 'unverified');
    reply([{ cardIndex: 0, from: 'Unverified claim', relation: 'is', to: 'Something unchecked' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    // listStudiable never returns it, so the model is never even asked.
    expect(runClaude).not.toHaveBeenCalled();
    expect(map.edges).toHaveLength(0);
  });

  it('drops a self-edge', async () => {
    addCard('What is hypokalemia?', 'Low serum hypokalemia');
    reply([{ cardIndex: 0, from: 'hypokalemia', relation: 'is', to: 'Hypokalemia' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges).toHaveLength(0);
  });

  it('ignores a relation pointing at a card that does not exist', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    reply([{ cardIndex: 99, from: 'hypokalemia', relation: 'causes', to: 'Flat T waves' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges).toHaveLength(0);
  });

  it('merges the same concept written two ways and ranks hubs first', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    addCard('How is hypokalemia treated?', 'Oral or IV potassium');
    reply([
      { cardIndex: 0, from: 'Hypokalemia', relation: 'causes', to: 'Flat T waves' },
      { cardIndex: 1, from: 'hypokalemia', relation: 'is treated with', to: 'IV potassium' },
    ]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges).toHaveLength(2);
    // One node, not two, and it is the hub.
    const hub = map.nodes[0]!;
    expect(hub.label.toLowerCase()).toBe('hypokalemia');
    expect(hub.degree).toBe(2);
    expect(map.nodes.filter((n) => n.label.toLowerCase() === 'hypokalemia')).toHaveLength(1);
  });

  it('strips a leading article so terms merge', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    reply([{ cardIndex: 0, from: 'the hypokalemia', relation: 'causes', to: 'Flat T waves' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(map.edges[0]!.from.toLowerCase()).toBe('hypokalemia');
  });

  it('reports cards that produced no relationship instead of hiding them', async () => {
    addCard('What ECG change is seen in hypokalemia?', 'Flat T waves');
    addCard('What is the normal potassium range?', '3.5-5.0 mEq/L');
    reply([{ cardIndex: 0, from: 'hypokalemia', relation: 'causes', to: 'Flat T waves' }]);

    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    // A bare number teaches no relationship. That is fine, but it is counted.
    expect(map.skipped).toBe(1);
  });

  it('spends nothing when there is nothing verified to map', async () => {
    const map = await buildConceptMap(db, { lectureId, workspaceDir: 'ws' });
    expect(runClaude).not.toHaveBeenCalled();
    expect(map.estimatedCostUsd).toBe(0);
  });
});
