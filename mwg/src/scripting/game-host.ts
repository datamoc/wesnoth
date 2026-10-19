// The game kernel's host side: `wesnoth.units`, `wesnoth.sides`, the live map and the
// scenario state, implemented over the port's `GameState`.
//
// Real engine: `src/scripting/game_lua_kernel.cpp` (and `lua_unit.cpp`, `lua_team.cpp`)
// expose the running game to Lua. Here the Lua side (`game-prelude.ts`) builds the
// userdata-like proxies and calls the `__*` host functions below with plain ids and
// JSON-like values; all state stays in TypeScript.
//
// Coordinates: Lua/WML is 1-based, the port's grid is 0-based; every x/y crossing the
// bridge is shifted once here.
import { filterLocationMatches, matchesUnitFilter, toFilterNode, type FilterWorld } from '../scenarios/wml-filter.ts';
import { abilitiesOf as combatAbilities } from '../simulation/combat.ts';
import { applyEffect } from '../simulation/effects.ts';
import { areAllied, setTerrainAt, terrainCodeAt, unitAt, updateVision, type GameState } from '../simulation/game.ts';
import type { WesnothData } from '../simulation/types.ts';
import { makeUnit, makeUnitWithTraits, type Unit } from '../simulation/unit.ts';
import type { WmlNode } from '../simulation/wml.ts';
import type { LuaValue, LuaVm } from './lua-vm.ts';

/** Per-side data the port's `GameState` does not carry. */
export interface SideSettings {
  gold: number;
  name: string;
  controller: string;
  teamName: string;
  recruit: string[];
  variables: { [key: string]: LuaValue };
  /** extra attributes the scenario set (`village_gold`, `fog`, `color`, ...) */
  attributes: { [key: string]: LuaValue };
}

/** What the host needs from the scene. */
export interface LuaGameServices {
  state(): GameState;
  data: WesnothData;
  sides: Map<number, SideSettings>;
  /** a float in [0, 1) */
  random(): number;
  /** the side whose turn it is */
  currentSide(): number;
  currentTurn(): number;
  /** a `[message]` for the player: speaker, text, optional portrait */
  say?(message: { speaker: string; text: string; image?: string; side?: number }): void;
  /** `[endlevel]` */
  endLevel?(result: string, next?: string): void;
  log?(message: string): void;
  /** `wesnoth.audio.play(file)` */
  playSound?(file: string): void;
}

/** What the port's `Unit` lacks compared with a Wesnoth unit. */
interface UnitExtra {
  variables: { [key: string]: LuaValue };
  status: { [key: string]: boolean };
  role?: string;
  wmlId?: string;
  overlays: string[];
}

/** The default team colour order (`[color_range] default=yes` in `team-colors.cfg`). */
const SIDE_COLORS = ['red', 'blue', 'green', 'purple', 'black', 'brown', 'orange', 'white', 'teal'];

const fakeLocation = { file: '<lua>', line: 0, column: 0 };

/** A Lua config table (`{ {tag, contents}, ..., attr = v }`) as a WML node tree. */
export function configToNode(tag: string, table: { [key: string]: LuaValue } | null): WmlNode {
  const node: WmlNode = { tag, attributes: {}, children: [], location: fakeLocation };
  if (!table || typeof table !== 'object') return node;
  const indices = Object.keys(table).filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
  for (const index of indices) {
    const entry = table[String(index)] as { [key: string]: LuaValue } | null;
    if (entry && typeof entry === 'object' && typeof entry['1'] === 'string') {
      node.children.push(configToNode(String(entry['1']), entry['2'] as { [key: string]: LuaValue }));
    }
  }
  for (const [key, value] of Object.entries(table)) {
    if (/^\d+$/.test(key)) continue;
    node.attributes[key] = value === true ? 'yes' : value === false ? 'no' : String(value);
  }
  return node;
}

export class LuaGameHost {
  private readonly services: LuaGameServices;
  private readonly extras = new Map<number, UnitExtra>();
  /**
   * Units an event is about that are no longer on the map (the unit that just died stays
   * readable while its `die` handlers run, as in the engine).
   */
  eventUnits: Unit[] = [];
  /** the modifications (`[object]`, `[trait]`, `[advancement]`) each unit has had applied, in order */
  private readonly modifications = new Map<number, { kind: string; cfg: { [key: string]: LuaValue } }[]>();
  /** units created by Lua that are not on the map (`wesnoth.units.create`) */
  private readonly detached = new Map<number, Unit>();
  /**
   * Hex overlays (`[item]` pictures, `wesnoth.interface.add_hex_overlay`), keyed by the
   * 0-based "x,y" of the hex; the scene draws them.
   */
  readonly overlays = new Map<string, { [key: string]: LuaValue }[]>();
  /** units stored off the map for the player's recall list (`to_recall`) */
  readonly recall = new Map<number, Unit[]>();

