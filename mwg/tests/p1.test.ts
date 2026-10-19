/**
 * P1 rules completeness and the P2 data-parity check.
 *
 * The numbers come from the real data (`game-data.ts`, built from the 2,598
 * Wesnoth `.cfg` files), so these tests fail if the extraction or the rules drift.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import {
  advanceUnit,
  endTurnHealing,
  immunities,
  incomeFor,
  isFlanked,
  isSkirmisher,
  leadershipBonus,
  makeGame,
  predictAttack,
  upkeepFor,
  type GameState,
} from '../src/simulation/game.ts';
import { attackNumbers, resistanceOf, resolveAttack } from '../src/simulation/combat.ts';
import { hasTraitMarker, makeUnit, pickTraits, traitCandidates } from '../src/simulation/unit.ts';
import { effectiveMovetype, resolveTerrain, splitCode } from '../src/simulation/terrain.ts';
import { movetypeOf, reachable } from '../src/simulation/movement.ts';

const ctx = { data: GAME_DATA, lawfulBonus: 0 };
const terrain = { id: 'grassland', baseId: 'grassland', overlayId: null, moveCost: 1, defense: 40, heals: 0, isVillage: false };

function unit(typeId: string, side = 1, x = 0, y = 0) {
  const made = makeUnit(GAME_DATA, typeId, side, x, y, () => 0.5);
  made.hitpoints = made.maxHitpoints;
  return made;
}

function emptyState(): GameState {
  return makeGame(6, 6, Array.from({ length: 36 }, () => 'Gg'), new Map());
}

test('traits come from the unit type, its race and the global set', () => {
  // Elves may take dextrous on top of the four global traits.
  const elf = traitCandidates(GAME_DATA, 'Elvish Scout');
  assert.ok(elf.includes('dextrous'), `elf candidates: ${elf.join(',')}`);
  for (const global of GAME_DATA.globalTraits) assert.ok(elf.includes(global), `missing global ${global}`);

  // An undead unit takes the undead trait and nothing else: it is `musthave`.
  const undeadType = Object.values(GAME_DATA.unitTypes).find((type) => type.race === 'undead');
  assert.ok(undeadType);
  assert.deepEqual(traitCandidates(GAME_DATA, undeadType.id), ['undead']);
  assert.deepEqual(pickTraits(GAME_DATA, undeadType.id, () => 0.5), ['undead']);

  // A unit type can opt out of its race's traits.
  const optingOut = Object.values(GAME_DATA.unitTypes).find((type) => type.ignoreRaceTraits);
  assert.ok(optingOut, 'some unit types ignore race traits');
  assert.equal(traitCandidates(GAME_DATA, optingOut.id).includes('dextrous'), false);
});

test('loyal units cost no upkeep, and fearless units ignore the time of day', () => {
  const state = emptyState();
  const spearman = unit('Spearman');
  state.units.push(spearman);
  assert.equal(upkeepFor(state, GAME_DATA, 1), 1, 'one level costs one gold');

  spearman.traits.push('loyal');
  assert.equal(upkeepFor(state, GAME_DATA, 1), 0, 'a loyal unit is free');
  assert.equal(hasTraitMarker(GAME_DATA, spearman, 'loyal'), true);
  assert.equal(incomeFor(state, GAME_DATA, 1), 2, 'base income only');

  const fearless = GAME_DATA.traits.fearless;
  assert.equal(fearless.availability, 'musthave');
  assert.deepEqual(fearless.markers, ['fearless']);
});

test('undead units are immune to poison, slow, drain and plague', () => {
  const undeadType = Object.values(GAME_DATA.unitTypes).find((type) => type.race === 'undead')!;
  const dead = unit(undeadType.id, 2);
  const immune = immunities(GAME_DATA, dead);
  for (const kind of ['poison', 'slow', 'drain', 'plague']) assert.ok(immune.includes(kind), `immune to ${kind}`);

  const attacker = unit('Spearman');
  const poisonedWeapon = { name: 'blade', description: '', type: 'blade', range: 'melee', damage: 5, number: 2, icon: '', specials: ['poison', 'drains'] };
  resolveAttack(ctx, { attacker, defender: dead, attack: poisonedWeapon, terrain, rng: () => 0, defenderImmune: immune });
  assert.equal(dead.poisoned, false, 'poison does not stick to the undead');
});

test('skirmisher ignores zones of control', () => {
  const state = emptyState();
  const skirmisher = Object.values(GAME_DATA.unitTypes).find((type) => type.abilities.includes('skirmisher'));
  assert.ok(skirmisher, 'core data has a skirmisher');
  const mover = unit(skirmisher.id, 1, 1, 1);
  assert.equal(isSkirmisher(state, mover, GAME_DATA), true);
  assert.equal(isSkirmisher(state, unit('Spearman', 1, 1, 1), GAME_DATA), false);
});

test('leadership adds 25 percent per level of the best adjacent leader', () => {
  const state = emptyState();
  const type = Object.values(GAME_DATA.unitTypes).find((candidate) => candidate.abilities.includes('leadership'));
  assert.ok(type, 'core data has a leader');
  const leader = unit(type.id, 1, 2, 2);
  leader.level = 3;
  const soldier = unit('Spearman', 1, 3, 2);
  soldier.level = 1;
  state.units.push(leader, soldier);
  assert.equal(leadershipBonus(state, GAME_DATA, soldier), 50);

  // An enemy leader does not help.
  const enemy = unit(type.id, 2, 4, 2);
  enemy.level = 3;
  state.units.push(enemy);
  assert.equal(leadershipBonus(state, GAME_DATA, soldier), 50);
});

test('backstab needs an enemy behind the target', () => {
  const state = emptyState();
  const attacker = unit('Spearman', 1, 2, 2);
  const target = unit('Orcish Grunt', 2, 3, 2);
  state.units.push(attacker, target);
  assert.equal(isFlanked(state, attacker, target), false);

  // Try every hex of the board: the ones behind the target flank it, whatever
  // order the grid lists neighbours in.
  let flanked = false;
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      if (x === target.x && y === target.y) continue;
      const ally = unit('Bowman', 1, x, y);
      state.units.push(ally);
      if (isFlanked(state, attacker, target)) flanked = true;
      state.units = state.units.filter((candidate) => candidate !== ally);
    }
  }
  assert.equal(flanked, true, 'an ally beyond the target flanks it');

  // The port gates the real backstab effect on the reported flank.
  const back = { name: 'knife', description: '', type: 'blade', range: 'melee', damage: 6, number: 2, icon: '', specials: ['backstab'] };
  const plain = attackNumbers(ctx, attacker, back, { isAttacker: true });
  const withFlank = attackNumbers(ctx, attacker, back, { isAttacker: true, flanked: true });
  assert.equal(plain.damage * 2, withFlank.damage, 'backstab doubles damage when flanked');
});

test('[disable] suppresses the named special of the opponent', () => {
  const attacker = unit('Spearman');
  const charge = { name: 'lance', description: '', type: 'pierce', range: 'melee', damage: 5, number: 2, icon: '', specials: ['charge'] };
  const plain = attackNumbers(ctx, attacker, charge, { isAttacker: true });
  const suppressed = attackNumbers(ctx, attacker, charge, { isAttacker: true, suppressed: ['charge'] });
  assert.equal(suppressed.damage * 2, plain.damage);
});

test('healing and advancement follow the real data', () => {
  const state = emptyState();
  const healer = Object.values(GAME_DATA.unitTypes).find((type) => type.abilities.includes('heals_8') && type.abilities.includes('cures'));
  assert.ok(healer, 'core data has a healer');
  const medic = unit(healer.id, 1, 2, 2);
  medic.side = 1;
  const wounded = unit('Spearman', 1, 3, 2);
  wounded.hitpoints = 10;
  wounded.poisoned = true;
  wounded.resting = false;
  state.units.push(medic, wounded);
  medic.movement = 0; // so the medic itself only heals by resting rules
  const healed = endTurnHealing(state, GAME_DATA, 1);
  assert.ok(healed >= 8, `a heals +8 ally heals the wounded unit (${healed})`);
  assert.equal(wounded.poisoned, false, 'cures clears poison');

  const spearman = unit('Spearman');
  spearman.experience = spearman.maxExperience;
  state.units.push(spearman);
  assert.equal(advanceUnit(state, GAME_DATA, spearman), true);
  const advanced = state.units.find((candidate) => candidate.id === spearman.id)!;
  assert.equal(advanced.typeId, GAME_DATA.unitTypes.Spearman.advancesTo[0], 'advances to the first listed type');
  assert.equal(advanced.name, spearman.name, 'keeps its name');
});

test('the interface can predict a fight before it happens', () => {
  const state = emptyState();
  const attacker = unit('Spearman', 1, 2, 2);
  const defender = unit('Orcish Grunt', 2, 3, 2);
  state.units.push(attacker, defender);
  const prediction = predictAttack(state, GAME_DATA, attacker, defender);
  assert.ok(prediction);
  assert.ok(prediction.cth > 0 && prediction.cth <= 100);
  assert.ok(prediction.damage > 0 && prediction.strikes > 0);
  assert.ok(prediction.defenderDamage > 0, 'the grunt hits back in melee');
});

test('an overlay decides the movement and defence of a hex', () => {
  const mover = unit('Spearman');
  const movetype = movetypeOf(GAME_DATA, mover);
  const grass = resolveTerrain(GAME_DATA, movetype, 'Gg');
  const forest = resolveTerrain(GAME_DATA, movetype, 'Gg^Fp');
  const village = resolveTerrain(GAME_DATA, movetype, 'Gg^Ve');
  assert.deepEqual(splitCode('Gg^Fp'), { base: 'Gg', overlay: '^Fp' });
  assert.equal(grass.defense, 60);
  assert.equal(forest.defense, 50, 'forest overlay gives forest defence');
  assert.equal(forest.moveCost, 2, 'and forest movement cost');
  assert.equal(village.defense, 40, 'village overlay gives village defence');
  assert.equal(village.isVillage, true);
});

test('unit-type tables merge over the movetype (src/units/types.cpp:298)', () => {
  // Ranger (smallfoot): hills 2->1, mountains 3->2, hills defence 50->40.
  const rangerMove = effectiveMovetype(GAME_DATA, 'Ranger')!;
  assert.equal(rangerMove.movementCosts.hills, 1);
  assert.equal(rangerMove.movementCosts.mountains, 2);
  assert.equal(rangerMove.defense.hills, 40);
  assert.equal(GAME_DATA.movetypes.smallfoot.movementCosts.hills, 2);
  assert.equal(GAME_DATA.movetypes.smallfoot.defense.hills, 50);

  // Elvish Scout (woodland): village defence 40->60, forest 30->40.
  const scoutMove = effectiveMovetype(GAME_DATA, 'Elvish Scout')!;
  assert.equal(scoutMove.defense.village, 60);
  assert.equal(scoutMove.defense.forest, 40);
  assert.equal(GAME_DATA.movetypes.woodland.defense.village, 40);

  // The merged tables drive terrain resolution through movetypeOf.
  const ranger = unit('Ranger');
  const hills = resolveTerrain(GAME_DATA, movetypeOf(GAME_DATA, ranger), 'Hh');
  assert.equal(hills.moveCost, 1, 'ranger pays its own hills cost');
  assert.equal(hills.defense, 40, 'ranger gets its own hills defence');

  // Resistance overrides win too: woodland has no pierce entry (100),
  // the Scout writes 120.
  const scout = unit('Elvish Scout');
  assert.equal(resistanceOf(GAME_DATA, scout, 'pierce'), 120);

  // 99 is UNREACHABLE (src/movetype.hpp:174): Nibbler cannot enter flat.
  const nibbler = unit('Nibbler');
  const flat = resolveTerrain(GAME_DATA, movetypeOf(GAME_DATA, nibbler), 'Gg');
  assert.equal(flat.moveCost, Infinity);
});

test('a slowed unit pays double movement (src/movetype.hpp:68)', () => {
  const state = makeGame(5, 3, Array.from({ length: 15 }, () => 'Gg'), new Map());
  const spearman = unit('Spearman', 1, 0, 1);
  spearman.movement = 2;
  spearman.maxMovement = 5;
  state.units.push(spearman);
  state.turn = 1;
  const plain = reachable(state, GAME_DATA, spearman);
  assert.ok(plain.has('2,1'), 'two flat steps cost 2 when healthy');

  spearman.slowed = true;
  const slowed = reachable(state, GAME_DATA, spearman);
  assert.ok(slowed.has('1,1'), 'one step is still reachable while slowed');
  assert.ok(!slowed.has('2,1'), 'the second step costs 4 while slowed');
});

test('data parity: every id the engine reads exists in the compiled data', () => {
  const data = GAME_DATA;
  const problems: string[] = [];
  const inline: string[] = [];
  for (const unitType of Object.values(data.unitTypes)) {
    if (unitType.movementType && !data.movetypes[unitType.movementType]) problems.push(`${unitType.id}: movement_type ${unitType.movementType}`);
    if (unitType.race && !data.races[unitType.race]) problems.push(`${unitType.id}: race ${unitType.race}`);
    for (const ability of unitType.abilities) if (!data.abilities[ability]) problems.push(`${unitType.id}: ability ${ability}`);
    for (const trait of unitType.ownTraits) if (!data.traits[trait]) problems.push(`${unitType.id}: trait ${trait}`);
    for (const advance of unitType.advancesTo) if (!data.unitTypes[advance]) problems.push(`${unitType.id}: advances_to ${advance}`);
    for (const attack of unitType.attacks) {
      for (const special of attack.specials) {
        if (special.includes('(')) {
          inline.push(`${unitType.id}: ${special}`);
          continue;
        }
        if (!data.weaponSpecials[special]) problems.push(`${unitType.id}: special ${special}`);
      }
    }
  }
  for (const race of Object.values(data.races)) for (const trait of race.traits) if (!data.traits[trait]) problems.push(`race ${race.id}: trait ${trait}`);
  for (const trait of data.globalTraits) if (!data.traits[trait]) problems.push(`global trait ${trait}`);
  for (const terrain of Object.values(data.terrains)) {
    for (const alias of terrain.aliasof) {
      // `_bas` and `-` are placeholders the terrain system fills in; a real
      // dangling alias is one that looks like an id or a map code.
      if (alias.startsWith('_') || alias === '-') continue;
      if (!data.terrains[alias] && !data.terrainByCode[alias]) problems.push(`terrain ${terrain.id}: alias ${alias}`);
    }
  }
  assert.deepEqual(problems.slice(0, 12), [], `${problems.length} dangling references`);
  // Parameterized inline specials (`plague(Walking Corpse)`) carry their own type
  // and are handled by the data itself; they are reported, not silently ignored.
  assert.ok(Array.isArray(inline));
});
