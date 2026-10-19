/**
 * The Two Brothers loader, run against the real campaign files.
 *
 * Each scenario preprocesses with NORMAL difficulty (no defines, exactly like
 * the engine's default), converts to MWL, and must compile under the
 * framework schema. Skipped tags are only allowed when a documented pattern
 * names them; every pattern must still occur, so the allowlist cannot rot.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from 'mwg/mwl';
import { parseTerrain } from 'mwg/mwl';
import { loadScenario, type LoaderContext } from '../src/scenarios/campaign-loader.ts';
import { scenarioSchema } from '../src/scenarios/scenario-schema.ts';
import { parseWml, WmlPreprocessor } from '../src/simulation/wml.ts';
import { GAME_DATA } from '../src/generated/game-data.ts';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');
const campaignDir = path.join(dataDir, 'campaigns', 'Two_Brothers');
const scenarioDir = path.join(campaignDir, 'scenarios');

const KNOWN = new Set(Object.keys(GAME_DATA.unitTypes));

function loadMacros(into: WmlPreprocessor): void {
  const coreMacros = path.join(dataDir, 'core', 'macros');
  into.loadMacros(readdirSync(coreMacros).filter((name) => name.endsWith('.cfg')).map((name) => path.join(coreMacros, name)));
  const utils = path.join(campaignDir, 'utils');
  into.loadMacros(readdirSync(utils).filter((name) => name.endsWith('.cfg')).map((name) => path.join(utils, name)));
}

function loadFile(name: string) {
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  loadMacros(wml);
  const file = path.join(scenarioDir, name);
  const nodes = parseWml(wml.preprocessFile(file), file);
  const scenario = nodes.find((node) => node.tag === 'scenario');
  assert.ok(scenario, `${name} has a [scenario]`);
  return scenario!;
}

function contextFor(scenarioId: string, mapRel: string | null): LoaderContext {
  let mapStarts: Record<number, { x: number; y: number }[]> = {};
  if (mapRel) {
    // A bare filename resolves against the campaign's maps directory.
    const mapPath = mapRel.includes('/') ? path.join(dataDir, mapRel) : path.join(campaignDir, 'maps', mapRel);
    const parsed = parseTerrain(readFileSync(mapPath, 'utf8'));
    mapStarts = parsed.starts as Record<number, { x: number; y: number }[]>;
  }
  return { scenarioId, knownUnitTypes: KNOWN, mapStarts };
}

/** Skips the loader is allowed to report, each kept honest below. */
const ALLOWED_SKIPS: RegExp[] = [
  /\[ai\]/,
  // `[sound]` and `[music]` are ported now (they compile to the audio hooks),
  // so they are deliberately absent from this list: a new one would be a
  // regression, not an accepted skip.
  // `[move_unit_fake]` and `[cancel_action]` are transient UI/controller
  // operations and are intentionally ignored by the loader.
  // `[role] ... [auto_recall]` is visible now that `parseWml` splits the
  // one-line `[auto_recall][/auto_recall]`; auto-recall itself is not ported.
  /\[role\] auto_recall/,
];

const allSkipped: { id: string; entry: string }[] = [];

function checkSkips(id: string, skipped: string[]): void {
  for (const entry of skipped) {
    const index = ALLOWED_SKIPS.findIndex((pattern) => pattern.test(entry));
    assert.ok(index >= 0, `${id}: unexpected skip: ${entry}`);
    allSkipped.push({ id, entry });
  }
}

const FILES = ['01_Rooting_Out_a_Mage.cfg', '02_The_Chase.cfg', '03_Guarded_Castle.cfg', '04_Return_to_the_Village.cfg'];

for (const file of FILES) {
  test(`loader converts ${file} to compiling MWL`, () => {
    const scenario = loadFile(file);
    const mapFile = scenario.attributes.map_file ?? null;
    const context = contextFor(scenario.attributes.id ?? file, mapFile);
    const result = loadScenario(scenario, context);
    assert.ok(result.meta.turns > 0, 'a turn limit');
    assert.ok(result.mwl.includes('tag: "side"'), 'sides');
    assert.ok(result.mwl.includes('tag: "unit"'), 'placements');
    assert.ok(result.mwl.includes('tag: "objectives"'), 'objectives');
    // Compile under the same schema the pipeline uses, where a filter's x/y may be a range.
    const game = compile(result.mwl, { file: `campaign/${file}.mwl`, schemas: scenarioSchema });
    assert.ok(game.roots.some((node) => node.tag === 'game'));
    checkSkips(result.meta.id, result.report.skipped);
    assert.equal(result.report.diagnostics.length, result.report.skipped.length);
  });
}

