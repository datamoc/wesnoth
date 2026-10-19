import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNodes, MwlRuntime, type MwlTraceEvent } from 'mwg/mwl';
import { parseWml } from '../src/simulation/wml.ts';
import { createSceneControls } from 'mwg/testing';

const leader = `[game]
schema=0.1
[map]
id=board
terrain=<<
1 Kh,Gg,Gg,Gg
Gg,Gg,Gg,Gg
Gg,Gg,Gg,Gg
Gg,Gg,Gg,Gg
>>
[/map]
[side]
id=1
leader=Konrad
[/side]
[unit]
id=Konrad
type=Fighter
side=1
x=2
y=3
[/unit]
[/game]`;

test('MWG preserves a named leader without creating a phantom type', () => {
  const runtime = new MwlRuntime(compileNodes(parseWml(leader)));
  assert.deepEqual(Object.keys(runtime.world.units), ['Konrad']);
  assert.equal(runtime.world.units.Konrad.type, 'Fighter');
});

test('MWG evaluates unit queries and reports a capped scenario loop', () => {
  const source = leader.replace('[/game]', `[event]
id=loop
on=start
[while]
test="have_unit('id=Konrad') and wml_condition_tree('tree=encoded-tree')"
max_iterations=2
[set_variable]
name=count
value=1
mode=number
[/set_variable]
[/while]
[/event]
[/game]`);
  const trace: MwlTraceEvent[] = [];
  const runtime = new MwlRuntime(compileNodes(parseWml(source)), { onTrace: (event) => trace.push(event), hooks: { predicate: {
    wml_condition_tree: (_world, context) => context.tree === 'encoded-tree',
  } } });
  runtime.run('start');
  assert.equal(Number(runtime.world.variables.count), 1);
  assert.equal(trace.filter((event) => event.type === 'variable').length, 2);
  assert.ok(trace.some((event) => event.type === 'while_limit'));
});

test('MWG accepts the port condition-tree context without a schema extension', () => {
  const source = leader.replace('[/game]', `[event]
id=predicate
on=start
[condition]
condition=hook
hook=predicate:wml_condition_tree
tree=encoded-tree
[/condition]
[set_variable]
name=matched
value=yes
[/set_variable]
[/event]
[/game]`);
  const runtime = new MwlRuntime(compileNodes(parseWml(source)), { hooks: { predicate: {
    wml_condition_tree: (_world, context) => context.tree === 'encoded-tree',
  } } });
  runtime.run('start');
  assert.equal(runtime.world.variables.matched, 'yes');
});

test('named scene controls await the scene flow and reject unknown steps', async () => {
  const controls = createSceneControls();
  let turns = 0;
  controls.register('finishTurn', async () => { turns++; });
  await controls.run('finishTurn');
  assert.equal(turns, 1);
  await assert.rejects(controls.run('unknown'), /unknown/);
});

test('converted compound loops use native predicate expressions and preserve apostrophes', async () => {
  const { loadScenario } = await import('../src/scenarios/campaign-loader.ts');
  const { compile } = await import('mwg/mwl');
  const scenario = parseWml(`[scenario]
id=compound-loop
name=Compound
[event]
name=prestart
[while]
[have_unit]
name="Delfador's apprentice"
[/have_unit]
[do]
[message]
speaker=narrator
message=visited
[/message]
[/do]
[/while]
[/event]
[/scenario]`)[0];
  const converted = loadScenario(scenario, { scenarioId: 'compound-loop', knownUnitTypes: new Set(), mapStarts: {} });
  let calls = 0;
  let messages = 0;
  const runtime = new MwlRuntime(compile(converted.mwl), { onMessage: () => { messages++; }, hooks: { predicate: {
    wml_condition_tree: (_world, context) => {
      const tree = JSON.parse(decodeURIComponent(context.tree));
      assert.equal(tree.attributes.name, "Delfador's apprentice");
      return calls++ === 0;
    },
  } } });
  runtime.run('prestart');
  assert.equal(calls, 2);
  assert.equal(messages, 1);
});
