import { useState } from 'react';
import type { PreflightReport } from '@shared/ipc.js';
import { SetupGate } from './SetupGate.js';

/**
 * Root. The app has exactly two states: gated, and running.
 *
 * Nothing in the study UI is mounted until preflight has passed, so no code
 * path can reach generation with a missing or signed-out CLI.
 */
export function App() {
  const [ready, setReady] = useState<PreflightReport>();

  if (!ready) return <SetupGate onReady={setReady} />;

  return (
    <div className="shell">
      <header className="shell-head">
        <h1>NurseDeck</h1>
        <span className="badge">
          {ready.auth?.email ?? 'signed in'}
          {ready.auth?.subscriptionType ? ` · ${ready.auth.subscriptionType}` : ''}
        </span>
      </header>
      <main className="shell-body">
        <div className="placeholder">
          <h2>Setup complete</h2>
          <p>
            Claude Code {ready.cli?.version} is installed and signed in. Lecture import and deck
            generation land next.
          </p>
        </div>
      </main>
    </div>
  );
}
