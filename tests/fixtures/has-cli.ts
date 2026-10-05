import { locateClaudeCli } from '@core/generate/cli-locator.js';

/**
 * Whether a usable Claude Code CLI exists on this machine.
 *
 * A handful of tests drive the real CLI rather than a mock, deliberately: they
 * check that the adversarial auditor actually catches a shifted lab range, a
 * reversed safety instruction, a true-but-uncited claim. Those are assertions
 * about model behaviour, and a mocked model would assert nothing.
 *
 * They cannot run on a CI runner. There is no Claude Code there and there must
 * not be: putting a subscription credential into CI is exactly the thing this
 * app was built to avoid. So they skip when no CLI is present, and run in full
 * on a machine that has one.
 *
 * A skipped test is not a passing test. What covers this on CI is everything
 * else -- the deterministic gate, the schema handling, the database invariants
 * -- and what covers the model behaviour is running the suite locally plus the
 * end-to-end validation against real lecture decks.
 */
export const CLI_AVAILABLE = (await locateClaudeCli()) !== undefined;
