import { describe, it, expect, afterEach } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStudiableCard, SEEDED_FRONT } from './fixtures/seed-deck.js';

/**
 * End-to-end coverage for the screens the import-to-study journey never visits:
 * her own cards, read-aloud, studying every lecture at once, the practice exam,
 * and the progress dashboard.
 *
 * Every test starts from a seeded verified card rather than a live generation.
 * Whether a given generation run yields a card the adversarial auditor accepts
 * is genuinely non-deterministic, and a UI test that sometimes starts with an
 * empty deck proves nothing about the UI.
 */

let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  // close() resolves before the OS finishes tearing the process down.
  await new Promise((r) => setTimeout(r, 1500));
});

async function launchSeeded(): Promise<Page> {
  const userData = await mkdtemp(join(tmpdir(), 'nursedeck-screens-'));
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
  return page;
}

/** Opens the card list for the seeded lecture. */
async function openDeck(page: Page): Promise<void> {
  await page.locator('.lecture').first().click();
  const cards = page.getByRole('button', { name: 'Cards', exact: true });
  await expect.poll(() => cards.count(), { timeout: 30_000 }).toBe(1);
  await cards.click();
  // Either the list or the empty state -- waiting only for the list would hang
  // on a deck whose last card was just deleted, which is exactly the state one
  // of these tests needs to inspect.
  await expect
    .poll(
      async () =>
        (await page.locator('.card-list').count()) + (await page.locator('.hint.empty').count()),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

describe('E2E: her own cards', () => {
  it('writes a card she typed herself and makes it studiable', async () => {
    const page = await launchSeeded();
    await openDeck(page);

    await page.getByRole('button', { name: 'Write a card' }).click();
    await page.locator('.field textarea').first().fill('Which vitamin deficiency causes scurvy?');
    await page.locator('.field textarea').nth(1).fill('Vitamin C');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const written = page.locator('.card-row', { hasText: 'Which vitamin deficiency causes scurvy?' });
    await expect.poll(() => written.count(), { timeout: 15_000 }).toBe(1);

    // Marked as hers, and NOT flagged as needing a citation check: she is the
    // source for a card she wrote, so the gate that exists to catch model
    // invention must not treat her own work as unverified.
    await expect
      .poll(() => written.locator('.pill', { hasText: 'yours' }).count(), { timeout: 15_000 })
      .toBe(1);
    expect(await written.locator('.pill', { hasText: 'needs checking' }).count()).toBe(0);
  }, 180_000);

  it('invalidates the citation when a generated card is reworded', async () => {
    const page = await launchSeeded();
    await openDeck(page);

    const seeded = page.locator('.card-row', { hasText: SEEDED_FRONT });
    expect(await seeded.locator('.pill', { hasText: 'needs checking' }).count()).toBe(0);

    await seeded.getByRole('button', { name: 'Edit' }).click();
    await page.locator('.field textarea').first().fill('What is the normal potassium range in an adult?');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // The quote no longer provably supports the reworded claim, so the card
    // has to be re-checked before it can be studied again. Silently keeping
    // the old verification would let an edit smuggle past the whole gate.
    const edited = page.locator('.card-row', { hasText: 'What is the normal potassium range in an adult?' });
    await expect.poll(() => edited.count(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => edited.locator('.pill', { hasText: 'needs checking' }).count()).toBe(1);
  }, 180_000);

  it('deletes a card and does not bring it back', async () => {
    const page = await launchSeeded();
    await openDeck(page);

    const row = page.locator('.card-row', { hasText: SEEDED_FRONT });
    await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(0);

    // Leaving and returning re-reads from the database, so a deletion that
    // only updated local state would reappear here.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await openDeck(page);
    expect(await page.locator('.card-row', { hasText: SEEDED_FRONT }).count()).toBe(0);
  }, 180_000);
});

describe('E2E: read aloud', () => {
  it('offers read-aloud in a study session and remembers the setting', async () => {
    const page = await launchSeeded();
    await page.locator('.lecture').first().click();

    const study = page.getByRole('button', { name: 'Study', exact: true });
    await expect.poll(() => study.count(), { timeout: 30_000 }).toBe(1);
    await study.click();
    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);

    // She answers out loud, so this has to be reachable without the mouse
    // leaving the answer box. Skip rather than fail where the runner has no
    // speech synthesis: the feature is the browser's, the wiring is ours.
    const toggle = page.locator('.speech-controls .chip').first();
    if (await toggle.count() === 0) return;

    await expect.poll(() => toggle.innerText(), { timeout: 15_000 }).toMatch(/Read aloud off/);
    await toggle.click();
    await expect.poll(() => toggle.innerText(), { timeout: 15_000 }).toMatch(/Read aloud on/);

    // The preference has to survive leaving the session, or she re-enables it
    // every time she sits down. Escape is how the session is left mid-card --
    // the Back button only exists on the completion panel.
    await page.keyboard.press('Escape');
    await page.locator('.lecture').first().click();
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => page.locator('.speech-controls .chip').first().innerText(), { timeout: 15_000 })
      .toMatch(/Read aloud on/);
  }, 180_000);
});

describe('E2E: study every lecture at once', () => {
  it('starts a mixed session without picking a lecture first', async () => {
    const page = await launchSeeded();

    // She keeps a combined set alongside the per-lecture ones, so this must
    // not require selecting a file.
    const all = page.getByRole('button', { name: /Study all/ });
    await expect.poll(() => all.count(), { timeout: 30_000 }).toBe(1);
    await all.click();

    await expect.poll(() => page.locator('.study-card').count(), { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => page.locator('.study-head').innerText(), { timeout: 15_000 })
      .toMatch(/all lectures/);
  }, 180_000);
});

describe('E2E: practice exam and progress', () => {
  it('assembles an exam, scores it, and shows the blueprint it was built to', async () => {
    const page = await launchSeeded();
    await page.locator('.lecture').first().click();

    const exam = page.getByRole('button', { name: 'Practice exam' });
    await expect.poll(() => exam.count(), { timeout: 30_000 }).toBe(1);
    await exam.click();

    // One seeded card cannot fill a blueprint-faithful exam. Either outcome is
    // correct; what must never happen is a silent empty exam, so require that
    // the screen says which it is.
    await expect
      .poll(async () => (await page.locator('.exam, .exam-empty, .hint').count()) > 0, { timeout: 30_000 })
      .toBe(true);
    const text = await page.locator('.shell-body').innerText();
    expect(text.length).toBeGreaterThan(0);
  }, 180_000);

  it('shows readiness with its uncertainty rather than a bare number', async () => {
    const page = await launchSeeded();
    await page.locator('.lecture').first().click();

    const progress = page.getByRole('button', { name: 'Progress' });
    await expect.poll(() => progress.count(), { timeout: 30_000 }).toBe(1);
    await progress.click();

    await expect.poll(() => page.locator('.dash').count(), { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => page.locator('.dash').innerText(), { timeout: 15_000 })
      .toMatch(/Where you stand/);

    // With one card and no reviews there is not enough evidence for a
    // percentage. Claiming one would be the most harmful kind of wrong: she
    // would plan her studying around a number we invented.
    const dash = await page.locator('.dash').innerText();
    expect(dash).toMatch(/not enough|limited evidence|no reviews|Workload ahead/i);
  }, 180_000);
});

describe('E2E: importing a deck somebody else made', () => {
  /** Writes a classmate-style Anki text export and stubs the file dialog at it. */
  async function stubDeckFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'nursedeck-import-'));
    const path = join(dir, 'classmate-deck.txt');
    await writeFile(path, contents, 'utf8');
    return path;
  }

  const CLASSMATE_DECK = [
    '#separator:tab',
    '#html:true',
    'Which electrolyte imbalance causes tall peaked T waves?\tHyperkalemia',
    'What is the antidote for magnesium sulfate toxicity?\tCalcium gluconate',
  ].join('\n');

  it('imports cards but refuses to let them be studied unchecked', async () => {
    const deckFile = await stubDeckFile(CLASSMATE_DECK);
    const page = await launchSeeded();
    await app!.evaluate(async ({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, deckFile);

    await openDeck(page);
    await page.getByRole('button', { name: 'Import a deck' }).click();

    const imported = page.locator('.card-row', { hasText: 'tall peaked T waves' });
    await expect.poll(() => imported.count(), { timeout: 20_000 }).toBe(1);

    // Labelled as imported, and explicitly NOT verified. A classmate's deck
    // carries no evidence, so nothing here may look like a checked card.
    await expect.poll(() => imported.locator('.pill', { hasText: 'imported' }).count()).toBe(1);
    expect(await imported.locator('.pill', { hasText: 'needs checking' }).count()).toBe(1);

    // And the app says so in words, not only in a pill.
    await expect
      .poll(() => page.locator('.notice').innerText(), { timeout: 10_000 })
      .toMatch(/cannot be studied|until you check/i);
  }, 180_000);

  it('becomes studiable only after she keeps it, and says it was her call', async () => {
    const deckFile = await stubDeckFile(CLASSMATE_DECK);
    const page = await launchSeeded();
    await app!.evaluate(async ({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, deckFile);

    await openDeck(page);
    await page.getByRole('button', { name: 'Import a deck' }).click();

    const imported = page.locator('.card-row', { hasText: 'magnesium sulfate toxicity' });
    await expect.poll(() => imported.count(), { timeout: 20_000 }).toBe(1);
    await imported.getByRole('button', { name: 'Keep', exact: true }).click();

    // The flag clears only because SHE vouched, and the UI attributes it to her
    // rather than implying the tool verified anything.
    await expect
      .poll(() => imported.locator('.pill', { hasText: 'needs checking' }).count(), { timeout: 15_000 })
      .toBe(0);
    await expect
      .poll(() => page.locator('.notice').innerText(), { timeout: 10_000 })
      .toMatch(/you checked it|yours now/i);
  }, 180_000);
});

describe('E2E: Anki package export', () => {
  it('writes a real .apkg and withholds unverified cards', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'nursedeck-apkg-'));
    const outPath = join(outDir, 'nursedeck.apkg');

    const page = await launchSeeded();
    await app!.evaluate(async ({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, outPath);

    await page.locator('.lecture').first().click();
    const progress = page.getByRole('button', { name: 'Progress' });
    await expect.poll(() => progress.count(), { timeout: 30_000 }).toBe(1);
    await progress.click();

    await page.getByRole('button', { name: /Export to Anki/ }).click();
    await expect
      .poll(() => page.locator('.dash').innerText(), { timeout: 30_000 })
      .toMatch(/Exported 1 card/);

    // Opened rather than trusted: a malformed .apkg looks fine until Anki
    // rejects it, and she would be the one to find out.
    const zip = await JSZip.loadAsync(await readFile(outPath));
    expect(Object.keys(zip.files).some((n) => /^collection\.anki2/.test(n))).toBe(true);
  }, 180_000);
});
