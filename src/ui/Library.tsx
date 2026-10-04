import { useCallback, useEffect, useState } from 'react';
import type { LectureSummary, GenKind, GenProgress, GenSummary } from '@shared/ipc.js';

/**
 * The home screen: import a lecture, generate from it, then review.
 *
 * Generation is slow and costs model calls, so progress is shown per batch and
 * the run is cancellable. The result deliberately reports what was DISCARDED as
 * prominently as what was kept — a rejection means the citation gate did its
 * job, and hiding that would make the tool look like it silently lost content.
 */

const KINDS: { id: GenKind; label: string; hint: string }[] = [
  { id: 'flashcard', label: 'Flashcards', hint: 'One fact per card' },
  { id: 'cloze', label: 'Fill in the blank', hint: 'Cloze deletions' },
  { id: 'qa', label: 'Q&A', hint: 'Short written answers' },
  { id: 'nclex', label: 'NCLEX questions', hint: 'Clinical vignettes' },
];

interface Props {
  /** Owned by App so it survives navigating to triage and back. */
  selectedId?: string;
  onSelect: (lectureId: string) => void;
  onReview: (lectureId: string) => void;
  onStudy: (lectureId: string) => void;
  onExam: (lectureId: string) => void;
}

export function Library({ selectedId, onSelect, onReview, onStudy, onExam }: Props) {
  const [lectures, setLectures] = useState<LectureSummary[]>([]);
  const selected = selectedId;
  const setSelected = onSelect;
  const [kinds, setKinds] = useState<GenKind[]>(['flashcard', 'cloze']);
  const [busy, setBusy] = useState<'importing' | 'generating'>();
  const [progress, setProgress] = useState<GenProgress>();
  const [summary, setSummary] = useState<GenSummary>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setLectures(await window.nursedeck.listLectures());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.nursedeck.onGenerateProgress(setProgress), []);

  const importFiles = useCallback(async () => {
    setError(undefined);
    const paths = await window.nursedeck.pickLecture();
    if (paths.length === 0) return;

    setBusy('importing');
    try {
      for (const p of paths) {
        const r = await window.nursedeck.importLecture(p);
        setSelected(r.lectureId);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const generate = useCallback(async () => {
    if (!selected || kinds.length === 0) return;
    setBusy('generating');
    setSummary(undefined);
    setProgress(undefined);
    setError(undefined);
    try {
      setSummary(await window.nursedeck.generate(selected, kinds));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
  }, [selected, kinds, refresh]);

  const toggleKind = (k: GenKind) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const current = lectures.find((l) => l.id === selected);

  return (
    <div className="library">
      <section className="panel">
        <div className="panel-head">
          <h2>Your lectures</h2>
          <button type="button" className="primary" onClick={() => void importFiles()} disabled={!!busy}>
            {busy === 'importing' ? 'Importing…' : 'Add PowerPoint'}
          </button>
        </div>

        {lectures.length === 0 ? (
          <p className="hint empty">
            No lectures yet. Add a PowerPoint to start building study material from it.
          </p>
        ) : (
          <ul className="lectures">
            {lectures.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className={`lecture ${selected === l.id ? 'lecture-selected' : ''}`}
                  onClick={() => setSelected(l.id)}
                >
                  <span className="lecture-title">{l.title}</span>
                  <span className="lecture-meta">
                    {l.studiableCount > 0 && <em className="pill pill-ok">{l.studiableCount} ready</em>}
                    {l.pendingCount > 0 && <em className="pill pill-pending">{l.pendingCount} to review</em>}
                    {l.itemCount === 0 && <em className="pill">no cards yet</em>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {current && (
        <section className="panel">
          <h2>Build study material</h2>
          <p className="hint">From “{current.title}”.</p>

          <div className="kinds">
            {KINDS.map((k) => (
              <label key={k.id} className={`kind ${kinds.includes(k.id) ? 'kind-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={kinds.includes(k.id)}
                  onChange={() => toggleKind(k.id)}
                  disabled={!!busy}
                />
                <span>
                  <span className="kind-label">{k.label}</span>
                  <span className="kind-hint">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="gate-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void generate()}
              disabled={!!busy || kinds.length === 0}
            >
              {busy === 'generating' ? 'Generating…' : 'Generate'}
            </button>

            {busy === 'generating' && (
              <button type="button" className="ghost" onClick={() => void window.nursedeck.cancelGeneration()}>
                Cancel
              </button>
            )}

            {current.pendingCount > 0 && !busy && (
              <button type="button" className="ghost" onClick={() => onReview(current.id)}>
                Review {current.pendingCount} card{current.pendingCount === 1 ? '' : 's'}
              </button>
            )}

            {current.studiableCount > 0 && !busy && (
              <>
                <button type="button" className="ghost" onClick={() => onStudy(current.id)}>
                  Study
                </button>
                <button type="button" className="ghost" onClick={() => onExam(current.id)}>
                  Practice exam
                </button>
              </>
            )}
          </div>

          {progress && busy === 'generating' && (
            <p className="waiting">
              <span className="spinner" aria-hidden="true" />
              {progress.phase === 'validating' ? 'Checking citations' : `Writing ${progress.kind}s`}
              {' · '}batch {progress.batch} of {progress.totalBatches}
            </p>
          )}

          {summary && (
            <div className="summary">
              <p>
                <strong>{summary.accepted}</strong> card{summary.accepted === 1 ? '' : 's'} ready to review
                {summary.rejected.length > 0 && (
                  <> · <strong>{summary.rejected.length}</strong> discarded</>
                )}
              </p>
              {summary.rejected.length > 0 && (
                <details>
                  <summary>Why were cards discarded?</summary>
                  <ul className="rejects">
                    {summary.rejected.map((r, i) => (
                      <li key={i}>
                        <span className="reject-stage">{r.stage}</span>
                        <span className="reject-front">{r.front.slice(0, 110)}</span>
                        <span className="reject-reason">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="hint">
                    Discarded cards made a claim the lecture does not support. That check is what
                    keeps the rest trustworthy.
                  </p>
                </details>
              )}
              {summary.errors.length > 0 && (
                <ul className="rejects">
                  {summary.errors.map((e, i) => <li key={i} className="reject-reason">{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
