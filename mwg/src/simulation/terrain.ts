/**
 * Terrain resolution, ported from the shapes in `data/core/terrain.cfg` and the
 * way `terrain_type_data`/`gamemap` merge base + overlay codes.
 *
 * A map cell code such as `Gg^Ve` is a base terrain `Gg` (grassland) with an
 * overlay `^Ve` (elven village). The merged terrain takes the best movement cost
 * and the best defense of its base and overlay chains, and the overlay's
 * healing/income when the overlay has any. `_bas` in an overlay's aliasof means
 * "the base terrain"; `mvt_alias` replaces the movement chain outright.
 *
 * Unit-type `[movement_costs]`/`[defense]`/`[resistance]` tables merge over the
 * movetype (`src/units/types.cpp:298 movement_type_.merge(cfg)`, overwrite mode
 * in `src/movetype.cpp:854`): see `effectiveMovetype`.
 *
 * Not ported (documented in PORT_COVERAGE.md): `default_base` map-code merging
 * inside the engine, `vision_costs`, `jamming_costs`, and the terrain-graphics
 * transition renderer.
 */

import type { MovetypeDef, TerrainDef, WesnothData } from './types.ts';

export interface ResolvedTerrain {
  id: string;
  baseId: string;
  overlayId: string | null;
  /** best (lowest) movement cost for this movetype, Infinity when impassable */
  moveCost: number;
  /** best (lowest) [defense] value for this movetype: the chance to be hit, 0..100 */
  defense: number;
  /** healing per turn standing here */
  heals: number;
  isVillage: boolean;
}

const IMPASSABLE = Number.POSITIVE_INFINITY;

export function splitCode(code: string): { base: string; overlay: string | null } {
  const caret = code.indexOf('^');
  if (caret === -1) return { base: code, overlay: null };
  return { base: code.slice(0, caret), overlay: code.slice(caret) };
}

export function terrainIdForCode(data: WesnothData, code: string): string {
  const exact = data.terrainByCode[code];
  if (exact) return exact;
  const { base } = splitCode(code);
  return data.terrainByCode[base] ?? base;
}

/** Follow an aliasof chain, resolving `_bas` against the base id, into terrain ids. */
function aliasChain(data: WesnothData, id: string, baseId: string, seen: Set<string>): string[] {
  // Alias entries may be terrain ids (`flat`) or map codes (`Gt`); resolve both.
  const resolved = data.terrains[id] ? id : data.terrainByCode[id] ? data.terrainByCode[id] : id;
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  const def = data.terrains[resolved];
  if (!def) return [resolved];
  const chain: string[] = [resolved];
  for (const alias of def.aliasof) {
    if (alias === '_bas') {
      chain.push(...aliasChain(data, baseId, baseId, seen));
    } else {
      chain.push(...aliasChain(data, alias, baseId, seen));
    }
  }
  return chain;
}

function movementChain(data: WesnothData, def: TerrainDef | undefined, baseId: string): string[] {
  if (def?.mvtAlias) {
    const chain: string[] = [];
    for (const alias of def.mvtAlias) {
      // A `-` entry means "no alias for this one", not "no movement at all":
      // `pine_forest` lists `-, _bas, Ft` and still moves as its base and forest.
      if (alias === '-') continue;
      if (alias === '_bas') chain.push(...aliasChain(data, baseId, baseId, new Set()));
      else chain.push(...aliasChain(data, alias, baseId, new Set()));
    }
    return chain;
  }
  if (!def) return [];
  return aliasChain(data, def.id, baseId, new Set());
}

/**
 * The movement type a unit of this type actually moves with: its
 * `[movement_type]` tables with the unit type's own `[movement_costs]`,
 * `[defense]` and `[resistance]` merged over them. The C++ builds this once per
 * unit type (`unit_type::build` inherits the movetype, then
 * `movement_type_.merge(cfg)` with overwrite); this port merges on read so the
 * generated data stays byte-identical and every caller sees the same tables.
 *
 * Values arrive as strings from MWL attributes, so they are parsed to numbers.
 * A movement cost at or above 99 is Wesnoth's `UNREACHABLE`
 * (`src/movetype.hpp:174`); it is stored as Infinity so the existing
 * impassable check in `resolveTerrain` and `reachable` keeps working.
 */
