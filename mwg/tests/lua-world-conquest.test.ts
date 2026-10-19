import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/scripting/kernel.ts';
import { wmlContents } from '../src/scripting/wml-bridge.ts';
import { WmlPreprocessor, parseWml } from '../src/simulation/wml.ts';
import { dataFiles } from '../tools/lua-data-files.ts';
import fs from 'node:fs';
import { bundledLuaFiles } from '../src/scripting/world-conquest.ts';
import { LUA_FILES } from '../src/generated/lua-files.ts';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

test('indexed bundled directories preserve loader ordering and isolate caller mutations', () => {
  const files = bundledLuaFiles();
  for (const dir of ['lua', 'lua/core', 'campaigns/World_Conquest/lua', 'campaigns/World_Conquest/lua/map']) {
    const children = Object.keys(LUA_FILES).filter((name) => name.startsWith(dir + '/')).map((name) => name.slice(dir.length + 1));
    const dirs = [...new Set(children.filter((name) => name.includes('/')).map((name) => name.split('/')[0] + '/'))].sort();
    const names = children.filter((name) => !name.includes('/')).sort();
    assert.deepEqual(files.list('./' + dir + '/'), [...dirs, ...names]);
    files.list(dir)!.pop();
    assert.deepEqual(files.list(dir), [...dirs, ...names]);
  }
  assert.equal(files.list('absent'), null);
});

function worldConquestWml() {
  const preprocessor = new WmlPreprocessor({ dataDir, defines: ['LOAD_WC2', 'MULTIPLAYER'], onFile: () => {} });
  const macros = path.join(dataDir, 'core', 'macros');
  preprocessor.loadMacros(fs.readdirSync(macros).filter((name) => name.endsWith('.cfg')).map((name) => path.join(macros, name)));
  const main = path.join(dataDir, 'campaigns', 'World_Conquest', '_main.cfg');
  const nodes = parseWml(preprocessor.preprocessFile(main), main);
  return { era: nodes.find((node) => node.tag === 'era')!, resources: nodes.filter((node) => node.tag === 'resource') };
}

test('the real data/lua/core boots on the port\'s engine builtins', () => {
  const vm = createKernel({ files: dataFiles(dataDir) });
  assert.equal(vm.run('return wesnoth.kernel_type()'), 'Game Lua Kernel');
  // core's own helpers work: WML tags, child lookup, string methods
  assert.equal(vm.run('local c = {{"a", {x = 1}}, {"b", {x = 2}}}; return wml.get_child(c, "b").x'), 2);
  assert.equal(vm.run('return ("a, b,c"):split()[3]'), 'c');
});

test('WML variables follow the engine\'s path syntax', () => {
  const vm = createKernel({ files: dataFiles(dataDir) });
  vm.run('wml.variables.gold = 12; wml.variables["unit[1].hp"] = 30; wml.variables["unit[0].hp"] = 20');
  assert.equal(vm.run('return wml.variables.gold'), 12);
  assert.equal(vm.run('return wml.variables["unit.length"]'), 2);
  assert.equal(vm.run('return wml.variables["unit[1].hp"]'), 30);
});

test('events fire by priority and first_time_only handlers run once', () => {
  const vm = createKernel({ files: dataFiles(dataDir) });
  vm.run(`
    log = {}
    wesnoth.game_events.add { name = 'ping', priority = 1, action = function() log[#log + 1] = 'low' end }
    wesnoth.game_events.add { name = 'ping', priority = 5, action = function() log[#log + 1] = 'high' end }
    wesnoth.game_events.fire('ping')
    wesnoth.game_events.fire('ping')
  `);
  assert.deepEqual(Object.values(vm.run('return log') as Record<string, string>), ['high', 'low']);
});

