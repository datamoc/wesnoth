import { hexDistance, hexNeighbors } from 'mwg';
import { FactionFog } from 'mwg/board';
import type { HookWorld, MwlHookRegistry, MwlValue, ScriptValue } from 'mwg/mwl';
import { activeSchedule, areAllied, attackWithRules, isFogged, recruit, restHealSide, setTerrainAt, teamOf, terrainCodeAt, updateVision, villageOwnerAt, type GameState } from '../simulation/game.ts';
import { moveUnit, reachable, teleportUnit } from '../simulation/movement.ts';
import { resolveTerrain } from '../simulation/terrain.ts';
import type { TimeOfDayDef, WesnothData } from '../simulation/types.ts';
import { makeUnit, removeTrait, type Rng, type Unit } from '../simulation/unit.ts';
import { applyWmlOperation, evaluateFormula as evaluateWmlFormula, interpolateWml, wmlNumber, type WmlValue } from './wml-value.ts';
import { decodeFilter, matchesUnitFilter, type FilterWorld } from './wml-filter.ts';
import { abilitiesOf as combatAbilities } from '../simulation/combat.ts';
import { evaluateFormula } from '../simulation/expression.ts';
import { applyObject, removeObject } from '../simulation/objects.ts';
import type { ObjectDef } from '../simulation/types.ts';
import { createPyroeisScriptHost } from 'mwg/mwl/pyroeis';
import { encodeCode, parseTerrainList, terrainMatches } from '../simulation/terrain-codes.ts';

interface SerializedVariableNode {
  tag: string;
  attributes: Record<string, string>;
  children: SerializedVariableNode[];
}

/**
 * The port's engine hooks.
 *
 * This is the MWL boundary the port keeps moving toward: a scenario decides
 * *when* something happens (`[event]` with a `[hook]`, or an objective with
 * `condition=hook`), while these functions decide *how*, by calling the real
 * rules in `src/simulation`. Hooks receive the framework's read-only world and
 * `Emit` surface, but use the live rule-engine state through `EngineHookContext`
 * because only the engine has terrain, movement costs, and combat formulas.
 */

export interface EngineHookContext {
  readonly data: WesnothData;
  /** the live rule-engine state */
  state(): GameState;
  /** MWL scenario unit id -> the simulation unit it drives */
  unit(id: string): Unit | undefined;
  /** all live simulation units, used by WML filters that select many units */
  units?(): readonly Unit[];
  /** a human-readable line for the scene's log */
  log(text: string): void;
  /** Preserve a WML presentation pause when the host can animate it. */
  delay?(seconds: number): void;
  /** Center the board on a 0-based map coordinate. */
  scrollTo?(x: number, y: number): void;
  /** WML unit-variable storage, including optional removal from the map. */
  /** stores every matching unit; returns one handle per stored unit (the WML array's elements) */
  storeUnit?(variable: string, filter: { id?: string; side?: string; type?: string; notId?: string; notType?: string }, kill: boolean): string[];
  /** Restore a previously stored unit, optionally at a requested location. */
  unstoreUnit?(variable: string, x?: string, y?: string, side?: string): void;
  /** Move a live unit to the campaign recall list. */
  putToRecallList?(id: string, heal: boolean): void;
  /** a unit object was swapped for another (`[transform]`): keep the scene's id registry pointing at the live one */
  replaceUnit?(previous: Unit, replacement: Unit): void;
  /** Add a WML-spawned unit to the live simulation state. */
  spawnUnit?(id: string, type: string, side: number, x: number, y: number): void;
  /** Recall a named unit from the campaign recall list, when available. */
  recallUnit?(id: string): void;
  /** Recall the first saved unit matching a WML recall filter. */
  /** recalls a unit from the side's recall list (at `x`,`y`, 1-based, when given); false when none matches */
  recallUnitByFilter?(filter: { id?: string; type?: string; role?: string; x?: string; y?: string }): boolean;
  /** Apply Wesnoth's no-upkeep loyal marker to a live unit. */
  makeLoyal?(id: string): void;
  /** Unlock a campaign achievement by id. */
  setAchievement?(id: string): void;
  /** Remove a named unit from the map; a no-op when it is not present (`[kill]`). */
  killUnit?(id: string): void;
  /** Dispatch a named MWL event from a WML [fire_event] command. */
  fireEvent?(name: string): void;
  /** Show a temporary image halo at a board coordinate. */
  showHalo?(image: string, x: number, y: number, duration: number, frames?: readonly { image: string; duration: number }[]): void;
  /** Update a side's live configuration from WML. */
  configureSide?(side: number, attributes: Record<string, string>): void;
  /** Add/remove unit types from a side's recruit list. */
  configureRecruit?(side: number, mode: 'allow' | 'disallow', types: string): void;
  /** Apply a WML gold delta after resolving a runtime variable if needed. */
  addGold?(side: number, amount: number): void;
  /** Read a side's current gold for `[store_gold]`. */
  gold?(side: number): number;
  /** scenario random stream; defaults to `Math.random` when the scene omits it */
  rng?(): number;
  /** Campaign-global WML variables, surviving scenario runtime recreation. */
  globalVariables?: Record<string, MwlValue>;
  /** switch the background music (`[music]`, and a story part's own track) */
  playMusic?(file: string, options: { playOnce: boolean; repeat: boolean; fade: number }): void;
  /** play a one-shot sound effect (`[sound]`) */
  playSound?(file: string): void;
  /** add a positional ambient source (`[sound_source]`) */
  playSoundSource?(file: string, x: number, y: number, options: { id?: string; repeat: boolean; interval: number; refDistance?: number; maxDistance?: number }): void;
  removeSoundSource?(id: string): void;
  /** Apply a WML volume command (percent values) to the audio surface. */
  configureAudio?(settings: { musicVolume?: number; soundVolume?: number }): void;
}

/** The `type:name` keys this registry implements, for validation and tests. */
export const ENGINE_HOOK_NAMES: readonly string[] = [
  'command:attack',
  'command:move',
  'command:recruit',
  'command:rest_heal',
  'command:teleport',
  'command:store_unit',
  'command:unstore_unit',
  'command:put_to_recall_list',
  'command:modify_unit',
  'command:transform_unit',
  'command:apply_object',
  'command:remove_object',
  'command:remove_trait',
  'command:petrify',
  'command:unpetrify',
  'command:unit_overlay',
  'command:remove_unit_overlay',
  'command:micro_ai',
  'command:heal_unit',
  'command:harm_unit',
  'command:kill_unit',
  'command:scenario_move',
  'command:capture_village',
  'command:set_terrain',
  'command:terrain_mask',
  'command:replace_map',
  'command:replace_map_section',
  'command:add_item',
  'command:remove_item',
  'command:store_items',
  'command:clear_shroud',
  'command:place_shroud',
  'command:reset_fog',
  'command:lift_fog',
  'command:config_side',
  'command:config_recruit',
  'command:allow_extra_recruit',
  'command:modify_ai',
  'command:modify_gold',
  'command:store_gold',
  'command:store_side',
  'command:store_unit_type',
  'command:store_unit_type_ids',
  'command:unit_worth',
  'command:spawn_unit',
  'command:spawn_dynamic',
  'command:set_variable_rand',
  'command:get_global_variable',
  'command:set_global_variable',
  'command:recall_unit',
  'command:make_loyal',
  'command:set_achievement',
  'command:fire_event',
  'command:show_halo',
  'command:show_objectives',
  'command:set_variable_dynamic',
  'command:modify_turns',
  'command:set_variables',
  'command:store_locations',
  'command:random_location',
  'command:random_count',
  'command:find_respawn_point',
  'command:store_turns',
  'command:store_villages',
  'command:set_village_owner',
  'command:store_reachable_locations',
  'command:set_unit_hidden',
  'predicate:alive_units',
  'predicate:side_owns_villages',
  'predicate:unit_exists',
  'unit_exists',
  'predicate:attack_filter',
  'attack_filter',
  'predicate:turn_limit',
  'predicate:variable_compare',
  'predicate:wml_filter',
  'predicate:wml_formula',
  'predicate:wml_condition_tree',
  'predicate:lua_condition',
  'command:play_music',
  'command:play_sound',
  'command:play_sound_source',
  'command:remove_sound_source',
  'command:volume',
  'command:delay',
  'command:scroll_to',
  'command:scroll_to_unit',
  'command:replace_schedule',
  'command:set_time_area',
  'command:remove_time_area',
  'command:store_time_of_day',
];