test('every skip pattern still occurs somewhere, so the allowlist cannot rot', () => {
  for (const pattern of ALLOWED_SKIPS) {
    assert.ok(
      allSkipped.some(({ entry }) => pattern.test(entry)),
      `allowlist pattern never fires: ${pattern}`,
    );
  }
});

test('tb01 names Mordak, Arvith and the turn beats', () => {
  const scenario = loadFile('01_Rooting_Out_a_Mage.cfg');
  const result = loadScenario(scenario, contextFor('01_Rooting_Out_a_Mage', scenario.attributes.map_file));
  assert.ok(result.mwl.includes('Mordak'), 'the mage is placed and named');
  assert.match(result.mwl, /id: "Baran"[\s\S]*type: "Red Mage"/, 'RECALL_ELSE restores Baran when the recall list is empty');
  assert.ok(result.mwl.includes('turn_number'), 'turn events gate on the round');
  assert.ok(result.mwl.includes('last_dead_id'), 'die filters read the kill context');
  assert.ok(result.meta.carryoverPercent > 0, 'carryover rules recorded');
  assert.match(result.mwl, /name: "carryover_percentage"[\s\S]*value: \d+/);
  assert.ok(result.report.diagnostics.length > 0, 'compatibility diagnostics are exposed');
});

test('endlevel branches preserve the selected campaign scenario', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=04_Choice_in_the_Fog\nname=Choice\nturns=4\n` +
    `[map]\nid=choice\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=die\n[endlevel]\nresult=victory\nnext_scenario=05c_Into_the_Depths\n[/endlevel]\n[/event]\n` +
    `[/scenario]`, 'choice.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, {
    scenarioId: '04_Choice_in_the_Fog',
    scenarioPrefix: 'the-south-guard',
    knownUnitTypes: KNOWN,
    mapStarts: {},
  });
  assert.match(result.mwl, /name: "__next_scenario"[\s\S]*value: "the-south-guard-05c"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'choice.mwl' }));
});

test('loader maps WML while/foreach/switch control flow to MWL', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=flow\nname=Flow\nturns=4\n` +
    `[map]\nid=flow\nterrain="Gg, Gg\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=prestart\n` +
    `[set_variable]\nname=counter\nvalue=0\n[/set_variable]\n` +
    `[while]\n[variable]\nname=counter\nless_than=2\n[/variable]\n[do]\n` +
    `[set_variable]\nname=counter\nadd=1\n[/set_variable]\n` +
    `[/do]\n[/while]\n` +
    `[foreach]\narray=counter\nvariable=value\n[do]\n` +
    `[switch]\nvariable=value\n[case]\nvalue=2\n[set_variable]\nname=matched\nvalue=yes\n[/set_variable]\n[/case]\n[/switch]\n` +
    `[/do]\n[/foreach]\n` +
    `[/event]\n[/scenario]`, 'flow.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'flow', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /tag: "while"/);
  assert.match(result.mwl, /tag: "foreach"/);
  assert.match(result.mwl, /tag: "switch"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'flow.mwl' }));
});

test('loader routes event unit filters through the filter algebra', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=filters\nname=Filters\nturns=2\n` +
    `[map]\nid=filters\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=moveto\n[filter]\nnot_type=Wolf\n[/filter]\n[/event]\n` +
    `[event]\nname=attack\n[filter]\nnot_type=Orcish Grunt\n[and]\nlevel=0-2\n[/and]\n[/filter]\n[/event]\n` +
    `[event]\nname=turn 3\n[filter]\ntype=Spearman\n[or]\ntype=Orcish Grunt\n[/or]\n[/filter]\n[/event]\n` +
    `[/scenario]`, 'filters.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'filters', knownUnitTypes: KNOWN, mapStarts: {} });
  // A moveto filter tests the unit that moved; a subjectless trigger asks
  // whether some live unit matches; a subject filter reads the trigger context.
  assert.match(result.mwl, /unit: "\$unit_moved_id"/);
  assert.match(result.mwl, /any: "yes"/);
  assert.match(result.mwl, /unit: "\$last_attacker_id"/);
  // The encoded body carries the real filter, `[and]` and `[or]` included.
  const decoded = [...result.mwl.matchAll(/filter: "(%[^"]+)"/g)].map((match) => JSON.parse(decodeURIComponent(match[1])) as { attributes: Record<string, string>; children: { tag: string }[] });
  assert.ok(decoded.some((node) => node.attributes.not_type === 'Wolf'));
  assert.ok(decoded.some((node) => node.attributes.not_type === 'Orcish Grunt' && node.children.some((child) => child.tag === 'and')));
  assert.ok(decoded.some((node) => node.children.some((child) => child.tag === 'or')));
  assert.doesNotThrow(() => compile(result.mwl, { file: 'filters.mwl' }));
});

test('loader routes event filter_formula through the formula predicate hook', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=formula-filter\nname=Formula\nturns=2\n` +
    `[map]\nid=formula-filter\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=turn\nfilter_formula="turn_number = side_number"\n[/event]\n` +
    `[/scenario]`, 'formula-filter.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'formula-filter', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /tag: "predicate",\n\s*name: "wml_formula"/);
  assert.match(result.mwl, /formula: "turn_number = side_number"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'formula-filter.mwl' }));
});

