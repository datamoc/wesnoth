import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeGame, updateVision, type GameState } from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import { applyAspects, policyFor } from '../src/ai/policy.ts';
import { enemiesVisibleTo, evaluateAttack, expectedStrikeDamage, planSide, threatMap } from '../src/ai/plan.ts';

const WIDTH = 7;
const HEIGHT = 3;

/** A 7x3 grass field with a village at 0,1 and keeps at the two ends. */
function field(overrides: Record<string, string> = {}): GameState {
  const codes: string[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) codes.push(overrides[`${x},${y}`] ?? 'Gg');
  }
  const keeps = new Map([
    [1, [{ x: 0, y: 0 }]],
    [2, [{ x: 6, y: 1 }]],
  ]);
  const state = makeGame(WIDTH, HEIGHT, codes, keeps);
  state.sides = [1, 2];
  state.turn = 2;
  return state;
}

function place(state: GameState, typeId: string, side: number, x: number, y: number) {
  const unit = makeUnit(GAME_DATA, typeId, side, x, y, () => 0);
  unit.movement = unit.maxMovement;
  state.units.push(unit);
  return unit;
}

test('the AI attacks an adjacent enemy through the real rules', () => {
  const state = field({ '4,1': 'Gg' });
  const grunt = place(state, 'Orcish Grunt', 2, 3, 1);
  const target = place(state, 'Bowman', 1, 4, 1);
  updateVision(state, GAME_DATA);

  assert.equal(enemiesVisibleTo(state, GAME_DATA, 2).length, 1, 'the adjacent enemy is visible');
  const actions = planSide(state, GAME_DATA, 2, { policy: policyFor('normal') });
  const attack = actions.find((action) => action.kind === 'attack');
  assert.ok(attack, 'an attack is planned');
  assert.equal(attack!.kind === 'attack' ? attack!.unitId : -1, grunt.id);
  assert.equal(attack!.kind === 'attack' ? attack!.targetId : -1, target.id);
});

test('a much stronger defender is not attacked into a losing trade', () => {
  const state = field();
  const grunt = place(state, 'Orcish Grunt', 2, 3, 1);
  const bowman = place(state, 'Bowman', 1, 4, 1);
  const cavalry = place(state, 'Cavalryman', 1, 3, 2);
  updateVision(state, GAME_DATA);

  const versusWeak = evaluateAttack(state, GAME_DATA, grunt, bowman, policyFor('normal'));
  const versusStrong = evaluateAttack(state, GAME_DATA, grunt, cavalry, policyFor('normal'));
  assert.ok(versusWeak && versusStrong);
  assert.ok(versusWeak!.score > versusStrong!.score, 'the weaker target scores higher');
  assert.equal(versusStrong!.taken > versusWeak!.taken, true, 'the stronger defender retaliates harder');
});

test('a wounded unit retreats to its own village', () => {
  const state = field({ '0,1': 'Gg^Ve' });
  const wounded = place(state, 'Orcish Grunt', 2, 2, 1);
  wounded.hitpoints = Math.max(1, Math.floor(wounded.maxHitpoints * 0.2));
  updateVision(state, GAME_DATA);

  const actions = planSide(state, GAME_DATA, 2, { policy: policyFor('normal') });
  const move = actions.find((action) => action.kind === 'move');
  assert.ok(move, 'the wounded unit moves');
  assert.equal(move!.kind === 'move' ? `${move!.x},${move!.y}` : '', '0,1', 'it reaches the heal village');
});

test('an idle unit claims an unclaimed village', () => {
  const state = field({ '0,1': 'Gg^Ve' });
  place(state, 'Orcish Grunt', 2, 2, 1);
  updateVision(state, GAME_DATA);

  const actions = planSide(state, GAME_DATA, 2, { policy: policyFor('normal') });
  const move = actions.find((action) => action.kind === 'move');
  assert.equal(move!.kind === 'move' ? `${move!.x},${move!.y}` : '', '0,1');
});

