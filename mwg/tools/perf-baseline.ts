/**
 * Record the performance suite's numbers as a trend baseline (ROADMAP P10).
 *
 * `tests/performance.test.ts` fails when a measurement drifts beyond the
 * tolerance in `tests/performance-baseline.json`; rewriting that file is a
 * deliberate act, so the diff shows what a change cost. Run `npm run perf:baseline`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { measureAll, mwgDir } from './perf-suite.ts';

const target = path.join(mwgDir, 'tests', 'performance-baseline.json');
const measurements = measureAll();
const baseline = {
  recorded: new Date().toISOString().slice(0, 10),
  measurements: Object.fromEntries(measurements.map((measurement) => [measurement.name, { value: Number(measurement.value.toFixed(2)), unit: measurement.unit, detail: measurement.detail }])),
};
fs.writeFileSync(target, `${JSON.stringify(baseline, null, '\t')}\n`, 'utf8');
for (const measurement of measurements) {
  const value = measurement.unit === 'bytes' ? `${(measurement.value / 1048576).toFixed(1)}MB` : `${measurement.value.toFixed(1)}${measurement.unit}`;
  console.log(`  ${measurement.name}: ${value}  (${measurement.detail})`);
}
console.log(`perf-baseline: ${measurements.length} measurements -> ${path.relative(mwgDir, target)}`);
