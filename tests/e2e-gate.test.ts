import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSpawnableStub } from './fixtures/stub-cli.js';

/**
 * End-to-end tests for the startup gate, driving the real built Electron app.
 *
 * These assert the behaviour that actually matters to the user: that the app
 * refuses to let her in until Claude Code is installed and signed in, that the
 * sign-in button does something useful, and that completing sign-in elsewhere
 * unblocks the app without a restart.
 *
 * Run `npm run build` first — these launch out/main/index.js.
 */

let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
});

interface LaunchOpts {
  /** Forces the main process to use a stub CLI instead of the real one. */
  stubDir?: string;
  env?: Record<string, string>;
}

async function launch(opts: LaunchOpts = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = await mkdtemp(join(tmpdir(), 'nursedeck-e2e-'));
  const launched = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      ...opts.env,
    } as Record<string, string>,
  });
  const page = await launched.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: launched, page };
}

describe('E2E startup gate', () => {
  it('runs every check and lets the user in on a healthy machine', async () => {
    // This machine has a working, signed-in CLI, so the gate must pass.
    const launched = await launch();
    app = launched.app;
    const { page } = launched;

    await expect.poll(() => page.locator('.check').count(), { timeout: 60_000 }).toBeGreaterThan(4);

    const labels = await page.locator('.check-label').allTextContents();
    expect(labels).toContain('Study data folder is writable');
    expect(labels).toContain('Local database engine available');
    expect(labels).toContain('Claude Code is installed');
    expect(labels).toContain('Signed in to Claude');

    // Every blocking check passed, so the entry button is offered.
    const start = page.getByRole('button', { name: 'Start studying' });
    await expect.poll(() => start.count(), { timeout: 60_000 }).toBe(1);

    // No failed checks on a healthy machine.
    expect(await page.locator('.check-fail').count()).toBe(0);

    // The gate blocks the study UI until that button is pressed.
    expect(await page.locator('.shell').count()).toBe(0);
    await start.click();
    await expect.poll(() => page.locator('.shell').count()).toBe(1);
    await expect.poll(() => page.locator('.gate').count()).toBe(0);
  }, 180_000);

  it('BLOCKS entry and offers sign-in when Claude Code is signed out', async () => {
    const stubDir = await mkdtemp(join(tmpdir(), 'nursedeck-stub-out-'));
    const cli = await makeSpawnableStub(stubDir, { loggedIn: false });

    // NURSEDECK_CLAUDE_PATH is honoured by the locator, so this exercises the
    // real code path rather than a test-only branch.
    const launched = await launch({
      env: { NURSEDECK_CLAUDE_PATH: cli.path, NURSEDECK_CLAUDE_PREFIX_ARGS: cli.prefixArgs.join(',') },
    });
    app = launched.app;
    const { page } = launched;

    await expect.poll(() => page.locator('.check').count(), { timeout: 60_000 }).toBeGreaterThan(2);

    // The signed-out check must be a visible failure...
    const authCheck = page.locator('.check', { hasText: 'Signed in to Claude' });
    await expect.poll(() => authCheck.getAttribute('class'), { timeout: 30_000 }).toContain('check-fail');

    // ...and the app must refuse entry.
    expect(await page.getByRole('button', { name: 'Start studying' }).count()).toBe(0);
    expect(await page.locator('.shell').count()).toBe(0);

    // The remedy offered is sign-in, not a dead end.
    await expect.poll(() => page.getByRole('button', { name: /Sign in to Claude/i }).count()).toBe(1);
    await expect
      .poll(() => page.locator('.gate-foot').textContent())
      .toContain('needs everything above to pass');
  }, 180_000);

  it('unblocks without a restart once sign-in completes elsewhere', async () => {
    const stubDir = await mkdtemp(join(tmpdir(), 'nursedeck-stub-flip-'));
    const flagDir = await mkdtemp(join(tmpdir(), 'nursedeck-flag-'));
    const flag = join(flagDir, 'logged-in.flag');
    const cli = await makeSpawnableStub(stubDir, { loggedIn: false, loginFlagFile: flag });

    const launched = await launch({
      env: { NURSEDECK_CLAUDE_PATH: cli.path, NURSEDECK_CLAUDE_PREFIX_ARGS: cli.prefixArgs.join(',') },
    });
    app = launched.app;
    const { page } = launched;

    const authCheck = page.locator('.check', { hasText: 'Signed in to Claude' });
    await expect.poll(() => authCheck.getAttribute('class'), { timeout: 60_000 }).toContain('check-fail');

    // Simulate the user completing sign-in in the terminal the app opened.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(flag, 'done', 'utf8');

    // "Check again" must pick it up — no app restart.
    await page.getByRole('button', { name: /Check again/i }).click();

    await expect.poll(() => authCheck.getAttribute('class'), { timeout: 60_000 }).toContain('check-ok');
    await expect
      .poll(() => page.getByRole('button', { name: 'Start studying' }).count(), { timeout: 30_000 })
      .toBe(1);
  }, 180_000);

  it('BLOCKS and tells the user how to install when Claude Code is missing', async () => {
    const launched = await launch({
      env: { NURSEDECK_CLAUDE_PATH: join(tmpdir(), 'nursedeck-absent', 'claude-does-not-exist') },
    });
    app = launched.app;
    const { page } = launched;

    const cliCheck = page.locator('.check', { hasText: 'Claude Code is installed' });
    await expect.poll(() => cliCheck.getAttribute('class'), { timeout: 60_000 }).toContain('check-fail');

    expect(await page.getByRole('button', { name: 'Start studying' }).count()).toBe(0);

    // An actionable install command, not just an error -- and the one that
    // needs no Node.js. Telling her to install a JavaScript runtime first was
    // a hurdle that is not actually in the way: Electron carries its own Node.
    const expected = process.platform === 'darwin'
      ? 'https://claude.ai/install.sh'
      : 'https://claude.ai/install.ps1';
    await expect
      .poll(() => page.locator('.copy-row code').first().textContent(), { timeout: 30_000 })
      .toContain(expected);

    // And it says where to paste it, which is the step a non-technical user
    // actually gets stuck on.
    const shell = process.platform === 'darwin' ? 'Terminal' : 'PowerShell';
    expect(await page.locator('.remedy').innerText()).toContain(shell);

    // npm stays available for anyone who already has Node, but tucked away so
    // the primary route is unambiguous.
    expect(await page.locator('.install-alt').count()).toBe(1);
  }, 180_000);

  it('WARNS but still allows entry when billing would be per-use', async () => {
    const stubDir = await mkdtemp(join(tmpdir(), 'nursedeck-stub-api-'));
    const cli = await makeSpawnableStub(stubDir, { authMethod: 'api_key' });

    const launched = await launch({
      env: { NURSEDECK_CLAUDE_PATH: cli.path, NURSEDECK_CLAUDE_PREFIX_ARGS: cli.prefixArgs.join(',') },
    });
    app = launched.app;
    const { page } = launched;

    const billing = page.locator('.check', { hasText: 'Claude subscription' });
    await expect.poll(() => billing.getAttribute('class'), { timeout: 60_000 }).toContain('check-warn');

    // A warning must not block her from studying.
    await expect
      .poll(() => page.getByRole('button', { name: 'Start studying' }).count(), { timeout: 30_000 })
      .toBe(1);
  }, 180_000);

  it('never exposes Node or raw IPC to the renderer', async () => {
    const launched = await launch();
    app = launched.app;
    const { page } = launched;

    const exposure = await page.evaluate(() => ({
      hasRequire: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
      hasProcess: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined',
      hasIpcRenderer: typeof (globalThis as Record<string, unknown>)['ipcRenderer'] !== 'undefined',
      bridgeKeys: Object.keys((globalThis as Record<string, unknown>)['nursedeck'] ?? {}).sort(),
    }));

    expect(exposure.hasRequire).toBe(false);
    expect(exposure.hasProcess).toBe(false);
    expect(exposure.hasIpcRenderer).toBe(false);

    // The exposed surface is pinned exactly. Adding a capability to the
    // renderer should require editing this list, so the attack surface cannot
    // grow by accident.
    expect(exposure.bridgeKeys).toEqual([
      // The four card-authoring methods are hers: write, edit, delete, browse.
      'addCard',
      'answerCard',
      'appInfo',
      'cancelGeneration',
      'cancelSignIn',
      'cancelVerifyAll',
      'conceptMap',
      'corroborate',
      'dashboard',
      'deleteCard',
      'editCard',
      'exportDeck',
      'generate',
      'gradeAnswer',
      'importDeck',
      'importLecture',
      'listDeck',
      'listLectures',
      'listTriage',
      'onGenerateProgress',
      'onImportProgress',
      'onSignInProgress',
      'onVerifyProgress',
      'openExternal',
      'pickLecture',
      'preflight',
      'setItemStatus',
      'signIn',
      'startExam',
      'studyQueue',
      'studyStats',
      'submitExam',
      'verifyAll',
      'verifyItem',
      'vouchCard',
    ]);
  }, 180_000);
});