test('the threat map charges the hexes a strong enemy could attack', () => {
  const state = field();
  place(state, 'Orcish Grunt', 2, 2, 1);
  const enemy = place(state, 'Cavalryman', 1, 4, 1);
  updateVision(state, GAME_DATA);
  const enemies = enemiesVisibleTo(state, GAME_DATA, 2);
  assert.equal(enemies.length, 1);
  const threat = threatMap(state, GAME_DATA, enemies);
  const adjacent = threat.get('3,1') ?? 0;
  const far = threat.get('0,2') ?? 0;
  assert.ok(adjacent > 0, 'the hex next to the enemy is threatened');
  assert.ok(adjacent > far, 'the near hex is threatened more than the far one');
  assert.equal(expectedStrikeDamage(enemy) > 0, true);
});

test('the threat map uses the defender terrain for chance to hit', () => {
  const state = field({ '3,2': 'Gg^Fp' });
  place(state, 'Orcish Grunt', 2, 2, 1);
  const enemy = place(state, 'Cavalryman', 1, 4, 1);
  const defender = place(state, 'Bowman', 2, 0, 1);
  updateVision(state, GAME_DATA);

  const exact = threatMap(state, GAME_DATA, [enemy], defender);
  const grass = exact.get('3,1') ?? 0;
  const forest = exact.get('3,2') ?? 0;
  assert.ok(grass > 0 && forest > 0, 'both candidate hexes are in threat range');
  assert.ok(forest > grass, 'forest defense raises the projected hit chance');
});

test('recruitment spends gold on the side recruit list and stops at the limit', () => {
  const state = field({ '5,0': 'Ch', '5,1': 'Ch', '5,2': 'Ch', '6,0': 'Ch', '6,2': 'Ch' });
  updateVision(state, GAME_DATA);
  const actions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), recruitLimit: 3 },
    recruitTypes: ['Orcish Grunt', 'Orcish Archer'],
    gold: 100,
  });
  const recruits = actions.filter((action) => action.kind === 'recruit');
  assert.equal(recruits.length, 3, 'three recruits at the limit');
  const spent = recruits.reduce((total, action) => total + GAME_DATA.unitTypes[action.kind === 'recruit' ? action.typeId : ''].cost, 0);
  assert.ok(spent <= 100, 'the side never overspends');
});

test('difficulty changes the policy, and [ai] aspects scale it', () => {
  const easy = policyFor('easy');
  const normal = policyFor('normal');
  const hard = policyFor('hard');
  assert.ok(easy.aggression < normal.aggression && normal.aggression < hard.aggression);
  assert.ok(easy.bonusGold < 0 && hard.bonusGold > 0);
  const aggressive = applyAspects(normal, { aggression: '0.8' });
  assert.ok(aggressive.aggression > normal.aggression, 'a higher aggression aspect raises the weight');
  const cautious = applyAspects(normal, { caution: '0.5' });
  assert.ok(cautious.caution > normal.caution);
  const grouped = applyAspects(normal, { grouping: '1.0' });
  assert.ok(grouped.grouping > normal.grouping, 'a higher grouping aspect raises formation preference');
});

test('grouping prefers a candidate closer to an allied unit', () => {
  const state = field();
  const unit = place(state, 'Orcish Grunt', 2, 3, 1);
  place(state, 'Orcish Archer', 2, 1, 1);
  updateVision(state, GAME_DATA);
  const actions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), grouping: 20, aggression: 0, greed: 0 },
  });
  const move = actions.find((action) => action.kind === 'move' && action.unitId === unit.id);
  assert.ok(move && move.kind === 'move');
  assert.ok(move.x <= 2, 'the unit moves toward its ally when grouping dominates');
});

test('candidate-action stages can disable combat while retaining movement', () => {
  const state = field();
  const grunt = place(state, 'Orcish Grunt', 2, 3, 1);
  place(state, 'Bowman', 1, 5, 1);
  updateVision(state, GAME_DATA);
  const actions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), stages: ['movement'], directives: [{ kind: 'goal', x: 0, y: 1, radius: 0, value: 20 }] },
  });
  assert.equal(actions.some((action) => action.kind === 'attack'), false);
  assert.ok(actions.some((action) => action.kind === 'move' && action.unitId === grunt.id));
});