test('loader keeps story-part music alongside the narrator page', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=story-music\nname=Story\nturns=2\n` +
    `[map]\nid=story-music\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[story]\n[part]\nstory=The road begins.\nbackground=story/test.webp\nmusic=story.ogg\n[/part]\n[/story]\n` +
    `[/scenario]`, 'story-music.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'story-music', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /name: "command:play_music"[\s\S]*file: "story\.ogg"[\s\S]*speaker: "narrator"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'story-music.mwl' }));
});

test('loader gates conditional story branches instead of flattening them', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=story-branches\nname=Story branches\nturns=2\n` +
    `[map]\nid=story-branches\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[story]\n[if]\n[variable]\nname=branch\nequals=yes\n[/variable]\n[then]\n[part]\nstory=The yes road.\n[/part]\n[/then]\n[else]\n[part]\nstory=The no road.\n[/part]\n[/else]\n[/if]\n` +
    `[switch]\nvariable=branch\n[case]\nvalue=maybe\n[part]\nstory=The maybe road.\n[/part]\n[/case]\n[/switch]\n[/story]\n` +
    `[/scenario]`, 'story-branches.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'story-branches', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /text: _\("The yes road\."\)/);
  assert.match(result.mwl, /text: _\("The no road\."\)/);
  assert.match(result.mwl, /text: _\("The maybe road\."\)/);
  assert.match(result.mwl, /variable: "branch",\n\s*equals: "yes"/);
  assert.match(result.mwl, /variable: "branch",\n\s*not_equals: "yes"/);
  assert.match(result.mwl, /variable: "branch",\n\s*equals: "maybe"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'story-branches.mwl' }));
});

test('loader converts replace_schedule time blocks to an engine hook', () => {
  const scenario = parseWml(
    `[scenario]\nid=replace-schedule\nname=Schedule\nturns=2\n` +
    `[map]\nid=replace-schedule\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[event]\nname=start\n[replace_schedule]\ncurrent_time=night\n[time]\nid=morning\nname=Morning\nlawful_bonus=25\n[/time]\n[time]\nid=night\nname=Night\nlawful_bonus=-25\n[/time]\n[/replace_schedule]\n[/event]\n` +
    `[/scenario]`,
    'replace-schedule.cfg',
  )[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'replace-schedule', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /name: "command:replace_schedule"/);
  assert.match(result.mwl, /current_time: "night"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'replace-schedule.mwl' }));
});

test('loader ports positional sound sources to the audio hook', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=source\nname=Source\nturns=2\n` +
    `[map]\nid=source\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=start\n[sound_source]\nid=wind\nsounds=ambient/wind.ogg\nx=2\ny=1\nloop=yes\nfull_range=3\nfade_range=5\ndelay=50000\n[/sound_source]\n[remove_sound_source]\nid=wind\n[/remove_sound_source]\n[/event]\n` +
    `[/scenario]`, 'source.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'source', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /name: "command:play_sound_source"[\s\S]*file: "ambient\/wind\.ogg"[\s\S]*x: 1[\s\S]*y: 0[\s\S]*id: "wind"[\s\S]*loop: "yes"[\s\S]*delay: 50000[\s\S]*ref_distance: 3[\s\S]*max_distance: 8/);
  assert.match(result.mwl, /name: "command:remove_sound_source"[\s\S]*id: "wind"/);
  assert.doesNotMatch(result.report.skipped.join('\\n'), /sound_source/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'source.mwl' }));
});

test('loader compiles location-based AI goals and avoid zones', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=ai-directives\nname=AI\nturns=2\n` +
    `[map]\nid=ai-directives\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=2\ncontroller=ai\n[ai]\n` +
    `[goal]\nname=target_location\nx=2\ny=1\nvalue=7\n[/goal]\n` +
    `[avoid]\nx=3\ny=2\nradius=2\n[/avoid]\n` +
    `[/ai]\n[/side]\n[/scenario]`, 'ai-directives.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'ai-directives', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.deepEqual(result.meta.aiDirectives, [
    { kind: 'goal', x: 1, y: 0, radius: 0, value: 7 },
    { kind: 'avoid', x: 2, y: 1, radius: 2, value: 10 },
  ]);
  assert.match(result.mwl, /name: "ai_directives"[\s\S]*goal,1,0,0,7;avoid,2,1,2,10/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'ai-directives.mwl' }));
});

