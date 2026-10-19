import assert from 'node:assert/strict';
import test from 'node:test';
import { MwlRuntime } from 'mwg/mwl';
import { CAMPAIGNS } from '../src/generated/campaigns.ts';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { SCENARIO_ORDER, SCENARIOS } from '../src/generated/scenarios.ts';
import { createEngineHooks } from '../src/scenarios/engine-hooks.ts';
import { makeGame } from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';

/**
 * Headless start-to-finish smoke (ROADMAP P7): every campaign's first scenario must run its
 * `start`/`prestart` events through `MwlRuntime` with no error, and every other shipped
 * scenario either starts too or is one of the known WML expression/variable-semantics gaps
 * listed below. The engine is a stub that records nothing; the point is that a scenario's
 * whole setup body executes without throwing.
 */

/** One stub runtime over a fresh 3x3 field, the way the browser wires its hooks. */
function startsCleanly(name: string): string | null {
  const game = SCENARIOS[name];
  if (!game) return 'not in the scenario registry';
  const state = makeGame(3, 3, Array.from({ length: 9 }, () => 'Gg'), new Map([[1, [{ x: 1, y: 1 }]]]));
  const hooks = createEngineHooks({
    data: GAME_DATA,
    state: () => state,
    unit: () => undefined,
    units: () => state.units,
    log: () => {},
    rng: () => 0,
    storeUnit: () => [],
    unstoreUnit: () => {},
    recallUnit: () => {},
    spawnUnit: (id, type, side, x, y) => {
      const unit = makeUnit(GAME_DATA, type, side, x, y);
      unit.wmlId = id;
      state.units.push(unit);
    },
    killUnit: () => {},
    makeLoyal: () => {},
    configureSide: () => {},
    configureRecruit: () => {},
    addGold: () => {},
    fireEvent: () => {},
    setAchievement: () => {},
    showHalo: () => {},
  });
  try {
    new MwlRuntime(game, { hooks }).run('start');
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

test('every campaign starts its first scenario headlessly', () => {
  assert.equal(CAMPAIGNS.length, 21);
  for (const campaign of CAMPAIGNS) {
    // World Conquest generates its maps from Lua; tests/lua-world-conquest.test.ts starts it
    if (campaign.firstScenario === 'wc-lua') continue;
    const first = campaign.scenarios[0];
    assert.ok(first, `${campaign.id} lists no scenarios`);
    const error = startsCleanly(first);
    assert.equal(error, null, `${campaign.id} first scenario (${first}) did not start: ${error}`);
  }
});

// Every scenario's setup body now runs: the port owns WML value semantics
// (`src/scenarios/wml-value.ts`), so an unset variable reads as empty, `$name?default|`
// supplies a fallback, `$(...)` evaluates a WFL formula, and a literal like
// `Raise Walking Corpse (8 Gold)` stores as written. The list of expression-semantics
// failures the roadmap recorded for this test is empty, so any entry here is a regression.
test('every shipped scenario starts headlessly', () => {
  const failures = SCENARIO_ORDER
    .map((name) => ({ name, error: startsCleanly(name) }))
    .filter((entry) => entry.error !== null);
  assert.deepEqual(failures, [], `scenario(s) failed to start: ${failures.map((entry) => `${entry.name}: ${entry.error}`).join('; ')}`);
});
