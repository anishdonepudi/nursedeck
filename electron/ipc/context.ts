import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { openDb, type Db } from '@core/db/index.js';
import type { CliCommand } from '@shared/preflight-types.js';

/**
 * Shared state for the IPC handler modules: the database, the app-owned
 * workspace, and the CLI that preflight validated.
 *
 * It lives here rather than in one handler module so that study and exam
 * handlers cannot end up with two different database connections to the same
 * file, which under WAL would be a subtle source of stale reads.
 */

let db: Db | undefined;
let dataDir = '';
let workspace = '';
let cli: CliCommand | undefined;

export function configureIpcContext(opts: { dataDir: string }): void {
  dataDir = opts.dataDir;
}

/**
 * The CLI binary preflight resolved and validated.
 *
 * Generation reuses it rather than re-resolving, so the app cannot validate one
 * install and then quietly run a different one.
 */
export function setCliCommand(command: CliCommand | undefined): void {
  cli = command;
}

export function getCli(): CliCommand | undefined {
  return cli;
}

/**
 * Claude's only readable directory: app-owned and empty.
 *
 * Lecture text is piped over stdin, so the generator never needs a path into
 * the user's own folders -- which is what removes the untrusted-directory
 * hazard rather than merely mitigating it.
 */
export function getWorkspaceDir(): string {
  return workspace;
}

export function getDataDir(): string {
  return dataDir;
}

export async function ensureDb(): Promise<Db> {
  if (db) return db;
  await mkdir(dataDir, { recursive: true });
  workspace = join(dataDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  db = openDb({ path: join(dataDir, 'nursedeck.db') });
  return db;
}

/** Test seam: drops the cached connection so a fresh data dir can be used. */
export function resetIpcContext(): void {
  db = undefined;
  workspace = '';
}
