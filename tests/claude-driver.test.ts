import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, checkCliHealth, ClaudeError } from '@core/generate/claude.js';

/**
 * These tests drive the real Claude Code CLI. They are the only proof that the
 * headless contract actually holds, so they are not mocked.
 */

let workspaceDir: string;
let health: Awaited<ReturnType<typeof checkCliHealth>>;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'nursedeck-test-'));
  health = await checkCliHealth();
});

describe('checkCliHealth', () => {
  it('finds an installed, signed-in CLI', () => {
    expect(health.installed).toBe(true);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(health.loggedIn).toBe(true);
    expect(health.problem).toBeUndefined();
  });

  it('reports a missing binary rather than throwing', async () => {
    const missing = await checkCliHealth('definitely-not-a-real-binary-xyz');
    expect(missing.installed).toBe(false);
    expect(missing.loggedIn).toBe(false);
    expect(missing.problem).toMatch(/not found|installer/i);
  });
});

describe('runClaude', () => {
  const schema = {
    type: 'object',
    properties: {
      analyte: { type: 'string' },
      low: { type: 'number' },
      high: { type: 'number' },
      unit: { type: 'string' },
    },
    required: ['analyte', 'low', 'high', 'unit'],
    additionalProperties: false,
  };

  it('returns schema-valid structured output', async () => {
    const res = await runClaude<{ analyte: string; low: number; high: number; unit: string }>(
      'State the normal adult serum potassium reference range. Respond with JSON only.',
      { schema, workspaceDir, model: 'sonnet', maxBudgetUsd: 1 },
    );

    expect(res.data.analyte.toLowerCase()).toContain('potassium');
    // The widely published adult range is 3.5-5.0 mEq/L.
    expect(res.data.low).toBeCloseTo(3.5, 1);
    expect(res.data.high).toBeGreaterThanOrEqual(5.0);
    expect(res.data.high).toBeLessThanOrEqual(5.5);
    expect(res.data.unit).toMatch(/mEq\/L|mmol\/L/i);

    expect(res.sessionId).not.toBe('');
    expect(res.numTurns).toBeGreaterThan(0);
  });

  it('grounds its answer in content piped via stdin', async () => {
    // Proves the stdin channel works and that the model uses the supplied
    // numbers rather than its own prior. The INR range here is real, but the
    // point is that it echoes what it was given.
    const res = await runClaude<{ analyte: string; low: number; high: number; unit: string }>(
      'The user message contains a lecture excerpt. Report the reference range it states, using its numbers exactly. JSON only.',
      {
        schema,
        workspaceDir,
        model: 'sonnet',
        maxBudgetUsd: 1,
        input: 'Slide 4: The therapeutic INR range for a client on warfarin is 2.0 to 3.0 (INR, no units).',
      },
    );
    expect(res.data.low).toBeCloseTo(2.0, 1);
    expect(res.data.high).toBeCloseTo(3.0, 1);
  });

  it('accepts content far larger than the Windows command-line limit', async () => {
    // ~90k chars: well past the ~32,767-char cap on a Windows command line,
    // so this can only succeed through stdin.
    const filler = Array.from(
      { length: 1200 },
      (_, i) => 'Slide ' + (i + 1) + ': Routine filler content about nursing documentation practices.',
    ).join('\n');
    const payload =
      filler + '\nSlide 1201: The normal adult serum magnesium range is 1.3 to 2.1 mEq/L.';
    expect(payload.length).toBeGreaterThan(40_000);

    const res = await runClaude<{ analyte: string; low: number; high: number; unit: string }>(
      'Find the magnesium reference range in the supplied lecture text and report it. JSON only.',
      { schema, workspaceDir, model: 'sonnet', maxBudgetUsd: 1, input: payload },
    );
    expect(res.data.low).toBeCloseTo(1.3, 1);
    expect(res.data.high).toBeCloseTo(2.1, 1);
  });

  it('surfaces a missing CLI as a typed ClaudeError', async () => {
    await expect(
      runClaude('hello', {
        schema,
        workspaceDir,
        cliPath: 'definitely-not-a-real-binary-xyz',
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(ClaudeError);
  });

  it('honours an AbortSignal', async () => {
    const ac = new AbortController();
    const p = runClaude('Describe the nursing process in detail.', {
      schema,
      workspaceDir,
      model: 'sonnet',
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ detail: { kind: 'aborted' } });
  });
});
