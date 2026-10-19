/**
 * Performance budgets (ROADMAP P10). The numbers are deliberately loose: they
 * exist to catch a pathological regression (a quadratic walk, a per-cell
 * container, an accidental `Math.random`, a rebuild inside a loop), not to fail
 * on a slow machine. Each test prints its measurement so a run records the
 * actual cost, and the ceilings are the documented budget.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Generator } from 'mwg/core';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { planSide } from '../src/ai/plan.ts';
import { policyFor } from '../src/ai/policy.ts';
import { attackWithRules, makeGame, updateVision, type GameState } from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import { buildTerrainTiles, parseTerrainGraphics, type TgRuleSpec } from '../src/simulation/terrain-graphics.ts';
import { parseWml, WmlPreprocessor, type WmlNode } from '../src/simulation/wml.ts';
import { measureAll } from '../tools/perf-suite.ts';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(mwgDir, '..', 'data');

/** Documented budgets, in milliseconds. */
const BUDGET = {
  terrainBuild: 3000,
  aiPlan: 1000,
  // The Node test runner executes files concurrently; leave headroom for the
  // terrain-graphics fixture and asset-heavy imports on shared CI workers.
  combat: 5000,
};

let realRules: TgRuleSpec[] | undefined;
function loadRealRules(): TgRuleSpec[] {
  if (realRules) return realRules;
  const dir = path.join(dataDir, 'core', 'terrain-graphics');
  const files = readdirSync(dir).filter((name) => name.endsWith('.cfg')).sort();
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  wml.loadMacros(files.map((name) => path.join(dir, name)));
  const nodes: WmlNode[] = files.flatMap((name) => parseWml(wml.preprocessFile(path.join(dir, name)), name));
  nodes.push(...parseWml(wml.preprocessFile(path.join(dataDir, 'core', 'terrain-graphics.cfg')), 'terrain-graphics.cfg'));
  realRules = parseTerrainGraphics(nodes, 'terrain-graphics.cfg');
  return realRules;
}

/** A 30x20 field with a 20-level castle keep and a mix of terrain for transitions. */
function largeField(): GameState {
  const width = 30;
  const height = 20;
  const codes: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x * 7 + y * 13) % 11;
      codes.push(v < 2 ? 'Gg^Fp' : v < 3 ? 'Gg^Vh' : v < 4 ? 'Ww' : v < 5 ? 'Mm' : 'Gg');
    }
  }
  const keeps = new Map([
    [1, [{ x: 0, y: 0 }]],
    [2, [{ x: width - 1, y: height - 1 }]],
  ]);
  const state = makeGame(width, height, codes, keeps);
  // Keep the AI's keep connected to a castle so this benchmark exercises the
  // recruitment candidate path as well as movement and threat scoring.
  codes[(height - 1) * width + width - 1] = 'Ch';
  for (let i = 0; i < 12; i++) {
    const unit = makeUnit(GAME_DATA, i % 2 === 0 ? 'Spearman' : 'Bowman', 1, i % 5, i % 4, () => 0.5);
    unit.movement = unit.maxMovement;
    state.units.push(unit);
  }
  for (let i = 0; i < 12; i++) {
    const unit = makeUnit(GAME_DATA, i % 2 === 0 ? 'Orcish Grunt' : 'Orcish Archer', 2, 13 + (i % 5), 8 + (i % 4), () => 0.5);
    unit.movement = unit.maxMovement;
    state.units.push(unit);
  }
  updateVision(state, GAME_DATA);
  return state;
}

test('the terrain-transition build stays within its budget on a 30x20 map', (t) => {
  const rules = loadRealRules();
  const isForest = (x: number, y: number): string => (x >= 8 && x <= 20 && y >= 5 && y <= 14 ? 'Gg^Fp' : 'Gg');
  const started = performance.now();
  const tiles = buildTerrainTiles(rules, { width: 30, height: 20, terrainAt: isForest, drawBorder: true, tod: 'morning' });
  const elapsed = performance.now() - started;
  t.diagnostic(`terrain build: ${elapsed.toFixed(1)}ms for ${tiles.size} hexes (budget ${BUDGET.terrainBuild}ms)`);
  assert.ok(tiles.size >= 600, `the map plus its border hexes built: ${tiles.size}`);
  assert.ok(elapsed < BUDGET.terrainBuild, `terrain build took ${elapsed.toFixed(1)}ms, budget ${BUDGET.terrainBuild}ms`);
});

