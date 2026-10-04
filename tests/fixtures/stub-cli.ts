import { writeFile, mkdir, chmod } from 'node:fs/promises';
import type { CliCommand } from '@core/generate/cli-locator.js';
import { join } from 'node:path';

/**
 * Builds a fake `claude` executable for preflight tests.
 *
 * Why a stub rather than the real CLI: verifying the signed-out path would
 * otherwise require running `claude auth logout`, which would destroy the
 * developer's (and the user's) real session. A stub lets us exercise every
 * state — missing, outdated, feature-poor, signed out, API-billed, and the
 * signed-out-then-signed-in transition — safely and deterministically.
 *
 * The stub is a real executable: a Node script with a shebang on POSIX, and a
 * paired .cmd shim on Windows, because that is what the locator and preflight
 * actually spawn.
 */

export interface StubOptions {
  version?: string;
  /** Flags to report in --help. Defaults to everything preflight requires. */
  flags?: string[];
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
  /** Exit non-zero from --version, simulating a broken native binary. */
  brokenBinary?: boolean;
  /** Emit text instead of JSON from `auth status`, as very old builds do. */
  noJsonAuth?: boolean;
  /**
   * Path to a file whose existence flips `loggedIn` to true. Lets a test
   * simulate the user completing sign-in in another window.
   */
  loginFlagFile?: string;
}

const DEFAULT_FLAGS = [
  '--json-schema',
  '--setting-sources',
  '--strict-mcp-config',
  '--restricted',
  '--output-format',
  '--print',
  '--model',
];

/**
 * Writes the stub and returns the path to spawn.
 * On Windows that is a .cmd shim; elsewhere the script itself.
 */
export async function makeStubCli(dir: string, opts: StubOptions = {}): Promise<string> {
  await mkdir(dir, { recursive: true });

  const cfg = {
    version: opts.version ?? '2.1.289',
    flags: opts.flags ?? DEFAULT_FLAGS,
    loggedIn: opts.loggedIn ?? true,
    authMethod: opts.authMethod ?? 'claude.ai',
    apiProvider: opts.apiProvider ?? 'firstParty',
    subscriptionType: opts.subscriptionType ?? 'max',
    email: opts.email ?? 'student@example.com',
    brokenBinary: opts.brokenBinary ?? false,
    noJsonAuth: opts.noJsonAuth ?? false,
    loginFlagFile: opts.loginFlagFile ?? null,
  };

  const script = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const CFG = ${JSON.stringify(cfg)};
const argv = process.argv.slice(2);

function loggedIn() {
  if (CFG.loginFlagFile && fs.existsSync(CFG.loginFlagFile)) return true;
  return CFG.loggedIn;
}

if (argv[0] === '--version') {
  if (CFG.brokenBinary) {
    process.stderr.write('Error: claude native binary not installed.\\n');
    process.exit(1);
  }
  process.stdout.write(CFG.version + ' (Claude Code)\\n');
  process.exit(0);
}

if (argv[0] === '--help') {
  process.stdout.write('Usage: claude [options]\\n\\nOptions:\\n');
  for (const f of CFG.flags) process.stdout.write('  ' + f + ' <value>   stub flag\\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  if (CFG.noJsonAuth) {
    process.stdout.write(loggedIn() ? 'Logged in as ' + CFG.email + '\\n' : 'Not logged in\\n');
    process.exit(loggedIn() ? 0 : 1);
  }
  process.stdout.write(JSON.stringify({
    loggedIn: loggedIn(),
    authMethod: loggedIn() ? CFG.authMethod : 'none',
    apiProvider: CFG.apiProvider,
    subscriptionType: CFG.subscriptionType,
    email: loggedIn() ? CFG.email : undefined,
  }, null, 2) + '\\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  // The real command is interactive; the stub just records that it ran.
  if (CFG.loginFlagFile) fs.writeFileSync(CFG.loginFlagFile, 'logged-in');
  process.stdout.write('Signed in.\\n');
  process.exit(0);
}

// -p / --print : emit a CLI-shaped envelope so driver tests can run offline.
if (argv.includes('-p') || argv.includes('--print')) {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'stub-session',
    total_cost_usd: 0,
    num_turns: 1,
    duration_ms: 1,
    result: 'ok',
    structured_output: { stub: true },
  }) + '\\n');
  process.exit(0);
}

process.stderr.write('stub: unhandled args ' + JSON.stringify(argv) + '\\n');
process.exit(2);
`;

  const scriptPath = join(dir, process.platform === 'win32' ? 'claude-stub.js' : 'claude');
  await writeFile(scriptPath, script, 'utf8');

  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  // On Windows a .js file is not directly spawnable without a shell, so pair it
  // with a .cmd shim — which is also exactly the shape the locator must cope
  // with in the real install.
  const cmdPath = join(dir, 'claude.cmd');
  await writeFile(cmdPath, `@echo off\r\nnode "%~dp0claude-stub.js" %*\r\n`, 'utf8');

  // And an .exe-equivalent entry point that Node *can* spawn directly: a tiny
  // batch file still needs a shell, so tests spawn node against the script.
  return cmdPath;
}

/**
 * Returns a spawnable CliCommand for the stub.
 *
 * On Windows this is `node claude-stub.js`, because a .cmd cannot be spawned
 * with shell:false — the same constraint the real locator works around, and the
 * reason CliCommand carries prefixArgs at all.
 */
export async function makeSpawnableStub(
  dir: string,
  opts: StubOptions = {},
): Promise<CliCommand> {
  const p = await makeStubCli(dir, opts);
  if (process.platform === 'win32') {
    return { path: process.execPath, prefixArgs: [join(dir, 'claude-stub.js')] };
  }
  return { path: p, prefixArgs: [] };
}