  constructor(services: LuaGameServices) {
    this.services = services;
  }

  private extra(unit: Unit): UnitExtra {
    let extra = this.extras.get(unit.id);
    if (!extra) {
      extra = { variables: {}, status: {}, overlays: [] };
      this.extras.set(unit.id, extra);
    }
    return extra;
  }

  private unitById(id: unknown): Unit | undefined {
    const wanted = Number(id);
    return this.services.state().units.find((unit) => unit.id === wanted) ?? this.eventUnits.find((unit) => unit.id === wanted) ?? this.detached.get(wanted);
  }

  private filterWorld(): FilterWorld {
    const { data } = this.services;
    const state = () => this.services.state();
    return {
      variable: () => undefined,
      terrainAt: (x, y) => terrainCodeAt(state(), x, y),
      villageOwnerAt: (x, y) => state().villageOwner[y * state().width + x] ?? null,
      allied: (a, b) => areAllied(state(), a, b),
      abilitiesOf: (unit) => combatAbilities(data, unit).map((ability) => ability.id),
      attacksOf: (unit) => unit.attacks.map((attack) => ({ id: attack.name, name: attack.name, range: attack.range, type: attack.type })),
      raceOf: (unit) => data.unitTypes[unit.typeId]?.race ?? '',
      unitAt: (x, y) => unitAt(state(), x, y),
    };
  }

  matches(unit: Unit, filter: { [key: string]: LuaValue } | null): boolean {
    if (!filter) return true;
    return matchesUnitFilter(toFilterNode(configToNode('filter', filter)), unit, this.filterWorld());
  }

