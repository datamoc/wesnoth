import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeUnit, type Unit } from '../src/simulation/unit.ts';
import { parseWml, type WmlNode } from '../src/simulation/wml.ts';
import { encodeFilter, matchesUnitFilter, toFilterNode, type FilterWorld, type WmlFilterNode } from '../src/scenarios/wml-filter.ts';

/**
 * The WML filter algebra (ROADMAP backlog: "Complete WML filter algebra").
 *
 * Every expectation here is checked against the real engine's semantics:
 * comma-list membership and numeric ranges from `src/units/filter.cpp:329-620`,
 * `[and]`/`[or]`/`[not]` folded in document order (`filter.cpp:263-276`),
 * `[filter_wml]` matched as a config (`filter.cpp:701-715`) and
 * `[filter_location]` as a terrain filter (`filter.cpp:740-742`).
 */

/** Parse a `[filter]` source string into the module's serializable form. */
function filter(source: string): WmlFilterNode {
  const node = parseWml(source, 'filter.cfg')[0] as WmlNode;
  assert.ok(node, 'the filter parses');
  return toFilterNode(node);
}

const spearman = makeUnit(GAME_DATA, 'Spearman', 1, 3, 4);
const grunt = makeUnit(GAME_DATA, 'Orcish Grunt', 2, 5, 6);
const variables: Record<string, string> = { wanted: 'Spearman', target_x: '4' };

const world: FilterWorld = {
  variable: (path) => variables[path],
  terrainAt: (x, y) => (x === 3 && y === 4 ? 'Gg^Fp' : 'Gg'),
  villageOwnerAt: (x) => (x === 5 ? 2 : null),
  allied: (a, b) => a === b,
  abilitiesOf: (unit) => [...(GAME_DATA.unitTypes[unit.typeId]?.abilities ?? []), ...unit.extraAbilities],
  attacksOf: (unit) => unit.attacks.map((attack) => ({ id: attack.name, name: attack.name, range: attack.range, type: attack.type })),
  raceOf: (unit) => GAME_DATA.unitTypes[unit.typeId]?.race ?? '',
  isVillageAt: (x) => x === 5,
};

const matches = (source: string, unit: Unit, second?: Unit): boolean => matchesUnitFilter(filter(source), unit, world, second);

test('string attributes are comma lists tested for membership', () => {
  assert.ok(matches('[filter]\ntype=Spearman\n[/filter]', spearman));
  assert.ok(!matches('[filter]\ntype=Spearman\n[/filter]', grunt));
  assert.ok(matches('[filter]\ntype=Spearman,Orcish Grunt\n[/filter]', grunt));
  assert.ok(matches('[filter]\nrace=human\n[/filter]', spearman));
  assert.ok(!matches('[filter]\nrace=human\n[/filter]', grunt));
  assert.ok(matches('[filter]\nside=1,2\n[/filter]', grunt));
  assert.ok(matches('[filter]\nalignment=lawful\n[/filter]', spearman));
});

test('numeric attributes read ranges and lists', () => {
  assert.ok(matches('[filter]\nlevel=0-2\n[/filter]', spearman));
  assert.ok(!matches('[filter]\nlevel=3-5\n[/filter]', spearman));
  assert.ok(matches('[filter]\nlevel=1,3\n[/filter]', spearman));
  assert.ok(matches(`[filter]\nhitpoints=${spearman.hitpoints}-${spearman.hitpoints + 5}\n[/filter]`, spearman));
  assert.ok(!matches('[filter]\nhitpoints=1-3\n[/filter]', spearman));
  assert.ok(matches(`[filter]\nx=${spearman.x + 1}\ny=${spearman.y + 1}\n[/filter]`, spearman));
  assert.ok(matches('[filter]\nx=1-5\n[/filter]', spearman));
});

test('not_type is the port spelling of the same negation [not] writes', () => {
  assert.ok(matches('[filter]\nnot_type=Wolf\n[/filter]', spearman));
  assert.ok(!matches('[filter]\nnot_type=Spearman\n[/filter]', spearman));
  assert.ok(matches('[filter]\n[not]\ntype=Wolf\n[/not]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\n[not]\ntype=Spearman\n[/not]\n[/filter]', spearman));
});

test('[and], [or] and [not] fold into the result in document order', () => {
  // `[and]` narrows, `[not]` excludes.
  assert.ok(matches('[filter]\ntype=Spearman\n[and]\nlevel=0-2\n[/and]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\ntype=Spearman\n[and]\nlevel=4\n[/and]\n[/filter]', spearman));
  assert.ok(matches('[filter]\ntype=Spearman,Orcish Grunt\n[not]\nside=2\n[/not]\n[/filter]', spearman));
  // `[or]` ORs with everything evaluated before it, exactly like the engine:
  // `[filter] type=Spearman [or] type=Orcish Grunt [/or]` accepts both types.
  assert.ok(matches('[filter]\ntype=Spearman\n[or]\ntype=Orcish Grunt\n[/or]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\ntype=Spearman\n[or]\ntype=Orcish Grunt\n[/or]\n[/filter]', makeUnit(GAME_DATA, 'Bowman', 1, 0, 0)));
  // The order matters: an `[and]` after an unsatisfied attribute cannot rescue it.
  assert.ok(!matches('[filter]\ntype=Bowman\n[or]\ntype=Spearman\n[/or]\n[and]\nlevel=1\n[/and]\n[/filter]', spearman) === false);
});

