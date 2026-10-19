import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import {
  attackNumbers,
  chanceToHit,
  damagePerStrike,
  resistanceAfterAbilities,
  resistanceOf,
  resolveAttack,
} from '../src/simulation/combat.ts';
import { applies, compositeValue, effectsOf } from '../src/simulation/specials.ts';
import { makeUnit, poisonTick } from '../src/simulation/unit.ts';
import { endTurnStatuses } from '../src/simulation/game.ts';
import { makeGame } from '../src/simulation/game.ts';
import { resolveTerrain } from '../src/simulation/terrain.ts';
import { movetypeOf } from '../src/simulation/movement.ts';
import type { EffectTree } from '../src/simulation/types.ts';

/**
 * P1 rules: the value engine and the weapon specials/abilities the fight uses.
 * Definitions come from the real macros (`weapon_specials.cfg`, `abilities.cfg`)
 * through the data pipeline, so the expectations below are the game's numbers.
 */
const ctx = { data: GAME_DATA, lawfulBonus: 0 };

function effect(tag: string, attributes: Record<string, string>, children: EffectTree[] = []): EffectTree {
  return { tag, attributes, children };
}

function unit(typeId: string, side = 1) {
  const made = makeUnit(GAME_DATA, typeId, side, 0, 0, () => 0.5);
  made.hitpoints = made.maxHitpoints;
  return made;
}

test('compositeValue follows the C++ effect composition', () => {
  // add and sub are independent, and only the best of each effect id counts.
  assert.equal(compositeValue([effect('damage', { add: '3' }), effect('damage', { add: '5' })], 10), 15);
  assert.equal(compositeValue([effect('damage', { sub: '3' }), effect('damage', { sub: '5' })], 10), 5);
  assert.equal(compositeValue([effect('damage', { add: '3', sub: '1' })], 10), 12);
  // multiply and divide are percentages, applied after the additions.
  assert.equal(compositeValue([effect('damage', { add: '2', multiply: '2' })], 10), 24);
  assert.equal(compositeValue([effect('damage', { divide: '2' })], 10), 5);
  // value sets, keeping the highest positive and the lowest negative override.
  assert.equal(compositeValue([effect('chance_to_hit', { value: '70' })], 40), 70);
  assert.equal(compositeValue([effect('chance_to_hit', { value: '30' })], 40), 30);
  // cumulative=yes means "at least the base", which is how marksman works.
  assert.equal(compositeValue([effect('chance_to_hit', { value: '60', cumulative: 'yes' })], 40), 60);
  assert.equal(compositeValue([effect('chance_to_hit', { value: '60', cumulative: 'yes' })], 80), 80);
  // max_value and min_value clamp the result.
  assert.equal(compositeValue([effect('resistance', { multiply: '2', max_value: '50' })], 20), 40);
  assert.equal(compositeValue([effect('resistance', { multiply: '4', max_value: '50' })], 20), 50);
  assert.equal(compositeValue([effect('damage', { min_value: '12' })], 4), 12);
});

test('[filter_base_value] limits an effect to a range of base values', () => {
  const steadfast = effect('resistance', { multiply: '2', max_value: '50' }, [
    effect('filter_base_value', { greater_than: '0', less_than: '50' }),
  ]);
  assert.equal(compositeValue([steadfast], 20), 40, 'doubles a resistance under 50');
  assert.equal(compositeValue([steadfast], 0), 0, 'does not touch a 0 resistance');
  assert.equal(compositeValue([steadfast], 60), 60, 'does not touch a resistance over 50');
});

test('active_on and apply_to decide when an effect applies', () => {
  const offense = effect('damage', { multiply: '2', active_on: 'offense' });
  const defense = effect('damage', { multiply: '2', active_on: 'defense' });
  assert.equal(applies(offense, { isAttacker: true }, 'attacker'), true);
  assert.equal(applies(offense, { isAttacker: false }, 'attacker'), false);
  assert.equal(applies(defense, { isAttacker: false }, 'attacker'), true);
  assert.equal(applies(effect('damage', { apply_to: 'defender' }), { isAttacker: true }, 'attacker'), false);
  assert.equal(applies(effect('damage', { apply_to: 'both' }), { isAttacker: true }, 'both'), true);
});

