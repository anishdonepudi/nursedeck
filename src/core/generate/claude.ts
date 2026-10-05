import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { locateClaudeCli } from './cli-locator.js';

/**
 * Drives the Claude Code CLI in headless mode.
 *
 * Deliberately spawns the CLI binary rather than using the Anthropic API or the
 * Agent SDK: the app runs entirely off the user's Claude Code subscription, so
 * there is no API-key code path anywhere in this module by design.
 *
 * Note: --bare is NOT usable here. It refuses OAuth/keychain credentials and
 * requires ANTHROPIC_API_KEY, exiting 1 with "Not logged in" under a
 * subscription login. The flag set below is the verified equivalent, and also
 * measured ~13x cheaper than an unrestricted call, because suppressing ambient
 * settings/skills/MCP is what shrinks the system prompt.
 */

export interface ClaudeResult<T> {
  data: T;
  sessionId: string;
  /** Client-side estimate. On a subscription this is not billed spend. */
  estimatedCostUsd: number;
  durationMs: number;
  numTurns: number;
}

export type ClaudeErrorKind =
  | 'not_installed'
  | 'not_logged_in'
  | 'schema_retries'
  | 'no_output'
  | 'nonzero_exit'
  | 'bad_json'
  | 'aborted';

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly detail: {
      kind: ClaudeErrorKind;
      exitCode?: number | null;
      stderr?: string;
      raw?: string;
    },
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

export interface ClaudeOptions {
  /** JSON Schema, draft-07. Newer drafts are rejected by the CLI validator. */
  schema: unknown;
  /**
   * The only directory Claude may read. Must be an app-owned workspace, never
   * the user's lecture folder: a .claude/settings.json sitting in an untrusted
   * directory would otherwise have its hooks executed by the CLI.
   */
  workspaceDir: string;
  /**
   * Bulk content (lecture text, reference excerpts) piped via stdin.
   *
   * It must not go in the prompt argument: Windows caps a command line at
   * ~32,767 characters, which a long lecture exceeds. stdin accepts up to 10MB.
   * This also means the generator needs no file-reading tool at all, which is
   * why `--tools ""` is safe here.
   */
  input?: string;
  model?: string;
  /** Hard spend rail. Honoured by the CLI only in --print mode. */
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cliPath?: string;
  /**
   * Grants the Read tool. Needed only for transcribing images, which the CLI
   * must open itself. Everything else is handed its input over stdin and gets
   * no tools at all.
   */
  allowReadTool?: boolean;
}

/** Attempts to re-LAUNCH after a transient spawn failure. */
const SPAWN_RETRIES = 3;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Flags that strip all ambient configuration. Order is not significant.
 *
 * `allowRead` is the single, narrow exception: transcribing a photograph
 * requires the model to open the image. Even then `--restricted` still removes
 * every command-running tool and WebFetch, and file access stays confined to
 * the working directories, which for that path is a staging folder holding
 * nothing but the images being transcribed.
 */
function lockdownFlags(allowRead = false): string[] {
  return [
    '--setting-sources', '',      // no user/project/local settings => no ambient hooks
    '--strict-mcp-config',        // ignore every MCP configuration
    '--disable-slash-commands',   // no skills
    '--restricted',               // no command-running tools, no WebFetch
    '--tools', allowRead ? 'Read' : '',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
  ];
}

interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

