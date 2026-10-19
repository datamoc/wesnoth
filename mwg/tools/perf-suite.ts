/**
 * The performance suite's measurements (ROADMAP P10: "Performance and memory
 * regression suite").
 *
 * One place defines what is measured and how, so `tests/performance.test.ts`
 * can assert against the budgets and `tools/perf-baseline.ts` can record the
 * same numbers as a trend baseline. A measurement is a small, deterministic
 * workload over the real data: a large-map terrain build, a long pathfinding
 * flood, a full AI turn, a combat-heavy rules loop, a scenario's runtime build,
 * and the compiled asset payload's size.
 *
 * The workloads deliberately use the shipped data and the real entry points
 * (`buildTerrainTiles`, `reachable`, `planSide`, `attackWithRules`,
 * `MwlRuntime`), so a regression in any of them shows up here rather than in a
 * player's frame time.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Generator } from 'mwg/core';
import { MwlRuntime } from 'mwg/mwl';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { SCENARIOS } from '../src/generated/scenarios.ts';
import { planSide } from '../src/ai/plan.ts';
import { policyFor } from '../src/ai/policy.ts';
import { attackWithRules, makeGame, updateVision, type GameState } from '../src/simulation/game.ts';
import { reachable } from '../src/simulation/movement.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';
import { buildTerrainTiles, parseTerrainGraphics, type TgRuleSpec } from '../src/simulation/terrain-graphics.ts';
import { parseWml, WmlPreprocessor } from '../src/simulation/wml.ts';

export const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(mwgDir, '..', 'data');

/** One measurement: the name a baseline records, its unit, and its value. */
export interface Measurement {
  name: string;
  unit: 'ms' | 'bytes' | 'count';
  value: number;
  /** what the workload covers, for a trend report */
  detail: string;
}

let cachedRules: TgRuleSpec[] | undefined;

/** The real `data/core/terrain-graphics` rules, loaded once. */
export function terrainRules(): TgRuleSpec[] {
  if (cachedRules) return cachedRules;
  const dir = path.join(dataDir, 'core', 'terrain-graphics');
  const files = readdirSync(dir).filter((name) => name.endsWith('.cfg')).sort();
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  wml.loadMacros(files.map((name) => path.join(dir, name)));
  const rules: TgRuleSpec[] = [];
  for (const file of files) rules.push(...parseTerrainGraphics(parseWml(wml.preprocessFile(path.join(dir, file)), file)));
  cachedRules = rules;
  return rules;
}

/** The compiled-node shape the scenario workloads walk. */
interface PerfNode {
  readonly children?: readonly PerfNode[];
}

/** A wide grass field with keeps at both ends, for movement and AI workloads. */
export function largeField(width = 40, height = 30): GameState {
  const codes: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) codes.push(x % 7 === 3 && y % 5 === 2 ? 'Gg^Fp' : 'Gg');
  }
  const keeps = new Map([[1, [{ x: 0, y: 0 }]], [2, [{ x: width - 1, y: height - 1 }]]]);
  const state = makeGame(width, height, codes, keeps);
  state.sides = [1, 2];
  state.turn = 2;
  const place = (typeId: string, side: number, x: number, y: number): Unit => {
    const unit = makeUnit(GAME_DATA, typeId, side, x, y, () => 0.5);
    unit.movement = unit.maxMovement;
    state.units.push(unit);
    return unit;
  };
  const types = ['Spearman', 'Bowman', 'Cavalryman', 'Orcish Grunt', 'Orcish Archer', 'Wolf Rider'];
  for (let index = 0; index < 24; index++) {
    const side = index % 2 === 0 ? 1 : 2;
    const x = side === 1 ? 2 + (index % 6) : width - 3 - (index % 6);
    const y = 2 + Math.floor(index / 2) % (height - 4);
    place(types[index % types.length], side, x, y);
  }
  updateVision(state, GAME_DATA);
  return state;
}

