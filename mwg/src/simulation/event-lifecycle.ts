/**
 * Wesnoth's event life cycle, as data.
 *
 * The engine fires a fixed sequence of named events around every life-cycle
 * step, and content hooks onto those names. The port keeps the same names, in
 * the same order, with the same context variables, so a scenario's
 * `[event] name=...` behaves the way it does in the original. Ported from the
 * 1.19.27 checkout:
 *
 * - `src/play_controller.cpp:380-425` the opening: `preload`, then one
 *   `unit_placed` per unit a side starts with, then `prestart`, then `start`.
 * - `src/play_controller.cpp:505-560` the start of a side turn: `turn_N` and
 *   `new_turn` (only when the turn is new), then `side_turn`,
 *   `side_N_turn`, `side_turn_N`, `side_N_turn_N`, then (after income and
 *   healing) `turn_refresh`, `side_N_turn_refresh`, `turn_N_refresh`,
 *   `side_N_turn_N_refresh`.
 * - `src/play_controller.cpp:620-645` the end of a side turn:
 *   `side_turn_end`, `side_N_turn_end`, `side_turn_N_end`,
 *   `side_N_turn_N_end`; when the round is over, `turn_end` and `turn_N_end`.
 * - `src/actions/move.cpp:1221-1232` a move: `capture` (with `$owner_side`)
 *   before `moveto`.
 * - `src/actions/create.cpp:655-712` a recruit or recall: `unit_placed`,
 *   `prerecruit`/`prerecall`, the village capture, `recruit`/`recall`, then
 *   the `sighted` events.
 * - `src/actions/attack.cpp:1084-1212` a fight: `petrified`, `last_breath`,
 *   `die`, then a plague spawn's `unit_placed`.
 * - `src/actions/advancement.cpp:284-405` a level-up: `pre_advance`, `advance`,
 *   `post_advance`, then the `sighted` events.
 * - `src/play_controller.cpp:1014`, `:1299` `enemies_defeated` and `time_over`.
 *
 * The turn and side variants (`side 2 turn`, `turn 5 end`) are the same
 * triggers: the loader folds their numbers into `[condition]` tests on the
 * context variables below, which the scene publishes before each run. A trigger
 * the sequence does not name is still legal content (`[fire_event]` targets a
 * scenario's own ids), so this table is the port's vocabulary, not a whitelist
 * of what content may declare.
 */

/** Custom trigger names a scenario can fire by id, plus the life-cycle ones. */
export const LIFECYCLE_TRIGGERS = [
  'preload',
  'unit_placed',
  'prestart',
  'start',
  'turn',
  'new_turn',
  'turn_refresh',
  'side_turn_end',
  'turn_end',
  'moveto',
  'capture',
  'sighted',
  'attack',
  'petrified',
  'last_breath',
  'die',
  'prerecruit',
  'recruit',
  'prerecall',
  'recall',
  'pre_advance',
  'advance',
  'post_advance',
  'enemies_defeated',
  'time_over',
  'ai_turn',
  'select',
  'scenario_end',
] as const;

export type LifecycleTrigger = (typeof LIFECYCLE_TRIGGERS)[number];

/** The stages of a scenario's life the scene walks in order. */
export type LifecyclePhase =
  | 'scenarioStart'
  | 'prestart'
  | 'turnStart'
  | 'turnRefresh'
  | 'sideTurnEnd'
  | 'turnEnd';

/** The turn a side is starting, which `[condition]` children are read against. */
export interface TurnContext {
  /** Wesnoth's `turn_number`: 1 on the first round (C++ `turn()`) */
  turn: number;
  /** Wesnoth's `side_number`: the side whose turn is starting */
  side: number;
}

/**
 * The variables the scene publishes before it fires a life-cycle trigger. The
 * loader's conditions and scenario content both read them, exactly as the
 * engine's `game_data` variables do (`src/game_data.hpp`).
 */
export function turnContextVariables(context: TurnContext): Record<string, string> {
  return {
    turn_number: String(context.turn),
    turn_side: String(context.side),
    side_number: String(context.side),
  };
}

/**
 * The events one phase fires, in order.
 *
 * `unit_placed` is not in this table: it runs once per unit, so the scene calls
 * it in a loop with that unit as the trigger context. `new_turn` is dropped
 * when a phase is not opening a turn, because the engine only fires it on the
 * first side of a round (`src/play_controller.cpp:509-512`).
 */
export function lifecycleEvents(phase: LifecyclePhase, options: { opensTurn?: boolean } = {}): readonly LifecycleTrigger[] {
  switch (phase) {
    case 'scenarioStart':
      return ['preload'];
    case 'prestart':
      return ['prestart', 'start'];
    case 'turnStart':
      return options.opensTurn === false ? ['turn'] : ['turn', 'new_turn'];
    case 'turnRefresh':
      return ['turn_refresh'];
    case 'sideTurnEnd':
      return ['side_turn_end'];
    case 'turnEnd':
      return ['turn_end'];
  }
}
