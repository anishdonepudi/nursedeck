import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConceptMapData, ConceptEdgeRow } from '@shared/ipc.js';

/**
 * The concept map.
 *
 * Every arrow comes from a card that already passed the citation gate, so
 * clicking one shows the lecture text behind it. That is the whole reason this
 * screen is trustworthy: nothing here is a relationship a model decided was
 * true, and anything she doubts can be checked in two clicks.
 *
 * Laid out on a circle rather than with a physics simulation. A force layout
 * needs a library and settles differently on every open, which makes the map
 * harder to learn; a stable ring puts the same concept in the same place every
 * time, and the hubs are placed first so the spine of the topic reads clearly.
 */

interface Props {
  lectureId?: string;
  onDone: () => void;
}

const WIDTH = 900;
const HEIGHT = 620;
const RADIUS = 235;

export function ConceptMap({ lectureId, onDone }: Props) {
  const [map, setMap] = useState<ConceptMapData>();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [selected, setSelected] = useState<ConceptEdgeRow>();
  const [focus, setFocus] = useState<string>();
  const [error, setError] = useState<string>();

  const build = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setProgress('Reading your verified cards');
    try {
      setMap(await window.nursedeck.conceptMap(lectureId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setProgress(undefined);
    }
  }, [lectureId]);

  useEffect(() => { void build(); }, [build]);

  /** Stable ring positions, hubs first. */
  const placed = useMemo(() => {
    const nodes = map?.nodes ?? [];
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    return new Map(
      nodes.map((n, i) => {
        const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
        return [n.label, { x: cx + RADIUS * Math.cos(angle), y: cy + RADIUS * Math.sin(angle), node: n }];
      }),
    );
  }, [map]);

  const visibleEdges = useMemo(() => {
    const edges = map?.edges ?? [];
    if (!focus) return edges;
    return edges.filter((e) => e.from === focus || e.to === focus);
  }, [map, focus]);

  if (loading) {
    return (
      <div className="dash">
        <p className="waiting"><span className="spinner" /> {progress ?? 'Building the map'}</p>
      </div>
    );
  }

  return (
    <div className="dash conceptmap">
      <section className="panel">
        <div className="panel-head">
          <h2>How it fits together</h2>
          <div className="panel-head-actions">
            {focus && (
              <button type="button" className="ghost" onClick={() => setFocus(undefined)}>
                Show everything
              </button>
            )}
            <button type="button" className="ghost" onClick={() => void build()}>Rebuild</button>
            <button type="button" className="ghost" onClick={onDone}>Back</button>
          </div>
        </div>

        <p className="hint">
          Built only from cards whose source was checked, so every arrow can be traced back to
          your lecture. Click one to see the slide text it came from.
        </p>

        {error && <p className="error">{error}</p>}

        {map && map.edges.length === 0 ? (
          <p className="hint empty">
            No relationships yet. Maps are drawn from verified cards, so study material has to be
            generated and checked first.
          </p>
        ) : null}
      </section>

      {map && map.edges.length > 0 && (
        <section className="panel">
          <svg
            className="map-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label="Concept map of verified cards"
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="map-arrow-head" />
              </marker>
            </defs>

            {visibleEdges.map((e, i) => {
              const a = placed.get(e.from);
              const b = placed.get(e.to);
              if (!a || !b) return null;
              const isSelected = selected?.itemId === e.itemId;
              return (
                <g
                  key={`${e.itemId}-${i}`}
                  className={`map-edge ${isSelected ? 'map-edge-on' : ''}`}
                  onClick={() => setSelected(e)}
                >
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#arrow)" />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                    {e.relation}
                  </text>
                </g>
              );
            })}

            {[...placed.values()].map(({ x, y, node }) => (
              <g
                key={node.label}
                className={`map-node ${focus === node.label ? 'map-node-on' : ''}`}
                onClick={() => setFocus(focus === node.label ? undefined : node.label)}
              >
                <circle cx={x} cy={y} r={Math.min(30, 10 + node.degree * 3)} />
                <text x={x} y={y - Math.min(30, 10 + node.degree * 3) - 6} textAnchor="middle">
                  {node.label}
                </text>
              </g>
            ))}
          </svg>

          <p className="hint">
            {map.nodes.length} concepts, {map.edges.length} relationships
            {map.skipped > 0 && ` · ${map.skipped} cards taught no relationship`}
          </p>
        </section>
      )}

      {selected && (
        <section className="panel">
          <h2>{selected.from} → {selected.to}</h2>
          <p className="hint">From the card: {selected.cardFront}</p>
          {selected.excerpt ? (
            <div className="cite cite-verified">
              <div className="cite-head"><span className="cite-badge">Source</span></div>
              <blockquote>{selected.excerpt}</blockquote>
            </div>
          ) : (
            <p className="hint">That card's source quote is no longer available.</p>
          )}
        </section>
      )}
    </div>
  );
}