test('World Conquest\'s real era and campaign Lua load with its real WML data', () => {
  const { era, resources } = worldConquestWml();
  const vm = createKernel({ files: dataFiles(dataDir) });
  vm.defineFunction('__wc_era', () => wmlContents(era));
  vm.defineFunction('__wc_resources', () => resources.map((resource) => wmlContents(resource)));
  vm.run('wesnoth.scenario.era = __wc_era(); wesnoth.scenario.resources = __wc_resources()');
  vm.run("wesnoth.dofile('campaigns/World_Conquest/lua/era_main.lua')");
  vm.run("wesnoth.dofile('campaigns/World_Conquest/lua/campaign_main.lua')");
  // the era module read the real factions out of [era]
  assert.ok(Number(vm.run('return #wc2_era.factions_wml')) >= 10);
});

test('World Conquest generates a real scenario in the mapgen kernel', () => {
  const vm = createKernel({ files: dataFiles(dataDir), kind: 'mapgen', seed: 1234 });
  vm.run(`
    wml.variables.wc2_scenario = 1
    wml.variables.wc2_difficulty = { enemy_power = 6 }
    wml.variables.wc2_player_count = 1
    wesnoth.dofile('campaigns/World_Conquest/lua/map/main.lua')
    scenario_result = wc_ii_generate_scenario(1, { nplayers = 1, id = 'WC_II_1p', { 'scenario', {} } })
  `);
  const sides = vm.run(`
    local n = 0
    for _, child in ipairs(scenario_result) do if child[1] == 'side' then n = n + 1 end end
    return n
  `);
  assert.equal(sides, 4, 'one player side plus the three enemy/deserter sides');
  const mapData = String(vm.run('return scenario_result.map_data'));
  assert.match(mapData, /\b1 K\w+/, 'the generated map carries the player keep');
  assert.match(mapData, /\b2 K\w+/);
  // the post-generation script ran: bridges, rivers and villages are on the map
  assert.match(mapData, /\^V\w+/);
});

test('World Conquest\'s real prestart and start events run on a generated map', async () => {
  const { makeGame } = await import('../src/simulation/game.ts');
  const { GAME_DATA } = await import('../src/generated/game-data.ts');
  const { makeUnit } = await import('../src/simulation/unit.ts');
  const { createKernelWithHost } = await import('../src/scripting/kernel.ts');
  const files = dataFiles(dataDir);

  // 1. the mapgen kernel builds the scenario
  const generator = createKernel({ files, kind: 'mapgen', seed: 4242 });
  generator.run(`
    wml.variables.wc2_scenario = 1
    wml.variables.wc2_difficulty = { enemy_power = 6 }
    wml.variables.wc2_player_count = 1
    wesnoth.dofile('campaigns/World_Conquest/lua/map/main.lua')
    scenario_result = wc_ii_generate_scenario(1, { nplayers = 1, id = 'WC_II_1p', { 'scenario', {} } })
  `);
  const scenario = generator.run('return scenario_result') as { [key: string]: any };

  // 2. the playable area is the game grid; WML (1,1) is grid (0,0)
  const all = String(scenario.map_data).split('\n').filter((row) => row.trim()).map((row) => row.split(',').map((cell) => cell.trim()));
  const rows = all.slice(1, -1).map((row) => row.slice(1, -1));
  const keeps = new Map<number, { x: number; y: number }[]>();
  const codes: string[] = [];
  rows.forEach((row, y) => row.forEach((cell, x) => {
    const start = /^(\d+) (\S+)$/.exec(cell);
    if (start) keeps.set(Number(start[1]), [{ x, y }]);
    codes.push(start ? start[2] : cell);
  }));
  const state = makeGame(rows[0].length, rows.length, codes, keeps);
  state.sides = [1, 2, 3, 4];
  for (const [side, type, keepSide] of [[1, 'Lieutenant', 1], [4, 'Peasant', 2]] as const) {
    const leader = makeUnit(GAME_DATA, type, side, keeps.get(keepSide)![0].x, keeps.get(keepSide)![0].y, () => 0.5);
    leader.canRecruit = true;
    state.units.push(leader);
  }
  const sides = new Map<number, import('../src/scripting/game-host.ts').SideSettings>([1, 2, 3, 4].map((side) => [side, { gold: 100, name: `Side ${side}`, controller: side === 1 ? 'human' : 'ai', teamName: String(side), recruit: [] as string[], variables: {}, attributes: side === 1 ? { faction: 'Loyalists' } : {} } as import('../src/scripting/game-host.ts').SideSettings]));
  const said: string[] = [];

  // 3. the game kernel runs the campaign's Lua and the scenario's events
  const { vm } = createKernelWithHost({
    files,
    kind: 'game',
    services: { state: () => state, data: GAME_DATA, sides, random: () => 0.5, currentSide: () => 1, currentTurn: () => 1, say: (message) => said.push(message.text) },
  });
  const { era, resources } = worldConquestWml();
  vm.defineFunction('__wc_era', () => wmlContents(era));
  vm.defineFunction('__wc_resources', () => resources.map((resource) => wmlContents(resource)));
  vm.defineFunction('__scenario', () => scenario);
  vm.run(`
    wesnoth.scenario.era = __wc_era()
    wesnoth.scenario.resources = __wc_resources()
    local scenario = __scenario()
    local by_id = {}
    for _, r in ipairs(wesnoth.scenario.resources) do by_id[r.id] = r end
    wml.variables.wc2_difficulty = { name = 'Lieutenant', enemy_power = 8, enemy_trained = 4, heroes = 2, extra_gold = 20, extra_training = true, experience_penalty = 10 }
    for _, child in ipairs(scenario) do
      if child[1] == 'variables' then for k, v in pairs(child[2]) do if type(k) == 'string' then wml.variables[k] = v end end end
      if child[1] == 'load_resource' then
        for _, rc in ipairs(by_id[child[2].id] or {}) do if rc[1] == 'lua' then assert(load(rc[2].code, '=resource'))() end end
      end
    end
    for _, child in ipairs(scenario) do if child[1] == 'event' then wesnoth.wml_actions.event(child[2]) end end
    wesnoth.game_events.fire('prestart')
    wesnoth.game_events.fire('start')
  `);
  // the real Lua gave the player heroes and the enemy leader an escort, and told the plot
  assert.ok(state.units.filter((unit) => unit.side === 1).length >= 3, 'the player has a leader and starting heroes');
  assert.ok(state.units.filter((unit) => unit.side === 4).length >= 2, 'the enemy has a leader and a commander');
  assert.ok(said.some((text) => text.includes('To war!')), 'the start event\'s plot messages reached the player');
  assert.ok(sides.get(1)!.gold > 100, 'the difficulty\'s extra gold was added');
});

