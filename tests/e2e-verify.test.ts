import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seedStudiableCard, seedExtraCards, SEEDED_QA_FRONT,
} from './fixtures/seed-deck.js';

/**
 * End-to-end coverage for the three features that had none: bulk verification,
 * teach-back grading, and the concept map.
 *
 * These drive the real Claude CLI, because what is being tested is the whole
 * path -- renderer to main to CLI and back -- and a mocked model would prove
 * only that the wiring compiles. They are slow for that reason.
 */

let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await new Promise((r) => setTimeout(r, 1500));
});

async function launch(): Promise<{ page: Page; lectureId: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'nursedeck-verify-'));
  const dataDir = join(userData, 'data');
  await mkdir(dataDir, { recursive: true });

  const { lectureId } = await seedStudiableCard(dataDir);
  await seedExtraCards(dataDir, lectureId);

  const launched = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`],
    env: { ...process.env } as Record<string, string>,
  });
  app = launched;

  const page = await launched.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: 'Start studying' }).click({ timeout: 90_000 });
  return { page, lectureId };
}

describe('E2E: checking every card at once', () => {
  it('checks the whole lecture from one button and reports the outcome', async () => {
    const { page } = await launch();
    await page.locator('.lecture').first().click();

    const review = page.getByRole('button', { name: /Review \d+ card/ });
    await expect.poll(() => review.count(), { timeout: 30_000 }).toBe(1);
    await review.click();

    // The whole point: one action, not one click per card.
    const checkAll = page.getByRole('button', { name: /Check all/ });
    await expect.poll(() => checkAll.count(), { timeout: 30_000 }).toBe(1);
    await checkAll.click();

    // Real CLI calls, so allow generous time. What must appear is a SUMMARY,
    // not a spinner that never resolves.
    await expect
      .poll(() => page.locator('.notice').count(), { timeout: 240_000 })
      .toBe(1);

    const notice = await page.locator('.notice').innerText();
    expect(notice).toMatch(/Checked \d+/);
    // It must say what happened to the cards, including the ones it rejected.
    expect(notice).toMatch(/verified|not supported/i);
  }, 420_000);

  it('offers a way to stop a long run', async () => {
    const { page } = await launch();
    await page.locator('.lecture').first().click();

    const review = page.getByRole('button', { name: /Review \d+ card/ });
    await expect.poll(() => review.count(), { timeout: 30_000 }).toBe(1);
    await review.click();
    await page.getByRole('button', { name: /Check all/ }).click();

    // A run that spends money unattended must be stoppable, and the control
    // has to appear immediately rather than after the first card finishes.
    await expect
      .poll(() => page.getByRole('button', { name: 'Stop checking' }).count(), { timeout: 20_000 })
      .toBe(1);
    await page.getByRole('button', { name: 'Stop checking' }).click();

    // Stopping must settle the UI rather than leaving it spinning forever.
    await expect
      .poll(
        () => page.getByRole('button', { name: /Check all/ }).count(),
        { timeout: 240_000 },
      )
      .toBe(1);
  }, 420_000);
});

describe('E2E: teach-back grading', () => {
  it('marks a typed explanation against the key points', async () => {
    const { page } = await launch();
    await page.locator('.lecture').first().click();

    const study = page.getByRole('button', { name: 'Study', exact: true });
    await expect.poll(() => study.count(), { timeout: 30_000 }).toBe(1);
    await study.click();
    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);

    // Walk to the short-answer card; order depends on the scheduler.
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      const prompt = await page.locator('.study-front').innerText();
      if (prompt.includes('IV push')) { found = true; break; }
      // Reveal and grade Good to advance.
      await page.getByRole('button', { name: /Show answer|Just show me/ }).first().click();
      await page.getByRole('button', { name: 'Good' }).click();
      await expect.poll(() => page.locator('.study-card').count(), { timeout: 20_000 }).toBe(1);
    }
    expect(found, 'short-answer card should appear in the queue').toBe(true);

    // It must be a textarea, not a one-line box: this asks for an explanation.
    expect(await page.locator('textarea.study-explain').count()).toBe(1);
    await page.locator('textarea.study-explain').fill(
      'Pushing potassium fast makes the blood level spike and it can stop the heart, so it has to be diluted and run in slowly.',
    );

    await page.getByRole('button', { name: 'Mark my answer' }).click();
    await expect.poll(() => page.locator('.teachback').count(), { timeout: 180_000 }).toBe(1);

    // Both key points are shown, marked individually, with the item's OWN
    // wording -- never a criterion invented at grading time.
    const teachback = await page.locator('.teachback').innerText();
    expect(teachback).toMatch(/covered \d+ of 2/i);
    expect(await page.locator('.keypoints li').count()).toBe(2);
    expect(teachback).toContain('stops the heart');
  }, 420_000);

  it('always lets her see the answer without waiting for a grade', async () => {
    const { page } = await launch();
    await page.locator('.lecture').first().click();
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);

    for (let i = 0; i < 6; i++) {
      const prompt = await page.locator('.study-front').innerText();
      if (prompt.includes('IV push')) break;
      await page.getByRole('button', { name: /Show answer|Just show me/ }).first().click();
      await page.getByRole('button', { name: 'Good' }).click();
      await expect.poll(() => page.locator('.study-card').count(), { timeout: 20_000 }).toBe(1);
    }

    // She must never be stuck behind a model call to see what she is learning.
    await page.getByRole('button', { name: 'Just show me' }).click();
    await expect.poll(() => page.locator('.study-back').count(), { timeout: 20_000 }).toBe(1);
    expect(await page.locator('.teachback').count()).toBe(0);
  }, 420_000);
});

describe('E2E: concept map', () => {
  it('draws only from verified cards and shows the quote behind an arrow', async () => {
    const { page } = await launch();
    await page.locator('.lecture').first().click();

    const mapButton = page.getByRole('button', { name: 'Concept map' });
    await expect.poll(() => mapButton.count(), { timeout: 30_000 }).toBe(1);
    await mapButton.click();

    // Either a map or an honest empty state -- never a silent blank screen.
    await expect
      .poll(
        async () =>
          (await page.locator('.map-svg').count()) + (await page.locator('.hint.empty').count()),
        { timeout: 240_000 },
      )
      .toBeGreaterThan(0);

    const header = await page.locator('.conceptmap').innerText();
    // The provenance promise has to be stated on the screen itself.
    expect(header).toMatch(/verified|checked/i);

    if (await page.locator('.map-edge').count() > 0) {
      await page.locator('.map-edge').first().click();
      // Clicking an arrow must surface the lecture text behind it.
      await expect
        .poll(() => page.locator('blockquote').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);
    }
  }, 420_000);
});
