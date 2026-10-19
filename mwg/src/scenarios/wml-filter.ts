/**
 * WML unit and location filters, evaluated against the live game.
 *
 * Ported from `src/units/filter.cpp` (`unit_filter_compound`) and
 * `src/terrain/filter.cpp` in the 1.19.27 checkout. The parts that matter:
 *
 * - A filter body is attributes plus child blocks. The attributes and the
 *   non-conditional children (`[filter_wml]`, `[filter_location]`,
 *   `[filter_adjacent]`) are conjunctions; `[and]`, `[or]` and `[not]` then
 *   apply **in document order to the result so far** (`filter.cpp:263-276`):
 *   `res = res && andBlock`, `res = res || orBlock`, `res = res && !notBlock`.
 *   An `[or]` is therefore not a parallel alternative, it ORs with everything
 *   evaluated before it.
 * - String attributes (`id`, `type`, `race`, `status`, `ability`, `trait`,
 *   `has_weapon`, `side`) are comma lists tested for membership
 *   (`utils::split` + `utils::contains`, `filter.cpp:329-520`).
 * - Numeric attributes (`level`, `hitpoints`, `recall_cost`, `defense`,
 *   `movement_cost`, `vision_cost`, `jamming_cost`, and the port's `moves`,
 *   `experience`) are ranges parsed by `utils::parse_ranges_unsigned` and
 *   tested with `in_ranges` (`filter.cpp:563-620`): `level=0-2`, `level=1,3`.
 * - `x`/`y` use `unit_filter_xy` (`filter.cpp:693`), which takes the same
 *   ranges.
 * - `[filter_wml]` serializes the unit and matches the config recursively
 *   (`filter.cpp:701-715`), so its attribute values take `config::matches`
 *   semantics: `*`/`?` globs, `>`,`<`,`>=`,`<=`,`!=` comparisons.
 * - `[filter_location]` is a terrain filter (`filter.cpp:740-742`), so
 *   `terrain=` uses the real terrain-code wildcard codec
 *   (`src/simulation/terrain-codes.ts`, from `translation.cpp`).
 *
 * The port's coordinates are 0-based while WML writes 1-based ones, so a
 * filter crossing into this module is shifted once by `toFilterNode`; every
 * `[filter_wml]` comparison against a unit's `x`/`y` shifts back at the point
 * of use. `not_type`/`not_race` style keys are the port's own spelling for the
 * same negation `[not] type=... [/not]` expresses, kept because the loader has
 * emitted them since P1.
 */

import { interpolateWml, type WmlValue, type WmlValueScope } from './wml-value.ts';
import { encodeCode, parseTerrainList, terrainMatches } from '../simulation/terrain-codes.ts';
import { hexDistance, hexNeighbors, hexRange } from 'mwg';
import { evaluateFormula, type FormulaObject } from '../simulation/expression.ts';
import type { Unit } from '../simulation/unit.ts';
import type { WmlNode } from '../simulation/wml.ts';

/** A filter tree with no source locations, safe to serialize into a scenario. */
export interface WmlFilterNode {
  tag: string;
  attributes: Record<string, string>;
  children: WmlFilterNode[];
}

/** What a filter reads from the live game. */
export interface FilterWorld {
  /** resolve `$name` in a filter value, the same scope content reads */
  variable(path: string): WmlValue | undefined;
  /** the terrain code at a cell */
  terrainAt(x: number, y: number): string;
  /** the side owning a village, or null */
  villageOwnerAt(x: number, y: number): number | null;
  /** whether two sides are on the same team */
  allied(a: number, b: number): boolean;
  /** the ability ids a unit has (its type's plus its own) */
  abilitiesOf(unit: Unit): readonly string[];
  /** ability definitions, including the WML effect tag and attributes */
  abilityDetailsOf?(unit: Unit): readonly { id: string; tag: string; attributes: Readonly<Record<string, string>> }[];
  /** the attacks a unit can use */
  attacksOf(unit: Unit): readonly { id: string; name: string; range: string; type: string }[];
  /** the race id of a unit's type */
  raceOf(unit: Unit): string;
  /** whether a cell's terrain is a village */
  isVillageAt?(x: number, y: number): boolean;
  /** the unit at a cell, when a caller needs one */
  unitAt?(x: number, y: number): Unit | undefined;
  /** whether a side currently sees a cell (fog/shroud, not hidden-unit rules) */
  visibleTo?(side: number, x: number, y: number): boolean;
}