test('the WorldConquest controller generates a map, starts the game and fires events', async () => {
  const { WorldConquest, wcFactions, wcDifficulties } = await import('../src/scripting/world-conquest.ts');
  const { makeGame } = await import('../src/simulation/game.ts');
  const { GAME_DATA } = await import('../src/generated/game-data.ts');

  assert.ok(wcFactions().length >= 10, 'the era offers its factions');
  assert.ok(wcDifficulties().some((entry) => entry.id === 'NORMAL'));
  const faction = wcFactions()[0];
  const wc = new WorldConquest({ data: GAME_DATA, seed: 31337, difficulty: 'NORMAL', factionId: faction.id });
  const setup = wc.generate();
  assert.equal(setup.number, 1);
  assert.ok(setup.width > 10 && setup.height > 10);
  const state = makeGame(setup.width, setup.height, setup.codes, new Map([...setup.starts].map(([side, start]) => [side, [start]])));
  state.sides = setup.sides.map((side) => side.side);
  WorldConquest.leaders(setup, GAME_DATA, state, () => 0.5);
  const sides = WorldConquest.sideSettings(setup, faction.id);
  const said: string[] = [];
  wc.start(setup, { state: () => state, data: GAME_DATA, sides, random: () => 0.5, currentSide: () => 1, currentTurn: () => 1, say: (message) => said.push(message.text) });
  wc.fire('prestart');
  wc.fire('start');
  assert.ok(state.units.length > setup.sides.filter((side) => side.canRecruit).length, 'Lua added units beyond the leaders');
  assert.ok(said.length > 0, 'the plot reached the player');
  // a turn event goes through the same registry
  wc.fire('turn 2');
});