export function effectiveMovetype(data: WesnothData, typeId: string): MovetypeDef | undefined {
  const type = data.unitTypes[typeId];
  const base = data.movetypes[type?.movementType ?? ''];
  if (!type || !base) return base;
  if (!type.movementCosts && !type.defense && !type.resistance) return base;
  const movementCosts: Record<string, number> = { ...base.movementCosts };
  for (const [key, raw] of Object.entries(type.movementCosts ?? {})) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    movementCosts[key] = value >= 99 ? IMPASSABLE : value;
  }
  const defense: Record<string, number> = { ...base.defense };
  for (const [key, raw] of Object.entries(type.defense ?? {})) {
    const value = Number(raw);
    if (Number.isFinite(value)) defense[key] = value;
  }
  const resistance: Record<string, number> = { ...base.resistance };
  for (const [key, raw] of Object.entries(type.resistance ?? {})) {
    const value = Number(raw);
    if (Number.isFinite(value)) resistance[key] = value;
  }
  return { name: base.name, movementCosts, defense, resistance };
}

export function resolveTerrain(
  data: WesnothData,
  movetype: MovetypeDef | undefined,
  code: string,
  movementOverrides?: Record<string, number>,
): ResolvedTerrain {
  const { base, overlay } = splitCode(code);
  const baseId = terrainIdForCode(data, base);
  // Overlay codes are stored with their caret (`^Fp` is the map code of
  // `pine_forest`), so the lookup uses the code exactly as the map writes it.
  const overlayId = overlay ? terrainIdForCode(data, overlay) : null;

  const baseDef = data.terrains[baseId];
  const overlayDef = overlayId ? data.terrains[overlayId] : undefined;

  const baseMove = movementChain(data, baseDef, baseId);
  const overlayMove = overlayDef ? movementChain(data, overlayDef, overlayId ?? baseId) : [];

  /**
   * A hex is its base terrain unless an overlay says otherwise: a forest overlay
   * on grass is forest for both movement and defence, a village overlay is a
   * village, and a bridge over water costs what the bridge costs. So the overlay
   * chain wins whenever it defines the value at all.
   */
  const costOf = (chain: string[]): number | undefined => {
    let cost: number | undefined;
    for (const id of chain) {
      const value = movementOverrides?.[id] ?? movetype?.movementCosts[id];
      if (value !== undefined) cost = cost === undefined ? value : Math.min(cost, value);
    }
    return cost;
  };
  let moveCost = costOf(overlayMove) ?? costOf(baseMove) ?? IMPASSABLE;
  // A unit without a movetype cannot enter anything.
  if (!movetype) moveCost = IMPASSABLE;

  // [defense] values are the chance to be hit; the lowest one is the best for
  // the defender, and a merged base+overlay terrain takes that best value.
  let defense = Number.POSITIVE_INFINITY;
  const considerDefense = (chain: string[]): void => {
    let best = Number.POSITIVE_INFINITY;
    for (const id of chain) {
      const value = movetype?.defense[id];
      if (value !== undefined && value < best) best = value;
    }
    if (best < defense) defense = best;
  };
  if (overlayMove.length) considerDefense(overlayMove);
  else considerDefense(baseMove);
  if (defense === Number.POSITIVE_INFINITY) defense = 0;

  const heals = Math.max(baseDef?.heals ?? 0, overlayDef?.heals ?? 0);
  const isVillage = Boolean(overlayDef?.givesIncome || baseDef?.givesIncome);

  return {
    id: overlayId ?? baseId,
    baseId,
    overlayId,
    moveCost,
    defense,
    heals,
    isVillage,
  };
}
