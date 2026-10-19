import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectHookReferences, compile, validateHookReferences, type Emit, type HookWorld } from 'mwg/mwl';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { isFogged, isShrouded, makeGame, type GameState } from '../src/simulation/game.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';
import { ENGINE_HOOK_NAMES, createEngineHooks } from '../src/scenarios/engine-hooks.ts';

/**
 * Engine hooks are the MWL boundary: the scenario says when, `src/simulation`
 * says how. These tests call the hooks directly with a small rule-engine state
 * and assert they use the real rules.
 */
const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = { variables: {}, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
const emit = {} as Emit;

function arena(): { state: GameState; units: Map<string, Unit> } {
  // All grass: keeps at the corners, no terrain modifiers to reason about.
  const state = makeGame(5, 5, Array.from({ length: 25 }, () => 'Gg'), new Map([[1, [{ x: 0, y: 0 }]], [2, [{ x: 4, y: 4 }]]]));
  const hero = makeUnit(GAME_DATA, 'Spearman', 1, 1, 1);
  const foe = makeUnit(GAME_DATA, 'Orcish Grunt', 2, 4, 4);
  state.units.push(hero, foe);
  const units = new Map<string, Unit>([['hero', hero], ['foe', foe]]);
  return { state, units };
}

function hooksFor(state: GameState, units: Map<string, Unit>) {
  return createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
}

test('the scenario hooks are all implemented by the engine registry', () => {
  const source = readFileSync(path.join(mwgDir, 'src', 'scenarios', 'freelands.mwl'), 'utf8');
  const game = compile(source, { file: 'scenarios/freelands.mwl' });
  const references = collectHookReferences(game);
  assert.deepEqual(
    references.map((reference) => `${reference.type}:${reference.name}`),
    ['command:rest_heal', 'predicate:side_owns_villages'],
  );
  assert.deepEqual(validateHookReferences(references, ENGINE_HOOK_NAMES), []);
});

test('command:attack resolves the real combat rules', () => {
  const original = Math.random;
  Math.random = () => 0; // always hit, so the assertion is deterministic
  try {
    const { state, units } = arena();
    const hooks = hooksFor(state, units);
    const foe = units.get('foe')!;
    hooks.command!['command:attack'](world, emit, { attacker: 'hero', defender: 'foe', attack: 'spear' });
    assert.ok(foe.hitpoints < foe.maxHitpoints, 'the defender took real combat damage');
  } finally {
    Math.random = original;
  }
});

test('command:move uses the real pathfinding rules', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const hero = units.get('hero')!;
  hooks.command!['command:move'](world, emit, { unit: 'hero', x: '2', y: '1' });
  assert.deepEqual({ x: hero.x, y: hero.y }, { x: 2, y: 1 });
  // The foe's hex is occupied, so the engine refuses the move.
  assert.throws(() => hooks.command!['command:move'](world, emit, { unit: 'hero', x: '4', y: '4' }), /cannot reach/);
});

test('command:transform_unit replaces the live unit while preserving identity', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const hero = units.get('hero')!;
  hero.hitpoints = 7;
  hooks.command!['command:transform_unit'](world, emit, { id: 'hero', transform_to: 'Swordsman' });
  const transformed = state.units.find((unit) => unit.id === hero.id)!;
  assert.equal(transformed.typeId, 'Swordsman');
  assert.equal(transformed.name, hero.name);
  assert.equal(transformed.x, hero.x);
  assert.equal(transformed.hitpoints, 7);
});

test('command:recruit uses the real recruit rules and turn check', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const before = state.units.length;
  hooks.command!['command:recruit'](world, emit, { side: '1', type: 'Spearman', x: '0', y: '0' });
  assert.equal(state.units.length, before + 1, 'side 1 recruits on its turn');
  // Side 2 cannot recruit while it is side 1's turn.
  assert.throws(() => hooks.command!['command:recruit'](world, emit, { side: '2', type: 'Spearman', x: '0', y: '0' }), /cannot recruit/);
});

