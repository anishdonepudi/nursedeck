import { useCallback, useEffect, useState } from 'react';
import type { TriageItem, TriageCitation } from '@shared/ipc.js';

/**
 * Card triage.
 *
 * Nothing generated reaches her deck without passing through here. The screen
 * is built around the keyboard because the review is repetitive: one key to
 * keep, one to discard, and the citation is always visible so the decision can
 * be made on evidence rather than on whether the card "looks right".
 */

interface Props {
  lectureId: string;
  onDone: () => void;
}

function CitationBlock({ citation, blocks }: { citation: TriageCitation; blocks: TriageItem['blocks'] }) {
  const verdictLabel =
    citation.verdict === 'verified' ? 'Verified' :
    citation.verdict === 'failed' ? 'Failed verification' : 'Quote matched';

  return (
    <div className={`cite cite-${citation.verdict}`}>
      <div className="cite-head">
        <span className="cite-badge">{verdictLabel}</span>
        <span className="cite-source">
          {citation.sourceTitle}
          {blocks.length > 0 && ` · slide ${blocks.map((b) => b.ordinal).join(', ')}`}
        </span>
      </div>
      <blockquote>{citation.excerpt}</blockquote>
      {citation.failureDetail && <p className="cite-fail">{citation.failureDetail}</p>}
    </div>
  );
}

function NclexOptions({ payload }: { payload: unknown }) {
  const p = payload as {
    options?: { text: string; isKey: boolean; rationale: string; errorClass?: string }[];
    itemType?: string;
    selectN?: number;
  } | null;
  if (!p?.options) return null;

  return (
    <div className="options">
      {p.itemType === 'select_n' && <p className="hint">Select {p.selectN}.</p>}
      {p.itemType === 'select_all' && <p className="hint">Select all that apply.</p>}
      {p.options.map((o, i) => (
        <div key={i} className={`option ${o.isKey ? 'option-key' : ''}`}>
          <span className="option-mark">{o.isKey ? '✓' : '·'}</span>
          <div>
            <div className="option-text">{o.text}</div>
            <div className="option-rationale">
              {o.rationale}
              {o.errorClass && <em> ({o.errorClass})</em>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Triage({ lectureId, onDone }: Props) {
  const [items, setItems] = useState<TriageItem[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [kept, setKept] = useState(0);
  const [discarded, setDiscarded] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.nursedeck.listTriage(lectureId);
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [lectureId]);

  const current = items[index];

  const decide = useCallback(
    async (status: 'accepted' | 'rejected') => {
      if (!current) return;
      try {
        await window.nursedeck.setItemStatus(current.id, status);
        if (status === 'accepted') setKept((n) => n + 1);
        else setDiscarded((n) => n + 1);
        setIndex((i) => i + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [current],
  );

  const verify = useCallback(async () => {
    if (!current) return;
    setVerifying(true);
    try {
      const citations = await window.nursedeck.verifyItem(current.id);
      setItems((prev) =>
        prev.map((it) => (it.id === current.id ? { ...it, citations } : it)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }, [current]);

  // Anki-style single-key decisions, so a long review never needs the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || key === 'arrowright') { e.preventDefault(); void decide('accepted'); }
      else if (key === 'd' || key === 'arrowleft') { e.preventDefault(); void decide('rejected'); }
      else if (key === 'v') { e.preventDefault(); void verify(); }
      else if (key === 'escape') { e.preventDefault(); onDone(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, verify, onDone]);

  if (loading) {
    return <div className="triage"><p className="waiting"><span className="spinner" /> Loading cards…</p></div>;
  }

  if (items.length === 0) {
    return (
      <div className="triage">
        <div className="triage-empty">
          <h2>Nothing to review</h2>
          <p className="hint">Generate study material from a lecture first.</p>
          <button type="button" className="primary" onClick={onDone}>Back</button>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="triage">
        <div className="triage-empty">
          <h2>Review complete</h2>
          <p className="hint">
            Kept {kept} · discarded {discarded}. Kept cards still need their citations verified
            before they can be studied.
          </p>
          <button type="button" className="primary" onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="triage">
      <header className="triage-head">
        <span className="triage-count">
          {index + 1} of {items.length}
        </span>
        <span className="triage-kind">{current.kind}</span>
        <span className="triage-tally">kept {kept} · discarded {discarded}</span>
      </header>

      <article className="triage-card">
        <div className="triage-front">{current.front}</div>

        {current.kind === 'nclex'
          ? <NclexOptions payload={current.payload} />
          : <div className="triage-back">{current.back}</div>}

        {current.citations.map((c) => (
          <CitationBlock key={c.id} citation={c} blocks={current.blocks} />
        ))}
      </article>

      {error && <p className="error">{error}</p>}

      <footer className="triage-actions">
        <button type="button" className="ghost danger" onClick={() => void decide('rejected')}>
          Discard <kbd>D</kbd>
        </button>
        <button type="button" className="ghost" onClick={() => void verify()} disabled={verifying}>
          {verifying ? 'Checking…' : <>Verify <kbd>V</kbd></>}
        </button>
        <button type="button" className="primary" onClick={() => void decide('accepted')}>
          Keep <kbd>K</kbd>
        </button>
      </footer>
    </div>
  );
}
