import type { Db } from '../db/index.js';
import { listStudiable, listCitations } from '../db/repo.js';
import { runClaude } from '../generate/claude.js';
import { normalizeForMatch } from '../validate/citation.js';

/**
 * Concept maps.
 *
 * The design question is not how to draw a graph, it is where the edges come
 * from. Asking a model to map a topic would invent relationships -- plausible,
 * unsourced, and indistinguishable from the ones she can trust. That is exactly
 * the failure this whole app is built to prevent, and a wrong arrow is worse
 * than a wrong flashcard because it reshapes how she organises the topic.
 *
 * So a map is a VIEW OVER VERIFIED CARDS, never a new source of claims. Every
 * edge is extracted from one card that already passed the citation gate, and
 * carries that card's quote with it. Two consequences:
 *
 * - The map can only say what her lecture already said.
 * - Clicking any arrow shows the slide text it came from.
 *
 * The extraction is checked rather than trusted: both ends of an edge must
 * appear in the card they claim to come from, so the model cannot introduce a
 * concept the card never mentioned.
 */

export interface ConceptEdge {
  from: string;
  /** Short verb phrase: "causes", "is treated with", "is a sign of". */
  relation: string;
  to: string;
  /** The verified card this came from. */
  itemId: string;
  cardFront: string;
  /** That card's source quote, so an arrow can be checked like a card. */
  excerpt?: string;
}

export interface ConceptNode {
  label: string;
  /** Edges in or out. Drives size in the UI: the hubs are the big topics. */
  degree: number;
}

export interface ConceptMap {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  /** Cards that yielded no usable relationship, so nothing looks lost. */
  skipped: number;
  estimatedCostUsd: number;
}

const RELATION_SCHEMA = {
  type: 'object',
  properties: {
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cardIndex: { type: 'integer' },
          from: { type: 'string' },
          relation: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['cardIndex', 'from', 'relation', 'to'],
        additionalProperties: false,
      },
    },
  },
  required: ['relations'],
  additionalProperties: false,
} as const;

const RELATION_SYSTEM = `You turn nursing flashcards into concept-map relationships.

For each card, state the relationship it teaches as three parts: from, relation, to.

- "from" and "to" MUST be terms copied from that card's own text. This is checked
  by exact string match and a relationship using a word the card does not
  contain is discarded.
- Use the shortest meaningful term: "hypokalemia", not "a client with hypokalemia".
- "relation" is a short verb phrase: causes, is treated with, is a sign of,
  is measured by, increases, decreases, is contraindicated in.
- One relationship per card, the most important one. If a card teaches no
  relationship -- a bare definition or a lone number -- give none for it.
- Never add a relationship from your own knowledge, however obvious. The cards
  are the only source.

Respond with JSON only.`;

export interface ConceptMapOptions {
  lectureId?: string;
  workspaceDir: string;
  model?: string;
  cliPath?: string;
  signal?: AbortSignal;
  maxBudgetUsd?: number;
  /** Cards per model call. */
  batchSize?: number;
  onProgress?: (p: { batch: number; totalBatches: number }) => void;
}

/** Trims a term to the shortest form that still appears in its card. */
function tidyTerm(term: string): string {
  return term
    .trim()
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/**
 * Both ends must really be in the card.
 *
 * Without this the map could introduce a concept the card never mentioned,
 * which would be a new unsourced claim wearing a verified card's citation.
 */
function appearsInCard(term: string, cardText: string): boolean {
  const t = normalizeForMatch(term);
  if (t.length < 2) return false;
  return normalizeForMatch(cardText).includes(t);
}

export async function buildConceptMap(db: Db, opts: ConceptMapOptions): Promise<ConceptMap> {
  // Only verified, accepted cards. listStudiable already enforces both, so a
  // map can never show something that failed the gate.
  const items = listStudiable(db, opts.lectureId ? { lectureId: opts.lectureId } : {});
  const usable = items.filter((i) => i.kind === 'flashcard' || i.kind === 'cloze');

  if (usable.length === 0) {
    return { nodes: [], edges: [], skipped: 0, estimatedCostUsd: 0 };
  }

  const batchSize = opts.batchSize ?? 25;
  const edges: ConceptEdge[] = [];
  let estimatedCostUsd = 0;

  const batches: typeof usable[] = [];
  for (let i = 0; i < usable.length; i += batchSize) batches.push(usable.slice(i, i + batchSize));

  for (const [batchIndex, batch] of batches.entries()) {
    opts.onProgress?.({ batch: batchIndex + 1, totalBatches: batches.length });

    const payload = [
      '<<<CARDS>>>',
      ...batch.map((c, i) => `${i}. Q: ${c.front}\n   A: ${c.back}`),
      '<<<END CARDS>>>',
    ].join('\n');

    const res = await runClaude<{
      relations: { cardIndex: number; from: string; relation: string; to: string }[];
    }>('State the relationship each card teaches. JSON only.', {
      schema: RELATION_SCHEMA,
      workspaceDir: opts.workspaceDir,
      input: payload,
      appendSystemPrompt: RELATION_SYSTEM,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    });

    estimatedCostUsd += res.estimatedCostUsd;

    for (const r of res.data?.relations ?? []) {
      const card = batch[r.cardIndex];
      if (!card) continue;

      const from = tidyTerm(r.from);
      const to = tidyTerm(r.to);
      const relation = tidyTerm(r.relation);
      if (!from || !to || !relation) continue;
      // A self-edge teaches nothing and clutters the map.
      if (normalizeForMatch(from) === normalizeForMatch(to)) continue;

      const cardText = `${card.front} ${card.back}`;
      if (!appearsInCard(from, cardText) || !appearsInCard(to, cardText)) continue;

      const [citation] = listCitations(db, card.id).filter((c) => c.verdict === 'verified');
      const edge: ConceptEdge = {
        from, relation, to, itemId: card.id, cardFront: card.front,
      };
      if (citation) edge.excerpt = citation.excerpt;
      edges.push(edge);
    }
  }

  // Merge nodes case-insensitively, keeping the first spelling seen so the map
  // reads in her lecture's own words.
  const canonical = new Map<string, string>();
  const degree = new Map<string, number>();

  for (const e of edges) {
    for (const term of [e.from, e.to]) {
      const key = normalizeForMatch(term);
      if (!canonical.has(key)) canonical.set(key, term);
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }

  for (const e of edges) {
    e.from = canonical.get(normalizeForMatch(e.from)) ?? e.from;
    e.to = canonical.get(normalizeForMatch(e.to)) ?? e.to;
  }

  const nodes: ConceptNode[] = [...degree.entries()]
    .map(([key, d]) => ({ label: canonical.get(key)!, degree: d }))
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

  return {
    nodes,
    edges,
    skipped: usable.length - new Set(edges.map((e) => e.itemId)).size,
    estimatedCostUsd,
  };
}
