/**
 * Fog of war and shroud, ported from `src/actions/vision.cpp` and the sight
 * rules behind it (`src/pathfind/pathfind.cpp` vision paths, `src/team.cpp`
 * shroud tracking).
 *
 * The real engine walks a vision path per unit: sight range `vision_` (which
 * defaults to the unit's maximum movement, `src/units/unit.cpp:2190`) over
 * vision costs (which fall back to movement costs when a movetype defines no
 * `vision_costs`, `src/units/types.cpp:888`). Jamming subtracts from sight.
 * This port matches that shape with two documented reductions: vision costs
 * are the unit's effective movement costs (the pipeline keeps no
 * `vision_costs` tables, so there is nothing else to fall back from), and
 * jamming is always zero (no mainline movetype in the pipeline defines
 * `jamming_costs`, and no unit in the default era has a jammer).
 *
 * Shroud (never seen) is stored per team and only ever clears; fog (not
 * visible right now) is recomputed from the units on demand. Sides without an
 * explicit team remain mutually hostile, while allied sides share the same
 * FactionFog key.
 */

import { hexNeighbors, weightedFlood } from 'mwg';
import { unitAbilities } from './specials.ts';
import { effectiveMovetype, resolveTerrain } from './terrain.ts';
import type { WesnothData } from './types.ts';
import type { Unit } from './unit.ts';

export interface VisionState {
  width: number;
  height: number;
  terrainCodes: string[];
  units: Unit[];
  teams?: ReadonlyMap<number, string>;
  /** bumped whenever a cell's terrain changes, so cached sight sets expire */
  terrainVersion?: number;
}

function teamOf(state: VisionState, side: number): string {
  return state.teams?.get(side) ?? String(side);
}

function allied(state: VisionState, first: number, second: number): boolean {
  return teamOf(state, first) === teamOf(state, second);
}

