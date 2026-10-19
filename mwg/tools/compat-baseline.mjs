/**
 * The WML compatibility baseline (ROADMAP P0: "WML compatibility matrix").
 *
 * Every compiled scenario publishes how much of its WML the loader could not
 * use: a count of skipped constructs, split into warnings (presentation and
 * detail tags) and blocking (anything that could change campaign state or
 * control flow), plus the distinct messages. `tests/compatibility.test.ts`
 * compares a fresh compile against this file, so a change that newly ignores
 * blocking content fails the suite instead of passing silently.
 *
 * Run `npm run compat:baseline` to rewrite it after an intentional change, and
 * say why in the commit message: the diff is the point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIO_COMPATIBILITY } from '../src/generated/scenarios.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mwgDir = path.resolve(here, '..');
const target = path.join(mwgDir, 'tests', 'compatibility-baseline.json');

/**
 * Strip the scenario id and the source location from a diagnostic, so the
 * baseline records the *kind* of construct that was skipped rather than every
 * occurrence of it.
 */
export function patternOf(message) {
  return message
    .replace(/^[^:]*:\s*/, '')
    .replace(/\s*\([^)]*:\d+\)\s*$/, '')
    .trim();
}

export function baselineFrom(compatibility) {
  const scenarios = {};
  const patterns = new Set();
  const totals = { scenarios: 0, skipped: 0, warnings: 0, blocking: 0 };
  for (const [id, report] of Object.entries(compatibility)) {
    scenarios[id] = { skipped: report.skipped, warnings: report.warnings, blocking: report.blocking };
    for (const detail of report.details) patterns.add(patternOf(detail));
    totals.scenarios += 1;
    totals.skipped += report.skipped;
    totals.warnings += report.warnings;
    totals.blocking += report.blocking;
  }
  return { totals, patterns: [...patterns].sort(), scenarios };
}

const baseline = baselineFrom(SCENARIO_COMPATIBILITY);
fs.writeFileSync(target, `${JSON.stringify(baseline, null, '\t')}\n`, 'utf8');
console.log(
  `compat-baseline: ${baseline.totals.scenarios} scenarios, ${baseline.totals.skipped} skips ` +
    `(${baseline.totals.warnings} warnings, ${baseline.totals.blocking} blocking), ` +
    `${baseline.patterns.length} distinct patterns -> ${path.relative(mwgDir, target)}`,
);