test('command:rest_heal applies the real rest healing rule', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const hero = units.get('hero')!;
  hero.hitpoints = 1;
  hooks.command!['command:rest_heal'](world, emit, { side: '1' });
  assert.equal(hero.hitpoints, 3, 'REST_HEAL is 2');
});

test('predicate hooks read the rule-engine state', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  state.villageOwner[0] = 1;
  state.villageOwner[1] = 1;
  state.villageOwner[2] = 1;
  assert.equal(hooks.predicate!['predicate:side_owns_villages'](world, { side: '1', value: '3' }), true);
  assert.equal(hooks.predicate!['predicate:side_owns_villages'](world, { side: '1', value: '4' }), false);

  assert.equal(hooks.predicate!['predicate:alive_units'](world, { side: '2', value: '1' }), true);
  units.get('foe')!.hitpoints = 0;
  assert.equal(hooks.predicate!['predicate:alive_units'](world, { side: '2', value: '1' }), false);
});

test('predicate:unit_filter matches abilities and statuses', () => {
  const { state, units } = arena();
  const hero = units.get('hero')!;
  hero.extraAbilities.push('scenario_ability');
  hero.poisoned = true;
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
  const localWorld = { ...world, variables: { subject: 'hero' } } as unknown as typeof world;
  const predicate = hooks.predicate!['predicate:unit_filter'];
  assert.equal(predicate(localWorld, { unit: '$subject', ability: 'scenario_ability' }), true);
  assert.equal(predicate(localWorld, { unit: '$subject', status: 'poisoned' }), true);
  assert.equal(predicate(localWorld, { unit: '$subject', not_status: 'slowed' }), true);
  assert.equal(predicate(localWorld, { unit: '$subject', ability: 'missing' }), false);
});

test('predicate:wml_formula evaluates event variables and locations', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const localWorld = {
    ...world,
    variables: { turn_number: 3, side_number: 3 },
    variableAt: (path: string) => ({ 'loc.x': 7, 'loc.y': 4 } as Record<string, number>)[path],
  } as unknown as HookWorld;
  const predicate = hooks.predicate!['predicate:wml_formula'];
  assert.equal(predicate(localWorld, { formula: 'turn_number = side_number and loc.x = 7' }), true);
  assert.equal(predicate(localWorld, { formula: 'turn_number = 4' }), false);
});

test('predicate:wml_condition_tree evaluates nested WML and/or conditions', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const localWorld = { variables: { first: 'no', second: 'yes' }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  const tree = encodeURIComponent(JSON.stringify({
    tag: 'or', attributes: {}, children: [
      { tag: 'variable', attributes: { name: 'first', equals: 'yes' }, children: [] },
      { tag: 'and', attributes: {}, children: [
        { tag: 'variable', attributes: { name: 'second', equals: 'yes' }, children: [] },
      ] },
    ],
  }));
  assert.equal(hooks.predicate!['predicate:wml_condition_tree'](localWorld, { tree }), true);
});

test('predicate:lua_condition evaluates the supported pure-return subset', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const localWorld = {
    ...world,
    variables: { turn_number: 3, side_number: 3, random_mode: '' },
  } as unknown as HookWorld;
  const predicate = hooks.predicate!['predicate:lua_condition'];
  assert.equal(predicate(localWorld, { code: 'return wml.variables.turn_number > 1' }), true);
  assert.equal(predicate(localWorld, { code: 'return "" == wesnoth.game_config.random_mode' }), true);
  assert.equal(predicate(localWorld, { code: 'return wml.variables.turn_number > 3' }), false);
});

