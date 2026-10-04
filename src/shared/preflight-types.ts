/**
 * Preflight result types.
 *
 * These live in `shared` rather than in `core/preflight` because the renderer
 * needs to render them, and the renderer must never import from `core` — that
 * code targets Node and would drag platform APIs into the browser bundle.
 * `core` imports these definitions, not the other way round.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** What the UI should offer the user when a check fails. */
export type RemedyAction =
  | 'install_cli'
  | 'update_cli'
  | 'login_cli'
  | 'switch_to_subscription'
  | 'none';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  /** A failing blocking check prevents the app from starting. */
  blocking: boolean;
  remedy?: RemedyAction;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
  orgName?: string;
}

/** A spawnable CLI invocation: an executable plus any leading arguments. */
export interface CliCommand {
  path: string;
  prefixArgs: string[];
}

export interface PreflightReport {
  /** True when no blocking check failed. */
  ok: boolean;
  checks: CheckResult[];
  cli?: { command: CliCommand; version: string };
  auth?: AuthStatus;
}
