// World Conquest II, run through its real Lua.
//
// The campaign is `scenario_generation=lua`: the scenario of each of its five maps (map, sides,
// events) is produced by `wc_ii_generate_scenario` in the mapgen kernel, and its mechanics
// (heroes, bonus points, items, training, enemy spawns, carry-over) live in the game kernel as
// `[event]`s and WML actions written in Lua. This module drives both kernels over the port's
// `GameState`; `src/main.ts` calls it to start a scenario and to hand it the game's events.
import { LUA_FILES } from '../generated/lua-files.ts';
import { COLOR_RANGES } from '../generated/team-colors.ts';
import { WC_CAMPAIGNS, WC_ERA, WC_RESOURCES } from '../generated/wc-data.ts';
import type { MwlCompiledGame } from 'mwg/mwl';
import type { GameState } from '../simulation/game.ts';
import type { WesnothData } from '../simulation/types.ts';
import { makeUnit, type Unit } from '../simulation/unit.ts';
import type { LuaGameHost, LuaGameServices, SideSettings } from './game-host.ts';
import { createKernel, createKernelWithHost, type Kernel } from './kernel.ts';
import type { LuaFileProvider, LuaValue, LuaVm } from './lua-vm.ts';

type Table = { [key: string]: LuaValue };

/** The bundled scripts, addressed like the engine does (paths relative to `data/`). */
export function bundledLuaFiles(): LuaFileProvider {
  // The bundle is immutable. Index directories once instead of walking every
  // bundled file on each filesystem.read_file call from the real package loader.
  const entries = new Map<string, Set<string>>();
  for (const name of Object.keys(LUA_FILES)) {
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const child = parts[i] + (i < parts.length - 1 ? '/' : '');
      if (!entries.has(dir)) entries.set(dir, new Set());
      entries.get(dir)!.add(child);
    }
  }
  const directories = new Map([...entries].map(([dir, children]) => {
    const dirs = [...children].filter((name) => name.endsWith('/')).sort();
    const files = [...children].filter((name) => !name.endsWith('/')).sort();
    return [dir, [...dirs, ...files]];
  }));
  return {
    read: (path) => LUA_FILES[path.replace(/^\.\//, '')] ?? null,
    list: (dir) => {
      const children = directories.get(dir.replace(/^\.\//, '').replace(/\/$/, ''));
      return children ? [...children] : null;
    },
  };
}

export interface WcFaction {
  id: string;
  name: string;
  image: string;
  leaders: string[];
}

/** The era's factions the player can pick (the `Random` entry is left out). */
export function wcFactions(): WcFaction[] {
  const out: WcFaction[] = [];
  for (const entry of Object.values(WC_ERA as unknown as Table)) {
    const node = entry as Table | null;
    if (!node || typeof node !== 'object' || node['1'] !== 'multiplayer_side') continue;
    const side = node['2'] as Table;
    if (side.random_faction === true) continue;
    out.push({
      id: String(side.id),
      name: String(side.name ?? side.id),
      image: String(side.image ?? ''),
      leaders: String(side.leader ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    });
  }
  return out;
}

export interface WcDifficulty {
  id: string;
  label: string;
}

/** The difficulties of the campaign, in the real definition's order. */
export function wcDifficulties(): WcDifficulty[] {
  const campaign = WC_CAMPAIGNS[0] as Table | undefined;
  const out: WcDifficulty[] = [];
  for (const entry of Object.values(campaign ?? {})) {
    const node = entry as Table | null;
    if (!node || typeof node !== 'object' || node['1'] !== 'difficulty') continue;
    const difficulty = node['2'] as Table;
    out.push({ id: String(difficulty.define), label: String(difficulty.label ?? difficulty.define).replace(/^_\s*/, '').replace(/"/g, '') });
  }
  return out;
}

/** `wc2_difficulty` for a difficulty, as the campaign's `preload` event would set it. */
export function wcDifficultyVariables(id: string, players: number): Table | null {
  const campaign = WC_CAMPAIGNS[0] as Table | undefined;
  for (const entry of Object.values(campaign ?? {})) {
    const node = entry as Table | null;
    if (!node || typeof node !== 'object' || node['1'] !== 'event') continue;
    const event = node['2'] as Table;
    const lua = Object.values(event).find((child) => (child as Table | null)?.['1'] === 'lua') as Table | undefined;
    const args = lua ? Object.values((lua['2'] as Table)).find((child) => (child as Table | null)?.['1'] === 'args') as Table | undefined : undefined;
    if ((args?.['2'] as Table | undefined)?.difficulty !== id) continue;
    const setVariables = Object.values(event).find((child) => (child as Table | null)?.['1'] === 'set_variables') as Table | undefined;
    const value = setVariables ? Object.values(setVariables['2'] as Table).find((child) => (child as Table | null)?.['1'] === 'value') as Table | undefined : undefined;
    if (!value) return null;
    const values = { ...(value['2'] as Table) };
    // `$(gold * 2 ^ (3 - nplayers) where nplayers = ..., gold = N)`: evaluated for this player count
    const formula = String(values.extra_gold ?? '');
    const base = /gold\s*=\s*(\d+)/.exec(formula);
    if (base) values.extra_gold = Number(base[1]) * 2 ** (3 - players);
    return values;
  }
  return null;
}

export interface WcSide {
  side: number;
  controller: string;
  gold: number;
  teamName: string;
  leaderType: string;
  leaderId: string;
  canRecruit: boolean;
  recruit: string[];
  startPosition: number;
  attributes: { [key: string]: LuaValue };
}

export interface WcSetup {
  id: string;
  name: string;
  number: number;
  turns: number;
  width: number;
  height: number;
  codes: string[];
  starts: Map<number, { x: number; y: number }>;
  sides: WcSide[];
  /** the generated `[scenario]` as a Lua config table */
  scenario: Table;
}

export interface WcOptions {
  data: WesnothData;
  seed: number;
  difficulty: string;
  factionId: string;
  players?: number;
}

function children(table: Table, tag: string): Table[] {
  const out: Table[] = [];
  for (let index = 1; table[String(index)] !== undefined; index++) {
    const entry = table[String(index)] as Table;
    if (entry['1'] === tag) out.push(entry['2'] as Table);
  }
  return out;
}

export class WorldConquest {
  private readonly options: WcOptions;
  private readonly files = bundledLuaFiles();
  /** the WML variables carried from scenario to scenario (`wc2_*`) */
  private variables: Table = {};
  private gameKernel: Kernel | null = null;
  private scenarioNumber = 0;
  private readonly players: number;

  constructor(options: WcOptions) {
    this.options = options;
    this.players = options.players ?? 1;
  }

  /** Run `wc_ii_generate_scenario` for the next map in the mapgen kernel. */
  generate(): WcSetup {
    this.scenarioNumber += 1;
    const number = this.scenarioNumber;
    const difficulty = wcDifficultyVariables(this.options.difficulty, this.players) ?? { enemy_power: 8 };
    const generator = createKernel({ files: this.files, kind: 'mapgen', seed: this.options.seed + number * 7919 });
    generator.defineFunction('__vars', () => this.variables);
    generator.defineFunction('__difficulty', () => difficulty);
    generator.run(`
      wml.__import_vars(__vars())
      wml.variables.wc2_scenario = ${number}
      wml.variables.wc2_player_count = ${this.players}
      wml.variables.wc2_difficulty = __difficulty()
      wesnoth.dofile('campaigns/World_Conquest/lua/map/main.lua')
      scenario_result = wc_ii_generate_scenario(${this.players}, { nplayers = ${this.players}, id = 'WC_II_${this.players}p', { 'scenario', {} } })
    `, '=wc-generate');
    const scenario = generator.run('return scenario_result') as Table;
    // the playable area is the game grid: WML (1,1) is grid (0,0)
    const all = String(scenario.map_data).split('\n').filter((row) => row.trim()).map((row) => row.split(',').map((cell) => cell.trim()));
    const rows = all.slice(1, -1).map((row) => row.slice(1, -1));
    const starts = new Map<number, { x: number; y: number }>();
    const codes: string[] = [];
    rows.forEach((row, y) => row.forEach((cell, x) => {
      const start = /^(\d+) (\S+)$/.exec(cell);
      if (start) starts.set(Number(start[1]), { x, y });
      codes.push(start ? start[2] : cell);
    }));
    const faction = wcFactions().find((entry) => entry.id === this.options.factionId);
    const sides: WcSide[] = children(scenario, 'side').map((side) => {
      const leaderNode = children(side, 'leader')[0];
      const number = Number(side.side);
      let leaderType = String(leaderNode?.type ?? side.type ?? '');
      if (!leaderType && number <= this.players && faction && faction.leaders.length > 0) {
        leaderType = faction.leaders[Math.floor(((this.options.seed + number) % 997) / 997 * faction.leaders.length)];
      }
      return {
        side: number,
        controller: String(side.controller ?? 'ai'),
        gold: Number(side.gold ?? 0),
        teamName: String(side.team_name ?? number),
        leaderType,
        leaderId: String(leaderNode?.id ?? side.id ?? ''),
        canRecruit: side.canrecruit === true && side.no_leader !== true,
        recruit: String(side.recruit ?? '').split(',').map((item) => item.trim()).filter(Boolean),
        startPosition: Number(side.location_id ?? side.side),
        attributes: Object.fromEntries(Object.entries(side).filter(([key]) => !/^\d+$/.test(key))) as { [key: string]: LuaValue },
      };
    });
    // the mapgen kernel's variable store (set up by the scenario) travels to the game kernel
    this.variables = generator.run('return wml.get_all_vars()') as Table;
    return {
      id: String(scenario.id ?? `WC_II_${this.players}p`),
      name: String(scenario.name ?? `Scenario ${number}`),
      number,
      turns: Number(scenario.turns ?? 0),
      width: rows[0]?.length ?? 0,
      height: rows.length,
      codes,
      starts,
      sides,
      scenario,
    };
  }

  /**
   * Boot the game kernel on the live game: load the campaign's resources (the Lua of the era
   * and of the scenario), register the scenario's events, and fire `prestart` then `start`.
   */
  start(setup: WcSetup, services: LuaGameServices, seed = this.options.seed): Kernel {
    const kernel = createKernelWithHost({ files: this.files, kind: 'game', services, seed });
    this.gameKernel = kernel;
    const vm = kernel.vm;
    vm.defineFunction('__colors', () => COLOR_RANGES as unknown as LuaValue);
    vm.defineFunction('__wc_era', () => WC_ERA as unknown as LuaValue);
    vm.defineFunction('__wc_resources', () => WC_RESOURCES as unknown as LuaValue);
    vm.defineFunction('__wc_scenario', () => setup.scenario);
    vm.defineFunction('__wc_vars', () => this.variables);
    vm.defineFunction('__wc_difficulty', () => wcDifficultyVariables(this.options.difficulty, this.players) as LuaValue);
    vm.run(`
      wesnoth.colors = __colors()
      wesnoth.scenario.era = __wc_era()
      wesnoth.scenario.resources = __wc_resources()
      wesnoth.scenario.id = ${JSON.stringify(setup.id)}
      wesnoth.scenario.difficulty = ${JSON.stringify(this.options.difficulty)}
      wml.__import_vars(__wc_vars())
      if wml.variables.wc2_difficulty == nil then wml.variables.wc2_difficulty = __wc_difficulty() end
      local scenario = __wc_scenario()
      local by_id = {}
      for _, r in ipairs(wesnoth.scenario.resources) do by_id[r.id] = r end
      local function load_resource(id)
        local resource = by_id[id]
        if not resource then return end
        for _, rc in ipairs(resource) do
          if rc[1] == 'lua' then
            local chunk = assert(load(rc[2].code, '=resource ' .. id))
            chunk()
          elseif rc[1] == 'load_resource' then
            load_resource(rc[2].id)
          end
        end
      end
      for _, child in ipairs(scenario) do
        if child[1] == 'variables' then
          for k, v in pairs(child[2]) do if type(k) == 'string' then wml.variables[k] = v end end
        end
      end
      for _, child in ipairs(scenario) do
        if child[1] == 'load_resource' then load_resource(child[2].id) end
      end
      for _, child in ipairs(scenario) do
        if child[1] == 'event' then wesnoth.wml_actions.event(child[2]) end
      end
    `, '=wc-start');
    return kernel;
  }

  /** Fire a game event; `x1,y1`/`x2,y2` are 0-based grid hexes. */
  fire(name: string, first?: { x: number; y: number }, second?: { x: number; y: number }, eventUnits: Unit[] = []): Table | null {
    const vm = this.gameKernel?.vm;
    if (!vm) return null;
    if (this.gameKernel?.host) this.gameKernel.host.eventUnits = eventUnits;
    const loc = (point?: { x: number; y: number }): string => (point ? `{ x = ${point.x + 1}, y = ${point.y + 1} }` : 'nil');
    vm.run(`wesnoth.game_events.fire(${JSON.stringify(name)}${first ? `, ${loc(first)}` : ''}${first && second ? `, ${loc(second)}` : ''})`, `=event ${name}`);
    return this.pendingRequest();
  }

  /** A dialog request a Lua handler is waiting on (the invest tree), or null. */
  pendingRequest(): Table | null {
    const vm = this.gameKernel?.vm;
    if (!vm) return null;
    return (vm.run('return wesnoth.__take_pending()') as Table | null) ?? null;
  }

  /** Give the waiting handler the player's answer; it may then ask again. */
  answer(value: LuaValue): Table | null {
    const vm = this.gameKernel?.vm;
    if (!vm) return null;
    vm.defineFunction('__answer', () => value);
    vm.run('wesnoth.__resume(__answer())', '=answer');
    return this.pendingRequest();
  }

  get host(): LuaGameHost | null {
    return this.gameKernel?.host ?? null;
  }

  get vm(): LuaVm | null {
    return this.gameKernel?.vm ?? null;
  }

  /** Save the Lua variable store when a scenario ends, for the next one. */
  endScenario(): void {
    const vm = this.gameKernel?.vm;
    if (vm) this.variables = vm.run('return wml.get_all_vars()') as Table;
    this.gameKernel = null;
  }

  /** The units and sides of a setup, ready for `makeGame` and the scene's state. */
  static leaders(setup: WcSetup, data: WesnothData, state: GameState, random: () => number): void {
    for (const side of setup.sides) {
      if (!side.canRecruit || !side.leaderType || !data.unitTypes[side.leaderType]) continue;
      const start = setup.starts.get(side.startPosition) ?? setup.starts.get(side.side);
      if (!start) continue;
      const unit = makeUnit(data, side.leaderType, side.side, start.x, start.y, random);
      unit.canRecruit = true;
      unit.wmlId = side.leaderId || `leader_${side.side}`;
      state.units.push(unit);
    }
  }

  static sideSettings(setup: WcSetup, factionId: string): Map<number, SideSettings> {
    const out = new Map<number, SideSettings>();
    for (const side of setup.sides) {
      out.set(side.side, {
        gold: side.gold,
        name: `Side ${side.side}`,
        controller: side.controller,
        teamName: side.teamName,
        recruit: side.recruit,
        variables: {},
        attributes: { ...side.attributes, ...(side.side <= 1 ? { faction: factionId } : {}) },
      });
    }
    return out;
  }
}

/**
 * The compiled scenario the scene starts from: the generated map with its start markers, one
 * side per `[side]`, the leaders, and the objectives. The Lua events (`prestart`, `start`,
 * turns, `enemies defeated`) run beside it through the kernel; the outcome the scene reads is
 * the leader's death and the Lua `[endlevel]`.
 */
export function wcCompiledGame(setup: WcSetup, skipLeaderSides: ReadonlySet<number> = new Set()): MwlCompiledGame {
  type Node = MwlCompiledGame['roots'][number];
  const node = (tag: string, attributes: Record<string, string>, nodeChildren: readonly Node[] = []): Node => ({ tag, attributes, children: nodeChildren });
  const rows: string[] = [];
  for (let y = 0; y < setup.height; y++) {
    const cells: string[] = [];
    for (let x = 0; x < setup.width; x++) {
      const start = [...setup.starts].find(([, at]) => at.x === x && at.y === y);
      cells.push(start ? `${start[0]} ${setup.codes[y * setup.width + x]}` : setup.codes[y * setup.width + x]);
    }
    rows.push(cells.join(', '));
  }
  const sides = setup.sides.map((side) => node('side', {
    id: String(side.side),
    controller: side.controller === 'human' ? 'human' : side.controller === 'null' ? 'null' : 'ai',
    gold: String(side.gold),
    recruit: side.recruit.join(','),
    ...(side.canRecruit && side.leaderType && !skipLeaderSides.has(side.side) ? { leader: side.leaderId || `leader_${side.side}` } : {}),
    team_name: side.teamName,
  }));
  const units = setup.sides
    .filter((side) => side.canRecruit && side.leaderType && !skipLeaderSides.has(side.side))
    .map((side) => {
      const start = setup.starts.get(side.startPosition) ?? setup.starts.get(side.side) ?? { x: 0, y: 0 };
      return node('unit', { id: side.leaderId || `leader_${side.side}`, type: side.leaderType, side: String(side.side), x: String(start.x), y: String(start.y) });
    });
  const game = node('game', { schema: '0.1', title: setup.name }, [
    ...sides,
    node('map', { id: setup.id, terrain: rows.join('\n') }),
    ...units,
  ]);
  return { schema: '0.1', roots: [game], assets: [], messages: [] } as unknown as MwlCompiledGame;
}
