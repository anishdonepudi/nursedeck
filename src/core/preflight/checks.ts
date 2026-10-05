import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { locateClaudeCli } from '../generate/cli-locator.js';
import type {
  CheckStatus, RemedyAction, CheckResult, AuthStatus, CliCommand, PreflightReport,
} from '@shared/preflight-types.js';
import { satisfiesMinimum } from './version.js';

/**
 * Startup preflight.
 *
 * The app must not reach its main UI until generation is actually possible.
 * Discovering a missing or signed-out CLI halfway through building a deck is
 * the worst outcome: the user has already waited, and the failure is opaque.
 * So every dependency is proven up front, in order of dependency, and the
 * result tells the UI exactly what to offer as a fix.
 */

export type {
  CheckStatus, RemedyAction, CheckResult, AuthStatus, CliCommand, PreflightReport,
} from '@shared/preflight-types.js';

/**
 * Minimum CLI version. --json-schema validation only became reliable in
 * 2.1.205; before that an invalid schema was silently ignored, which would let
 * unvalidated model output reach the deck.
 */
export const MIN_CLI_VERSION = '2.1.205';

/** CLI flags the generation pipeline depends on. */
const REQUIRED_FLAGS = [
  '--json-schema',
  '--setting-sources',
  '--strict-mcp-config',
  '--restricted',
  '--output-format',
] as const;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 25_000,
): Promise<Ran> {
  return (async () => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch {
      return { code: null, stdout: '', stderr: 'spawn threw', failed: true };
    }
    let stdout = '';
    let stderr = '';
    let failed = false;
    child.on('error', () => { failed = true; });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { stdout += c; });
    child.stderr?.on('data', (c: string) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
      const [code] = (await once(child, 'close')) as [number | null];
      return { code, stdout, stderr, failed };
    } catch {
      return { code: null, stdout, stderr, failed: true };
    } finally {
      clearTimeout(timer);
    }
  })();
}

/** Reads `claude auth status --json`, tolerating older text-only builds. */
export async function readAuthStatus(cli: CliCommand): Promise<AuthStatus> {
  const res = await run(cli.path, [...cli.prefixArgs, 'auth', 'status', '--json']);
  const raw = res.stdout.trim();

  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const out: AuthStatus = { loggedIn: j['loggedIn'] === true };
      if (typeof j['authMethod'] === 'string') out.authMethod = j['authMethod'];
      if (typeof j['apiProvider'] === 'string') out.apiProvider = j['apiProvider'];
      if (typeof j['subscriptionType'] === 'string') out.subscriptionType = j['subscriptionType'];
      if (typeof j['email'] === 'string') out.email = j['email'];
      if (typeof j['orgName'] === 'string') out.orgName = j['orgName'];
      return out;
    } catch {
      // fall through to text handling
    }
  }

  // Fallback for builds without --json.
  const text = `${res.stdout}\n${res.stderr}`;
  return { loggedIn: res.code === 0 && !/not logged in|logged out/i.test(text) };
}

export interface PreflightOptions {
  /** Directory the app stores its database and workspace in. */
  dataDir: string;
  /** Injected in tests to exercise every state without touching real credentials. */
  cliOverride?: CliCommand;
  /** Skips the paid end-to-end generation probe. */
  skipGenerationProbe?: boolean;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const checks: CheckResult[] = [];
  const report: PreflightReport = { ok: false, checks };

  /* 1. Writable data directory. Checked first because it needs nothing else. */
  try {
    await mkdir(opts.dataDir, { recursive: true });
    const probe = join(opts.dataDir, '.write-probe');
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    checks.push({
      id: 'data_dir',
      label: 'Study data folder is writable',
      status: 'ok',
      blocking: true,
    });
  } catch (err) {
    checks.push({
      id: 'data_dir',
      label: 'Study data folder is writable',
      status: 'fail',
      detail: `Cannot write to ${opts.dataDir}: ${(err as Error).message}`,
      blocking: true,
      remedy: 'none',
    });
    return report; // Nothing else can work without storage.
  }

