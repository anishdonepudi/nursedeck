import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflight, type PreflightReport } from '@core/preflight/checks.js';
import { launchLogin, waitForLogin } from '@core/preflight/login.js';
import { clearCliCache, type CliCommand } from '@core/generate/cli-locator.js';
import { CHANNELS, type SignInProgress, type SignInOutcome } from '@shared/ipc.js';
import { registerStudyIpc, registerStudyModeIpc } from '../ipc/study.js';
import { registerExamIpc } from '../ipc/exam.js';
import { configureIpcContext, setCliCommand } from '../ipc/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Main process.
 *
 * The central rule here is that the app is GATED: the renderer is told the
 * preflight verdict, and it must not present the study UI until preflight
 * passes. The gate lives in the renderer rather than in a second BrowserWindow
 * so that sign-in, retry, and entry into the app are one continuous screen
 * rather than a window that disappears and reappears.
 */

let mainWindow: BrowserWindow | undefined;
let lastReport: PreflightReport | undefined;
/** Set while a sign-in wait is in flight, so the UI can cancel it. */
let signInAbort: AbortController | undefined;

function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b1020',
    title: 'NurseDeck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Hard isolation: the renderer never gets Node, and reaches the main
      // process only through the named channels declared in the preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the contextBridge
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/* ---------------------------- IPC ---------------------------- */

function registerIpc(): void {
  ipcMain.handle(CHANNELS.preflightRun, async (): Promise<PreflightReport> => {
    // Re-locate on every run so that installing or signing in to the CLI while
    // the gate is open is picked up without restarting the app.
    clearCliCache();
    lastReport = await runPreflight({ dataDir: dataDir() });
    // Share the resolved CLI so generation spawns the same binary preflight
    // validated, rather than re-resolving and possibly finding another.
    setCliCommand(lastReport.cli?.command);
    return lastReport;
  });

  ipcMain.handle(CHANNELS.signInStart, async (event): Promise<SignInOutcome> => {
    const cli: CliCommand | undefined = lastReport?.cli?.command;
    if (!cli) {
      return {
        ok: false,
        reason: 'no_cli',
        message: 'Claude Code must be installed before signing in.',
      };
    }

    signInAbort?.abort();
    signInAbort = new AbortController();

    const launch = launchLogin(cli);
    const send = (p: SignInProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.signInProgress, p);
    };

    send({
      phase: 'launched',
      launched: launch.launched,
      manualCommand: launch.launched ? launch.command : launch.manualCommand,
      ...(launch.launched ? {} : { reason: launch.reason }),
    });

    const result = await waitForLogin({
      cli,
      signal: signInAbort.signal,
      onPoll: (attempt) => send({ phase: 'waiting', attempt }),
    });

    if (result.ok) {
      clearCliCache();
      lastReport = await runPreflight({ dataDir: dataDir() });
      return { ok: true, auth: result.auth };
    }
    return {
      ok: false,
      reason: result.reason,
      message:
        result.reason === 'timeout'
          ? 'Sign-in did not complete in time. You can try again.'
          : 'Sign-in was cancelled.',
    };
  });

  ipcMain.handle(CHANNELS.signInCancel, (): void => {
    signInAbort?.abort();
    signInAbort = undefined;
  });

  ipcMain.handle(CHANNELS.openExternal, async (_e, url: unknown): Promise<void> => {
    // Only ever open http(s), so a renderer bug cannot launch a local handler.
    if (typeof url !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle(CHANNELS.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: dataDir(),
  }));
}

/* -------------------------- lifecycle -------------------------- */

// A second instance would contend for the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpc();
    configureIpcContext({ dataDir: dataDir() });
    registerStudyIpc();
    registerStudyModeIpc();
    registerExamIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => signInAbort?.abort());
}
