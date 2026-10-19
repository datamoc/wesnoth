import assert from 'node:assert/strict';
import test from 'node:test';
import { CARRYOVER_GOLD_PERCENT, carryoverFor, describeCarryover, nextScenario, nextScenarioWithOverride } from '../src/campaign.ts';

/**
 * The campaign rules: scenario order and the carry-over between two scenarios.
 * Wesnoth's `[endlevel]` defaults are the reference (all survivors recall, a
 * share of the gold carries); the port keeps them simplified.
 */
test('nextScenario walks the campaign order and stops at the end', () => {
  const order = ['courier', 'freelands'];
  assert.equal(nextScenario(order, 'courier'), 'freelands');
  assert.equal(nextScenario(order, 'freelands'), null);
  assert.equal(nextScenario(order, 'unknown'), null);
});

test('scenario endlevel override selects an available campaign branch', () => {
  const order = ['the-south-guard-01', 'the-south-guard-02', 'the-south-guard-04'];
  assert.equal(nextScenarioWithOverride(order, 'the-south-guard-04', 'the-south-guard-05c', (id) => id === 'the-south-guard-05c'), 'the-south-guard-05c');
  assert.equal(nextScenarioWithOverride(order, 'the-south-guard-02', 'missing', () => false), 'the-south-guard-04');
});

test('carry-over keeps a share of the gold and the surviving units', () => {
  const carryover = carryoverFor({
    from: 'courier',
    to: 'freelands',
    gold: 75,
    units: [
      { typeId: 'Elvish Scout', name: 'Elvish Scout', side: 1, hitpoints: 12, experience: 9 },
      { typeId: 'Orcish Grunt', name: 'Orcish Grunt', side: 2, hitpoints: 20, experience: 0 },
      { typeId: 'Bowman', name: 'Bowman', side: 1, hitpoints: 0, experience: 3 },
    ],
  });

  assert.equal(carryover.gold, Math.floor((75 * CARRYOVER_GOLD_PERCENT) / 100));
  assert.equal(carryover.percent, CARRYOVER_GOLD_PERCENT);
  assert.deepEqual(carryover.units, [{ typeId: 'Elvish Scout', name: 'Elvish Scout', hitpoints: 12, experience: 9 }]);
});

test('carry-over rounds gold down and honours an explicit percentage', () => {
  assert.equal(carryoverFor({ from: 'a', to: 'b', gold: 7, units: [] }).gold, 5);
  const full = carryoverFor({ from: 'a', to: 'b', gold: 7, units: [], percent: 100 });
  assert.equal(full.gold, 7);
  assert.equal(full.percent, 100);
  assert.equal(carryoverFor({ from: 'a', to: 'b', gold: -5, units: [] }).gold, 0);
});

test('the victory summary names the survivors and the gold', () => {
  const carryover = carryoverFor({
    from: 'courier',
    to: 'freelands',
    gold: 75,
    units: [{ typeId: 'Elvish Scout', name: 'Elvish Scout', side: 1, hitpoints: 12, experience: 9 }],
  });
  assert.deepEqual(describeCarryover(carryover, 75), [
    'Units carried over: Elvish Scout',
    'Gold carried over: 60 of 75 (80%)',
    'Next scenario: freelands',
  ]);
  assert.match(describeCarryover({ ...carryover, units: [] }, 0)[0], /None/);
});