  /* 2. Local database engine. */
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);');
    const row = db.prepare('SELECT a FROM t').get() as { a: number } | undefined;
    db.close();
    if (row?.a !== 1) throw new Error('sanity query returned no row');
    checks.push({
      id: 'sqlite',
      label: 'Local database engine available',
      status: 'ok',
      blocking: true,
    });
  } catch (err) {
    checks.push({
      id: 'sqlite',
      label: 'Local database engine available',
      status: 'fail',
      detail: (err as Error).message,
      blocking: true,
      remedy: 'none',
    });
  }

  /* 3. Claude Code CLI present. */
  let cli = opts.cliOverride;
  let cliVersion: string | undefined;

  if (cli) {
    const v = await run(cli.path, [...cli.prefixArgs, '--version']);
    if (v.failed || v.code !== 0) {
      checks.push({
        id: 'cli_found',
        label: 'Claude Code is installed',
        status: 'fail',
        detail: /native binary not installed/i.test(v.stderr)
          ? 'Claude Code is installed but its native binary is missing.'
          : `Could not run ${cli.path}.`,
        blocking: true,
        remedy: 'install_cli',
      });
      return report;
    }
    cliVersion = /(\d+\.\d+\.\d+\S*)/.exec(v.stdout)?.[1];
  } else {
    const located = await locateClaudeCli();
    if (!located) {
      checks.push({
        id: 'cli_found',
        label: 'Claude Code is installed',
        status: 'fail',
        detail:
          'Claude Code was not found. NurseDeck uses it to read your lectures and build study material.',
        blocking: true,
        remedy: 'install_cli',
      });
      return report;
    }
    cli = { path: located.path, prefixArgs: located.prefixArgs };
    cliVersion = located.version;
  }

  checks.push({
    id: 'cli_found',
    label: 'Claude Code is installed',
    status: 'ok',
    detail: cliVersion ? `version ${cliVersion}` : undefined,
    blocking: true,
  });
  report.cli = { command: cli, version: cliVersion ?? 'unknown' };

  /* 4. Version floor. */
  if (cliVersion && satisfiesMinimum(cliVersion, MIN_CLI_VERSION)) {
    checks.push({
      id: 'cli_version',
      label: `Claude Code is ${MIN_CLI_VERSION} or newer`,
      status: 'ok',
      detail: cliVersion,
      blocking: true,
    });
  } else {
    checks.push({
      id: 'cli_version',
      label: `Claude Code is ${MIN_CLI_VERSION} or newer`,
      status: 'fail',
      detail: `Found ${cliVersion ?? 'an unreadable version'}. Older builds silently ignore the ` +
        'output format NurseDeck relies on, which would let unchecked content into your deck.',
      blocking: true,
      remedy: 'update_cli',
    });
  }

  /* 5. Required flags, detected rather than assumed across versions. */
  const help = await run(cli.path, [...cli.prefixArgs, '--help'], 30_000);
  const missingFlags = REQUIRED_FLAGS.filter((f) => !help.stdout.includes(f));
  checks.push(
    missingFlags.length === 0
      ? {
          id: 'cli_features',
          label: 'Claude Code supports the required options',
          status: 'ok',
          blocking: true,
        }
      : {
          id: 'cli_features',
          label: 'Claude Code supports the required options',
          status: 'fail',
          detail: `This build is missing: ${missingFlags.join(', ')}`,
          blocking: true,
          remedy: 'update_cli',
        },
  );

  /* 6. Signed in. */
  const auth = await readAuthStatus(cli);
  report.auth = auth;

  checks.push(
    auth.loggedIn
      ? {
          id: 'cli_auth',
          label: 'Signed in to Claude',
          status: 'ok',
          detail: auth.email
            ? `${auth.email}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}`
            : auth.authMethod,
          blocking: true,
        }
      : {
          id: 'cli_auth',
          label: 'Signed in to Claude',
          status: 'fail',
          detail: 'Claude Code is not signed in. NurseDeck cannot build study material until it is.',
          blocking: true,
          remedy: 'login_cli',
        },
  );

  /* 7. Billing mode. Not blocking, but the whole point is that this is free. */
  if (auth.loggedIn) {
    const onSubscription =
      auth.apiProvider === 'firstParty' && auth.authMethod !== 'api_key';
    checks.push(
      onSubscription
        ? {
            id: 'cli_billing',
            label: 'Using a Claude subscription (no per-use charges)',
            status: 'ok',
            detail: auth.subscriptionType ? `plan: ${auth.subscriptionType}` : undefined,
            blocking: false,
          }
        : {
            id: 'cli_billing',
            label: 'Using a Claude subscription (no per-use charges)',
            status: 'warn',
            detail:
              `Claude Code is signed in via ${auth.authMethod ?? auth.apiProvider ?? 'an API account'}, ` +
              'so generating study material will be billed per use. Sign in with a Claude subscription to avoid charges.',
            blocking: false,
            remedy: 'switch_to_subscription',
          },
    );
  }

  /* Network. Claude Code reaches Anthropic over the internet, so without a
   * connection generation fails partway through with a CLI error that says
   * nothing useful. Checked last and NOT blocking: everything already in her
   * deck -- studying, exams, the dashboard, export -- works entirely offline,
   * and blocking entry over a dropped wifi connection would be wrong. */
  checks.push(await checkConnectivity());

  report.ok = !checks.some((c) => c.blocking && c.status === 'fail');
  return report;
}

/**
 * Whether the machine can reach Anthropic.
 *
 * A DNS lookup rather than a request: it is enough to tell "no network" from
 * "network fine", costs nothing, and sends no data anywhere.
 */
async function checkConnectivity(): Promise<CheckResult> {
  const label = 'Connected to the internet';
  try {
    const { lookup } = await import('node:dns/promises');
    await Promise.race([
      lookup('api.anthropic.com'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 4000)),
    ]);
    return { id: 'network', label, status: 'ok', blocking: false };
  } catch {
    return {
      id: 'network',
      label,
      status: 'warn',
      detail:
        'Could not reach Anthropic. Studying, exams and export all work offline, ' +
        'but making new cards from a lecture needs a connection.',
      blocking: false,
      remedy: 'none',
    };
  }
}
