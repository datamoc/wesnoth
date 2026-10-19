import assert from 'node:assert/strict';
import test from 'node:test';
import { MwlRuntime, compile, type MwlHookRegistry } from 'mwg/mwl';
import { classifyEventName } from '../src/scenarios/campaign-loader.ts';
import { lifecycleEvents, turnContextVariables } from '../src/simulation/event-lifecycle.ts';
import { scenarioSchema } from '../src/scenarios/scenario-schema.ts';

/**
 * The scenario life cycle (ROADMAP backlog: "Scenario lifecycle and event
 * ordering audit").
 *
 * The engine fires a fixed, ordered set of named events, and mainline content
 * hooks onto the names (`prestart` for setup, `turn 5` for reinforcements,
 * `side_turn_end` for cleanup). Two properties matter and are locked here:
 *
 * 1. Every WML spelling classifies to the canonical trigger with the turn/side
 *    conditions the scene satisfies (`classifyEventName`).
 * 2. Those conditions are read against variables the scene actually publishes,
 *    so a `turn 2` event fires on turn 2 and not on every turn. Before this
 *    test existed, `turn_side`/`turn_number` were emitted into 1,419 compiled
 *    conditions and never written, which silently disabled every scripted turn
 *    event in all 20 campaigns.
 */

test('every WML turn and side event name classifies to a canonical trigger', () => {
  const cases: [string, string, Record<string, string>][] = [
    // [WML name, trigger, conditions]
    ['side 2 turn', 'turn', { turn_side: '2' }],
    ['side turn', 'turn', {}],
    ['side turn 3', 'turn', { turn_number: '3' }],
    ['side 2 turn 3', 'turn', { turn_side: '2', turn_number: '3' }],
    ['turn 5', 'turn', { turn_number: '5' }],
    ['new turn', 'new_turn', {}],
    ['turn refresh', 'turn_refresh', {}],
    ['side 1 turn refresh', 'turn_refresh', { turn_side: '1' }],
    ['turn 4 refresh', 'turn_refresh', { turn_number: '4' }],
    ['side 1 turn 4 refresh', 'turn_refresh', { turn_side: '1', turn_number: '4' }],
    ['turn end', 'turn_end', {}],
    ['turn 7 end', 'turn_end', { turn_number: '7' }],
    ['side turn end', 'side_turn_end', {}],
    ['side 2 turn end', 'side_turn_end', { turn_side: '2' }],
    ['side 2 turn 7 end', 'side_turn_end', { turn_side: '2', turn_number: '7' }],
    ['side $lisar_side turn 4 end', 'side_turn_end', { turn_side: '$lisar_side', turn_number: '4' }],
    ['turn $($turn_number + 8)', 'turn', { turn_number: '$($turn_number + 8)' }],
    ['turn_$ambush_turn', 'turn', { turn_number: '$ambush_turn' }],
    ['prestart', 'prestart', {}],
    ['start', 'start', {}],
    ['unit placed', 'unit_placed', {}],
    ['last breath', 'last_breath', {}],
    ['pre advance', 'pre_advance', {}],
    ['post advance', 'post_advance', {}],
    ['enemies defeated', 'enemies_defeated', {}],
    ['time over', 'time_over', {}],
    ['prerecruit', 'prerecruit', {}],
    ['recall', 'recall', {}],
    ['capture', 'capture', {}],
    ['enter hex', 'moveto', {}],
    ['moveto', 'moveto', {}],
    ['my custom event', 'my_custom_event', {}],
  ];
  for (const [name, trigger, conditions] of cases) {
    const classified = classifyEventName(name);
    assert.equal(classified.trigger, trigger, `${name} -> trigger`);
    assert.deepEqual(
      Object.fromEntries(classified.conditions.map((entry) => [entry.variable, entry.equals])),
      conditions,
      `${name} -> conditions`,
    );
  }
});

test('the life cycle fires in the engine order', () => {
  // src/play_controller.cpp:380-425, :505-560, :620-645.
  assert.deepEqual([...lifecycleEvents('scenarioStart')], ['preload']);
  assert.deepEqual([...lifecycleEvents('prestart')], ['prestart', 'start']);
  assert.deepEqual([...lifecycleEvents('turnStart', { opensTurn: true })], ['turn', 'new_turn']);
  assert.deepEqual([...lifecycleEvents('turnStart', { opensTurn: false })], ['turn']);
  assert.deepEqual([...lifecycleEvents('turnRefresh')], ['turn_refresh']);
  assert.deepEqual([...lifecycleEvents('sideTurnEnd')], ['side_turn_end']);
  assert.deepEqual([...lifecycleEvents('turnEnd')], ['turn_end']);
});