test('campaign hooks spawn loyal units and clear a shroud rectangle', () => {
  const { state, units } = arena();
  let spawned: { id: string; type: string; side: number; x: number; y: number } | undefined;
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    units: () => state.units,
    log: () => {},
    spawnUnit: (id, type, side, x, y) => { spawned = { id, type, side, x, y }; },
    makeLoyal: (id) => { const unit = units.get(id); if (unit) unit.loyal = true; },
  });
  hooks.command!['command:spawn_unit'](
    { ...world, units: { recruit: { hp: 20, x: 2, y: 3, alive: true, type: 'Spearman', side: '1' } } },
    emit,
    { unit: 'recruit' },
  );
  assert.deepEqual(spawned, { id: 'recruit', type: 'Spearman', side: 1, x: 2, y: 3 });

  hooks.command!['command:make_loyal'](world, emit, { unit: 'hero' });
  assert.equal(units.get('hero')!.loyal, true);

  assert.equal(isShrouded(state, 1, 1, 1), true);
  hooks.command!['command:clear_shroud'](world, emit, { side: '1', xs: '1-2', ys: '1-2' });
  assert.equal(isShrouded(state, 1, 1, 1), false);
  assert.equal(isShrouded(state, 1, 2, 2), false);
  assert.equal(isShrouded(state, 1, 3, 3), true);
});

test('command:fire_event dispatches the named MWL event', () => {
  const { state, units } = arena();
  let dispatched = '';
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    fireEvent: (name) => { dispatched = name; },
  });
  hooks.command!['command:fire_event'](world, emit, { event: 'branch_if_1' });
  assert.equal(dispatched, 'branch_if_1');
});

test('side configuration hooks update campaign recruitment', () => {
  const { state, units } = arena();
  let mode = '';
  let types = '';
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    configureRecruit: (_side, nextMode, nextTypes) => { mode = nextMode; types = nextTypes; },
  });
  hooks.command!['command:config_recruit'](world, emit, { side: '1', mode: 'disallow', types: 'Spearman,Bowman' });
  assert.equal(mode, 'disallow');
  assert.equal(types, 'Spearman,Bowman');
});

test('dynamic WML gold resolves a runtime variable through the engine hook', () => {
  const { state, units } = arena();
  let received = 0;
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    addGold: (_side, amount) => { received += amount; },
  });
  const localWorld = { variables: { bonus_income: 15 }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  hooks.command!['command:modify_gold'](localWorld, emit, { side: '1', amount: '$bonus_income' });
  assert.equal(received, 15);
});

test('command:kill_unit tolerates an absent unit instead of throwing', () => {
  const { state, units } = arena();
  const removed: string[] = [];
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    killUnit: (id) => removed.push(id),
  });
  // A prestart `[kill]` purge runs before the named units exist.
  hooks.command!['command:kill_unit'](world, emit, { unit: 'not_on_the_map' });
  assert.deepEqual(removed, ['not_on_the_map']);
  hooks.command!['command:kill_unit'](world, emit, { unit: 'hero' });
  assert.deepEqual(removed, ['not_on_the_map', 'hero']);
});

test('predicate:turn_limit is false inside the limit and true after it', () => {
  const { state, units } = arena();
  const localWorld = { variables: { turn_limit: '3' }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
  state.round = 2;
  assert.equal(hooks.predicate!['predicate:turn_limit'](localWorld, {}), false);
  state.round = 4;
  assert.equal(hooks.predicate!['predicate:turn_limit'](localWorld, {}), true);
});

test('command:spawn_dynamic resolves a `$variable` type and spawns through the rules', () => {
  const { state, units } = arena();
  const spawned: string[] = [];
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    spawnUnit: (id, type, side, x, y) => { spawned.push(`${id}|${type}|${side}|${x},${y}`); },
  });
  const localWorld = { variables: { typeofenemy: 'Wolf' }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  const emitted: string[] = [];
  const localEmit = { spawn: (type: string, side: string, x: number, y: number) => { emitted.push(`${type}|${side}|${x},${y}`); } } as unknown as Emit;
  hooks.command!['command:spawn_dynamic'](localWorld, localEmit, { type: '$typeofenemy', side: '2', x: '4', y: '4' });
  // WML coordinates are 1-based, the rules engine's are 0-based.
  assert.deepEqual(emitted, ['Wolf|2|3,3']);
  assert.deepEqual(spawned, ['Wolf#2@3,3|Wolf|2|3,3']);
  // An unresolved or unknown type is a no-op, never a crash.
  hooks.command!['command:spawn_dynamic'](localWorld, localEmit, { type: '$unset', side: '2', x: '1', y: '1' });
  hooks.command!['command:spawn_dynamic'](localWorld, localEmit, { type: 'Not A Type', side: '2', x: '1', y: '1' });
  assert.equal(emitted.length, 1);
});

