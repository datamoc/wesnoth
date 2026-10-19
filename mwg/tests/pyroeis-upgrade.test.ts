import assert from 'node:assert/strict';
import test from 'node:test';
import pyroeis from '@datamoc/pyroeis';
import { luaToJs } from 'mwg/mwl/pyroeis';

// The port's VM and MWG's optional Lua host now share one package, @datamoc/pyroeis
// (the renamed @datamoc/fengari 0.5.4: same Lua 5.4.6 VM, same execution guard).

test('shared pyroeis reports the Lua version the port targets', () => {
  assert.match(pyroeis.PYROEIS_VERSION, /^Pyroeis 0\.6/);
  const vm = new pyroeis.PyroeisVm();
  assert.equal(vm.run('return _VERSION'), 'Lua 5.4');
});

test('shared pyroeis rejects instruction limits caught by Lua-created coroutines', () => {
  const vm = new pyroeis.PyroeisVm(undefined, 123, { sandbox: true, limits: { instructions: 1_000 } });
  assert.throws(() => vm.run(`
    local co = coroutine.create(function() while true do end end)
    coroutine.resume(co)
    return 42
  `), pyroeis.LimitError);
  assert.equal(vm.run('return 42'), 42);
});

test('shared pyroeis budgets close handlers and recovers for the next operation', () => {
  const vm = new pyroeis.PyroeisVm(undefined, 123, { sandbox: true, limits: { instructions: 1_000 } });
  const co = vm.coroutineFromSource(`
    local value <close> = setmetatable({}, {__close = function()
      local n = 0
      for i = 1, 10000 do n = n + i end
      closed = n
    end})
    coroutine.yield()
  `);
  assert.equal(co.resume().done, false);
  assert.throws(() => co.close(), pyroeis.LimitError);
  assert.equal(vm.run('return closed'), null, 'the interrupted handler never completed');
  assert.equal(vm.run('return 7'), 7);
});

test('MWG Lua translation preserves false, zero, empty strings and single evaluation', () => {
  const source = `
    local calls = 0
    function choose(a, b) return a or b end
    function counted(a)
      calls = calls + 1
      return a
    end
    function once(a, b) return counted(a) or b end
    function count() return calls end
  `;
  const translated = luaToJs(source, { format: 'none' });
  assert.deepEqual(translated.warnings, []);
  const js = new Function(`${translated.code}; return {choose, once, count};`)() as {
    choose(a: unknown, b: unknown): unknown;
    once(a: unknown, b: unknown): unknown;
    count(): number;
  };
  const vm = new pyroeis.PyroeisVm();
  vm.run(source);
  for (const value of [false, 0, '', 17, 'hello', null]) {
    // luaToJs represents nil as undefined; the interpreter bridge uses null.
    const translatedValue = value === null ? undefined : value;
    assert.equal(js.choose(translatedValue, 'fallback'), vm.call('choose', value, 'fallback'));
    assert.equal(js.once(translatedValue, 'fallback'), vm.call('once', value, 'fallback'));
    assert.equal(js.count(), vm.call('count'));
  }
});