export function createEngineHooks(engine: EngineHookContext): MwlHookRegistry {
  const luaHost = createPyroeisScriptHost({ instructionLimit: 50_000, seed: 0x6d7767 });
  const requiredUnit = (id: string | undefined, hook: string): Unit => {
    const unit = id ? engine.unit(id) : undefined;
    if (!unit) throw new Error(`${hook}: unknown unit "${id ?? ''}"`);
    return unit;
  };
  const integer = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const worldInteger = (world: HookWorld, value: string | undefined, fallback: number): number => {
    const literal = Number(value);
    if (Number.isFinite(literal)) return Math.trunc(literal);
    const variable = value?.trim().replace(/^\$/, '');
    const flat = variable ? world.variables[variable] : undefined;
    const resolved = flat ?? (variable ? world.variableAt?.(variable) : undefined);
    const number = typeof resolved === 'number' ? resolved : Number(resolved);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
  };
  // WML's value type is immutable (`readonly WmlValue[]`) and MWG's is not, so a value crossing
  // into the framework is copied rather than cast: a later write through the framework then
  // cannot reach back into an array this side still holds.
  const toMwlValue = (value: WmlValue): MwlValue =>
    Array.isArray(value)
      ? Array.from(value as readonly WmlValue[], (entry): MwlValue => toMwlValue(entry))
      : (value as string | number | boolean);
  /**
   * Wesnoth reads `$a.b` through the whole variable tree, while port hooks also write some
   * paths as flat dotted keys; try the flat key first, then the framework's `variableAt`
   * (the same walker `[variable] name=` reads through), so scenario and hook paths agree.
   * The manual walk stays as a fallback for stub worlds in tests that predate `variableAt`.
   */
  const variableReader = (world: HookWorld) => (path: string): WmlValue | undefined => {
    const flat = world.variables[path];
    if (flat !== undefined) return asWmlValue(flat);
    const throughFramework = world.variableAt?.(path);
    if (throughFramework !== undefined) return asWmlValue(throughFramework);
    let current: unknown = world.variables;
    for (const part of path.split('.')) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return asWmlValue(current);
  };
  // A WML attribute value is `vconfig::expand`ed: `$name`, `$name?default|` and `$(formula)`
  // all resolve before the action sees it, and an unset variable reads as the empty string.
  const resolveVariablePath = (world: HookWorld, value: string): string =>
    interpolateWml(value, variableReader(world));
  const compareVariable = (world: HookWorld, context: Record<string, string>): boolean => {
    const rawPath = context.variable ?? context.name ?? '';
    const path = rawPath.includes('$') ? resolveVariablePath(world, rawPath) : rawPath;
    const stored = variableReader(world)(path);
    const actual = stored === undefined ? '' : valueToString(stored);
    const expected = (key: string): number => Number(resolveVariablePath(world, context[key] ?? ''));
    if (context.not_equals !== undefined) return !sameValue(actual, resolveVariablePath(world, context.not_equals));
    if (context.equals !== undefined) return sameValue(actual, resolveVariablePath(world, context.equals));
    if (context.greater_than !== undefined) return Number(actual) > expected('greater_than');
    if (context.less_than !== undefined) return Number(actual) < expected('less_than');
    if (context.greater_than_or_equal_to !== undefined) return Number(actual) >= expected('greater_than_or_equal_to');
    if (context.less_than_or_equal_to !== undefined) return Number(actual) <= expected('less_than_or_equal_to');
    return Boolean(actual);
  };
  const matchingUnits = (context: Record<string, string>): Unit[] => {
    const selected = context.id ? engine.unit(context.id) : undefined;
    const all = [...(engine.units?.() ?? [])];
    if (selected && !all.includes(selected)) all.push(selected);
    return all.filter((unit) =>
      (!context.id || unit === selected || unit.id.toString() === context.id || unit.name === context.id) &&
      (!context.side || unit.side === integer(context.side, unit.side)) &&
      (!context.type || unit.typeId === context.type) &&
      (!context.canrecruit || unit.canRecruit === (context.canrecruit === 'yes' || context.canrecruit === 'true')) &&
      (!context.x || unit.x === integer(context.x, unit.x)) &&
      (!context.y || unit.y === integer(context.y, unit.y)),
    );
  };
  const cells = (value: string | undefined): { x: number; y: number }[] =>
    (value ?? '').split(';').map((entry) => entry.split(',').map((part) => Number(part))).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).map(([x, y]) => ({ x, y }));
  const list = (value: string): string[] => value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const axis = (value: string | undefined): number[] => (value ?? '').split(',').flatMap((part) => {
    const [from, to] = part.trim().split('-').map(Number);
    if (!Number.isFinite(from)) return [];
    if (!Number.isFinite(to)) return [from];
    const step = from <= to ? 1 : -1;
    return Array.from({ length: Math.abs(to - from) + 1 }, (_unused, index) => from + index * step);
  });
  const locationExists = (world: HookWorld, node: SerializedVariableNode): boolean => {
    const state = engine.state();
    const expanded = (value: string | undefined): string => interpolateWml(value ?? '', variableReader(world));
    const terrain = node.attributes.terrain ? parseTerrainList(expanded(node.attributes.terrain)) : undefined;
    const xValues = node.attributes.x === undefined ? undefined : axis(expanded(node.attributes.x));
    const yValues = node.attributes.y === undefined ? undefined : axis(expanded(node.attributes.y));
    for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
      if (xValues && !xValues.includes(x + 1)) continue;
      if (yValues && !yValues.includes(y + 1)) continue;
      if (node.attributes.radius !== undefined && node.attributes.x !== undefined && node.attributes.y !== undefined) {
        const cx = Number(expanded(node.attributes.x)) - 1;
        const cy = Number(expanded(node.attributes.y)) - 1;
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || hexDistance({ x, y }, { x: cx, y: cy }) > Number(expanded(node.attributes.radius))) continue;
      }
      if (terrain && !terrainMatches(encodeCode(state.terrainCodes[y * state.width + x] ?? ''), terrain)) continue;
      return true;
    }
    return false;
  };
  const unitExists = (world: { units: Record<string, { alive?: boolean; type?: string; side?: string; x?: number; y?: number }> }, context: Record<string, string>): boolean => {
    const entries = context.id ? [world.units[context.id]] : Object.values(world.units);
    const matchesAxis = (actual: number | undefined, spec: string | undefined): boolean => {
      if (spec === undefined || actual === undefined) return spec === undefined;
      return axis(spec).includes(actual);
    };
    const exists = entries.some((entry) => {
      // MWL side ids are strings; WML filters compare side numbers.
      const entrySide = entry?.side === undefined ? undefined : Number(entry.side);
      return Boolean(entry?.alive &&
        (!context.side || entrySide === integer(context.side, entrySide ?? 0)) &&
        (!context.type || entry.type === context.type) &&
        matchesAxis(entry.x, context.x) && matchesAxis(entry.y, context.y));
    });
    return context.exists === 'no' ? !exists : exists;
  };
  /**
   * The port's WML filter algebra (`src/scenarios/wml-filter.ts`) over the live
   * game. `unit=` names the subject by context variable (`$last_dead_id`), the
   * same way the simpler predicates read theirs; `any=yes` asks whether some
   * live unit matches, which is what an event without a subject means.
   */
  const filterWorld = (world: HookWorld): FilterWorld => {
    const state = engine.state();
    const reader = variableReader(world);
    return {
      variable: (path) => reader(path),
      terrainAt: (x, y) => terrainCodeAt(state, x, y),
      villageOwnerAt: (x, y) => villageOwnerAt(state, x, y),
      allied: (a, b) => areAllied(state, a, b),
      abilitiesOf: (unit) => [...(engine.data.unitTypes[unit.typeId]?.abilities ?? []), ...unit.extraAbilities],
      abilityDetailsOf: (unit) => combatAbilities(engine.data, unit).flatMap((ability) =>
        ability.effects.map((effect) => ({ id: ability.id, tag: effect.tag, attributes: effect.attributes })),
      ),
      attacksOf: (unit) => unit.attacks.map((attack) => ({ id: attack.name, name: attack.name, range: attack.range, type: attack.type })),
      raceOf: (unit) => engine.data.unitTypes[unit.typeId]?.race ?? '',
      // `resolveTerrain` reads `isVillage` off the terrain chain, so no movetype is needed.
      isVillageAt: (x, y) => resolveTerrain(engine.data, undefined, terrainCodeAt(state, x, y)).isVillage,
      unitAt: (x, y) => state.units.find((unit) => unit.x === x && unit.y === y && unit.hitpoints > 0),
      visibleTo: (side, x, y) => !isFogged(state, engine.data, side, x, y),
    };
  };

  const wmlFilter = (world: HookWorld, context: Record<string, string>): boolean => {
    const node = decodeFilter(context.filter ?? '');
    if (!node) return false;
    const second = context.second ? decodeFilter(context.second) : null;
    if (context.any === 'yes') {
      const scope = filterWorld(world);
      return engine.state().units.some((unit) => unit.hitpoints > 0 && matchesUnitFilter(node, unit, scope));
    }
    const subjectId = context.unit?.startsWith('$') ? world.variables[context.unit.slice(1)] : context.unit;
    const unit = subjectId === undefined || subjectId === null ? undefined : engine.unit(String(subjectId));
    if (!unit) return false;
    const scope = filterWorld(world);
    if (!second) return matchesUnitFilter(node, unit, scope);
    const secondaryId = context.second_unit?.startsWith('$') ? world.variables[context.second_unit.slice(1)] : context.second_unit;
    const other = secondaryId === undefined || secondaryId === null ? undefined : engine.unit(String(secondaryId));
    return matchesUnitFilter(node, unit, scope, other);
  };

  const matchingUnitsWithFilter = (world: HookWorld, context: Record<string, string>): Unit[] => {
    const node = context.filter ? decodeFilter(context.filter) : null;
    if (!node) return matchingUnits(context);
    const scope = filterWorld(world);
    return matchingUnits(context).filter((unit) => matchesUnitFilter(node, unit, scope));
  };

  const attackFilter = (world: HookWorld, context: Record<string, string>): boolean => {
    const id = resolveVariablePath(world, context.unit ?? '');
    const unit = engine.unit(id);
    if (!unit) return false;
    let filter: { attributes?: Record<string, string>; children?: SerializedVariableNode[] } | undefined;
    try { filter = context.filter ? JSON.parse(decodeURIComponent(context.filter)) as typeof filter : undefined; } catch { return false; }
    const attrs = filter?.attributes ?? {};
    const list = (key: string): string[] => (attrs[key] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    return unit.attacks.some((attack) => {
      if (list('name').length && !list('name').includes(attack.name)) return false;
      if (list('range').length && !list('range').includes(attack.range)) return false;
      if (list('type').length && !list('type').includes(attack.type)) return false;
      if (list('damage_type').length && !list('damage_type').includes(attack.type)) return false;
      return true;
    });
  };
  const unitFilter = (world: HookWorld, context: Record<string, string>): boolean => {
    const rawId = context.unit?.startsWith('$') ? world.variables[context.unit.slice(1)] : context.unit;
    const unit = rawId ? engine.unit(String(rawId)) : undefined;
    if (!unit) return false;
    const hasAny = (values: string, available: readonly string[]): boolean => list(values).some((value) => available.includes(value));
    const abilities = [...(engine.data.unitTypes[unit.typeId]?.abilities ?? []), ...unit.extraAbilities];
    const statuses = (['poisoned', 'slowed', 'petrified'] as const).filter((status) => unit[status]);
    if (context.ability && !hasAny(context.ability, abilities)) return false;
    if (context.not_ability && hasAny(context.not_ability, abilities)) return false;
    if (context.status && !hasAny(context.status, statuses)) return false;
    if (context.not_status && hasAny(context.not_status, statuses)) return false;
    return true;
  };

  // MWG 0.9 resolves predicate children by their bare `name`, while older
  // runtime paths used the `predicate:`-prefixed registry key. Keep the Lua
  // condition implementation in one function and expose both spellings.
  const luaCondition = (world: HookWorld, context: Record<string, string>): boolean => {
    const source = context.code ?? '';
    if (!/^\s*return\s+/.test(source)) return false;
    const variables: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(world.variables)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') variables[key] = value;
    }
    const nested: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variables)) {
      const parts = key.split('.');
      let cursor = nested;
      for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {}) as Record<string, unknown>;
      cursor[parts.at(-1)!] = value;
    }
    try {
      const expression = source.replace(/^\s*return\s+/, '').trim();
      const result = luaHost.evaluate(expression, {
        wml: { variables: nested as ScriptValue },
        wesnoth: { game_config: { random_mode: String(world.variables.random_mode ?? '') } },
      });
      return result === true || (typeof result === 'number' && result !== 0) || (typeof result === 'string' && result !== '');
    } catch {
      return false;
    }
  };

  return {
    command: {
      'command:attack': (_world, _emit, context) => {
        const attacker = requiredUnit(context.attacker, 'command:attack');
        const defender = requiredUnit(context.defender, 'command:attack');
        const attack = context.attack
          ? attacker.attacks.find((candidate) => candidate.name === context.attack)
          : [...attacker.attacks].sort((a, b) => b.damage * b.number - a.damage * a.number)[0];
        if (!attack) throw new Error(`command:attack: ${attacker.name} has no attack "${context.attack ?? ''}"`);
        const rng: Rng = engine.rng ?? Math.random;
        const outcome = attackWithRules(engine.state(), engine.data, attacker, defender, attack.name, rng);
        engine.log(`${attacker.name} attacks ${defender.name} with ${attack.name}: ${outcome.exchange.strikes.length} strikes.`);
      },
      'command:move': (_world, _emit, context) => {
        const unit = requiredUnit(context.unit, 'command:move');
        const x = integer(context.x, unit.x);
        const y = integer(context.y, unit.y);
        const result = moveUnit(engine.state(), engine.data, unit, x, y);
        if (!result.ok) throw new Error(`command:move: ${unit.name} cannot reach ${x},${y}`);
        engine.log(`${unit.name} moves to ${x},${y}.`);
      },
      'command:recruit': (_world, _emit, context) => {
        const side = integer(context.side, 1);
        const typeId = context.type ?? '';
        const x = integer(context.x, -1);
        const y = integer(context.y, -1);
        const unit = recruit(engine.state(), engine.data, side, typeId, x, y);
        if (!unit) throw new Error(`command:recruit: side ${side} cannot recruit ${typeId} at ${x},${y}`);
        engine.log(`Side ${side} recruits a ${unit.name}.`);
      },
      'command:rest_heal': (_world, _emit, context) => {
        const side = integer(context.side, 1);
        const healed = restHealSide(engine.state(), engine.data, side);
        engine.log(`Side ${side} recovers ${healed} hitpoints.`);
      },
      'command:teleport': (world, _emit, context) => {
        const selectedId = context.unit ? resolveVariablePath(world, context.unit) : '';
        const selected = selectedId ? engine.unit(selectedId) : undefined;
        const unit = selected ?? matchingUnits({
          id: context.id ? resolveVariablePath(world, context.id) : '',
          side: context.side ?? '',
          type: context.type ?? '',
          x: context.x ?? '',
          y: context.y ?? '',
        })[0];
        // WML actions silently do nothing when their filter selects no unit.
        if (!unit) return;
        const x = integer(context.to_x ?? context.x, unit.x);
        const y = integer(context.to_y ?? context.y, unit.y);
        const state = engine.state();
        const result = teleportUnit(state, engine.data, unit, x, y);
        if (!result.ok) {
          // The WML `[teleport]` action (`src/game_events/action_wml.cpp wml_action_teleport`)
          // is not the teleport ability: it moves the unit unconditionally, to the nearest
          // vacant hex when the target is occupied (`pathfind::find_vacant_tile`), costs no
          // movement and is a no-op for a target off the map. The ability path above only
          // handles the unit's own village-to-village teleport.
          if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
          const taken = (cx: number, cy: number): boolean => state.units.some((other) => other !== unit && other.hitpoints > 0 && other.x === cx && other.y === cy);
          let spot: { x: number; y: number } | undefined;
          const seen = new Set<string>([`${x},${y}`]);
          let ring = [{ x, y }];
          for (let depth = 0; depth < 6 && !spot; depth++) {
            spot = ring.find((cell) => !taken(cell.x, cell.y));
            const next: { x: number; y: number }[] = [];
            for (const cell of ring) {
              for (const n of hexNeighbors(cell.x, cell.y)) {
                if (n.x < 0 || n.y < 0 || n.x >= state.width || n.y >= state.height || seen.has(`${n.x},${n.y}`)) continue;
                seen.add(`${n.x},${n.y}`);
                next.push({ x: n.x, y: n.y });
              }
            }
            ring = next;
          }
          if (!spot) return;
          unit.x = spot.x;
          unit.y = spot.y;
          updateVision(state, engine.data);
          engine.log(`${unit.name} teleports to ${spot.x},${spot.y}.`);
          return;
        }
        engine.log(`${unit.name} teleports to ${x},${y}.`);
      },
      'command:store_unit': (world, _emit, context) => {
        if (!engine.storeUnit) throw new Error('command:store_unit is unavailable');
        const variable = context.variable ?? '';
        const handles = engine.storeUnit(variable, {
          id: context.id,
          side: context.side,
          type: context.type,
          notId: context.not_id,
          notType: context.not_type,
        }, context.kill === 'yes' || context.kill === 'true');
        // WML stores a unit as a container array, which `[foreach]` walks and `[unstore_unit]
        // variable=this_item` reads back; each element carries the handle of its stored unit.
        if (variable) (world.variables as Record<string, unknown>)[variable] = handles.map((handle) => ({ __stored: handle }));
      },
      'command:unstore_unit': (world, _emit, context) => {
        if (!engine.unstoreUnit) throw new Error('command:unstore_unit is unavailable');
        let variable = context.variable ?? '';
        const item = (world.variables as Record<string, unknown>)[variable] as { __stored?: string; side?: string | number; x?: string | number; y?: string | number } | undefined;
        let { x, y, side } = context;
        if (item && typeof item === 'object' && typeof item.__stored === 'string') {
          // An element a `[foreach]` handed out (the MODIFY_UNIT macro): its own fields are the edits.
          variable = item.__stored;
          if (item.x !== undefined) x = String(item.x);
          if (item.y !== undefined) y = String(item.y);
          if (item.side !== undefined) side = String(item.side);
        }
        engine.unstoreUnit(variable, x, y, side);
      },
      'command:put_to_recall_list': (world, _emit, context) => {
        const id = resolveVariablePath(world, context.id ?? context.unit ?? '');
        const heal = context.heal === 'yes' || context.heal === 'true';
        if (id) {
          engine.putToRecallList?.(id, heal);
          return;
        }
        let filter: SerializedVariableNode | undefined;
        try { filter = context.filter ? JSON.parse(decodeURIComponent(context.filter)) as SerializedVariableNode : undefined; } catch { return; }
        const root = filter?.attributes ?? {};
        const excluded = new Set((filter?.children ?? []).filter((child) => child.tag === 'not').flatMap((child) => child.attributes.id ? [child.attributes.id] : []));
        for (const unit of [...(engine.units?.() ?? [])]) {
          if (root.side && unit.side !== integer(root.side, unit.side)) continue;
          if (root.type && unit.typeId !== root.type) continue;
          if (excluded.has(unit.name) || excluded.has(unit.id.toString())) continue;
          engine.putToRecallList?.(unit.id.toString(), heal);
        }
      },
      'command:modify_unit': (world, _emit, context) => {
        for (const unit of matchingUnitsWithFilter(world, context)) {
          if (context.moves !== undefined) unit.movement = Math.max(0, integer(context.moves, unit.movement));
          if (context.max_hitpoints !== undefined) {
            unit.maxHitpoints = Math.max(1, integer(context.max_hitpoints, unit.maxHitpoints));
            unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints);
          }
          if (context.hitpoints !== undefined) unit.hitpoints = Math.max(1, Math.min(unit.maxHitpoints, integer(context.hitpoints, unit.hitpoints)));
          if (context.experience !== undefined) unit.experience = Math.max(0, integer(context.experience, unit.experience));
          if (context.alignment === 'lawful' || context.alignment === 'neutral' || context.alignment === 'chaotic' || context.alignment === 'liminal') unit.alignment = context.alignment;
          if (context.poisoned !== undefined) unit.poisoned = context.poisoned === 'yes' || context.poisoned === 'true';
          if (context.slowed !== undefined) unit.slowed = context.slowed === 'yes' || context.slowed === 'true';
          for (const status of ['poisoned', 'slowed', 'petrified'] as const) {
            const value = context[`status_${status}`];
            if (value !== undefined) unit[status] = value === 'yes' || value === 'true';
          }
          if (context.canrecruit !== undefined) unit.canRecruit = context.canrecruit === 'yes' || context.canrecruit === 'true';
          if (context.extra_recruit !== undefined) {
            engine.configureRecruit?.(unit.side, 'allow', interpolateWml(context.extra_recruit, variableReader(world)));
          }
          if (context.unit_name !== undefined) unit.name = context.unit_name;
          if (context.unrenamable !== undefined) unit.unrenamable = context.unrenamable === 'yes' || context.unrenamable === 'true';
          if (context.facing !== undefined) unit.facing = context.facing;
          if (context.ellipse !== undefined) unit.ellipse = context.ellipse;
          if (context.variation !== undefined) unit.variation = context.variation;
          if (context.vision !== undefined) unit.vision = integer(context.vision, unit.vision ?? 0);
          if (context.recall_filter !== undefined) {
            try { unit.recallFilter = JSON.parse(decodeURIComponent(context.recall_filter)) as Record<string, string>; } catch { /* keep prior filter */ }
          }
          if (context.unit_variables !== undefined) {
            try {
              const values = JSON.parse(decodeURIComponent(context.unit_variables)) as Record<string, string>;
              unit.variables = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateWml(value, variableReader(world))]));
            } catch { /* keep prior variables */ }
          }
          if (context.clear_variable !== undefined) {
            unit.variables ??= {};
            for (const name of interpolateWml(context.clear_variable, variableReader(world)).split(',')) {
              const key = name.trim();
              if (key) delete unit.variables[key];
            }
          }
          if (context.restore_statuses === 'yes' || context.restore_statuses === 'true') {
            unit.poisoned = false;
            unit.slowed = false;
            unit.petrified = false;
          }
          if (context.damage_type !== undefined) for (const attack of unit.attacks) attack.type = context.damage_type;
          if (context.object) {
            try {
              const object = JSON.parse(decodeURIComponent(context.object)) as ObjectDef;
              applyObject(engine.data, unit, object);
            } catch {
              // A malformed optional object must not abort an otherwise valid
              // modify_unit action, matching the engine's empty-config path.
            }
          }
        }
      },
      'command:petrify': (_world, _emit, context) => {
        for (const unit of matchingUnits(context)) unit.petrified = true;
      },
      'command:unpetrify': (_world, _emit, context) => {
        for (const unit of matchingUnits(context)) unit.petrified = false;
      },
      'command:transform_unit': (world, _emit, context) => {
        const target = resolveVariablePath(world, context.transform_to ?? context.type ?? '');
        if (!target || !engine.data.unitTypes[target]) return;
        const id = context.id ? resolveVariablePath(world, context.id).replaceAll('"', '') : '';
        for (const unit of matchingUnits({ id })) {
          const replacement = makeUnit(engine.data, target, unit.side, unit.x, unit.y);
          replacement.id = unit.id;
          replacement.wmlId = unit.wmlId;
          replacement.name = unit.name;
          replacement.hitpoints = Math.max(1, Math.min(replacement.maxHitpoints, unit.hitpoints));
          replacement.movement = Math.min(replacement.maxMovement, unit.movement);
          replacement.experience = Math.min(replacement.maxExperience, unit.experience);
          replacement.loyal = unit.loyal;
          replacement.hidden = unit.hidden;
          replacement.facing = unit.facing;
          replacement.extraAbilities = [...unit.extraAbilities];
          replacement.appliedObjects = unit.appliedObjects ? structuredClone(unit.appliedObjects) : [];
          replacement.overlays = unit.overlays ? structuredClone(unit.overlays) : [];
          const index = engine.state().units.findIndex((candidate) => candidate.id === unit.id);
          if (index >= 0) engine.state().units[index] = replacement;
          engine.replaceUnit?.(unit, replacement);
        }
      },
      'command:apply_object': (world, _emit, context) => {
        if (!context.object) return;
        try {
          const object = JSON.parse(decodeURIComponent(context.object)) as ObjectDef;
          const id = context.id ? resolveVariablePath(world, context.id) : '';
          for (const unit of matchingUnits({ id, side: context.side ?? '', type: context.type ?? '' })) {
            applyObject(engine.data, unit, object);
          }
        } catch {
          // An object with only presentation effects is a valid WML object but
          // has no simulation effect in this port.
        }
      },
      'command:remove_object': (world, _emit, context) => {
        const objectId = context.object_id ?? context.object ?? '';
        const id = context.id ? resolveVariablePath(world, context.id) : '';
        const selected = context.filter
          ? matchingUnitsWithFilter(world, context)
          : matchingUnits({ id, side: context.side ?? '', type: context.type ?? '', canrecruit: context.canrecruit ?? '' });
        for (const unit of selected) {
          if (objectId) removeObject(engine.data, unit, objectId);
          else for (const applied of [...(unit.appliedObjects ?? [])]) removeObject(engine.data, unit, applied.object.id);
        }
      },
      'command:remove_trait': (world, _emit, context) => {
        const id = context.id ? resolveVariablePath(world, context.id) : '';
        const traitId = context.trait_id ? resolveVariablePath(world, context.trait_id) : undefined;
        for (const unit of matchingUnits({ id, side: context.side ?? '', type: context.type ?? '' })) removeTrait(engine.data, unit, traitId);
      },
      'command:unit_overlay': (world, _emit, context) => {
        const id = context.id ? resolveVariablePath(world, context.id) : '';
        const image = context.image ? resolveVariablePath(world, context.image) : '';
        if (!image) return;
        for (const unit of matchingUnits({ id, side: context.side ?? '', type: context.type ?? '', x: context.x ?? '', y: context.y ?? '' })) {
          (unit.overlays ??= []).push({ image, ...(context.object_id ? { id: context.object_id } : {}) });
        }
      },
      'command:remove_unit_overlay': (world, _emit, context) => {
        const id = context.id ? resolveVariablePath(world, context.id) : '';
        const image = context.image ? resolveVariablePath(world, context.image) : '';
        const objectId = context.object_id ?? '';
        for (const unit of matchingUnits({ id, side: context.side ?? '', type: context.type ?? '', x: context.x ?? '', y: context.y ?? '' })) {
          unit.overlays = (unit.overlays ?? []).filter((overlay) => objectId ? overlay.id !== objectId : overlay.image !== image);
        }
      },
      'command:micro_ai': (world, _emit, context) => {
        // The stock micro-AIs are composites around movement/combat. Feed the
        // location-bearing variants into the same live directive channel used
        // by [ai][goal]/[avoid], so patrol/goto/guardian behaviours survive
        // event-time installation without inventing a second planner.
        const type = context.ai_type ?? '';
        const supported = new Set(['goto', 'patrol', 'zone_guardian', 'stationed_guardian', 'return_guardian', 'hang_out', 'messenger_escort']);
        if (!supported.has(type) || context.action === 'delete') return;
        const pair = context['x,y']?.split(',') ?? [];
        const xs = context.waypoint_x?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
        const ys = context.waypoint_y?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
        const x = context.goal_x ?? context.x ?? pair[0] ?? xs[0];
        const y = context.goal_y ?? context.y ?? pair[1] ?? ys[0];
        const nx = Number(resolveVariablePath(world, x ?? ''));
        const ny = Number(resolveVariablePath(world, y ?? ''));
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        const radius = Number(context.radius ?? (type === 'patrol' ? 2 : 1));
        const value = Number(context.value ?? 5);
        if (!Number.isFinite(radius) || !Number.isFinite(value)) return;
        const directive = `goal,${nx - 1},${ny - 1},${Math.max(0, radius)},${Math.max(0, value)}`;
        const current = String(world.variables.ai_directives ?? '');
        (world.variables as Record<string, string>).ai_directives = current ? `${current};${directive}` : directive;
      },
      'command:heal_unit': (_world, _emit, context) => {
        const amount = integer(context.amount, 0);
        for (const unit of matchingUnits(context)) unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints + amount);
      },
      'command:harm_unit': (world, _emit, context) => {
        const amount = Math.max(0, worldInteger(world, context.amount, 0));
        const selected = context.id ? engine.unit(context.id) : undefined;
        for (const unit of matchingUnits(context)) {
          const remaining = unit.hitpoints - amount;
          if (remaining > 0 || context.kill === 'no' || context.kill === 'false') {
            unit.hitpoints = Math.max(1, remaining);
          } else {
            unit.hitpoints = 0;
            engine.killUnit?.(selected === unit && context.id ? context.id : String(unit.id));
          }
        }
      },
      'command:kill_unit': (world, _emit, context) => {
        // `[kill]` selects whatever matches; a filter that matches nothing is a
        // no-op (the framework's own `[kill] unit=` throws instead), so the
        // scene removes the unit only when it is present.
        const id = context.unit ?? context.id;
        if (id) engine.killUnit?.(id);
        if (context.filter) {
          const filter = decodeFilter(context.filter);
          if (!filter) return;
          const scope = filterWorld(world);
          for (const unit of [...(engine.units?.() ?? [])]) {
            if (unit.hitpoints > 0 && matchesUnitFilter(filter, unit, scope)) engine.killUnit?.(unit.name || String(unit.id));
          }
        }
        if (!id && !context.filter && context.all === 'yes') {
          for (const unit of [...(engine.units?.() ?? [])]) {
            if (unit.hitpoints > 0) engine.killUnit?.(unit.name || String(unit.id));
          }
        }
      },
      'command:scenario_move': (world, _emit, context) => {
        for (const unit of matchingUnits({ ...context, id: context.id ? resolveVariablePath(world, context.id) : context.id })) {
          unit.x = context.raw === 'yes' ? worldInteger(world, context.x, unit.x + 1) - 1 : integer(context.x, unit.x);
          unit.y = context.raw === 'yes' ? worldInteger(world, context.y, unit.y + 1) - 1 : integer(context.y, unit.y);
        }
      },
      'command:capture_village': (_world, _emit, context) => {
        const side = integer(context.side, 1);
        for (const cell of cells(context.cells)) {
          const index = cell.y * engine.state().width + cell.x;
          if (index >= 0 && index < engine.state().villageOwner.length) engine.state().villageOwner[index] = side;
        }
      },
      'command:set_terrain': (_world, _emit, context) => {
        for (const cell of cells(context.cells)) {
          // Through the state's own setter, so the terrain revision (and with it
          // every cached sight set) moves.
          if (context.terrain) setTerrainAt(engine.state(), cell.x, cell.y, context.terrain);
        }
      },
      'command:terrain_mask': (world, _emit, context) => {
        const originX = integer(context.x, 1) - 1;
        const originY = integer(context.y, 1) - 1;
        let mask = '';
        try { mask = decodeURIComponent(context.mask ?? ''); } catch { return; }
        if (!mask && context.mask_file && context.masks) {
          try {
            const file = interpolateWml(decodeURIComponent(context.mask_file), variableReader(world));
            const files = JSON.parse(decodeURIComponent(context.masks)) as Record<string, string>;
            mask = files[file] ?? files[file.replace(/^.*[\\/]/, '')] ?? '';
          } catch { return; }
        }
        const rows = mask.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
        const state = engine.state();
        for (let row = 0; row < rows.length; row++) {
          const cells = rows[row].split(',').map((cell) => cell.trim());
          for (let column = 0; column < cells.length; column++) {
            const code = cells[column];
            if (!code || code === '_f' || code === '*') continue;
            const x = originX + column;
            const y = originY + row;
            if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
            // Mask entries such as `4 Ke` carry a terrain probability prefix;
            // the final terrain code is the value applied by this lightweight
            // deterministic port.
            const terrain = code.split(/\s+/).at(-1) ?? code;
            setTerrainAt(state, x, y, terrain);
          }
        }
      },
      'command:replace_map': (_world, _emit, context) => {
        let text = '';
        try { text = decodeURIComponent(context.terrain ?? ''); } catch { return; }
        const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
        if (!rows.length) return;
        const parsed = rows.map((row) => row.split(',').map((cell) => {
          const value = cell.trim();
          return value.split(/\s+/).at(-1) ?? value;
        }));
        const width = Math.max(...parsed.map((row) => row.length));
        const height = parsed.length;
        if (!width || !height) return;
        const state = engine.state();
        state.width = width;
        state.height = height;
        state.terrainCodes = Array.from({ length: width * height }, (_, index) => parsed[Math.floor(index / width)]?.[index % width] ?? 'Gg');
        state.villageOwner = Array.from({ length: width * height }, () => null);
        state.keeps = new Map();
        state.fog = new FactionFog(width, height);
        state.forcedShroud = {};
        state.terrainVersion = (state.terrainVersion ?? 0) + 1;
        for (const unit of state.units) {
          if (unit.x >= width) unit.x = Math.max(0, width - 1);
          if (unit.y >= height) unit.y = Math.max(0, height - 1);
        }
      },
      'command:replace_map_section': (_world, _emit, context) => {
        let text = '';
        try { text = decodeURIComponent(context.terrain ?? ''); } catch { return; }
        const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
        const originX = integer(context.x, 1) - 1;
        const originY = integer(context.y, 1) - 1;
        const state = engine.state();
        for (let row = 0; row < rows.length; row++) {
          const cells = rows[row].split(',').map((cell) => cell.trim());
          for (let column = 0; column < cells.length; column++) {
            const x = originX + column;
            const y = originY + row;
            if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
            const code = cells[column];
            if (code && code !== '_' && code !== '*') setTerrainAt(state, x, y, code.split(/\s+/).at(-1) ?? code);
          }
        }
      },
      'command:clear_shroud': (_world, _emit, context) => {
        const side = integer(context.side, 1);
        const faction = teamOf(engine.state(), side);
        const xs = axis(context.xs);
        const ys = axis(context.ys);
        const revealed = [];
        for (const y of ys) for (const x of xs) revealed.push({ x, y });
        const forced = new Set(engine.state().forcedShroud?.[faction] ?? []);
        for (const cell of revealed) forced.delete(`${cell.x},${cell.y}`);
        (engine.state().forcedShroud ??= {})[faction] = [...forced];
        engine.state().fog.reveal(faction, revealed);
      },
      'command:add_item': (world, _emit, context) => {
        const x = worldInteger(world, context.x, Number.NaN) - 1;
        const y = worldInteger(world, context.y, Number.NaN) - 1;
        const state = engine.state();
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= state.width || y >= state.height) return;
        let image = '';
        try { image = context.image ? decodeURIComponent(context.image) : ''; } catch { image = context.image ?? ''; }
        state.items.push({ x, y, name: context.item_name || undefined, image, object: { id: '', effects: [], abilities: [] }, taken: false });
      },
      'command:remove_item': (world, _emit, context) => {
        const x = context.x ? worldInteger(world, context.x, Number.NaN) - 1 : undefined;
        const y = context.y ? worldInteger(world, context.y, Number.NaN) - 1 : undefined;
        const name = context.item_name || undefined;
        let image: string | undefined;
        try { image = context.image ? decodeURIComponent(context.image) : undefined; } catch { image = context.image || undefined; }
        engine.state().items = engine.state().items.filter((item) => {
          if (x !== undefined && item.x !== x) return true;
          if (y !== undefined && item.y !== y) return true;
          if (name && item.name !== name) return true;
          if (image && item.image !== image) return true;
          return false;
        });
      },
      'command:store_items': (world, emit, context) => {
        const x = context.x ? worldInteger(world, context.x, Number.NaN) - 1 : undefined;
        const y = context.y ? worldInteger(world, context.y, Number.NaN) - 1 : undefined;
        const name = context.item_name || undefined;
        const stored = engine.state().items
          .filter((item) => !item.taken && (x === undefined || item.x === x) && (y === undefined || item.y === y) && (!name || item.name === name))
          .map((item) => ({ x: item.x + 1, y: item.y + 1, name: item.name ?? '', image: item.image }));
        emit.setVariable(context.variable ?? '', toMwlValue(stored as unknown as WmlValue));
      },
      'command:place_shroud': (_world, _emit, context) => {
        const state = engine.state();
        const side = integer(context.side, 1);
        const faction = teamOf(state, side);
        const xs = axis(context.xs);
        const ys = axis(context.ys);
        const radius = Number(context.radius ?? 0);
        const centers = [];
        for (const y of ys) for (const x of xs) centers.push({ x, y });
        const forced = new Set(state.forcedShroud?.[faction] ?? []);
        for (const center of centers) {
          for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
            if (radius > 0 && hexDistance(center, { x, y }) > radius) continue;
            if (radius <= 0 && (x !== center.x || y !== center.y)) continue;
            forced.add(`${x},${y}`);
          }
        }
        (state.forcedShroud ??= {})[faction] = [...forced];
        updateVision(state, engine.data);
      },
      'command:reset_fog': () => {
        // Rebuild current visibility from the live units. The framework fog
        // object retains explored/shroud memory while replacing visible cells,
        // matching Wesnoth's reset_fog action.
        updateVision(engine.state(), engine.data);
      },
      'command:lift_fog': (_world, _emit, context) => {
        const state = engine.state();
        const side = integer(context.side, 1);
        const faction = teamOf(state, side);
        const selectedCells = cells(context.cells);
        const terrain = context.terrain ?? '';
        const radius = Number(context.radius ?? 0);
        const candidates = selectedCells.length ? selectedCells : Array.from({ length: state.width * state.height }, (_, index) => ({ x: index % state.width, y: Math.floor(index / state.width) }));
        const selected = new Map<string, { x: number; y: number }>();
        for (const cell of candidates) {
          if (terrain && !terrainMatches(encodeCode(state.terrainCodes[cell.y * state.width + cell.x] ?? ''), parseTerrainList(terrain))) continue;
          if (context.owner_side && state.villageOwner[cell.y * state.width + cell.x] !== integer(context.owner_side, -1)) continue;
          for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
            if (radius > 0 && hexDistance(cell, { x, y }) > radius) continue;
            if (radius <= 0 && (x !== cell.x || y !== cell.y)) continue;
            selected.set(`${x},${y}`, { x, y });
          }
        }
        state.fogLifts ??= {};
        const untilTurn = context.multiturn === 'yes' || context.multiturn === 'true' ? Number.POSITIVE_INFINITY : state.turn;
        const prior = state.fogLifts[faction] ?? [];
        state.fogLifts[faction] = [...prior.filter((entry) => entry.untilTurn < state.turn), ...[...selected.values()].map((cell) => ({ ...cell, untilTurn }))];
      },
      'command:config_side': (_world, _emit, context) => {
        const side = integer(context.side, 1);
        const attributes = { ...context };
        delete attributes.side;
        if (context.village_support !== undefined) {
          const value = Number(context.village_support);
          if (Number.isFinite(value)) (engine.state().sideRules ??= {})[side] = { ...(engine.state().sideRules?.[side] ?? {}), villageSupport: Math.max(0, Math.trunc(value)) };
        }
        engine.configureSide?.(side, attributes);
      },
      'command:config_recruit': (_world, _emit, context) => {
        engine.configureRecruit?.(integer(context.side, 1), context.mode === 'disallow' ? 'disallow' : 'allow', context.types ?? '');
      },
      'command:allow_extra_recruit': (world, _emit, context) => {
        const id = resolveVariablePath(world, context.id ?? '');
        const state = engine.state();
        const unit = id
          ? engine.unit(id)
          : state.units.find((candidate) => candidate.x === integer(context.x, -1) - 1 && candidate.y === integer(context.y, -1) - 1);
        if (!unit) return;
        const types = interpolateWml(context.types ?? '', variableReader(world)).split(',').map((type) => type.trim()).filter(Boolean);
        const previous = unit.extraRecruit ?? [];
        unit.extraRecruit = types;
        if (previous.length) engine.configureRecruit?.(unit.side, 'disallow', previous.join(','));
        if (types.length) engine.configureRecruit?.(unit.side, 'allow', types.join(','));
      },
      'command:modify_ai': (world, _emit, context) => {
        const action = context.action ?? '';
        const path = context.path ?? '';
        const list = (name: string): string[] => String(world.variables[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
        const writeList = (name: string, values: readonly string[]): void => {
          (world.variables as Record<string, string>)[name] = [...new Set(values)].join(',');
        };
        const candidate = context.candidate ?? /candidate_action\[([^\]]+)\]/.exec(path)?.[1];
        if (candidate && /candidate_action\[/.test(path)) {
          if (action === 'delete') writeList('ai_candidate_off', [...list('ai_candidate_off'), candidate]);
          else if (action === 'add') {
            writeList('ai_candidates', [...list('ai_candidates'), candidate]);
            writeList('ai_candidate_off', list('ai_candidate_off').filter((value) => value !== candidate));
          }
          return;
        }
        if (action === 'add' && context.goal_kind) {
          const x = Number(context.goal_x);
          const y = Number(context.goal_y);
          const radius = Number(context.goal_radius ?? 0);
          const value = Number(context.goal_value ?? (context.goal_kind === 'avoid' ? 10 : 1));
          if (Number.isFinite(radius) && Number.isFinite(value)) {
            const point = Number.isFinite(x) && Number.isFinite(y) ? `${x - 1},${y - 1}` : ',,';
            const directive = `${context.goal_kind},${point},${Math.max(0, radius)},${Math.max(0, value)}`;
            const current = String(world.variables.ai_directives ?? '');
            (world.variables as Record<string, string>).ai_directives = current ? `${current};${directive}` : directive;
          }
        }
      },
      'command:modify_gold': (world, _emit, context) => {
        engine.addGold?.(integer(context.side, 1), worldInteger(world, context.amount, 0));
      },
      'command:store_gold': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? 'gold');
        if (!variable) return;
        const side = integer(context.side, 1);
        const amount = engine.gold?.(side);
        if (amount !== undefined) emit.setVariable(variable, amount);
      },
      'command:store_side': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? 'side');
        const side = resolveVariablePath(world, context.side ?? '1');
        if (!variable || !side) return;
        const stored = world.sides[side];
        if (stored !== undefined) emit.setVariable(variable, stored);
      },
      'command:store_unit_type_ids': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? 'unit_type_ids');
        if (!variable) return;
        emit.setVariable(variable, Object.keys(engine.data.unitTypes).sort().join(','));
      },
      'command:store_unit_type': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? 'unit_type');
        if (!variable) return;
        const types = (context.types ?? '').split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
        const snapshots = types.map((id) => {
          const type = engine.data.unitTypes[id];
          if (!type) return undefined;
          return {
            id: type.id,
            name: type.name,
            image: type.image,
            hitpoints: type.hitpoints,
            movement: type.movement,
            movement_type: type.movementType,
            experience: type.experience,
            level: type.level,
            alignment: type.alignment,
            advances_to: type.advancesTo.join(','),
            cost: type.cost,
            race: type.race,
          };
        }).filter((value): value is NonNullable<typeof value> => value !== undefined);
        if (!snapshots.length) return;
        emit.setVariable(variable, snapshots.length === 1 ? snapshots[0] : snapshots);
      },
      'command:unit_worth': (world, emit, context) => {
        let node: SerializedVariableNode | undefined;
        try { node = context.filter ? JSON.parse(decodeURIComponent(context.filter)) as SerializedVariableNode : undefined; } catch { return; }
        const attrs = node?.attributes ?? {};
        const id = attrs.id ? resolveVariablePath(world, attrs.id).replaceAll('"', '') : '';
        const candidates = matchingUnits({
          id,
          side: attrs.side ?? '',
          type: attrs.type ?? '',
        }).filter((unit) => {
          const x = attrs.x ? axis(attrs.x).map((value) => value - 1) : undefined;
          const y = attrs.y ? axis(attrs.y).map((value) => value - 1) : undefined;
          return (!x || x.includes(unit.x)) && (!y || y.includes(unit.y));
        });
        const unit = candidates[0];
        if (!unit) return;
        const type = engine.data.unitTypes[unit.typeId];
        if (!type) return;
        const health = type.hitpoints > 0 ? unit.hitpoints / unit.maxHitpoints : 0;
        const experience = unit.maxExperience > 0 ? unit.experience / unit.maxExperience : 0;
        let nextCost = type.cost;
        for (const target of type.advancesTo) {
          const advancement = engine.data.unitTypes[target];
          if (advancement) nextCost = Math.max(nextCost, advancement.cost);
        }
        emit.setVariable('cost', type.cost);
        emit.setVariable('next_cost', nextCost);
        emit.setVariable('health', Math.floor(health * 100));
        emit.setVariable('experience', Math.floor(experience * 100));
        // Unit types do not currently carry per-unit recall costs in MWG;
        // Wesnoth's default is 20 gold, while scenario overrides are stored
        // on the unit and are handled by the native unstore/recruit path.
        emit.setVariable('recall_cost', 20);
        emit.setVariable('unit_worth', Math.floor(Math.max(type.cost * health, nextCost * experience)));
      },
      'command:spawn_unit': (world, _emit, context) => {
        const id = context.unit ?? '';
        const entry = id ? world.units[id] : undefined;
        if (!entry || !entry.type || entry.side === undefined) return;
        engine.spawnUnit?.(id, entry.type, Number(entry.side), entry.x, entry.y);
      },
      // A `[unit] type=$variable` spawn (Sceptre of Fire's `WINTERENEMY`
      // picks `$typeofenemy` from a `rand=` list first) cannot be resolved at
      // load time. Resolve the type against the live variables, then register
      // the world entry and hand it to the rules engine, the same two steps
      // the loader emits for a static spawn.
      'command:spawn_dynamic': (world, emit, context) => {
        const type = resolveVariablePath(world, context.type ?? '').trim();
        if (!type || !engine.data.unitTypes[type]) return;
        const side = integer(context.side, 1);
        const x = worldInteger(world, context.x, Number.NaN) - 1;
        const y = worldInteger(world, context.y, Number.NaN) - 1;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        // `emit.spawn` creates the runtime world entry under the same generated
        // id the scene's spawn uses, so both halves agree.
        emit.spawn(type, String(side), x, y);
        engine.spawnUnit?.(context.id || `${type}#${side}@${x},${y}`, type, side, x, y);
      },
      // `[set_variable] rand=A,B,C` picks one list entry, repetition weighting
      // it (Wesnoth's own `rand=` semantics); the pick feeds a later
      // `command:spawn_dynamic` through the variable it is stored in.
      'command:set_variable_rand': (world, _emit, context) => {
        const name = resolveVariablePath(world, context.variable ?? '');
        if (!name) return;
        const values = (context.values ?? '').split(',').map((value) => value.trim()).filter(Boolean);
        if (!values.length) return;
        const rng = engine.rng ?? Math.random;
        const pick = values[Math.min(values.length - 1, Math.max(0, Math.floor(rng() * values.length)))];
        (world.variables as Record<string, string | number | boolean>)[name] = pick;
      },
      'command:get_global_variable': (world, emit, context) => {
        const name = (value: string | undefined): string => value?.includes('$') ? resolveVariablePath(world, value) : (value ?? '');
        const namespace = name(context.namespace);
        const from = name(context.from_global);
        const local = name(context.to_local);
        if (!local) return;
        const key = namespace ? `${namespace}.${from}` : from;
        const value = engine.globalVariables?.[key];
        emit.setVariable(local, value === undefined ? '' : structuredClone(value));
      },
      'command:set_global_variable': (world, _emit, context) => {
        const name = (value: string | undefined): string => value?.includes('$') ? resolveVariablePath(world, value) : (value ?? '');
        const namespace = name(context.namespace);
        const from = name(context.from_local);
        const to = name(context.to_global);
        if (!to || !engine.globalVariables) return;
        const key = namespace ? `${namespace}.${to}` : to;
        // `variableReader` intentionally narrows arbitrary objects for scalar
        // expressions; global WML variables must preserve tables as well.
        const value = world.variables[from] ?? world.variableAt?.(from) as MwlValue | undefined;
        if (value === undefined) delete engine.globalVariables[key];
        else engine.globalVariables[key] = structuredClone(value) as MwlValue;
      },
      'command:recall_unit': (_world, _emit, context) => {
        // The recall list first (HttT puts Konrad on it, then `[recall] id=Konrad x= y=`), then a
        // unit a scenario stored itself.
        const recalled = engine.recallUnitByFilter?.({ id: context.id, type: context.type, role: context.role, x: context.x, y: context.y });
        if (!recalled && context.unit) engine.recallUnit?.(context.unit);
      },
      'command:make_loyal': (_world, _emit, context) => {
        const ids = (context.units ?? context.unit ?? '').split(',').map((id) => id.trim()).filter(Boolean);
        for (const id of ids) engine.makeLoyal?.(id);
      },
      'command:set_achievement': (_world, _emit, context) => {
        if (context.id) engine.setAchievement?.(context.id);
      },
      'command:fire_event': (_world, _emit, context) => {
        if (context.event) engine.fireEvent?.(context.event);
      },
      'command:show_halo': (_world, _emit, context) => {
        if (!context.image) return;
        const x = Number(context.x);
        const y = Number(context.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const duration = Number(context.duration ?? 1);
        const frames = (context.frames ?? '').split(';').map((entry) => {
          const separator = entry.lastIndexOf('@');
          if (separator <= 0) return null;
          const frameDuration = Number(entry.slice(separator + 1));
          return Number.isFinite(frameDuration) ? { image: entry.slice(0, separator), duration: Math.max(0.01, frameDuration) } : null;
        }).filter((frame): frame is { image: string; duration: number } => frame !== null);
        engine.showHalo?.(context.image, x, y, Number.isFinite(duration) ? Math.max(0, duration) : 1, frames.length ? frames : undefined);
      },
      'command:show_objectives': () => {},
      'command:delay': (_world, _emit, context) => {
        const seconds = Number(context.time ?? context.duration ?? context.seconds ?? 0);
        if (Number.isFinite(seconds) && seconds > 0) engine.delay?.(seconds);
      },
      'command:scroll_to': (world, _emit, context) => {
        const x = integer(resolveVariablePath(world, context.x ?? ''), -1);
        const y = integer(resolveVariablePath(world, context.y ?? ''), -1);
        if (x >= 0 && y >= 0) engine.scrollTo?.(x, y);
      },
      'command:scroll_to_unit': (world, _emit, context) => {
        const id = resolveVariablePath(world, context.id ?? context.unit ?? '');
        const unit = id ? engine.unit(id) : undefined;
        if (unit) engine.scrollTo?.(unit.x, unit.y);
      },
      'command:replace_schedule': (world, _emit, context) => {
        let root: SerializedVariableNode | undefined;
        try { root = context.schedule ? JSON.parse(decodeURIComponent(context.schedule)) as SerializedVariableNode : undefined; } catch { return; }
        const times: TimeOfDayDef[] = (root?.children ?? [])
          .filter((child) => child.tag === 'time')
          .map((child) => ({
            id: interpolateWml(child.attributes.id ?? '', variableReader(world)),
            name: interpolateWml(child.attributes.name ?? '', variableReader(world)),
            lawfulBonus: worldInteger(world, child.attributes.lawful_bonus, 0),
          }))
          .filter((time) => time.id !== '');
        if (!times.length) return;
        const state = engine.state();
        const scheduleId = `__wml_schedule_${times.map((time) => `${time.id}:${time.lawfulBonus}`).join('|')}`;
        state.customSchedules ??= {};
        state.customSchedules[scheduleId] = times;
        state.scheduleId = scheduleId;
        const current = context.current_time ? interpolateWml(context.current_time, variableReader(world)) : '';
        const index = current ? times.findIndex((time) => time.id === current) : -1;
        if (index >= 0) state.scheduleIndex = index;
        engine.log(`Schedule replaced with ${times.length} times of day.`);
      },
      'command:set_time_area': (world, _emit, context) => {
        let root: SerializedVariableNode | undefined;
        try { root = context.area ? JSON.parse(decodeURIComponent(context.area)) as SerializedVariableNode : undefined; } catch { return; }
        const times: TimeOfDayDef[] = (root?.children ?? [])
          .filter((child) => child.tag === 'time')
          .map((child) => ({
            id: interpolateWml(child.attributes.id ?? '', variableReader(world)),
            name: interpolateWml(child.attributes.name ?? '', variableReader(world)),
            lawfulBonus: worldInteger(world, child.attributes.lawful_bonus, 0),
          }))
          .filter((time) => time.id !== '');
        if (!times.length) return;
        const state = engine.state();
        const id = interpolateWml(root?.attributes.id ?? '', variableReader(world));
        const area = { id, xs: interpolateWml(root?.attributes.x ?? '', variableReader(world)), ys: interpolateWml(root?.attributes.y ?? '', variableReader(world)), times };
        state.timeAreas = [...state.timeAreas.filter((entry) => !id || entry.id !== id), area];
      },
      'command:remove_time_area': (_world, _emit, context) => {
        const id = context.id ?? '';
        const state = engine.state();
        state.timeAreas = id ? state.timeAreas.filter((area) => area.id !== id) : [];
      },
      'command:store_time_of_day': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable) return;
        const schedule = activeSchedule(engine.data, engine.state());
        const time = schedule[engine.state().scheduleIndex] ?? schedule[0];
        if (!time) return;
        emit.setVariable(variable, {
          id: time.id,
          name: time.name,
          lawful_bonus: time.lawfulBonus,
        });
      },
      'command:set_variables': (world, emit, context) => {
        const raw = context.payload;
        if (!raw) return;
        let payload: {
          name?: string;
          mode?: string;
          to_variable?: string;
          children?: SerializedVariableNode[];
        };
        try {
          payload = JSON.parse(decodeURIComponent(raw)) as typeof payload;
        } catch {
          return;
        }
        const name = resolveVariablePath(world, payload.name ?? '');
        if (!name) return;
        const scope = variableReader(world);
        const children = payload.children ?? [];
        const scalar = (value: string, literal: boolean): MwlValue =>
          literal ? value : wmlScalar(interpolateWml(value, scope)) as MwlValue;
        const valueOf = (node: SerializedVariableNode, literal = false): MwlValue => {
          const result: Record<string, MwlValue> = {};
          for (const [key, value] of Object.entries(node.attributes ?? {})) {
            result[key] = scalar(value, literal || node.tag === 'literal');
          }
          for (const child of node.children ?? []) {
            const childValue = valueOf(child, literal || node.tag === 'literal');
            const previous = result[child.tag];
            result[child.tag] = previous === undefined
              ? childValue
              : Array.isArray(previous) ? [...previous, childValue] : [previous, childValue];
          }
          return Object.keys(result).length ? result : '';
        };
        const split = children.find((child) => child.tag === 'split');
        let entries: MwlValue[];
        if (split) {
          const list = interpolateWml(split.attributes.list ?? '', scope);
          const separator = split.attributes.separator ?? ',';
          entries = list.split(separator).filter((entry) => entry !== '').map((entry) => ({
            [split.attributes.key ?? 'value']: wmlScalar(entry.trim()) as MwlValue,
          }));
        } else {
          entries = children
            .filter((child) => child.tag === 'value' || child.tag === 'literal')
            .map((child) => valueOf(child));
        }
        if (payload.to_variable && !entries.length) {
          const source = scope(resolveVariablePath(world, payload.to_variable));
          emit.setVariable(name, source === undefined ? '' : source as MwlValue);
          return;
        }
        if (payload.mode === 'append') {
          // `variableReader` intentionally exposes the WFL-compatible scalar
          // subset; append must also preserve object/array roots created by a
          // previous `[set_variables]` command.
          const current = world.variables[name] as MwlValue | undefined;
          const prior = Array.isArray(current) ? current : current === undefined ? [] : [current];
          emit.setVariable(name, [...prior, ...entries]);
        } else {
          emit.setVariable(name, entries);
        }
      },
      'command:store_locations': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable) return;
        const decode = (text: string | undefined): SerializedVariableNode | undefined => {
          if (!text) return undefined;
          try { return JSON.parse(decodeURIComponent(text)) as SerializedVariableNode; } catch { return undefined; }
        };
        const root = decode(context.filter);
        const state = engine.state();
        const expanded = (text: string | undefined): string => interpolateWml(text ?? '', variableReader(world));
        const inRange = (value: number, spec: string): boolean => expanded(spec).split(',').some((part) => {
          const match = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(part);
          if (match) return value >= Number(match[1]) - 1 && value <= Number(match[2]) - 1;
          return /^\s*-?\d+\s*$/.test(part) && value === Number(part.trim()) - 1;
        });
        const terrain = (x: number, y: number): string => state.terrainCodes[y * state.width + x] ?? '';
        const terrainTest = (x: number, y: number, spec: string | undefined): boolean =>
          !spec || terrainMatches(encodeCode(terrain(x, y)), parseTerrainList(expanded(spec)));
        const matches = (node: SerializedVariableNode | undefined, x: number, y: number): boolean => {
          if (!node) return true;
          let result = terrainTest(x, y, node.attributes.terrain);
          if (node.attributes.include_borders === 'no' && (x === 0 || y === 0 || x === state.width - 1 || y === state.height - 1)) result = false;
          if (node.attributes.radius !== undefined && node.attributes.x !== undefined && node.attributes.y !== undefined) {
            const cx = Number(expanded(node.attributes.x)) - 1;
            const cy = Number(expanded(node.attributes.y)) - 1;
            if (Number.isFinite(cx) && Number.isFinite(cy)) result = result && hexDistance({ x, y }, { x: cx, y: cy }) <= Number(expanded(node.attributes.radius));
          } else {
            if (node.attributes.x !== undefined) result = result && inRange(x, node.attributes.x);
            if (node.attributes.y !== undefined) result = result && inRange(y, node.attributes.y);
          }
          for (const child of node.children ?? []) {
            const childResult = child.tag === 'filter'
              ? matchingUnits({ id: child.attributes.id ?? '', side: child.attributes.side ?? '', type: child.attributes.type ?? '' })
                .some((unit) => unit.x === x && unit.y === y)
              : child.tag === 'filter_location' || child.tag === 'filter_radius'
              ? matches(child, x, y)
              : child.tag === 'filter_adjacent_location'
              ? hexNeighbors(x, y).filter(({ x: nx, y: ny }) => nx >= 0 && ny >= 0 && nx < state.width && ny < state.height && matches(child, nx, ny)).length >= Number(child.attributes.count?.split('-')[0] ?? 1)
                : matches(child, x, y);
            if (child.tag === 'or') result = result || childResult;
            else if (child.tag === 'not') result = result && !childResult;
            else result = result && childResult;
          }
          return result;
        };
        const locations: MwlValue[] = [];
        for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
          if (matches(root, x, y)) locations.push({ x: x + 1, y: y + 1 });
        }
        emit.setVariable(variable, locations);
      },
      'command:random_count': (world, emit, context) => {
        const source = (context.source ?? '').trim().replace(/^\$/, '');
        const variable = (context.variable ?? '').trim().replace(/^\$/, '');
        if (!source || !variable) return;
        const values = world.variables[source] ?? world.variableAt?.(source);
        const size = Array.isArray(values) ? values.length : 0;
        const scope = variableReader(world);
        const expanded = interpolateWml(context.expr ?? '', scope);
        let evaluated = Number(expanded);
        if (!Number.isFinite(evaluated)) try {
          evaluated = Number(evaluateWmlFormula(expanded, (path) => (path === 'size' ? size : scope(path))));
        } catch {
          // a formula the WML evaluator cannot read places every location
        }
        // A formula that does not resolve, or divides by zero, places every location.
        let count = Number.isFinite(evaluated) ? Math.trunc(evaluated) : size;
        if (context.allow_less !== 'no') count = Math.min(count, size);
        emit.setVariable(variable, Math.max(0, count));
      },
      'command:random_location': (world, emit, context) => {
        const source = (context.source ?? '').trim().replace(/^\$/, '');
        const variable = (context.variable ?? '').trim().replace(/^\$/, '');
        if (!source || !variable) return;
        // Location arrays contain object entries (`{x,y}`), which are intentionally
        // outside the scalar WML evaluator type. Read the raw framework value here.
        const values = world.variables[source] ?? world.variableAt?.(source);
        if (!Array.isArray(values) || values.length === 0) return;
        const index = Math.min(values.length - 1, Math.floor((engine.rng?.() ?? Math.random()) * values.length));
        const picked = values[index];
        emit.setVariable(variable, picked as MwlValue);
        emit.setVariable(source, values.filter((_value, candidate) => candidate !== index));
      },
      'command:find_respawn_point': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable) return;
        const requested = resolveVariablePath(world, context.respawn_near ?? '');
        const state = engine.state();
        const liveUnits = engine.units?.() ?? state.units;
        const anchor = engine.unit(requested) ?? liveUnits.find((unit) => unit.name === requested)
          ?? engine.unit('Tallin') ?? liveUnits.find((unit) => unit.name === 'Tallin');
        if (!anchor) return;
        const blocked = new Set(liveUnits.filter((unit) => unit.hitpoints > 0).map((unit) => `${unit.x},${unit.y}`));
        const forbidden = parseTerrainList('Wo,*^Xm,*^Xo,X*,Q*');
        for (let radius = 1; radius <= state.width + state.height; radius++) {
          for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
            if (x === 0 || y === 0 || x === state.width - 1 || y === state.height - 1) continue;
            if (hexDistance(anchor, { x, y }) > radius || blocked.has(`${x},${y}`)) continue;
            const code = encodeCode(state.terrainCodes[y * state.width + x] ?? '');
            if (terrainMatches(code, forbidden)) continue;
            emit.setVariable(variable, { x: x + 1, y: y + 1 } as MwlValue);
            return;
          }
        }
      },
      'command:store_turns': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable) return;
        const limit = Number(variableReader(world)('turn_limit') ?? world.variables.turn_limit ?? 0);
        const turn = Number(world.turn ?? engine.state().round ?? 1);
        emit.setVariable(variable, limit > 0 ? Math.max(0, Math.trunc(limit - turn + 1)) : -1);
      },
      'command:store_villages': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable) return;
        const state = engine.state();
        const villages: MwlValue[] = [];
        for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
          const terrain = resolveTerrain(engine.data, undefined, state.terrainCodes[y * state.width + x] ?? 'Gg');
          if (terrain.isVillage) villages.push({ x: x + 1, y: y + 1, side: state.villageOwner[y * state.width + x] ?? 0 });
        }
        emit.setVariable(variable, villages);
      },
      'command:set_village_owner': (_world, _emit, context) => {
        const side = integer(context.side, 0);
        if (!side) return;
        for (const cell of cells(context.cells)) {
          const x = cell.x;
          const y = cell.y;
          if (x >= 0 && y >= 0 && x < engine.state().width && y < engine.state().height) {
            engine.state().villageOwner[y * engine.state().width + x] = side;
          }
        }
      },
      'command:store_reachable_locations': (world, emit, context) => {
        const variable = resolveVariablePath(world, context.variable ?? '');
        if (!variable || !context.filter) return;
        let root: SerializedVariableNode;
        try { root = JSON.parse(decodeURIComponent(context.filter)) as SerializedVariableNode; } catch { return; }
        const state = engine.state();
        const unitFilter = root.children.find((child) => child.tag === 'filter');
        const locationFilter = root.children.find((child) => child.tag === 'filter_location');
        const selected = unitFilter
          ? matchingUnits({
            id: unitFilter.attributes.id ?? '',
            side: unitFilter.attributes.side ?? '',
            type: unitFilter.attributes.type ?? '',
          })
          : [];
        const inRange = (value: number, spec: string): boolean => interpolateWml(spec, variableReader(world)).split(',').some((part) => {
          const range = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(part);
          if (range) return value >= Number(range[1]) - 1 && value <= Number(range[2]) - 1;
          return value === Number(part.trim()) - 1;
        });
        const terrainOk = (x: number, y: number): boolean => {
          const terrain = locationFilter?.attributes.terrain;
          return !terrain || terrainMatches(encodeCode(state.terrainCodes[y * state.width + x] ?? ''), parseTerrainList(interpolateWml(terrain, variableReader(world))));
        };
        const locationOk = (x: number, y: number): boolean => {
          if (!locationFilter) return true;
          if (locationFilter.attributes.x !== undefined && !inRange(x, locationFilter.attributes.x)) return false;
          if (locationFilter.attributes.y !== undefined && !inRange(y, locationFilter.attributes.y)) return false;
          if (!terrainOk(x, y)) return false;
          const occupied = engine.units?.().find((candidate) => candidate.x === x && candidate.y === y && candidate.hitpoints > 0);
          const nestedFilter = locationFilter.children.find((child) => child.tag === 'filter');
          if (nestedFilter && !occupied) return false;
          if (nestedFilter?.attributes.id && occupied?.wmlId !== nestedFilter.attributes.id && occupied?.name !== nestedFilter.attributes.id) return false;
          return !occupied || nestedFilter !== undefined;
        };
        const locations = new Map<string, MwlValue>();
        for (const unit of selected) {
          const movement = context.moves === 'max' ? unit.maxMovement : unit.movement;
          for (const key of reachable(state, engine.data, unit, { ignoreTurn: true, movement }).keys()) {
            const [x, y] = key.split(',').map(Number);
            if (locationOk(x, y)) locations.set(key, { x: x + 1, y: y + 1 });
          }
        }
        emit.setVariable(variable, [...locations.values()]);
      },
      'command:set_unit_hidden': (world, _emit, context) => {
        const id = context.id ? resolveVariablePath(world, context.id) : '';
        const selected = matchingUnits({ id, side: context.side ?? '', type: context.type ?? '' });
        for (const unit of selected) unit.hidden = context.hidden === 'yes' || context.hidden === 'true';
      },
      // WML's `[set_variable]` is interpolation plus arithmetic, not MWL's arithmetic-only
      // `value=` guess, so the loader hands the raw WML text over and this decides what each
      // operation means. The `mode` is one attribute of `[set_variable]` (`add`, `round`, ...).
      //
      // Every write goes through `emit.setVariable`, never `world.variables[name]`: `name` is a
      // path (`stored_naga.hitpoints`, `party[0].name`), and assigning it as a key writes one flat
      // dotted string that no scenario's `[variable] name=stored_naga.hitpoints` can find, since
      // that reads through the framework's own walker. Reads come back through `variableReader`,
      // which asks the same walker, so a hook and the content agree on what a path means.
      'command:set_variable_dynamic': (world, emit, context) => {
        const name = resolveVariablePath(world, context.variable ?? context.name ?? '');
        if (!name) return;
        const scope = variableReader(world);
        const current = scope(name);
        const write = (value: WmlValue): void => emit.setVariable(name, toMwlValue(value));
        const operand = () => interpolateWml(context.value ?? '', scope);
        const mode = context.mode ?? 'value';
        switch (mode) {
          case 'value':
            write(wmlScalar(operand()));
            return;
          case 'literal':
            write(context.value ?? '');
            return;
          case 'formula':
            write(evaluateWmlFormula(context.value ?? '', (path) => (path === 'value' ? current : scope(path))));
            return;
          case 'to_variable': {
            const source = scope(operand());
            write(source === undefined ? '' : source);
            return;
          }
          case 'suffix':
            write(`${current === undefined ? '' : valueToString(current)}${operand()}`);
            return;
          case 'prefix':
            write(`${operand()}${current === undefined ? '' : valueToString(current)}`);
            return;
          case 'string_length':
            write(String(operand()).length);
            return;
          case 'min':
          case 'max': {
            const values = operand().split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
            if (values.length) write(mode === 'min' ? Math.min(...values) : Math.max(...values));
            return;
          }
          case 'add':
          case 'subtract':
          case 'sub':
          case 'multiply':
          case 'divide':
          case 'modulo':
            write(applyWmlOperation(mode === 'subtract' ? 'sub' : mode, wmlNumber(asWmlValue(current)), wmlNumber(operand())));
            return;
          case 'abs':
            write(Math.abs(wmlNumber(asWmlValue(current))));
            return;
          case 'power':
            write(Math.pow(wmlNumber(asWmlValue(current)), wmlNumber(operand())));
            return;
          case 'root': {
            const root = operand();
            const degree = root === 'square' ? 2 : root === 'cube' ? 3 : wmlNumber(root);
            write(degree === 0 ? 0 : Math.pow(wmlNumber(asWmlValue(current)), 1 / degree));
            return;
          }
          case 'round': {
            const value = wmlNumber(asWmlValue(current));
            const how = operand();
            if (how === 'ceil') write(Math.ceil(value));
            else if (how === 'floor') write(Math.floor(value));
            else if (how === 'trunc') write(Math.trunc(value));
            else write(roundDecimals(value, wmlNumber(how)));
            return;
          }
          default:
            throw new Error(`command:set_variable_dynamic does not implement ${mode}=`);
        }
      },
      'command:play_music': (_world, _emit, context) => {
        const file = context.file ?? context.name ?? '';
        if (!file) return;
        engine.playMusic?.(file, {
          playOnce: context.play_once === 'yes',
          repeat: context.repeat !== 'no',
          // `[music] fadein=` is milliseconds in WML; the surface takes seconds.
          fade: Number(context.fadein ?? context.fade ?? 1000) / 1000,
        });
      },
      'command:play_sound': (_world, _emit, context) => {
        const file = context.file ?? context.name ?? '';
        if (file) engine.playSound?.(file);
      },
      'command:modify_turns': (world, emit, context) => {
        const scope = variableReader(world);
        const numeric = (raw: string | undefined): number | undefined => {
          if (raw === undefined) return undefined;
          const expanded = interpolateWml(raw, scope);
          const literal = Number(expanded);
          if (Number.isFinite(literal)) return Math.trunc(literal);
          try {
            const value = evaluateWmlFormula(expanded, scope);
            return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
          } catch {
            return undefined;
          }
        };
        const current = numeric(String(scope('turn_limit') ?? world.variables.turn_limit ?? '')) ?? 0;
        const value = numeric(context.value);
        const add = numeric(context.add);
        if (value !== undefined) emit.setVariable('turn_limit', value);
        else if (add !== undefined) emit.setVariable('turn_limit', current + add);
      },
      'command:play_sound_source': (_world, _emit, context) => {
        const file = context.file ?? context.name ?? '';
        const x = Number(context.x);
        const y = Number(context.y);
        if (!file || !Number.isFinite(x) || !Number.isFinite(y)) return;
        engine.playSoundSource?.(file, x, y, {
          id: context.id,
          repeat: context.repeat !== 'no' && context.loop !== 'no',
          // `delay` is milliseconds in WML; an explicit MWL interval is in
          // seconds.
          interval: Math.max(0.25, context.interval !== undefined
            ? Number(context.interval)
            : Number(context.delay ?? 2000) / 1000),
          refDistance: Number.isFinite(Number(context.ref_distance)) ? Number(context.ref_distance) : undefined,
          maxDistance: Number.isFinite(Number(context.max_distance)) ? Number(context.max_distance) : undefined,
        });
      },
      'command:remove_sound_source': (_world, _emit, context) => {
        if (context.id) engine.removeSoundSource?.(context.id);
      },
      'command:volume': (world, _emit, context) => {
        const settings: { musicVolume?: number; soundVolume?: number } = {};
        for (const [key, target] of [['music', 'musicVolume'], ['sound', 'soundVolume']] as const) {
          if (context[key] === undefined) continue;
          const value = worldInteger(world, context[key], 0);
          settings[target] = Math.max(0, Math.min(1, value / 100));
        }
        if (Object.keys(settings).length) engine.configureAudio?.(settings);
      },
    },
    predicate: {
      'predicate:alive_units': (_world, context) => {
        const side = integer(context.side, 1);
        const count = integer(context.value, 1);
        return engine.state().units.filter((unit) => unit.side === side && unit.hitpoints > 0).length >= count;
      },
      'predicate:side_owns_villages': (_world, context) => {
        const side = integer(context.side, 1);
        const count = integer(context.value, 1);
        return engine.state().villageOwner.filter((owner) => owner === side).length >= count;
      },
      'predicate:unit_exists': unitExists,
      unit_exists: unitExists,
      // the loader's `[predicate] name=attack_filter` form has no `predicate:` prefix, like the three below
      attack_filter: attackFilter,
      'predicate:attack_filter': attackFilter,
      'predicate:unit_filter': unitFilter,
      unit_filter: unitFilter,
      'predicate:wml_filter': wmlFilter,
      wml_filter: wmlFilter,
      'predicate:turn_limit': (world) => {
        // The scenario's `[event] time over` normally defeats the player; the
        // loader also adds this fallback for scenarios that rely on
        // `{TURNS_RUN_OUT}` without their own time-over event.
        const limit = Number(world.variables.turn_limit ?? 0);
        return limit > 0 && engine.state().round > limit;
      },
      'predicate:variable_compare': compareVariable,
      variable_compare: compareVariable,
      'predicate:wml_formula': (world, context) => {
        const source = interpolateWml(context.formula ?? '', variableReader(world));
        if (!source.trim()) return false;
        const values: Record<string, import('../simulation/expression.ts').FormulaValue> = {};
        for (const [key, value] of Object.entries(world.variables)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = value;
        }
        const locX = world.variableAt?.('loc.x');
        const locY = world.variableAt?.('loc.y');
        if (locX !== undefined || locY !== undefined) values.loc = {
          x: typeof locX === 'number' ? locX : Number(locX ?? 0),
          y: typeof locY === 'number' ? locY : Number(locY ?? 0),
        };
        try {
          // Event filter formulas use WFL's single `=` comparison spelling;
          // the shared evaluator deliberately exposes JavaScript-like equality.
          const normalized = source.replace(/(?<![=!<>])=(?!=)/g, '==');
          return Boolean(evaluateFormula(normalized, { values }));
        } catch {
          return false;
        }
      },
      'predicate:wml_condition_tree': (world, context) => {
        let root: SerializedVariableNode | undefined;
        try { root = context.tree ? JSON.parse(decodeURIComponent(context.tree)) as SerializedVariableNode : undefined; } catch { return false; }
        const evaluate = (node: SerializedVariableNode): boolean => {
          if (node.tag === 'and') return node.children.every(evaluate);
          if (node.tag === 'or') return node.children.some(evaluate);
          if (node.tag === 'not') return !node.children.some(evaluate);
          if (node.tag === 'variable') {
            const attrs: Record<string, string> = { ...node.attributes, variable: node.attributes.name ?? '' };
            return compareVariable(world, attrs);
          }
          if (node.tag === 'have_unit') return unitExists(world, { ...node.attributes, exists: 'yes' });
          if (node.tag === 'have_location') return locationExists(world, node);
          if (node.tag === 'lua') {
            const code = node.attributes.code ?? '';
            if (!/^\s*return\s+/.test(code)) return false;
            const nested: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(world.variables)) {
              if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
              let cursor = nested;
              const parts = key.split('.');
              for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {}) as Record<string, unknown>;
              cursor[parts.at(-1)!] = value;
            }
            try {
              const value = luaHost.evaluate(code.replace(/^\s*return\s+/, '').trim(), { wml: { variables: nested as ScriptValue } });
              return value === true || (typeof value === 'number' && value !== 0) || (typeof value === 'string' && value !== '');
            } catch { return false; }
          }
          return false;
        };
        return root ? evaluate(root) : false;
      },
      wml_condition_tree: (world, context) => {
        let root: SerializedVariableNode | undefined;
        try { root = context.tree ? JSON.parse(decodeURIComponent(context.tree)) as SerializedVariableNode : undefined; } catch { return false; }
        const evaluate = (node: SerializedVariableNode): boolean => {
          if (node.tag === 'and') return node.children.every(evaluate);
          if (node.tag === 'or') return node.children.some(evaluate);
          if (node.tag === 'not') return !node.children.some(evaluate);
          if (node.tag === 'variable') return compareVariable(world, { ...node.attributes, variable: node.attributes.name ?? '' });
          if (node.tag === 'have_unit') return unitExists(world, { ...node.attributes, exists: 'yes' });
          if (node.tag === 'have_location') return locationExists(world, node);
          return false;
        };
        return root ? evaluate(root) : false;
      },
      'predicate:lua_condition': luaCondition,
      lua_condition: luaCondition,
    },
  };
}

/** Narrow a stored variable to a value the WML evaluator understands. */
function asWmlValue(value: unknown): WmlValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.filter((item): item is WmlValue => asWmlValue(item) !== undefined);
  return undefined;
}

function valueToString(value: WmlValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(valueToString).join(', ');
  return String(value);
}

/** A stored `value=` keeps its number shape when the text reads as one, like WML's own typing. */
function wmlScalar(text: string): WmlValue {
  return /^-?\d+(?:\.\d+)?$/.test(text.trim()) ? Number(text) : text;
}

/** `equals=`/`not_equals=` compare numerically when both sides read as numbers. */
function sameValue(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (a !== '' && b !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) return Number(a) === Number(b);
  return a === b;
}

/** WML `round=<decimals>` rounds to a number of decimal places (negative truncates). */
function roundDecimals(value: number, decimals: number): number {
  const places = Math.trunc(decimals);
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}