test('command:set_variable_rand stores one list entry, repetition weighting it', () => {
  const { state, units } = arena();
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {}, rng: () => 0 });
  const localWorld = { variables: {}, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  hooks.command!['command:set_variable_rand'](localWorld, emit, { variable: 'typeofenemy', values: 'Wolf, Great Wolf' });
  assert.equal((localWorld.variables as Record<string, unknown>).typeofenemy, 'Wolf');
});

test('command:set_variables builds interpolated value tables and appends entries', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const variables: Record<string, unknown> = { difficulty: 'hard' };
  const tableEmit = { setVariable(name: string, value: unknown) { variables[name] = value; } } as Emit;
  const payload = encodeURIComponent(JSON.stringify({
    name: 'waves',
    mode: 'replace',
    children: [{ tag: 'value', attributes: { power: '$difficulty', count: '3' }, children: [] }],
  }));
  hooks.command!['command:set_variables']({ ...world, variables } as unknown as HookWorld, tableEmit, { payload });
  assert.deepEqual(variables.waves, [{ power: 'hard', count: 3 }]);
  const appendPayload = encodeURIComponent(JSON.stringify({
    name: 'waves',
    mode: 'append',
    children: [{ tag: 'value', attributes: { power: 'normal' }, children: [] }],
  }));
  hooks.command!['command:set_variables']({ ...world, variables, variableAt: (name: string) => variables[name] } as unknown as HookWorld, tableEmit, { payload: appendPayload });
  assert.deepEqual(variables.waves, [{ power: 'hard', count: 3 }, { power: 'normal' }]);
});

test('command:store_locations stores one-based filtered hex coordinates', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  let stored: unknown;
  const locationEmit = { setVariable(_name: string, value: unknown) { stored = value; } } as Emit;
  const payload = encodeURIComponent(JSON.stringify({
    tag: 'store_locations',
    attributes: { variable: 'nearby', x: '3', y: '3', radius: '1', terrain: 'G*' },
    children: [],
  }));
  hooks.command!['command:store_locations'](world, locationEmit, { variable: 'nearby', filter: payload });
  assert.equal((stored as unknown[]).length, 7);
  assert.ok((stored as { x: number; y: number }[]).every((location) => location.x >= 1 && location.y >= 1));
});

test('command:random_location picks and removes one stored location', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const variables: Record<string, unknown> = {
    candidates: [{ x: 2, y: 2 }, { x: 3, y: 3 }],
  };
  const values: Record<string, unknown> = {};
  const localWorld = {
    ...world,
    variables,
    variableAt: (name: string) => variables[name],
  } as unknown as HookWorld;
  const localEmit = {
    setVariable(name: string, value: unknown) { variables[name] = value; values[name] = value; },
  } as Emit;
  hooks.command!['command:random_location'](localWorld, localEmit, { source: 'candidates', variable: 'picked' });
  assert.ok((values.picked as { x: number; y: number }).x === 2 || (values.picked as { x: number; y: number }).x === 3);
  assert.equal((variables.candidates as unknown[]).length, 1);
});

test('command:find_respawn_point stores a free nearby map coordinate', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const variables: Record<string, unknown> = {};
  const localWorld = { ...world, variables } as unknown as HookWorld;
  const localEmit = { setVariable(name: string, value: unknown) { variables[name] = value; } } as Emit;
  hooks.command!['command:find_respawn_point'](localWorld, localEmit, { variable: 'respawn_point', respawn_near: 'hero' });
  const point = variables.respawn_point as { x: number; y: number };
  assert.ok(point.x >= 2 && point.x <= 4 && point.y >= 2 && point.y <= 4);
  assert.notDeepEqual(point, { x: 2, y: 2 });
});

