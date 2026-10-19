import type { ActionJournalEntry } from 'mwg/core';

/** Commands emitted by the Wesnoth rules path and safe to share as JSON. */
export type WesnothAction =
  | { type: 'move'; unitId: number; unitName?: string; from: { x: number; y: number }; to: { x: number; y: number }; side: number; stateHash?: string }
  | { type: 'attack'; attackerId: number; attackerName?: string; defenderId: number; defenderName?: string; attackName: string; side: number; stateHash?: string }
  | { type: 'recruit'; unitId: number; unitName?: string; typeId: string; x: number; y: number; side: number; stateHash?: string }
  | { type: 'end_turn'; side: number; round: number; stateHash?: string };

export interface WesnothEvent {
  type: 'resolved' | 'killed' | 'scenario';
  id?: number;
}

export interface ReplayFile {
  readonly format: 'mwg-wesnoth-replay';
  readonly version: 1;
  readonly scenario: string;
  readonly seed: number;
  readonly actions: readonly ActionJournalEntry<WesnothAction, WesnothEvent>[];
}

/** Build a portable replay document from a scenario's action journal. */
export function createReplay(
  scenario: string,
  seed: number,
  actions: readonly ActionJournalEntry<WesnothAction, WesnothEvent>[],
): ReplayFile {
  if (!scenario || !Number.isSafeInteger(seed) || seed < 0) throw new Error('invalid replay header');
  validateEntries(actions);
  return {
    format: 'mwg-wesnoth-replay',
    version: 1,
    scenario,
    seed,
    actions: structuredClone(actions),
  };
}

/** Serialize a replay using stable indentation for files and diagnostics. */
export function encodeReplay(replay: ReplayFile): string {
  validateReplay(replay);
  return `${JSON.stringify(replay, null, 2)}\n`;
}

/** Parse and validate a replay before it reaches the game engine. */
export function decodeReplay(source: string): ReplayFile {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('replay is not valid JSON'); }
  validateReplay(value);
  return structuredClone(value);
}

/**
 * Deterministically dispatch every command in order.  The callback is the
 * engine adapter: it applies one action and may return the events observed by
 * that engine.  Keeping dispatch separate from Wesnoth's rules lets the same
 * replay file feed the browser scene, a headless verifier, or a future network
 * client without duplicating validation.
 */
export function replayActions(
  replay: ReplayFile,
  apply: (action: WesnothAction, expectedEvents: readonly WesnothEvent[], sequence: number) => void,
): number {
  validateReplay(replay);
  for (const entry of replay.actions) apply(entry.action, entry.events, entry.sequence);
  return replay.actions.length;
}

function validateReplay(value: unknown): asserts value is ReplayFile {
  if (!value || typeof value !== 'object') throw new Error('replay must be an object');
  const replay = value as Partial<ReplayFile>;
  if (replay.format !== 'mwg-wesnoth-replay' || replay.version !== 1) throw new Error('unsupported replay format');
  if (typeof replay.scenario !== 'string' || replay.scenario.length === 0) throw new Error('replay has no scenario');
  if (!Number.isSafeInteger(replay.seed) || (replay.seed as number) < 0) throw new Error('replay has an invalid seed');
  if (!Array.isArray(replay.actions)) throw new Error('replay has no action list');
  validateEntries(replay.actions);
}

function validateEntries(entries: readonly ActionJournalEntry<WesnothAction, WesnothEvent>[]): void {
  let expected = 0;
  for (const entry of entries) {
    if (!entry || entry.sequence !== expected || !Number.isSafeInteger(entry.sequence)) throw new Error('replay action sequences must be contiguous from zero');
    if (!entry.action || !['move', 'attack', 'recruit', 'end_turn'].includes(entry.action.type)) throw new Error('replay contains an unknown action');
    if (!Array.isArray(entry.events)) throw new Error('replay action events must be an array');
    expected += 1;
  }
}