function inside(state: VisionState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function cellIndex(state: VisionState, x: number, y: number): number {
  return y * state.width + x;
}

function terrainCodeAt(state: VisionState, x: number, y: number): string {
  return state.terrainCodes[cellIndex(state, x, y)] ?? 'Gg';
}

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Hexes (as cell indices) one unit can currently see, walked over vision
 * costs. Sight range is the unit's maximum movement (`unit.cpp:2190`); a
 * slowed unit pays double per hex, the same rule movement uses
 * (`src/movetype.hpp:68`). Impassable hexes block sight the way they block
 * movement. Per-side union and explored memory live in the framework's
 * `FactionFog`; this stays the per-unit walk the framework must never learn.
 */
export function visibleHexesForUnit(state: VisionState, data: WesnothData, unit: Unit): Set<number> {
  // A unit's own sight set depends on nothing but the unit and the terrain, so
  // it is cached against a signature of exactly that: the position, the state
  // that could change the walk (slowed, movement range, type) and the terrain's
  // revision. Without this, every combat exchange paid for a fresh flood of
  // every unit on the map (measured: ~1.3ms per unit on a 40x30 field, which
  // the rules loop called after every attack).
  const signature = `${unit.x},${unit.y}|${unit.slowed ? 1 : 0}|${unit.maxMovement}|${unit.typeId}|${state.terrainVersion ?? 0}`;
  const cached = sightCache.get(unit);
  if (cached && cached.signature === signature) return cached.hexes;

  const movetype = effectiveMovetype(data, unit.typeId) ?? data.movetypes[data.unitTypes[unit.typeId]?.movementType ?? ''];
  const range = unit.maxMovement;
  // The flood asks for an edge cost whenever it relaxes a hex, which can happen
  // more than once per hex; resolving the terrain once per cell keeps the walk
  // proportional to the hexes it visits.
  const costs = new Map<number, number>();
  const reached = weightedFlood({ x: unit.x, y: unit.y }, {
    key: (cell) => key(cell.x, cell.y),
    neighbors: (cell) => hexNeighbors(cell.x, cell.y),
    cost: (_from, next) => {
      if (!inside(state, next.x, next.y)) return Infinity;
      const index = cellIndex(state, next.x, next.y);
      const known = costs.get(index);
      if (known !== undefined) return known;
      const terrain = resolveTerrain(data, movetype, terrainCodeAt(state, next.x, next.y));
      const cost = terrain.moveCost === Infinity ? Infinity : terrain.moveCost * (unit.slowed ? 2 : 1);
      costs.set(index, cost);
      return cost;
    },
    maxCost: range,
  });
  const hexes = new Set([...reached.values()].map(({ cell }) => cellIndex(state, cell.x, cell.y)));
  sightCache.set(unit, { signature, hexes });
  return hexes;
}

/** Per-unit sight sets, invalidated by the signature above. */
const sightCache = new WeakMap<Unit, { signature: string; hexes: Set<number> }>();

/** Hexes one side can currently see: the union over its alive units. */
export function visibleHexes(state: VisionState, data: WesnothData, side: number): Set<number> {
  const seen = new Set<number>();
  for (const unit of state.units) {
    if (unit.side !== side || unit.hitpoints <= 0 || unit.petrified) continue;
    for (const index of visibleHexesForUnit(state, data, unit)) seen.add(index);
  }
  return seen;
}

/** The `[hides]` ability ids the real macros define (`abilities.cfg`). */
export type HidesId = 'ambush' | 'concealment' | 'nightstalk' | 'burrow' | 'submerge' | 'swamp_lurk';

function hidesAbilities(data: WesnothData, unit: Unit): string[] {
  const ids = [...(data.unitTypes[unit.typeId]?.abilities ?? []), ...(unit.extraAbilities ?? [])];
  const found: string[] = [];
  for (const definition of unitAbilities(data, ids)) {
    for (const effect of definition.effects) {
      if (effect.tag === 'hides' && effect.attributes.id) found.push(effect.attributes.id);
    }
  }
  return found;
}

/**
 * Whether the unit's own hex and state would hide it, ignoring enemies: the
 * `[filter_location]` terrain of its `[hides]` ability holds. Adjacency
 * always reveals (handled in `isHidden`), and `nightstalk` needs the current
 * lawful bonus, passed in so this module never imports the turn state.
 *
 * Terrain codes are matched the way the macros write them: `*^F*` forest
 * overlays (plus the bluff/glutch `Qhhf`/`Qhuf` variants named in the macro
 * comments), `*^V*` villages, `Wo*` deep water, `S*` swamp, `D*` sand for
 * burrow's dirt. `burrow` additionally requires resting (`self.resting`).
 */
export function hidesOn(
  state: VisionState,
  data: WesnothData,
  unit: Unit,
  lawfulBonus: number,
): HidesId | null {
  const code = terrainCodeAt(state, unit.x, unit.y);
  const caret = code.indexOf('^');
  const overlay = caret === -1 ? '' : code.slice(caret);
  const base = caret === -1 ? code : code.slice(0, caret);
  const resolved = resolveTerrain(
    data,
    effectiveMovetype(data, unit.typeId) ?? data.movetypes[data.unitTypes[unit.typeId]?.movementType ?? ''],
    code,
  );
  for (const id of hidesAbilities(data, unit)) {
    switch (id) {
      case 'ambush':
        if (overlay.startsWith('^F') || overlay.includes('Qhhf') || overlay.includes('Qhuf')) return id;
        break;
      case 'burrow':
        if (!unit.resting) break;
        if (overlay.startsWith('^F') || overlay.includes('Qhhf') || overlay.includes('Qhuf') || base.startsWith('D') || base.startsWith('S')) return id;
        break;
      case 'concealment':
        if (resolved.isVillage) return id;
        break;
      case 'submerge':
        if (base.startsWith('Wo')) return id;
        break;
      case 'swamp_lurk':
        if (base.startsWith('S')) return id;
        break;
      case 'nightstalk':
        if (lawfulBonus < 0) return id;
        break;
      default:
        break;
    }
  }
  return null;
}

/**
 * Whether `viewerSide` cannot see the unit: it is alive, hostile, hidden by
 * its own terrain/state, and no viewer unit stands next to it. Adjacent
 * enemies always see through hiding (`abilities.cfg`: "except if they have
 * units next to it").
 */
export function isHidden(
  state: VisionState,
  data: WesnothData,
  unit: Unit,
  viewerSide: number,
  lawfulBonus: number,
): boolean {
  if (allied(state, unit.side, viewerSide) || unit.hitpoints <= 0 || unit.petrified) return false;
  for (const next of hexNeighbors(unit.x, unit.y)) {
    const watcher = state.units.find((candidate) => candidate.x === next.x && candidate.y === next.y);
    if (watcher && allied(state, watcher.side, viewerSide) && watcher.hitpoints > 0 && !watcher.petrified) return false;
  }
  return hidesOn(state, data, unit, lawfulBonus) !== null;
}

/** Enemy units of `side` that `side` can currently see (hidden ones excluded). */
export function visibleEnemies(
  state: VisionState,
  data: WesnothData,
  side: number,
  lawfulBonus: number,
): Unit[] {
  return state.units.filter((unit) => !allied(state, unit.side, side) && unit.hitpoints > 0 && !isHidden(state, data, unit, side, lawfulBonus));
}
