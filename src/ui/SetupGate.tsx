import { useCallback, useEffect, useState } from 'react';
import type { PreflightReport, SignInProgress } from '@shared/ipc.js';
import type { CheckResult, RemedyAction } from '@shared/preflight-types.js';

/**
 * The startup gate.
 *
 * Shown until preflight passes. Its job is not merely to report a failure but
 * to fix it in place: the common case (Claude Code not signed in) is resolved
 * with one button, without the user ever opening a terminal themselves or
 * restarting the app.
 */

/**
 * How to install Claude Code, per platform.
 *
 * The native installer is primary and the npm one is the fallback, which is the
 * opposite of what this used to say. It matters for a non-technical user: npm
 * requires installing Node.js first, and NurseDeck itself has never needed Node
 * -- Electron carries its own. Telling a nursing student to install a
 * JavaScript runtime before she can make a flashcard was asking her to clear a
 * hurdle that is not actually in the way.
 *
 * Commands differ by shell, so the right one is shown rather than both.
 */
const INSTALL_COMMANDS: Record<'mac' | 'windows', { primary: string; shell: string }> = {
  mac: {
    primary: 'curl -fsSL https://claude.ai/install.sh | bash',
    shell: 'Terminal',
  },
  windows: {
    primary: 'irm https://claude.ai/install.ps1 | iex',
    shell: 'PowerShell',
  },
};

const NPM_FALLBACK = 'npm install -g @anthropic-ai/claude-code';

/** Platform, from the renderer. Used only to choose which command to show. */
function currentPlatform(): 'mac' | 'windows' {
  return navigator.userAgent.includes('Mac') ? 'mac' : 'windows';
}

function StatusDot({ status }: { status: CheckResult['status'] }) {
  const label = status === 'ok' ? 'Passed' : status === 'warn' ? 'Warning' : 'Failed';
  return (
    <span className={`dot dot-${status}`} role="img" aria-label={label}>
      {status === 'ok' ? '✓' : status === 'warn' ? '!' : '✕'}
    </span>
  );
}

function CopyRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <code>{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => undefined,
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

interface RemedyProps {
  remedy: RemedyAction;
  onSignIn: () => void;
  signingIn: boolean;
  progress?: SignInProgress;
  onCancelSignIn: () => void;
}

function Remedy({ remedy, onSignIn, signingIn, progress, onCancelSignIn }: RemedyProps) {
  if (remedy === 'login_cli' || remedy === 'switch_to_subscription') {
    if (signingIn) {
      return (
        <div className="remedy">
          <p className="waiting">
            <span className="spinner" aria-hidden="true" />
            Waiting for you to finish signing in...
            {progress?.phase === 'waiting' ? ` (checked ${progress.attempt}×)` : ''}
          </p>
          {progress?.phase === 'launched' && !progress.launched && (
            <>
              <p className="hint">
                NurseDeck could not open a terminal for you. Run this yourself, then come back --
                this screen will notice automatically.
              </p>
              <CopyRow text={progress.manualCommand} />
            </>
          )}
          {progress?.phase === 'launched' && progress.launched && (
            <p className="hint">
              A terminal window opened. Complete the sign-in there, then return here.
            </p>
          )}
          <button type="button" className="ghost" onClick={onCancelSignIn}>
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div className="remedy">
        <button type="button" className="primary" onClick={onSignIn}>
          {remedy === 'login_cli' ? 'Sign in to Claude' : 'Sign in with a Claude subscription'}
        </button>
        <p className="hint">
          Opens a terminal to complete sign-in. NurseDeck never sees your password -- Claude Code
          holds the credentials.
        </p>
      </div>
    );
  }

  if (remedy === 'install_cli' || remedy === 'update_cli') {
    return (
      <div className="remedy">
        <p className="hint">
          {remedy === 'install_cli'
            ? 'NurseDeck uses Claude Code to read your lectures. Install it with:'
            : 'Update Claude Code to a supported version with:'}
        </p>
        <p className="hint">
          Open <strong>{INSTALL_COMMANDS[currentPlatform()].shell}</strong> and paste this:
        </p>
        <CopyRow text={INSTALL_COMMANDS[currentPlatform()].primary} />
        <p className="hint">
          Then sign in with your Claude subscription and choose “Check again”.
        </p>
        <details className="install-alt">
          <summary>Already have Node.js?</summary>
          <p className="hint">You can install it through npm instead:</p>
          <CopyRow text={NPM_FALLBACK} />
        </details>
        <p className="hint">
          More detail in the{' '}
          <a
            href="https://docs.claude.com/en/docs/claude-code/setup"
            onClick={(e) => {
              e.preventDefault();
              void window.nursedeck.openExternal('https://docs.claude.com/en/docs/claude-code/setup');
            }}
          >
            Claude Code setup guide
          </a>
          .
        </p>
      </div>
    );
  }

  return null;
}

export function SetupGate({ onReady }: { onReady: (report: PreflightReport) => void }) {
  const [report, setReport] = useState<PreflightReport>();
  const [checking, setChecking] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [progress, setProgress] = useState<SignInProgress>();
  const [error, setError] = useState<string>();

  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      const r = await window.nursedeck.preflight();
      setReport(r);
      return r;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => window.nursedeck.onSignInProgress(setProgress), []);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setProgress(undefined);
    try {
      const outcome = await window.nursedeck.signIn();
      if (!outcome.ok) setError(outcome.message);
      await check();
    } finally {
      setSigningIn(false);
    }
  }, [check]);

  const cancelSignIn = useCallback(() => {
    void window.nursedeck.cancelSignIn();
    setSigningIn(false);
  }, []);

  const blockingFailure = report?.checks.find((c) => c.blocking && c.status === 'fail');
  const warning = report?.checks.find((c) => c.status === 'warn');

  return (
    <div className="gate">
      <header className="gate-head">
        <h1>NurseDeck</h1>
        <p className="tagline">Evidence-cited study material from your own lectures.</p>
      </header>

      <section className="panel">
        <h2>Checking your setup</h2>

        <ul className="checks">
          {report?.checks.map((c) => (
            <li key={c.id} className={`check check-${c.status}`}>
              <StatusDot status={c.status} />
              <div>
                <span className="check-label">{c.label}</span>
                {c.detail && <span className="check-detail">{c.detail}</span>}
              </div>
            </li>
          ))}
          {!report && checking && (
            <li className="check">
              <span className="spinner" aria-hidden="true" /> <span>Running checks...</span>
            </li>
          )}
        </ul>

        {error && <p className="error">{error}</p>}

        {blockingFailure && (
          <Remedy
            remedy={blockingFailure.remedy ?? 'none'}
            onSignIn={() => void signIn()}
            signingIn={signingIn}
            {...(progress ? { progress } : {})}
            onCancelSignIn={cancelSignIn}
          />
        )}

        {!blockingFailure && warning && !signingIn && (
          <Remedy
            remedy={warning.remedy ?? 'none'}
            onSignIn={() => void signIn()}
            signingIn={signingIn}
            {...(progress ? { progress } : {})}
            onCancelSignIn={cancelSignIn}
          />
        )}

        <div className="gate-actions">
          <button type="button" className="ghost" onClick={() => void check()} disabled={checking || signingIn}>
            {checking ? 'Checking...' : 'Check again'}
          </button>

          {report?.ok && (
            <button type="button" className="primary" onClick={() => onReady(report)}>
              Start studying
            </button>
          )}
        </div>

        {report && !report.ok && (
          <p className="gate-foot">
            NurseDeck needs everything above to pass before it can build study material.
          </p>
        )}
      </section>
    </div>
  );
}
