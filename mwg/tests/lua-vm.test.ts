import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { LuaError, LuaVm, Multi } from '../src/scripting/lua-vm.ts';
import { BOOTSTRAP_LUA } from '../src/scripting/wesnoth-prelude.ts';
import { dataFiles } from '../tools/lua-data-files.ts';

const files = { read: () => null, list: () => null };

test('shared VM setup preserves the recorded script stream across Lua and host draws', () => {
  const vm = new LuaVm(files, 1234);
  // Recorded before MWG 0.35.1 setup adoption: the port's existing seeded stream.
  assert.deepEqual([
    vm.nextRandom(), vm.run('return __random()'), vm.nextRandom(),
    vm.run('return __random()'), vm.nextRandom(), vm.run('return __random()'),
  ], [
    0.07329497812315822, 0.7034119898453355, 0.9028560190927237,
    0.9705493662040681, 0.04096397617831826, 0.11776310740970075,
  ]);
});

test('shared file helpers work inside coroutines without changing port print diagnostics', () => {
  const vm = new LuaVm({
    read: (name) => name === 'lua/test.lua' ? 'return 12' : null,
    list: (name) => name === 'lua' ? ['core/', 'test.lua'] : null,
  });
  assert.equal(vm.run(`
    local co = coroutine.create(function()
      local names = __fs_list('lua')
      assert(names[1] == 'core/' and names[2] == 'test.lua')
      assert(__fs_read('absent') == nil and __fs_list('absent') == nil)
      return assert(load(__fs_read('lua/' .. names[2])))()
    end)
    local ok, value = coroutine.resume(co)
    assert(ok)
    print('loaded', value, {answer = value})
    return value
  `), 12);
  assert.deepEqual(vm.output, ['loaded\t12\t{"answer":12}']);
});

test('real World Conquest Wild connected components receives six adjacent locations', () => {
  const realFiles = dataFiles(path.resolve(import.meta.dirname, '..', '..', 'data'));
  const vm = new LuaVm(realFiles);
  vm.run(BOOTSTRAP_LUA);
  assert.equal(vm.run('return select("#", wesnoth.map.get_adjacent_hexes(2, 2))'), 6);
  const source = realFiles.read('campaigns/World_Conquest/lua/map/postgeneration/4F_Wild.lua')!;
  vm.run(source.slice(0, source.indexOf('function repaint(')), '@4F_Wild.lua');
  assert.deepEqual(vm.run(`
    local groups = connected_components({{1, 1}, {2, 1}, {6, 6}})
    local sizes = {}
    for i, group in ipairs(groups) do sizes[i] = #group end
    table.sort(sizes)
    return sizes
  `), { '1': 1, '2': 2 });
});

test('radius filters preserve exhaustive reachable-set results with early exits', () => {
  const vm = new LuaVm(dataFiles(path.resolve(import.meta.dirname, '..', '..', 'data')));
  vm.run(BOOTSTRAP_LUA);
  assert.equal(vm.run(`
    local map = wesnoth.map.create(7, 7, 'Gg')
    for y = 0, 6 do map[{3, y}] = 'Ww' end
    map[{3, 3}] = 'Gg'
    map[{5, 4}] = 'Mm'
    local target = wesnoth.map.filter({'terrain', 'Mm'})
    local pass = wesnoth.map.filter({'terrain', 'Gg,Mm'})
    local checked = 0
    for _, constrained in ipairs({false, true}) do
      for radius = 0, 4 do
        local spec = {'radius', radius, {'terrain', 'Mm'}}
        if constrained then spec.filter_radius = {'terrain', 'Gg,Mm'} end
        local filter = wesnoth.map.filter(spec)
        for x = 0, 6 do for y = 0, 6 do
          local seen = {[x .. ',' .. y] = true}
          local ring, all = {{x, y}}, {{x, y}}
          for step = 1, radius do
            local next_ring = {}
            for _, loc in ipairs(ring) do
              for _, n in ipairs({wesnoth.map.get_adjacent_hexes(loc)}) do
                local key = n.x .. ',' .. n.y
                if not seen[key] and n.x >= 0 and n.y >= 0 and n.x < 7 and n.y < 7
                  and (not constrained or pass.matches(map, n.x, n.y)) then
                  seen[key] = true
                  next_ring[#next_ring + 1] = n
                  all[#all + 1] = n
                end
              end
            end
            ring = next_ring
          end
          local expected = false
          for _, loc in ipairs(all) do
            if target.matches(map, loc[1], loc[2]) then expected = true end
          end
          assert(filter.matches(map, x, y) == expected)
          checked = checked + 1
        end end
      end
    end
    return checked
  `), 490);
});

test('Lua execution limits stop loops even behind pcall and coroutine.resume', () => {
  const vm = new LuaVm(files, 123, { instructionLimit: 10_000 });
  for (const source of [
    'while true do end',
    'pcall(function() while true do end end); return 42',
    'local co = coroutine.create(function() while true do end end); coroutine.resume(co); return 42',
  ]) {
    assert.throws(() => vm.run(source), LuaError);
    assert.equal(vm.run('return 42'), 42, 'the next call gets a fresh budget and a restored stack');
  }
  vm.run('function runaway() while true do end end');
  assert.throws(() => vm.call('runaway'), LuaError);
  vm.run('api = setmetatable({}, {__index = function() while true do end end})');
  assert.throws(() => vm.call('api.missing'), LuaError, 'global-path lookup stays inside the budget');
  assert.equal(vm.run('return 7'), 7);
});

test('Lua allocation limits cover parsing and native string operations', () => {
  const vm = new LuaVm(files, 123, { memoryLimit: 16_384 });
  assert.throws(() => vm.run('return string.rep("x", 100000)'), LuaError);
  assert.equal(vm.run('return 9'), 9);
  assert.throws(() => vm.run(`return "${'x'.repeat(100_000)}"`), LuaError);
  assert.equal(vm.run('return 10'), 10);
});

test('the guarded Wesnoth bridge keeps WML indices and coroutine callback results', () => {
  const vm = new LuaVm(files, 123);
  vm.defineFunction('host.values', (value) => new Multi([value, { '1': 'tag', '2': { hp: 20 } }]));
  assert.deepEqual(vm.run(`
    local co = coroutine.create(function()
      local first, cfg = host.values('hello')
      coroutine.yield({first = first, tag = cfg[1], hp = cfg[2].hp})
      return 8
    end)
    local ok, result = coroutine.resume(co)
    assert(ok)
    return result
  `), { first: 'hello', tag: 'tag', hp: 20 });
  assert.throws(() => vm.run('error({reason = "broken"})'), /broken/);
  assert.equal(vm.run('return 1'), 1);
});
