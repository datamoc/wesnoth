import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWml } from '../src/simulation/wml.ts';
import { compileWesnothMwl, toGameState, toMapData, toWesnothData, wesnothNodesToMwl } from '../src/adapters/from-mwl.ts';
import type { MwlNode } from 'mwg/mwl';

const TERRAIN = `
[terrain_type]
    id=grassland
    string=Gg
    aliasof=Gt
[/terrain_type]
[terrain_type]
    id=elven_village
    string=^Ve
    aliasof=_bas, Vt
    default_base=Gg
    heals=8
    gives_income=yes
[/terrain_type]
`;

const UNITS = `
[units]
    [movetype]
        name=smallfoot
        [movement_costs]
            flat=1
            forest=2
        [/movement_costs]
        [defense]
            flat=60
            forest=50
        [/defense]
        [resistance]
            arcane=90
            pierce=100
        [/resistance]
    [/movetype]
    [trait]
        id=strong
        male_name="strong"
        [effect]
            apply_to=attack
            range=melee
            increase_damage=1
        [/effect]
        [effect]
            apply_to=hitpoints
            increase_total=1
        [/effect]
    [/trait]
    [unit_type]
        id=Spearman
        name="Spearman"
        image="units/human-loyalists/spearman.png"
        hitpoints=36
        movement_type=smallfoot
        movement=5
        experience=42
        level=1
        alignment=lawful
        advances_to=Swordsman, Pikeman
        cost=14
        [attack]
            name=spear
            description="spear"
            type=pierce
            range=melee
            damage=7
            number=3
            icon=attacks/spear.png
            specials_list=firststrike
        [/attack]
        [attack]
            name=arcane_bolt
            type=arcane
            range=ranged
            damage=5
            number=2
            [specials]
                [chance_to_hit]
                    id=magical
                [/chance_to_hit]
            [/specials]
        [/attack]
    [/unit_type]
[/units]
`;

test('parseWml preserves CFG source positions for the MWL adapter', () => {
  const nodes = parseWml('[unit_type]\n    id=hero\n[/unit_type]', 'data/core/units.cfg');
  assert.deepEqual(nodes[0].location, { file: 'data/core/units.cfg', line: 1, column: 1 });
  const converted = wesnothNodesToMwl({ terrain: [], units: nodes, schedule: [] });
  assert.deepEqual(converted[0].location, { file: 'data/core/units.cfg', line: 1, column: 1 });
});

const SCHEDULE = `
[time]
    id=dawn
    name="Dawn"
    lawful_bonus=0
[/time]
[time]
    id=morning
    name="Morning"
    lawful_bonus=25
[/time]
`;

const MAP = 'Gg,Gg\nGg,1 Kh';

test('adapter converts terrain, movetypes, traits, units, and schedule through MWL', () => {
  const terrain = parseWml(TERRAIN);
  const unitsRoot = parseWml(UNITS);
  const units = unitsRoot.flatMap((node) => (node.tag === 'units' ? node.children : []));
  const schedule = parseWml(SCHEDULE);

  const compiled = compileWesnothMwl({ terrain, units, schedule, map: { name: 'Test', text: MAP } });
  const data = toWesnothData(compiled);

  const grassland = data.terrains.grassland;
  assert.deepEqual(grassland.aliasof, ['Gt']);
  assert.equal(grassland.heals, 0);
  assert.equal(grassland.givesIncome, false);
  const village = data.terrains.elven_village;
  assert.deepEqual(village.aliasof, ['_bas', 'Vt']);
  assert.equal(village.defaultBase, 'Gg');
  assert.equal(village.heals, 8);
  assert.equal(village.givesIncome, true);
  assert.equal(data.terrainByCode['^Ve'], 'elven_village');

  // Open attribute maps survive conversion: any terrain key, numeric value.
  assert.equal(data.movetypes.smallfoot.movementCosts.flat, 1);
  assert.equal(data.movetypes.smallfoot.movementCosts.forest, 2);
  assert.equal(data.movetypes.smallfoot.defense.flat, 60);
  assert.equal(data.movetypes.smallfoot.resistance.arcane, 90);

  // Trait name/male_name are dropped; only the effects survive.
  assert.deepEqual(data.traits.strong, {
    id: 'strong',
    effects: [
      { applyTo: 'attack', range: 'melee', increaseDamage: 1 },
      { applyTo: 'hitpoints', increaseTotal: 1 },
    ],
  });

  const spearman = data.unitTypes.Spearman;
  assert.equal(spearman.movementType, 'smallfoot');
  assert.deepEqual(spearman.advancesTo, ['Swordsman', 'Pikeman']);
  assert.equal(spearman.attacks[0].specials.join(','), 'firststrike');
  // Nested [specials] are flattened into the specials list too.
  assert.deepEqual(spearman.attacks[1].specials, ['magical']);

  assert.deepEqual(
    data.schedule.map((time) => `${time.id}:${time.lawfulBonus}`),
    ['dawn:0', 'morning:25'],
  );
});

