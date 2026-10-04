import { useCallback, useEffect, useRef, useState } from 'react';
import type { StartedExam, ExamResult, ExamAnswer, ExamSubscore } from '@shared/ipc.js';

/**
 * Practice exam.
 *
 * Mirrors the real sitting: no feedback until the end, and no going back to a
 * previous question. The report that follows is the point — a single score
 * tells her almost nothing, whereas "Prioritize Hypotheses 40%" tells her which
 * reasoning step to work on.
 */

interface Props {
  lectureId?: string;
  onDone: () => void;
}

function Subscores({ title, rows, note }: { title: string; rows: ExamSubscore[]; note?: string }) {
  if (rows.length === 0) return null;
  return (
    <section className="subscores">
      <h3>{title}</h3>
      {note && <p className="hint">{note}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <span className="sub-label">{r.label}</span>
            <span className="sub-bar">
              <span
                className={`sub-fill ${r.percent < 50 ? 'sub-low' : r.percent < 75 ? 'sub-mid' : 'sub-high'}`}
                style={{ width: `${Math.max(2, r.percent)}%` }}
              />
            </span>
            <span className="sub-value">
              {r.percent}%
              {/* Below ~15 items a subscore is noise, so it is labelled rather
                  than presented as a measurement. */}
              {!r.reliable && <em className="sub-weak"> · only {r.n}</em>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Exam({ lectureId, onDone }: Props) {
  const [exam, setExam] = useState<StartedExam>();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, string[]>>(new Map());
  const [result, setResult] = useState<ExamResult>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [length, setLength] = useState(25);
  const [started, setStarted] = useState(false);
  const questionStart = useRef(Date.now());
  const durations = useRef(new Map<string, number>());

  const start = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setExam(await window.nursedeck.startExam(lectureId, length));
      setStarted(true);
      questionStart.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lectureId, length]);

  useEffect(() => { setLoading(false); }, []);

  const current = exam?.questions[index];

  const toggle = useCallback(
    (optionId: string) => {
      if (!current) return;
      setAnswers((prev) => {
        const next = new Map(prev);
        const chosen = next.get(current.itemId) ?? [];
        if (current.itemType === 'multiple_choice') {
          next.set(current.itemId, [optionId]);
        } else {
          next.set(
            current.itemId,
            chosen.includes(optionId) ? chosen.filter((o) => o !== optionId) : [...chosen, optionId],
          );
        }
        return next;
      });
    },
    [current],
  );

  const advance = useCallback(() => {
    if (!current) return;
    durations.current.set(current.itemId, Date.now() - questionStart.current);
    questionStart.current = Date.now();
    setIndex((i) => i + 1);
  }, [current]);

  const submit = useCallback(async () => {
    if (!exam) return;
    setSubmitting(true);
    try {
      const payload: ExamAnswer[] = exam.questions.map((q) => ({
        itemId: q.itemId,
        selected: answers.get(q.itemId) ?? [],
        ...(durations.current.has(q.itemId)
          ? { durationMs: durations.current.get(q.itemId)! }
          : {}),
      }));
      setResult(await window.nursedeck.submitExam(exam.examId, payload));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [exam, answers]);

  /* ----------------------------- results ----------------------------- */

  if (result) {
    const weakest = result.byNjcmmStep[0];
    return (
      <div className="exam">
        <section className="panel">
          <h2>Results</h2>
          <p className="score">
            <strong>{result.pointsEarned}</strong> of {result.pointsPossible} points
            <span className="score-pct">{result.percent}%</span>
          </p>
          <p className="hint">
            Scored in points rather than questions, because partial credit applies.
            {' '}You took {result.actualMinutes} minutes against a {result.estimatedMinutes}-minute budget.
          </p>

          {weakest && !weakest.reliable && (
            <p className="hint">
              Subscores below are based on few questions each — treat them as a direction,
              not a measurement.
            </p>
          )}

          <Subscores
            title="By clinical judgment step"
            rows={result.byNjcmmStep}
            note="This is the most useful view: it points at a reasoning stage rather than a topic."
          />
          <Subscores title="By client need" rows={result.byClientNeed} />
          <Subscores title="By cognitive level" rows={result.byCognitiveLevel} />
          <Subscores
            title="By question format"
            rows={result.byItemType}
            note="A gap here is unfamiliarity with a format, not a knowledge gap."
          />

          {result.overSelectionRate !== undefined && result.overSelectionRate > 0.2 && (
            <p className="hint warn-text">
              You selected more options than needed on{' '}
              {Math.round(result.overSelectionRate * 100)}% of select-all questions. Those are
              scored with a penalty, so extra guesses cost points.
            </p>
          )}

          <div className="gate-actions">
            <button type="button" className="primary" onClick={onDone}>Done</button>
          </div>
        </section>

        <section className="panel">
          <h2>Review</h2>
          {result.review.map((q) => (
            <article key={q.itemId} className="review-item">
              <div className="review-head">
                <span className={q.earned === q.possible ? 'pill pill-ok' : 'pill pill-pending'}>
                  {q.earned} / {q.possible}
                </span>
              </div>
              <p className="review-stem">{q.stem}</p>
              <div className="options">
                {q.options.map((o) => (
                  <div
                    key={o.id}
                    className={`option ${o.isKey ? 'option-key' : ''} ${o.chosen && !o.isKey ? 'option-wrong' : ''}`}
                  >
                    <span className="option-mark">{o.isKey ? '✓' : o.chosen ? '✕' : '·'}</span>
                    <div>
                      <div className="option-text">
                        {o.text}
                        {o.chosen && <em className="chose"> — you chose this</em>}
                      </div>
                      <div className="option-rationale">
                        {o.rationale}
                        {o.errorClass && <em> ({o.errorClass})</em>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {q.citation && (
                <div className="cite cite-verified">
                  <div className="cite-head">
                    <span className="cite-badge">Source</span>
                    <span className="cite-source">{q.citation.sourceTitle}</span>
                  </div>
                  <blockquote>{q.citation.excerpt}</blockquote>
                </div>
              )}
            </article>
          ))}
        </section>
      </div>
    );
  }

  /* ------------------------------ setup ------------------------------ */

  if (!started) {
    return (
      <div className="exam">
        <section className="panel">
          <h2>Practice exam</h2>
          <p className="hint">
            Blueprint-weighted to the 2026 NCLEX-RN test plan. No feedback until you finish,
            and no going back — same as the real thing.
          </p>
          <div className="lengths">
            {[10, 25, 50, 85].map((n) => (
              <button
                key={n}
                type="button"
                className={`chip ${length === n ? 'chip-on' : ''}`}
                onClick={() => setLength(n)}
              >
                {n} questions
              </button>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="gate-actions">
            <button type="button" className="primary" onClick={() => void start()} disabled={loading}>
              {loading ? 'Building…' : 'Start exam'}
            </button>
            <button type="button" className="ghost" onClick={onDone}>Back</button>
          </div>
        </section>
      </div>
    );
  }

  if (!exam || !current) {
    return (
      <div className="exam">
        <section className="panel">
          <h2>Ready to submit</h2>
          <p className="hint">
            {answers.size} of {exam?.questions.length ?? 0} answered.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="gate-actions">
            <button type="button" className="primary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Scoring…' : 'Submit exam'}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const chosen = answers.get(current.itemId) ?? [];

  return (
    <div className="exam">
      <header className="study-head">
        <span>{index + 1} of {exam.questions.length}</span>
        {current.clientNeed && <span className="study-kind">{current.clientNeed}</span>}
        <span style={{ marginLeft: 'auto' }} className="hint">~{exam.estimatedMinutes} min total</span>
      </header>

      <article className="study-card">
        <div className="study-front">{current.stem}</div>
        {current.itemType === 'select_all' && (
          <p className="hint">Select all that apply. Incorrect choices lose a point.</p>
        )}
        {current.itemType === 'select_n' && (
          <p className="hint">Select {current.selectN}.</p>
        )}

        <div className="options">
          {current.options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`option option-pick ${chosen.includes(o.id) ? 'option-chosen' : ''}`}
              onClick={() => toggle(o.id)}
            >
              <span className="option-mark">{chosen.includes(o.id) ? '●' : '○'}</span>
              <div className="option-text">{o.text}</div>
            </button>
          ))}
        </div>

        <div className="gate-actions">
          <button type="button" className="primary" onClick={advance}>
            {index + 1 === exam.questions.length ? 'Finish' : 'Next'}
          </button>
        </div>
      </article>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
