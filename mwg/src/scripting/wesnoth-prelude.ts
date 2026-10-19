// The Lua side of the engine builtins: what `lua_kernel_base.cpp` registers before
// `data/lua/package.lua` and `data/lua/core` run. Written in Lua because most of these
// are thin table/metatable shapes; the stateful parts call the `__*` host functions
// installed by `wesnoth-api.ts`.
//
// Deviation (PORT_COVERAGE.md "Wesnoth Lua API"): only the builtins the shipped data
// reaches are implemented; the rest are absent, so a script that calls one fails with
// Lua's "attempt to call a nil value" naming it rather than silently doing nothing.

export const BOOTSTRAP_LUA = String.raw`
wesnoth = wesnoth or {}
wesnoth.package = {}

-- ---------------------------------------------------------------- filesystem
local function canonical(path, current_dir)
  if path:sub(1, 2) == './' or path:sub(1, 3) == '../' then
    path = (current_dir or '') .. '/' .. path
  end
  local parts = {}
  for part in path:gmatch('[^/]+') do
    if part == '..' then
      if #parts > 0 then table.remove(parts) end
    elseif part ~= '.' then
      parts[#parts + 1] = part
    end
  end
  local out = table.concat(parts, '/')
  if path:sub(-1) == '/' and out ~= '' then out = out .. '/' end
  return out
end

-- The directory of the calling file, skipping the package loader's own frames
-- (src/scripting/lua_fileops.cpp: relative paths resolve against the file that asked).
local function caller_dir(level)
  level = level + 1
  while true do
    local info = debug.getinfo(level, 'S')
    if not info then return '' end
    local source = info.source or ''
    if source:sub(1, 1) == '@' and source ~= '@lua/package.lua' and source ~= '@lua/core/filesystem.lua' then
      return (source:sub(2):match('^(.*)/[^/]*$')) or ''
    end
    level = level + 1
  end
end

filesystem = filesystem or {}
function filesystem.canonical_path(path)
  return canonical(path, caller_dir(2))
end
function filesystem.have_file(path, only_file)
  local full = canonical(path, caller_dir(2))
  if __fs_read(full) ~= nil then return true end
  if only_file then return false end
  return __fs_list(full) ~= nil
end
function filesystem.read_file(path)
  local full = canonical(path, caller_dir(2))
  local content = __fs_read(full)
  if content ~= nil then return content end
  local entries = __fs_list(full)
  if entries == nil then return nil end
  local result, ndirs = {}, 0
  for i = 1, #entries do
    result[i] = entries[i]
    if entries[i]:sub(-1) == '/' then ndirs = ndirs + 1 end
  end
  result.ndirs = ndirs
  return result
end

function wesnoth.dofile(path, ...)
  local full = canonical(path, caller_dir(2))
  local source = __fs_read(full)
  if source == nil then error('file not found: ' .. path .. ' (' .. full .. ')', 2) end
  local chunk, message = load(source, '@' .. full)
  if not chunk then error(message, 2) end
  return chunk(...)
end

-- ---------------------------------------------------------------- kernel basics
function wesnoth.kernel_type() return __kernel_type or 'Game Lua Kernel' end

-- gettext: the port ships no catalogs for scripts; an untranslated string is its msgid
-- without the "context^" prefix, as translation::dsgettext returns it.
function wesnoth.textdomain(domain)
  local function translate(msgid, ...)
    if type(msgid) ~= 'string' then return msgid end
    return (msgid:gsub('^[^%^]*%^', '', 1))
  end
  return translate
end

function wesnoth.deprecated_message(name, level, version, message)
  if level == 4 then error(name .. ' has been removed. ' .. (message or ''), 2) end
end

wesnoth.game_config = wesnoth.game_config or { strict_lua = false, global_traits = {}, debug = false, mp_debug = false, red_green_scale = false, do_not_log_wml = false, wesnoth_version = nil }

function wesnoth.ms_since_init() return math.floor(os.clock() * 1000) end
function wesnoth.get_language() return 'en_US' end

-- wesnoth.log(level, message, in_chat): errors surface in the output buffer
function wesnoth.log(level, message, in_chat)
  if message == nil then message, level = level, 'info' end
  print('[' .. tostring(level) .. '] ' .. tostring(message))
end

-- Versions: wesnoth.version("1.19.2") objects compare with < <= ==.
do
  local mt = {}
  local function parse(text)
    local parts = {}
    for n in tostring(text):gmatch('%d+') do parts[#parts + 1] = tonumber(n) end
    while #parts < 3 do parts[#parts + 1] = 0 end
    return parts
  end
  local function compare(a, b)
    for i = 1, math.max(#a.__parts, #b.__parts) do
      local x, y = a.__parts[i] or 0, b.__parts[i] or 0
      if x ~= y then return x < y and -1 or 1 end
    end
    return 0
  end
  mt.__lt = function(a, b) return compare(a, b) < 0 end
  mt.__le = function(a, b) return compare(a, b) <= 0 end
  mt.__eq = function(a, b) return compare(a, b) == 0 end
  mt.__index = function(self, key)
    if key == 'major' then return self.__parts[1] end
    if key == 'minor' then return self.__parts[2] end
    if key == 'revision' then return self.__parts[3] end
    if key == 'is_canonical' then return true end
    if key == 'sufix' then return '' end
  end
  mt.__tostring = function(self) return self.__text end
  function wesnoth.version(text)
    if type(text) == 'table' then return text end
    return setmetatable({ __parts = parse(text), __text = tostring(text) }, mt)
  end
  function wesnoth.current_version() return wesnoth.version('1.19.27') end
  wesnoth.game_config.version = wesnoth.current_version()
end

-- dollar-name and dollar-brace-name interpolation on strings (lua_common.cpp vformat)
function string.vformat(text, variables)
  return (text:gsub('%$(%b{})', function(name) return tostring(variables[name:sub(2, -2)] or '') end)
              :gsub('%$([%a_][%w_]*)', function(name) local v = variables[name]; if v == nil then return nil end return tostring(v) end))
end
string.format_conjunct_list = nil

-- Namespaces the core files extend and the data reaches into.
wesnoth.paths = wesnoth.paths or {}
wesnoth.schedule = wesnoth.schedule or {}
wesnoth.sync = wesnoth.sync or {}
wesnoth.interface = wesnoth.interface or {}
wesnoth.units = wesnoth.units or {}
wesnoth.sides = wesnoth.sides or {}
wesnoth.map = wesnoth.map or {}
wesnoth.game_events = wesnoth.game_events or {}
wesnoth.wml_actions = wesnoth.wml_actions or {}
wesnoth.wml_conditionals = wesnoth.wml_conditionals or {}
wesnoth.effects = wesnoth.effects or {}
wesnoth.scenario = wesnoth.scenario or {}
wesnoth.current = wesnoth.current or {}
wesnoth.races = wesnoth.races or {}
wesnoth.unit_types = wesnoth.unit_types or {}
wesnoth.terrain_types = wesnoth.terrain_types or {}
wesnoth.experimental = wesnoth.experimental or {}
wml = wml or {}
wml.variables = wml.variables or {}
mathx = mathx or {}
stringx = stringx or {}
gui = gui or {}
audio = audio or {}
wesnoth.audio = audio

wesnoth.dofile('lua/package.lua')

wesnoth.custom_synced_commands = wesnoth.custom_synced_commands or {}

function wesnoth.named_tuple(values, names)
  local t, index = {}, {}
  for i = 1, math.max(#values, #names) do t[i] = values[i] end
  for i, name in ipairs(names) do index[name] = i end
  return setmetatable(t, {
    __index = function(self, key) local i = index[key]; if i then return rawget(self, i) end end,
    __newindex = function(self, key, value) local i = index[key]; if i then rawset(self, i, value) else rawset(self, key, value) end end,
  })
end

-- ---------------------------------------------------------------- game events
-- Real engine: src/game_events/manager.cpp keeps the handlers, game_lua_kernel.cpp exposes
-- wesnoth.game_events.*. Handlers run by decreasing priority, then in order of adding.
do
  local handlers, by_id, counter = {}, {}, 0
  local ge = wesnoth.game_events

  -- The event manager spells names with underscores ("side 2 turn 3" is side_2_turn_3).
  local function normalize(name)
    return (tostring(name):gsub('^%s+', ''):gsub('%s+$', ''):gsub('%s+', '_'))
  end
  local function names_of(spec)
    local out = {}
    for name in tostring(spec or ''):gmatch('[^,]+') do out[#out + 1] = normalize(name) end
    return out
  end

  local function run_commands(cfg)
    for _, child in ipairs(cfg) do
      local tag, contents = child[1], child[2]
      local action = wesnoth.wml_actions[tag]
      if action then
        -- the engine hands an action a vconfig: $name and $(formula) in its attributes
        -- are read at the moment the action runs
        action(wesnoth.__shallow_vconfig and wesnoth.__shallow_vconfig(contents) or contents)
      else
        wesnoth.log('warn', 'unknown WML action [' .. tostring(tag) .. '] in an event')
      end
    end
  end
  wesnoth.run_wml_commands = run_commands

  function ge.add(cfg)
    counter = counter + 1
    local handler = {
      id = cfg.id, names = names_of(cfg.name or cfg.event), priority = tonumber(cfg.priority) or 0,
      first_time_only = cfg.first_time_only ~= false and cfg.first_time_only ~= 'no',
      order = counter, action = cfg.action, cfg = cfg.cfg, filter_condition = cfg.filter_condition,
    }
    if cfg.first_time_only == nil then handler.first_time_only = true end
    -- event filters (game_lua_kernel intf_add_event): unit, second_unit, condition, side, attack...
    if type(cfg.filter) == 'function' then
      handler.filter_fn = cfg.filter
    elseif type(cfg.filter) == 'table' then
      handler.filters = {
        unit = cfg.filter.unit, second_unit = cfg.filter.second_unit, condition = cfg.filter.condition,
        side = cfg.filter.side, attack = cfg.filter.attack, second_attack = cfg.filter.second_attack,
      }
    end
    handlers[#handlers + 1] = handler
    if handler.id then by_id[handler.id] = handler end
    return handler
  end

  function ge.add_repeating(name, fn, priority)
    return ge.add { name = name, priority = priority, first_time_only = false, action = fn }
  end

  function ge.add_wml(cfg)
    local handler = ge.add {
      id = cfg.id, name = cfg.name or cfg.event, priority = cfg.priority,
      first_time_only = cfg.first_time_only ~= 'no' and cfg.first_time_only ~= false,
    }
    handler.cfg = cfg
    local filters = {}
    for _, child in ipairs(cfg) do
      local tag, contents = child[1], child[2]
      if tag == 'filter' then filters.unit = contents
      elseif tag == 'filter_second' then filters.second_unit = contents
      elseif tag == 'filter_condition' then filters.condition = contents
      elseif tag == 'filter_side' then filters.side = contents
      elseif tag == 'filter_attack' then filters.attack = contents
      elseif tag == 'filter_second_attack' then filters.second_attack = contents end
    end
    if next(filters) then handler.filters = filters end
    return handler
  end

  function wesnoth.wml_actions.event(cfg)
    if cfg.remove then ge.remove(cfg.id or cfg.name) return end
    ge.add_wml(cfg)
  end

  function ge.remove(id)
    for i = #handlers, 1, -1 do
      if handlers[i].id == id then table.remove(handlers, i) end
    end
    by_id[id] = nil
  end

  local function matching(name)
    local list = {}
    for _, handler in ipairs(handlers) do
      for _, n in ipairs(handler.names) do
        if n == name then list[#list + 1] = handler break end
      end
    end
    table.sort(list, function(a, b)
      if a.priority ~= b.priority then return a.priority > b.priority end
      return a.order < b.order
    end)
    return list
  end

  -- does the event's context satisfy the handler's filters?
  local function filters_pass(handler, context)
    if handler.filter_fn then
      local ok, result = pcall(handler.filter_fn, context)
      return ok and result ~= false
    end
    local f = handler.filters
    if not f then return true end
    if f.unit then
      local u = context.x1 and wesnoth.units.get(context.x1, context.y1)
      if not u or not u:matches(f.unit) then return false end
    end
    if f.second_unit then
      local u = context.x2 and wesnoth.units.get(context.x2, context.y2)
      if not u or not u:matches(f.second_unit) then return false end
    end
    if f.side then
      local ok = false
      for _, side in ipairs(wesnoth.sides.find(f.side)) do
        if side.side == wesnoth.current.side then ok = true end
      end
      if not ok then return false end
    end
    if f.condition and wml.eval_conditional and not wml.eval_conditional(f.condition) then return false end
    return true
  end

  local function run_handler(handler)
    if handler.removed then return end
    if not filters_pass(handler, wesnoth.current.event_context or {}) then return end
    if handler.first_time_only then
      handler.removed = true
      for i = #handlers, 1, -1 do if handlers[i] == handler then table.remove(handlers, i) end end
    end
    if handler.action then
      handler.action(wesnoth.current.event_context)
    elseif handler.cfg then
      run_commands(handler.cfg)
    end
  end

  -- fire(name, [loc1], [loc2], [data]): returns true when a handler ran
  local function fire(name, ...)
    name = normalize(name)
    local args = { ... }
    local context = { name = name }
    local data
    local locations = 0
    for _, value in ipairs(args) do
      if type(value) == 'table' and value.x ~= nil then
        locations = locations + 1
        context['x' .. locations], context['y' .. locations] = value.x, value.y
      elseif type(value) == 'table' then
        data = value
      end
    end
    context.data = data
    local previous = wesnoth.current.event_context
    wesnoth.current.event_context = context
    local ran = false
    for _, handler in ipairs(matching(name)) do
      ran = true
      run_handler(handler)
    end
    wesnoth.current.event_context = previous
    return ran
  end
  ge.fire = fire
  function ge.fire_by_id(id, ...)
    local handler = by_id[id]
    if handler then wesnoth.current.event_context = { name = id } run_handler(handler) return true end
    return false
  end
  function ge.__handlers() return handlers end
  function ge.set_undoable() end
  function ge.add_undo_actions() end
  function ge.on_load() end
  function ge.on_save() end
  function ge.add_menu() end
  ge.on_event = ge.on_event or function() end
  wesnoth.fire_game_event = fire
end

-- ---------------------------------------------------------------- interface (presentation hooks)
-- The scene owns the screen; scripts only ask. Anything not wired yet is a no-op that
-- answers the neutral value, so presentation calls never stop a script.
do
  local ui = wesnoth.interface
  ui.game_display = ui.game_display or {}
  ui.game_display.unit_status = ui.game_display.unit_status or function() return {} end
  ui.game_display.unit_image = ui.game_display.unit_image or function() return '' end
  ui.game_display.unit_name = ui.game_display.unit_name or function() return '' end
  ui.game_display.unit_type = ui.game_display.unit_type or function() return '' end
  ui.game_display.unit_race = ui.game_display.unit_race or function() return '' end
  ui.game_display.unit_traits = ui.game_display.unit_traits or function() return '' end
  ui.game_display.unit_moves = ui.game_display.unit_moves or function() return '' end
  ui.game_display.unit_weapons = ui.game_display.unit_weapons or function() return '' end
  ui.game_display.unit_abilities = ui.game_display.unit_abilities or function() return '' end
  ui.game_display.unit_hp = ui.game_display.unit_hp or function() return '' end
  ui.game_display.unit_xp = ui.game_display.unit_xp or function() return '' end
  ui.game_display.unit_level = ui.game_display.unit_level or function() return '' end
  ui.game_display.unit_alignment = ui.game_display.unit_alignment or function() return '' end
  ui.get_displayed_unit = ui.get_displayed_unit or function() return nil end
  ui.is_skipping_messages = ui.is_skipping_messages or function() return true end
  ui.float_label = ui.float_label or function() end
  ui.add_chat_message = ui.add_chat_message or function(...) print('[chat] ' .. table.concat({ ... }, ' ')) end
  ui.get_viewing_side = ui.get_viewing_side or function() return wesnoth.current.side or 1 end
  ui.scroll_to_hex = ui.scroll_to_hex or function() end
  ui.deselect_hex = ui.deselect_hex or function() end
  ui.select_hex = ui.select_hex or function() end
  ui.lock = ui.lock or function() end
  ui.delay = ui.delay or function() end
  ui.clear_menu_item = ui.clear_menu_item or function() end
  ui.set_menu_item = ui.set_menu_item or function() end
  ui.add_overlay_text = ui.add_overlay_text or function() end
  ui.remove_overlay_text = ui.remove_overlay_text or function() end
  ui.get_items = ui.get_items or function() return {} end
  ui.skip_messages = ui.skip_messages or function() end
  ui.zoom = ui.zoom or function() end
  ui.get_hovered_hex = ui.get_hovered_hex or function() return nil end
  ui.get_selected_hex = ui.get_selected_hex or function() return nil end
  ui.show_menu = ui.show_menu or function() return 0 end
end

-- ---------------------------------------------------------------- wml module (lua_wml.cpp)
do
  function wml.valid(cfg) return type(cfg) == 'table' end

  local function clone(value)
    if type(value) ~= 'table' then return value end
    local out = {}
    for k, v in pairs(value) do out[k] = clone(v) end
    return out
  end
  wml.clone = clone

  function wml.equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do if not wml.equal(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
  end

  -- wml.merge(base, merge, mode): mode "replace", "append" or "merge" (default)
  function wml.merge(base, merge, mode)
    mode = mode or 'merge'
    if mode == 'replace' then
      for k in pairs(base) do base[k] = nil end
      for k, v in pairs(clone(merge)) do base[k] = v end
      return base
    end
    for k, v in pairs(clone(merge)) do
      if type(k) == 'number' then base[#base + 1] = v else base[k] = v end
    end
    return base
  end

  -- A filter attribute matches when the value equals it or, for a comma list or a
  -- glob, is one of its members.
  local function attribute_matches(value, wanted)
    if value == nil then return false end
    if type(wanted) == 'string' and wanted:find('[,*?]') then
      local text = tostring(value)
      for item in wanted:gmatch('[^,]+') do
        item = item:gsub('^%s+', ''):gsub('%s+$', '')
        local pattern = '^' .. item:gsub('[%^%$%(%)%%%.%[%]%+%-]', '%%%0'):gsub('%*', '.*'):gsub('%?', '.') .. '$'
        if text:match(pattern) then return true end
      end
      return false
    end
    return tostring(value) == tostring(wanted)
  end

  local function matches(cfg, filter)
    for k, wanted in pairs(filter) do
      if type(k) == 'string' and not attribute_matches(cfg[k], wanted) then return false end
    end
    for _, child in ipairs(filter) do
      local tag, contents = child[1], child[2]
      if tag == 'not' then
        if matches(cfg, contents) then return false end
      elseif tag ~= 'and' and tag ~= 'or' then
        local found = false
        for _, own in ipairs(cfg) do
          if own[1] == tag and matches(own[2], contents) then found = true break end
        end
        if not found then return false end
      end
    end
    return true
  end
  function wml.matches_filter(cfg, filter) return matches(cfg or {}, filter or {}) end

  function wml.tostring(cfg)
    local parts = {}
    local function write(t, indent)
      local keys = {}
      for k in pairs(t) do if type(k) == 'string' then keys[#keys + 1] = k end end
      table.sort(keys)
      for _, k in ipairs(keys) do
        local v = t[k]
        if type(v) == 'boolean' then v = v and 'yes' or 'no' end
        parts[#parts + 1] = indent .. k .. '="' .. tostring(v):gsub('"', '""') .. '"'
      end
      for _, child in ipairs(t) do
        parts[#parts + 1] = indent .. '[' .. child[1] .. ']'
        write(child[2], indent .. '    ')
        parts[#parts + 1] = indent .. '[/' .. child[1] .. ']'
      end
    end
    write(cfg, '')
    return table.concat(parts, '\n')
  end

  -- wml.interpolate(text, cfg): dollar-name substitution against a config
  function wml.interpolate(text, cfg)
    return (tostring(text):gsub('%$([%a_][%w_%.]*)', function(name)
      local value = cfg
      for part in name:gmatch('[^%.]+') do
        if type(value) ~= 'table' then return nil end
        value = value[part]
      end
      if value == nil then return nil end
      return tostring(value)
    end))
  end

  function wml.parse(text) return __wml_parse(text) end
  function wml.load(path)
    local source = __fs_read(filesystem.canonical_path(path))
    return source and __wml_parse(source) or nil
  end
  function wml.dump(cfg) return wml.tostring(cfg) end

  -- ------------------------------------------------------------ WML variables
  -- The scenario's variable store, a config table addressed by paths such as "name",
  -- "name.sub", "name[2].sub" and "name.length" (game_lua_kernel intf_get_variable).
  local store = {}
  local function split_path(path)
    local parts = {}
    for part in tostring(path):gmatch('[^%.]+') do
      local name, index = part:match('^([^%[]+)%[(%d+)%]$')
      if name then parts[#parts + 1] = { name = name, index = tonumber(index) }
      else parts[#parts + 1] = { name = part } end
    end
    return parts
  end
  local function nth_child(cfg, name, index)
    local count = 0
    for _, child in ipairs(cfg) do
      if child[1] == name then
        if count == (index or 0) then return child[2] end
        count = count + 1
      end
    end
    return nil
  end
  local function child_count(cfg, name)
    local count = 0
    for _, child in ipairs(cfg) do if child[1] == name then count = count + 1 end end
    return count
  end

  local function path_get(root, path)
    local parts = split_path(path)
    local last = parts[#parts]
    if not last then return nil end
    -- "x.length" is the number of children named x; a missing array counts as 0
    if #parts >= 2 and last.name == 'length' and last.index == nil and parts[#parts - 1].index == nil then
      local owner = root
      for j = 1, #parts - 2 do
        owner = nth_child(owner, parts[j].name, parts[j].index)
        if owner == nil then return 0 end
      end
      return child_count(owner, parts[#parts - 1].name)
    end
    local cfg = root
    for i = 1, #parts - 1 do
      cfg = nth_child(cfg, parts[i].name, parts[i].index)
      if cfg == nil then return nil end
    end
    if last.index ~= nil then return nth_child(cfg, last.name, last.index) end
    local attribute = cfg[last.name]
    if attribute ~= nil then return attribute end
    return nth_child(cfg, last.name, 0)
  end

  local function path_set(root, path, value)
    local parts = split_path(path)
    local cfg = root
    -- a missing child is created, padded with empty siblings up to the asked index
    local function ensure_child(owner, name, index)
      local child = nth_child(owner, name, index)
      while child == nil do
        local fresh = {}
        owner[#owner + 1] = { name, fresh }
        if child_count(owner, name) > (index or 0) then child = fresh end
      end
      return child
    end
    for i = 1, #parts - 1 do
      cfg = ensure_child(cfg, parts[i].name, parts[i].index)
    end
    local last = parts[#parts]
    if not last then return end
    if type(value) == 'table' then
      local copy = clone(value)
      local count, found = 0, nil
      for i, child in ipairs(cfg) do
        if child[1] == last.name then
          if count == (last.index or 0) then found = i break end
          count = count + 1
        end
      end
      if found then cfg[found] = { last.name, copy } else cfg[#cfg + 1] = { last.name, copy } end
    elseif value == nil then
      if last.index ~= nil then
        local count = 0
        for i, child in ipairs(cfg) do
          if child[1] == last.name then
            if count == last.index then table.remove(cfg, i) break end
            count = count + 1
          end
        end
      else
        cfg[last.name] = nil
        for i, child in ipairs(cfg) do
          if child[1] == last.name then table.remove(cfg, i) break end
        end
      end
    else
      cfg[last.name] = value
    end
  end

  wml.__path_get, wml.__path_set = path_get, path_set
  function wml.get_variable(path) return path_get(store, path) end
  function wml.set_variable(path, value) path_set(store, path, value) end

  function wml.get_all_vars() return store end
  -- carry the variable store from one scenario's kernels to the next
  function wml.__import_vars(vars)
    for k in pairs(store) do store[k] = nil end
    for k, v in pairs(vars or {}) do store[k] = clone(v) end
  end
end

-- ---------------------------------------------------------------- stringx (lua_stringx.cpp)
do
  local function trim(s) return (s:gsub('^%s+', ''):gsub('%s+$', '')) end
  stringx.trim = function(s) return trim(tostring(s)) end

  -- utils::split with the REMOVE_EMPTY / STRIP_SPACES flags
  local function split_plain(str, sep, remove_empty, strip)
    local out, start = {}, 1
    while true do
      local at = str:find(sep, start, true)
      local piece = at and str:sub(start, at - 1) or str:sub(start)
      if strip then piece = trim(piece) end
      if not (remove_empty and piece == '') then out[#out + 1] = piece end
      if not at then break end
      start = at + #sep
    end
    return out
  end

  -- utils::parenthetical_split: split at sep (or, with no sep, into portions) outside brackets
  local function split_paren(str, sep, left, right, remove_empty, strip)
    local out, depth, current, stack = {}, 0, {}, {}
    local function flush()
      local piece = table.concat(current)
      if strip then piece = trim(piece) end
      if not (remove_empty and piece == '') then out[#out + 1] = piece end
      current = {}
    end
    for i = 1, #str do
      local ch = str:sub(i, i)
      local li = left:find(ch, 1, true)
      if li and (#stack == 0 or true) then
        if sep == '' and #stack == 0 then flush() end
        stack[#stack + 1] = right:sub(li, li)
        current[#current + 1] = ch
      elseif #stack > 0 and ch == stack[#stack] then
        stack[#stack] = nil
        current[#current + 1] = ch
        if sep == '' and #stack == 0 then flush() end
      elseif ch == sep and #stack == 0 and sep ~= '' then
        flush()
      else
        current[#current + 1] = ch
      end
    end
    flush()
    return out
  end

  local function split_escaped(str, sep, esc, remove_empty, strip)
    local out, current, i = {}, {}, 1
    local function flush()
      local piece = table.concat(current)
      if strip then piece = trim(piece) end
      if not (remove_empty and piece == '') then out[#out + 1] = piece end
      current = {}
    end
    while i <= #str do
      local ch = str:sub(i, i)
      if ch == esc and i < #str then
        current[#current + 1] = str:sub(i + 1, i + 1)
        i = i + 2
      elseif ch == sep then
        flush()
        i = i + 1
      else
        current[#current + 1] = ch
        i = i + 1
      end
    end
    flush()
    return out
  end

  function stringx.split(str, sep, options)
    str = tostring(str)
    sep = sep or ','
    local remove_empty, strip = true, true
    if type(options) == 'table' then
      remove_empty = options.remove_empty ~= false
      strip = options.strip_spaces ~= false
      if options.escape then return split_escaped(str, sep:sub(1, 1), options.escape, remove_empty, strip) end
      local left, right = options.quote_left, options.quote_right
      if options.quote then left, right = options.quote, options.quote end
      if left then return split_paren(str, sep:sub(1, 1), left, right, remove_empty, strip) end
    end
    return split_plain(str, sep:sub(1, 1), remove_empty, strip)
  end
  stringx.escaped_split = stringx.escaped_split
  function stringx.parenthetical_split(str, left, right, strip)
    return split_paren(tostring(str), '', left or '(', right or ')', true, strip ~= false)
  end

  function stringx.map_split(str, sep, kv, options)
    str = tostring(str)
    sep, kv = sep or ',', kv or ':'
    local remove_empty, strip, default = true, true, ''
    if type(options) == 'table' then
      remove_empty = options.remove_empty ~= false
      strip = options.strip_spaces ~= false
      default = options.default or ''
    end
    local out = {}
    for _, piece in ipairs(split_plain(str, sep, remove_empty, strip)) do
      local at = piece:find(kv, 1, true)
      if at then
        local key, value = piece:sub(1, at - 1), piece:sub(at + 1)
        if strip then key, value = trim(key), trim(value) end
        out[key] = value
      else
        out[piece] = default
      end
    end
    return out
  end

  function stringx.join(a, b)
    local list, sep
    if type(a) == 'table' then list, sep = a, b or ',' else sep, list = a, b end
    local pieces = {}
    for i = 1, #list do pieces[i] = tostring(list[i]) end
    return table.concat(pieces, sep)
  end

  function stringx.join_map(a, b, c)
    local map, sep, kv
    if type(a) == 'table' then map, sep, kv = a, b or ',', c or ':'
    elseif type(b) == 'table' then sep, map, kv = a, b, c or ':'
    else sep, kv, map = a, b, c end
    local keys = {}
    for k in pairs(map) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local pieces = {}
    for _, k in ipairs(keys) do pieces[#pieces + 1] = k .. kv .. tostring(map[k]) end
    return table.concat(pieces, sep)
  end

  function stringx.parse_range(str, real)
    str = tostring(str)
    local a, b = str:match('^%s*(-?[%d%.]+)%s*%-%s*(-?[%d%.]+)%s*$')
    if not a then a = str:match('^%s*(-?[%d%.]+)%s*$'); b = a end
    if str:find('infinity') then b = real and math.huge or 2 ^ 31 - 1 end
    a, b = tonumber(a) or 0, tonumber(b) or tonumber(a) or 0
    if not real then a, b = math.floor(a), math.floor(b) end
    return a, b
  end

  -- dollar-name interpolation against a table (utils::interpolate_variables_into_string):
  -- $name, $name.sub, $name[i].sub and $(formula) is not evaluated here
  function stringx.vformat(text, variables)
    return (tostring(text):gsub('%$([%a_][%w_%.%[%]]*)', function(name)
      local value = variables
      for part in name:gmatch('[^%.]+') do
        local key, index = part:match('^([^%[]+)%[(%d+)%]$')
        if type(value) ~= 'table' then return nil end
        if key then
          local count = 0
          local found
          for _, child in ipairs(value) do
            if child[1] == key then
              if count == tonumber(index) then found = child[2] break end
              count = count + 1
            end
          end
          value = found
        else
          value = value[part]
        end
        if value == nil then return nil end
      end
      if type(value) == 'boolean' then return value and 'yes' or 'no' end
      return tostring(value)
    end))
  end
  string.vformat = stringx.vformat

  local function format_list(default, values, word)
    if #values == 0 then return default end
    if #values == 1 then return values[1] end
    local head = {}
    for i = 1, #values - 1 do head[i] = values[i] end
    return table.concat(head, ', ') .. ' ' .. word .. ' ' .. values[#values]
  end
  function stringx.format_conjunct_list(default, values) return format_list(default, values, 'and') end
  function stringx.format_disjunct_list(default, values) return format_list(default, values, 'or') end

  -- A string indexed by a name looks it up in stringx; by an integer, it is that character.
  getmetatable('').__index = function(s, key)
    if type(key) == 'string' then return stringx[key] or string[key] end
    if type(key) == 'number' then
      if key == 0 or math.abs(key) > #s then return nil end
      return string.sub(s, key, key)
    end
  end
end

-- ---------------------------------------------------------------- mathx (lua_mathx.cpp)
do
  -- mathx.random(): float in [0,1); random(n): integer 1..n; random(a, b): integer a..b
  function mathx.random(a, b)
    if a == nil then return __random() end
    if b == nil then a, b = 1, a end
    if a > b then error('mathx.random: empty range', 2) end
    return a + math.floor(__random() * (b - a + 1))
  end
  function mathx.round(x)
    if x >= 0 then return math.floor(x + 0.5) end
    return -math.floor(-x + 0.5)
  end
  mathx.pi, mathx.huge = math.pi, math.huge
  for _, name in ipairs({ 'abs', 'acos', 'asin', 'atan', 'ceil', 'cos', 'exp', 'floor', 'fmod', 'log', 'max', 'min', 'sin', 'sqrt', 'tan' }) do
    mathx[name] = mathx[name] or math[name]
  end
end

-- ---------------------------------------------------------------- name_generator (src/name_generator.cpp)
-- A character Markov chain over the input names. The engine draws from its synced RNG;
-- the port draws from the script random stream, so a given seed names units differently.
do
  local function markov(names, chain_size, max_length)
    local starts, transitions = {}, {}
    local list = {}
    if type(names) == 'string' then
      for item in names:gmatch('[^,]+') do list[#list + 1] = (item:gsub('^%s+', ''):gsub('%s+$', '')) end
    else
      list = names
    end
    for _, name in ipairs(list) do
      if #name >= chain_size then
        starts[#starts + 1] = name:sub(1, chain_size)
        for i = 1, #name - chain_size + 1 do
          local prefix = name:sub(i, i + chain_size - 1)
          local following = name:sub(i + chain_size, i + chain_size)
          local entry = transitions[prefix]
          if not entry then entry = {} transitions[prefix] = entry end
          entry[#entry + 1] = following
        end
      end
    end
    return function()
      if #starts == 0 then return '' end
      local result = starts[mathx.random(#starts)]
      while #result < max_length do
        local entry = transitions[result:sub(-chain_size)]
        if not entry then break end
        local nextc = entry[mathx.random(#entry)]
        if nextc == '' then break end
        result = result .. nextc
      end
      return result
    end
  end

  function wesnoth.name_generator(kind, data, chain_size, max_length)
    if kind == 'markov' or kind == 'markov_chain' then
      return markov(data, chain_size or 2, max_length or 12)
    end
    -- context-free grammar: nonterminals in brackets expand to a random production
    local grammar = type(data) == 'table' and data or {}
    return function()
      local function expand(symbol, depth)
        local productions = grammar[symbol]
        if not productions or depth > 20 then return symbol end
        if type(productions) == 'string' then productions = stringx.split(productions, '|') end
        local choice = productions[mathx.random(#productions)]
        return (choice:gsub('%$?([%a_][%w_]*)', function(name) if grammar[name] then return expand(name, depth + 1) end end))
      end
      return expand('main', 0)
    end
  end
end

std_print = print

function wesnoth.map.generate(width, height, cfg)
  return __map_generate(width, height, cfg)
end

-- ---------------------------------------------------------------- hex math (lua_map_location_ops.cpp)
-- Locations are { x = , y = } tables in WML coordinates: 1-based over the playable area,
-- 0 and playable_size + 1 being the border hexes.
do
  local loc_mt = {}
  loc_mt.__index = function(self, key)
    if key == 1 then return rawget(self, 'x') elseif key == 2 then return rawget(self, 'y') end
  end
  loc_mt.__eq = function(a, b) return a.x == b.x and a.y == b.y end
  loc_mt.__tostring = function(self) return '(' .. self.x .. ',' .. self.y .. ')' end
  local function new_loc(x, y) return setmetatable({ x = x, y = y }, loc_mt) end
  wesnoth.map.__new_loc = new_loc

  -- accept (x, y), {x, y} and {x = , y = }
  local function read_loc(a, b)
    if type(a) == 'table' then return a.x or a[1], a.y or a[2] end
    return a, b
  end
  wesnoth.map.__read_loc = read_loc

  -- Neighbours in the engine order: N, NE, SE, S, SW, NW. In WML coordinates an odd
  -- column sits higher than its even neighbours.
  local function adjacent(x, y)
    if x % 2 == 1 then
      return { new_loc(x, y - 1), new_loc(x + 1, y - 1), new_loc(x + 1, y), new_loc(x, y + 1), new_loc(x - 1, y), new_loc(x - 1, y - 1) }
    end
    return { new_loc(x, y - 1), new_loc(x + 1, y), new_loc(x + 1, y + 1), new_loc(x, y + 1), new_loc(x - 1, y + 1), new_loc(x - 1, y) }
  end
  function wesnoth.map.get_adjacent_hexes(a, b)
    local x, y = read_loc(a, b)
    -- src/scripting/lua_map_location_ops.cpp:195-206 returns six separate values.
    -- Core/map.lua and World Conquest collect them with {get_adjacent_hexes(...)}.
    return table.unpack(adjacent(x, y))
  end

  local function distance(ax, ay, bx, by)
    local horizontal = math.abs(ax - bx)
    local a_even, b_even = ax % 2 == 0, bx % 2 == 0
    -- in WML coordinates the column parity is the opposite of the internal one
    local penalty = ((not a_even) and b_even and ay < by or (not b_even) and a_even and by < ay) and 1 or 0
    return math.max(horizontal, math.abs(ay - by) + penalty + horizontal // 2)
  end
  function wesnoth.map.distance_between(a, b, c, d)
    local ax, ay, bx, by
    if type(a) == 'table' then ax, ay = read_loc(a); bx, by = read_loc(b) else ax, ay, bx, by = a, b, c, d end
    return distance(ax, ay, bx, by)
  end
  function wesnoth.map.are_hexes_adjacent(a, b, c, d)
    local ax, ay, bx, by
    if type(a) == 'table' then ax, ay = read_loc(a); bx, by = read_loc(b) else ax, ay, bx, by = a, b, c, d end
    return distance(ax, ay, bx, by) == 1
  end
  function wesnoth.map.get_hexes_in_radius(a, b, c)
    local x, y, radius
    if type(a) == 'table' then x, y = read_loc(a); radius = b else x, y, radius = a, b, c end
    local seen, out = { [x .. ',' .. y] = true }, { new_loc(x, y) }
    local ring = { new_loc(x, y) }
    for _ = 1, radius do
      local next_ring = {}
      for _, loc in ipairs(ring) do
        for _, n in ipairs(adjacent(loc.x, loc.y)) do
          local key = n.x .. ',' .. n.y
          if not seen[key] then seen[key] = true; out[#out + 1] = n; next_ring[#next_ring + 1] = n end
        end
      end
      ring = next_ring
    end
    return out
  end
  function wesnoth.map.get_direction(a, b, c, d)
    local x, y, dir, count
    if type(a) == 'table' then x, y = read_loc(a); dir, count = b, c else x, y, dir, count = a, b, c, d end
    count = count or 1
    local names = { n = 1, ne = 2, se = 3, s = 4, sw = 5, nw = 6 }
    local index = names[dir]
    local loc = new_loc(x, y)
    for _ = 1, count do
      local n = adjacent(loc.x, loc.y)[index]
      loc = n
    end
    return loc
  end
end

-- ---------------------------------------------------------------- terrain codes and maps (mapgen kernel)
-- Real engine: t_translation, lua_terrainmap.cpp, lua_terrainfilter.cpp.
do
  local new_loc, read_loc = wesnoth.map.__new_loc, wesnoth.map.__read_loc

  local function split_code(code)
    local base, overlay = code:match('^([^%^]*)%^?(.*)$')
    return base, overlay
  end
  local function code_string(base, overlay)
    if overlay == nil or overlay == '' then return base end
    return base .. '^' .. overlay
  end

  -- a glob over one layer: "*" matches anything, a "*" inside matches any run
  local function layer_matches(pattern, value)
    if pattern == '*' then return true end
    if not pattern:find('*', 1, true) then return pattern == value end
    local lua_pattern = '^' .. pattern:gsub('[%^%$%(%)%%%.%[%]%+%-%?]', '%%%0'):gsub('%*', '.*') .. '$'
    return value:match(lua_pattern) ~= nil
  end

  -- terrain_matches: a list of codes, a "!" toggling the answer for what follows, a bare
  -- "*" ending the walk with the current answer
  local matcher_cache = {}
  local function compile(list)
    local cached = matcher_cache[list]
    if cached then return cached end
    local items = {}
    for item in tostring(list):gmatch('[^,]+') do
      item = item:gsub('^%s+', ''):gsub('%s+$', '')
      if item == '!' then
        items[#items + 1] = { negate = true }
      elseif item == '*' then
        items[#items + 1] = { all = true }
      else
        local base, overlay = split_code(item)
        -- a code without an overlay has none; "Gg^*" and "*^Fp" use the glob
        items[#items + 1] = { base = base, overlay = overlay }
      end
    end
    local function matches(code)
      if #items == 0 then return false end
      local base, overlay = split_code(code)
      local result = true
      for _, item in ipairs(items) do
        if item.all then return result end
        if item.negate then
          result = not result
        elseif layer_matches(item.base, base) and layer_matches(item.overlay, overlay) then
          return result
        end
      end
      return not result
    end
    matcher_cache[list] = matches
    return matches
  end
  wesnoth.map.__terrain_matches = function(code, list) return compile(list)(code) end

  -- ------------------------------------------------------------ the map object
  local MapMT = {}
  local SpecialMT = {}

  local function in_total(map, x, y) return x >= 0 and y >= 0 and x < map.__w and y < map.__h end
  local function on_board(map, x, y)
    return x >= map.__border and y >= map.__border and x < map.__w - map.__border and y < map.__h - map.__border
  end

  local function parse_map(text)
    local rows, starts = {}, {}
    local y = 0
    for line in text:gmatch('[^\r\n]+') do
      if line:find('=') == nil and line:match('%S') then
        local row, x = {}, 0
        for cell in line:gmatch('[^,]+') do
          cell = cell:gsub('^%s+', ''):gsub('%s+$', '')
          local player, rest = cell:match('^(%S+)%s+(%S+)$')
          if player then starts[player] = new_loc(x, y); cell = rest end
          row[x] = cell
          x = x + 1
        end
        rows[y] = row
        y = y + 1
      end
    end
    return rows, starts, y
  end

  local function make_map(rows, w, h, starts, border)
    local map = { __rows = rows, __w = w, __h = h, __starts = starts or {}, __border = border }
    return setmetatable(map, MapMT)
  end

  function wesnoth.map.create(a, b, c)
    if type(a) == 'number' then
      local rows = {}
      for y = 0, b - 1 do
        rows[y] = {}
        for x = 0, a - 1 do rows[y][x] = c end
      end
      return make_map(rows, a, b, {}, 0)
    end
    local rows, starts, h = parse_map(a or '')
    local w = 0
    if rows[0] then for x in pairs(rows[0]) do if x + 1 > w then w = x + 1 end end end
    return make_map(rows, w, h, starts, 1)
  end

  function wesnoth.map.on_board(map, a, b, with_border)
    local x, y = read_loc(a, b)
    if with_border then return in_total(map, x, y) end
    return on_board(map, x, y)
  end
  function wesnoth.map.on_border(map, a, b)
    local x, y = read_loc(a, b)
    return in_total(map, x, y) and not on_board(map, x, y)
  end

  -- merge a new code into an old one: "^Fp" sets the overlay, "Gg^" the base, otherwise replace
  local function merge(old, new)
    if new:sub(1, 1) == '^' then
      local base = split_code(old)
      return code_string(base, new:sub(2))
    elseif new:sub(-1) == '^' then
      local _, overlay = split_code(old)
      return code_string(new:sub(1, -2), overlay)
    end
    return new
  end

  MapMT.__index = function(self, key)
    if type(key) == 'table' then
      local x, y = read_loc(key)
      local row = rawget(self, '__rows')[y]
      return row and row[x]
    end
    if key == 'width' then return self.__w end
    if key == 'height' then return self.__h end
    if key == 'playable_width' then return self.__w - 2 * self.__border end
    if key == 'playable_height' then return self.__h - 2 * self.__border end
    if key == 'border_size' then return self.__border end
    if key == 'special_locations' then return setmetatable({ __map = self }, SpecialMT) end
    if key == 'data' then
      local lines = {}
      local by_pos = {}
      for name, loc in pairs(self.__starts) do by_pos[loc.x .. ',' .. loc.y] = name end
      for y = 0, self.__h - 1 do
        local cells = {}
        for x = 0, self.__w - 1 do
          local name = by_pos[x .. ',' .. y]
          cells[#cells + 1] = (name and (name .. ' ') or '') .. self.__rows[y][x]
        end
        lines[#lines + 1] = table.concat(cells, ', ')
      end
      return table.concat(lines, '\n') .. '\n'
    end
    return wesnoth.map[key]
  end
  MapMT.__newindex = function(self, key, value)
    if type(key) == 'table' then
      local x, y = read_loc(key)
      local row = self.__rows[y]
      if row and row[x] then row[x] = merge(row[x], tostring(value)) end
      return
    end
    error('unknown modifiable property of map: ' .. tostring(key), 2)
  end

  SpecialMT.__index = function(self, key) return self.__map.__starts[tostring(key)] end
  SpecialMT.__newindex = function(self, key, loc)
    local x, y = read_loc(loc)
    self.__map.__starts[tostring(key)] = new_loc(x, y)
  end
  SpecialMT.__pairs = function(self) return next, self.__map.__starts, nil end

  function wesnoth.map.iter(map, with_border)
    local x, y = with_border and -1 or 0, 1
    local width = with_border and map.__w - 1 or map.playable_width
    local height = with_border and map.__h - 1 or map.playable_height
    return function()
      if x == width then
        if y == height then return nil end
        x, y = with_border and 0 or 1, y + 1
      else
        x = x + 1
      end
      return x, y, map[{ x, y }]
    end
  end

  -- ------------------------------------------------------------ filters
  -- A filter is a table { "kind", ... }: all/any/none/not_all, x, y, find_in, adjacent,
  -- terrain, radius, cached, formula, onborder (lua_terrainfilter.cpp build_filter).
  local function parse_range(text)
    local set = {}
    for part in tostring(text):gmatch('[^,]+') do
      part = part:gsub('%s', '')
      local a, b = part:match('^(%d+)%-(%d+)$')
      if not a then a = part:match('^(%d+)$'); b = a end
      if a then for i = tonumber(a), tonumber(b) do set[i] = true end end
    end
    return set
  end

  local offsets_even = { { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 }, { 0, -1 } }
  local offsets_odd = { { 1, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 }, { -1, -1 }, { 0, -1 } }

  -- "n,se" style relative offsets (parse_rel)
  local function parse_rel(text)
    local s, se, last_was_n = 0, 0, false
    for ch in text:gmatch('.') do
      if ch == 'n' then s = s - 1; last_was_n = true
      elseif ch == 's' then s = s + 1; last_was_n = false
      elseif ch == 'e' then se = se + 1; if not last_was_n then s = s - 1 end
      elseif ch == 'w' then se = se - 1; if last_was_n then s = s + 1 end end
    end
    if se & 2 == 0 then return { se, s + se // 2 }, { se, s + se // 2 } end
    return { se, s + (se - 1) // 2 }, { se, s + (se + 1) // 2 }
  end

  local build

  local function location_list(value)
    local set = {}
    if type(value) ~= 'table' then return set end
    if value.x or (type(value[1]) == 'number' and type(value[2]) == 'number' and #value == 2) then
      local x, y = read_loc(value)
      set[x .. ',' .. y] = true
      return set
    end
    for _, loc in ipairs(value) do
      local x, y = read_loc(loc)
      set[x .. ',' .. y] = true
    end
    return set
  end

  function build(spec, resources, known)
    if type(spec) ~= 'table' then error('buildfilter: expected table', 3) end
    local kind = spec[1]
    if kind == 'all' or kind == 'any' or kind == 'none' or kind == 'not_all' or kind == 'notall' then
      local children = {}
      for i = 2, #spec do children[#children + 1] = build(spec[i], resources, known) end
      if kind == 'all' then
        return function(map, x, y) for _, f in ipairs(children) do if not f(map, x, y) then return false end end return true end
      elseif kind == 'any' then
        return function(map, x, y) for _, f in ipairs(children) do if f(map, x, y) then return true end end return false end
      elseif kind == 'none' then
        return function(map, x, y) for _, f in ipairs(children) do if f(map, x, y) then return false end end return true end
      end
      return function(map, x, y) for _, f in ipairs(children) do if not f(map, x, y) then return true end end return false end
    elseif kind == 'x' then
      local set = parse_range(spec[2])
      return function(map, x, y) return set[x] == true end
    elseif kind == 'y' then
      local set = parse_range(spec[2])
      return function(map, x, y) return set[y] == true end
    elseif kind == 'onborder' then
      return function(map, x, y) return not on_board(map, x, y) end
    elseif kind == 'terrain' then
      local matches = compile(spec[2])
      return function(map, x, y)
        local row = map.__rows[y]
        local code = row and row[x]
        return code ~= nil and matches(code)
      end
    elseif kind == 'find_in' then
      local set
      local second, third = spec[2], spec[3]
      if type(second) == 'table' then
        set = location_list(second)
      elseif type(second) == 'number' then
        set = { [second .. ',' .. third] = true }
      elseif type(second) == 'string' then
        if type(third) == 'string' then
          -- ranges of x and ranges of y, pairwise
          set = {}
          local xs, ys = {}, {}
          for part in second:gmatch('[^,]+') do xs[#xs + 1] = part end
          for part in third:gmatch('[^,]+') do ys[#ys + 1] = part end
          for i = 1, math.min(#xs, #ys) do
            for x in pairs(parse_range(xs[i])) do
              for y in pairs(parse_range(ys[i])) do set[x .. ',' .. y] = true end
            end
          end
        else
          if known[second] == nil then known[second] = location_list(resources and resources[second]) end
          set = known[second]
        end
      else
        set = {}
      end
      return function(map, x, y) return set[x .. ',' .. y] == true end
    elseif kind == 'adjacent' then
      local inner = build(spec[2], resources, known)
      local even, odd = offsets_even, offsets_odd
      if spec.adjacent then
        even, odd = {}, {}
        for part in tostring(spec.adjacent):gmatch('[^,]+') do
          local e, o = parse_rel((part:gsub('%s', '')))
          even[#even + 1] = e
          odd[#odd + 1] = o
        end
      end
      local counts = spec.count and parse_range(spec.count) or nil
      return function(map, x, y)
        local offsets = (x % 2 == 1) and odd or even
        local count = 0
        for _, o in ipairs(offsets) do
          local ax, ay = x + o[1], y + o[2]
          if in_total(map, ax, ay) and inner(map, ax, ay) then
            if not counts then return true end
            count = count + 1
          end
        end
        return counts ~= nil and counts[count] == true
      end
    elseif kind == 'radius' then
      local radius = spec[2]
      local inner = build(spec[3], resources, known)
      local radius_filter = spec.filter_radius and build(spec.filter_radius, resources, known) or nil
      return function(map, x, y)
        -- src/scripting/lua_terrainfilter.cpp:535-551 tests existence in the reachable
        -- radius. This is an existence query over pure filters. Stop at the first match
        -- instead of materializing the whole radius for every hex of the map.
        if inner(map, x, y) then return true end
        local seen = { [x .. ',' .. y] = true }
        local ring = { { x, y } }
        for _ = 1, radius do
          local next_ring = {}
          for _, loc in ipairs(ring) do
            for _, n in ipairs({wesnoth.map.get_adjacent_hexes(loc[1], loc[2])}) do
              local key = n.x .. ',' .. n.y
              if not seen[key] and in_total(map, n.x, n.y) and (not radius_filter or radius_filter(map, n.x, n.y)) then
                seen[key] = true
                if inner(map, n.x, n.y) then return true end
                next_ring[#next_ring + 1] = { n.x, n.y }
              end
            end
          end
          ring = next_ring
          if #ring == 0 then break end
        end
        return false
      end
    elseif kind == 'cached' then
      local inner = build(spec[2], resources, known)
      local cache = {}
      return function(map, x, y)
        local key = x .. ',' .. y
        local hit = cache[key]
        if hit == nil then hit = inner(map, x, y); cache[key] = hit end
        return hit
      end
    elseif kind == 'formula' then
      -- WFL map formulas are not ported; the filter never matches (PORT_COVERAGE.md)
      return function() return false end
    end
    error('buildfilter: invalid filter type ' .. tostring(kind), 3)
  end

  local FilterMT = { __metatable = 'terrainfilter' }
  FilterMT.__index = FilterMT

  function wesnoth.map.filter(spec, resources)
    if getmetatable(spec) == 'terrainfilter' then return spec end
    local known = {}
    return setmetatable({ matches = build(spec, resources, known) }, FilterMT)
  end

  local function as_filter(f)
    if type(f) == 'table' and rawget(f, 'matches') then return f end
    return wesnoth.map.filter(f)
  end

  local function sorted_locations(set_of_keys)
    local out = {}
    for key in pairs(set_of_keys) do
      local x, y = key:match('^(-?%d+),(-?%d+)$')
      out[#out + 1] = { tonumber(x), tonumber(y) }
    end
    table.sort(out, function(a, b) if a[1] ~= b[1] then return a[1] < b[1] end return a[2] < b[2] end)
    local locs = {}
    for _, p in ipairs(out) do locs[#locs + 1] = new_loc(p[1], p[2]) end
    return locs
  end

  -- map:find(filter, [locations]): the matching hexes of the playable area
  function wesnoth.map.find(map, filter, locs)
    local f = as_filter(filter)
    local found = {}
    if locs ~= nil then
      for key in pairs(location_list(locs)) do
        local x, y = key:match('^(-?%d+),(-?%d+)$')
        x, y = tonumber(x), tonumber(y)
        if f.matches(map, x, y) then found[key] = true end
      end
    else
      for y = map.__border, map.__h - map.__border - 1 do
        for x = map.__border, map.__w - map.__border - 1 do
          if f.matches(map, x, y) then found[x .. ',' .. y] = true end
        end
      end
    end
    return sorted_locations(found)
  end

  function wesnoth.map.find_in_radius(map, locs, radius, filter)
    local f = as_filter(filter)
    local result = {}
    local ring = {}
    for key in pairs(location_list(locs)) do
      result[key] = true
      local x, y = key:match('^(-?%d+),(-?%d+)$')
      ring[#ring + 1] = { tonumber(x), tonumber(y) }
    end
    for _ = 1, radius do
      local next_ring = {}
      for _, loc in ipairs(ring) do
        for _, n in ipairs({wesnoth.map.get_adjacent_hexes(loc[1], loc[2])}) do
          local key = n.x .. ',' .. n.y
          if not result[key] and in_total(map, n.x, n.y) and f.matches(map, n.x, n.y) then
            result[key] = true
            next_ring[#next_ring + 1] = { n.x, n.y }
          end
        end
      end
      ring = next_ring
    end
    return sorted_locations(result)
  end

  function wesnoth.map.replace_if_failed(code, mode, replace)
    return code
  end
end
`;