test('planning a full side stays within its budget', (t) => {
  const state = largeField();
  const started = performance.now();
  const actions = planSide(state, GAME_DATA, 2, { policy: { ...policyFor('normal'), recruitLimit: 24 }, recruitTypes: ['Orcish Grunt', 'Orcish Archer'], gold: 200 });
  const elapsed = performance.now() - started;
  t.diagnostic(`ai plan: ${elapsed.toFixed(1)}ms for ${state.units.length} units -> ${actions.length} actions (budget ${BUDGET.aiPlan}ms)`);
  assert.ok(actions.length > 0, 'the planner returns actions');
  assert.ok(elapsed < BUDGET.aiPlan, `ai plan took ${elapsed.toFixed(1)}ms, budget ${BUDGET.aiPlan}ms`);
});

test('a combat-heavy rules loop stays within its budget', (t) => {
  const state = largeField();
  const attacker = state.units.find((unit) => unit.side === 1)!;
  const defender = state.units.find((unit) => unit.side === 2)!;
  attacker.x = defender.x - 1;
  attacker.y = defender.y;
  const rng = new Generator(7);
  const roll = (): number => rng.float();
  const name = attacker.attacks[0].name;
  const exchanges = 200;
  const started = performance.now();
  for (let i = 0; i < exchanges; i++) {
    attacker.hitpoints = attacker.maxHitpoints;
    defender.hitpoints = defender.maxHitpoints;
    attackWithRules(state, GAME_DATA, attacker, defender, name, roll);
  }
  const elapsed = performance.now() - started;
  t.diagnostic(`combat: ${elapsed.toFixed(1)}ms for ${exchanges} exchanges (${(elapsed / exchanges).toFixed(3)}ms each, budget ${BUDGET.combat}ms)`);
  assert.ok(elapsed < BUDGET.combat, `combat loop took ${elapsed.toFixed(1)}ms, budget ${BUDGET.combat}ms`);
});

/**
 * The trend baseline (ROADMAP P10). `npm run perf:baseline` records the suite's
 * numbers in `tests/performance-baseline.json`; this test fails when a
 * measurement drifts past the tolerance, so a performance regression is a test
 * failure with the old and new numbers rather than a slow game nobody notices.
 * The tolerance is wide on purpose: the point is to catch a change in kind
 * (a quadratic walk, a per-cell container, a rebuild inside a loop), not the
 * noise of a shared CI worker.
 */
const TREND_TOLERANCE = 2.5;

interface PerfBaseline {
  recorded: string;
  measurements: Record<string, { value: number; unit: string; detail: string }>;
}

test('no measurement drifts past the recorded baseline', (t) => {
  const baselinePath = path.join(mwgDir, 'tests', 'performance-baseline.json');
  if (!existsSync(baselinePath)) {
    t.diagnostic('no performance baseline recorded; run `npm run perf:baseline` to create one');
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as PerfBaseline;
  const measurements = measureAll();
  const regressions: string[] = [];
  for (const measurement of measurements) {
    const recorded = baseline.measurements[measurement.name];
    if (!recorded) {
      t.diagnostic(`${measurement.name}: not in the baseline (recorded ${baseline.recorded})`);
      continue;
    }
    const ratio = recorded.value === 0 ? 0 : measurement.value / recorded.value;
    const value = measurement.unit === 'bytes' ? `${(measurement.value / 1048576).toFixed(1)}MB` : `${measurement.value.toFixed(1)}${measurement.unit}`;
    const was = recorded.unit === 'bytes' ? `${(recorded.value / 1048576).toFixed(1)}MB` : `${recorded.value.toFixed(1)}${recorded.unit}`;
    t.diagnostic(`${measurement.name}: ${value} (baseline ${was}, recorded ${baseline.recorded})`);
    if (ratio > TREND_TOLERANCE) regressions.push(`${measurement.name}: ${was} -> ${value} (${ratio.toFixed(1)}x)`);
  }
  assert.deepEqual(regressions, [], `measurements past ${TREND_TOLERANCE}x their baseline:\n${regressions.join('\n')}`);
});
