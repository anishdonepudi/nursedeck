import { useCallback, useEffect, useState } from 'react';
import type {
  TriageItem, TriageCitation, CorroborationReport, VerifyProgress, VerifyAllSummary,
} from '@shared/ipc.js';

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
          {blocks.length > 0 && ` - slide ${blocks.map((b) => b.ordinal).join(', ')}`}
        </span>
      </div>
      <blockquote>{citation.excerpt}</blockquote>
      {citation.failureDetail && <p className="cite-fail">{citation.failureDetail}</p>}
    </div>
  );
}

/**
 * Result of checking a claim against an independent authority.
 *
 * A conflict is given the most prominent treatment deliberately: it means her
 * lecture and the manufacturer's labelling disagree, which is exactly the thing
 * she would otherwise memorise without ever noticing.
 */
function Corroboration({ report }: { report: CorroborationReport }) {
  const label =
    report.outcome === 'confirmed' ? 'Confirmed by an independent source'
    : report.outcome === 'conflict' ? 'Disagrees with the official source'
    : report.outcome === 'not_found' ? 'No official source covers this'
    : 'Could not be settled either way';

  return (
    <div className={`corr corr-${report.outcome}`}>
      <div className="cite-head">
        <span className="cite-badge">{label}</span>
        {report.sourceTitle && <span className="cite-source">{report.sourceTitle}</span>}
      </div>
      {report.excerpt && <blockquote>{report.excerpt}</blockquote>}
      {report.detail && <p className="corr-detail">{report.detail}</p>}
      {report.sourceUrl && (
        <button
          type="button"
          className="linkish"
          onClick={() => void window.nursedeck.openExternal(report.sourceUrl!)}
        >
          Open the source
        </button>
      )}
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
          <span className="option-mark">{o.isKey ? '✓' : '-'}</span>
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
  const [corroborating, setCorroborating] = useState(false);
  const [corroboration, setCorroboration] = useState<CorroborationReport>();
  const [error, setError] = useState<string>();
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<VerifyProgress>();
  const [verifySummary, setVerifySummary] = useState<VerifyAllSummary>();

  // Extracted so the bulk check can re-read after it rewrites every verdict.
  const load = useCallback(async () => {
    try {
      setItems(await window.nursedeck.listTriage(lectureId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lectureId]);

  useEffect(() => { void load(); }, [load]);

  const current = items[index];

  // Cleared per card, so one card's result never appears under another.
  useEffect(() => setCorroboration(undefined), [index]);

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

  const corroborate = useCallback(async () => {
    if (!current) return;
    setCorroborating(true);
    setCorroboration(undefined);
    try {
      setCorroboration(await window.nursedeck.corroborate(current.id));
      // A confirmation adds a citation, so refresh what is shown.
      const refreshed = await window.nursedeck.listTriage(lectureId);
      const updated = refreshed.find((i) => i.id === current.id);
      if (updated) {
        setItems((prev) => prev.map((it) => (it.id === current.id ? updated : it)));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCorroborating(false);
    }
  }, [current, lectureId]);

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

  const verifyAll = useCallback(async () => {
    setVerifyingAll(true);
    setVerifySummary(undefined);
    setVerifyProgress(undefined);
    setError(undefined);
    try {
      const summary = await window.nursedeck.verifyAll(lectureId);
      setVerifySummary(summary);
      // Re-read, because verdicts changed underneath every card on screen.
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifyingAll(false);
      setVerifyProgress(undefined);
    }
  }, [lectureId, load]);

  useEffect(() => window.nursedeck.onVerifyProgress(setVerifyProgress), []);

  // Anki-style single-key decisions, so a long review never needs the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k' || key === 'arrowright') { e.preventDefault(); void decide('accepted'); }
      else if (key === 'd' || key === 'arrowleft') { e.preventDefault(); void decide('rejected'); }
      else if (key === 'v') { e.preventDefault(); void verify(); }
      else if (key === 'f') { e.preventDefault(); void corroborate(); }
      else if (key === 'escape') { e.preventDefault(); onDone(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, verify, corroborate, onDone]);

  if (loading) {
    return <div className="triage"><p className="waiting"><span className="spinner" /> Loading cards...</p></div>;
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
            Kept {kept} - discarded {discarded}. Kept cards still need their citations verified
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
        <span className="triage-tally">kept {kept} - discarded {discarded}</span>

        {/*
          Verification was one card at a time, which meant fifty clicks to find
          out which cards were studiable. A guarantee nobody has the patience to
          reach is not a working guarantee.
        */}
        {verifyingAll ? (
          <button type="button" className="chip" onClick={() => void window.nursedeck.cancelVerifyAll()}>
            Stop checking
          </button>
        ) : (
          <button type="button" className="chip" onClick={() => void verifyAll()}>
            Check all {items.length}
          </button>
        )}
      </header>

      {verifyingAll && (
        <p className="waiting">
          <span className="spinner" aria-hidden="true" />
          {verifyProgress
            ? `Checking sources - card ${verifyProgress.item} of ${verifyProgress.totalItems}` +
              ` (${verifyProgress.verified} verified, ${verifyProgress.failed} not supported)`
            : 'Checking sources'}
        </p>
      )}

      {verifySummary && !verifyingAll && (
        <p className="hint notice">
          Checked {verifySummary.checked}: {verifySummary.verified} verified and ready to study,
          {' '}{verifySummary.failed} not supported by the slide.
          {verifySummary.remaining > 0 &&
            ` ${verifySummary.remaining} not checked${
              verifySummary.stoppedEarly === 'budget' ? ' (stopped at the spending limit)' : ''
            }.`}
          {verifySummary.errors.length > 0 && ` ${verifySummary.errors.length} could not be checked.`}
        </p>
      )}

      <article className="triage-card">
        <div className="triage-front">{current.front}</div>

        {current.kind === 'nclex'
          ? <NclexOptions payload={current.payload} />
          : <div className="triage-back">{current.back}</div>}

        {current.citations.map((c) => (
          <CitationBlock key={c.id} citation={c} blocks={current.blocks} />
        ))}

        {corroboration && <Corroboration report={corroboration} />}
      </article>

      {error && <p className="error">{error}</p>}

      <footer className="triage-actions">
        <button type="button" className="ghost danger" onClick={() => void decide('rejected')}>
          Discard <kbd>D</kbd>
        </button>
        <button type="button" className="ghost" onClick={() => void verify()} disabled={verifying}>
          {verifying ? 'Checking...' : <>Verify <kbd>V</kbd></>}
        </button>
        <button type="button" className="ghost" onClick={() => void corroborate()} disabled={corroborating}>
          {corroborating ? 'Looking up...' : <>Cross-check <kbd>F</kbd></>}
        </button>
        <button type="button" className="primary" onClick={() => void decide('accepted')}>
          Keep <kbd>K</kbd>
        </button>
      </footer>
    </div>
  );
}