test('loader expands ranged AI keep-away locations', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=ai-range\nname=AI\nturns=2\n` +
    `[map]\nid=ai-range\nterrain="Gg, Gg\nGg, Gg"\n[/map]\n` +
    `[side]\nside=2\ncontroller=ai\n[ai]\n` +
    `[avoid]\nx=2-3\ny=1-2\n[/avoid]\n` +
    `[/ai]\n[/side]\n[/scenario]`, 'ai-range.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'ai-range', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.deepEqual(result.meta.aiDirectives, [
    { kind: 'avoid', x: 1, y: 0, radius: 0, value: 10 },
    { kind: 'avoid', x: 1, y: 1, radius: 0, value: 10 },
    { kind: 'avoid', x: 2, y: 0, radius: 0, value: 10 },
    { kind: 'avoid', x: 2, y: 1, radius: 0, value: 10 },
  ]);
});

test('loader preserves unit criteria AI goals without coordinates', () => {
  const scenario = parseWml(`[scenario]\nid=ai-filter\nname=AI\nturns=2\n` +
    `[map]\nid=ai-filter\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=2\ncontroller=ai\n[ai]\n[goal]\nname=target\nvalue=4\n[criteria]\nside=1\ntype=Bowman,Spearman\n[/criteria]\n[/goal]\n[/ai]\n[/side]\n[/scenario]`, 'ai-filter.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'ai-filter', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.deepEqual(result.meta.aiDirectives, [{ kind: 'goal', radius: 0, value: 4, filter: { side: 1, type: ['Bowman', 'Spearman'] } }]);
  assert.match(result.mwl, /name: "ai_directives"/);
});

test('loader accepts coordinates inside AI criteria', () => {
  const scenario = parseWml(`[scenario]\nid=ai-criteria-location\nname=AI\nturns=2\n` +
    `[map]\nid=ai-criteria-location\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=2\ncontroller=ai\n[ai]\n[goal]\nname=protect_location\nvalue=4\n[criteria]\nx,y=2,1\n[/criteria]\n[/goal]\n[/ai]\n[/side]\n[/scenario]`, 'ai-criteria-location.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'ai-criteria-location', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.deepEqual(result.meta.aiDirectives, [{ kind: 'goal', x: 1, y: 0, radius: 0, value: 4 }]);
});

test('loader maps stock candidate actions into executable AI stages', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=ai-stages\nname=AI\nturns=2\n` +
    `[map]\nid=ai-stages\nterrain="Gg, Gg\nGg, Gg"\n[/map]\n` +
    `[side]\nside=2\ncontroller=ai\n[ai]\n` +
    `[stage]\nname=main_loop\n[candidate_action]\nid=recruitment\n[/candidate_action]\n` +
    `[candidate_action]\nid=combat\n[/candidate_action]\n[/stage]\n` +
    `[/ai]\n[/side]\n[/scenario]`, 'ai-stages.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'ai-stages', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.deepEqual(result.meta.aiStages, ['recruitment', 'combat']);
  assert.match(result.mwl, /name: "ai_stages"[\s\S]*value: "recruitment,combat"/);
});

test('loader preserves side team and shared-vision settings', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=teams\nname=Teams\nturns=2\n` +
    `[map]\nid=teams\nterrain="Gg, Gg\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\ntype=Spearman\nid=leader\nteam_name=alliance\nshare_vision=all\n[/side]\n` +
    `[/scenario]`, 'teams.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'teams', knownUnitTypes: KNOWN, mapStarts: { 1: [{ x: 0, y: 0 }] } });
  assert.match(result.mwl, /team_name: "alliance"/);
  assert.match(result.mwl, /share_vision: "all"/);
});

