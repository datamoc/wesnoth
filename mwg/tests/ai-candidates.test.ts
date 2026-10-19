import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_ACTIONS, DEFAULT_CANDIDATE_IDS, activeCandidates, candidateSettingFrom } from '../src/ai/candidates.ts';
import { applyAspects, policyFor } from '../src/ai/policy.ts';

/**
 * The composite AI scheduler (ROADMAP backlog: "Composite AI scheduler and
 * target filters").
 *
 * The table is data, and the data is the engine's: `max_score` bands come from
 * `data/core/macros/ai_candidate_actions.cfg` and the enabled set from the
 * `main_loop` stage in `data/ai/ais/ai_default_rca.cfg`. The first test reads
 * the real macro file, so a drift between the port's table and the engine's own
 * numbers fails the build.
 */
const wesnothRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the candidate action bands are the engine macros, read from the real file', () => {
  const source = readFileSync(path.join(wesnothRoot, 'data', 'core', 'macros', 'ai_candidate_actions.cfg'), 'utf8');
  const bands = new Map<string, number>();
  for (const match of source.matchAll(/#define\s+AI_CA_([A-Z0-9_]+?)_(?:MAX_)?SCORE\s*\n\s*(\d+)/g)) {
    bands.set(match[1].toLowerCase(), Number(match[2]));
  }
  assert.ok(bands.size >= 15, `read ${bands.size} score macros`);

  for (const action of CANDIDATE_ACTIONS) {
    // `high_xp_attack` uses the `_MAX_SCORE` macro, everything else `_SCORE`.
    const expected = bands.get(action.id) ?? bands.get(action.id.replace(/_/g, ''));
    assert.equal(action.maxScore, expected, `${action.id} band`);
  }
  // The port's rank order is the engine's, so the loop asks the same action first.
  const ranked = [...CANDIDATE_ACTIONS].sort((a, b) => b.maxScore - a.maxScore).map((action) => action.id);
  assert.deepEqual(ranked[0], 'goto');
  assert.ok(ranked.indexOf('retreat_injured') < ranked.indexOf('combat'));
  assert.ok(ranked.indexOf('combat') < ranked.indexOf('healing'));
  assert.ok(ranked.indexOf('healing') < ranked.indexOf('villages'));
  assert.ok(ranked.indexOf('villages') < ranked.indexOf('move_to_targets'));
});

test('the default enabled set is the engine default AI stage', () => {
  const source = readFileSync(path.join(wesnothRoot, 'data', 'ai', 'ais', 'ai_default_rca.cfg'), 'utf8');
  for (const id of DEFAULT_CANDIDATE_IDS) {
    assert.match(source, new RegExp(`AI_CA_${id.toUpperCase()}|\\b${id}\\b`), `${id} appears in the default AI stage`);
  }
  // `castle_switch` is registered as a candidate action but not enabled by default.
  assert.ok(!DEFAULT_CANDIDATE_IDS.includes('castle_switch'));
});

test('activeCandidates ranks by band and honours the scenario configuration', () => {
  assert.deepEqual(activeCandidates()[0].id, 'goto');
  assert.ok(activeCandidates().every((action, index, all) => index === 0 || all[index - 1].maxScore >= action.maxScore));

  const restricted = activeCandidates({ enabled: ['combat', 'healing'] });
  assert.deepEqual(restricted.map((action) => action.id), ['combat', 'healing']);

  const disabled = activeCandidates({ disabled: ['combat', 'high_xp_attack'] });
  assert.ok(!disabled.some((action) => action.port === 'combat'));

  const retuned = activeCandidates({ scores: { healing: 250000 } });
  assert.equal(retuned[0].id, 'healing');
});

test('candidateSettingFrom reads the engine attributes and ignores foreign ids', () => {
  assert.deepEqual(candidateSettingFrom({ id: 'combat', max_score: '150000' }), { id: 'combat', maxScore: 150000 });
  assert.deepEqual(candidateSettingFrom({ id: 'healing', enable: 'no' }), { id: 'healing', enabled: false });
  assert.deepEqual(candidateSettingFrom({ id: 'recruitment' }), { id: 'recruitment' });
  // An id the engine does not define (a custom AI action) is not the port's to invent.
  assert.equal(candidateSettingFrom({ id: 'my_custom_action' }), null);
  assert.equal(candidateSettingFrom({}), null);
});

test('policy aspects carry the scenario candidate configuration', () => {
  const policy = applyAspects(policyFor('normal'), {
    candidates: 'combat,healing',
    disabledCandidates: 'goto',
    candidateScores: 'healing:90000',
  });
  assert.deepEqual(policy.candidates, {
    enabled: ['combat', 'healing'],
    disabled: ['goto'],
    scores: { healing: 90000 },
  });
  // No candidate configuration leaves the default set in place.
  assert.equal(applyAspects(policyFor('normal'), { aggression: '0.5' }).candidates, undefined);
});
