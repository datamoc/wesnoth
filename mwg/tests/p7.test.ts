import assert from 'node:assert/strict';
import test from 'node:test';
import { carryoverFor, describeCarryover } from '../src/campaign.ts';
import { CAMPAIGNS } from '../src/generated/campaigns.ts';
import { SCENARIOS } from '../src/generated/scenarios.ts';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeUnitWithTraits } from '../src/simulation/unit.ts';

/**
 * Campaign systems: the real `[campaign]` definition, trait-preserving recall
 * and the early-finish bonus. The campaign order is the campaign's own scenario
 * chain, not the alphabet.
 */
test('the compiled campaign owns its scenario chain and difficulties', () => {
  const twoBrothers = CAMPAIGNS.find((campaign) => campaign.id === 'Two_Brothers');
  assert.ok(twoBrothers, 'Two Brothers compiled from its [campaign]');
  assert.equal(twoBrothers!.title, 'A Tale of Two Brothers');
  assert.equal(twoBrothers!.abbrev, 'AToTB');
  assert.deepEqual(twoBrothers!.scenarios, [
    'two-brothers-01',
    'two-brothers-02',
    'two-brothers-03',
    'two-brothers-04',
    'two-brothers-05',
  ]);
  assert.deepEqual(twoBrothers!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'HARD']);
  assert.equal(twoBrothers!.defaultDifficulty, 'EASY');
  assert.equal(twoBrothers!.difficulties[0].label, 'Horseman');
  assert.equal(twoBrothers!.difficulties[1].label, 'Grand Knight');
});

test('The South Guard campaign scenarios are compiled from real WML', () => {
  const southGuard = CAMPAIGNS.find((campaign) => campaign.id === 'The_South_Guard');
  assert.ok(southGuard, 'The South Guard compiled from its [campaign]');
  assert.deepEqual(southGuard!.scenarios, [
    'the-south-guard-01',
    'the-south-guard-02',
    'the-south-guard-02x',
    'the-south-guard-03',
    'the-south-guard-04',
  ]);
  assert.deepEqual(southGuard!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);

  // Branch scenarios are kept in the registry even though the linear campaign
  // definition currently follows only the default 01 -> 04 route.
  for (const id of [
    'the-south-guard-01', 'the-south-guard-02', 'the-south-guard-02x',
    'the-south-guard-03', 'the-south-guard-04', 'the-south-guard-05a',
    'the-south-guard-05b', 'the-south-guard-05c', 'the-south-guard-06a',
    'the-south-guard-06b', 'the-south-guard-06x',
  ]) {
    assert.ok(SCENARIOS[id], `${id} is present in the compiled scenario registry`);
    assert.ok(SCENARIOS[id].roots.some((root) => root.tag === 'game'), `${id} has a game root`);
  }
});

