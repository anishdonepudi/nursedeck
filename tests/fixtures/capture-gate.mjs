/**
 * Captures screenshots of the startup gate in each state.
 * Run after `npm run build`:  node tests/fixtures/capture-gate.mjs <outDir>
 */
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node capture-gate.mjs <outDir>');
  process.exit(1);
}

/** Writes a stub CLI reporting the given auth state. */
async function stub(state) {
  const dir = await mkdtemp(join(tmpdir(), 'nursedeck-shot-'));
  const script = join(dir, 'claude-stub.js');
  const body = `
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('2.1.289 (Claude Code)\\n'); process.exit(0); }
if (argv[0] === '--help') {
  process.stdout.write('--json-schema\\n--setting-sources\\n--strict-mcp-config\\n--restricted\\n--output-format\\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify(${JSON.stringify(state)}));
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(script, body, 'utf8');
  return { NURSEDECK_CLAUDE_PATH: process.execPath, NURSEDECK_CLAUDE_PREFIX_ARGS: script };
}

async function shoot(name, env, waitFor) {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, ...env },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(waitFor, { timeout: 60_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  const checks = await page.locator('.check').allTextContents();
  console.log(`${name}: ${checks.length} checks`);
  await app.close();
}

// Signed out: the state she will most likely hit on a fresh Mac.
await shoot('gate-signedout', await stub({ loggedIn: false, authMethod: 'none' }),
  'button:has-text("Sign in to Claude")');

// Billed per use: allowed, but warned about.
await shoot('gate-apibilling',
  await stub({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: 'student@example.com' }),
  '.check-warn');

// Not installed at all.
await shoot('gate-missing',
  { NURSEDECK_CLAUDE_PATH: join(tmpdir(), 'nursedeck-absent-cli') },
  '.copy-row');

console.log('done');
