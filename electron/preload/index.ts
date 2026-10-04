import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type NurseDeckBridge, type SignInProgress } from '@shared/ipc.js';

/**
 * The only bridge between the renderer and the main process.
 *
 * Exposes named functions rather than ipcRenderer itself, so the renderer can
 * never invoke an arbitrary channel. Each function is a thin, typed wrapper.
 */

const bridge: NurseDeckBridge = {
  preflight: () => ipcRenderer.invoke(CHANNELS.preflightRun),
  signIn: () => ipcRenderer.invoke(CHANNELS.signInStart),
  cancelSignIn: () => ipcRenderer.invoke(CHANNELS.signInCancel),

  onSignInProgress: (cb: (p: SignInProgress) => void) => {
    const listener = (_e: unknown, payload: SignInProgress) => cb(payload);
    ipcRenderer.on(CHANNELS.signInProgress, listener);
    // Returns an unsubscribe so a React effect can clean up and we never leak
    // listeners across re-renders.
    return () => ipcRenderer.removeListener(CHANNELS.signInProgress, listener);
  },

  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  appInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
};

contextBridge.exposeInMainWorld('nursedeck', bridge);
