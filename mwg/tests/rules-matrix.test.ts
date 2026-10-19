import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeGame, attackWithRules, advanceUnitChoice, illuminatedNear, advancementOptions, type GameState } from '../src/simulation/game.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';
import type { AttackDef } from '../src/simulation/types.ts';

/**
 * The rules edge-case matrix (ROADMAP backlog: "Full rules edge-case matrix").
 *
 * Each case is a rule *interaction* rather than one formula: the ordering and
 * side effects that only show up when two rules meet. The expectations are the
 * engine's, with the source cited where the behaviour is subtle, and every case
 * runs through `attackWithRules`, the same entry point the scene and the AI use.
 */

function field(width = 5, height = 3): GameState {
  const state = makeGame(width, height, Array.from({ length: width * height }, () => 'Gg'), new Map([[1, [{ x: 0, y: 0 }]], [2, [{ x: width - 1, y: 0 }]]]));
  state.sides = [1, 2];
  state.turn = 1;
  return state;
}

function unit(state: GameState, typeId: string, side: number, x: number, y: number): Unit {
  const made = makeUnit(GAME_DATA, typeId, side, x, y, () => 0.5);
  made.hitpoints = made.maxHitpoints;
  made.movement = made.maxMovement;
  state.units.push(made);
  return made;
}

function weapon(overrides: Partial<AttackDef> = {}): AttackDef {
  return { name: 'test-blade', description: '', type: 'blade', range: 'melee', damage: 5, number: 2, icon: '', specials: [], ...overrides };
}

test('petrify stops the fight and the defender cannot retaliate', () => {
  const state = field();
  const attacker = unit(state, 'Orcish Grunt', 1, 1, 1);
  const defender = unit(state, 'Bowman', 2, 2, 1);
  // `attackWithRules` reads the weapon from the unit's own list, so the case
  // gives the attacker a real attack carrying the special.
  attacker.attacks = [{ ...weapon({ name: 'gaze', damage: 3, number: 3, specials: ['petrifies'] }) }];

  const outcome = attackWithRules(state, GAME_DATA, attacker, defender, 'gaze', () => 0);
  assert.equal(defender.petrified, true, 'the defender is petrified');
  assert.equal(outcome.exchange.strikes.length, 1, 'one strike landed and the fight stopped');
  assert.equal(outcome.exchange.strikes[0].attacker, attacker.id);
  assert.deepEqual(
    outcome.exchange.strikes.filter((strike) => strike.attacker === defender.id),
    [],
    'a petrified defender never retaliates',
  );
});

test('plague raises a fresh unit that cannot act this turn', () => {
  // `src/actions/attack.cpp:1184-1204`: the plague unit appears on the victim's
  // hex, on the killer's side, with no attacks and no movement left.
  const state = field();
  const attacker = unit(state, 'Orcish Grunt', 1, 1, 1);
  const defender = unit(state, 'Bowman', 2, 2, 1);
  defender.hitpoints = 1;
  attacker.attacks = [weapon({ name: 'touch', damage: 10, number: 1, specials: ['plague'] })];
  const before = state.units.length;

  const outcome = attackWithRules(state, GAME_DATA, attacker, defender, 'touch', () => 0);
  assert.equal(defender.hitpoints <= 0, true, 'the victim died');
  assert.equal(state.units.length, before, 'the victim left the map, the spawned unit took its place');
  const raised = state.units.find((candidate) => candidate.typeId === (outcome.plagueSpawn?.typeId ?? ''));
  assert.ok(raised, 'a plague unit was raised');
  assert.equal(raised!.side, attacker.side);
  assert.equal(raised!.x, 2);
  assert.equal(raised!.y, 1);
  assert.equal(raised!.movement, 0, 'it cannot act in the turn that raised it');
});

test('drain heals the striker by the real percentage, capped at its maximum', () => {
  const state = field();
  const bat = unit(state, 'Vampire Bat', 1, 1, 1);
  const victim = unit(state, 'Bowman', 2, 2, 1);
  bat.attacks = [weapon({ name: 'fangs', damage: 6, number: 1, specials: ['drains'] })];
  const drained = bat.attacks[0];
  const expected = Math.floor(drained.damage * 50 / 100);

  bat.hitpoints = bat.maxHitpoints - 5;
  const start = bat.hitpoints;
  const outcome = attackWithRules(state, GAME_DATA, bat, victim, 'fangs', () => 0);
  const received = outcome.exchange.strikes
    .filter((strike) => strike.defender === bat.id)
    .reduce((total, strike) => total + strike.damage, 0);
  assert.equal(bat.hitpoints, start + expected - received, 'drain heals half the damage dealt, retaliation still hurts');

  // Healing never exceeds the maximum.
  victim.attacks = [];
  bat.hitpoints = bat.maxHitpoints - 1;
  victim.hitpoints = victim.maxHitpoints;
  attackWithRules(state, GAME_DATA, bat, victim, 'fangs', () => 0);
  assert.equal(bat.hitpoints, bat.maxHitpoints);
});

