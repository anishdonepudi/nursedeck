import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, readAuthStatus, MIN_CLI_VERSION } from '@core/preflight/checks.js';
import { waitForLogin, launchLogin } from '@core/preflight/login.js';
import { satisfiesMinimum, parseVersion } from '@core/preflight/version.js';
import { makeSpawnableStub } from './fixtures/stub-cli.js';
import { locateClaudeCli } from '@core/generate/cli-locator.js';

/**
 * Preflight is the gate that decides whether the app may start, so every state
 * it can report is exercised here.
 *
 * All auth states are driven through a stub CLI rather than the real one. That
 * is deliberate: proving the signed-out path with the real binary would require
 * `claude auth logout`, destroying the developer's live session.
 */

let root: string;
const fresh = async (name: string) => {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  return d;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nursedeck-preflight-'));
});

describe('version comparison', () => {
  it('parses and compares correctly', () => {
    expect(parseVersion('2.1.289 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 289 });
    expect(satisfiesMinimum('2.1.289', '2.1.205')).toBe(true);
    expect(satisfiesMinimum('2.1.205', '2.1.205')).toBe(true);
    expect(satisfiesMinimum('2.1.204', '2.1.205')).toBe(false);
    expect(satisfiesMinimum('2.0.999', '2.1.205')).toBe(false);
    expect(satisfiesMinimum('3.0.0', '2.1.205')).toBe(true);
    // Numeric, not lexicographic: "2.1.99" must be < "2.1.205".
    expect(satisfiesMinimum('2.1.99', '2.1.205')).toBe(false);
  });

  it('treats an unreadable version as not satisfying the floor', () => {
    expect(satisfiesMinimum('unknown', '2.1.205')).toBe(false);
  });
});

describe('preflight — happy path', () => {
  it('passes every check with a healthy, signed-in CLI', async () => {
    const dir = await fresh('happy');
    const cli = await makeSpawnableStub(await fresh('happy-cli'));
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    expect(report.ok).toBe(true);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['data_dir']?.status).toBe('ok');
    expect(byId['sqlite']?.status).toBe('ok');
    expect(byId['cli_found']?.status).toBe('ok');
    expect(byId['cli_version']?.status).toBe('ok');
    expect(byId['cli_features']?.status).toBe('ok');
    expect(byId['cli_auth']?.status).toBe('ok');
    expect(byId['cli_billing']?.status).toBe('ok');
    expect(report.auth?.loggedIn).toBe(true);
    expect(report.auth?.subscriptionType).toBe('max');
  });
});

describe('preflight — blocks startup when it must', () => {
  it('BLOCKS when the CLI is not installed', async () => {
    const dir = await fresh('nocli');
    const report = await runPreflight({
      dataDir: dir,
      cliOverride: { path: join(dir, 'does-not-exist'), prefixArgs: [] },
    });
    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'cli_found');
    expect(c?.status).toBe('fail');
    expect(c?.blocking).toBe(true);
    expect(c?.remedy).toBe('install_cli');
  });

  it('BLOCKS when the native binary is missing, with a distinct message', async () => {
    const dir = await fresh('broken');
    const cli = await makeSpawnableStub(await fresh('broken-cli'), { brokenBinary: true });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'cli_found');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toMatch(/native binary is missing/i);
  });

  it('BLOCKS when the CLI is too old to validate output schemas', async () => {
    const dir = await fresh('old');
    const cli = await makeSpawnableStub(await fresh('old-cli'), { version: '2.1.100' });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'cli_version');
    expect(c?.status).toBe('fail');
    expect(c?.remedy).toBe('update_cli');
    expect(c?.detail).toContain('2.1.100');
  });

  it('BLOCKS when the CLI lacks a required option', async () => {
    const dir = await fresh('nofeat');
    const cli = await makeSpawnableStub(await fresh('nofeat-cli'), {
      flags: ['--output-format', '--print'], // missing --json-schema etc.
    });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'cli_features');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toContain('--json-schema');
  });

  it('BLOCKS when signed out, and asks the UI for the login flow', async () => {
    const dir = await fresh('loggedout');
    const cli = await makeSpawnableStub(await fresh('loggedout-cli'), { loggedIn: false });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'cli_auth');
    expect(c?.status).toBe('fail');
    expect(c?.blocking).toBe(true);
    expect(c?.remedy).toBe('login_cli');
    expect(report.auth?.loggedIn).toBe(false);
  });

  it('BLOCKS when the data folder cannot be written', async () => {
    // A path whose parent is a FILE cannot be created as a directory.
    const dir = await fresh('filecollide');
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const report = await runPreflight({ dataDir: join(blocker, 'data') });

    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.id === 'data_dir');
    expect(c?.status).toBe('fail');
    // Short-circuits: nothing else is worth checking without storage.
    expect(report.checks).toHaveLength(1);
  });
});

