import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestPptx } from './fixtures/make-pptx.js';
import { seedStudiableCard } from './fixtures/seed-deck.js';

/**
 * The whole user journey, driven through the real built app:
 * import a PowerPoint, generate study material, review it, study it.
 *
 * This is the test that proves the features work together rather than
 * individually. It uses the real Claude CLI, so it is slow.
 */

let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  // close() resolves before the OS has finished tearing the process down, and
  // a new Electron instance launched into that window starts slowly enough to
  // trip the next test's timeouts. A short settle is cheaper and steadier than
  // inflating every timeout downstream.
  await new Promise((r) => setTimeout(r, 1500));
});

async function launchWithLecture(): Promise<{ page: Page; pptxPath: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'nursedeck-flow-'));
  const fixtureDir = await mkdtemp(join(tmpdir(), 'nursedeck-fixture-'));
  const deck = await buildTestPptx(join(fixtureDir, 'electrolytes.pptx'));

  const launched = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`],
    env: { ...process.env } as Record<string, string>,
  });
  app = launched;

  // The file dialog is native and cannot be driven, so it is stubbed to return
  // our fixture. Everything downstream is the real code path.
  await launched.evaluate(async ({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, deck.path);

  const page = await launched.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 90_000 });

  return { page, pptxPath: deck.path };
}

describe('E2E: import to study', () => {
  it('walks the full journey and never studies an unverified card', async () => {
    const { page } = await launchWithLecture();

    /* ---------------------------- import ---------------------------- */

    await page.getByRole('button', { name: 'Add lecture' }).click();
    const lecture = page.locator('.lecture', { hasText: 'Fluid and Electrolyte Balance' });
    await expect.poll(() => lecture.count(), { timeout: 60_000 }).toBe(1);

    // A freshly imported lecture has no cards yet.
    await expect.poll(() => lecture.textContent()).toContain('no cards yet');

    await lecture.click();
    await expect.poll(() => page.locator('.kinds').count()).toBe(1);

    /* --------------------------- generate --------------------------- */

    // Flashcards only, to keep this test to a single model round trip.
    const clozeToggle = page.locator('.kind', { hasText: 'Fill in the blank' }).locator('input');
    if (await clozeToggle.isChecked()) await clozeToggle.uncheck();

    await page.getByRole('button', { name: 'Generate', exact: true }).click();

    await expect
      .poll(() => page.locator('.summary').count(), { timeout: 300_000 })
      .toBe(1);

    const summary = await page.locator('.summary').textContent();
    expect(summary).toMatch(/card(s)? ready to review/);

    /* ---------------------------- triage ---------------------------- */

    const reviewButton = page.getByRole('button', { name: /Review \d+ card/ });
    await expect.poll(() => reviewButton.count(), { timeout: 30_000 }).toBe(1);
    await reviewButton.click();

    await expect.poll(() => page.locator('.triage-card').count(), { timeout: 30_000 }).toBe(1);

    // Every card offered for review must show the evidence behind it.
    expect(await page.locator('.cite blockquote').count()).toBeGreaterThan(0);

    const total = Number((await page.locator('.triage-count').textContent())?.match(/of (\d+)/)?.[1]);
    expect(total).toBeGreaterThan(0);

    // Keep the first card with the keyboard, discard the second with the mouse.
    await page.keyboard.press('k');
    await expect.poll(() => page.locator('.triage-tally').textContent()).toContain('kept 1');

    if (total > 1) {
      await page.getByRole('button', { name: /Discard/ }).click();
      await expect.poll(() => page.locator('.triage-tally').textContent()).toContain('discarded 1');
    }

    /* ------------------------- study gating ------------------------- */

    // Walk out of triage and back to the library.
    while ((await page.locator('.triage-card').count()) > 0) {
      await page.keyboard.press('d');
    }
    await page.getByRole('button', { name: /Done|Back/ }).click();

    // The lecture must still be selected after returning — otherwise the next
    // assertion would pass merely because no lecture panel is shown, which is
    // exactly how an earlier version of this test passed for the wrong reason.
    const lectureRow = page.locator('.lecture', { hasText: 'Fluid and Electrolyte Balance' });
    await expect.poll(() => lectureRow.getAttribute('class'), { timeout: 30_000 })
      .toContain('lecture-selected');
    expect(await page.locator('.kinds').count()).toBe(1);

    // The kept card is accepted but its citation is still unverified, so it is
    // NOT studiable. This is the accuracy guarantee visible in the UI.
    await expect.poll(() => lectureRow.textContent()).not.toContain('ready');
    expect(await page.getByRole('button', { name: 'Study' }).count()).toBe(0);
  }, 900_000);

  /**
   * The study path, driven through the real UI but over a SEEDED deck.
   *
   * An earlier version generated the card live and then ran the adversarial
   * audit on it, and was flaky for a good reason: whether a given run produced
   * a card the auditor would pass is genuinely non-deterministic, so the test
   * sometimes asserted against a deck with nothing studiable in it.
   *
   * The gate itself (accepted + verified before anything is studiable) is
   * covered deterministically in db.test.ts and fsrs.test.ts. What is worth
   * testing HERE is the interface: that answering a card captures confidence
   * before the answer is revealed, shows four graded intervals, and keeps the
   * source visible. So the deck is seeded and the UI is exercised.
   */
  it('shows the source, captures confidence before the answer, and grades', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'nursedeck-study-'));
    const dataDir = join(userData, 'data');
    await mkdir(dataDir, { recursive: true });
    await seedStudiableCard(dataDir);

    const launched = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`],
      env: { ...process.env } as Record<string, string>,
    });
    app = launched;
    const page = await launched.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 90_000 });

    await page.locator('.lecture').first().click();

    const studyButton = page.getByRole('button', { name: 'Study', exact: true });
    await expect.poll(() => studyButton.count(), { timeout: 30_000 }).toBe(1);
    await studyButton.click();

    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);

    // Confidence is captured BEFORE the answer is revealed. If the two were
    // collected together, "confident and wrong" would be unrecoverable.
    await page.getByRole('button', { name: 'Fairly sure' }).click();
    expect(await page.locator('.study-back').count()).toBe(0);

    await page.locator('.study-input').fill('3.5 to 5.0 mEq/L');
    await page.keyboard.press('Enter');

    await expect.poll(() => page.locator('.study-back').count()).toBe(1);
    // Four graded buttons, each showing its predicted interval.
    expect(await page.locator('.rating').count()).toBe(4);
    // The evidence stays on screen while she grades herself.
    expect(await page.locator('.cite blockquote').count()).toBeGreaterThan(0);

    await page.keyboard.press('3'); // Good

    await expect
      .poll(() => page.locator('.study-card, .study-empty').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }, 300_000);
});