test('global variable hooks copy namespaced campaign state', () => {
  const { state, units } = arena();
  const globalVariables = { 'TestNamespace.score': { value: 7 } } as Record<string, import('mwg/mwl').MwlValue>;
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {}, globalVariables });
  const variables: Record<string, unknown> = { local: { value: 9 } };
  const localWorld = { ...world, variables, variableAt: (name: string) => variables[name] } as unknown as HookWorld;
  const localEmit = { setVariable(name: string, value: unknown) { variables[name] = value; } } as Emit;
  hooks.command!['command:get_global_variable'](localWorld, localEmit, { namespace: 'TestNamespace', from_global: 'score', to_local: 'copy' });
  assert.deepEqual(variables.copy, { value: 7 });
  hooks.command!['command:set_global_variable'](localWorld, localEmit, { namespace: 'TestNamespace', from_local: 'local', to_global: 'updated' });
  assert.deepEqual(globalVariables['TestNamespace.updated'], { value: 9 });
});

test('predicate:unit_exists supports negated filter criteria', () => {
  const { state, units } = arena();
  const localWorld = {
    variables: {},
    units: {
      hero: { alive: true, type: 'Spearman', side: 1, x: 1, y: 1 },
    },
    sides: {},
    turn: 1,
  } as unknown as HookWorld;
  const hooks = hooksFor(state, units);
  const predicate = hooks.predicate!['predicate:unit_exists'];
  assert.equal(predicate(localWorld, { id: 'hero', type: 'Spearman', x: '1', y: '1' }), true);
  assert.equal(predicate(localWorld, { id: 'hero', type: 'Orcish Grunt' }), false);
  assert.equal(predicate(localWorld, { id: 'hero', type: 'Orcish Grunt', exists: 'no' }), true);
});

test('command:play_sound_source converts WML delay to seconds and keeps ranges', () => {
  const { state, units } = arena();
  let received: { file: string; x: number; y: number; options: { interval: number; refDistance?: number; maxDistance?: number } } | undefined;
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    playSoundSource: (file, x, y, options) => { received = { file, x, y, options }; },
  });
  hooks.command!['command:play_sound_source'](world, emit, {
    file: 'ambient/wind.ogg', x: '1', y: '0', id: 'wind', loop: 'yes',
    delay: '50000', ref_distance: '3', max_distance: '8',
  });
  assert.deepEqual(received, {
    file: 'ambient/wind.ogg', x: 1, y: 0,
    options: { id: 'wind', repeat: true, interval: 50, refDistance: 3, maxDistance: 8 },
  });
});

test('command:harm_unit applies damage and honors kill=yes', () => {
  const { state, units } = arena();
  const killed: string[] = [];
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: (id) => units.get(id),
    log: () => {},
    killUnit: (id) => killed.push(id),
  });
  const localWorld = { variables: { damage: 99 }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  hooks.command!['command:harm_unit'](localWorld, emit, { id: 'foe', amount: '$damage', kill: 'yes' });
  assert.equal(units.get('foe')!.hitpoints, 0);
  assert.deepEqual(killed, ['foe']);
});

test('command:modify_ai changes candidate enablement in the live WML variables', () => {
  const { state, units } = arena();
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
  const localWorld = { variables: { ai_candidates: 'combat,villages', ai_candidate_off: '' }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  hooks.command!['command:modify_ai'](localWorld, emit, { action: 'delete', path: 'stage[main_loop].candidate_action[villages]' });
  assert.equal(localWorld.variables.ai_candidate_off, 'villages');
  hooks.command!['command:modify_ai'](localWorld, emit, { action: 'add', path: 'stage[main_loop].candidate_action[villages]' });
  assert.equal(localWorld.variables.ai_candidates, 'combat,villages');
  assert.equal(localWorld.variables.ai_candidate_off, '');
  hooks.command!['command:modify_ai'](localWorld, emit, { action: 'add', path: 'goal[]', goal_kind: 'goal', goal_x: '4', goal_y: '3', goal_radius: '2', goal_value: '7' });
  assert.equal(localWorld.variables.ai_directives, 'goal,3,2,2,7');
});

test('command:modify_turns updates the live turn limit', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const localWorld = { variables: { turn_limit: 10 }, units: {}, sides: {}, turn: 1 } as unknown as HookWorld;
  const localEmit = { setVariable: (name: string, value: unknown) => { (localWorld.variables as Record<string, unknown>)[name] = value; } } as Emit;
  hooks.command!['command:modify_turns'](localWorld, localEmit, { add: '5' });
  assert.equal(localWorld.variables.turn_limit, 15);
  hooks.command!['command:modify_turns'](localWorld, localEmit, { value: '$(turn_limit + 2)' });
  assert.equal(localWorld.variables.turn_limit, 17);
});