test('candidate actions run in the engine band order', () => {
  const state = field({ '0,1': 'Gg^Ve' });
  // A recruit (band 180000) and a combat decision (band 100000) in one turn:
  // the engine's RCA loop asks the higher band first, and so does the port.
  place(state, 'Orcish Grunt', 2, 3, 1);
  place(state, 'Bowman', 1, 4, 1);
  updateVision(state, GAME_DATA);
  const actions = planSide(state, GAME_DATA, 2, {
    policy: policyFor('normal'),
    recruitTypes: ['Orcish Grunt', 'Wolf Rider'],
    gold: 100,
  });
  const firstRecruit = actions.findIndex((action) => action.kind === 'recruit');
  const firstCombat = actions.findIndex((action) => action.kind === 'attack');
  assert.ok(firstRecruit >= 0, 'the side recruits');
  assert.ok(firstCombat >= 0, 'the side attacks');
  assert.ok(firstRecruit < firstCombat, 'recruitment outranks combat');

  // Disabling the candidate by its engine id stops the decisions it owns: a
  // scenario's `[candidate_action] id=combat enable=no` really disarms the side.
  const disabled = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), candidates: { disabled: ['combat', 'high_xp_attack'] } },
    recruitTypes: ['Orcish Grunt'],
    gold: 100,
  });
  assert.equal(disabled.some((action) => action.kind === 'attack'), false);
  assert.ok(disabled.some((action) => action.kind === 'recruit'), 'the rest of the plan still runs');
  // A `max_score` override moves the decision in the band order.
  const retuned = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), candidates: { scores: { recruitment: 1000 } } },
    recruitTypes: ['Orcish Grunt'],
    gold: 100,
  });
  const retunedRecruit = retuned.findIndex((action) => action.kind === 'recruit');
  const retunedAttack = retuned.findIndex((action) => action.kind === 'attack');
  assert.ok(retunedRecruit > retunedAttack, 'retuning recruitment below combat reorders them');
});

test('location goals and avoid zones steer candidate positions', () => {
  const state = field();
  const unit = place(state, 'Orcish Grunt', 2, 3, 1);
  updateVision(state, GAME_DATA);
  const goalActions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), directives: [{ kind: 'goal', x: 0, y: 1, radius: 0, value: 10 }] },
  });
  const goalMove = goalActions.find((action) => action.kind === 'move');
  assert.ok(goalMove && goalMove.kind === 'move');
  assert.equal(`${goalMove.x},${goalMove.y}`, '0,1', 'the planner advances toward a target location');

  const avoidActions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), directives: [{ kind: 'avoid', x: 3, y: 1, radius: 2, value: 10 }] },
  });
  const avoidMove = avoidActions.find((action) => action.kind === 'move');
  assert.ok(avoidMove && avoidMove.kind === 'move');
  assert.notEqual(`${avoidMove.x},${avoidMove.y}`, `${unit.x},${unit.y}`, 'an avoid zone penalizes staying inside it');
});

test('unit criteria goals steer toward matching units', () => {
  const state = field();
  const unit = place(state, 'Orcish Grunt', 2, 3, 1);
  const target = place(state, 'Bowman', 1, 1, 1);
  updateVision(state, GAME_DATA);
  const actions = planSide(state, GAME_DATA, 2, {
    policy: { ...policyFor('normal'), directives: [{ kind: 'goal', radius: 0, value: 20, filter: { side: 1, type: ['Bowman'] } }] },
  });
  const move = actions.find((action) => action.kind === 'move' && action.unitId === unit.id);
  assert.ok(move && move.kind === 'move');
  assert.ok(Math.abs(move.x - target.x) + Math.abs(move.y - target.y) < 4, 'the unit advances toward the filtered target');
});
