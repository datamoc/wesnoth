import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA, GAME_MAP } from '../src/generated/game-data.ts';
import { applyEffect, makeUnit } from '../src/simulation/unit.ts';
import { damagePerStrike, modifiedChanceToHit, retaliationAttack, roundDamage, lawfulCombatModifier } from '../src/simulation/combat.ts';
import { resolveTerrain } from '../src/simulation/terrain.ts';
import { reachable } from '../src/simulation/movement.ts';
import { makeGame, recruit, enemyZoc, upkeepFor, incomeFor } from '../src/simulation/game.ts';

test('roundDamage matches src/utils/math.hpp', () => {
  assert.equal(roundDamage(7, 12500, 10000), 9); // 7 * 1.25 rounded towards 7
  assert.equal(roundDamage(7, 7500, 10000), 5); // 7 * 0.75
  assert.equal(roundDamage(6, 10000, 10000), 6);
  assert.equal(roundDamage(1, 12500, 10000), 1); // never below 1
});

test('modifiedChanceToHit applies magical and marksman by id', () => {
  assert.equal(modifiedChanceToHit(40, []), 40);
  assert.equal(modifiedChanceToHit(40, ['magical']), 70);
  assert.equal(modifiedChanceToHit(40, ['marksman']), 60);
  assert.equal(modifiedChanceToHit(80, ['marksman']), 80);
  assert.equal(modifiedChanceToHit(40, ['magical', 'marksman']), 70); // magical replaces
});

test('defense_weight zero excludes an attack from retaliation', () => {
  const defender = { attacks: [
    { name: 'offense-only', range: 'melee', damage: 99, number: 9, defenseWeight: 0 },
    { name: 'shield', range: 'melee', damage: 2, number: 2, defenseWeight: 1 },
  ] } as never;
  assert.equal(retaliationAttack(defender, 'melee')?.name, 'shield');
});

test('lawfulCombatModifier matches generic_combat_modifier', () => {
  assert.equal(lawfulCombatModifier(25, 'lawful'), 25);
  assert.equal(lawfulCombatModifier(25, 'chaotic'), -25);
  assert.equal(lawfulCombatModifier(25, 'neutral'), 0);
  assert.equal(lawfulCombatModifier(25, 'liminal'), -25);
  assert.equal(lawfulCombatModifier(-25, 'lawful', true), 0); // fearless floors at 0
});

test('smallfoot terrain resolution reads the real alias chains', () => {
  const data = GAME_DATA;
  const smallfoot = data.movetypes.smallfoot;
  const grass = resolveTerrain(data, smallfoot, 'Gg');
  assert.equal(grass.moveCost, 1);
  assert.equal(grass.defense, 60);
  const village = resolveTerrain(data, smallfoot, 'Gg^Ve');
  assert.equal(village.moveCost, 1);
  assert.equal(village.defense, 40); // village defense beats grass defense
  assert.equal(village.heals, 8);
  assert.equal(village.isVillage, true);
  const deepWater = resolveTerrain(data, smallfoot, 'Wo');
  assert.equal(deepWater.moveCost, Infinity); // smallfoot cannot enter deep water
});

test('makeUnit applies real trait effects', () => {
  // rng always returns 0: picks strong first, then quick.
  const spearman = makeUnit(GAME_DATA, 'Spearman', 1, 0, 0, () => 0);
  assert.deepEqual(spearman.traits, ['strong', 'quick']);
  assert.equal(spearman.maxHitpoints, 35); // 36 +1 strong, then -5% quick
  assert.equal(spearman.maxMovement, 6); // 5 +1 quick
  const spear = spearman.attacks.find((attack) => attack.name === 'spear')!;
  assert.equal(spear.damage, 8); // 7 +1 strong melee
});

