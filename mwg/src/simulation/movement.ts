/**
 * Movement and zone of control, ported from the route computation in
 * `src/pathfind/pathfind.cpp` and `src/actions/move.cpp` (1.19.27 checkout):
 *
 * - Each step costs the unit type's effective movetype (its movetype merged
 *   with its own `[movement_costs]`, `src/units/types.cpp:298`) for the merged
 *   terrain, doubled when slowed (`src/movetype.hpp:68`).
 * - A unit without skirmisher that starts inside an enemy ZoC cannot move.
 * - Entering an enemy ZoC hex ends the route there (`enemy_zoc`, pathfind.cpp:134).
 * - Entering a village not owned by the mover captures it and consumes all
 *   remaining movement (move.cpp `move_unit`, the `capture` branch).
 * - Friendly units do not block movement; only the destination must be empty.
 * - A mover that first steps next to a hidden enemy loses the rest of its
 *   movement (`abilities.cfg`: discovering a hidden unit stops the discoverer).
 * - A unit with the `teleport` ability may step between its side's empty
 *   villages for 1 movement (`ABILITY_TELEPORT`).
 */

import { hexNeighbors, weightedFlood } from 'mwg';
import {
  enemyZoc,
  areAllied,
  isSkirmisher,
  lawfulBonusAt,
  terrainCodeAt,
  unitAt,
  updateVision,
  villageOwnerAt,
  inside,
  cellIndex,
  type GameState,
} from './game.ts';
import { effectiveMovetype, resolveTerrain } from './terrain.ts';
import { isHidden } from './vision.ts';
import { hasAbility } from './combat.ts';
import { pickupItems } from './objects.ts';
import type { WesnothData } from './types.ts';
import type { Unit } from './unit.ts';

export const key = (x: number, y: number): string => `${x},${y}`;

export function movetypeOf(data: WesnothData, unit: Unit) {
  const base =
    effectiveMovetype(data, unit.typeId) ??
    data.movetypes[data.unitTypes[unit.typeId]?.movementType ?? ''] ??
    Object.values(data.movetypes)[0];
  // `[effect] apply_to=defense` changes the chance to be hit per terrain id
  if (!base || !unit.defenseMods) return base;
  const defense = { ...base.defense };
  for (const [terrain, delta] of Object.entries(unit.defenseMods)) {
    if (defense[terrain] !== undefined) defense[terrain] = Math.max(0, Math.min(100, defense[terrain] + delta));
  }
  return { ...base, defense };
}


/**
 * Options for `reachable`. The AI's threat projection asks what an enemy could
 * reach on its own turn, when it is not the active side and its movement has
 * already been spent, so it needs both overrides.
 */
export interface ReachOptions {
  /** ignore `unit.side === state.turn` (threat maps run for the other side) */
  ignoreTurn?: boolean;
  /** movement budget to use instead of `unit.movement` (`maxMovement` projects a fresh turn) */
  movement?: number;
}

/**
 * Cells this unit may enter this turn, with their lowest movement cost.
 * Matches the route shape described above.
 */
export function reachable(state: GameState, data: WesnothData, unit: Unit, options: ReachOptions = {}): Map<string, number> {
  const result = new Map<string, number>();
  const budget = options.movement ?? unit.movement;
  if (!options.ignoreTurn && unit.side !== state.turn) return result;
  if (budget <= 0) return result;

  const skirmisher = isSkirmisher(state, unit);
  if (!skirmisher && enemyZoc(state, unit.side, unit.x, unit.y)) return result;

  const movetype = movetypeOf(data, unit);
  const start = { x: unit.x, y: unit.y };
  const reached = weightedFlood(start, {
    key: (cell) => key(cell.x, cell.y),
    neighbors: (cell) => hexNeighbors(cell.x, cell.y),
    cost: (_from, next) => {
      if (!inside(state, next.x, next.y)) return Infinity;
      const terrain = resolveTerrain(data, movetype, terrainCodeAt(state, next.x, next.y), unit.movementCostOverrides);
      // A slowed unit pays double (`movetype::terrain_costs::cost`,
      // `src/movetype.hpp:68`), unless the hex is impassable.
      return terrain.moveCost === Infinity ? Infinity : terrain.moveCost * (unit.slowed ? 2 : 1);
    },
    maxCost: budget,
    canEnter: (cell) => {
      const occupant = unitAt(state, cell.x, cell.y);
      return !occupant || occupant.id === unit.id;
    },
    stop: (cell) => {
      if (cell.x === start.x && cell.y === start.y) return false;
      const terrain = resolveTerrain(data, movetype, terrainCodeAt(state, cell.x, cell.y), unit.movementCostOverrides);
      // Capturing a village or entering enemy ZoC ends the route there.
      return (terrain.isVillage && villageOwnerAt(state, cell.x, cell.y) !== unit.side) ||
        (!skirmisher && enemyZoc(state, unit.side, cell.x, cell.y));
    },
  });

  for (const [cellKey, entry] of reached) {
    if (cellKey === key(unit.x, unit.y)) continue;
    const terrain = resolveTerrain(data, movetype, terrainCodeAt(state, entry.cell.x, entry.cell.y), unit.movementCostOverrides);
    // Preserve the port's public meaning: a capture spends all remaining movement.
    result.set(cellKey, terrain.isVillage && villageOwnerAt(state, entry.cell.x, entry.cell.y) !== unit.side ? unit.movement : entry.cost);
  }
  return result;
}

