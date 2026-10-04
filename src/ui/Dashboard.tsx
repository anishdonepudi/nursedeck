import { useCallback, useEffect, useState } from 'react';
import type { Dashboard as DashboardData } from '@shared/ipc.js';

/**
 * Readiness dashboard.
 *
 * The guiding rule is that no number is shown as more certain than it is. A
 * topic answered twice correctly reads "not enough data yet", not "100%",
 * because two weeks before an exam a falsely reassuring figure is worse than
 * no figure at all.
 */

interface Props {
  lectureId?: string;
  onDone: () => void;
  onStudy: () => void;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function ReadinessBar({ low, high, mean, reliable }: {
  low: number; high: number; mean: number; reliable: boolean;
}) {
  if (!reliable) {
    // A wide interval drawn as a bar still reads as a measurement, so an
    // unreliable topic shows the uncertainty in words instead.
    return <span className="sub-weak">not enough data yet</span>;
  }
  return (
    <span className="range-bar" title={`${pct(low)} - ${pct(high)}`}>
      <span
        className="range-span"
        style={{ left: `${low * 100}%`, width: `${Math.max(2, (high - low) * 100)}%` }}
      />
      <span className="range-mean" style={{ left: `${mean * 100}%` }} />
    </span>
  );
}

export function Dashboard({ lectureId, onDone, onStudy }: Props) {
  const [data, setData] = useState<DashboardData>();
  const [examDate, setExamDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await window.nursedeck.dashboard(lectureId, examDate || undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lectureId, examDate]);

  useEffect(() => { void load(); }, [load]);

  const exportDeck = useCallback(async (format: 'anki-tsv' | 'quizlet-csv' | 'apkg') => {
    setExporting(true);
    setExported(undefined);
    try {
      const r = await window.nursedeck.exportDeck(lectureId, format);
      if (r.saved) {
        setExported(
          `Exported ${r.cardCount} card${r.cardCount === 1 ? '' : 's'}` +
          (r.skipped > 0 ? ` - ${r.skipped} withheld as unverified` : ''),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }, [lectureId]);

  if (loading && !data) {
    return <div className="dash"><p className="waiting"><span className="spinner" /> Loading...</p></div>;
  }

  const maxDue = Math.max(1, ...(data?.forecast ?? []).map((f) => f.due));

  return (
    <div className="dash">
      <section className="panel">
        <div className="panel-head">
          <h2>Where you stand</h2>
          <button type="button" className="ghost" onClick={onDone}>Back</button>
        </div>

        {data && (
          <dl className="stats">
            <div><dt>Cards ready</dt><dd>{data.stats.total}</dd></div>
            <div><dt>Due now</dt><dd>{data.stats.dueNow}</dd></div>
            <div><dt>Not yet seen</dt><dd>{data.stats.unseen}</dd></div>
            <div>
              <dt>Predicted recall</dt>
              <dd>{pct(data.stats.averageRetrievability)}</dd>
            </div>
            {data.stats.calibrationGap !== undefined && (
              <div>
                <dt>Calibration</dt>
                <dd className={Math.abs(data.stats.calibrationGap) > 0.1 ? 'warn-text' : ''}>
                  {data.stats.calibrationGap > 0.1
                    ? `${Math.round(data.stats.calibrationGap * 100)} points overconfident`
                    : data.stats.calibrationGap < -0.1
                      ? `${Math.round(-data.stats.calibrationGap * 100)} points underconfident`
                      : 'well calibrated'}
                </dd>
              </div>
            )}
          </dl>
        )}

        {data && data.stats.dueNow > 0 && (
          <div className="gate-actions">
            <button type="button" className="primary" onClick={onStudy}>
              Study {data.stats.dueNow} due card{data.stats.dueNow === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </section>

      {data && data.topics.length > 0 && (
        <section className="panel">
          <h2>Readiness by topic</h2>
          <p className="hint">
            Weakest first. The bar shows a range, not a point -- a topic you have barely
            practised cannot be measured yet, and is labelled so.
          </p>
          <ul className="topics">
            {data.topics.map((t) => (
              <li key={t.topic}>
                <span className="topic-name">{t.topic}</span>
                <ReadinessBar low={t.low} high={t.high} mean={t.readiness} reliable={t.reliable} />
                <span className="topic-meta">
                  {t.reliable ? pct(t.readiness) : ''}
                  <em> - {t.cardCount} card{t.cardCount === 1 ? '' : 's'}, {t.reviewCount} review{t.reviewCount === 1 ? '' : 's'}</em>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Workload ahead</h2>
        <p className="hint">Cards falling due over the next 30 days.</p>
        <div className="forecast">
          {(data?.forecast ?? []).map((f) => (
            <span
              key={f.date}
              className="forecast-bar"
              style={{ height: `${Math.max(2, (f.due / maxDue) * 100)}%` }}
              title={`${f.date}: ${f.due} due`}
            />
          ))}
        </div>

        <div className="exam-date">
          <label htmlFor="exam-date">Exam date</label>
          <input
            id="exam-date"
            type="date"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
          />
        </div>

        {data?.projection && data.projection.length > 0 && (
          <>
            <p className="hint">
              Projected recall on that date if you keep to the current schedule. A topic is
              flagged when its next review falls after the exam.
            </p>
            <ul className="topics">
              {data.projection.map((p) => (
                <li key={p.topic}>
                  <span className="topic-name">{p.topic}</span>
                  <span className={`pill ${p.atRisk ? 'pill-pending' : 'pill-ok'}`}>
                    {p.atRisk ? 'at risk' : 'on track'}
                  </span>
                  <span className="topic-meta">
                    {pct(p.projectedRecall)}
                    {p.unseenBefore > 0 && <em> - {p.unseenBefore} not revisited before then</em>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {data && data.illusions.length > 0 && (
        <section className="panel">
          <h2>Thought you knew these</h2>
          <p className="hint">
            Answered confidently and still got wrong. These are the gaps you do not know you
            have, so nothing else will surface them.
          </p>
          <ul className="weak-list">
            {data.illusions.map((c) => (
              <li key={c.itemId}>
                <span className="weak-front">{c.front}</span>
                <span className="weak-meta">
                  {c.occurrences}× wrong at {pct(c.meanConfidence ?? 0)} confidence
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.leeches.length > 0 && (
        <section className="panel">
          <h2>Cards that keep failing</h2>
          <p className="hint">
            Worth rewriting as well as revising -- a card nobody can answer is as likely to be
            ambiguous as to be hard.
          </p>
          <ul className="weak-list">
            {data.leeches.map((c) => (
              <li key={c.itemId}>
                <span className="weak-front">{c.front}</span>
                <span className="weak-meta">{c.lapses} lapse{c.lapses === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Export</h2>
        <p className="hint">
          Takes your verified cards to Anki or Quizlet, with the source quote attached.
          Unverified cards are withheld.
        </p>
        <div className="gate-actions">
          {/* .apkg keeps the deck and the scheduler preset; the text export does not. */}
          <button type="button" className="ghost" onClick={() => void exportDeck('apkg')} disabled={exporting}>
            Export to Anki (.apkg)
          </button>
          <button type="button" className="ghost" onClick={() => void exportDeck('anki-tsv')} disabled={exporting}>
            Export as text for Anki
          </button>
          <button type="button" className="ghost" onClick={() => void exportDeck('quizlet-csv')} disabled={exporting}>
            Export as CSV
          </button>
        </div>
        {exported && <p className="hint">{exported}</p>}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