function runProcess(
  cliPath: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; input?: string } = {},
): Promise<ProbeResult> {
  return (async () => {
    const child = spawn(cliPath, args, {
      cwd: opts.cwd,
      // When there is no input, stdin is ignored outright: left open and empty,
      // the CLI waits ~3s for piped data before giving up.
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (opts.input !== undefined && child.stdin) {
      // EPIPE is expected if the CLI exits before draining stdin.
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input, 'utf8');
    }

    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    child.on('error', (e: Error) => { spawnError = e; });
    // Typed as nullable because the stdio tuple is built dynamically; both
    // streams are always 'pipe' above.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { stdout += c; });
    child.stderr?.on('data', (c: string) => { stderr += c; });

    // SIGINT rather than SIGTERM: it lets the CLI end its turn cleanly.
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGINT'), opts.timeoutMs)
      : undefined;
    const onAbort = () => child.kill('SIGINT');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const [code] = (await once(child, 'close')) as [number | null];
      return { code, stdout, stderr, spawnError };
    } catch (err) {
      return { code: null, stdout, stderr: stderr || String(err), spawnError };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  })();
}

export async function runClaude<T>(prompt: string, opts: ClaudeOptions): Promise<ClaudeResult<T>> {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(opts.schema),
    '--add-dir', opts.workspaceDir,
    ...lockdownFlags(opts.allowReadTool === true),
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);

  let cliPath = opts.cliPath;
  if (!cliPath) {
    const located = await locateClaudeCli();
    if (!located) {
      throw new ClaudeError(
        'Claude Code was not found. Install it and sign in, then restart NurseDeck.',
        { kind: 'not_installed' },
      );
    }
    cliPath = located.path;
  }

  let { code, stdout, stderr, spawnError } = await runProcess(cliPath, args, {
    cwd: opts.workspaceDir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    input: opts.input,
  });

  // Two transient failures to LAUNCH show up on Windows, both observed here
  // rather than imagined:
  //
  //   ENOENT  - the CLI updates itself in place, and a run that spawns during
  //             the swap fails against a path that exists moments before and
  //             after. Confirmed from the binary's timestamp.
  //   UNKNOWN - errno -4094, the system out of process handles. A verification
  //             run over fifty cards hit this on forty-three of them and
  //             reported a 17% yield that was entirely an artefact.
  //
  // Both clear on their own, so launching is retried with growing backoff. A
  // CLI that STARTS and then errors is reporting something real and is never
  // retried: only the spawn itself.
  for (let attempt = 1; attempt <= SPAWN_RETRIES && spawnError && !opts.signal?.aborted; attempt++) {
    // 1s, 3s, 7s: long enough for handles to be released under load, short
    // enough that a genuinely missing binary still fails quickly.
    await new Promise((r) => setTimeout(r, (2 ** attempt - 1) * 1000));
    ({ code, stdout, stderr, spawnError } = await runProcess(cliPath, args, {
      cwd: opts.workspaceDir,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      input: opts.input,
    }));
  }

  if (opts.signal?.aborted) {
    throw new ClaudeError('Generation was cancelled.', { kind: 'aborted', exitCode: code });
  }

  if (spawnError) {
    throw new ClaudeError(
      `Could not launch the Claude Code CLI at ${cliPath}: ${spawnError.message}`,
      { kind: 'not_installed', exitCode: code, stderr },
    );
  }

  if (/native binary not installed/i.test(stderr)) {
    throw new ClaudeError(
      'The Claude Code CLI is installed but its native binary is missing. Re-run its installer.',
      { kind: 'not_installed', exitCode: code, stderr },
    );
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    const kind: ClaudeErrorKind = code === 0 ? 'bad_json' : 'nonzero_exit';
    throw new ClaudeError(
      code === 0
        ? 'Could not parse the Claude CLI JSON envelope.'
        : `Claude CLI exited ${code} without JSON output.`,
      { kind, exitCode: code, stderr, raw: stdout.slice(0, 2000) },
    );
  }

  const resultText = String(envelope['result'] ?? '');

  if (envelope['is_error'] === true) {
    const notLoggedIn = /not logged in|\/login/i.test(resultText);
    throw new ClaudeError(
      notLoggedIn
        ? 'Claude Code is not signed in. Run `claude` once in a terminal and sign in with your Claude account.'
        : `Claude returned an error: ${resultText.slice(0, 300)}`,
      {
        kind: notLoggedIn ? 'not_logged_in' : 'nonzero_exit',
        exitCode: code,
        stderr,
        raw: resultText.slice(0, 2000),
      },
    );
  }

  if (String(envelope['subtype'] ?? '') === 'error_max_structured_output_retries') {
    throw new ClaudeError('Claude could not produce output matching the required schema.', {
      kind: 'schema_retries', exitCode: code, stderr, raw: resultText.slice(0, 2000),
    });
  }

  // A `success` subtype carrying no structured_output is still a failure.
  const structured = envelope['structured_output'];
  if (structured === undefined || structured === null) {
    throw new ClaudeError('Claude returned no structured output.', {
      kind: 'no_output', exitCode: code, stderr, raw: resultText.slice(0, 2000),
    });
  }

  return {
    data: structured as T,
    sessionId: String(envelope['session_id'] ?? ''),
    estimatedCostUsd: Number(envelope['total_cost_usd'] ?? 0),
    durationMs: Number(envelope['duration_ms'] ?? 0),
    numTurns: Number(envelope['num_turns'] ?? 0),
  };
}

export interface CliHealth {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  problem?: string;
}

/**
 * Drives the first-run wizard so a broken or signed-out CLI surfaces up front
 * rather than as an opaque failure midway through generating a deck.
 */
export async function checkCliHealth(cliPathOverride?: string): Promise<CliHealth> {
  let cliPath = cliPathOverride;
  if (!cliPath) {
    const located = await locateClaudeCli();
    if (!located) {
      return {
        installed: false,
        loggedIn: false,
        problem: 'Claude Code was not found. Install it and sign in, then restart NurseDeck.',
      };
    }
    cliPath = located.path;
  }

  const ver = await runProcess(cliPath, ['--version'], { timeoutMs: 20_000 });

  if (ver.code !== 0 || ver.spawnError) {
    const missingBinary = /native binary not installed/i.test(ver.stderr);
    return {
      installed: false,
      loggedIn: false,
      problem: missingBinary
        ? 'Claude Code is installed but its native binary is missing. Re-run its installer.'
        : 'Claude Code was not found. Install it and sign in, then restart NurseDeck.',
    };
  }

  const auth = await runProcess(cliPath, ['auth', 'status'], { timeoutMs: 20_000 });
  const text = `${auth.stdout}\n${auth.stderr}`;
  const authMethod = /authMethod"?\s*[:=]\s*"?([\w.-]+)/i.exec(text)?.[1];
  const loggedIn =
    auth.code === 0 && !/not logged in/i.test(text) && authMethod !== 'none';

  return {
    installed: true,
    version: ver.stdout.trim().split(/\s+/)[0],
    loggedIn,
    authMethod,
    problem: loggedIn
      ? undefined
      : 'Claude Code is not signed in. Run `claude` once in a terminal and sign in with your Claude account.',
  };
}
