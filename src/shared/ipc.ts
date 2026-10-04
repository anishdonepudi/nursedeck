import type { PreflightReport, AuthStatus } from './preflight-types.js';

/**
 * The IPC contract between main and renderer.
 *
 * Channel names live here as constants so main and preload cannot drift apart,
 * and the renderer only ever sees the named functions the preload exposes —
 * never ipcRenderer itself.
 */

export const CHANNELS = {
  preflightRun: 'preflight:run',
  signInStart: 'signin:start',
  signInCancel: 'signin:cancel',
  signInProgress: 'signin:progress',
  openExternal: 'shell:openExternal',
  appInfo: 'app:info',
} as const;

export type SignInProgress =
  | {
      phase: 'launched';
      launched: boolean;
      /** Shown so the user can run it by hand if no terminal opened. */
      manualCommand: string;
      reason?: string;
    }
  | { phase: 'waiting'; attempt: number };

export type SignInOutcome =
  | { ok: true; auth: AuthStatus }
  | {
      ok: false;
      reason: 'timeout' | 'cancelled' | 'no_cli';
      message: string;
    };

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
}

/** The surface exposed on window.nursedeck by the preload. */
export interface NurseDeckBridge {
  preflight(): Promise<PreflightReport>;
  signIn(): Promise<SignInOutcome>;
  cancelSignIn(): Promise<void>;
  onSignInProgress(cb: (p: SignInProgress) => void): () => void;
  openExternal(url: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
}

export type { PreflightReport, AuthStatus };