describe('preflight — warns without blocking', () => {
  it('WARNS when signed in via an API account, which would cost money', async () => {
    const dir = await fresh('apibill');
    const cli = await makeSpawnableStub(await fresh('apibill-cli'), {
      authMethod: 'api_key',
      apiProvider: 'firstParty',
    });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });

    // Still startable — just not free.
    expect(report.ok).toBe(true);
    const c = report.checks.find((x) => x.id === 'cli_billing');
    expect(c?.status).toBe('warn');
    expect(c?.blocking).toBe(false);
    expect(c?.remedy).toBe('switch_to_subscription');
    expect(c?.detail).toMatch(/billed per use/i);
  });

  it('WARNS for a non-first-party provider', async () => {
    const dir = await fresh('bedrock');
    const cli = await makeSpawnableStub(await fresh('bedrock-cli'), {
      authMethod: 'third_party',
      apiProvider: 'bedrock',
    });
    const report = await runPreflight({ dataDir: dir, cliOverride: cli });
    expect(report.checks.find((x) => x.id === 'cli_billing')?.status).toBe('warn');
  });
});

describe('readAuthStatus — version tolerance', () => {
  it('parses the JSON form', async () => {
    const cli = await makeSpawnableStub(await fresh('json-auth'), { email: 'a@b.com' });
    const auth = await readAuthStatus(cli);
    expect(auth.loggedIn).toBe(true);
    expect(auth.email).toBe('a@b.com');
    expect(auth.authMethod).toBe('claude.ai');
  });

  it('falls back to text output on builds without --json', async () => {
    const cli = await makeSpawnableStub(await fresh('text-auth'), { noJsonAuth: true });
    expect((await readAuthStatus(cli)).loggedIn).toBe(true);

    const out = await makeSpawnableStub(await fresh('text-auth-out'), {
      noJsonAuth: true,
      loggedIn: false,
    });
    expect((await readAuthStatus(out)).loggedIn).toBe(false);
  });
});

describe('login flow', () => {
  it('detects sign-in completing in another window and unblocks', async () => {
    // The stub reports signed-out until the flag file appears, exactly as the
    // real CLI reports signed-out until the browser OAuth completes.
    const cliDir = await fresh('login-transition');
    const flag = join(cliDir, 'logged-in.flag');
    const cli = await makeSpawnableStub(cliDir, { loggedIn: false, loginFlagFile: flag });

    const polls: number[] = [];
    const waiter = waitForLogin({
      cli,
      timeoutMs: 20_000,
      pollIntervalMs: 150,
      onPoll: (attempt) => polls.push(attempt),
    });

    // Simulate the user finishing sign-in a moment later.
    setTimeout(() => void writeFile(flag, 'done', 'utf8'), 600);

    const result = await waiter;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auth.loggedIn).toBe(true);
      expect(result.auth.email).toBe('student@example.com');
    }
    // Proves it actually polled rather than passing on the first read.
    expect(polls.length).toBeGreaterThan(1);
  });

  it('times out when sign-in never completes', async () => {
    const cli = await makeSpawnableStub(await fresh('login-timeout'), { loggedIn: false });
    const result = await waitForLogin({ cli, timeoutMs: 900, pollIntervalMs: 150 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
      expect(result.lastStatus?.loggedIn).toBe(false);
    }
  });

  it('is cancellable, so the user can back out', async () => {
    const cli = await makeSpawnableStub(await fresh('login-cancel'), { loggedIn: false });
    const ac = new AbortController();
    const p = waitForLogin({ cli, timeoutMs: 30_000, pollIntervalMs: 150, signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cancelled');
  });

  it('always surfaces a copyable manual command', () => {
    const launch = launchLogin({ path: '/path/to/claude', prefixArgs: [] });
    const command = launch.launched ? launch.command : launch.manualCommand;
    expect(command).toBe('/path/to/claude auth login --claudeai');
  });

  it('includes prefix args in the manual command', () => {
    const launch = launchLogin({ path: 'node', prefixArgs: ['/shim.js'] });
    const command = launch.launched ? launch.command : launch.manualCommand;
    expect(command).toBe('node /shim.js auth login --claudeai');
  });
});

describe('preflight — against the REAL Claude CLI on this machine', () => {
  it('finds and validates the actual install', async () => {
    const located = await locateClaudeCli();
    expect(located, 'real Claude CLI should be locatable').toBeDefined();

    const dir = await fresh('real');
    const report = await runPreflight({ dataDir: dir });

    // This machine has a working, signed-in CLI, so preflight must pass.
    expect(report.ok).toBe(true);
    expect(report.cli?.version).toBeDefined();
    expect(satisfiesMinimum(report.cli!.version, MIN_CLI_VERSION)).toBe(true);
    expect(report.auth?.loggedIn).toBe(true);
  });
});
