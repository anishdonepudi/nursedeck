import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestPptx } from './fixtures/make-pptx.js';

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

  it('a verified card becomes studiable and can be answered', async () => {
    const { page } = await launchWithLecture();

    await page.getByRole('button', { name: 'Add lecture' }).click();
    const lecture = page.locator('.lecture', { hasText: 'Fluid and Electrolyte Balance' });
    await expect.poll(() => lecture.count(), { timeout: 60_000 }).toBe(1);
    await lecture.click();

    const clozeToggle = page.locator('.kind', { hasText: 'Fill in the blank' }).locator('input');
    if (await clozeToggle.isChecked()) await clozeToggle.uncheck();
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(() => page.locator('.summary').count(), { timeout: 300_000 }).toBe(1);

    await page.getByRole('button', { name: /Review \d+ card/ }).click();
    await expect.poll(() => page.locator('.triage-card').count(), { timeout: 30_000 }).toBe(1);

    // Run the adversarial audit on this card, then keep it.
    await page.getByRole('button', { name: /Verify/ }).click();
    await expect
      .poll(() => page.locator('.cite-verified, .cite-failed').count(), { timeout: 180_000 })
      .toBeGreaterThan(0);

    const verified = await page.locator('.cite-verified').count();
    await page.keyboard.press('k');

    // Clear the rest of the queue.
    while ((await page.locator('.triage-card').count()) > 0) {
      await page.keyboard.press('d');
    }
    await page.getByRole('button', { name: /Done|Back/ }).click();

    if (verified === 0) {
      // The audit rejected it, so it must still not be studiable. That is a
      // pass: the gate held.
      expect(await page.getByRole('button', { name: 'Study' }).count()).toBe(0);
      return;
    }

    /* ----------------------------- study ---------------------------- */

    const studyButton = page.getByRole('button', { name: 'Study' });
    await expect.poll(() => studyButton.count(), { timeout: 30_000 }).toBe(1);
    await studyButton.click();

    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);

    // Confidence is captured BEFORE the answer is shown.
    await page.getByRole('button', { name: 'Fairly sure' }).click();
    expect(await page.locator('.study-back').count()).toBe(0);

    await page.locator('.study-input').fill('an answer');
    await page.keyboard.press('Enter');

    // Answer and the four graded intervals appear together.
    await expect.poll(() => page.locator('.study-back').count()).toBe(1);
    expect(await page.locator('.rating').count()).toBe(4);
    // The source stays visible while reviewing.
    expect(await page.locator('.cite blockquote').count()).toBeGreaterThan(0);

    await page.keyboard.press('3'); // Good

    // Either the next card, or the end-of-session summary.
    await expect
      .poll(() => page.locator('.study-card, .study-empty').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }, 900_000);
});
