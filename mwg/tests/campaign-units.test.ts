import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeImagePath } from '../src/adapters/unit-animations.ts';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { SCENARIO_COMPATIBILITY } from '../src/generated/scenarios.ts';

/**
 * Each shipped campaign defines its own `[unit_type]`s (Descent Into Darkness's
 * `Malin Keshar`, The South Guard's `Veteran Fencer`, ...). `npm run data`
 * compiles each campaign's `units/` with that campaign's macros into the same
 * registry as core, so a scenario's `[unit] type=` resolves instead of being
 * dropped as "unit without a known type".
 */
test('campaign-specific unit types are compiled into the game registry', () => {
  const malin = GAME_DATA.unitTypes['Malin Keshar'];
  assert.ok(malin, 'Descent Into Darkness hero is registered');
  assert.ok(malin.hitpoints > 0, 'real hitpoints from the campaign file');
  assert.ok(malin.attacks.length >= 1, 'real attacks from the campaign file');

  const fencer = GAME_DATA.unitTypes['Veteran Fencer'];
  assert.ok(fencer, 'The South Guard unit is registered');
  assert.ok(fencer.attacks.length >= 1);
});

test('`data/internal` unit types a scenario places directly are compiled', () => {
  for (const type of ['Rogue Mage', 'Shadow Mage', 'Dwarvish Witness']) {
    assert.ok(GAME_DATA.unitTypes[type], `${type} is registered`);
    assert.ok(GAME_DATA.unitTypes[type].attacks.length >= 1, `${type} has its real attacks`);
  }
});

test('compiled scenarios no longer drop the campaign units they place', () => {
  const details = Object.values(SCENARIO_COMPATIBILITY).flatMap((entry) => entry.details);
  for (const type of ['Malin Keshar', 'Veteran Fencer', 'Rogue Mage', 'Shadow Mage', 'Dwarvish Witness']) {
    assert.ok(
      !details.some((detail) => detail.includes(`unit without a known type (${type})`)),
      `${type} is no longer reported as unknown`,
    );
  }
  // The only placements left unresolved are the `none`/`missing` difficulty
  // sentinels inside a `[if]` that never runs (`{GENERIC_UNITC ...}`); a
  // `$variable` type resolves at runtime instead.
  const unresolved = [...new Set(details.flatMap((detail) => /unit without a known type \(([^)]+)\)/.exec(detail)?.[1] ?? []))];
  assert.deepEqual(unresolved.sort(), ['missing', 'none']);
});

test('a data-root-prefixed image path is normalized to the asset key', () => {
  // Winds of Fate's `Gate` spells the source root out fully; the bundle key and
  // the runtime path must both be root-relative.
  assert.equal(normalizeImagePath('data/core/images/scenery/gate-rusty-sw.png'), 'scenery/gate-rusty-sw.png');
  assert.equal(normalizeImagePath('units/human-loyalists/spearman.png'), 'units/human-loyalists/spearman.png');
});
