/**
 * The port's native save format: one versioned payload, plus the migration and
 * validation the scene and the import path share.
 *
 * Wesnoth's own save is a gzipped WML config (`src/savegame.cpp`,
 * `src/save_index.cpp`); the port deliberately does not read it
 * (ROADMAP section 5) and stores its own state instead, because only the port's
 * model can round-trip the port's units, traits and journal. What it keeps is
 * the engine's discipline: a version number, a migration for anything older,
 * and a clear failure for a file that is not this game's save.
 *
 * The payload is the *whole* rule state: the runtime snapshot (which owns the
 * scenario's content variables and MWL once-claims), the seeded RNG state, gold,
 * teams, the units with the id map the rules use, the recall list, the action
 * journal and the achievement counters. Loading it and re-running the journal
 * must reach the same `syncStateHash` (`src/simulation/sync.ts`), which is what
 * `tests/save.test.ts` checks.
 */

import type { ActionJournalEntry } from 'mwg/core';
import type { Carryover } from '../campaign.ts';
import type { Unit } from './unit.ts';
import type { WesnothAction, WesnothEvent } from './replay.ts';
import type { TimeOfDayDef } from './types.ts';

/** The `format` field every exported artifact carries. */
export const SAVE_FORMAT = 'mwg-wesnoth-save';
/** The current payload version; `normalizeSave` migrates older ones forward. */
export const SAVE_VERSION = 3;

/**
 * The rule-engine half of the state: what the simulation owns and the MWL
 * runtime snapshot does not carry. `syncStateHash` covers exactly these fields,
 * so a save that omits one cannot round-trip (which is how the missing turn and
 * village state was found: the round-trip check in `tools/verify-browser.mjs`
 * compares the hash before and after a load).
 */
export interface WesnothRuleState {
  turn: number;
  round: number;
  /** index into the active schedule, i.e. the time of day */
  scheduleIndex: number;
  /** the active schedule's id, when the scenario named one */
  scheduleId?: string;
  /** Runtime schedules installed by `[replace_schedule]`. */
  customSchedules?: Record<string, TimeOfDayDef[]>;
  fogLifts?: Record<string, { x: number; y: number; untilTurn: number }[]>;
  /** village owner per cell (side number or null), row-major */
  villageOwner: (number | null)[];
  /** the map's terrain codes, as `[set_terrain]` may have changed them */
  terrainCodes: string[];
  /** per-faction explored cells, so shroud memory survives a reload */
  explored?: [string, number[]][];
  /** map items not yet picked up */
  itemIds?: string[];
}

export interface WesnothSavePayload {
  version: number;
  scenario: string;
  rngState: [number, number, number, number];
  /** the MWL runtime snapshot: content variables, solved-once events, turn */
  runtime: string;
  gold: Record<number, number>;
  /** Team identities are part of the rules state because they control shared vision and alliances. */
  teams?: [number, string][];
  units: [string, Unit][];
  recallList: Carryover['units'];
  /** Ordered, deterministic commands used by replay/undo tooling. */
  journal: ActionJournalEntry<WesnothAction, WesnothEvent>[];
  achievements?: { counts: [string, number][] };
  /** The seed of the scenario's generator, so an export can be replayed from scratch. */
  seed?: number;
  /**
   * The rule-engine state (version 3+). A version 2 save has none, and restores
   * with the scenario's opening turn, villages and shroud: the migration is
   * honest about what it could not know.
   */
  rules?: WesnothRuleState;
}

/** A save the port can load: the payload plus what the file itself declared. */
export interface NormalizedSave {
  payload: WesnothSavePayload;
  /** the version the file was written with, before migration */
  sourceVersion: number;
  /** values the migration filled in, for a log line or a test assertion */
  migrated: string[];
}

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate whatever `SaveSystem` handed back (or whatever an imported file
 * contained) and bring it to the current version.
 *
 * `knownScenario` is the caller's registry lookup: a save naming a scenario this
 * build does not ship cannot be played, and saying so is friendlier than a
 * stack trace from the middle of the scene.
 */
export function normalizeSave(raw: unknown, knownScenario?: (id: string) => boolean): NormalizedSave {
  if (!isRecord(raw)) throw new SaveError('save is not an object');
  const sourceVersion = Number(raw.version ?? 0);
  if (!Number.isFinite(sourceVersion) || sourceVersion < 1) throw new SaveError('save has no version');
  if (sourceVersion > SAVE_VERSION) {
    throw new SaveError(`save was written by a newer build (version ${sourceVersion}, this build reads ${SAVE_VERSION})`);
  }
  const migrated: string[] = [];
  const payload = { ...raw } as unknown as WesnothSavePayload;
  const scenario = raw.scenario;
  if (typeof scenario !== 'string' || !scenario) throw new SaveError('save names no scenario');
  if (knownScenario && !knownScenario(scenario)) throw new SaveError(`save names an unknown scenario "${scenario}"`);
  if (typeof raw.runtime !== 'string' || !raw.runtime) throw new SaveError('save has no runtime state');
  if (!Array.isArray(raw.units)) throw new SaveError('save has no units');
  if (!Array.isArray(raw.journal)) throw new SaveError('save has no journal');
  if (!isRecord(raw.gold)) throw new SaveError('save has no gold');

  // Version 1 stored units but no seed and no team list; a scenario the port
  // only ever runs with one team can reconstruct both.
  if (sourceVersion < 2) {
    if (payload.seed === undefined) {
      payload.seed = 0;
      migrated.push('seed');
    }
    if (payload.teams === undefined) {
      payload.teams = [];
      migrated.push('teams');
    }
  }
  if (!Array.isArray(payload.recallList)) {
    payload.recallList = [];
    migrated.push('recallList');
  }
  return { payload: { ...payload, version: SAVE_VERSION }, sourceVersion, migrated };
}

/**
 * The portable export an import path can read back: the payload plus the
 * format tag, so a foreign JSON file fails with "not a Wesnoth save" rather
 * than with a missing field.
 */
export function encodeSaveExport(payload: WesnothSavePayload): string {
  return `${JSON.stringify({ format: SAVE_FORMAT, ...payload, version: SAVE_VERSION }, null, '\t')}\n`;
}

export function decodeSaveExport(source: string, knownScenario?: (id: string) => boolean): NormalizedSave {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new SaveError('file is not JSON');
  }
  if (!isRecord(parsed)) throw new SaveError('file is not a save object');
  if (parsed.format !== SAVE_FORMAT) throw new SaveError(`file is not a ${SAVE_FORMAT} artifact`);
  return normalizeSave(parsed, knownScenario);
}

/** The file name a downloaded export should carry. */
export function saveFileName(scenario: string, slot?: string): string {
  const stem = slot ? `${scenario}-${slot}` : scenario;
  return `${stem.replace(/[^A-Za-z0-9_.-]/g, '_')}-save.json`;
}