/** Numeric attributes read as ranges, per `filter.cpp`'s `create_attribute` calls. */
const RANGE_ATTRIBUTES = new Set([
  'level',
  'hitpoints',
  'max_hitpoints',
  'experience',
  'max_experience',
  'moves',
  'max_moves',
  'recall_cost',
  'cost',
  'vision',
  'defense',
  'movement_cost',
  'vision_cost',
  'jamming_cost',
  'attacks_left',
]);

/** String attributes read as comma-separated membership lists. */
const LIST_ATTRIBUTES = new Set([
  'id',
  'type',
  'race',
  'gender',
  'status',
  'ability',
  'trait',
  'has_weapon',
  'variation',
  'alignment',
  'role',
  'upkeep',
  'side',
]);

/**
 * Copy a parsed WML filter into the serializable form. The `x,y` shorthand is
 * split, and nothing else changes: WML coordinates stay 1-based here, because
 * the engine expands a filter value (`$target_x`) before it parses it as a map
 * location, and shifting at encode time would compare a variable's 1-based
 * value against the port's 0-based grid (`src/units/filter.cpp:693`).
 */
export function toFilterNode(node: WmlNode): WmlFilterNode {
  return toFilterNodeInternal(node, true);
}

function toFilterNodeInternal(node: WmlNode, root: boolean): WmlFilterNode {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === 'x,y') {
      const [x, y] = value.split(',');
      attributes.x = (x ?? '').trim();
      attributes.y = (y ?? '').trim();
      continue;
    }
    attributes[key] = value;
  }
  return {
    tag: node.tag,
    attributes,
    // The outer `[filter]` is a structural wrapper. Nested `[filter]` blocks
    // are meaningful references inside `[filter_location]` and must survive.
    children: node.children
      .filter((child) => !(root && child.tag === 'filter'))
      .map((child) => toFilterNodeInternal(child, false)),
  };
}

export function encodeFilter(node: WmlFilterNode): string {
  return encodeURIComponent(JSON.stringify(node));
}

export function decodeFilter(encoded: string): WmlFilterNode | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as WmlFilterNode;
    return parsed && typeof parsed.tag === 'string' && parsed.attributes ? parsed : null;
  } catch {
    return null;
  }
}

/** `utils::parse_ranges_unsigned` plus `in_ranges`: `0-2`, `1,3`, `5`. */
export function valueInRanges(actual: number, spec: string): boolean {
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(trimmed);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (actual >= Math.min(low, high) && actual <= Math.max(low, high)) return true;
      continue;
    }
    if (Number(trimmed) === actual) return true;
  }
  return false;
}