test('Liberty campaign scenarios are compiled from real WML', () => {
  const liberty = CAMPAIGNS.find((campaign) => campaign.id === 'Liberty');
  assert.ok(liberty, 'Liberty compiled from its [campaign]');
  assert.deepEqual(liberty!.scenarios, [
    'liberty-01', 'liberty-02', 'liberty-03', 'liberty-04',
    'liberty-05', 'liberty-06', 'liberty-07', 'liberty-08',
  ]);
  assert.deepEqual(liberty!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (const id of liberty!.scenarios) {
    assert.ok(SCENARIOS[id], `${id} is present in the compiled scenario registry`);
    assert.ok(SCENARIOS[id].roots.some((root) => root.tag === 'game'), `${id} has a game root`);
  }
});

test('Dusk of Dawn campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Dusk_of_Dawn');
  assert.ok(campaign, 'Dusk of Dawn compiled from its [campaign]');
  assert.deepEqual(campaign!.scenarios, [
    'dusk-of-dawn-00', 'dusk-of-dawn-01', 'dusk-of-dawn-02',
    'dusk-of-dawn-03', 'dusk-of-dawn-04',
  ]);
  for (const id of campaign!.scenarios) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Of Pearls and Pirates campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Pearls_and_Pirates');
  assert.ok(campaign, 'Of Pearls and Pirates compiled from its [campaign]');
  assert.deepEqual(campaign!.scenarios, [
    'of-pearls-and-pirates-01', 'of-pearls-and-pirates-02',
    'of-pearls-and-pirates-03', 'of-pearls-and-pirates-04',
    'of-pearls-and-pirates-05', 'of-pearls-and-pirates-06',
  ]);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD', 'NIGHTMARE']);
  for (const id of campaign!.scenarios) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('The Hammer of Thursagan campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'The_Hammer_of_Thursagan');
  assert.ok(campaign, 'The Hammer of Thursagan compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 11);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD', 'NIGHTMARE']);
  for (const id of campaign!.scenarios) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Dead Water campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Dead_Water');
  assert.ok(campaign, 'Dead Water compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 13);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD', 'NIGHTMARE']);
  for (const id of campaign!.scenarios) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Descent Into Darkness campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Descent_into_Darkness');
  assert.ok(campaign, 'Descent Into Darkness compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 12);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (const id of [
    'descent-into-darkness-01', 'descent-into-darkness-02', 'descent-into-darkness-03',
    'descent-into-darkness-04', 'descent-into-darkness-05', 'descent-into-darkness-06',
    'descent-into-darkness-07a', 'descent-into-darkness-07b', 'descent-into-darkness-07c',
    'descent-into-darkness-08', 'descent-into-darkness-09', 'descent-into-darkness-10',
    'descent-into-darkness-11',
  ]) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Sceptre of Fire campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Sceptre_of_Fire');
  assert.ok(campaign, 'Sceptre of Fire compiled from its [campaign]');
  assert.deepEqual(campaign!.scenarios, [
    'sceptre-of-fire-01', 'sceptre-of-fire-02', 'sceptre-of-fire-2t', 'sceptre-of-fire-2p5',
    'sceptre-of-fire-03', 'sceptre-of-fire-3t', 'sceptre-of-fire-04', 'sceptre-of-fire-4t',
    'sceptre-of-fire-05', 'sceptre-of-fire-06', 'sceptre-of-fire-07', 'sceptre-of-fire-08', 'sceptre-of-fire-09',
    // The whole campaign's ids no longer have to start with a number; `epilogue` is named from
    // its id slug and is reachable in the chain.
    'sceptre-of-fire-epilogue',
  ]);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (const id of [
    'sceptre-of-fire-01', 'sceptre-of-fire-02', 'sceptre-of-fire-03', 'sceptre-of-fire-04',
    'sceptre-of-fire-05', 'sceptre-of-fire-06', 'sceptre-of-fire-07', 'sceptre-of-fire-08',
    'sceptre-of-fire-09', 'sceptre-of-fire-2p5', 'sceptre-of-fire-2t', 'sceptre-of-fire-3t', 'sceptre-of-fire-4t',
    'sceptre-of-fire-epilogue',
  ]) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Northern Rebirth campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Northern_Rebirth');
  assert.ok(campaign, 'Northern Rebirth compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 16);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (const id of [
    'northern-rebirth-01', 'northern-rebirth-02-01', 'northern-rebirth-02-02', 'northern-rebirth-03',
    'northern-rebirth-04', 'northern-rebirth-05a-01', 'northern-rebirth-05a-02', 'northern-rebirth-06a',
    'northern-rebirth-07a', 'northern-rebirth-08a', 'northern-rebirth-09a', 'northern-rebirth-10a',
    'northern-rebirth-11a', 'northern-rebirth-12a', 'northern-rebirth-13a', 'northern-rebirth-14a',
  ]) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Son of the Black-Eye campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Son_of_the_Black-Eye');
  assert.ok(campaign, 'Son of the Black-Eye compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 18);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (let number = 1; number <= 19; number += 1) {
    const id = `son-of-the-black-eye-${String(number).padStart(2, '0')}`;
    assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
  }
});