  /** Register every host function on the VM. */
  install(vm: LuaVm): void {
    const { services } = this;

    vm.defineFunction('__units_find', (filter) => {
      const found = services.state().units.filter((unit) => unit.hitpoints > 0 && this.matches(unit, filter as { [key: string]: LuaValue } | null));
      return found.map((unit) => unit.id);
    });
    vm.defineFunction('__unit_at', (x, y) => {
      const unit = unitAt(services.state(), Number(x) - 1, Number(y) - 1)
        ?? this.eventUnits.find((candidate) => candidate.x === Number(x) - 1 && candidate.y === Number(y) - 1);
      return unit ? unit.id : null;
    });
    vm.defineFunction('__unit_get', (id, key) => this.getField(this.unitById(id), String(key)));
    vm.defineFunction('__unit_set', (id, key, value) => {
      this.setField(this.unitById(id), String(key), value);
    });
    vm.defineFunction('__unit_matches', (id, filter) => {
      const unit = this.unitById(id);
      return unit ? this.matches(unit, filter as { [key: string]: LuaValue } | null) : false;
    });
    vm.defineFunction('__unit_status', (id, name, value) => {
      const unit = this.unitById(id);
      if (!unit) return null;
      const extra = this.extra(unit);
      const key = String(name);
      if (value !== undefined && value !== null) {
        const on = value === true;
        extra.status[key] = on;
        if (key === 'poisoned') unit.poisoned = on;
        if (key === 'slowed') unit.slowed = on;
        if (key === 'petrified') unit.petrified = on;
        return null;
      }
      if (key === 'poisoned') return unit.poisoned;
      if (key === 'slowed') return unit.slowed;
      if (key === 'petrified') return unit.petrified;
      return extra.status[key] === true;
    });
    vm.defineFunction('__unit_effect', (id, effect) => {
      const unit = this.unitById(id);
      if (unit) applyEffect(services.data, unit, configToNode('effect', effect as { [key: string]: LuaValue }));
    });
    vm.defineFunction('__unit_add_mod', (id, kind, cfg) => {
      const unit = this.unitById(id);
      if (!unit) return;
      const list = this.modifications.get(unit.id) ?? [];
      list.push({ kind: String(kind), cfg: (cfg ?? {}) as { [key: string]: LuaValue } });
      this.modifications.set(unit.id, list);
    });
    vm.defineFunction('__unit_mods', (id) => {
      const unit = this.unitById(id);
      return (unit ? this.modifications.get(unit.id) ?? [] : []).map((entry) => ({ 1: entry.kind, 2: entry.cfg })) as unknown as LuaValue;
    });
    // remove_modifications: drop the matching entries, then rebuild the unit from its type, its
    // traits and the modifications that remain (the engine's `unit::remove_modifications`)
    vm.defineFunction('__unit_remove_mods', (id, kind, filter) => {
      const unit = this.unitById(id);
      if (!unit) return;
      const wantedKind = kind === null || kind === undefined ? '' : String(kind);
      const wanted = (filter ?? {}) as { [key: string]: LuaValue };
      const list = this.modifications.get(unit.id) ?? [];
      const kept = list.filter((entry) => {
        if (wantedKind && entry.kind !== wantedKind) return true;
        return !Object.entries(wanted).every(([key, value]) => typeof value === 'object' || String(entry.cfg[key]) === String(value));
      });
      if (kept.length === list.length) return;
      this.modifications.set(unit.id, kept);
      const fresh = makeUnitWithTraits(services.data, unit.typeId, unit.side, unit.x, unit.y, unit.traits);
      for (const entry of kept) {
        for (const child of configToNode(entry.kind, entry.cfg).children) {
          if (child.tag === 'effect') applyEffect(services.data, fresh, child);
        }
      }
      const keep = { id: unit.id, name: unit.name, experience: unit.experience, canRecruit: unit.canRecruit, wmlId: unit.wmlId, loyal: unit.loyal, x: unit.x, y: unit.y, side: unit.side, movement: unit.movement };
      const ratio = unit.hitpoints / Math.max(1, unit.maxHitpoints);
      Object.assign(unit, fresh, keep);
      unit.hitpoints = Math.max(1, Math.min(unit.maxHitpoints, Math.round(ratio * unit.maxHitpoints)));
      unit.movement = Math.min(unit.maxMovement, keep.movement);
    });
    vm.defineFunction('__unit_variables', (id) => {
      const unit = this.unitById(id);
      return unit ? this.extra(unit).variables : null;
    });
    vm.defineFunction('__unit_set_variables', (id, table) => {
      const unit = this.unitById(id);
      if (unit) this.extra(unit).variables = (table ?? {}) as { [key: string]: LuaValue };
    });
    vm.defineFunction('__unit_create', (cfg) => {
      const table = (cfg ?? {}) as { [key: string]: LuaValue };
      const type = String(table.type ?? '');
      if (!services.data.unitTypes[type]) throw new Error(`unknown unit type "${type}"`);
      const side = Number(table.side ?? 1);
      const unit = makeUnit(services.data, type, side, Number(table.x ?? 1) - 1, Number(table.y ?? 1) - 1, services.random);
      if (table.name !== undefined) unit.name = String(table.name);
      if (table.canrecruit === true) unit.canRecruit = true;
      if (table.id !== undefined) unit.wmlId = String(table.id);
      if (table.hitpoints !== undefined) unit.hitpoints = Number(table.hitpoints);
      if (table.experience !== undefined) unit.experience = Number(table.experience);
      if (table.moves !== undefined) unit.movement = Number(table.moves);
      this.detached.set(unit.id, unit);
      return unit.id;
    });
    vm.defineFunction('__unit_place', (id, x, y) => {
      const unit = this.detached.get(Number(id)) ?? this.unitById(id);
      if (!unit) return false;
      unit.x = Number(x) - 1;
      unit.y = Number(y) - 1;
      this.detached.delete(unit.id);
      const state = services.state();
      if (!state.units.includes(unit)) state.units.push(unit);
      updateVision(state, services.data);
      return true;
    });
    vm.defineFunction('__unit_erase', (id) => {
      const state = services.state();
      const index = state.units.findIndex((unit) => unit.id === Number(id));
      if (index >= 0) state.units.splice(index, 1);
      this.detached.delete(Number(id));
    });
    vm.defineFunction('__unit_to_recall', (id) => {
      const state = services.state();
      const unit = this.unitById(id);
      if (!unit) return;
      const index = state.units.indexOf(unit);
      if (index >= 0) state.units.splice(index, 1);
      const list = this.recall.get(unit.side) ?? [];
      list.push(unit);
      this.recall.set(unit.side, list);
    });
    vm.defineFunction('__units_recall', (side) => (this.recall.get(Number(side)) ?? []).map((unit) => unit.id));
    vm.defineFunction('__unit_type_info', (type) => {
      const def = services.data.unitTypes[String(type)];
      if (!def) return null;
      return {
        id: def.id,
        name: def.name,
        image: def.image,
        profile: def.profile ?? '',
        max_moves: def.movement,
        max_experience: def.experience,
        max_hitpoints: def.hitpoints,
        level: def.level,
        race: def.race,
        cost: def.cost,
        hitpoints: def.hitpoints,
        experience: def.experience,
        movement: def.movement,
        alignment: def.alignment,
        advances_to: def.advancesTo ?? [],
        abilities: def.abilities ?? [],
      } as unknown as LuaValue;
    });
    vm.defineFunction('__unit_types', () => Object.keys(services.data.unitTypes));

    // ---- sides
    vm.defineFunction('__side_list', () => [...services.sides.keys()]);
    vm.defineFunction('__side_get', (side, key) => {
      const settings = services.sides.get(Number(side));
      if (!settings) return null;
      switch (String(key)) {
        case 'gold': return settings.gold;
        case 'name': return settings.name;
        case 'controller': return settings.controller;
        case 'team_name': return settings.teamName;
        case 'recruit': return settings.recruit;
        case 'variables': return settings.variables;
        case 'color': return settings.attributes.color ?? SIDE_COLORS[(Number(side) - 1) % SIDE_COLORS.length];
        default: return settings.attributes[String(key)] ?? null;
      }
    });
    vm.defineFunction('__side_set', (side, key, value) => {
      const settings = services.sides.get(Number(side));
      if (!settings) return;
      switch (String(key)) {
        case 'gold': settings.gold = Number(value); break;
        case 'name': settings.name = String(value); break;
        case 'controller': settings.controller = String(value); break;
        case 'team_name': settings.teamName = String(value); break;
        case 'recruit': settings.recruit = Array.isArray(value) ? value.map(String) : Object.values((value ?? {}) as object).map(String); break;
        case 'variables': settings.variables = (value ?? {}) as { [key: string]: LuaValue }; break;
        default: settings.attributes[String(key)] = value;
      }
    });
    vm.defineFunction('__side_leader', (side) => {
      const leader = services.state().units.find((unit) => unit.side === Number(side) && unit.canRecruit);
      return leader ? leader.id : null;
    });

    // ---- the live map
    vm.defineFunction('__game_map_info', () => {
      const state = services.state();
      return { width: state.width, height: state.height } as unknown as LuaValue;
    });
    vm.defineFunction('__game_terrain', (x, y) => {
      const state = services.state();
      const cx = Number(x) - 1;
      const cy = Number(y) - 1;
      if (cx < 0 || cy < 0 || cx >= state.width || cy >= state.height) return '_off^_usr';
      return terrainCodeAt(state, cx, cy);
    });
    vm.defineFunction('__game_set_terrain', (x, y, code) => {
      const state = services.state();
      const cx = Number(x) - 1;
      const cy = Number(y) - 1;
      if (cx >= 0 && cy >= 0 && cx < state.width && cy < state.height) setTerrainAt(state, cx, cy, String(code));
    });
    // wesnoth.map.find(cfg): a WML location filter over the whole map (intf_get_locations)
    vm.defineFunction('__locations_find', (cfg) => {
      const state = services.state();
      const node = toFilterNode(configToNode('filter_location', (cfg ?? {}) as { [key: string]: LuaValue }));
      const world = this.filterWorld();
      const found: LuaValue[] = [];
      for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
          if (filterLocationMatches(node, x, y, world)) found.push({ x: x + 1, y: y + 1 });
        }
      }
      return found;
    });
    vm.defineFunction('__overlay_add', (x, y, cfg) => {
      const key = `${Number(x) - 1},${Number(y) - 1}`;
      const list = this.overlays.get(key) ?? [];
      list.push((cfg ?? {}) as { [key: string]: LuaValue });
      this.overlays.set(key, list);
    });
    vm.defineFunction('__overlay_remove', (x, y, name) => {
      const key = `${Number(x) - 1},${Number(y) - 1}`;
      const list = this.overlays.get(key) ?? [];
      const kept = name === null || name === undefined ? [] : list.filter((entry) => entry.name !== name && entry.image !== name);
      if (kept.length) this.overlays.set(key, kept);
      else this.overlays.delete(key);
    });
    vm.defineFunction('__overlay_get', (x, y) => this.overlays.get(`${Number(x) - 1},${Number(y) - 1}`) ?? []);
    vm.defineFunction('__game_village_owner', (x, y) => {
      const state = services.state();
      const owner = state.villageOwner[(Number(y) - 1) * state.width + (Number(x) - 1)];
      return owner ?? null;
    });
    vm.defineFunction('__game_set_village_owner', (x, y, side) => {
      const state = services.state();
      state.villageOwner[(Number(y) - 1) * state.width + (Number(x) - 1)] = side === null || side === 0 ? null : Number(side);
    });
    vm.defineFunction('__game_state', () => ({
      side: services.currentSide(),
      turn: services.currentTurn(),
    }));
    vm.defineFunction('__random_float', () => services.random());
    vm.defineFunction('__say', (message) => {
      const table = (message ?? {}) as { [key: string]: LuaValue };
      // `[message]` hands over { title = the speaker's name, portrait/image, message }
      services.say?.({
        speaker: String(table.title ?? table.speaker ?? ''),
        text: String(table.message ?? ''),
        image: table.portrait ? String(table.portrait) : table.image ? String(table.image) : undefined,
        side: table.side ? Number(table.side) : undefined,
      });
    });
    vm.defineFunction('__audio_play', (file) => {
      services.playSound?.(String(file));
    });
    vm.defineFunction('__end_level', (result, next) => {
      services.endLevel?.(String(result ?? 'victory'), next ? String(next) : undefined);
    });
  }

  private getField(unit: Unit | undefined, key: string): LuaValue {
    if (!unit) return null;
    const type = this.services.data.unitTypes[unit.typeId];
    switch (key) {
      case 'x': return unit.x + 1;
      case 'y': return unit.y + 1;
      case 'side': return unit.side;
      case 'type': return unit.typeId;
      case 'id': return unit.wmlId ?? this.extra(unit).wmlId ?? '';
      case 'name': return unit.name;
      case 'hitpoints': return unit.hitpoints;
      case 'max_hitpoints': return unit.maxHitpoints;
      case 'experience': return unit.experience;
      case 'max_experience': return unit.maxExperience;
      case 'moves': return unit.movement;
      case 'max_moves': return unit.maxMovement;
      // the port ends a unit's turn when it attacks (movement drops to 0), so a unit with
      // movement left still has its attack
      case 'attacks_left': return unit.movement > 0 ? 1 : 0;
      case 'level': return unit.level;
      case 'race': return type?.race ?? '';
      case 'canrecruit': return unit.canRecruit === true;
      case 'alignment': return unit.alignment;
      case 'role': return this.extra(unit).role ?? '';
      case 'resting': return unit.resting;
      case 'hidden': return unit.hidden === true;
      case 'upkeep': return unit.loyal ? 'loyal' : unit.level;
      case 'cost': return unit.cost;
      case 'traits': return unit.traits;
      case 'facing': return unit.facing ?? 'se';
      case 'overlays': return this.extra(unit).overlays;
      default: return null;
    }
  }

  private setField(unit: Unit | undefined, key: string, value: LuaValue): void {
    if (!unit) return;
    switch (key) {
      case 'x': unit.x = Number(value) - 1; break;
      case 'y': unit.y = Number(value) - 1; break;
      case 'side': unit.side = Number(value); break;
      case 'name': unit.name = String(value); break;
      case 'hitpoints': unit.hitpoints = Number(value); break;
      case 'max_hitpoints': unit.maxHitpoints = Number(value); break;
      case 'experience': unit.experience = Number(value); break;
      case 'max_experience': unit.maxExperience = Number(value); break;
      case 'moves': unit.movement = Number(value); break;
      case 'max_moves': unit.maxMovement = Number(value); break;
      case 'canrecruit': unit.canRecruit = value === true; break;
      case 'resting': unit.resting = value === true; break;
      case 'hidden': unit.hidden = value === true; break;
      case 'role': this.extra(unit).role = String(value); break;
      case 'facing': unit.facing = String(value); break;
      case 'id': unit.wmlId = String(value); break;
      case 'overlays': this.extra(unit).overlays = Array.isArray(value) ? value.map(String) : []; break;
      default: break;
    }
  }
}
