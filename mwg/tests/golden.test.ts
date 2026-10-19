/**
 * Golden scenario runs (ROADMAP P10). A scripted, headless sequence of real
 * rules calls (move, attack, recruit) driven by a seeded `mwg/core` generator;
 * the outcome to diff is the final `syncStateHash`. The hash covers unit
 * positions, hit points, movement, statuses, gold, the round/turn counters and
 * the generator state, so a change to combat, terrain, upkeep, trait rolls or
 * even the order randomness is consumed in changes it. This is the regression
 * gate the roadmap asks for: scripted scenarios run headless and diff their
 * outcome.
 *
 * After an intentional rules change, run `node --test tests/golden.test.ts` and
 * copy the reported hash into `GOLDEN` below (the assertion prints it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Generator } from 'mwg/core';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { attackWithRules, makeGame, recruit, type GameState } from '../src/simulation/game.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';
import { moveUnit } from '../src/simulation/movement.ts';
import { syncStateHash } from '../src/simulation/sync.ts';

const WIDTH = 8;
const HEIGHT = 5;
const SEED = 20260911;
/** Recorded from the first run with seed `20260911`; see the file comment. */
const GOLDEN = '751f4c6f';

type Roll = () => number;

/** An 8x5 grass field with a village on the road and a castle keep per side. */
function field(): GameState {
  const codes: string[] = [];
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) codes.push('Gg');
  const set = (x: number, y: number, code: string): void => { codes[y * WIDTH + x] = code; };
  set(3, 1, 'Gg^Ve');
  set(4, 2, 'Gg^Ve');
  set(1, 1, 'Ch');
  set(1, 2, 'Ch');
  set(1, 3, 'Ch');
  set(6, 1, 'Ch');
  set(6, 2, 'Ch');
  set(6, 3, 'Ch');
  const keeps = new Map([
    [1, [{ x: 0, y: 2 }]],
    [2, [{ x: 7, y: 2 }]],
  ]);
  return makeGame(WIDTH, HEIGHT, codes, keeps);
}

function place(state: GameState, typeId: string, side: number, x: number, y: number, roll: Roll): Unit {
  const unit = makeUnit(GAME_DATA, typeId, side, x, y, roll);
  unit.movement = unit.maxMovement;
  state.units.push(unit);
  return unit;
}

function strike(state: GameState, attacker: Unit, defender: Unit, index: number, roll: Roll): number {
  const name = attacker.attacks[index]?.name;
  assert.ok(name, `${attacker.typeId} has attack #${index}`);
  return attackWithRules(state, GAME_DATA, attacker, defender, name, roll).exchange.strikes.length;
}

interface Skirmish {
  hash: string;
  state: GameState;
  gold: Record<number, number>;
  strikes: number;
}

/** The scripted run; both tests share it so they diff the same thing. */
function skirmish(): Skirmish {
  const rng = new Generator(SEED);
  const roll: Roll = () => rng.float();
  const state = field();
  const gold: Record<number, number> = { 1: 100, 2: 100 };

  state.turn = 1;
  const spearman = place(state, 'Spearman', 1, 2, 2, roll);
  const bowman = place(state, 'Bowman', 1, 2, 1, roll);
  const grunt = place(state, 'Orcish Grunt', 2, 5, 2, roll);
  const archer = place(state, 'Orcish Archer', 2, 5, 1, roll);

  assert.ok(moveUnit(state, GAME_DATA, spearman, 4, 2).ok, 'the spearman reaches the village');
  let strikes = strike(state, spearman, grunt, 0, roll);
  assert.ok(strikes > 0, 'the spearman lands at least one strike');

  assert.ok(moveUnit(state, GAME_DATA, bowman, 4, 1).ok, 'the bowman advances');
  strikes += strike(state, bowman, archer, 0, roll);

  const levy = recruit(state, GAME_DATA, 1, 'Spearman', 1, 2, roll);
  assert.ok(levy, 'side 1 recruits on its keep');
  gold[1] -= GAME_DATA.unitTypes.Spearman.cost;

  // Side 2 answers, then recruits.
  state.turn = 2;
  for (const unit of state.units) unit.movement = unit.maxMovement;
  if (grunt.hitpoints > 0) strikes += strike(state, grunt, spearman, 0, roll);
  if (archer.hitpoints > 0) strikes += strike(state, archer, bowman, 0, roll);
  const orc = recruit(state, GAME_DATA, 2, 'Orcish Grunt', 7, 2, roll);
  assert.ok(orc, 'side 2 recruits on its keep');
  gold[2] -= GAME_DATA.unitTypes['Orcish Grunt'].cost;

  // Round two: fresh movement, one more exchange.
  state.round = 2;
  state.turn = 1;
  for (const unit of state.units) unit.movement = unit.maxMovement;
  if (spearman.hitpoints > 0 && grunt.hitpoints > 0) strikes += strike(state, spearman, grunt, 0, roll);

  return { hash: outcomeHash(state, gold, rng.getState()), state, gold, strikes };
}

/**
 * `syncStateHash` includes unit ids, which come from a process-wide counter and
 * depend on how many units earlier tests made. Renumber by insertion order so
 * the golden depends only on the rules and the seed.
 */
function outcomeHash(state: GameState, gold: Record<number, number>, rngState: readonly number[]): string {
  const units = state.units.map((unit, index) => ({ ...unit, id: index + 1 }));
  return syncStateHash({ ...state, units }, 'golden-skirmish', gold, rngState);
}

test('a scripted skirmish is deterministic across runs', () => {
  const first = skirmish();
  const second = skirmish();
  assert.equal(first.hash, second.hash, 'two runs of the same seed and script agree');
  assert.deepEqual(
    first.state.units.map((unit) => [unit.typeId, unit.x, unit.y, unit.hitpoints, unit.movement]),
    second.state.units.map((unit) => [unit.typeId, unit.x, unit.y, unit.hitpoints, unit.movement]),
  );
  assert.ok(first.strikes >= 6, `${first.strikes} strikes`);
  assert.ok(
    first.state.units.some((unit) => unit.hitpoints < unit.maxHitpoints),
    'the script really fought',
  );
  assert.ok(first.state.villageOwner.some((owner) => owner === 1), 'the spearman captured the village');
});

test('the scripted skirmish matches its recorded golden outcome', () => {
  const { hash, state, gold } = skirmish();
  assert.equal(hash, GOLDEN, `the golden hash changed; update GOLDEN to ${hash}`);
  assert.deepEqual(gold, { 1: 100 - GAME_DATA.unitTypes.Spearman.cost, 2: 100 - GAME_DATA.unitTypes['Orcish Grunt'].cost });
  assert.equal(state.round, 2);
  assert.equal(state.turn, 1);
  assert.equal(state.units.length, 5, 'one recruit joined the four starting units');
});