test('The Rise of Wesnoth campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'The_Rise_of_Wesnoth');
  assert.ok(campaign, 'The Rise of Wesnoth compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 22);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD']);
  for (const id of [
    'the-rise-of-wesnoth-01', 'the-rise-of-wesnoth-02', 'the-rise-of-wesnoth-03',
    'the-rise-of-wesnoth-04a', 'the-rise-of-wesnoth-04b', 'the-rise-of-wesnoth-05',
    'the-rise-of-wesnoth-06', 'the-rise-of-wesnoth-07', 'the-rise-of-wesnoth-08',
    'the-rise-of-wesnoth-09', 'the-rise-of-wesnoth-10', 'the-rise-of-wesnoth-11',
    'the-rise-of-wesnoth-12', 'the-rise-of-wesnoth-13', 'the-rise-of-wesnoth-14',
    'the-rise-of-wesnoth-15', 'the-rise-of-wesnoth-16', 'the-rise-of-wesnoth-17a',
    'the-rise-of-wesnoth-17b', 'the-rise-of-wesnoth-17c', 'the-rise-of-wesnoth-17d',
    'the-rise-of-wesnoth-18', 'the-rise-of-wesnoth-19', 'the-rise-of-wesnoth-20',
    'the-rise-of-wesnoth-21', 'the-rise-of-wesnoth-22', 'the-rise-of-wesnoth-23',
  ]) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('Winds of Fate campaign scenarios are compiled from real WML', () => {
  const campaign = CAMPAIGNS.find((entry) => entry.id === 'Winds_of_Fate');
  assert.ok(campaign, 'Winds of Fate compiled from its [campaign]');
  assert.equal(campaign!.scenarios.length, 16);
  assert.deepEqual(campaign!.difficulties.map((difficulty) => difficulty.id), ['EASY', 'NORMAL', 'HARD', 'NIGHTMARE']);
  for (const id of [
    'winds-of-fate-01', 'winds-of-fate-02', 'winds-of-fate-02x', 'winds-of-fate-03',
    'winds-of-fate-03x', 'winds-of-fate-04', 'winds-of-fate-05', 'winds-of-fate-05x',
    'winds-of-fate-06', 'winds-of-fate-06x', 'winds-of-fate-07', 'winds-of-fate-08',
    'winds-of-fate-09', 'winds-of-fate-10', 'winds-of-fate-11', 'winds-of-fate-12',
  ]) assert.ok(SCENARIOS[id], `${id} is in the scenario registry`);
});

test('recall traits are rebuilt, not re-rolled', () => {
  const plain = makeUnitWithTraits(GAME_DATA, 'Spearman', 1, 0, 0, []);
  const quick = makeUnitWithTraits(GAME_DATA, 'Spearman', 1, 0, 0, ['quick']);
  assert.deepEqual(quick.traits, ['quick']);
  assert.deepEqual(plain.traits, []);
  // `quick` is +1 movement and -5% hitpoints in the real trait data.
  assert.equal(quick.maxMovement, plain.maxMovement + 1);
  assert.ok(quick.maxHitpoints < plain.maxHitpoints);
});

test('carry-over keeps traits, loyalty and granted abilities', () => {
  const carryover = carryoverFor({
    from: 'two-brothers-01',
    to: 'two-brothers-02',
    gold: 100,
    bonusGold: 30,
    units: [
      { typeId: 'Spearman', name: 'Arvith', side: 1, hitpoints: 20, experience: 12, traits: ['quick', 'strong'], loyal: true, extraAbilities: ['leadership'] },
      { typeId: 'Orcish Grunt', name: 'Grunt', side: 2, hitpoints: 10, experience: 0 },
    ],
  });
  assert.equal(carryover.gold, 80 + 30, '80% of 100 plus the 30 early-finish gold');
  assert.equal(carryover.bonus, 30);
  assert.deepEqual(carryover.units, [
    { typeId: 'Spearman', name: 'Arvith', hitpoints: 20, experience: 12, traits: ['quick', 'strong'], loyal: true, extraAbilities: ['leadership'] },
  ]);
  const lines = describeCarryover(carryover, 100);
  assert.match(lines[1], /40 \+ 30|early-finish/, 'the bonus is in the summary');
  assert.match(lines[1], /including a 30 early-finish bonus/);
});