test('command:modify_unit applies an inline object through the real object rules', () => {
  const { state, units } = arena();
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
  const hero = units.get('hero')!;
  const before = hero.maxHitpoints;
  const object = encodeURIComponent(JSON.stringify({
    id: 'amulet', effects: [{ applyTo: 'hitpoints', increaseTotal: 5, healFull: true }], abilities: [],
  }));
  hooks.command!['command:modify_unit'](world, emit, { id: 'hero', object });
  assert.equal(hero.maxHitpoints, before + 5);
  assert.equal(hero.hitpoints, hero.maxHitpoints);
});

test('command:remove_object reverses a recorded object on matching units', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const hero = units.get('hero')!;
  const before = hero.maxHitpoints;
  const object = encodeURIComponent(JSON.stringify({
    id: 'amulet', effects: [{ applyTo: 'hitpoints', increaseTotal: 5 }], abilities: [],
  }));
  hooks.command!['command:apply_object'](world, emit, { id: 'hero', object });
  assert.equal(hero.maxHitpoints, before + 5);
  hooks.command!['command:remove_object'](world, emit, { id: 'hero', object_id: 'amulet' });
  assert.equal(hero.maxHitpoints, before);
  assert.equal(hero.appliedObjects?.length, 0);
});

test('command:remove_trait removes the trait marker and reverses its stats', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const hero = units.get('hero')!;
  const baseMovement = hero.maxMovement;
  hero.traits = ['quick'];
  hero.maxMovement += 1;
  hero.movement += 1;
  hooks.command!['command:remove_trait'](world, emit, { id: 'hero', trait_id: 'quick' });
  assert.deepEqual(hero.traits, []);
  assert.equal(hero.maxMovement, baseMovement);
});

test('command:store_reachable_locations uses the movement flood fill', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  let stored: unknown;
  const localEmit = { setVariable: (_name: string, value: unknown) => { stored = value; } } as Emit;
  const filter = encodeURIComponent(JSON.stringify({
    tag: 'store_reachable_locations',
    attributes: { variable: 'reachable', moves: 'max' },
    children: [{ tag: 'filter', attributes: { id: 'hero' }, children: [] }],
  }));
  hooks.command!['command:store_reachable_locations'](world, localEmit, { variable: 'reachable', filter, moves: 'max' });
  assert.ok(Array.isArray(stored));
  assert.ok((stored as unknown[]).some((entry) => (entry as { x: number }).x === 2), 'a reachable WML coordinate is stored');
});

test('command:replace_schedule installs a live schedule and selects current_time', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const payload = encodeURIComponent(JSON.stringify({
    tag: 'replace_schedule', attributes: {}, children: [
      { tag: 'time', attributes: { id: 'morning', name: 'Morning', lawful_bonus: '25' }, children: [] },
      { tag: 'time', attributes: { id: 'night', name: 'Night', lawful_bonus: '-25' }, children: [] },
    ],
  }));
  hooks.command!['command:replace_schedule'](world, emit, { schedule: payload, current_time: 'night' });
  assert.equal(state.scheduleIndex, 1);
  assert.ok(state.customSchedules?.[state.scheduleId]);
  assert.deepEqual(state.customSchedules?.[state.scheduleId], [
    { id: 'morning', name: 'Morning', lawfulBonus: 25 },
    { id: 'night', name: 'Night', lawfulBonus: -25 },
  ]);
});

test('command:store_time_of_day stores the active time definition', () => {
  const { state, units } = arena();
  state.customSchedules = { test: [
    { id: 'dawn', name: 'Dawn', lawfulBonus: -25 },
    { id: 'night', name: 'Night', lawfulBonus: -25 },
  ] };
  state.scheduleId = 'test';
  state.scheduleIndex = 1;
  let stored: unknown;
  const hooks = hooksFor(state, units);
  hooks.command!['command:store_time_of_day'](world, { setVariable: (_name, value) => { stored = value; } } as Emit, { variable: 'tod' });
  assert.deepEqual(stored, { id: 'night', name: 'Night', lawful_bonus: -25 });
});