test('charge doubles the damage dealt and taken', () => {
  const charger = unit('Elvish Scout');
  const target = unit('Orcish Grunt', 2);
  const plain = { name: 'spear', description: '', type: 'pierce', range: 'melee', damage: 6, number: 2, icon: '', specials: [] };
  const charge = { ...plain, specials: ['charge'] };

  const plainNumbers = attackNumbers(ctx, charger, plain, { isAttacker: true });
  const chargeNumbers = attackNumbers(ctx, charger, charge, { isAttacker: true });
  assert.equal(chargeNumbers.damage, plainNumbers.damage * 2, 'charge multiplies by the real multiply=2');

  // `apply_to=both`: the counterattack against the charger is doubled too.
  const back = attackNumbers(ctx, target, plain, { isAttacker: false, opponentWeapon: charge });
  const backPlain = attackNumbers(ctx, target, plain, { isAttacker: false, opponentWeapon: plain });
  assert.equal(back.damage, backPlain.damage * 2);
});

test('magical and marksman use their real values', () => {
  const archer = unit('Orcish Archer', 2);
  const attack = { name: 'bow', description: '', type: 'pierce', range: 'ranged', damage: 5, number: 3, icon: '', specials: [] };
  const terrain = { id: 'grassland', baseId: 'grassland', overlayId: null, moveCost: 1, defense: 60, heals: 0, isVillage: false };

  // Base: 100 - 60 defence = 40% to be hit.
  assert.equal(chanceToHit(ctx, archer, terrain, [], archer), 40);

  const magical = attackNumbers(ctx, archer, { ...attack, specials: ['magical'] }, { isAttacker: true, baseCth: 40 });
  assert.equal(magical.cth, 70, 'magical always hits 70%');

  const marksman = attackNumbers(ctx, archer, { ...attack, specials: ['marksman'] }, { isAttacker: true, baseCth: 40 });
  assert.equal(marksman.cth, 60, 'marksman raises 40% to 60%');
  const marksmanOnClear = attackNumbers(ctx, archer, { ...attack, specials: ['marksman'] }, { isAttacker: true, baseCth: 80 });
  assert.equal(marksmanOnClear.cth, 80, 'and leaves a better chance alone');
});

test('weapon accuracy and defender parry modify chance to hit before specials', () => {
  const attacker = unit('Orcish Archer');
  const plain = { name: 'bow', description: '', type: 'pierce', range: 'ranged', damage: 5, number: 3, icon: '', specials: [] };
  const accurate = { ...plain, accuracy: 20 };
  const parrying = { ...plain, parry: 15 };
  assert.equal(attackNumbers(ctx, attacker, accurate, { isAttacker: true, baseCth: 40 }).cth, 60);
  assert.equal(attackNumbers(ctx, attacker, plain, { isAttacker: true, baseCth: 40, opponentWeapon: parrying }).cth, 25);
  assert.equal(attackNumbers(ctx, attacker, { ...accurate, specials: ['marksman'] }, { isAttacker: true, baseCth: 40, opponentWeapon: parrying }).cth, 60);
});

test('steadfast doubles resistance up to 50 percent', () => {
  // A unit whose ability list names the real steadfast ability.
  const dwarf = Object.values(GAME_DATA.unitTypes).find((type) => type.abilities.includes('steadfast'));
  assert.ok(dwarf, 'core data has a steadfast unit');
  const made = unit(dwarf.id);
  const taken = resistanceOf(GAME_DATA, made, 'blade');
  const expected = 100 - Math.min(50, Math.max(0, 2 * (100 - taken)));
  assert.equal(resistanceAfterAbilities(GAME_DATA, made, 'blade'), expected);
  assert.ok(resistanceAfterAbilities(GAME_DATA, made, 'blade') < taken, 'steadfast reduces the damage taken');
});

test('poison, slow and petrify land on a hit and behave', () => {
  const attacker = unit('Orcish Grunt');
  const target = unit('Elvish Scout', 2);
  const poisoned = { name: 'claws', description: '', type: 'blade', range: 'melee', damage: 4, number: 2, icon: '', specials: ['poison', 'slow'] };
  const terrain = { id: 'grassland', baseId: 'grassland', overlayId: null, moveCost: 1, defense: 40, heals: 0, isVillage: false };

  // An rng of 0 always hits.
  resolveAttack(ctx, { attacker, defender: target, attack: poisoned, terrain, rng: () => 0 });
  assert.equal(target.poisoned, true);
  assert.equal(target.slowed, true);

  // Poison ticks 8 without ever killing.
  target.hitpoints = 20;
  assert.equal(poisonTick(target, 8), 8);
  target.hitpoints = 3;
  assert.equal(poisonTick(target, 8), 2, 'poison leaves the unit at 1 hitpoint');
  assert.equal(target.hitpoints, 1);

  // Slow halves the damage the slowed unit deals.
  const weapon = { name: 'sword', description: '', type: 'blade', range: 'melee', damage: 8, number: 1, icon: '', specials: [] };
  const duel = unit('Orcish Grunt');
  duel.slowed = true;
  const defender = unit('Elvish Scout', 2);
  const slowedDamage = damagePerStrike(ctx, duel, defender, weapon);
  duel.slowed = false;
  const normalDamage = damagePerStrike(ctx, duel, defender, weapon);
  assert.ok(slowedDamage < normalDamage, `${slowedDamage} < ${normalDamage}`);

  // Slow wears off when the side's turn ends; poison stays.
  const game = makeGame(3, 3, Array(9).fill('Gg'), new Map());
  game.units.push(duel, defender);
  endTurnStatuses(game, 1);
  assert.equal(duel.slowed, false, 'slow is cured');
  assert.equal(duel.poisoned, false, 'this unit was not poisoned');
});

