// The Lua side of the game kernel (`game_lua_kernel.cpp`, `lua_unit.cpp`, `lua_team.cpp`):
// unit and side proxies, `wesnoth.units`/`wesnoth.sides`/`wesnoth.current`, and the engine's
// own WML actions. The stateful work is done by the `__*` functions in `game-host.ts`.
//
// Like `wesnoth-prelude.ts` this is a template literal: no dollar-brace and no backticks.

export const GAME_LUA = String.raw`
-- ---------------------------------------------------------------- units
do
  local proxies = setmetatable({}, { __mode = 'v' })
  local UnitMT = { __metatable = 'unit' }
  local methods = {}

  local function proxy(id)
    if id == nil then return nil end
    local existing = proxies[id]
    if existing then return existing end
    local unit = setmetatable({ __id = id }, UnitMT)
    proxies[id] = unit
    return unit
  end
  wesnoth.__unit_proxy = proxy

  local status_mt = {
    __index = function(t, name) return __unit_status(rawget(t, '__id'), name) end,
    __newindex = function(t, name, value) __unit_status(rawget(t, '__id'), name, value and true or false) end,
  }
  -- unit and side variables are WML variable stores: paths like "a.b[1].c" and "a.length"
  local variables_mt = {
    __metatable = 'unit variables',
    __index = function(t, name)
      return wml.__path_get(__unit_variables(rawget(t, '__id')) or {}, name)
    end,
    __newindex = function(t, name, value)
      local id = rawget(t, '__id')
      local vars = __unit_variables(id) or {}
      wml.__path_set(vars, name, value)
      __unit_set_variables(id, vars)
    end,
  }

  UnitMT.__index = function(u, key)
    local method = methods[key]
    if method then return method end
    local id = rawget(u, '__id')
    if key == 'status' then return setmetatable({ __id = id }, status_mt) end
    if key == 'variables' then return setmetatable({ __id = id }, variables_mt) end
    if key == 'valid' then return 'map' end
    if key == '__cfg' then return methods.to_wml(u) end
    if key == 'modifications' then
      local mods = {}
      for _, m in ipairs(__unit_mods(id)) do mods[#mods + 1] = { m[1], m[2] } end
      return mods
    end
    if key == 'attacks' then return methods.__attacks(u) end
    if key == 'abilities' then return methods.__abilities(u) end
    if key == 'advances_to' or key == 'advances_to_list' then return wesnoth.unit_types[__unit_get(id, 'type')].advances_to end
    if key == 'type' then return __unit_get(id, 'type') end
    return __unit_get(id, key)
  end
  UnitMT.__newindex = function(u, key, value) __unit_set(rawget(u, '__id'), key, value) end
  UnitMT.__eq = function(a, b) return rawget(a, '__id') == rawget(b, '__id') end
  UnitMT.__tostring = function(u) return 'unit ' .. tostring(rawget(u, '__id')) end

  function methods.matches(u, filter) return __unit_matches(rawget(u, '__id'), filter) end
  function methods.to_map(u, x, y) return wesnoth.units.to_map(u, x, y) end
  function methods.to_recall(u) return wesnoth.units.to_recall(u) end
  function methods.erase(u) return wesnoth.units.erase(u) end
  function methods.extract(u) return wesnoth.units.extract(u) end
  function methods.clone(u) return wesnoth.units.clone(u) end
  function methods.add_modification(u, kind, cfg, replace) return wesnoth.units.add_modification(u, kind, cfg, replace) end
  function methods.advance(u, ...) return wesnoth.units.advance(u, ...) end
  function methods.transform(u, to) return wesnoth.units.transform(u, to) end
  function methods.remove_modifications(u, filter, kind) return wesnoth.units.remove_modifications(u, filter, kind) end
  function methods.__attacks(u) return {} end
  function methods.__abilities(u) return {} end
  function methods.resistance_against(u, damage_type) return 0 end
  function methods.defense_on(u, terrain) return 60 end
  function methods.movement_on(u, terrain) return 1 end
  function methods.ability(u, id) return false end
  function methods.to_wml(u)
    local mods = {}
    for _, m in ipairs(__unit_mods(rawget(u, '__id'))) do mods[#mods + 1] = { m[1], m[2] } end
    return {
      type = u.type, side = u.side, x = u.x, y = u.y, id = u.id, name = u.name,
      hitpoints = u.hitpoints, max_hitpoints = u.max_hitpoints, experience = u.experience,
      moves = u.moves, max_moves = u.max_moves, canrecruit = u.canrecruit,
      { 'modifications', mods },
    }
  end
  function methods.get_variable(u, name) return u.variables[name] end

  local units = wesnoth.units

  function units.get(a, b)
    local x, y = wesnoth.map.__read_loc and wesnoth.map.__read_loc(a, b) or a, b
    if type(a) == 'string' then
      for _, id in ipairs(__units_find({ id = a })) do return proxy(id) end
      return nil
    end
    if type(a) == 'table' then x, y = a.x or a[1], a.y or a[2] else x, y = a, b end
    return proxy(__unit_at(x, y))
  end

  function units.find_on_map(filter)
    local out = {}
    for _, id in ipairs(__units_find(filter or {})) do out[#out + 1] = proxy(id) end
    return out
  end

  function units.find_on_recall(filter)
    local out = {}
    local side = (filter and filter.side) or wesnoth.current.side
    for _, id in ipairs(__units_recall(tonumber(side) or 1)) do
      local unit = proxy(id)
      if filter == nil or unit:matches(filter) then out[#out + 1] = unit end
    end
    return out
  end

  function units.matches(unit, filter) return unit:matches(filter) end

  function units.create(cfg)
    local id = __unit_create(cfg)
    return proxy(id)
  end

  function units.to_map(unit, x, y)
    if getmetatable(unit) ~= 'unit' and type(unit) == 'table' then
      -- a unit config: apply its hit point fields to the unit standing on its hex
      local existing = units.get(unit.x, unit.y)
      if existing then
        existing.max_hitpoints = unit.max_hitpoints or existing.max_hitpoints
        existing.hitpoints = unit.hitpoints or existing.hitpoints
      end
      return
    end
    if type(x) == 'table' then x, y = x.x or x[1], x.y or x[2] end
    x, y = x or unit.x, y or unit.y
    __unit_place(rawget(unit, '__id'), x, y)
  end
  function units.to_recall(unit) __unit_to_recall(rawget(unit, '__id')) end
  function units.erase(unit) __unit_erase(rawget(unit, '__id')) end
  function units.extract(unit) __unit_erase(rawget(unit, '__id')) end
  function units.clone(unit)
    return units.create { type = unit.type, side = unit.side, x = unit.x, y = unit.y, name = unit.name }
  end
  function units.transform(unit, to) __unit_set(rawget(unit, '__id'), 'type', to) end
  function units.advance(unit) end
  function units.add_modification(unit, kind, cfg, replace)
    -- [effect]s: Lua effects (wesnoth.effects) first, then the engine's built-in ones
    for _, child in ipairs(cfg or {}) do
      if child[1] == 'effect' then
        local effect = child[2]
        local custom = wesnoth.effects[effect.apply_to]
        if custom then custom(unit, effect) else wesnoth.__builtin_effect(unit, effect) end
      end
    end
    __unit_add_mod(rawget(unit, '__id'), kind, cfg or {})
  end
  function units.remove_modifications(unit, filter, kind)
    __unit_remove_mods(rawget(unit, '__id'), kind, filter or {})
  end
  function units.select() end
  function units.scroll_to() end
  function units.resistance_against(unit, damage_type) return 0 end
  function units.defense_on(unit, terrain) return 60 end
  function units.movement_on(unit, terrain) return 1 end
  function units.vision_on(unit, terrain) return 1 end
  function units.jamming_on(unit, terrain) return 99 end
  function units.ability(unit, id) return false end
  function units.create_animator() return { add = function() end, run = function() end } end
  function units.create_weapon() return {} end
  function units.teleport() end

  -- wesnoth.unit_types: type definitions by id
  setmetatable(wesnoth.unit_types, {
    __index = function(t, name)
      local info = __unit_type_info(name)
      if not info then return nil end
      local entry = setmetatable({}, { __index = info })
      rawset(t, name, entry)
      return entry
    end,
    __pairs = function(t)
      local names = __unit_types()
      local i = 0
      return function()
        i = i + 1
        local name = names[i]
        if name then return name, t[name] end
      end
    end,
  })

  -- ---------------------------------------------------------------- sides
  local SideMT = { __metatable = 'side' }
  local side_proxies = {}
  local function side_proxy(n)
    if not __side_list_has(n) then return nil end
    local existing = side_proxies[n]
    if existing then return existing end
    local s = setmetatable({ __side = n }, SideMT)
    side_proxies[n] = s
    return s
  end
  function __side_list_has(n)
    for _, side in ipairs(__side_list()) do if side == n then return true end end
    return false
  end
  local side_vars_mt = {
    __metatable = 'side variables',
    __index = function(t, name)
      return wml.__path_get(__side_get(rawget(t, '__side'), 'variables') or {}, name)
    end,
    __newindex = function(t, name, value)
      local n = rawget(t, '__side')
      local vars = __side_get(n, 'variables') or {}
      wml.__path_set(vars, name, value)
      __side_set(n, 'variables', vars)
    end,
  }
  SideMT.__index = function(s, key)
    local n = rawget(s, '__side')
    if key == 'side' then return n end
    if key == 'variables' then return setmetatable({ __side = n }, side_vars_mt) end
    if key == 'leader' then return proxy(__side_leader(n)) end
    if key == 'recruit' then return __side_get(n, 'recruit') or {} end
    if key == 'is_local' then return true end
    if key == 'num_units' then return #wesnoth.units.find_on_map { side = n } end
    if key == 'num_villages' then return 0 end
    local value = __side_get(n, key)
    return value
  end
  SideMT.__newindex = function(s, key, value) __side_set(rawget(s, '__side'), key, value) end
  SideMT.__eq = function(a, b) return rawget(a, '__side') == rawget(b, '__side') end

  function wesnoth.sides.get(n) return side_proxy(n) end
  -- A side filter: side (a number list), team_name, controller, [has_unit], [enemy_of],
  -- with [not]/[and]/[or] folded in document order like the unit filter does.
  local function side_matches(n, filter)
    if filter == nil then return true end
    local result = true
    if filter.side ~= nil and tostring(filter.side) ~= '' then
      local ok = false
      for item in tostring(filter.side):gmatch('[^,]+') do if tonumber(item) == n then ok = true end end
      result = result and ok
    end
    if filter.team_name and __side_get(n, 'team_name') ~= filter.team_name then result = false end
    if filter.controller and __side_get(n, 'controller') ~= filter.controller then result = false end
    if filter.canrecruit ~= nil then
      local leader = __side_leader(n)
      if (leader ~= nil) ~= (filter.canrecruit == true) then result = false end
    end
    for _, child in ipairs(filter) do
      local tag, contents = child[1], child[2]
      if tag == 'has_unit' then
        local f = {}
        for k, v in pairs(contents) do f[k] = v end
        f.side = n
        if #__units_find(f) == 0 then result = false end
      elseif tag == 'not' then
        result = result and not side_matches(n, contents)
      elseif tag == 'and' then
        result = result and side_matches(n, contents)
      elseif tag == 'or' then
        result = result or side_matches(n, contents)
      end
    end
    return result
  end
  function wesnoth.sides.matches(side, filter)
    local n = type(side) == 'table' and rawget(side, '__side') or side
    return side_matches(n, filter)
  end
  function wesnoth.sides.find(filter)
    local out = {}
    for _, n in ipairs(__side_list()) do
      if wesnoth.sides.matches(n, filter) then out[#out + 1] = side_proxy(n) end
    end
    return out
  end
end

-- ---------------------------------------------------------------- current / scenario / paths
do
  local current = wesnoth.current
  setmetatable(current, {
    __index = function(t, key)
      if key == 'side' then return __game_state().side end
      if key == 'turn' then return __game_state().turn end
      if key == 'map' then return wesnoth.__game_map() end
    end,
  })
  wesnoth.scenario.difficulty = wesnoth.scenario.difficulty or 'NORMAL'
  wesnoth.scenario.id = wesnoth.scenario.id or ''

  function wesnoth.paths.find_vacant_hex(a, b, unit, ...)
    local x, y = wesnoth.map.__read_loc(a, b)
    return wesnoth.map.__new_loc(x, y)
  end
  wesnoth.paths.find_vacant_tile = wesnoth.paths.find_vacant_hex
  function wesnoth.sync.evaluate_single(fn) return fn() end
  function wesnoth.sync.run_unsynced(fn) return fn() end
  function wesnoth.sync.evaluate_multiple(fn) return { fn() } end
  function wesnoth.sync.invoke_command() end
  function wesnoth.allow_undo() end
  function wesnoth.__builtin_effect() end
end

-- [lua] code=... [args] ... [/args] [/lua]: run the code with the [args] config as its argument
function wesnoth.wml_actions.lua(cfg)
  local args = wml.get_child(cfg, 'args') or {}
  local chunk, message = load(cfg.code or '', '=lua')
  if not chunk then error(message) end
  chunk(args)
end

-- ---------------------------------------------------------------- misc game functions
do
  function wesnoth.add_known_unit() end
  function wesnoth.redraw() end
  function wesnoth.cancel_action() end
  function wesnoth.fire_wml_menu_item() end
  function wesnoth.get_era(id) return wesnoth.scenario.era end
  function wesnoth.get_resource(id)
    for _, resource in ipairs(wesnoth.scenario.resources or {}) do
      if resource.id == id then return resource end
    end
  end

  -- Interpolation as the engine does it for a vconfig attribute: $name, $name.sub and
  -- $(arithmetic over $names) in strings (utils::interpolate_variables_into_string).
  local function variable_text(name)
    local value = wml.variables[name]
    if value == nil then return nil end
    if type(value) == 'boolean' then return value and 'yes' or 'no' end
    if type(value) == 'table' then return nil end
    return tostring(value)
  end
  local function interpolate(text)
    if type(text) ~= 'string' or not text:find('$', 1, true) then return text end
    -- $( ... ) formulas: find a balanced group after each "$("
    local out, pos = {}, 1
    while true do
      local start = text:find('$(', pos, true)
      if not start then out[#out + 1] = text:sub(pos) break end
      out[#out + 1] = text:sub(pos, start - 1)
      local depth, stop = 0, nil
      for i = start + 1, #text do
        local c = text:sub(i, i)
        if c == '(' then depth = depth + 1 elseif c == ')' then depth = depth - 1 if depth == 0 then stop = i break end end
      end
      if not stop then out[#out + 1] = text:sub(start) break end
      local expr = text:sub(start + 2, stop - 1)
      expr = expr:gsub('%$([%a_][%w_%.%[%]]*)', function(name) return variable_text(name) or '0' end)
      local result
      if not expr:find('[^%d%s%+%-%*/%^%%%(%)%.,%a_]') then
        local chunk = load('local floor, ceil, abs, max, min, sqrt = math.floor, math.ceil, math.abs, math.max, math.min, math.sqrt; return ' .. expr, '=formula')
        if chunk then
          local ok, value = pcall(chunk)
          if ok and type(value) == 'number' then
            if value == math.floor(value) then value = math.tointeger(value) or value end
            result = tostring(value)
          end
        end
      end
      out[#out + 1] = result or text:sub(start, stop)
      pos = stop + 1
    end
    text = table.concat(out)
    return (text:gsub('%$([%a_][%w_%.%[%]]*)', function(name) return variable_text(name) end))
  end
  wesnoth.__interpolate = interpolate

  -- attribute values that are pure numbers read back as numbers, as typed config attributes do
  local function retype(original, text)
    if text == original then return original end
    local number = tonumber(text)
    if number ~= nil then return math.tointeger(number) or number end
    return text
  end

  local function substitute(cfg, shallow)
    local out = {}
    for k, v in pairs(cfg) do
      if type(v) == 'string' and v:find('$', 1, true) then
        out[k] = retype(v, interpolate(v))
      elseif type(v) == 'table' and type(k) == 'number' then
        out[k] = shallow and v or { v[1], substitute(v[2]) }
      else
        out[k] = v
      end
    end
    return out
  end
  function wesnoth.__shallow_vconfig(cfg) return substitute(cfg, true) end
  -- A vconfig: the config an action receives. Reading an attribute interpolates $name and
  -- $(formula) at that moment; children come back as vconfigs too (lua_common.cpp vconfig).
  local vconfig
  local VMT = {}
  local function wrap_pair(pair) return { pair[1], vconfig(pair[2]) } end
  function vconfig(raw)
    if type(raw) ~= 'table' then return raw end
    if getmetatable(raw) == VMT then return raw end
    return setmetatable({ __raw = raw }, VMT)
  end
  VMT.__index = function(self, key)
    local raw = rawget(self, '__raw')
    if key == '__literal' or key == '__shallow_literal' then return raw end
    if key == '__parsed' or key == '__shallow_parsed' then
      local out = {}
      for k, v in pairs(raw) do
        if type(v) == 'string' then out[k] = retype(v, interpolate(v)) else out[k] = v end
      end
      return out
    end
    local value = raw[key]
    if type(key) == 'number' then
      if type(value) == 'table' then return wrap_pair(value) end
      return value
    end
    if type(value) == 'string' and value:find('$', 1, true) then return retype(value, interpolate(value)) end
    return value
  end
  VMT.__newindex = function(self, key, value) rawget(self, '__raw')[key] = value end
  VMT.__len = function(self) return #rawget(self, '__raw') end
  VMT.__pairs = function(self)
    local raw = rawget(self, '__raw')
    local function step(_, key)
      local k, v = next(raw, key)
      if k == nil then return nil end
      return k, self[k]
    end
    return step, self, nil
  end
  wesnoth.__vconfig = vconfig
  wesnoth.__shallow_vconfig = vconfig
  function wml.tovconfig(cfg) return substitute(cfg) end
  wesnoth.tovconfig = wml.tovconfig

  -- conditional tags: [variable], [have_unit], [have_location], [and]/[or]/[not]
  local function compare(value, cfg)
    local function num(v) return tonumber(v) end
    if cfg.equals ~= nil and tostring(value) ~= tostring(cfg.equals) then return false end
    if cfg.not_equals ~= nil and tostring(value) == tostring(cfg.not_equals) then return false end
    if cfg.numerical_equals ~= nil and num(value) ~= num(cfg.numerical_equals) then return false end
    if cfg.numerical_not_equals ~= nil and num(value) == num(cfg.numerical_not_equals) then return false end
    if cfg.greater_than ~= nil and not (num(value) and num(value) > num(cfg.greater_than)) then return false end
    if cfg.less_than ~= nil and not (num(value) and num(value) < num(cfg.less_than)) then return false end
    if cfg.greater_than_equal_to ~= nil and not (num(value) and num(value) >= num(cfg.greater_than_equal_to)) then return false end
    if cfg.less_than_equal_to ~= nil and not (num(value) and num(value) <= num(cfg.less_than_equal_to)) then return false end
    if cfg.boolean_equals ~= nil then
      local want = cfg.boolean_equals == true or cfg.boolean_equals == 'yes'
      local have = value == true or value == 'yes' or value == 1
      if want ~= have then return false end
    end
    if cfg.contains ~= nil and not tostring(value):find(tostring(cfg.contains), 1, true) then return false end
    return true
  end
  local function conditions_hold(cfg)
    local result = true
    for _, child in ipairs(cfg) do
      local tag, c = child[1], child[2]
      local value
      if tag == 'variable' then
        value = compare(wml.variables[c.name], c)
      elseif tag == 'have_unit' then
        local count = #wesnoth.units.find_on_map(c)
        local want = c.count and tostring(c.count) or '1-9999'
        local lo, hi = want:match('^(%d+)%-?(%d*)$')
        lo = tonumber(lo) or 1
        hi = tonumber(hi) or lo
        if want:find('-') == nil then hi = lo end
        value = count >= lo and count <= hi
      elseif tag == 'have_location' then
        value = #wesnoth.current.map:find(c) > 0
      elseif tag == 'not' then
        value = not conditions_hold(c)
      elseif tag == 'and' then
        result = result and conditions_hold(c)
      elseif tag == 'or' then
        result = result or conditions_hold(c)
      elseif tag == 'true' then
        value = true
      elseif tag == 'false' then
        value = false
      end
      if value ~= nil then result = result and value end
    end
    return result
  end
  function wml.eval_conditional(cfg) return conditions_hold(cfg) end
  wesnoth.eval_conditional = wml.eval_conditional

  -- gui: narration (a [message]) goes to the player through the host; no choices are offered
  function gui.show_narration(cfg, options, text_input)
    __say(cfg)
    return 0, nil
  end
  function gui.show_popup() end
  function gui.show_story() end
  function gui.show_help() end
  function gui.show_inspector() end
  function gui.show_menu() return 0 end
  function gui.show_prompt() return 0 end
  function gui.show_dialog() return 0 end
  wesnoth.interface.is_skipping_messages = function() return false end
  wesnoth.interface.highlight_hex = function() end
  wesnoth.interface.skip_messages = function() end
  wesnoth.interface.is_skipping_messages = function() return false end
  wesnoth.interface.scroll_to_hex = function() end
  wesnoth.interface.deselect_hex = function() end

  -- ------------------------------------------------------------ the live map (game kernel)
  local read_loc, new_loc = wesnoth.map.__read_loc, wesnoth.map.__new_loc
  local GameMapMT = {}
  GameMapMT.__index = function(self, key)
    if type(key) == 'table' then
      local x, y = read_loc(key)
      return __game_terrain(x, y)
    end
    local info = __game_map_info()
    if key == 'width' or key == 'playable_width' then return info.width end
    if key == 'height' or key == 'playable_height' then return info.height end
    if key == 'border_size' then return 0 end
    return wesnoth.map[key]
  end
  GameMapMT.__newindex = function(self, key, value)
    if type(key) == 'table' then
      local x, y = read_loc(key)
      __game_set_terrain(x, y, tostring(value))
    end
  end
  local game_map = setmetatable({}, GameMapMT)
  function wesnoth.__game_map() return game_map end

  function wesnoth.map.get_owner(a, b)
    local x, y = read_loc(a, b)
    return __game_village_owner(x, y)
  end
  function wesnoth.map.set_owner(a, b, c, d)
    local x, y, side
    if type(a) == 'table' then x, y = read_loc(a); side = b else x, y, side = a, b, c end
    __game_set_village_owner(x, y, side)
  end
  function wesnoth.map.matches(a, b, c)
    local x, y, filter
    if type(a) == 'table' then x, y = read_loc(a); filter = b else x, y, filter = a, b, c end
    return #wesnoth.map.find(filter, { { x, y } }) > 0
  end
  function wesnoth.map.replace_base() end
  function wesnoth.map.add_label() end
  function wesnoth.map.remove_label() end
  function wesnoth.map.get_label() end
end

-- ---------------------------------------------------------------- engine actions in Lua
do
  local units = wesnoth.units

  -- the built-in [effect]s run in the host (src/simulation/effects.ts)
  function wesnoth.__builtin_effect(unit, effect) __unit_effect(rawget(unit, '__id'), effect) end

  -- the nearest free hex to a location, searching outward
  function wesnoth.paths.find_vacant_hex(a, b)
    local x, y = wesnoth.map.__read_loc(a, b)
    local map = wesnoth.current.map
    local seen = {}
    local ring = { { x, y } }
    for _ = 0, 8 do
      local next_ring = {}
      for _, loc in ipairs(ring) do
        local key = loc[1] .. ',' .. loc[2]
        if not seen[key] then
          seen[key] = true
          if loc[1] >= 1 and loc[2] >= 1 and loc[1] <= map.width and loc[2] <= map.height and not units.get(loc[1], loc[2]) then
            return wesnoth.map.__new_loc(loc[1], loc[2])
          end
          for _, n in ipairs({wesnoth.map.get_adjacent_hexes(loc[1], loc[2])}) do next_ring[#next_ring + 1] = { n.x, n.y } end
        end
      end
      ring = next_ring
    end
    return nil
  end
  wesnoth.paths.find_vacant_tile = wesnoth.paths.find_vacant_hex

  -- units.create understands [modifications] children, like the engine's unit constructor
  local raw_create = units.create
  function units.create(cfg)
    local unit = raw_create(cfg)
    for _, child in ipairs(cfg) do
      if child[1] == 'modifications' then
        for _, mod in ipairs(child[2]) do units.add_modification(unit, mod[1], mod[2]) end
      end
    end
    return unit
  end

  -- [unit]: create a unit and put it on the map, in the recall list or as the leader
  function wesnoth.wml_actions.unit(cfg)
    cfg = wml.tovconfig(cfg)
    local unit = units.create(cfg)
    local placement = cfg.placement or 'map'
    if placement == 'recall' then
      units.to_recall(unit)
    else
      local spot = wesnoth.paths.find_vacant_hex(cfg.x or 1, cfg.y or 1)
      if spot then units.to_map(unit, spot.x, spot.y) else units.to_recall(unit) end
    end
    return unit
  end

  -- [recall]: bring a unit from the recall list to a free castle hex next to the leader
  function wesnoth.wml_actions.recall(cfg)
    local side = tonumber(cfg.side) or wesnoth.current.side
    local filter = {}
    for k, v in pairs(cfg) do if type(k) == 'string' and k ~= 'side' and k ~= 'check_passability' and k ~= 'fire_event' and k ~= 'show' then filter[k] = v end end
    for _, child in ipairs(cfg) do if child[1] == 'filter' then for k, v in pairs(child[2]) do filter[k] = v end end end
    filter.side = side
    local candidates = units.find_on_recall(filter)
    local unit = candidates[1]
    if not unit then return end
    local leader = wesnoth.sides[side].leader
    local x, y = cfg.x, cfg.y
    if not x and leader then x, y = leader.x, leader.y end
    if not x then return end
    local spot = wesnoth.paths.find_vacant_hex(x, y)
    if not spot then return end
    wesnoth.sides[side].gold = wesnoth.sides[side].gold - (unit.recall_cost or 20)
    units.to_map(unit, spot.x, spot.y)
  end
end

-- In the game kernel wesnoth.map.find takes a WML location filter (the mapgen kernel's
-- takes a terrain filter object); core/map.lua wraps this raw function.
do
  local new_loc = wesnoth.map.__new_loc
  function wesnoth.map.find(cfg, ref_unit)
    local found = {}
    for _, loc in ipairs(__locations_find(cfg or {})) do found[#found + 1] = new_loc(loc.x, loc.y) end
    return found
  end
  function wesnoth.map.matches(a, b, c)
    local x, y, filter
    if type(a) == 'table' then x, y = wesnoth.map.__read_loc(a); filter = b else x, y, filter = a, b, c end
    for _, loc in ipairs(__locations_find(filter or {})) do
      if loc.x == x and loc.y == y then return true end
    end
    return false
  end
end

-- hex overlays: the pictures of [item]s; the scene draws what the host stores
do
  local ui = wesnoth.interface
  function ui.add_hex_overlay(a, b, c)
    local x, y, cfg
    if type(a) == 'table' then x, y = wesnoth.map.__read_loc(a); cfg = b else x, y, cfg = a, b, c end
    __overlay_add(x, y, cfg)
  end
  function ui.remove_hex_overlay(a, b, c)
    local x, y, name
    if type(a) == 'table' then x, y = wesnoth.map.__read_loc(a); name = b else x, y, name = a, b, c end
    __overlay_remove(x, y, name)
  end
  function ui.get_items(a, b)
    local x, y = wesnoth.map.__read_loc(a, b)
    return __overlay_get(x, y)
  end
  ui.get_hovered_hex = function() return nil end
end


-- audio: sound effects go to the scene; music and sound sources are accepted and ignored
do
  local audio = wesnoth.audio
  function audio.play(file) __audio_play(file) end
  function audio.volume() return 1 end
  audio.music_list = audio.music_list or {}
  audio.sources = setmetatable({}, { __newindex = function() end })
end


-- [endlevel] ends by assigning wesnoth.scenario.end_level_data; the scene decides what follows
do
  setmetatable(wesnoth.scenario, {
    __newindex = function(t, key, value)
      rawset(t, key, value)
      if key == 'end_level_data' and type(value) == 'table' then
        __end_level(value.result or 'victory', rawget(t, 'next'))
      end
    end,
  })
end

-- ---------------------------------------------------------------- blocking dialogs
-- A handler that opens a dialog (World Conquest's invest and item prompts) must wait for the
-- player, while Lua runs synchronously. The top-level fire runs the handlers inside a
-- coroutine; a dialog yields its request, the scene shows it, and wesnoth.__resume carries
-- the answer back in.
do
  local ge = wesnoth.game_events
  local fire_now = ge.fire
  local pending

  local function step(co, ...)
    local ok, request = coroutine.resume(co, ...)
    if not ok then
      pending = nil
      local text = request
      if type(request) == 'table' then
        local parts = {}
        for k, v in pairs(request) do parts[#parts + 1] = tostring(k) .. '=' .. tostring(v) end
        text = 'error table {' .. table.concat(parts, ',') .. '}'
      end
      error(debug.traceback(co, tostring(text)), 0)
    end
    if coroutine.status(co) == 'suspended' then
      pending = { co = co, request = request }
    else
      pending = nil
    end
  end

  function ge.fire(...)
    if coroutine.isyieldable() then return fire_now(...) end
    local args = { ... }
    local co = coroutine.create(function() return fire_now(table.unpack(args)) end)
    step(co)
    return true
  end
  function wesnoth.__take_pending() return pending and pending.request or nil end
  function wesnoth.__has_pending() return pending ~= nil end
  function wesnoth.__resume(answer)
    local current = pending
    if not current then return end
    step(current.co, answer)
  end

  -- ask the player something: yields inside an event, otherwise picks the default
  function wesnoth.__ask(request, default)
    if coroutine.isyieldable() then return coroutine.yield(request) end
    return default
  end

  -- A recording stand-in for a GUI2 dialog: widgets are auto-created tables, so a dialog's
  -- preshow function can fill a tree of items with names, pictures and descriptions. The scene
  -- shows that tree as a list and the answer is written back as the selected path.
  gui.widget = gui.widget or {}
  local function widget(path)
    local fields, children, sub = {}, {}, {}
    local node = { __fields = fields, __children = children, path = path or {} }
    return setmetatable(node, {
      __index = function(t, key)
        if key == 'add_item_of_type' then
          return function(self, kind)
            local child_path = {}
            for i, p in ipairs(rawget(t, 'path')) do child_path[i] = p end
            child_path[#child_path + 1] = #children + 1
            local child = widget(child_path)
            rawget(child, '__fields').__type = kind
            children[#children + 1] = child
            return child
          end
        end
        if key == 'item_count' then return #children end
        if key == 'selected_item_path' and fields.selected_item_path == nil then
          -- a tree starts with its first item (not a category heading) selected
          local function first_item(n)
            for _, c in ipairs(rawget(n, '__children')) do
              local kind = rawget(c, '__fields').__type
              if kind ~= 'category' then return c end
              local inner = first_item(c)
              if inner then return inner end
            end
          end
          local item = first_item(t)
          return item and rawget(item, 'path') or {}
        end
        -- methods a script added to gui.widget (WC's add_invest_item) are widget methods
        if rawget(gui.widget, key) ~= nil then return gui.widget[key] end
        if key == 'find_widget' or key == 'remove_items_at' or key == 'add_item' or key == 'close' then return function() end end
        if fields[key] ~= nil then return fields[key] end
        local existing = sub[key]
        if not existing then
          existing = widget()
          sub[key] = existing
        end
        return existing
      end,
      __newindex = function(t, key, value) fields[key] = value end,
    })
  end

  local function label_of(widget_node)
    if type(widget_node) ~= 'table' then return nil end
    local f = rawget(widget_node, '__fields')
    return f and f.label
  end

  local function describe(node)
    local out = {}
    for _, child in ipairs(rawget(node, '__children')) do
      local fields = rawget(child, '__fields')
      out[#out + 1] = {
        path = rawget(child, 'path'),
        type = fields.__type,
        category = label_of(child.category_name),
        name = label_of(child.name),
        desc = label_of(child.desc),
        image = label_of(child.image),
        children = describe(child),
      }
    end
    return out
  end

  function gui.show_dialog(dialog_wml, preshow, postshow)
    local dialog = widget()
    if preshow then preshow(dialog) end
    local tree = dialog.left_tree
    local has_tree = #rawget(tree, '__children') > 0
    if has_tree then
      local request = { kind = 'tree', tree = describe(tree) }
      local choice = wesnoth.__ask(request, nil)
      if choice == nil then
        -- not inside an event (or the scene gave no answer): take the first item
        local first = rawget(tree, '__children')[1]
        local leaf = first and rawget(first, '__children')[1] or first
        choice = leaf and rawget(leaf, 'path') or { 1 }
      end
      tree.selected_item_path = choice
      local on_modified = rawget(tree, '__fields').on_modified
      if on_modified then on_modified() end
    end
    if postshow then postshow(dialog) end
    return 1
  end
  wesnoth.show_dialog = gui.show_dialog

  -- sync choices without a network: the single player's own choice
  function wesnoth.sync.evaluate_single(a, b)
    local fn = type(a) == 'function' and a or b
    return fn()
  end
end

-- wml.load: a data file parsed to a config; a dialog definition that does not parse as WML
-- (GUI2 syntax) still answers with its [resolution] so the script can run its preshow
do
  local raw_load = wml.load
  function wml.load(path)
    local cfg = raw_load(path)
    if cfg and wml.get_child(cfg, 'resolution') then return cfg end
    return cfg or { { 'resolution', {} } }
  end
end
`;