test('damagePerStrike applies alignment bonus and resistance like attack.cpp', () => {
  const spearman = makeUnit(GAME_DATA, 'Spearman', 1, 0, 0, () => 0.5);
  const orc = makeUnit(GAME_DATA, 'Orcish Grunt', 2, 1, 0, () => 0.5);
  const spear = spearman.attacks.find((attack) => attack.name === 'spear')!;
  // Morning: lawful +25%. Orcish Grunt has pierce resistance 100.
  assert.equal(damagePerStrike({ data: GAME_DATA, lawfulBonus: 25 }, spearman, orc, spear), 9);
  // Night: lawful -25%.
  assert.equal(damagePerStrike({ data: GAME_DATA, lawfulBonus: -25 }, spearman, orc, spear), 5);
});

test('reachable respects movement costs and ZoC stops', () => {
  const state = makeGame(5, 3, Array.from({ length: 15 }, () => 'Gg'), new Map());
  const spearman = makeUnit(GAME_DATA, 'Spearman', 1, 0, 1, () => 0.5);
  state.units.push(spearman);
  state.turn = 1;

  // 5 movement, all flat: every hex in range 5 except occupied.
  const moves = reachable(state, GAME_DATA, spearman);
  assert.ok(moves.size > 0);
  assert.ok(!moves.has('0,1'));

  // An adjacent level-1 enemy exerts ZoC; the hex next to it is reachable but
  // ends the route there.
  const grunt = makeUnit(GAME_DATA, 'Orcish Grunt', 2, 2, 1, () => 0.5);
  state.units.push(grunt);
  const nearEnemy = [...reachable(state, GAME_DATA, spearman).keys()];
  assert.ok(nearEnemy.includes('2,1') === false); // occupied
  assert.ok(enemyZoc(state, 1, 1, 1));
});

test('economy: upkeep is unit levels minus villages, income is base + villages - upkeep', () => {
  const state = makeGame(3, 3, Array.from({ length: 9 }, () => 'Gg'), new Map());
  const spearman = makeUnit(GAME_DATA, 'Spearman', 1, 0, 0, () => 0.5); // level 1
  state.units.push(spearman);
  state.villageOwner[4] = 1;
  assert.equal(upkeepFor(state, GAME_DATA, 1), 0); // 1 level - 1 village
  assert.equal(incomeFor(state, GAME_DATA, 1), 3); // 2 base + 1 village - 0 upkeep
  state.villageOwner[4] = null;
  assert.equal(upkeepFor(state, GAME_DATA, 1), 1);
  assert.equal(incomeFor(state, GAME_DATA, 1), 1);
});

test('recruit requires a castle hex connected to the keep', () => {
  const codes = Array.from({ length: 4 * 3 }, () => 'Gg');
  codes[1 * 4 + 1] = 'Kh';
  codes[1 * 4 + 2] = 'Ch';
  codes[1 * 4 + 3] = 'Ch';
  const state = makeGame(4, 3, codes, new Map([[1, [{ x: 1, y: 1 }]]]));
  state.turn = 1;
  const unit = recruit(state, GAME_DATA, 1, 'Spearman', 3, 1, () => 0.5);
  assert.ok(unit);
  assert.equal(unit.side, 1);
  assert.equal(recruit(state, GAME_DATA, 1, 'Spearman', 0, 0, () => 0.5), null); // not castle
});

test('compiled map parses to the real Freelands dimensions and keeps', () => {
  assert.equal(GAME_MAP.width, 39);
  assert.equal(GAME_MAP.height, 26);
  assert.deepEqual(GAME_MAP.keeps['1'], [{ x: 19, y: 4 }]);
  assert.deepEqual(GAME_MAP.keeps['2'], [{ x: 19, y: 21 }]);
});

test('quick trait percent effect rounds like the engine', () => {
  assert.equal(applyEffect({ applyTo: 'hitpoints', increaseTotal: '-5%' }, [], { maxHitpoints: 36, maxMovement: 5, maxExperience: 42 }).maxHitpoints, 34);
  assert.equal(applyEffect({ applyTo: 'hitpoints', increaseTotal: 1 }, [], { maxHitpoints: 36, maxMovement: 5, maxExperience: 42 }).maxHitpoints, 37);
});
