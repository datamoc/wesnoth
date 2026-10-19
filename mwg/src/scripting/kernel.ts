// Boot sequence of the Wesnoth Lua kernel (`lua_kernel_base` + `game_lua_kernel`): the
// builtins, then the real `data/lua/core`, then the real WML actions (`wml-tags.lua`),
// then whatever the campaign loads (`[lua]` blocks of its resources).
import { generateDefaultMap, type WmlTable } from '../simulation/default-map-generator.ts';
import { parseWml } from '../simulation/wml.ts';
import { GAME_LUA } from './game-prelude.ts';
import { LuaGameHost, type LuaGameServices } from './game-host.ts';
import { LuaVm, type LuaFileProvider } from './lua-vm.ts';
import { BOOTSTRAP_LUA } from './wesnoth-prelude.ts';
import { wmlContents } from './wml-bridge.ts';

export interface KernelOptions {
  files: LuaFileProvider;
  /**
   * `game` runs a scenario's events; `mapgen` is the separate kernel the engine uses for
   * `scenario_generation=lua` (`mapgen_lua_kernel.cpp`) and carries the terrain-map API.
   */
  kind?: 'game' | 'mapgen';
  /** the live game the `game` kernel scripts act on; required for scenario play */
  services?: LuaGameServices;
  /** seed of the script random stream */
  seed?: number;
}

/** The files `data/core/_main.cfg` loads at start (its `[lua]` block). */
export const CORE_LUA_FILES: readonly string[] = [
  'lua/wml-tags.lua',
  'lua/feeding.lua',
  'lua/diversion.lua',
  'lua/stun.lua',
  'lua/scenario_end_events.lua',
];

export interface Kernel {
  vm: LuaVm;
  host: LuaGameHost | null;
}

export function createKernel(options: KernelOptions): LuaVm {
  return createKernelWithHost(options).vm;
}

export function createKernelWithHost(options: KernelOptions): Kernel {
  // Mapgen postprocessing searches thousands of hexes before returning to the scene;
  // give it more headroom than interactive events (PORT_COVERAGE.md "Lua execution budgets").
  const limits = options.kind === 'mapgen'
    ? { instructionLimit: 500_000_000, memoryLimit: 256 * 1024 * 1024 }
    : undefined;
  const vm = new LuaVm(options.files, options.seed, limits);
  vm.defineFunction('__wml_parse', (text) => {
    const root = { tag: 'root', attributes: {}, children: parseWml(String(text), '<lua>'), location: { file: '<lua>', line: 0, column: 0 } };
    return wmlContents(root);
  });
  // wesnoth.map.generate(width, height, cfg): the engine's default random map generator.
  vm.defineFunction('__map_generate', (width, height, cfg) =>
    generateDefaultMap(Number(width), Number(height), (cfg ?? {}) as WmlTable, Math.floor(vm.nextRandom() * 2 ** 31)));
  vm.run(BOOTSTRAP_LUA, '=bootstrap');
  vm.run(`__kernel_type = ${options.kind === 'mapgen' ? "'Mapgen Lua Kernel'" : "'Game Lua Kernel'"}`, '=kind');
  let host: LuaGameHost | null = null;
  if (options.kind !== 'mapgen' && options.services) {
    host = new LuaGameHost(options.services);
    host.install(vm);
    vm.run(GAME_LUA, '=game-prelude');
  }
  vm.run("wesnoth.require('lua/core')", '=core');
  // `data/core/_main.cfg`'s [lua] runs in the game kernel only; the mapgen kernel has none of it.
  if (options.kind !== 'mapgen') for (const file of CORE_LUA_FILES) vm.run(`wesnoth.dofile('${file}')`, `=${file}`);
  return { vm, host };
}
