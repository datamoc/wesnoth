// A persistent Lua state (@datamoc/pyroeis 0.6.0, shared with MWG 0.36.0) for the Wesnoth Lua API.
//
// Real engine: `src/scripting/lua_kernel_base.cpp` owns one `lua_State`, registers the
// C++ builtins under `wesnoth`/`wml`/..., and loads `data/lua/core` on top of them. The
// framework's `createPyroeisRuntime` now supports state and callbacks, but omits debug,
// os and load, which the real package loader uses for relative paths and source loading.
// Keep the Wesnoth bridge, backed by the same PyroeisVm execution guard as MWG's host.
//
// Values cross the bridge as JSON-like data: nil/boolean/number/string, arrays and
// string-keyed objects (integer-looking keys become Lua integers, as in WML tables).
// Everything stateful (units, sides, the map) stays on the TypeScript side behind ids.
//
// Pyroeis is the package fengari 0.5.4 became: same Lua 5.4.6 VM, same `lua`/`lauxlib`
// C API and the same `PyroeisVm` guard, under a name the framework now shares. A default
// import is used rather than named ones because the package is CommonJS
// (`module.exports = Object.assign(...)`), which neither Rollup nor Node's ESM interop
// can resolve named exports from statically.
import pyroeis from '@datamoc/pyroeis';

const { lauxlib, lua, to_jsstring, to_luastring } = pyroeis;

export type LuaValue = null | boolean | number | string | LuaValue[] | { [key: string]: LuaValue };

/** Several return values from a host function. */
export class Multi {
  readonly values: LuaValue[];
  constructor(values: LuaValue[]) {
    this.values = values;
  }
}

/** A host function: receives the call's arguments, returns its results. */
export type HostFunction = (...args: LuaValue[]) => LuaValue | Multi | void;

/**
 * The data files the scripts can read, addressed like the engine does: paths relative to
 * the data directory (`lua/core`, `campaigns/World_Conquest/lua/main.lua`).
 */
export interface LuaFileProvider {
  /** file contents, or null when there is no such file */
  read(path: string): string | null;
  /** names in a directory (subdirectories first, each with a trailing `/`), or null when it is not one */
  list(path: string): string[] | null;
}

export interface LuaVmLimits {
  instructionLimit?: number;
  memoryLimit?: number;
}

export class LuaError extends Error {
  readonly traceback: string;
  constructor(message: string, traceback: string) {
    super(message);
    this.name = 'LuaError';
    this.traceback = traceback;
  }
}

export class LuaVm {
  readonly state: any;
  private readonly engine: pyroeis.PyroeisVm;
  /** Messages the script printed (`print`, `wesnoth.log`), kept for tests and diagnostics. */
  readonly output: string[] = [];
  /** the coroutine a host function was called from (its stack holds the arguments), if any */
  private thread: any = null;

  constructor(files: LuaFileProvider, seed = 0x57e5_a07, limits: LuaVmLimits = {}) {
    // Deviation (PORT_COVERAGE.md "Lua execution budgets"): native Wesnoth imposes
    // no per-call instruction/allocation cap. Bound each browser operation, including
    // Lua-created coroutine resumes, to prevent a script from freezing the scene.
    // Map generation needs more headroom than MWG's expression-host defaults.
    const instructions = limits.instructionLimit ?? 50_000_000;
    const totalAllocation = limits.memoryLimit ?? 128 * 1024 * 1024;
    for (const [name, value] of Object.entries({ instructions, totalAllocation })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }
    // Use the shared file helpers and seeded stream. Native print avoids installing
    // a buffer callback just to replace it with the port's existing diagnostic format.
    this.engine = new pyroeis.PyroeisVm(files, seed, { print: 'native', limits: { instructions, totalAllocation } });
    this.state = this.engine.state;
    this.defineFunction('print', (...args) => {
      this.output.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\t'));
    });
  }

  /** The script-visible mulberry32 stream, shared with Lua's `__random`. */
  nextRandom(): number {
    return this.engine.nextRandom();
  }

