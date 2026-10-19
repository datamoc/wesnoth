import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCENARIO_COMPATIBILITY } from '../src/generated/scenarios.ts';

/**
 * The WML compatibility matrix gate (ROADMAP P0).
 *
 * The ledger in `PORT_COVERAGE.md` says what the port implements; this test
 * says what the *shipped scenarios actually use*. Every compiled scenario
 * publishes the constructs its loader could not use, split into warnings
 * (presentation) and blocking (anything that can change campaign state or
 * control flow). `tests/compatibility-baseline.json` records today's numbers:
 * a change that newly ignores blocking content, or introduces a kind of skip
 * the baseline never saw, fails here rather than shipping quietly.
 *
 * `npm run compat:baseline` rewrites the file after an intentional change.
 */
const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Baseline {
  totals: { scenarios: number; skipped: number; warnings: number; blocking: number };
  patterns: string[];
  scenarios: Record<string, { skipped: number; warnings: number; blocking: number }>;
}

const baseline = JSON.parse(readFileSync(path.join(mwgDir, 'tests', 'compatibility-baseline.json'), 'utf8')) as Baseline;

/** The same normalization the baseline tool uses: drop ids and line numbers. */
function patternOf(message: string): string {
  return message.replace(/^[^:]*:\s*/, '').replace(/\s*\([^)]*:\d+\)\s*$/, '').trim();
}

test('no scenario newly ignores blocking WML', () => {
  const regressions: string[] = [];
  for (const [id, report] of Object.entries(SCENARIO_COMPATIBILITY)) {
    const before = baseline.scenarios[id];
    if (!before) {
      // A scenario the baseline never saw (a newly compiled campaign) is
      // allowed only when it ignores nothing blocking.
      if (report.blocking > 0) regressions.push(`${id}: ${report.blocking} blocking constructs (not in the baseline)`);
      continue;
    }
    if (report.blocking > before.blocking) {
      regressions.push(`${id}: blocking ${before.blocking} -> ${report.blocking}`);
    }
  }
  assert.deepEqual(regressions, [], `new blocking WML content:\n${regressions.join('\n')}`);
});

test('no scenario newly skips a construct the baseline never saw', () => {
  const known = new Set(baseline.patterns);
  const introduced = new Map<string, string>();
  for (const [id, report] of Object.entries(SCENARIO_COMPATIBILITY)) {
    for (const detail of report.details) {
      const pattern = patternOf(detail);
      if (!known.has(pattern) && !introduced.has(pattern)) introduced.set(pattern, `${id}: ${pattern}`);
    }
  }
  assert.deepEqual(
    [...introduced.values()],
    [],
    'new skip patterns (add them to tests/compatibility-baseline.json only with a PORT_COVERAGE.md row)',
  );
});

test('the shipped totals do not drift upward', () => {
  const totals = { scenarios: 0, skipped: 0, warnings: 0, blocking: 0 };
  for (const report of Object.values(SCENARIO_COMPATIBILITY)) {
    totals.scenarios += 1;
    totals.skipped += report.skipped;
    totals.warnings += report.warnings;
    totals.blocking += report.blocking;
  }
  assert.ok(totals.scenarios >= baseline.totals.scenarios, 'no scenario disappeared');
  assert.ok(totals.blocking <= baseline.totals.blocking, `blocking skips rose: ${baseline.totals.blocking} -> ${totals.blocking}`);
  assert.ok(totals.skipped <= baseline.totals.skipped, `skips rose: ${baseline.totals.skipped} -> ${totals.skipped}`);
});