test('ability and status attributes read the unit, not its type alone', () => {
  const healer = makeUnit(GAME_DATA, 'White Mage', 1, 2, 2);
  assert.ok(matches('[filter]\nstatus=poisoned\n[/filter]', { ...healer, poisoned: true }));
  assert.ok(!matches('[filter]\nstatus=poisoned\n[/filter]', healer));
  // `[not] status=` is how content excludes a status.
  assert.ok(matches('[filter]\n[not]\nstatus=slowed\n[/not]\n[/filter]', healer));
  assert.ok(matches('[filter]\ncanrecruit=yes\n[/filter]', { ...healer, canRecruit: true }));
  assert.ok(!matches('[filter]\ncanrecruit=yes\n[/filter]', healer));
});

test('values resolve $variables before they are compared', () => {
  assert.ok(matches('[filter]\ntype=$wanted\n[/filter]', spearman));
  assert.ok(!matches('[filter]\ntype=$wanted\n[/filter]', grunt));
  assert.ok(matches(`[filter]\nx=$target_x\n[/filter]`, spearman));
});

test('[filter_wml] matches the unit as a config, coordinates included', () => {
  assert.ok(matches('[filter]\n[filter_wml]\ntype=Spearman\n[/filter_wml]\n[/filter]', spearman));
  // A glob is a `config::matches` wildcard.
  assert.ok(matches('[filter]\n[filter_wml]\nname=*\n[/filter_wml]\n[/filter]', spearman));
  // WML writes 1-based coordinates; the port stores 0-based ones.
  assert.ok(matches(`[filter]\n[filter_wml]\nx=${spearman.x + 1}\n[/filter_wml]\n[/filter]`, spearman));
  assert.ok(!matches(`[filter]\n[filter_wml]\nx=${spearman.x + 2}\n[/filter_wml]\n[/filter]`, spearman));
  // A comparison operator, and a status block.
  assert.ok(matches(`[filter]\n[filter_wml]\nhitpoints=>${spearman.hitpoints - 1}\n[/filter_wml]\n[/filter]`, spearman));
  assert.ok(matches('[filter]\n[filter_wml]\n[status]\npoisoned=no\n[/status]\n[/filter_wml]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\n[filter_wml]\n[status]\npoisoned=yes\n[/status]\n[/filter_wml]\n[/filter]', spearman));
});

test('[filter_location] is a terrain filter over the hex the unit stands on', () => {
  // The unit at 3,4 stands on grass with a forest overlay, so the pattern has
  // to spell that overlay: `ter_match` compares both layers unless a `*` makes
  // one of them a wildcard (`src/terrain/translation.cpp` is_match).
  assert.ok(matches('[filter]\n[filter_location]\nterrain=Gg^Fp\n[/filter_location]\n[/filter]', spearman));
  assert.ok(matches('[filter]\n[filter_location]\nterrain=*^F*\n[/filter_location]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\n[filter_location]\nterrain=Gg\n[/filter_location]\n[/filter]', spearman));
  assert.ok(!matches('[filter]\n[filter_location]\nterrain=Ww\n[/filter_location]\n[/filter]', spearman));
  assert.ok(matches(`[filter]\n[filter_location]\nx=${spearman.x + 1}\ny=${spearman.y + 1}\n[/filter_location]\n[/filter]`, spearman));
  // Ownership reads the village owner, so a hex that is not a village fails.
  assert.ok(!matches('[filter]\n[filter_location]\nowner_side=2\n[/filter_location]\n[/filter]', spearman));
});

test('[filter_adjacent] matches neighboring units and applies count/team filters', () => {
  const adjacent = makeUnit(GAME_DATA, 'Bowman', 2, 4, 4);
  const localWorld: FilterWorld = {
    ...world,
    unitAt: (x, y) => x === adjacent.x && y === adjacent.y ? adjacent : undefined,
    allied: (a, b) => a === b,
  };
  const localMatches = (source: string, subject = spearman) =>
    matchesUnitFilter(toFilterNode(parseWml(source, 'filter.cfg')[0] as WmlNode), subject, localWorld);
  assert.ok(localMatches('[filter]\n[filter_adjacent]\ntype=Bowman\n[/filter_adjacent]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_adjacent]\ncount=1\nis_enemy=yes\n[/filter_adjacent]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_adjacent]\ncount=2\n[/filter_adjacent]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_adjacent]\nis_friend=yes\n[/filter_adjacent]\n[/filter]'));
});

