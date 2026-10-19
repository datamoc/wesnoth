import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile, parse as parseMwl, schema01 } from 'mwg/mwl';
import { compileWesnothMwl, toWesnothData } from '../src/adapters/from-mwl.ts';
import { wesnothSchema } from '../src/adapters/wesnoth-schema.ts';
import { emitMwl, genericMwlNodes, newConversionStats, sliceMwlNodes } from '../src/adapters/wesnoth-to-mwl.ts';
import { WmlPreprocessor, parseWml, type WmlNode } from '../src/simulation/wml.ts';

/**
 * `.cfg` -> `.mwl` conversion. The port reads Wesnoth data as WML; these tests
 * convert real files and prove the two halves:
 *
 * - generic conversion is lossless: the emitted MWL parses back to the same tree,
 *   including the `_ "..."` gettext markers (modulo the deliberate JSON5
 *   boolean-spelling normalization, `yes`/`no` to `true`/`false`);
 * - slice conversion is data-identical: compiling the emitted MWL yields the same
 *   `WesnothData` as the direct in-memory route, for the tags the port consumes.
 */
const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');
const MACRO_FILES = ['traits.cfg', 'weapon_specials.cfg', 'abilities.cfg', 'schedules.cfg', 'sound-utils.cfg', 'special-notes.cfg'];

const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
wml.loadMacros(MACRO_FILES.map((name) => path.join(dataDir, 'core', 'macros', name)));

function parseCfg(relative: string): WmlNode[] {
  return parseWml(wml.preprocessFile(path.join(dataDir, relative)), relative);
}

/** Compare only what a conversion promises to preserve. */
function shape(node: { tag: string; attributes: Record<string, string>; children: readonly unknown[]; gettext?: readonly string[] }): unknown {
  // JSON5 normalizes boolean spellings by design (`fog=yes` renders as
  // `fog: true`; the proposal keeps `yes`/`no` readable only downstream in
  // `readers.ts` coercion). Compare modulo that spelling on both sides.
  const entry = schema01[node.tag];
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attributes)) {
    const type = entry?.attributes?.[key] ?? entry?.openAttributes;
    attributes[key] = type === 'boolean' && (value === 'yes' || value === 'no') ? String(value === 'yes') : value;
  }
  return {
    tag: node.tag,
    attributes,
    gettext: [...(node.gettext ?? [])].sort(),
    children: node.children.map((child) => shape(child as Parameters<typeof shape>[0])),
  };
}

test('generic conversion of a real scenario round-trips through MWL text', () => {
  const nodes = parseCfg('multiplayer/scenarios/2p_Hamlets.cfg');
  const text = emitMwl(genericMwlNodes(nodes, newConversionStats()));

  assert.match(text, /tag: "multiplayer"/);
  assert.match(text, /name: _\("2p — Hamlets"\)/, 'gettext marker is re-emitted');
  assert.match(text, /tag: "side"/, 'nesting is preserved');

  const reparsed = parseMwl(text, 'round-trip.mwl');
  assert.deepEqual(reparsed.map(shape), nodes.map(shape));
});

test('slice conversion of terrain.cfg compiles to the same data as the direct route', () => {
  const terrain = parseCfg('core/terrain.cfg');
  const direct = toWesnothData(compileWesnothMwl({ terrain, units: [], schedule: [] }));
  assert.equal(Object.keys(direct.terrains).length, 284);

  const stats = newConversionStats();
  const text = emitMwl(sliceMwlNodes(terrain, stats), stats);
  assert.equal(stats.skipped, 0, 'every terrain_type node converts');

  const roundTrip = toWesnothData(compile(text, { file: 'terrain.mwl', schemas: wesnothSchema }));
  assert.deepEqual(roundTrip.terrains, direct.terrains);
  assert.deepEqual(roundTrip.terrainByCode, direct.terrainByCode);
});

test('slice conversion of a unit file keeps the typed unit and drops animations', () => {
  const units = parseCfg('core/units/humans/Horseman.cfg');
  const direct = toWesnothData(compileWesnothMwl({ terrain: [], units, schedule: [] }));

  const stats = newConversionStats();
  const text = emitMwl(sliceMwlNodes(units, stats), stats);

  assert.equal(stats.converted, 1, 'one [unit_type] survived');
  assert.ok(stats.skipped > 20, `animation and branch tags are reported (${stats.skipped})`);
  assert.ok(stats.skippedTags.has('frame'));
  assert.match(text, /tag: "unit_type"/);
  assert.match(text, /specials: "charge"/);

  // The port's own schema, the one the data pipeline compiles with: it carries
  // the Wesnoth-only attributes (`die_sound`, `abilities_list`) the framework's
  // base schema does not know.
  const roundTrip = toWesnothData(compile(text, { file: 'horseman.mwl', schemas: wesnothSchema }));
  assert.deepEqual(roundTrip.unitTypes['Horseman'], direct.unitTypes['Horseman']);
});

test('values that would change meaning are quoted', () => {
  const nodes = parseCfg('core/units/humans/Horseman.cfg');
  const stats = newConversionStats();
  const text = emitMwl(sliceMwlNodes(nodes, stats), stats);
  assert.match(text, /icon: ""/, 'an empty value is quoted');
  assert.ok(stats.quoted > 0);
});