test('loader converts a halo command to the presentation hook', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=halo\nname=Halo\nturns=2\n` +
    `[map]\nid=halo\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=start\n[halo]\nimage=halo/fire.png\nx=2\ny=1\nduration=0.5\n[/halo]\n[/event]\n` +
    `[/scenario]`, 'halo.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'halo', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /name: "command:show_halo"[\s\S]*image: "halo\/fire\.png"[\s\S]*x: 1[\s\S]*y: 0/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'halo.mwl' }));
});

test('loader retains halo frame images and durations', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=halo-frames\nname=Halo\nturns=2\n` +
    `[map]\nid=halo-frames\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=start\n[halo]\nx=2\ny=1\n` +
    `[halo_frame]\nimage=halo/a.png\nduration=0.2\n[/halo_frame]\n` +
    `[halo_frame]\nimage=halo/b.png\nduration=0.3\n[/halo_frame]\n` +
    `[/halo]\n[/event]\n[/scenario]`, 'halo-frames.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'halo-frames', knownUnitTypes: KNOWN, mapStarts: {} });
  assert.match(result.mwl, /frames: "halo\/a\.png@0\.2;halo\/b\.png@0\.3"/);
  assert.match(result.mwl, /duration: 0\.5/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'halo-frames.mwl' }));
});

/**
 * A WML `value=` is interpolation, never arithmetic, so MWL's own `[set_variable]` (whose
 * expression evaluator raises on an unset variable and cannot spell a literal like
 * `A (8 Gold)`) is only safe for a plain integer. Everything else is a port hook that owns
 * Wesnoth's `$`/`$(...)` semantics, and each arithmetic key is its own hook in WML order.
 */
test('loader routes WML variable values through the port hook, not MWL arithmetic', () => {
  const scenario = parseWml(`[scenario]\n` +
    `id=values\nname=Values\nturns=2\n` +
    `[map]\nid=values\nterrain="Gg, Gg\\nGg, Gg"\n[/map]\n` +
    `[side]\nside=1\ncontroller=human\n[/side]\n` +
    `[event]\nname=start\n` +
    `[set_variable]\nname=plain\nvalue=7\n[/set_variable]\n` +
    `[set_variable]\nname=label\nvalue=Raise Walking Corpse (8 Gold)\n[/set_variable]\n` +
    `[set_variable]\nname=maybe\nvalue=$turns?0|\n[/set_variable]\n` +
    `[set_variable]\nname=rounded\nvalue=$(min(5,($killed)))\n[/set_variable]\n` +
    `[set_variable]\nname=scaled\nvalue=1\nmultiply=3\n[/set_variable]\n` +
    `[set_variable]\nname=rem\nvalue=1\nmodulo=6\n[/set_variable]\n` +
    `[/event]\n[/scenario]`, 'values.cfg')[0];
  assert.ok(scenario);
  const result = loadScenario(scenario!, { scenarioId: 'values', knownUnitTypes: KNOWN, mapStarts: {} });
  // A plain integer is common ground with MWL, so it stays on the framework's own command.
  assert.match(result.mwl, /tag: "set_variable",\n\s*name: "plain",\n\s*value: 7,/);
  for (const [variable, value] of [
    ['label', 'Raise Walking Corpse (8 Gold)'],
    ['maybe', '$turns?0|'],
    ['rounded', '$(min(5,($killed)))'],
  ] as const) {
    assert.match(result.mwl, new RegExp(`name: "command:set_variable_dynamic",\\n\\s*variable: "${variable.replaceAll('(', '\\(').replaceAll(')', '\\)').replaceAll('$', '\\$').replaceAll('|', '\\|')}",\\n\\s*value: .*\\n\\s*mode: "value"`));
    assert.ok(result.mwl.includes(value), `${value} is preserved verbatim`);
  }
  assert.match(result.mwl, /name: "command:set_variable_dynamic",\n\s*variable: "scaled",\n\s*value: 3,\n\s*mode: "multiply"/);
  assert.match(result.mwl, /name: "command:set_variable_dynamic",\n\s*variable: "rem",\n\s*value: 6,\n\s*mode: "modulo"/);
  assert.doesNotThrow(() => compile(result.mwl, { file: 'values.mwl' }));
  assert.deepEqual(
    result.report.diagnostics.filter((diagnostic) => diagnostic.message.includes('[set_variable]')),
    [],
    'no set_variable key is dropped',
  );
});
