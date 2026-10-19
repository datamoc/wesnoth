/**
 * P1 vision, hidden abilities, teleport, diversion, feeding, plague and the
 * player-chosen AMLA.
 *
 * Numbers come from the real data (`game-data.ts`); terrain codes are the
 * real map codes (`Ss` swamp, `Wo` deep water, `Gg^Fp` forest overlay).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FactionFog } from 'mwg/board';
import { GAME_DATA } from '../src/generated/game-data.ts';
import {
  advancementOptions,
  advanceUnitChoice,
  attackWithRules,
  isFogged,
  isShrouded,
  makeGame,
  updateVision,
  type GameState,
} from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import { moveUnit, teleportDestinations, teleportUnit } from '../src/simulation/movement.ts';
import { hidesOn, isHidden, visibleEnemies, visibleHexes } from '../src/simulation/vision.ts';

function unit(typeId: string, side = 1, x = 0, y = 0) {
  const made = makeUnit(GAME_DATA, typeId, side, x, y, () => 0.5);
  made.hitpoints = made.maxHitpoints;
  return made;
}

function flatState(w = 7, h = 5): GameState {
  return makeGame(w, h, Array.from({ length: w * h }, () => 'Gg'), new Map());
}

test('shroud clears permanently while fog follows the units', () => {
  // A Spearman sees 5 (its maximum movement); (8,2) is 7 steps from (1,2).
  const state = makeGame(9, 5, Array.from({ length: 45 }, () => 'Gg'), new Map());
  assert.ok(state.fog instanceof FactionFog, 'shroud storage is the framework fog');
  const scout = unit('Spearman', 1, 1, 2);
  state.units.push(scout);
  updateVision(state, GAME_DATA);
  assert.equal(isShrouded(state, 1, 1, 2), false, 'own hex is seen');
  assert.equal(isShrouded(state, 1, 8, 2), true, 'far hex stays shrouded');
  assert.equal(isFogged(state, GAME_DATA, 1, 8, 2), true, 'far hex is fogged');

  // March across the map: everything passed becomes ever-seen...
  scout.x = 6;
  updateVision(state, GAME_DATA);
  assert.equal(isShrouded(state, 1, 8, 2), false, 'shroud cleared around the new post');

  // ...but leaving fogs it again (fog reads the last sync, and every rule
  // that moves units syncs, so fixtures sync by hand after moving).
  scout.x = 0;
  updateVision(state, GAME_DATA);
  assert.equal(isFogged(state, GAME_DATA, 1, 8, 2), true, 'left hex is fogged now');
  assert.equal(isShrouded(state, 1, 8, 2), false, 'but no longer shrouded');
});

test('vision walks costs, so woods see less far than fields', () => {
  // Smallfoot pays 1 on grass and 2 in forest over the same 5 sight range.
  const open = flatState();
  const scout = unit('Spearman', 1, 0, 2);
  open.units.push(scout);
  const openSeen = visibleHexes(open, GAME_DATA, 1);

  const woods = makeGame(7, 5, Array.from({ length: 35 }, () => 'Gg^Fp'), new Map());
  const twin = unit('Spearman', 1, 0, 2);
  woods.units.push(twin);
  const woodSeen = visibleHexes(woods, GAME_DATA, 1);
  assert.ok(woodSeen.size < openSeen.size, `forest (${woodSeen.size}) hides more than grass (${openSeen.size})`);
});

test('ambush hides in forest until an enemy steps next to it', () => {
  const codes = Array.from({ length: 35 }, () => 'Gg^Fp');
  const state = makeGame(7, 5, codes, new Map());
  const ranger = unit('Elvish Ranger', 1, 3, 2);
  const foe = unit('Orcish Grunt', 2, 0, 2);
  state.units.push(ranger, foe);
  assert.equal(hidesOn(state, GAME_DATA, ranger, 0), 'ambush');
  assert.equal(isHidden(state, GAME_DATA, ranger, 2, 0), true, 'unseen in the woods');

  // Discovery ends the discoverer's move.
  foe.movement = 5;
  state.turn = 2;
  const result = moveUnit(state, GAME_DATA, foe, 2, 2);
  assert.equal(result.ok, true);
  assert.equal(foe.movement, 0, 'first sight of the ambusher stops the foe');
  assert.equal(isHidden(state, GAME_DATA, ranger, 2, 0), false, 'adjacent enemies see through it');
});

test('concealment, submerge, swamp_lurk and nightstalk read their own terrain', () => {
  const state = flatState();
  const thief = unit('Fugitive', 1, 1, 1);
  state.units.push(thief);
  assert.equal(hidesOn(state, GAME_DATA, thief, 0), null, 'no village, no hiding');

  const village = makeGame(7, 5, Array.from({ length: 35 }, () => 'Gg^Ve'), new Map());
  const hidden = unit('Fugitive', 1, 1, 1);
  village.units.push(hidden, unit('Orcish Grunt', 2, 5, 1));
  assert.equal(hidesOn(village, GAME_DATA, hidden, 0), 'concealment');
  assert.equal(isHidden(village, GAME_DATA, hidden, 2, 0), true);

  const sea = makeGame(7, 5, Array.from({ length: 35 }, () => 'Wo'), new Map());
  const diver = unit('Chocobone', 1, 1, 1);
  sea.units.push(diver, unit('Orcish Grunt', 2, 5, 1));
  assert.equal(hidesOn(sea, GAME_DATA, diver, 0), 'submerge', 'deep water hides the submerged');

  const swamp = makeGame(7, 5, Array.from({ length: 35 }, () => 'Ss'), new Map());
  const lizard = unit('Swamp Lizard', 1, 1, 1);
  swamp.units.push(lizard, unit('Orcish Grunt', 2, 5, 1));
  assert.equal(hidesOn(swamp, GAME_DATA, lizard, 0), 'swamp_lurk');

  const night = flatState();
  const cat = unit('Jumpcat', 1, 1, 1);
  night.units.push(cat);
  assert.equal(hidesOn(night, GAME_DATA, cat, -25), 'nightstalk', 'chaotic hours hide the nightstalker');
  assert.equal(hidesOn(night, GAME_DATA, cat, 25), null, 'daylight exposes it');
});

test('a hidden unit cannot be targeted, and the AI only sees the visible', () => {
  const codes = Array.from({ length: 35 }, () => 'Gg^Fp');
  const state = makeGame(7, 5, codes, new Map());
  const ranger = unit('Elvish Ranger', 1, 3, 2);
  const foe = unit('Orcish Grunt', 2, 0, 2);
  state.units.push(ranger, foe);
  assert.throws(() => attackWithRules(state, GAME_DATA, foe, ranger, foe.attacks[0].name), /hidden/);
  assert.deepEqual(
    visibleEnemies(state, GAME_DATA, 2, 0).map((enemy) => enemy.id),
    [],
    'side 2 sees no one while the ranger hides',
  );
});

test('allied sides share fog and do not appear as enemies', () => {
  const state = makeGame(7, 5, Array.from({ length: 35 }, () => 'Gg'), new Map(), {
    teams: new Map([[1, 'alliance'], [2, 'alliance'], [3, 'foes']]),
  });
  state.sides = [1, 2, 3];
  const scout = unit('Elvish Fighter', 1, 0, 0);
  const ally = unit('Spearman', 2, 6, 4);
  const foe = unit('Orcish Grunt', 3, 3, 2);
  state.units.push(scout, ally, foe);
  updateVision(state, GAME_DATA);
  assert.equal(isFogged(state, GAME_DATA, 1, 6, 4), false, 'side 1 sees through side 2');
  assert.equal(isShrouded(state, 1, 6, 4), false, 'side 1 explores through side 2');
  assert.deepEqual(visibleEnemies(state, GAME_DATA, 1, 0).map((candidate) => candidate.id), [foe.id]);
  assert.equal(isFogged(state, GAME_DATA, 2, 0, 0), false, 'side 2 sees through side 1');
});

test('teleport steps between the side’s empty villages', () => {
  const codes = Array.from({ length: 25 }, () => 'Gg');
  codes[1 * 5 + 1] = 'Gg^Ve';
  codes[3 * 5 + 3] = 'Gg^Ve';
  const state = makeGame(5, 5, codes, new Map());
  state.villageOwner[1 * 5 + 1] = 1;
  state.villageOwner[3 * 5 + 3] = 1;
  const mage = unit('Silver Mage', 1, 1, 1);
  mage.movement = 5;
  state.units.push(mage);
  state.turn = 1;
  const targets = teleportDestinations(state, GAME_DATA, mage);
  assert.deepEqual(targets, [{ x: 3, y: 3 }], 'the other own village is the destination');
  assert.equal(teleportUnit(state, GAME_DATA, mage, 3, 3).ok, true);
  assert.deepEqual([mage.x, mage.y], [3, 3]);
  assert.equal(mage.movement, 4, 'the step costs one move');

  const walker = unit('Spearman', 1, 1, 1);
  assert.deepEqual(teleportDestinations(state, GAME_DATA, walker), [], 'no gift, no travel');
});

test('diversion cuts the retaliation when the target is flanked', () => {
  const setup = (flanked: boolean): { state: GameState; falconer: ReturnType<typeof unit>; target: ReturnType<typeof unit> } => {
    const state = flatState();
    const falconer = unit('Dune Falconer', 1, 2, 2);
    const target = unit('Orcish Grunt', 2, 3, 2);
    state.units.push(falconer, target);
    // (4,3) is the far-side hex `isFlanked` reports for this approach: the
    // neighbour of the target furthest from the attacker.
    if (flanked) state.units.push(unit('Spearman', 1, 4, 3));
    return { state, falconer, target };
  };
  const sword = GAME_DATA.unitTypes['Dune Falconer'].attacks[0].name;
  const plain = setup(false);
  const diverted = setup(true);
  const plainCth = attackWithRules(plain.state, GAME_DATA, plain.falconer, plain.target, sword, () => 1).exchange.defenderCth;
  const divertedCth = attackWithRules(diverted.state, GAME_DATA, diverted.falconer, diverted.target, sword, () => 1).exchange.defenderCth;
  assert.equal(divertedCth, plainCth - 20, `diversion subtracts 20 (${plainCth} -> ${divertedCth})`);
});

test('feeding grows the killer and plague raises the victim', () => {
  const state = flatState();
  const ghoul = unit('Necrophage', 1, 2, 2);
  const victim = unit('Spearman', 2, 3, 2);
  victim.hitpoints = 1;
  const before = ghoul.maxHitpoints;
  state.units.push(ghoul, victim);
  attackWithRules(state, GAME_DATA, ghoul, victim, ghoul.attacks[0].name, () => 0);
  assert.equal(ghoul.maxHitpoints, before + 1, 'feeding adds one maximum hitpoint');

  const fresh = flatState();
  const necro = unit('Necromancer', 1, 2, 2);
  const doomed = unit('Spearman', 2, 3, 2);
  doomed.hitpoints = 1;
  fresh.units.push(necro, doomed);
  const staff = necro.attacks.find((attack) => attack.name === 'plague staff') ?? necro.attacks[0];
  attackWithRules(fresh, GAME_DATA, necro, doomed, staff.name, () => 0);
  const risen = fresh.units.find((candidate) => candidate.typeId === 'Walking Corpse');
  assert.ok(risen, 'plague replaces the victim with a Walking Corpse');
  assert.equal(risen.side, 1, 'the corpse serves the killer');
});

test('the player chooses the advancement: a path or the default AMLA', () => {
  const state = flatState();
  const spearman = unit('Spearman');
  spearman.experience = spearman.maxExperience;
  state.units.push(spearman);
  const options = advancementOptions(GAME_DATA, spearman);
  assert.ok(options.some((option) => option.id === 'amla_default'), 'the default AMLA is always offered');
  assert.ok(options.some((option) => option.id.startsWith('advance:')), 'every listed path is offered');

  const picked = options.find((option) => option.id.startsWith('advance:'))!;
  assert.equal(advanceUnitChoice(state, GAME_DATA, spearman, picked.id), true);
  const advanced = state.units.find((candidate) => candidate.id === spearman.id)!;
  assert.equal(advanced.typeId, picked.id.slice('advance:'.length));

  const veteran = unit('Spearman');
  veteran.experience = veteran.maxExperience;
  veteran.poisoned = true;
  const hp = veteran.maxHitpoints;
  const xp = veteran.maxExperience;
  state.units.push(veteran);
  assert.equal(advanceUnitChoice(state, GAME_DATA, veteran, 'amla_default'), true);
  assert.equal(veteran.maxHitpoints, hp + 3, 'AMLA_DEFAULT grants +3 max HP');
  assert.equal(veteran.hitpoints, veteran.maxHitpoints, 'and heals to full');
  assert.equal(veteran.poisoned, false, 'and cures');
  assert.ok(veteran.maxExperience > xp, 'with harder-won experience');
  assert.equal(advanceUnitChoice(state, GAME_DATA, veteran, 'amla_default'), false, 'no choice before the bar is full');
});