  /** Push a JS value as a Lua value. */
  push(value: LuaValue | undefined): void {
    const L = this.thread ?? this.state;
    lua.lua_checkstack(L, 8);
    if (value === null || value === undefined) {
      lua.lua_pushnil(L);
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(L, value);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) lua.lua_pushinteger(L, value);
      else lua.lua_pushnumber(L, value);
    } else if (typeof value === 'string') {
      lua.lua_pushstring(L, to_luastring(value));
    } else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((entry, index) => {
        this.push(entry);
        lua.lua_seti(L, -2, index + 1);
      });
    } else {
      lua.lua_createtable(L, 0, Object.keys(value).length);
      for (const [key, entry] of Object.entries(value)) {
        this.push(entry);
        if (/^-?\d+$/.test(key)) lua.lua_seti(L, -2, Number(key));
        else lua.lua_setfield(L, -2, to_luastring(key));
      }
    }
  }

  /** Read the value at a stack index as JSON-like data. Functions and userdata read as null. */
  read(index: number, depth = 0): LuaValue {
    const L = this.thread ?? this.state;
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
    if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index));
    if (type !== lua.LUA_TTABLE || depth > 24) return null;
    lua.lua_checkstack(L, 8);
    const table = index < 0 ? lua.lua_gettop(L) + index + 1 : index;
    const result: { [key: string]: LuaValue } = {};
    lua.lua_pushnil(L);
    while (lua.lua_next(L, table) !== 0) {
      const keyType = lua.lua_type(L, -2);
      let key: string | null = null;
      if (keyType === lua.LUA_TNUMBER) key = String(lua.lua_tonumber(L, -2));
      else if (keyType === lua.LUA_TSTRING) key = to_jsstring(lua.lua_tostring(L, -2));
      if (key !== null) result[key] = this.read(-1, depth + 1);
      lua.lua_pop(L, 1);
    }
    return result;
  }

  /** Register `name` (a dotted path under globals, created as needed) as a host function. */
  defineFunction(name: string, fn: HostFunction): void {
    const L = this.state;
    const parts = name.split('.');
    const last = parts.pop()!;
    if (parts.length === 0) {
      lua.lua_pushjsfunction(L, this.wrap(fn));
      lua.lua_setglobal(L, to_luastring(last));
      return;
    }
    lua.lua_getglobal(L, to_luastring(parts[0]));
    if (lua.lua_isnil(L, -1)) {
      lua.lua_pop(L, 1);
      lua.lua_newtable(L);
      lua.lua_pushvalue(L, -1);
      lua.lua_setglobal(L, to_luastring(parts[0]));
    }
    for (const part of parts.slice(1)) {
      lua.lua_getfield(L, -1, to_luastring(part));
      if (lua.lua_isnil(L, -1)) {
        lua.lua_pop(L, 1);
        lua.lua_newtable(L);
        lua.lua_pushvalue(L, -1);
        lua.lua_setfield(L, -3, to_luastring(part));
      }
      lua.lua_remove(L, -2);
    }
    lua.lua_pushjsfunction(L, this.wrap(fn));
    lua.lua_setfield(L, -2, to_luastring(last));
    lua.lua_pop(L, 1);
  }

  private wrap(fn: HostFunction): (L: unknown) => number {
    return (L) => {
      // A script running inside a coroutine calls with that coroutine's own stack.
      const previous = this.thread;
      this.thread = L;
      try {
        const count = lua.lua_gettop(L);
        const args: LuaValue[] = [];
        for (let index = 1; index <= count; index++) args.push(this.read(index));
        let results: LuaValue | Multi | void;
        try {
          results = fn(...args);
        } catch (error) {
          // Surface a TypeScript failure as a Lua error, so `pcall` in the scripts sees it.
          lua.lua_pushstring(L, to_luastring(error instanceof Error ? error.message : String(error)));
          return lua.lua_error(L);
        }
        if (results === undefined) return 0;
        if (results instanceof Multi) {
          for (const value of results.values) this.push(value);
          return results.values.length;
        }
        this.push(results);
        return 1;
      } finally {
        this.thread = previous;
      }
    };
  }

  private protectedCall(argCount: number, base: number, handler: number): LuaValue {
    const L = this.state;
    const status = lua.lua_pcall(L, argCount, 1, handler);
    if (status !== lua.LUA_OK) {
      // an error value that is not a string (a table, nil) is described, not dropped
      const raw = lua.lua_tostring(L, -1);
      const trace = raw ? to_jsstring(raw) : `error object of type ${to_jsstring(lua.lua_typename(L, lua.lua_type(L, -1)))}`;
      lua.lua_settop(L, base);
      throw new LuaError(trace.split('\n')[0], trace);
    }
    const value = this.read(-1);
    lua.lua_settop(L, base);
    return value;
  }

  private pushTracebackHandler(): number {
    const L = this.state;
    lua.lua_pushjsfunction(L, (state: unknown) => {
      // an error value that is a table (wml.error, a script's own) is shown with its fields
      let message = lua.lua_tostring(state, 1);
      if (!message && lua.lua_istable(state, 1)) message = to_luastring(`error table ${JSON.stringify(this.read(1))}`);
      lauxlib.luaL_traceback(state, state, message, 1);
      return 1;
    });
    return lua.lua_gettop(L);
  }

  /** Run Lua source; returns the chunk's first result. Throws a `LuaError` with a traceback. */
  run(source: string, chunkName = '=chunk'): LuaValue {
    return this.execute(() => this.runChunk(source, chunkName));
  }

  private runChunk(source: string, chunkName: string): LuaValue {
    const L = this.state;
    const base = lua.lua_gettop(L);
    const handler = this.pushTracebackHandler();
    const bytes = to_luastring(source);
    const loaded = lauxlib.luaL_loadbuffer(L, bytes, bytes.length, to_luastring(chunkName));
    if (loaded !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, base);
      throw new LuaError(message, message);
    }
    return this.protectedCall(0, base, handler);
  }

  /** Call a global Lua function by dotted path with JSON-like arguments; returns its first result. */
  call(path: string, ...args: LuaValue[]): LuaValue {
    return this.execute(() => this.callFunction(path, args));
  }

  private callFunction(path: string, args: LuaValue[]): LuaValue {
    const L = this.state;
    const base = lua.lua_gettop(L);
    const handler = this.pushTracebackHandler();
    const parts = path.split('.');
    lua.lua_getglobal(L, to_luastring(parts[0]));
    for (const part of parts.slice(1)) {
      lua.lua_getfield(L, -1, to_luastring(part));
      lua.lua_remove(L, -2);
    }
    for (const arg of args) this.push(arg);
    return this.protectedCall(args.length, base, handler);
  }

  private execute(operation: () => LuaValue): LuaValue {
    try {
      // `protect` owns the fresh execution budget, rejects swallowed coroutine limit
      // errors, and restores the stack even on compilation failure.
      return this.engine.protect(operation);
    } catch (error) {
      if (error instanceof pyroeis.LuaError) {
        throw new LuaError(error.message, error.traceback ?? error.message);
      }
      throw error;
    }
  }
}