test('command:lift_fog reveals selected cells for the current turn or multiple turns', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  assert.equal(isFogged(state, GAME_DATA, 1, 2, 2), true);
  hooks.command!['command:lift_fog'](world, emit, { side: '1', cells: '2,2', multiturn: 'no' });
  assert.equal(isFogged(state, GAME_DATA, 1, 2, 2), false);
  state.turn = 2;
  assert.equal(isFogged(state, GAME_DATA, 1, 2, 2), true);
  hooks.command!['command:lift_fog'](world, emit, { side: '1', cells: '2,2', multiturn: 'yes' });
  state.turn = 3;
  assert.equal(isFogged(state, GAME_DATA, 1, 2, 2), false);
});

test('command:volume maps WML percentages to audio settings', () => {
  const { state, units } = arena();
  let settings: { musicVolume?: number; soundVolume?: number } | undefined;
  const hooks = createEngineHooks({
    data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {},
    configureAudio: (value) => { settings = value; },
  });
  hooks.command!['command:volume']({ ...world, variables: {} } as HookWorld, emit, { music: '35', sound: '80' });
  assert.deepEqual(settings, { musicVolume: 0.35, soundVolume: 0.8 });
});

test('command:store_gold writes the live side gold to the requested variable', () => {
  const { state, units } = arena();
  let stored: unknown;
  const hooks = createEngineHooks({
    data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {}, gold: (side) => side === 1 ? 42 : 7,
  });
  hooks.command!['command:store_gold'](world, { setVariable: (_name, value) => { stored = value; } } as Emit, { side: '1', variable: 'gold' });
  assert.equal(stored, 42);
});

test('command:store_unit_type stores compiled unit type data and ids', () => {
  const { state, units } = arena();
  const values: Record<string, unknown> = {};
  const hooks = createEngineHooks({ data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {} });
  const setVariable = (name: string, value: unknown) => { values[name] = value; };
  hooks.command!['command:store_unit_type_ids'](world, { setVariable } as Emit, { variable: 'ids' });
  hooks.command!['command:store_unit_type'](world, { setVariable } as Emit, { variable: 'type', types: 'Spearman' });
  assert.match(String(values.ids), /Spearman/);
  assert.deepEqual(values.type, {
    id: 'Spearman', name: 'Spearman', image: GAME_DATA.unitTypes.Spearman.image,
    hitpoints: GAME_DATA.unitTypes.Spearman.hitpoints, movement: GAME_DATA.unitTypes.Spearman.movement,
    movement_type: GAME_DATA.unitTypes.Spearman.movementType, experience: GAME_DATA.unitTypes.Spearman.experience,
    level: GAME_DATA.unitTypes.Spearman.level, alignment: GAME_DATA.unitTypes.Spearman.alignment,
    advances_to: GAME_DATA.unitTypes.Spearman.advancesTo.join(','), cost: GAME_DATA.unitTypes.Spearman.cost,
    race: GAME_DATA.unitTypes.Spearman.race,
  });
});

test('command:kill_unit applies an encoded unit filter to every matching unit', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const killed: string[] = [];
  const filteringHooks = createEngineHooks({
    data: GAME_DATA, state: () => state, unit: (id) => units.get(id), units: () => state.units,
    log: () => {}, killUnit: (id) => killed.push(id),
  });
  const filter = encodeURIComponent(JSON.stringify({ tag: 'filter', attributes: { side: '2' }, children: [] }));
  filteringHooks.command!['command:kill_unit'](world, emit, { filter });
  assert.deepEqual(killed, ['Orcish Grunt']);
  void hooks;
});

