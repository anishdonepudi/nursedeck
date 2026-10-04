import { useState } from 'react';
import type { PreflightReport } from '@shared/ipc.js';
import { SetupGate } from './SetupGate.js';
import { Library } from './Library.js';
import { Triage } from './Triage.js';
import { Study } from './Study.js';

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
  | { name: 'study'; lectureId: string };

export function App() {
  const [ready, setReady] = useState<PreflightReport>();
  const [view, setView] = useState<View>({ name: 'library' });

  if (!ready) return <SetupGate onReady={setReady} />;

  return (
    <div className="shell">
      <header className="shell-head">
        <button type="button" className="brand" onClick={() => setView({ name: 'library' })}>
          NurseDeck
        </button>
        <span className="badge">
          {ready.auth?.email ?? 'signed in'}
          {ready.auth?.subscriptionType ? ` · ${ready.auth.subscriptionType}` : ''}
        </span>
      </header>

      <main className="shell-body">
        {view.name === 'library' && (
          <Library
            onReview={(lectureId) => setView({ name: 'triage', lectureId })}
            onStudy={(lectureId) => setView({ name: 'study', lectureId })}
          />
        )}
        {view.name === 'triage' && (
          <Triage lectureId={view.lectureId} onDone={() => setView({ name: 'library' })} />
        )}
        {view.name === 'study' && (
          <Study lectureId={view.lectureId} onDone={() => setView({ name: 'library' })} />
        )}
      </main>
    </div>
  );
}