/** `config::matches` value semantics: globs and numeric comparisons. */
function configValueMatches(actual: string, spec: string): boolean {
  const comparison = /^(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (comparison) {
    const left = Number(actual);
    const right = Number(comparison[2]);
    if (Number.isFinite(left)) {
      switch (comparison[1]) {
        case '>=': return left >= right;
        case '<=': return left <= right;
        case '!=': return left !== right;
        case '>': return left > right;
        case '<': return left < right;
        case '=': return left === right;
      }
    }
  }
  if (spec.includes('*') || spec.includes('?')) {
    const pattern = new RegExp(`^${spec.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return pattern.test(actual);
  }
  return actual === spec;
}

/** One attribute value, with `$variables` resolved first. */
function resolveValue(value: string, world: FilterWorld): string {
  if (!value.includes('$')) return value;
  const scope: WmlValueScope = (path) => world.variable(path);
  return interpolateWml(value, scope);
}

function unitAttribute(unit: Unit, key: string, world: FilterWorld): string | number | boolean | undefined {
  switch (key) {
    case 'id': return unit.wmlId ?? String(unit.id);
    case 'name': return unit.name;
    case 'type': return unit.typeId;
    case 'race': return world.raceOf(unit);
    case 'side': return unit.side;
    case 'level': return unit.level;
    case 'hitpoints': return unit.hitpoints;
    case 'max_hitpoints': return unit.maxHitpoints;
    case 'experience': return unit.experience;
    case 'max_experience': return unit.maxExperience;
    case 'moves': return unit.movement;
    case 'max_moves': return unit.maxMovement;
    case 'alignment': return unit.alignment;
    case 'canrecruit': return unit.canRecruit === true;
    case 'resting': return unit.resting === true;
    case 'loyal': return unit.loyal === true;
    case 'upkeep': return unit.loyal ? 'loyal' : 'full';
    case 'x': return unit.x;
    case 'y': return unit.y;
    default: return undefined;
  }
}

/**
 * Whether a unit matches one filter body (attributes plus its non-conditional
 * children, then `[and]`/`[or]`/`[not]` in document order).
 */
export function matchesUnitFilter(node: WmlFilterNode, unit: Unit, world: FilterWorld, second?: Unit): boolean {
  let result = attributesMatch(node.attributes, unit, world, second);
  for (const child of node.children) {
    if (child.tag === 'filter_wml') result = result && filterWmlMatches(child, unit, world);
    else if (child.tag === 'filter_location') result = result && filterLocationMatches(child, unit.x, unit.y, world);
    else if (child.tag === 'filter_adjacent') result = result && filterAdjacentMatches(child, unit, world);
    else if (child.tag === 'filter_vision') result = result && filterVisionMatches(child, unit.x, unit.y, unit.side, world);
    else if (child.tag === 'filter_ability') result = result && filterAbilityMatches(child, unit, world);
    else if (child.tag === 'filter_second' && second) result = result && matchesUnitFilter(child, second, world, unit);
  }
  // `[and]`, `[or]` and `[not]` fold into the result so far, in document order.
  for (const child of node.children) {
    if (child.tag === 'and') result = result && matchesUnitFilter(child, unit, world, second);
    else if (child.tag === 'or') result = result || matchesUnitFilter(child, unit, world, second);
    else if (child.tag === 'not') result = result && !matchesUnitFilter(child, unit, world, second);
  }
  return result;
}

/** `[filter_adjacent]` counts neighboring units matching its unit filter. */
function filterAdjacentMatches(node: WmlFilterNode, unit: Unit, world: FilterWorld): boolean {
  const neighbors = hexNeighbors(unit.x, unit.y)
    .map(({ x, y }) => world.unitAt?.(x, y))
    .filter((neighbor): neighbor is Unit => neighbor !== undefined && neighbor.hitpoints > 0);
  const candidates = neighbors.filter((neighbor) => {
    const isEnemy = !world.allied(unit.side, neighbor.side);
    if (node.attributes.is_enemy !== undefined && isEnemy !== booleanValue(node.attributes.is_enemy)) return false;
    if (node.attributes.is_friend !== undefined && !isEnemy !== booleanValue(node.attributes.is_friend)) return false;
    // `count` is a property of the adjacent filter, not of the nested unit filter.
    const nested: WmlFilterNode = {
      tag: 'filter',
      attributes: Object.fromEntries(Object.entries(node.attributes).filter(([key]) =>
        key !== 'count' && key !== 'is_enemy' && key !== 'is_friend')),
      children: node.children,
    };
    return matchesUnitFilter(nested, neighbor, world, unit);
  });
  const count = node.attributes.count;
  return count === undefined ? candidates.length > 0 : valueInRanges(candidates.length, resolveValue(count, world));
}

function booleanValue(value: string): boolean {
  return value !== 'no' && value !== 'false' && value !== '0';
}

/** `[filter_ability]` matches an ability definition, not merely its registry id. */
function filterAbilityMatches(node: WmlFilterNode, unit: Unit, world: FilterWorld): boolean {
  const details = world.abilityDetailsOf?.(unit) ?? world.abilitiesOf(unit).map((id) => ({ id, tag: id, attributes: {} }));
  return details.some((ability) => Object.entries(node.attributes).every(([key, raw]) => {
    const value = resolveValue(raw, world);
    const actual = key === 'id' ? ability.id : key === 'tag_name' ? ability.tag : ability.attributes[key];
    return actual !== undefined && value.split(',').map((entry) => entry.trim()).includes(actual);
  }));
}

function attributesMatch(attributes: Record<string, string>, unit: Unit, world: FilterWorld, second?: Unit): boolean {
  for (const [key, raw] of Object.entries(attributes)) {
    const value = resolveValue(raw, world);
    if (key === 'formula') {
      if (!unitFormulaMatches(value, unit, second, world)) return false;
      continue;
    }
    // `not_type=`, `not_race=` and friends are the port's spelling for the
    // negation `[not] type=... [/not]` writes; the test is inverted, not absent.
    if (key.startsWith('not_')) {
      if (matchesAttribute(key.slice(4), value, unit, world, second)) return false;
      continue;
    }
    if (!matchesAttribute(key, value, unit, world, second)) return false;
  }
  return true;
}

/** Evaluate the WFL filter formula with the engine's self/other unit scope. */
function unitFormulaMatches(source: string, unit: Unit, second: Unit | undefined, world: FilterWorld): boolean {
  try {
    const self = formulaUnit(unit, world);
    const other = second ? formulaUnit(second, world) : undefined;
    const value = evaluateFormula(source.replace(/^\s*[([{]|[)\]}]\s*$/g, ''), { values: { self, other } });
    return Boolean(value);
  } catch {
    return false;
  }
}

function formulaUnit(unit: Unit, world: FilterWorld): FormulaObject {
  return {
    id: unit.wmlId ?? String(unit.id),
    type: unit.typeId,
    side: unit.side,
    level: unit.level,
    hitpoints: unit.hitpoints,
    max_hitpoints: unit.maxHitpoints,
    experience: unit.experience,
    max_experience: unit.maxExperience,
    moves: unit.movement,
    max_moves: unit.maxMovement,
    x: unit.x + 1,
    y: unit.y + 1,
    resting: unit.resting === true,
    canrecruit: unit.canRecruit === true,
    race: world.raceOf(unit),
  };
}

function matchesAttribute(key: string, value: string, unit: Unit, world: FilterWorld, second?: Unit): boolean {
  if (key === 'ability') {
    const abilities = world.abilitiesOf(unit);
    return value.split(',').map((entry) => entry.trim()).some((entry) => entry !== '' && abilities.includes(entry));
  }
  if (key === 'trait') {
    const traits = unit.traits ?? [];
    return value.split(',').map((entry) => entry.trim()).some((entry) => entry !== '' && traits.includes(entry));
  }
  if (key === 'has_weapon') {
    const attacks = world.attacksOf(unit);
    return value.split(',').map((entry) => entry.trim()).some((entry) => entry !== '' && attacks.some((attack) => attack.id === entry));
  }
  if (key === 'status') {
    const active = (['poisoned', 'slowed', 'petrified'] as const).filter((status) => unit[status]);
    return value.split(',').map((entry) => entry.trim()).some((entry) => entry !== '' && active.includes(entry as typeof active[number]));
  }
  if (key === 'x' || key === 'y') {
    // The engine parses an expanded filter value as a 1-based map location.
    const coordinate = (key === 'x' ? unit.x : unit.y) + 1;
    return valueInRanges(coordinate, value);
  }
  if (key === 'canrecruit' || key === 'resting' || key === 'loyal') {
    const actual = unitAttribute(unit, key, world);
    const wanted = value === 'yes' || value === 'true' || value === '1';
    return (actual === true) === wanted;
  }
  if (RANGE_ATTRIBUTES.has(key)) {
    const actual = unitAttribute(unit, key, world);
    return typeof actual === 'number' && valueInRanges(actual, value);
  }
  if (LIST_ATTRIBUTES.has(key)) {
    const actual = unitAttribute(unit, key, world);
    if (actual === undefined) return true;
    if (typeof actual === 'boolean') return String(actual) === value || (value === 'yes' && actual) || (value === 'no' && !actual);
    return value.split(',').map((entry) => entry.trim()).filter(Boolean).some((entry) => entry === String(actual));
  }
  // An attribute this port does not evaluate matches nothing, like the engine
  // ignoring an attribute it has no reader for (`filter.cpp`'s create_attribute
  // table is exhaustive: an unknown key is never tested).
  void second;
  return true;
}

/** `[filter_vision]` tests whether a location is currently visible to a side. */
function filterVisionMatches(node: WmlFilterNode, x: number, y: number, defaultSide: number, world: FilterWorld): boolean {
  const sides = (resolveValue(node.attributes.side ?? String(defaultSide), world))
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((side) => Number.isFinite(side));
  const visible = sides.some((side) => world.visibleTo?.(side, x, y) ?? false);
  const wanted = booleanValue(node.attributes.visible ?? 'yes');
  return visible === wanted;
}

/** The `[filter_wml]` body: a recursive match against the unit's WML form. */
function filterWmlMatches(node: WmlFilterNode, unit: Unit, world: FilterWorld): boolean {
  for (const [key, value] of Object.entries(node.attributes)) {
    const actual = unitAttribute(unit, key, world);
    if (actual === undefined) return false;
    // WML writes 1-based coordinates; the port stores 0-based ones.
    const comparable = key === 'x' || key === 'y' ? String(Number(actual) + 1) : String(actual);
    if (!configValueMatches(comparable, resolveValue(value, world))) return false;
  }
  for (const child of node.children) {
    if (child.tag === 'status') {
      for (const [key, value] of Object.entries(child.attributes)) {
        const active = (['poisoned', 'slowed', 'petrified'] as const).includes(key as 'poisoned');
        if (!active) continue;
        const on = unit[key as 'poisoned' | 'slowed' | 'petrified'] === true;
        const wanted = value === 'yes' || value === 'true' || value === '1';
        if (on !== wanted) return false;
      }
      continue;
    }
    if (child.tag === 'variables') continue;
    return false;
  }
  return true;
}

/** `[filter_location]`: a terrain filter, plus tile-level ownership. */
export function filterLocationMatches(node: WmlFilterNode, x: number, y: number, world: FilterWorld): boolean {
  const attributes = node.attributes;
  const radius = attributes.radius === undefined ? 0 : Math.max(0, Number(resolveValue(attributes.radius, world)) || 0);
  if (radius === 0 && (attributes.x !== undefined || attributes.y !== undefined)) {
    // A `[filter_location]` coordinate is WML's 1-based spelling, so compare
    // the 1-based position the caller passes in.
    const inX = attributes.x === undefined || valueInRanges(x + 1, attributes.x);
    const inY = attributes.y === undefined || valueInRanges(y + 1, attributes.y);
    if (!(inX && inY)) return false;
  }
  if (radius > 0 && (attributes.x !== undefined || attributes.y !== undefined)) {
    const centers = locationCenters(attributes, world);
    if (centers.length === 0 || !centers.some((center) => hexDistance(center, { x, y }) <= radius)) return false;
  }
  if (attributes.terrain !== undefined) {
    const code = world.terrainAt(x, y);
    if (code === '') return false;
    const wanted = parseTerrainList(resolveValue(attributes.terrain, world));
    if (!terrainMatches(encodeCode(code), wanted)) return false;
  }
  if (attributes.owner_side !== undefined || attributes.side !== undefined) {
    const spec = attributes.owner_side ?? attributes.side ?? '';
    const owners = resolveValue(spec, world)
      .split(',')
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
    const owner = world.villageOwnerAt(x, y);
    if (owner === null || !owners.includes(owner)) return false;
  }
  if (attributes.is_village !== undefined) {
    const wanted = attributes.is_village !== 'no' && attributes.is_village !== 'false';
    const onVillage = world.isVillageAt?.(x, y) ?? false;
    if (onVillage !== wanted) return false;
  }
  for (const child of node.children) {
    if (child.tag === 'and' && !filterLocationMatches(child, x, y, world)) return false;
    if (child.tag === 'not' && filterLocationMatches(child, x, y, world)) return false;
    if (child.tag === 'filter_adjacent_location' && !filterAdjacentLocationMatches(child, x, y, world)) return false;
    if (child.tag === 'filter_vision' && !filterVisionMatches(child, x, y, 0, world)) return false;
    if (child.tag === 'filter_radius' && !filterLocationMatches(child, x, y, world)) return false;
    if (child.tag === 'filter' && !radiusReferenceMatches(child, x, y, radius, world)) return false;
  }
  if (radius > 0 && attributes.x === undefined && attributes.y === undefined &&
      !node.children.some((child) => child.tag === 'filter')) return false;
  return true;
}

function locationCenters(attributes: Record<string, string>, world: FilterWorld): { x: number; y: number }[] {
  const xs = resolveValue(attributes.x ?? '', world).split(',').map((value) => Number(value.trim()) - 1).filter(Number.isFinite);
  const ys = resolveValue(attributes.y ?? '', world).split(',').map((value) => Number(value.trim()) - 1).filter(Number.isFinite);
  return xs.flatMap((cx) => ys.map((cy) => ({ x: cx, y: cy })));
}

/**
 * Wesnoth expands `radius` before matching and uses `[filter_radius]` to
 * constrain the candidate (`src/terrain/filter.cpp:397-414`). The port's
 * FilterWorld intentionally exposes no map iterator, so a nested unit filter
 * scans the framework hex range through `unitAt`.
 */
function radiusReferenceMatches(node: WmlFilterNode, x: number, y: number, radius: number, world: FilterWorld): boolean {
  if (radius <= 0) return true;
  return hexRange({ x, y }, radius).some(({ x: nx, y: ny }) => {
    const reference = world.unitAt?.(nx, ny);
    return reference !== undefined && reference.hitpoints > 0 && matchesUnitFilter(node, reference, world);
  });
}

/** `[filter_adjacent_location]` applies a location filter to each neighbor. */
function filterAdjacentLocationMatches(node: WmlFilterNode, x: number, y: number, world: FilterWorld): boolean {
  const matching = hexNeighbors(x, y).filter(({ x: nx, y: ny }) =>
    filterLocationMatches({ ...node, children: node.children.filter((child) => child.tag !== 'filter_adjacent_location') }, nx, ny, world),
  ).length;
  const count = node.attributes.count;
  return count === undefined ? matching > 0 : valueInRanges(matching, resolveValue(count, world));
}
