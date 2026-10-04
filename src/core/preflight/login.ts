import { spawn } from 'node:child_process';
import { readAuthStatus, type AuthStatus } from './checks.js';
import type { CliCommand } from '../generate/cli-locator.js';

/**
 * Sign-in orchestration.
 *
 * `claude auth login` is an interactive browser/SSO flow. We deliberately do
 * NOT try to drive or screen-scrape it: that flow is owned by the CLI and has
 * several variants (browser callback, SSO, device code), any of which may
 * change between versions. Reimplementing it would be fragile and would put us
 * in the business of handling credentials, which we never want to do.
 *
 * Instead: open a real terminal running the CLI's own login command, then poll
 * `claude auth status --json` until it reports success. The CLI keeps sole
 * ownership of the credentials, and this works regardless of which login
 * variant the user's build uses.
 */

export type LoginLaunch =
  | { launched: true; how: 'terminal'; command: string }
  | { launched: false; reason: string; manualCommand: string };

/** Quotes a path for safe embedding in an AppleScript string literal. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Quotes a path for a POSIX shell single-quoted string. */
function escapeForPosixShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Opens a terminal window running the CLI's login command.
 *
 * The command is built from our own located CLI path plus fixed flags — never
 * from user input — so there is no injection surface here.
 */
export function launchLogin(cli: CliCommand): LoginLaunch {
  const cliPath = cli.path;
  const pre = cli.prefixArgs;
  const manualCommand = [cliPath, ...pre, 'auth', 'login', '--claudeai'].join(' ');

  try {
    if (process.platform === 'darwin') {
      // Terminal.app via AppleScript: reliably brings a window to the front,
      // which `open -a Terminal` does not do with an argument.
      const script =
        `tell application "Terminal"\n` +
        `  activate\n` +
        `  do script "${escapeForAppleScript(manualCommand)}"\n` +
        `end tell`;
      const child = spawn('osascript', ['-e', script], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return { launched: true, how: 'terminal', command: manualCommand };
    }

    if (process.platform === 'win32') {
      // `start` is a cmd builtin, so it must run through cmd.exe. The empty ""
      // is the window title, which `start` otherwise consumes from the path.
      const child = spawn(
        process.env['COMSPEC'] ?? 'cmd.exe',
        ['/c', 'start', '', '/wait', cliPath, ...pre, 'auth', 'login', '--claudeai'],
        { stdio: 'ignore', detached: true, windowsHide: false },
      );
      child.unref();
      return { launched: true, how: 'terminal', command: manualCommand };
    }

    // Linux: try the common emulators in turn.
    const inner = `${escapeForPosixShell(cliPath)} ${pre.map(escapeForPosixShell).join(' ')} auth login --claudeai; echo; echo "You can close this window."; read -n 1`;
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      try {
        const child = spawn(term, ['-e', `bash -lc ${escapeForPosixShell(inner)}`], {
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        return { launched: true, how: 'terminal', command: manualCommand };
      } catch {
        continue;
      }
    }
    return {
      launched: false,
      reason: 'No terminal emulator could be opened.',
      manualCommand,
    };
  } catch (err) {
    return { launched: false, reason: (err as Error).message, manualCommand };
  }
}

export interface WaitForLoginOptions {
  cli: CliCommand;
  /** Give up after this long. Default 5 minutes — OAuth plus typing a password. */
  timeoutMs?: number;
  /** How often to re-check. Default 2s: responsive without hammering the CLI. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Called after each poll, so the UI can show that it is still waiting. */
  onPoll?: (attempt: number, status: AuthStatus) => void;
}

export type WaitForLoginResult =
  | { ok: true; auth: AuthStatus }
  | { ok: false; reason: 'timeout' | 'cancelled'; lastStatus?: AuthStatus };

/** Polls until the CLI reports a signed-in state, or we give up. */
export async function waitForLogin(
  opts: WaitForLoginOptions,
): Promise<WaitForLoginResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const interval = opts.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  let attempt = 0;
  let lastStatus: AuthStatus | undefined;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return lastStatus ? { ok: false, reason: 'cancelled', lastStatus } : { ok: false, reason: 'cancelled' };
    }

    attempt += 1;
    lastStatus = await readAuthStatus(opts.cli);
    opts.onPoll?.(attempt, lastStatus);

    if (lastStatus.loggedIn) return { ok: true, auth: lastStatus };

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(interval, remaining));
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  if (opts.signal?.aborted) {
    return lastStatus ? { ok: false, reason: 'cancelled', lastStatus } : { ok: false, reason: 'cancelled' };
  }
  return lastStatus ? { ok: false, reason: 'timeout', lastStatus } : { ok: false, reason: 'timeout' };
}

/**
 * Full sign-in: open the terminal, then wait for it to take effect.
 * Returns the launch outcome too, so the UI can show the manual command when
 * no terminal could be opened.
 */
export async function signIn(
  opts: WaitForLoginOptions,
): Promise<{ launch: LoginLaunch; result: WaitForLoginResult }> {
  const launch = launchLogin(opts.cli);
  // Poll even when the launch failed: the user may run the command themselves.
  const result = await waitForLogin(opts);
  return { launch, result };
}
