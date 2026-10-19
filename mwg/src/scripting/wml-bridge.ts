// WML <-> Lua tables, the shape `luaW_pushconfig`/`luaW_toconfig` (`src/scripting/lua_common.cpp`)
// gives scripts: a config is a table whose array part lists its children as
// `{ "tag", { ...contents } }` pairs and whose string keys are its attributes.
//
// Attribute typing: Wesnoth stores a parsed attribute as a variant, and Lua sees `yes`/`no`
// (and `true`/`false`) as booleans and numeric text as numbers; anything else stays a string.
import type { WmlNode } from '../simulation/wml.ts';
import type { LuaValue } from './lua-vm.ts';

/** One attribute value as a script reads it. */
export function attributeValue(raw: string): LuaValue {
  const value = raw.trim();
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  if (/^-?\d+$/.test(value) && Math.abs(Number(value)) < 2 ** 53) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return raw;
}

/** A node's contents (attributes and children) as a Lua config table. */
export function wmlContents(node: WmlNode): { [key: string]: LuaValue } {
  const table: { [key: string]: LuaValue } = {};
  node.children.forEach((child, index) => {
    table[String(index + 1)] = { 1: child.tag, 2: wmlContents(child) } as unknown as LuaValue;
  });
  for (const [name, value] of Object.entries(node.attributes)) table[name] = attributeValue(value);
  // a `[lua]` block's source is kept apart from its attributes by the parser
  if (node.luaSource !== undefined) table.code = node.luaSource;
  return table;
}

/** A list of sibling nodes as a config table (the root of a file, a `[scenario]`'s children). */
export function wmlList(nodes: readonly WmlNode[]): { [key: string]: LuaValue } {
  const table: { [key: string]: LuaValue } = {};
  nodes.forEach((child, index) => {
    table[String(index + 1)] = { 1: child.tag, 2: wmlContents(child) } as unknown as LuaValue;
  });
  return table;
}
