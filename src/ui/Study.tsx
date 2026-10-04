import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyCard, StudyStats } from '@shared/ipc.js';
import { useSpeech } from './useSpeech.js';

/**
 * The review screen.
 *
 * Two evidence-driven choices:
 *
 * - Type-the-answer is the default, not flip-the-card. Re-reading beats recall
 *   at five minutes and loses badly at a week; passive flipping feels
 *   productive and is the weaker study mode.
 * - Confidence is captured BEFORE the answer is revealed and stored separately
 *   from correctness. "Confident and wrong" is the single most valuable signal
 *   in the whole system, and it is unrecoverable if the two are conflated.
 */

const RATINGS = [
  { value: 1, label: 'Again', key: '1', cls: 'again' },
  { value: 2, label: 'Hard', key: '2', cls: 'hard' },
  { value: 3, label: 'Good', key: '3', cls: 'good' },
  { value: 4, label: 'Easy', key: '4', cls: 'easy' },
] as const;

const CONFIDENCE = [
  { value: 0.25, label: 'Guessing' },
  { value: 0.5, label: 'Unsure' },
  { value: 0.75, label: 'Fairly sure' },
  { value: 0.95, label: 'Certain' },
] as const;

function humanInterval(due: string, from = Date.now()): string {
  const ms = new Date(due).getTime() - from;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Forgiving comparison: punctuation, case and spacing should not fail a recall. */
function answerMatches(typed: string, expected: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().normalize('NFKC')
      .replace(/[‐-―−]/g, '-')
      .replace(/[^a-z0-9.\-/ ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(typed);
  const b = norm(expected);
  if (!a) return false;
  return a === b || b.includes(a) || a.includes(b);
}

interface Props {
  lectureId: string;
  onDone: () => void;
}

export function Study({ lectureId, onDone }: Props) {
  const [queue, setQueue] = useState<StudyCard[]>([]);
  const [stats, setStats] = useState<StudyStats>();
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confidence, setConfidence] = useState<number>();
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState('');
  const [wasCorrect, setWasCorrect] = useState<boolean>();
  const [error, setError] = useState<string>();
  const speech = useSpeech();
  const startedAt = useRef(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const current = queue[index];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cards, s] = await Promise.all([
        window.nursedeck.studyQueue(lectureId),
        window.nursedeck.studyStats(lectureId),
      ]);
      setQueue(cards);
      setStats(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lectureId]);

  useEffect(() => { void load(); }, [load]);

  // Reset per-card state and focus the input, so typing can start immediately.
  useEffect(() => {
    setRevealed(false);
    setTyped('');
    setConfidence(undefined);
    setWasCorrect(undefined);
    startedAt.current = Date.now();
    inputRef.current?.focus();
    // Reading the question aloud is the point of the feature: it lets her
    // answer out loud rather than silently recognising.
    if (speech.enabled && current) speech.speak(current.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const reveal = useCallback(() => {
    if (!current || revealed) return;
    setWasCorrect(answerMatches(typed, current.expectedAnswer));
    setRevealed(true);
    if (speech.enabled) speech.speak(current.expectedAnswer);
  }, [current, revealed, typed, speech]);

  const answer = useCallback(
    async (rating: number) => {
      if (!current || !revealed) return;
      try {
        await window.nursedeck.answerCard({
          itemId: current.id,
          rating,
          ...(confidence !== undefined ? { confidence } : {}),
          ...(wasCorrect !== undefined ? { correct: wasCorrect } : {}),
          durationMs: Date.now() - startedAt.current,
          mode: 'type',
        });
        setIndex((i) => i + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [current, revealed, confidence, wasCorrect],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onDone(); return; }
      if (e.key.toLowerCase() === 'r' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault();
        speech.speak(revealed ? current?.expectedAnswer ?? '' : current?.prompt ?? '');
        return;
      }
      if (!revealed) {
        if (e.key === 'Enter') { e.preventDefault(); reveal(); }
        return;
      }
      // Anki's muscle memory: 1-4 grade, space is Good.
      const n = Number(e.key);
      if (n >= 1 && n <= 4) { e.preventDefault(); void answer(n); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void answer(3); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, reveal, answer, onDone, speech, current]);

  if (loading) {
    return <div className="study"><p className="waiting"><span className="spinner" /> Loading...</p></div>;
  }

  if (queue.length === 0 || !current) {
    return (
      <div className="study">
        <div className="study-empty">
          <h2>{queue.length === 0 ? 'Nothing due' : 'Session complete'}</h2>
          {stats && (
            <dl className="stats">
              <div><dt>Cards ready</dt><dd>{stats.total}</dd></div>
              <div><dt>Not yet seen</dt><dd>{stats.unseen}</dd></div>
              <div><dt>Predicted recall</dt><dd>{Math.round(stats.averageRetrievability * 100)}%</dd></div>
              {stats.calibrationGap !== undefined && (
                <div>
                  <dt>Calibration</dt>
                  <dd className={stats.calibrationGap > 0.1 ? 'warn-text' : ''}>
                    {stats.calibrationGap > 0.1
                      ? `${Math.round(stats.calibrationGap * 100)} points overconfident`
                      : stats.calibrationGap < -0.1
                        ? `${Math.round(-stats.calibrationGap * 100)} points underconfident`
                        : 'well calibrated'}
                  </dd>
                </div>
              )}
              {stats.illusionOfKnowing > 0 && (
                <div>
                  <dt>Confident but wrong</dt>
                  <dd className="warn-text">{stats.illusionOfKnowing}</dd>
                </div>
              )}
            </dl>
          )}
          <button type="button" className="primary" onClick={onDone}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="study">
      <header className="study-head">
        <span>{index + 1} of {queue.length}</span>
        {current.isNew && <span className="pill">new</span>}
        <span className="study-kind">{current.kind}</span>

        {speech.supported && (
          <span className="speech-controls">
            <button
              type="button"
              className={`chip ${speech.enabled ? 'chip-on' : ''}`}
              onClick={() => speech.setEnabled(!speech.enabled)}
              title="Read cards aloud"
            >
              {speech.enabled ? 'Read aloud on' : 'Read aloud off'}
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => speech.speak(revealed ? current.expectedAnswer : current.prompt)}
              title="Replay (R)"
            >
              {speech.speaking ? 'Speaking' : 'Replay'}
            </button>
          </span>
        )}
      </header>

      <article className="study-card">
        <div className="study-front">{current.prompt}</div>

        {!revealed ? (
          <>
            <input
              ref={inputRef}
              className="study-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your answer, then press Enter"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="confidence">
              <span className="confidence-label">How sure are you?</span>
              {CONFIDENCE.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`chip ${confidence === c.value ? 'chip-on' : ''}`}
                  onClick={() => setConfidence(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button type="button" className="primary" onClick={reveal}>
              Show answer <kbd>Enter</kbd>
            </button>
          </>
        ) : (
          <>
            {typed && (
              <div className={`typed ${wasCorrect ? 'typed-ok' : 'typed-no'}`}>
                You wrote: {typed}
              </div>
            )}
            <div className="study-back">{current.expectedAnswer}</div>

            {current.citation && (
              <div className="cite cite-verified">
                <div className="cite-head">
                  <span className="cite-badge">Source</span>
                  <span className="cite-source">
                    {current.citation.sourceTitle}
                    {current.blocks.length > 0 && ` - slide ${current.blocks.map((b) => b.ordinal).join(', ')}`}
                  </span>
                </div>
                <blockquote>{current.citation.excerpt}</blockquote>
              </div>
            )}

            <div className="ratings">
              {RATINGS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={`rating rating-${r.cls}`}
                  onClick={() => void answer(r.value)}
                >
                  <span className="rating-label">{r.label}</span>
                  <span className="rating-interval">
                    {humanInterval(current.preview[r.cls as keyof typeof current.preview])}
                  </span>
                  <kbd>{r.key}</kbd>
                </button>
              ))}
            </div>
          </>
        )}
      </article>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
