import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MwlRuntime, compile, type MwlRuntimeOptions } from 'mwg/mwl';
import { MULTIPLAYER_SCENARIO_ORDER, SCENARIO_COMPATIBILITY, SCENARIOS } from '../src/generated/scenarios.ts';

/**
 * The port's scenarios are MWL documents in `src/scenarios/`; the build tool
 * embeds each scenario's real map rows, and `MwlRuntime` loads them. These tests
 * compile the sources the same way and check the setup, messages, and objectives
 * the browser scene uses.
 */
const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wesnothRoot = path.resolve(mwgDir, '..');

function loadScenario(name: string, options: Partial<MwlRuntimeOptions> = {}): MwlRuntime {
  const source = readFileSync(path.join(mwgDir, 'src', 'scenarios', `${name}.mwl`), 'utf8');
  const game = compile(source, { file: `scenarios/${name}.mwl` });
  return new MwlRuntime(game, {
    resolveMap: (file) => readFileSync(path.join(wesnothRoot, 'data', file), 'utf8'),
    ...options,
  });
}

test('the freelands scenario loads the map, sides, and starting units', () => {
  const runtime = loadScenario('freelands');

  assert.equal(runtime.world.map?.width, 39);
  assert.equal(runtime.world.map?.height, 26);
  assert.deepEqual(runtime.world.map?.starts, {
    1: [{ x: 19, y: 4 }],
    2: [{ x: 19, y: 21 }],
  });

  assert.deepEqual(Object.keys(runtime.world.sides).sort(), ['1', '2']);
  assert.equal(runtime.world.sides['1'].gold, 75);
  assert.equal(runtime.world.sides['1'].recruit, 'Spearman,Bowman,Cavalryman');
  assert.equal(runtime.world.sides['2'].recruit, 'Orcish Grunt,Orcish Archer,Wolf Rider');

  const units = Object.entries(runtime.world.units).map(([id, unit]) => ({ id, ...unit }));
  assert.deepEqual(
    units.map((unit) => `${unit.id}:${unit.type}@${unit.x},${unit.y}`),
    [
      'unit-1-spearman:Spearman@20,4',
      'unit-1-bowman:Bowman@18,4',
      'unit-1-cavalryman:Cavalryman@19,5',
      'unit-2-grunt:Orcish Grunt@20,21',
      'unit-2-archer:Orcish Archer@19,20',
      'unit-2-wolf-rider:Wolf Rider@18,21',
    ],
  );
});

test('generated scenarios publish WML compatibility diagnostics', () => {
  for (const name of ['two-brothers-01', 'two-brothers-02', 'two-brothers-03', 'two-brothers-04', 'two-brothers-05']) {
    const report = SCENARIO_COMPATIBILITY[name as keyof typeof SCENARIO_COMPATIBILITY];
    assert.ok(report, `${name} has no compatibility report`);
    assert.ok(report.skipped >= report.warnings + report.blocking);
    assert.ok(Array.isArray(report.details));
  }
});

test('the standard multiplayer map pool is generated and has embedded maps', () => {
  assert.equal(MULTIPLAYER_SCENARIO_ORDER.length, 62);
  for (const name of MULTIPLAYER_SCENARIO_ORDER) {
    const game = SCENARIOS[name];
    assert.ok(game, `${name} is missing from the generated registry`);
    const map = game.roots.flatMap((root) => [root, ...root.children]).find((node) => node.tag === 'map');
    // Four official random-map entries intentionally generate a map at game
    // setup rather than shipping a fixed terrain file.
    if (!name.startsWith('mp-random-map')) assert.ok(map?.attributes.terrain, `${name} has no embedded map terrain`);
  }
});

test('the freelands scenario starts with its message and playing objectives', () => {
  const messages: string[] = [];
  const runtime = loadScenario('freelands', {
    onMessage: (message) => messages.push(message.text),
    // The village objective is an engine predicate; this test only checks that
    // it does not fire here. `engine-hooks.test.ts` exercises it for real.
    hooks: { predicate: { 'predicate:side_owns_villages': () => false } },
  });

  runtime.run('start');
  assert.deepEqual(messages, ['The Freelands: destroy the enemy force, or lose your own.']);
  assert.equal(runtime.evaluate(), 'playing');

  for (const unit of Object.values(runtime.world.units)) if (unit.side === '2') unit.alive = false;
  assert.equal(runtime.evaluate(), 'won');
});

test('the courier scenario is a scripted objective run', () => {
  const messages: string[] = [];
  const runtime = loadScenario('courier', { onMessage: (message) => messages.push(message.text) });

  assert.equal(runtime.world.map?.width, 22);
  assert.equal(runtime.world.map?.height, 14);
  // The messenger's purse: what the campaign carries into the next scenario.
  assert.equal(runtime.world.sides['1'].gold, 20);

  const courier = Object.entries(runtime.world.units).find(([, unit]) => unit.type === 'Elvish Scout');
  assert.ok(courier, 'the messenger exists');
  const [, messenger] = courier;
  assert.deepEqual({ x: messenger.x, y: messenger.y, side: messenger.side }, { x: 20, y: 6, side: '1' });
  assert.equal(Object.values(runtime.world.units).filter((unit) => unit.side === '2').length, 3, 'three orc guards');

  runtime.run('start');
  assert.deepEqual(messages, ['Carry the dispatch to the elven village before the orcs close the road.']);
  assert.equal(runtime.evaluate(), 'playing');

  // Stepping onto the picket hex triggers the dialogue, once.
  messenger.x = 13;
  messenger.y = 5;
  runtime.fireMoveto(courier[0]);
  assert.deepEqual(messages.slice(1), ['Halt. The road to the village is closed.', 'Then I will take the long way round.']);
  runtime.fireMoveto(courier[0]);
  assert.equal(messages.length, 3, 'the picket beat does not repeat');

  // The delivery beat fires on the same arrival that wins the scenario.
  messenger.x = 10;
  messenger.y = 3;
  runtime.fireMoveto(courier[0]);
  assert.equal(messages.at(-1), 'The dispatch is delivered. The village is warned.');
  assert.equal(runtime.evaluate(), 'won');

  // Running out of turns loses.
  const late = loadScenario('courier');
  late.world.turn = 4;
  assert.equal(late.evaluate(), 'lost');

  // Losing the messenger loses.
  const dead = loadScenario('courier');
  dead.world.units[courier[0]].alive = false;
  assert.equal(dead.evaluate(), 'lost');
});