test('feeding raises the killer maximum hitpoints by one', () => {
  // `data/lua/feeding.lua`: the killer gains a point of maximum hitpoints.
  const state = field();
  const ghoul = unit(state, 'Orcish Grunt', 1, 1, 1);
  const victim = unit(state, 'Bowman', 2, 2, 1);
  victim.hitpoints = 1;
  ghoul.extraAbilities = ['feeding'];
  ghoul.attacks = [weapon({ name: 'bite', damage: 10, number: 1 })];
  const before = ghoul.maxHitpoints;

  attackWithRules(state, GAME_DATA, ghoul, victim, 'bite', () => 0);
  assert.equal(ghoul.maxHitpoints, before + 1);
  assert.equal(ghoul.hitpoints <= ghoul.maxHitpoints, true);
});

test('firststrike lets the defender swing first', () => {
  const state = field();
  const attacker = unit(state, 'Orcish Grunt', 1, 1, 1);
  const defender = unit(state, 'Bowman', 2, 2, 1);
  attacker.attacks = [weapon({ name: 'axe', damage: 5, number: 1 })];
  defender.attacks = [weapon({ name: 'bow', range: 'ranged', damage: 4, number: 1, specials: ['firststrike'] })];

  // The attacker's weapon is melee, so the defender cannot retaliate with a
  // ranged one: give the defender a firststrike melee weapon too.
  defender.attacks = [weapon({ name: 'blade', damage: 4, number: 1, specials: ['firststrike'] })];
  const outcome = attackWithRules(state, GAME_DATA, attacker, defender, 'axe', () => 0);
  assert.deepEqual(outcome.exchange.strikes.map((strike) => strike.attacker), [defender.id, attacker.id]);
});

test('illumination lights every unit beside the illuminator', () => {
  // `{ABILITY_ILLUMINATES}` compiles to the `illumination` ability
  // (`data/core/macros/abilities.cfg:237-248`, id=illumination, value=25);
  // `Mage of Light` is one of the two core units that carries it.
  const state = field();
  const light = unit(state, 'Mage of Light', 1, 1, 1);
  const sergeant = unit(state, 'Spearman', 1, 2, 1);
  assert.ok(GAME_DATA.unitTypes['Mage of Light'].abilities.includes('illumination'));
  assert.equal(illuminatedNear(state, GAME_DATA, sergeant), true, 'the neighbour is lit');
  assert.equal(illuminatedNear(state, GAME_DATA, light), false, 'an illuminator does not light itself');
  state.units = [sergeant];
  assert.equal(illuminatedNear(state, GAME_DATA, sergeant), false, 'with no illuminator nearby there is no bonus');
});

test('a level-up award is eight per level, and both survivors can advance', () => {
  const state = field();
  const attacker = unit(state, 'Orcish Grunt', 1, 1, 1);
  const defender = unit(state, 'Bowman', 2, 2, 1);
  defender.hitpoints = 1;
  const victimLevel = defender.level;

  const outcome = attackWithRules(state, GAME_DATA, attacker, defender, attacker.attacks[0].name, () => 0);
  assert.equal(outcome.xpAwarded.attacker, 1 + 8 * victimLevel, 'a kill awards combat XP plus kill XP');

  // An AMLA pick heals, cures and raises both caps (`AMLA_DEFAULT`).
  const veteran = unit(state, 'Orcish Grunt', 1, 3, 2);
  veteran.experience = veteran.maxExperience;
  veteran.poisoned = true;
  veteran.slowed = true;
  veteran.hitpoints = 3;
  const maxHp = veteran.maxHitpoints;
  const maxXp = veteran.maxExperience;
  assert.ok(advancementOptions(GAME_DATA, veteran).some((option) => option.id === 'amla_default'));
  assert.equal(advanceUnitChoice(state, GAME_DATA, veteran, 'amla_default'), true);
  assert.equal(veteran.maxHitpoints, maxHp + 3);
  // `utils::apply_modifier` rounds the percentage (`src/serialization/string_utils.cpp:414-428`).
  assert.equal(veteran.maxExperience, maxXp + Math.round(maxXp * 0.2));
  assert.equal(veteran.hitpoints, veteran.maxHitpoints, 'the AMLA heals fully');
  assert.equal(veteran.poisoned, false);
  assert.equal(veteran.slowed, false);
  assert.equal(veteran.experience, 0);
});

test('a mutual kill leaves neither unit on the map', () => {
  const state = field();
  const attacker = unit(state, 'Orcish Grunt', 1, 1, 1);
  const defender = unit(state, 'Bowman', 2, 2, 1);
  // Berserk keeps both swinging until one falls; equal one-hit damage means the
  // firststrike side survives, so give the attacker enough hitpoints to trade.
  attacker.hitpoints = 3;
  defender.hitpoints = 3;
  attacker.attacks = [weapon({ name: 'axe', damage: 3, number: 1, specials: ['berserk'] })];
  defender.attacks = [weapon({ name: 'blade', damage: 3, number: 1 })];

  const outcome = attackWithRules(state, GAME_DATA, attacker, defender, 'axe', () => 0);
  const survivors = state.units.filter((candidate) => candidate.id === attacker.id || candidate.id === defender.id);
  assert.equal(outcome.exchange.attackerKilled || outcome.exchange.defenderKilled, true);
  assert.equal(survivors.length, outcome.exchange.attackerKilled && outcome.exchange.defenderKilled ? 0 : 1);
});