test('[filter_adjacent_location] matches terrain on neighboring hexes', () => {
  const localWorld: FilterWorld = {
    ...world,
    terrainAt: (x, y) => x === 4 && y === 4 ? 'Gg^Fp' : 'Gg',
  };
  const localMatches = (source: string) =>
    matchesUnitFilter(toFilterNode(parseWml(source, 'filter.cfg')[0] as WmlNode), spearman, localWorld);
  assert.ok(localMatches('[filter]\n[filter_location]\n[filter_adjacent_location]\nterrain=Gg\n[/filter_adjacent_location]\n[/filter_location]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_location]\n[filter_adjacent_location]\nterrain=*^F*\n[/filter_adjacent_location]\n[/filter_location]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_location]\n[filter_adjacent_location]\ncount=6\nterrain=Gg^Fp\n[/filter_adjacent_location]\n[/filter_location]\n[/filter]'));
});

test('[filter_location] applies radius to explicit and unit-reference centers', () => {
  const hamel = makeUnit(GAME_DATA, 'Lieutenant', 2, 6, 5);
  const localWorld: FilterWorld = {
    ...world,
    terrainAt: (x, y) => x === spearman.x && y === spearman.y ? 'Gg' : 'Ww',
    unitAt: (x, y) => x === hamel.x && y === hamel.y ? hamel : undefined,
  };
  const localMatches = (source: string) =>
    matchesUnitFilter(toFilterNode(parseWml(source, 'filter.cfg')[0] as WmlNode), spearman, localWorld);
  assert.ok(localMatches('[filter]\n[filter_location]\nx=4\ny=5\nradius=1\n[filter_radius]\nterrain=Gg\n[/filter_radius]\n[/filter_location]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_location]\nradius=4\n[filter]\ntype=Lieutenant\n[/filter]\n[filter_radius]\nterrain=Gg\n[/filter_radius]\n[/filter_location]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_location]\nx=4\ny=5\nradius=1\n[filter_radius]\nterrain=Ww\n[/filter_radius]\n[/filter_location]\n[/filter]'));
});

test('[filter_vision] matches current fog visibility for units and locations', () => {
  const seen = new Set(['3,4']);
  const localWorld: FilterWorld = {
    ...world,
    visibleTo: (side, x, y) => side === 1 && seen.has(`${x},${y}`),
  };
  const localMatches = (source: string, unit = spearman) =>
    matchesUnitFilter(toFilterNode(parseWml(source, 'filter.cfg')[0] as WmlNode), unit, localWorld);
  assert.ok(localMatches('[filter]\n[filter_vision]\nside=1\nvisible=yes\n[/filter_vision]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_vision]\nside=2\nvisible=yes\n[/filter_vision]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_vision]\nside=2\nvisible=no\n[/filter_vision]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_location]\n[filter_vision]\nside=1\nvisible=yes\n[/filter_vision]\n[/filter_location]\n[/filter]'));
});

test('[filter_ability] matches registry ids and WML effect tags', () => {
  const mage = makeUnit(GAME_DATA, 'White Mage', 1, 3, 4);
  const details = [
    { id: 'heals_4', tag: 'heals', attributes: { value: '4' } },
    { id: 'illumination', tag: 'illuminates', attributes: { value: '25' } },
  ] as const;
  const localWorld: FilterWorld = {
    ...world,
    abilitiesOf: () => details.map((entry) => entry.id),
    abilityDetailsOf: () => details,
  };
  const localMatches = (source: string) =>
    matchesUnitFilter(toFilterNode(parseWml(source, 'filter.cfg')[0] as WmlNode), mage, localWorld);
  assert.ok(localMatches('[filter]\n[filter_ability]\nid=illumination\n[/filter_ability]\n[/filter]'));
  assert.ok(localMatches('[filter]\n[filter_ability]\ntag_name=illuminates\n[/filter_ability]\n[/filter]'));
  assert.ok(!localMatches('[filter]\n[filter_ability]\ntag_name=leadership\n[/filter_ability]\n[/filter]'));
});

test('filter formulas evaluate against self and other unit values', () => {
  assert.ok(matches('[filter]\nformula="self.hitpoints < self.max_hitpoints"\n[/filter]', { ...spearman, hitpoints: 1 }));
  assert.ok(!matches('[filter]\nformula="self.hitpoints < self.max_hitpoints"\n[/filter]', spearman));
  assert.ok(matches('[filter]\nformula="self.level < other.level"\n[/filter]', spearman, makeUnit(GAME_DATA, 'White Mage', 2, 4, 4)));
});

test('an encoded filter survives the trip into a scenario document', () => {
  const node = filter('[filter]\ntype=Spearman\n[and]\nlevel=0-2\n[/and]\n[/filter]');
  const encoded = encodeFilter(node);
  assert.ok(!encoded.includes('\n'), 'the encoding is one MWL value');
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), node);
});