test('adapter reads the compiled map back with keep markers', () => {
  const compiled = compileWesnothMwl({ terrain: parseWml(TERRAIN), units: [], schedule: [], map: { name: 'Test', text: MAP } });
  const map = toMapData(compiled);
  assert.equal(map.width, 2);
  assert.equal(map.height, 2);
  assert.deepEqual(map.codes, ['Gg', 'Gg', 'Gg', 'Kh']);
  assert.deepEqual(map.keeps, { 1: [{ x: 1, y: 1 }] });
});

test('map rows parse through the framework, including windows line endings', () => {
  // Row parsing is `parseTerrain` from `mwg/mwl`; the port only renames
  // `starts` to `keeps`. `\r\n` maps must not leave a stray `\r` code.
  const compiled = compileWesnothMwl({ terrain: parseWml(TERRAIN), units: [], schedule: [], map: { name: 'Test', text: 'Gg,Gg\r\nGg,1 Kh' } });
  const map = toMapData(compiled);
  assert.deepEqual(map.codes, ['Gg', 'Gg', 'Gg', 'Kh']);
  assert.deepEqual(map.keeps, { 1: [{ x: 1, y: 1 }] });
});

test('adapter converts a compiled world into the port GameState', () => {
  const terrain = parseWml(TERRAIN);
  const unitsRoot = parseWml(UNITS);
  const units = unitsRoot.flatMap((node) => (node.tag === 'units' ? node.children : []));
  const compiled = compileWesnothMwl({ terrain, units, schedule: [], map: { name: 'Test', text: MAP } });
  const data = toWesnothData(compiled);
  const map = toMapData(compiled);

  // The world now carries unit type and side, so no context maps are needed.
  const state = toGameState(
    {
      variables: {},
      units: {
        hero: { hp: 5, x: 0, y: 0, alive: true, type: 'Spearman', side: '1' },
        gone: { hp: 0, x: 1, y: 0, alive: false, type: 'Spearman', side: '1' },
      },
      sides: { '1': { gold: 0, income: 0 } },
      maps: {},
      gold: {},
      turn: 1,
      status: 'playing',
    },
    { data, map },
  );

  assert.equal(state.units.length, 1);
  assert.equal(state.units[0].name, 'Spearman');
  assert.equal(state.units[0].side, 1);
  assert.equal(state.units[0].hitpoints, 5);
  assert.equal(state.turn, 1);

  // Older snapshots without type/side still work through the context overrides.
  const legacy = toGameState(
    {
      variables: {},
      units: { hero: { hp: 5, x: 0, y: 0, alive: true } },
      sides: {},
      maps: {},
      gold: {},
      turn: 1,
      status: 'playing',
    },
    { data, map, unitTypes: { hero: 'Spearman' }, sides: { hero: 2 } },
  );
  assert.equal(legacy.units.length, 1);
  assert.equal(legacy.units[0].side, 2);
});

test('adapter node conversion emits MWL nodes the framework schema accepts', () => {
  const nodes: MwlNode[] = wesnothNodesToMwl({ terrain: parseWml(TERRAIN), units: [], schedule: [], map: { name: 'Test', text: MAP } });
  const tags = nodes.map((node) => node.tag);
  assert.deepEqual(tags, ['terrain_type', 'terrain_type', 'map']);
  assert.equal(nodes[0].attributes.string, 'Gg');
});
