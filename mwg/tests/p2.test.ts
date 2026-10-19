/**
 * P2 content completeness: eras and factions, schedules and `[time_area]`,
 * items and `[object]` content, terrain-graphics transition inputs, and the
 * strengthened data parity check.
 *
 * Counts come from the real checkout (`game-data.ts` plus the data files
 * around it), so these tests fail if the extraction or the rules drift.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { activeSchedule, lawfulBonusAt, makeGame, rangeCovers } from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import { applyObject, itemFromWml, objectFromWml, pickupItems } from '../src/simulation/objects.ts';
import { parseTerrainGraphics } from '../src/simulation/terrain-graphics.ts';
import { parseWml, WmlPreprocessor } from '../src/simulation/wml.ts';
import type { TimeAreaDef } from '../src/simulation/types.ts';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');

function unit(typeId: string, side = 1, x = 0, y = 0) {
  const made = makeUnit(GAME_DATA, typeId, side, x, y, () => 0.5);
  made.hitpoints = made.maxHitpoints;
  return made;
}

test('eras: the default era’s factions, leaders and recruits come from data', () => {
  const eras = GAME_DATA.eras ?? {};
  assert.ok(eras.era_default, 'era_default compiled');
  assert.ok(eras.era_heroes, 'era_heroes compiled');
  const ids = eras.era_default.factions.map((faction) => faction.id);
  for (const expected of ['Loyalists', 'Rebels', 'Northerners', 'Undead', 'Knalgan Alliance', 'Drakes', 'Dunefolk']) {
    assert.ok(ids.includes(expected), `default era fields ${expected}`);
  }
  const loyalists = eras.era_default.factions.find((faction) => faction.id === 'Loyalists')!;
  for (const recruit of ['Spearman', 'Bowman', 'Cavalryman']) {
    assert.ok(loyalists.recruit.includes(recruit), `Loyalists recruit ${recruit}`);
    assert.ok(GAME_DATA.unitTypes[recruit], `${recruit} is a known unit type`);
  }
  const northerners = eras.era_default.factions.find((faction) => faction.id === 'Northerners')!;
  for (const recruit of ['Orcish Grunt', 'Orcish Archer', 'Wolf Rider']) {
    assert.ok(northerners.recruit.includes(recruit), `Northerners recruit ${recruit}`);
  }
  // Every faction recruit and leader names a real unit type.
  const problems: string[] = [];
  for (const era of Object.values(eras)) {
    for (const faction of era.factions) {
      if (faction.id === 'Random') continue;
      for (const id of [...faction.recruit, ...faction.leaders]) {
        if (!GAME_DATA.unitTypes[id]) problems.push(`${era.id}/${faction.id}: ${id}`);
      }
    }
  }
  assert.deepEqual(problems.slice(0, 10), [], `${problems.length} era references without a unit type`);
});

test('the skirmish recruit lists are factions from the default era', () => {
  const loyalists = GAME_DATA.eras?.era_default.factions.find((faction) => faction.id === 'Loyalists')!;
  const northerners = GAME_DATA.eras?.era_default.factions.find((faction) => faction.id === 'Northerners')!;
  for (const recruit of ['Spearman', 'Bowman', 'Cavalryman']) assert.ok(loyalists.recruit.includes(recruit));
  for (const recruit of ['Orcish Grunt', 'Orcish Archer', 'Wolf Rider']) assert.ok(northerners.recruit.includes(recruit));
});

test('schedules: every named variant loads with real lawful bonuses', () => {
  const schedules = GAME_DATA.schedules ?? {};
  for (const id of ['default', 'summer', 'winter', 'indoors', 'underground', 'deep_underground']) {
    assert.ok(schedules[id]?.length, `schedule ${id} compiled`);
  }
  assert.deepEqual(
    schedules.default.map((time) => time.id),
    ['dawn', 'morning', 'afternoon', 'dusk', 'first_watch', 'second_watch'],
  );
  const bonus = (id: string, time: string): number => schedules[id].find((entry) => entry.id === time)?.lawfulBonus ?? NaN;
  assert.equal(bonus('default', 'morning'), 25);
  assert.equal(bonus('default', 'first_watch'), -25);
  assert.equal(bonus('underground', 'underground'), -25);
  assert.equal(bonus('deep_underground', 'deep_underground'), -30, 'deep mines favour chaos more');

  // The state selects its schedule by id; unknown ids fall back to default.
  const state = makeGame(3, 3, Array.from({ length: 9 }, () => 'Gg'), new Map(), { scheduleId: 'underground' });
  assert.equal(activeSchedule(GAME_DATA, state)[state.scheduleIndex]?.lawfulBonus, -25);
  state.scheduleId = 'no-such-schedule';
  assert.equal(activeSchedule(GAME_DATA, state), GAME_DATA.schedule);
});

test('[time_area] overrides the schedule on its own hexes', () => {
  const area: TimeAreaDef = {
    id: 'cave',
    xs: '1-2',
    ys: '1-3',
    times: [{ id: 'underground', lawfulBonus: -25, name: 'Underground' }],
  };
  const state = makeGame(5, 3, Array.from({ length: 15 }, () => 'Gg'), new Map(), { timeAreas: [area] });
  assert.equal(lawfulBonusAt(GAME_DATA, state, 0, 0), -25, 'inside the area');
  assert.equal(lawfulBonusAt(GAME_DATA, state, 4, 2), GAME_DATA.schedule[state.scheduleIndex]?.lawfulBonus ?? 0, 'outside it');
  assert.equal(rangeCovers('1-5,8', 0), true);
  assert.equal(rangeCovers('1-5,8', 5), false);
  assert.equal(rangeCovers('1-5,8', 7), true, 'ranges are 1-based like WML');
});

test('[object] gifts apply numbers, cures, heals and abilities', () => {
  const spearman = unit('Spearman');
  spearman.hitpoints = 10;
  spearman.poisoned = true;
  applyObject(GAME_DATA, spearman, {
    id: 'sword',
    effects: [
      { applyTo: 'attack', range: 'melee', increaseDamage: 2 },
      { applyTo: 'hitpoints', increaseTotal: 4 },
      { applyTo: 'status', remove: 'poisoned' },
    ],
    abilities: [],
  });
  const sword = spearman.attacks.find((attack) => attack.range === 'melee')!;
  assert.ok(sword.damage >= 9, `melee sharpened to ${sword.damage}`);
  assert.equal(spearman.poisoned, false, 'object cures poison');

  const healer = unit('Elvish Shaman');
  assert.ok(!healer.extraAbilities.includes('heals_8'));
  applyObject(GAME_DATA, healer, { id: 'amulet', effects: [], abilities: ['heals_8', 'no-such-ability'] });
  assert.deepEqual(healer.extraAbilities, ['heals_8'], 'known gifts attach, unknown ones do not');
});

test('[item] nodes parse with their inline [object], and pick up once', () => {
  const nodes = parseWml(
    `[item]
    x=3
    y=2
    image=items/sword.png
    [object]
        id=sword
        [effect]
            apply_to=attack
            range=melee
            increase_damage=2
        [/effect]
    [/object]
[/item]`,
    '<item>',
  );
  const item = itemFromWml(nodes[0])!;
  assert.deepEqual([item.x, item.y], [2, 1], 'WML coordinates are 1-based');
  assert.equal(item.object.id, 'sword');

  const state = makeGame(5, 5, Array.from({ length: 25 }, () => 'Gg'), new Map(), { items: [item] });
  const spearman = unit('Spearman', 1, 2, 1);
  const before = spearman.attacks.find((attack) => attack.range === 'melee')!.damage;
  state.units.push(spearman);
  assert.deepEqual(pickupItems(GAME_DATA, spearman, state.items), ['sword']);
  assert.ok(spearman.attacks.find((attack) => attack.range === 'melee')!.damage > before);
  assert.equal(item.taken, true);
  assert.deepEqual(pickupItems(GAME_DATA, spearman, state.items), [], 'a taken item stays taken');
});

test('an [object] node keeps exactly what the rules run', () => {
  const nodes = parseWml(
    `[object]
    id=gift
    [effect]
        apply_to=hitpoints
        increase_total=4
        heal_full=yes
    [/effect]
    [effect]
        apply_to=defense
        increase=10
    [/effect]
[/object]`,
    '<object>',
  );
  const object = objectFromWml(nodes[0])!;
  assert.equal(object.effects.length, 1, 'defense effects are not modeled, so they are dropped');
  assert.equal(object.effects[0].healFull, true);
});

test('terrain-graphics: all 30 rule files parse into a transition model', () => {
  const dir = path.join(dataDir, 'core', 'terrain-graphics');
  const files = readdirSync(dir).filter((name) => name.endsWith('.cfg')).sort();
  assert.equal(files.length, 30, `30 rule files, saw ${files.length}`);
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  wml.loadMacros(files.map((name) => path.join(dir, name)));
  const nodes = files.flatMap((name) => parseWml(wml.preprocessFile(path.join(dir, name)), path.join(dir, name)));
  nodes.push(...parseWml(wml.preprocessFile(path.join(dataDir, 'core', 'terrain-graphics.cfg')), 'terrain-graphics.cfg'));
  const rules = parseTerrainGraphics(nodes, 'terrain-graphics.cfg');
  assert.ok(rules.length > 1000, `${rules.length} transition rules`);
  for (const rule of rules) {
    assert.ok(rule.constraints.length > 0, 'every rule has constraints');
  }
  assert.ok(
    rules.some((rule) => rule.constraints.some((constraint) => constraint.types !== '')),
    'constraints carry terrain matches',
  );
  assert.ok(
    rules.some((rule) => rule.constraints.some((constraint) => constraint.images.length > 0)),
    'rules carry images',
  );
  const prob = rules.filter((rule) => rule.probability !== 100);
  assert.ok(prob.length > 0, 'probabilities read where present');
  const rotated = rules.filter((rule) => rule.rotations.length > 0);
  assert.ok(rotated.length > 0, 'rotated rules are kept for expansion');
});

test('data parity: every table key the engine reads names something real', () => {
  const data = GAME_DATA;
  const problems: string[] = [];
  const damageTypes = new Set<string>();
  for (const type of Object.values(data.unitTypes)) for (const attack of type.attacks) if (attack.type) damageTypes.add(attack.type);
  for (const [name, movetype] of Object.entries(data.movetypes)) {
    for (const key of Object.keys(movetype.movementCosts)) {
      if (!data.terrains[key]) problems.push(`movetype ${name}: movement_costs ${key}`);
    }
    for (const key of Object.keys(movetype.defense)) {
      if (!data.terrains[key]) problems.push(`movetype ${name}: defense ${key}`);
    }
    for (const key of Object.keys(movetype.resistance)) {
      if (!damageTypes.has(key)) problems.push(`movetype ${name}: resistance ${key}`);
    }
  }
  // Legacy keys the real engine also ignores: `terrain_info::value` looks up
  // by terrain id, so `Canoe`'s `swamp=1` (`data/core/units/boats/Canoe.cfg`)
  // never matches any terrain and never applies. The port resolves the same
  // way, so the key is inert on both sides, not a port gap.
  // Some unit files write `[movement_costs] mountain=`/`hill=` where the terrain
  // ids are `mountains`/`hills`; `terrain_info` looks up by id, so those keys are
  // inert in Wesnoth too (The South Guard's Townsfolk, The Deceivers' Gambit's
  // Veteran Cavalier and Frost Stoat Poly).
  const legacyKeys = new Set([
    'Canoe:[movement_costs]:swamp',
    'Townsfolk:[movement_costs]:mountain',
    'Veteran Cavalier:[movement_costs]:mountain',
    'Frost Stoat Poly:[movement_costs]:hill',
    'Frost Stoat Poly:[movement_costs]:mountain',
  ]);
  for (const type of Object.values(data.unitTypes)) {
    for (const key of Object.keys(type.movementCosts ?? {})) {
      if (!data.terrains[key] && !legacyKeys.has(`${type.id}:[movement_costs]:${key}`)) {
        problems.push(`${type.id}: [movement_costs] ${key}`);
      }
    }
    for (const key of Object.keys(type.defense ?? {})) {
      if (!data.terrains[key]) problems.push(`${type.id}: [defense] ${key}`);
    }
    for (const key of Object.keys(type.resistance ?? {})) {
      if (!damageTypes.has(key)) problems.push(`${type.id}: [resistance] ${key}`);
    }
  }
  for (const terrain of Object.values(data.terrains)) {
    for (const alias of [...terrain.aliasof, ...(terrain.mvtAlias ?? [])]) {
      if (alias.startsWith('_') || alias === '-') continue;
      if (!data.terrains[alias] && !data.terrainByCode[alias]) problems.push(`terrain ${terrain.id}: alias ${alias}`);
    }
    if (terrain.defaultBase && !data.terrainByCode[terrain.defaultBase] && !data.terrains[terrain.defaultBase]) {
      problems.push(`terrain ${terrain.id}: default_base ${terrain.defaultBase}`);
    }
  }
  assert.equal(data.schedule.length > 0, true, 'a default schedule exists');
  for (const [id, times] of Object.entries(data.schedules ?? {})) {
    assert.ok(times.length > 0, `schedule ${id} is not empty`);
    for (const time of times) assert.ok(Number.isFinite(time.lawfulBonus), `schedule ${id}/${time.id} bonus`);
  }
  assert.deepEqual(problems.slice(0, 12), [], `${problems.length} dangling table keys`);
});
