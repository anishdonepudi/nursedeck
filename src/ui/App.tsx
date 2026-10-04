import { useState } from 'react';
import type { PreflightReport } from '@shared/ipc.js';
import { SetupGate } from './SetupGate.js';
import { Library } from './Library.js';
import { Triage } from './Triage.js';
import { Study } from './Study.js';
import { Exam } from './Exam.js';
import { Dashboard } from './Dashboard.js';

/**
 * Root.
 *
 * The app is gated: nothing below the setup screen is mounted until preflight
 * passes, so no code path can reach generation with a missing or signed-out
 * CLI.
 */

type View =
  | { name: 'library' }
  | { name: 'triage'; lectureId: string }
  | { name: 'study'; lectureId: string }
  | { name: 'exam'; lectureId?: string }
  | { name: 'dashboard'; lectureId?: string };

export function App() {
  const [ready, setReady] = useState<PreflightReport>();
  const [view, setView] = useState<View>({ name: 'library' });
  // Held here, not in Library, so returning from triage or study does not
  // silently deselect the lecture she was working on.
  const [selectedLecture, setSelectedLecture] = useState<string>();

  if (!ready) return <SetupGate onReady={setReady} />;

  return (
    <div className="shell">
      <header className="shell-head">
        <button type="button" className="brand" onClick={() => setView({ name: 'library' })}>
          NurseDeck
        </button>
        <span className="badge">
          {ready.auth?.email ?? 'signed in'}
          {ready.auth?.subscriptionType ? ` - ${ready.auth.subscriptionType}` : ''}
        </span>
      </header>

      <main className="shell-body">
        {view.name === 'library' && (
          <Library
            {...(selectedLecture ? { selectedId: selectedLecture } : {})}
            onSelect={setSelectedLecture}
            onReview={(lectureId) => setView({ name: 'triage', lectureId })}
            onStudy={(lectureId) => setView({ name: 'study', lectureId })}
            onExam={(lectureId) => setView({ name: 'exam', lectureId })}
            onDashboard={(lectureId) => setView({ name: 'dashboard', lectureId })}
          />
        )}
        {view.name === 'triage' && (
          <Triage lectureId={view.lectureId} onDone={() => setView({ name: 'library' })} />
        )}
        {view.name === 'study' && (
          <Study lectureId={view.lectureId} onDone={() => setView({ name: 'library' })} />
        )}
        {view.name === 'dashboard' && (
          <Dashboard
            {...(view.lectureId ? { lectureId: view.lectureId } : {})}
            onDone={() => setView({ name: 'library' })}
            onStudy={() => setView({ name: 'study', lectureId: view.lectureId! })}
          />
        )}
        {view.name === 'exam' && (
          <Exam
            {...(view.lectureId ? { lectureId: view.lectureId } : {})}
            onDone={() => setView({ name: 'library' })}
          />
        )}
      </main>
    </div>
  );
}
