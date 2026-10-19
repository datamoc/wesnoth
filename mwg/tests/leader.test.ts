import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import {
  canRecruitOn,
  isCastleHex,
  isKeepHex,
  isRecruitHex,
  makeGame,
  recruit,
  sideLeaders,
  vacantRecruitHexes,
  type GameState,
} from '../src/simulation/game.ts';
import { terrainIdForCode } from '../src/simulation/terrain.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';

/**
 * Recruit, recall and leader lifecycle (`src/game_state.cpp:288-378`):
 *
 * - a castle is the terrain flag `recruit_onto=yes`, a keep is `recruit_from=yes`,
 *   so orcish (`Co`) and encampment (`Ke`) codes classify like `Ch`/`Kh`;
 * - a leader must stand on a keep and the target must be a vacant castle hex
 *   connected to that keep through castle hexes (`can_recruit_on`);
 * - a side whose scenario declares a leader loses recruitment when the leader
 *   leaves the keep or dies.
 *
 * A 5x3 field: keep `Ke` at (2,0), `Co` castles at (1,0), (3,0) and (2,1), and
 * a detached `Co` at (0,2) with grass between it and the keep.
 */
function arena(): GameState {
  const codes = Array.from({ length: 15 }, () => 'Gg');
  const set = (x: number, y: number, code: string): void => { codes[y * 5 + x] = code; };
  set(2, 0, 'Ke');
  set(1, 0, 'Co');
  set(3, 0, 'Co');
  set(2, 1, 'Co');
  set(0, 2, 'Co');
  const state = makeGame(5, 3, codes, new Map([[1, [{ x: 2, y: 0 }]]]));
  state.turn = 1;
  state.leaderSides = new Set([1]);
  return state;
}

function leaderAt(state: GameState, x: number, y: number): Unit {
  const leader = makeUnit(GAME_DATA, 'Orcish Grunt', 1, x, y);
  leader.canRecruit = true;
  state.units.push(leader);
  return leader;
}

test('recruit_onto and recruit_from come from the terrain data, not the code prefix', () => {
  assert.equal(GAME_DATA.terrains[terrainIdForCode(GAME_DATA, 'Ch')].recruitOnto, true);
  assert.equal(GAME_DATA.terrains[terrainIdForCode(GAME_DATA, 'Co')].recruitOnto, true);
  assert.equal(GAME_DATA.terrains[terrainIdForCode(GAME_DATA, 'Ke')].recruitFrom, true);
  assert.equal(GAME_DATA.terrains[terrainIdForCode(GAME_DATA, 'Gg')].recruitOnto, false);

  const state = arena();
  assert.equal(isCastleHex(state, GAME_DATA, 1, 0), true, 'orcish castle is a castle');
  assert.equal(isCastleHex(state, GAME_DATA, 2, 0), true, 'a keep is recruit_onto');
  assert.equal(isCastleHex(state, GAME_DATA, 0, 0), false, 'grass is not');
  assert.equal(isKeepHex(state, GAME_DATA, 2, 0), true, 'encampment keep');
  assert.equal(isKeepHex(state, GAME_DATA, 1, 0), false, 'a castle is not a keep');
});

test('a leader recruits only onto castle hexes connected to its keep', () => {
  const state = arena();
  const leader = leaderAt(state, 2, 0);
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 1, 0), true, 'adjacent castle');
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 2, 1), true, 'castle below the keep');
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 0, 2), false, 'detached castle is unreachable');
  assert.equal(canRecruitOn(state, GAME_DATA, leader, 2, 0), false, 'the leader occupies its own keep');
  assert.equal(recruit(state, GAME_DATA, 1, 'Orcish Grunt', 0, 2), null, 'recruit respects connectivity');
});

test('an empty keep or a dead leader stops recruitment', () => {
  const state = arena();
  const leader = leaderAt(state, 2, 0);
  assert.equal(recruit(state, GAME_DATA, 1, 'Orcish Grunt', 1, 0) !== null, true);
  // Walk the leader off the keep: no recruiter stands on a keep any more.
  leader.x = 0;
  leader.y = 1;
  assert.equal(sideLeaders(state, 1).length, 1, 'the leader still exists');
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 3, 0), false, 'but cannot recruit from grass');
  // Death removes the recruiter entirely.
  leader.hitpoints = 0;
  assert.equal(sideLeaders(state, 1).length, 0);
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 3, 0), false);
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 2, 1), false, 'a declared-leader side stops recruiting');
});

test('vacantRecruitHexes returns the free castle hexes the leader owns', () => {
  const state = arena();
  leaderAt(state, 2, 0);
  const free = vacantRecruitHexes(state, GAME_DATA, 1).map((hex) => `${hex.x},${hex.y}`);
  assert.deepEqual(free.sort(), ['1,0', '2,1', '3,0']);
  state.units.push(makeUnit(GAME_DATA, 'Orcish Grunt', 1, 3, 0), makeUnit(GAME_DATA, 'Orcish Grunt', 1, 1, 0));
  const after = vacantRecruitHexes(state, GAME_DATA, 1).map((hex) => `${hex.x},${hex.y}`);
  assert.deepEqual(after, ['2,1'], 'occupied hexes are not offered');
});

test('a side with no declared leader keeps the port skirmish rule', () => {
  const state = arena();
  state.leaderSides = undefined;
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 1, 0), true, 'keep marker and connected castles');
  assert.equal(isRecruitHex(state, GAME_DATA, 1, 0, 2), false, 'detached castle still unreachable');
});