test('command:kill_unit without a filter kills every live unit', () => {
  const { state, units } = arena();
  const killed: string[] = [];
  const hooks = createEngineHooks({
    data: GAME_DATA, state: () => state, unit: (id) => units.get(id), units: () => state.units,
    log: () => {}, killUnit: (id) => killed.push(id),
  });
  hooks.command!['command:kill_unit'](world, emit, { all: 'yes' });
  assert.deepEqual(killed, ['Spearman', 'Orcish Grunt']);
});

test('command:replace_map replaces terrain and rebuilds map-sized derived state', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  const terrain = encodeURIComponent('Gg, Ww\nHh, Ke');
  hooks.command!['command:replace_map'](world, emit, { terrain });
  assert.deepEqual({ width: state.width, height: state.height }, { width: 2, height: 2 });
  assert.deepEqual(state.terrainCodes, ['Gg', 'Ww', 'Hh', 'Ke']);
  assert.equal(state.villageOwner.length, 4);
  assert.equal(state.fog.width, 2);
  assert.equal(state.fog.height, 2);
});

test('command:replace_map_section applies a terrain fragment at WML coordinates', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  hooks.command!['command:replace_map_section'](world, emit, {
    x: '2', y: '3', terrain: encodeURIComponent('Ww, Hh\nKe, Gg'),
  });
  assert.equal(state.terrainCodes[2 * state.width + 1], 'Ww');
  assert.equal(state.terrainCodes[2 * state.width + 2], 'Hh');
  assert.equal(state.terrainCodes[3 * state.width + 1], 'Ke');
});

test('command:store_turns stores the remaining turn limit', () => {
  const { state, units } = arena();
  const hooks = hooksFor(state, units);
  let stored: unknown;
  const turnWorld = { ...world, turn: 3, variables: { turn_limit: 7 } } as unknown as HookWorld;
  hooks.command!['command:store_turns'](turnWorld, { setVariable: (_name, value) => { stored = value; } } as Emit, { variable: 'remaining' });
  assert.equal(stored, 5);
});

test('command:store_villages stores one-based village coordinates and owners', () => {
  const { state, units } = arena();
  state.terrainCodes[6] = 'Gg^Ve';
  state.villageOwner[6] = 2;
  const hooks = hooksFor(state, units);
  let stored: unknown;
  hooks.command!['command:store_villages'](world, { setVariable: (_name, value) => { stored = value; } } as Emit, { variable: 'villages' });
  assert.deepEqual(stored, [{ x: 2, y: 2, side: 2 }]);
});

test('command:unpetrify reverses petrify for matching units', () => {
  const { state, units } = arena();
  const hero = units.get('hero')!;
  hero.petrified = true;
  const hooks = hooksFor(state, units);
  hooks.command!['command:unpetrify'](world, emit, { id: 'hero' });
  assert.equal(hero.petrified, false);
});

test('command:modify_unit clears selected unit variables', () => {
  const { state, units } = arena();
  const hero = units.get('hero')!;
  hero.variables = { swiftness_rune: true, keep: 1 };
  const hooks = hooksFor(state, units);
  hooks.command!['command:modify_unit'](world, emit, { id: 'hero', clear_variable: 'swiftness_rune' });
  assert.deepEqual(hero.variables, { keep: 1 });
});

test('command:config_side applies village support to upkeep rules', () => {
  const { state, units } = arena();
  state.villageOwner[6] = 1;
  const hooks = hooksFor(state, units);
  hooks.command!['command:config_side'](world, emit, { side: '1', village_support: '2' });
  assert.equal(state.sideRules?.[1]?.villageSupport, 2);
});

test('command:allow_extra_recruit supports coordinate targets and clearing', () => {
  const { state, units } = arena();
  const hooks = createEngineHooks({
    data: GAME_DATA, state: () => state, unit: (id) => units.get(id), log: () => {},
    configureRecruit: (_side, _mode, _types) => {},
  });
  const hero = units.get('hero')!;
  hooks.command!['command:allow_extra_recruit'](world, emit, { x: '2', y: '2', types: 'Mage,Archer' });
  assert.deepEqual(hero.extraRecruit, ['Mage', 'Archer']);
  hooks.command!['command:allow_extra_recruit'](world, emit, { id: 'hero', types: '' });
  assert.deepEqual(hero.extraRecruit, []);
});