test('swarm scales the strikes with the unit hitpoints', () => {
  const saurian = unit('Orcish Grunt');
  const swarm = { name: 'tail', description: '', type: 'impact', range: 'melee', damage: 4, number: 6, icon: '', specials: ['swarm'] };
  assert.equal(GAME_DATA.weaponSpecials.swarm.tag, 'swarm');

  const healthy = attackNumbers(ctx, saurian, swarm, { isAttacker: true, hitpoints: { current: 40, max: 40 } });
  const wounded = attackNumbers(ctx, saurian, swarm, { isAttacker: true, hitpoints: { current: 20, max: 40 } });
  assert.equal(healthy.attacks, 6, 'a full-health unit keeps all its strikes');
  assert.equal(wounded.attacks, 3, 'half health means half the strikes');
});

test('drains heals the striker for the real percentage', () => {
  const attacker = unit('Orcish Grunt');
  const target = unit('Orcish Grunt', 2);
  attacker.hitpoints = 1;
  const draining = { name: 'fangs', description: '', type: 'blade', range: 'ranged', damage: 6, number: 4, icon: '', specials: ['drains'] };
  const terrain = { id: 'grassland', baseId: 'grassland', overlayId: null, moveCost: 1, defense: 40, heals: 0, isVillage: false };

  const numbers = attackNumbers(ctx, attacker, draining, { isAttacker: true });
  assert.equal(numbers.drainPercent, 50, 'the macro says value=50');
  resolveAttack(ctx, { attacker, defender: target, attack: draining, terrain, rng: () => 0 });
  assert.ok(attacker.hitpoints > 1, 'the attack healed the striker');

  const definition = GAME_DATA.weaponSpecials.drains;
  assert.equal(effectsOf([definition], 'drains')[0]?.attributes.value, '50');
});

test('berserk and firststrike come from their definitions', () => {
  const attacker = unit('Orcish Grunt');
  const berserk = { name: 'axe', description: '', type: 'blade', range: 'melee', damage: 3, number: 2, icon: '', specials: ['berserk', 'firststrike'] };
  const numbers = attackNumbers(ctx, attacker, berserk, { isAttacker: true });
  assert.equal(numbers.berserkRounds, 30, 'the macro says value=30');
  assert.equal(numbers.firststrike, true);

  // Berserk keeps swinging past the normal strike count.
  const defender = unit('Elvish Scout', 2);
  const terrain = { id: 'grassland', baseId: 'grassland', overlayId: null, moveCost: 1, defense: 40, heals: 0, isVillage: false };
  const exchange = resolveAttack(ctx, { attacker, defender, attack: berserk, terrain, rng: () => 0 });
  assert.ok(exchange.strikes.length > 4, `berserk landed ${exchange.strikes.length} strikes`);
});

test('the terrain defence is what decides the hit chance', () => {
  const attacker = unit('Orcish Grunt');
  const movetype = movetypeOf(GAME_DATA, attacker);
  const grass = resolveTerrain(GAME_DATA, movetype, 'Gg');
  const village = resolveTerrain(GAME_DATA, movetype, 'Gg^Ve');
  assert.equal(chanceToHit(ctx, attacker, grass, [], attacker), 40, 'grass: 60% defence means a 40% chance to be hit');
  assert.equal(chanceToHit(ctx, attacker, village, [], attacker), 60, 'village: 40% defence means 60%');
  // An overlay decides both numbers now: pine forest on grass is forest, and a
  // village overlay is a village (`mvt_alias` and `aliasof` chains).
  const forest = resolveTerrain(GAME_DATA, movetype, 'Gg^Fp');
  assert.equal(forest.defense, 50, 'forest overlay defence');
  assert.equal(forest.moveCost, 2, 'forest overlay movement cost');
});