/** A registry whose only job is to record the events that ran, in order. */
function recordingHooks(fired: string[]): MwlHookRegistry {
  return {
    // The registry is keyed by the full `type:name`, the same string `[hook] name=` carries.
    command: {
      'command:record': (_world, _emit, context) => {
        fired.push(context.id ?? '');
      },
    },
  };
}

const SCENARIO = `[
  {
    tag: "game",
    schema: 0.1,
    children: [
      {
        tag: "event",
        id: "prestart_setup",
        once: true,
        on: "prestart",
        children: [
          { tag: "hook", name: "command:record", id: "prestart_setup" },
        ],
      },
      {
        tag: "event",
        id: "start_only",
        once: true,
        on: "start",
        children: [
          { tag: "hook", name: "command:record", id: "start_only" },
        ],
      },
      {
        tag: "event",
        id: "turn_two",
        on: "turn",
        once: false,
        children: [
          { tag: "condition", variable: "turn_number", equals: 2 },
          { tag: "hook", name: "command:record", id: "turn_two" },
        ],
      },
      {
        tag: "event",
        id: "side_two_turn",
        on: "turn",
        once: false,
        children: [
          { tag: "condition", variable: "turn_side", equals: 2 },
          { tag: "hook", name: "command:record", id: "side_two_turn" },
        ],
      },
      {
        tag: "event",
        id: "refresh",
        on: "turn_refresh",
        once: false,
        children: [
          { tag: "hook", name: "command:record", id: "refresh" },
        ],
      },
      {
        tag: "event",
        id: "side_one_end",
        on: "side_turn_end",
        once: false,
        children: [
          { tag: "condition", variable: "turn_side", equals: 1 },
          { tag: "hook", name: "command:record", id: "side_one_end" },
        ],
      },
      {
        tag: "event",
        id: "round_end",
        on: "turn_end",
        once: false,
        children: [
          { tag: "hook", name: "command:record", id: "round_end" },
        ],
      },
      {
        tag: "event",
        id: "only_once",
        once: true,
        on: "start",
        children: [
          { tag: "hook", name: "command:record", id: "only_once" },
        ],
      },
    ],
  },
]
`;

/**
 * A minimal stand-in for `WesnothScene`'s turn loop: the same phases, in the
 * same order, with the same context variables.
 */
function drive(): string[] {
  const fired: string[] = [];
  const runtime = new MwlRuntime(compile(SCENARIO, { file: 'lifecycle.mwl', schemas: scenarioSchema }), {
    hooks: recordingHooks(fired),
  });
  const publish = (turn: number, side: number): void => {
    Object.assign(runtime.world.variables, turnContextVariables({ turn, side }));
    runtime.world.turn = turn;
  };

  const enterSideTurn = (turn: number, side: number, opensTurn: boolean): void => {
    publish(turn, side);
    for (const name of lifecycleEvents('turnStart', { opensTurn })) runtime.run(name);
    for (const name of lifecycleEvents('turnRefresh')) runtime.run(name);
  };

  for (const name of lifecycleEvents('scenarioStart')) runtime.run(name);
  for (const name of lifecycleEvents('prestart')) runtime.run(name);
  enterSideTurn(1, 1, true);

  // Round 1: side 1 ends, side 2 plays and ends, round 2 opens.
  publish(1, 1);
  runtime.run('side_turn_end');
  enterSideTurn(1, 2, false);
  publish(1, 2);
  runtime.run('side_turn_end');
  runtime.run('turn_end');
  enterSideTurn(2, 1, true);
  return fired;
}

test('turn and side conditions select the events the scene fires', () => {
  assert.deepEqual(drive(), [
    'prestart_setup',
    'start_only',
    'only_once',
    // side 1's turn 1, which is also where it ends
    'refresh',
    'side_one_end',
    // side 2's turn 1
    'side_two_turn',
    'refresh',
    // the round rolls over into turn 2, side 1
    'round_end',
    'turn_two',
    'refresh',
  ]);
});

test('a turn event only fires on its own turn, and once flags hold', () => {
  const fired = drive();
  // `turn_two` is the only turn-conditional event above, and it ran exactly
  // once, on turn 2, after the round's `turn_end`.
  assert.equal(fired.filter((id) => id === 'turn_two').length, 1);
  assert.ok(fired.indexOf('turn_two') > fired.indexOf('round_end'));
  // The once flag is per event: a second `start` run on a fresh runtime is a
  // no-op, which is what keeps `prestart` setup from running twice.
  const second: string[] = [];
  const runtime = new MwlRuntime(compile(SCENARIO, { file: 'lifecycle.mwl', schemas: scenarioSchema }), {
    hooks: recordingHooks(second),
  });
  runtime.run('start');
  runtime.run('start');
  assert.deepEqual(second, ['start_only', 'only_once']);
});
