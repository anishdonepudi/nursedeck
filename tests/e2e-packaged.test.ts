import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { seedStudiableCard } from './fixtures/seed-deck.js';

/**
 * The PACKAGED application, not the development build.
 *
 * Everything else in this suite runs against out/main/index.js, where every
 * file sits loose on disk. The shipped app runs from inside an app.asar, and
 * that difference is exactly where packaging bugs live: a module resolved by
 * path, or a data file read next to its module, can work perfectly in
 * development and fail only for her.
 *
 * The .apkg exporter is the sharp case. It loads sql.js, a WebAssembly build of
 * SQLite, and must hand it the .wasm bytes read from beside the module. That is
 * a file read through an asar by a path from require.resolve, and it either
 * works or Anki export is broken in the shipped build with no sign of it here.
 *
 * Skips when no packaged build exists, so the normal suite does not require one.
 */

const PACKAGED = join(process.cwd(), 'release', 'win-unpacked', 'NurseDeck.exe');
const havePackagedBuild = await access(PACKAGED).then(() => true).catch(() => false);

let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await new Promise((r) => setTimeout(r, 1500));
});

describe.skipIf(!havePackagedBuild)('E2E: the packaged application', () => {
  it('starts, and exports a real .apkg from inside the asar', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'nursedeck-packaged-'));
    const dataDir = join(userData, 'data');
    await mkdir(dataDir, { recursive: true });
    await seedStudiableCard(dataDir);

    const outDir = await mkdtemp(join(tmpdir(), 'nursedeck-packaged-out-'));
    const outPath = join(outDir, 'nursedeck.apkg');

    const launched = await electron.launch({
      executablePath: PACKAGED,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env } as Record<string, string>,
    });
    app = launched;

    await launched.evaluate(async ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, outPath);

    const page = await launched.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 120_000 });

    await page.locator('.lecture').first().click();
    const progress = page.getByRole('button', { name: 'Progress' });
    await expect.poll(() => progress.count(), { timeout: 30_000 }).toBe(1);
    await progress.click();

    await page.getByRole('button', { name: /Export to Anki/ }).click();
    await expect
      .poll(() => page.locator('.dash').innerText(), { timeout: 60_000 })
      .toMatch(/Exported 1 card/);

    // Opened rather than trusted. sql.js runs WebAssembly it loads from a .wasm
    // read out of the asar; if that resolution failed the export would error
    // or write nothing, and she would be the one to find out.
    const zip = await JSZip.loadAsync(await readFile(outPath));
    expect(Object.keys(zip.files).some((n) => /^collection\.anki2/.test(n))).toBe(true);
  }, 300_000);

  it('reaches the study screen in the packaged build', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'nursedeck-packaged2-'));
    const dataDir = join(userData, 'data');
    await mkdir(dataDir, { recursive: true });
    await seedStudiableCard(dataDir);

    const launched = await electron.launch({
      executablePath: PACKAGED,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env } as Record<string, string>,
    });
    app = launched;

    const page = await launched.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 120_000 });

    await page.locator('.lecture').first().click();
    const study = page.getByRole('button', { name: 'Study', exact: true });
    await expect.poll(() => study.count(), { timeout: 30_000 }).toBe(1);
    await study.click();

    // The renderer, preload bridge, database and scheduler all have to work
    // from inside the package for a card to appear at all.
    await expect.poll(() => page.locator('.study-card').count(), { timeout: 60_000 }).toBe(1);
  }, 300_000);
});
