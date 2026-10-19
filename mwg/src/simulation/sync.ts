import { stateChecksum } from 'mwg/core';
import type { GameState } from './game.ts';
import type { Unit } from './unit.ts';

/** A compact deterministic digest for lockstep out-of-sync diagnostics. */
export function syncStateHash(state: GameState, runtime: string, gold: Readonly<Record<number, number>>, rngState: readonly number[]): string {
  const units = [...state.units]
    .sort((a, b) => a.id - b.id)
    .map((unit: Unit) => [unit.id, unit.typeId, unit.side, unit.x, unit.y, unit.hitpoints, unit.experience, unit.movement, unit.resting, unit.poisoned, unit.slowed, unit.petrified] as const);
  return stateChecksum({
    round: state.round,
    turn: state.turn,
    scheduleIndex: state.scheduleIndex,
    scheduleId: state.scheduleId,
    customSchedules: state.customSchedules,
    fogLifts: state.fogLifts,
    terrainCodes: state.terrainCodes,
    villageOwner: state.villageOwner,
    teams: [...state.teams.entries()].sort(([a], [b]) => a - b),
    units,
    gold,
    rngState,
    runtime,
  }).toString(16).padStart(8, '0');
}