function time(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

/** Every measurement, run in order. */
export function measureAll(): Measurement[] {
  const out: Measurement[] = [];

  const rules = terrainRules();
  const isForest = (x: number, y: number): string => (x >= 10 && x <= 60 && y >= 6 && y <= 40 ? 'Gg^Fp' : 'Gg');
  out.push({
    name: 'terrainBuild.60x50',
    unit: 'ms',
    value: time(() => {
      buildTerrainTiles(rules, { width: 60, height: 50, terrainAt: isForest, drawBorder: true, tod: 'morning' });
    }),
    detail: 'a 60x50 map with a forest block, real terrain-graphics rules',
  });

  const state = largeField();
  const mover = state.units.find((unit) => unit.side === 2)!;
  out.push({
    name: 'pathfinding.40x30',
    unit: 'ms',
    value: time(() => {
      for (let index = 0; index < 50; index++) {
        mover.movement = mover.maxMovement;
        reachable(state, GAME_DATA, mover);
      }
    }),
    detail: '50 reachable-set floods on a 40x30 map with 24 units',
  });

  const plan = time(() => {
    planSide(state, GAME_DATA, 2, { policy: { ...policyFor('normal'), recruitLimit: 24 }, recruitTypes: ['Orcish Grunt', 'Orcish Archer'], gold: 200 });
  });
  out.push({ name: 'ai.planSide', unit: 'ms', value: plan, detail: 'one side of 12 units plus recruitment, with the threat map' });

  const attacker = state.units.find((unit) => unit.side === 1)!;
  const defender = state.units.find((unit) => unit.side === 2)!;
  attacker.x = defender.x - 1;
  attacker.y = defender.y;
  const rng = new Generator(7);
  const name = attacker.attacks[0].name;
  out.push({
    name: 'combat.200exchanges',
    unit: 'ms',
    value: time(() => {
      for (let index = 0; index < 200; index++) {
        attacker.hitpoints = attacker.maxHitpoints;
        defender.hitpoints = defender.maxHitpoints;
        attackWithRules(state, GAME_DATA, attacker, defender, name, () => rng.float());
      }
    }),
    detail: '200 resolved exchanges through the real rules',
  });

  // The scene builds a runtime when it enters a scenario, and the shipped
  // scenarios range from a skirmish to a 400-scenario campaign document, so the
  // measurement walks the whole registry rather than guessing which is biggest.
  const nodeCount = (node: PerfNode): number => (node.children ?? []).reduce((total, child) => total + 1 + nodeCount(child), 0);
  const gameNodes = (game: { roots: readonly PerfNode[] }): number => game.roots.reduce((total, root) => total + 1 + nodeCount(root), 0);
  const totalNodes = Object.values(SCENARIOS).reduce((total, game) => total + gameNodes(game), 0);
  const biggest = Object.entries(SCENARIOS).sort((a, b) => gameNodes(b[1]) - gameNodes(a[1]))[0];
  out.push({
    name: 'scenario.buildAll',
    unit: 'ms',
    value: time(() => {
      for (const game of Object.values(SCENARIOS)) new MwlRuntime(game);
    }),
    detail: `one runtime per shipped scenario (${Object.keys(SCENARIOS).length} scenarios, ${totalNodes} nodes)`,
  });
  out.push({
    name: 'scenario.enterLargest',
    unit: 'ms',
    value: time(() => {
      const runtime = new MwlRuntime(biggest[1]);
      runtime.evaluate();
    }),
    detail: `runtime build plus objective evaluation for ${biggest[0]} (${gameNodes(biggest[1])} nodes)`,
  });

  const assets = path.join(mwgDir, 'src', 'assets', 'wesnoth');
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        bytes += statSync(full).size;
        files += 1;
      }
    }
  };
  walk(assets);
  out.push({ name: 'assets.bytes', unit: 'bytes', value: bytes, detail: `${files} files copied into the offline build` });

  return out;
}