export interface MoveResult {
  ok: boolean;
  cost: number;
  capturedVillage: boolean;
  /** the side that owned the taken village before the move, for `$owner_side` */
  previousOwner?: number | null;
}

/**
 * Villages a teleporting unit may leave from and arrive at: its side's
 * villages (`[tunnel]` source/target with `gives_income=true` and the owner
 * formula in `ABILITY_TELEPORT`). The unit must stand on one of its side's
 * villages; every other empty one owned by the same side is a destination.
 */
export function teleportDestinations(state: GameState, data: WesnothData, unit: Unit): { x: number; y: number }[] {
  if (!hasAbility(data, unit, 'teleport')) return [];
  const code = terrainCodeAt(state, unit.x, unit.y);
  const standing = resolveTerrain(data, movetypeOf(data, unit), code, unit.movementCostOverrides);
  if (!standing.isVillage || villageOwnerAt(state, unit.x, unit.y) !== unit.side) return [];
  const destinations: { x: number; y: number }[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (x === unit.x && y === unit.y) continue;
      const terrain = resolveTerrain(data, movetypeOf(data, unit), terrainCodeAt(state, x, y), unit.movementCostOverrides);
      if (!terrain.isVillage || villageOwnerAt(state, x, y) !== unit.side) continue;
      if (unitAt(state, x, y)) continue;
      destinations.push({ x, y });
    }
  }
  return destinations;
}

/**
 * Step between two of the unit's side's villages for 1 movement point.
 * Wesnoth describes it as "using one of its moves"; charging a single point
 * is the documented simplification (the real tunnel has no per-hex cost at
 * all, but a free full-map move would break the movement economy).
 */
export function teleportUnit(state: GameState, data: WesnothData, unit: Unit, x: number, y: number): MoveResult {
  if (unit.side !== state.turn || unit.movement < 1) return { ok: false, cost: 0, capturedVillage: false };
  if (!teleportDestinations(state, data, unit).some((cell) => cell.x === x && cell.y === y)) {
    return { ok: false, cost: 0, capturedVillage: false };
  }
  unit.x = x;
  unit.y = y;
  unit.movement -= 1;
  unit.resting = false;
  updateVision(state, data);
  return { ok: true, cost: 1, capturedVillage: false };
}

export function moveUnit(state: GameState, data: WesnothData, unit: Unit, x: number, y: number): MoveResult {
  const cost = reachable(state, data, unit).get(key(x, y));
  if (cost === undefined) return { ok: false, cost: 0, capturedVillage: false };

  // Enemies hidden from the mover before this step: stepping next to one of
  // them discovers it and ends the mover's turn.
  const bonus = lawfulBonusAt(data, state, unit.x, unit.y);
  const hiddenBefore = new Set(
    state.units.filter((enemy) => !areAllied(state, enemy.side, unit.side) && isHidden(state, data, enemy, unit.side, bonus)).map((enemy) => enemy.id),
  );

  unit.x = x;
  unit.y = y;
  unit.movement -= cost;
  unit.resting = false;

  let capturedVillage = false;
  // Wesnoth records the previous owner so the `capture` event can read
  // `$owner_side` (`src/team.cpp:424-441`); the port reports it the same way.
  let previousOwner: number | null = null;
  const code = terrainCodeAt(state, x, y);
  const terrain = resolveTerrain(data, movetypeOf(data, unit), code, unit.movementCostOverrides);
  if (terrain.isVillage && villageOwnerAt(state, x, y) !== unit.side) {
    previousOwner = villageOwnerAt(state, x, y);
    state.villageOwner[cellIndex(state, x, y)] = unit.side;
    unit.movement = 0;
    capturedVillage = true;
  } else {
    for (const next of hexNeighbors(x, y)) {
      const discovered = state.units.find((enemy) => enemy.x === next.x && enemy.y === next.y && hiddenBefore.has(enemy.id));
      if (discovered) {
        unit.movement = 0;
        break;
      }
    }
  }
  pickupItems(data, unit, state.items);
  updateVision(state, data);
  if (capturedVillage) return { ok: true, cost, capturedVillage: true, previousOwner };
  return { ok: true, cost, capturedVillage: false };
}
