/**
 * The port's side planner.
 *
 * Where the previous stand-in chased the nearest enemy, this scores candidate
 * positions and attacks the way the real AI's candidate actions do
 * (`src/ai/default/`), in the port's own units:
 *
 * - **Evaluation** (`attack` scoring): expected damage dealt and taken come from
 *   the engine's own `predictAttack`, so CTH, resistances, leadership, time of
 *   day and retaliation all flow through the real rules.
 * - **Threat map** (rung c): every visible enemy projects its best expected
 *   damage onto the hexes it could attack from next turn; moving into threat is
 *   penalised, which is what keeps the AI from feeding units one at a time.
 * - **Villages and healing** (rung b): taking an enemy or neutral village is
 *   worth gold and support, and a wounded unit values resting on its own village
 *   (the real 8 HP village heal).
 * - **Unit preservation** (rung b): a trade that would not kill is refused, and
 *   standing threat is subtracted from every candidate position.
 * - **ZoC** already lives in `movement.ts`'s `reachable`, so a candidate square
 *   the real engine would not let the unit stop on is never offered here.
 *
 * The result is a list of `AiAction`s. The scene executes them with the same
 * `moveUnit`/`attackWithRules`/`recruit` calls the human uses, so the AI cannot
 * cheap: it pays real movement, real terrain and real combat rolls.
 *
 * Deliberate reductions, recorded in `PORT_COVERAGE.md`: the planner is greedy
 * per unit and does not simulate earlier units' moves; it does not reproduce the
 * real AI's full candidate-action framework, keep-away maps or Lua stages.
 */

import { hexDistance, hexNeighbors } from 'mwg';
import { areAllied, isFogged, lawfulBonusAt, predictAttack, terrainCodeAt, vacantRecruitHexes, villageOwnerAt, type GameState } from '../simulation/game.ts';
import { key, movetypeOf, reachable } from '../simulation/movement.ts';
import { resolveTerrain } from '../simulation/terrain.ts';
import type { WesnothData } from '../simulation/types.ts';
import type { Unit } from '../simulation/unit.ts';
import { isHidden } from '../simulation/vision.ts';
import { activeCandidates } from './candidates.ts';
import { DEFAULT_POLICY, type AiPolicy, type AiUnitFilter } from './policy.ts';

export type AiAction =
  | { readonly kind: 'recruit'; readonly typeId: string; readonly x: number; readonly y: number }
  | { readonly kind: 'move'; readonly unitId: number; readonly x: number; readonly y: number }
  | { readonly kind: 'attack'; readonly unitId: number; readonly targetId: number; readonly attackName: string };

function hasStage(policy: AiPolicy, stage: AiPolicy['stages'][number]): boolean {
  return policy.stages.includes(stage);
}

export interface AiOptions {
  readonly policy?: AiPolicy;
  /** the side's recruit list, from the scenario's `[side] recruit=` */
  readonly recruitTypes?: readonly string[];
  /** the side's treasury, so recruitment can stop when it runs out */
  readonly gold?: number;
}

export interface AttackEvaluation {
  readonly attackName: string;
  /** expected damage this attack lands */
  readonly dealt: number;
  /** expected retaliation damage */
  readonly taken: number;
  /** approximate chance at least one strike kills the defender */
  readonly killChance: number;
  readonly score: number;
}

/** Enemies the side can actually see: not fogged and not hidden from it. */
export function enemiesVisibleTo(state: GameState, data: WesnothData, side: number): Unit[] {
  return state.units.filter((unit) => {
    if (areAllied(state, unit.side, side) || unit.hitpoints <= 0) return false;
    if (isFogged(state, data, side, unit.x, unit.y)) return false;
    const bonus = lawfulBonusAt(data, state, unit.x, unit.y);
    return !isHidden(state, data, unit, side, bonus);
  });
}

/** A unit's best expected strike damage, the weight its zone of threat carries. */
export function expectedStrikeDamage(unit: Unit): number {
  let best = 0;
  for (const attack of unit.attacks) best = Math.max(best, attack.damage * attack.number);
  // Without a target there is no CTH to read, so the projection assumes the
  // engine's average 50% hit chance; the real threat map computes per-defender.
  return best * 0.5;
}

/**
 * Threat per hex: what the visible enemies could land on a unit standing there
 * next turn. An enemy that can reach a hex, or any neighbour of it, may attack
 * it, so both are charged.
 */
export function threatMap(state: GameState, data: WesnothData, enemies: readonly Unit[], defender?: Unit): Map<string, number> {
  const threat = new Map<string, number>();
  for (const enemy of enemies) {
    const reach = reachable(state, data, enemy, { ignoreTurn: true, movement: enemy.maxMovement });
    const cells = new Map<string, number>();
    const charge = (attackerX: number, attackerY: number, targetX: number, targetY: number): void => {
      const x = targetX;
      const y = targetY;
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
      const cell = key(x, y);
      const damage = defender
        ? threatDamageAt(state, data, enemy, defender, attackerX, attackerY, x, y)
        : expectedStrikeDamage(enemy);
      if (damage > 0) cells.set(cell, Math.max(cells.get(cell) ?? 0, damage));
    };
    for (const cell of reach.keys()) {
      const [x, y] = cell.split(',').map(Number);
      if (defender) {
        for (const next of hexNeighbors(x, y)) charge(x, y, next.x, next.y);
      } else {
        charge(x, y, x, y);
        for (const next of hexNeighbors(x, y)) charge(x, y, next.x, next.y);
      }
    }
    // It can also attack without moving at all.
    for (const next of hexNeighbors(enemy.x, enemy.y)) charge(enemy.x, enemy.y, next.x, next.y);
    for (const [cell, damage] of cells) threat.set(cell, (threat.get(cell) ?? 0) + damage);
  }
  return threat;
}

/**
 * Expected damage against one defender on one candidate hex.  The real AI
 * threat projection evaluates candidate actions against the defender's
 * terrain, rather than using a universal 50% hit chance.  Temporarily moving
 * the two existing units keeps the rules engine's leadership/flanking and
 * lawful-bonus calculations on the same positions the candidate represents.
 */
function threatDamageAt(state: GameState, data: WesnothData, attacker: Unit, defender: Unit, attackerX: number, attackerY: number, defenderX: number, defenderY: number): number {
  if (hexDistance({ x: attackerX, y: attackerY }, { x: defenderX, y: defenderY }) !== 1) return 0;
  const originalAttackerX = attacker.x;
  const originalAttackerY = attacker.y;
  const originalDefenderX = defender.x;
  const originalDefenderY = defender.y;
  attacker.x = attackerX;
  attacker.y = attackerY;
  defender.x = defenderX;
  defender.y = defenderY;
  try {
    let best = 0;
    for (const attack of attacker.attacks) {
      const prediction = predictAttack(state, data, attacker, defender, attack.name);
      if (!prediction) continue;
      best = Math.max(best, (prediction.cth / 100) * prediction.damage * prediction.strikes);
    }
    return best;
  } finally {
    attacker.x = originalAttackerX;
    attacker.y = originalAttackerY;
    defender.x = originalDefenderX;
    defender.y = originalDefenderY;
  }
}

/** Score one attack from the attacker's current square. */
export function evaluateAttack(state: GameState, data: WesnothData, attacker: Unit, defender: Unit, policy: AiPolicy): AttackEvaluation | null {
  let best: AttackEvaluation | null = null;
  for (const attack of attacker.attacks) {
    const prediction = predictAttack(state, data, attacker, defender, attack.name);
    if (!prediction) continue;
    const hitChance = Math.max(0, Math.min(1, prediction.cth / 100));
    const dealt = hitChance * prediction.damage * prediction.strikes;
    const taken = Math.max(0, Math.min(1, prediction.defenderCth / 100)) * prediction.defenderDamage * prediction.defenderStrikes;
    const oneStrikeKills = prediction.damage >= defender.hitpoints;
    const allStrikesKill = prediction.damage * prediction.strikes >= defender.hitpoints;
    const killChance = oneStrikeKills
      ? 1 - Math.pow(1 - hitChance, prediction.strikes)
      : allStrikesKill
        ? 0.5 * (1 - Math.pow(1 - hitChance, prediction.strikes))
        : 0;
    let score = dealt * (1 + defender.level * 0.15) * policy.aggression;
    score += killChance * (3 + defender.level * 5);
    score -= taken * policy.caution;
    // A trade that cannot kill is refused when it would kill the attacker.
    if (taken >= attacker.hitpoints && killChance < 0.5) score -= 20 + attacker.level * 5;
    if (!best || score > best.score) best = { attackName: attack.name, dealt, taken, killChance, score };
  }
  return best;
}

interface AttackPlan {
  readonly target: Unit;
  readonly evaluation: AttackEvaluation;
}

/**
 * The best attack this unit can make from `(x, y)`. The unit is moved there for
 * the duration of the evaluation so `predictAttack` sees the candidate terrain,
 * leadership and flanking, then restored; nothing else reads the temporary
 * position.
 */
function bestAttackFrom(
  state: GameState,
  data: WesnothData,
  unit: Unit,
  x: number,
  y: number,
  enemies: readonly Unit[],
  policy: AiPolicy,
): AttackPlan | null {
  const adjacent = enemies.filter((enemy) => enemy.hitpoints > 0 && hexDistance({ x, y }, enemy) === 1);
  if (!adjacent.length) return null;
  const fromX = unit.x;
  const fromY = unit.y;
  unit.x = x;
  unit.y = y;
  try {
    let best: AttackPlan | null = null;
    for (const target of adjacent) {
      const evaluation = evaluateAttack(state, data, unit, target, policy);
      if (evaluation && (!best || evaluation.score > best.evaluation.score)) best = { target, evaluation };
    }
    return best;
  } finally {
    unit.x = fromX;
    unit.y = fromY;
  }
}

/** The target the side is advancing on: nearest visible enemy, else its keeps. */
function nearestTarget(state: GameState, side: number, enemies: readonly Unit[], x: number, y: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    const distance = hexDistance({ x, y }, enemy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: enemy.x, y: enemy.y };
    }
  }
  if (best) return best;
  for (const other of state.sides) {
    if (other === side) continue;
    for (const keep of state.keeps.get(other) ?? []) {
      const distance = hexDistance({ x, y }, keep);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = keep;
      }
    }
  }
  return best;
}

/** How good standing on `(x, y)` is: terrain, villages, healing, threat, pressure. */
function positionScore(
  state: GameState,
  data: WesnothData,
  side: number,
  unit: Unit,
  x: number,
  y: number,
  threat: Map<string, number>,
  enemies: readonly Unit[],
  policy: AiPolicy,
): number {
  const terrain = resolveTerrain(data, movetypeOf(data, unit), terrainCodeAt(state, x, y));
  let score = terrain.defense * 0.03 * policy.caution;
  for (const directive of policy.directives ?? []) {
    if (directive.filter) {
      const targets = state.units.filter((candidate) => matchesAiFilter(candidate, directive.filter!));
      if (targets.length) {
        // This is the adapter's compact approximation of the composite AI's
        // target-map candidates: the nearest matching live unit supplies the
        // attraction/repulsion point for this unit's candidate hex.
        const distance = Math.min(...targets.map((target) => hexDistance({ x, y }, target)));
        if (directive.kind === 'goal') score += (directive.value * 4) / (distance + 1);
        else if (distance <= directive.radius) score -= directive.value * (directive.radius - distance + 1);
      }
    }
    if (directive.x !== undefined && directive.y !== undefined) {
      const distance = hexDistance({ x, y }, { x: directive.x, y: directive.y });
      if (directive.kind === 'goal') score += (directive.value * 4) / (distance + 1);
      else if (distance <= directive.radius) score -= directive.value * (directive.radius - distance + 1);
    }
  }
  const owner = villageOwnerAt(state, x, y);
  if (terrain.isVillage) {
    if (owner !== side && hasStage(policy, 'villages')) score += 3.5 * policy.greed;
    else if (unit.hitpoints < unit.maxHitpoints && hasStage(policy, 'healing')) score += 2.5 * policy.greed * policy.healUrgency;
  }
  score -= (threat.get(key(x, y)) ?? 0) * 0.4 * policy.caution;
  const target = nearestTarget(state, side, enemies, x, y);
  if (target) score -= hexDistance({ x, y }, target) * 0.6;
  if (policy.grouping > 0) {
    const nearestAlly = state.units
      .filter((ally) => ally.id !== unit.id && ally.side === side && ally.hitpoints > 0)
      .reduce((distance, ally) => Math.min(distance, hexDistance({ x, y }, ally)), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nearestAlly)) score -= nearestAlly * 0.15 * policy.grouping;
  }
  return score;
}

function matchesAiFilter(unit: Unit, filter: AiUnitFilter): boolean {
  if (unit.hitpoints <= 0) return false;
  if (filter.id !== undefined && !filter.id.some((id) => unit.wmlId === id || unit.name === id)) return false;
  if (filter.side !== undefined && unit.side !== filter.side) return false;
  if (filter.type?.length && !filter.type.includes(unit.typeId)) return false;
  if (filter.notType?.includes(unit.typeId)) return false;
  if (filter.level !== undefined && unit.level !== filter.level) return false;
  if (filter.alignment?.length && !filter.alignment.includes(unit.alignment)) return false;
  if (filter.canRecruit !== undefined && unit.canRecruit !== filter.canRecruit) return false;
  return true;
}


function planRecruitment(
  state: GameState,
  data: WesnothData,
  side: number,
  policy: AiPolicy,
  recruitTypes: readonly string[],
  gold: number,
): AiAction[] {
  const actions: AiAction[] = [];
  const types = recruitTypes.filter((id) => data.unitTypes[id]);
  if (!types.length || !(state.keeps.get(side) ?? []).length) return actions;
  const free = vacantRecruitHexes(state, data, side);
  if (!free.length) return actions;
  let budget = gold;
  const byCost = [...types].sort((a, b) => data.unitTypes[b].cost - data.unitTypes[a].cost);
  let count = state.units.filter((unit) => unit.side === side && unit.hitpoints > 0).length;
  while (count < policy.recruitLimit && free.length > 0) {
    const affordable = byCost.filter((id) => data.unitTypes[id].cost <= budget);
    if (!affordable.length) break;
    // Mostly the strongest affordable unit, with a cheap filler every third
    // recruit so the side is not all officers; the real AI keeps a mixed force.
    const pick = count % 3 === 2 ? affordable[affordable.length - 1] : affordable[0];
    const hex = free.shift()!;
    actions.push({ kind: 'recruit', typeId: pick, x: hex.x, y: hex.y });
    budget -= data.unitTypes[pick].cost;
    count += 1;
  }
  return actions;
}

interface UnitPlan {
  x: number;
  y: number;
  moved: boolean;
  attack: AttackPlan | null;
  score: number;
}

function bestPlanForUnit(
  state: GameState,
  data: WesnothData,
  side: number,
  unit: Unit,
  enemies: readonly Unit[],
  threat: Map<string, number>,
  occupied: Set<string>,
  policy: AiPolicy,
  allowMovement: boolean,
  allowCombat: boolean,
): UnitPlan {
  const stay = positionScore(state, data, side, unit, unit.x, unit.y, threat, enemies, policy);
  let best: UnitPlan = { x: unit.x, y: unit.y, moved: false, attack: null, score: stay };

  for (const cell of allowMovement ? reachable(state, data, unit).keys() : []) {
    if (occupied.has(cell)) continue;
    const [x, y] = cell.split(',').map(Number);
    const base = positionScore(state, data, side, unit, x, y, threat, enemies, policy);
    const attack = allowCombat ? bestAttackFrom(state, data, unit, x, y, enemies, policy) : null;
    const score = attack ? base + attack.evaluation.score : base;
    if (score > best.score) best = { x, y, moved: true, attack, score };
  }

  // A unit already next to a target may attack without moving at all.
  const here = allowCombat ? bestAttackFrom(state, data, unit, unit.x, unit.y, enemies, policy) : null;
  if (here) {
    const score = stay + here.evaluation.score;
    if (score > best.score) best = { x: unit.x, y: unit.y, moved: false, attack: here, score };
  }
  return best;
}

/**
 * Plan one side's whole turn: recruits first, then every unit's move and attack
 * in descending level order (leaders commit first). The scene executes the
 * returned actions; this function never mutates the game state.
 */
export function planSide(state: GameState, data: WesnothData, side: number, options: AiOptions = {}): AiAction[] {
  const policy = options.policy ?? DEFAULT_POLICY;
  const enemies = enemiesVisibleTo(state, data, side);
  // The enabled candidate actions, in the engine's own band order. A scenario
  // that disables one (`[candidate_action] id=combat enable=no`) stops the
  // decisions that candidate owns, the way the engine's loop never asks it.
  const candidates = activeCandidates(policy.candidates ?? {});
  const enabled = new Set(candidates.map((candidate) => candidate.id));
  const bandOf = new Map(candidates.map((candidate) => [candidate.id, candidate.maxScore]));
  const recruit = candidates.find((candidate) => candidate.port === 'recruit');
  const decisions: { candidate: string; rank: number; action: AiAction }[] = [];

  if (recruit && hasStage(policy, 'recruitment')) {
    for (const action of planRecruitment(state, data, side, policy, options.recruitTypes ?? [], options.gold ?? 0)) {
      decisions.push({ candidate: recruit.id, rank: 0, action });
    }
  }
  const occupied = new Set(state.units.filter((unit) => unit.hitpoints > 0).map((unit) => key(unit.x, unit.y)));
  const order = state.units
    .filter((unit) => unit.side === side && unit.hitpoints > 0 && !unit.petrified)
    .sort((a, b) => b.level - a.level || a.id - b.id);
  const movementAllowed = hasStage(policy, 'movement');
  // Combat is planned only while a combat candidate is enabled, so disabling
  // `combat`/`high_xp_attack` leaves the unit free to move instead of planning
  // an attack it is not allowed to make.
  const combatAllowed = hasStage(policy, 'combat') && (enabled.has('combat') || enabled.has('high_xp_attack'));

  for (const unit of order) {
    // Threat is defender-specific: a resilient unit and a fragile unit on the
    // same hex can expose very different risks because terrain changes CTH.
    const threat = threatMap(state, data, enemies, unit);
    const plan = bestPlanForUnit(
      state,
      data,
      side,
      unit,
      enemies,
      threat,
      occupied,
      policy,
      movementAllowed,
      combatAllowed,
    );
    if (!plan.moved && !plan.attack) continue;
    const candidate = classifyDecision(state, data, side, unit, plan, threat, enemies);
    if (!enabled.has(candidate)) continue;
    if (plan.moved && movementAllowed) {
      decisions.push({ candidate, rank: -unit.level, action: { kind: 'move', unitId: unit.id, x: plan.x, y: plan.y } });
      occupied.delete(key(unit.x, unit.y));
      occupied.add(key(plan.x, plan.y));
    }
    if (plan.attack && combatAllowed) {
      // The action's own candidate, so a scenario can disable attacks without
      // silently disabling the movement that set them up.
      const attackCandidate = killerCandidate(candidate) ?? candidate;
      if (!enabled.has(attackCandidate)) continue;
      decisions.push({
        candidate: attackCandidate,
        rank: -unit.level,
        action: { kind: 'attack', unitId: unit.id, targetId: plan.attack.target.id, attackName: plan.attack.evaluation.attackName },
      });
    }
  }
  // The engine's loop asks the highest band first; the port emits the finished
  // decisions in that same band order, keeping the unit order within a band.
  return decisions
    .sort((a, b) => (bandOf.get(b.candidate) ?? 0) - (bandOf.get(a.candidate) ?? 0) || a.rank - b.rank)
    .map((decision) => decision.action);
}

/** An attack decision belongs to a combat candidate, whatever moved the unit. */
function killerCandidate(candidate: string): string | null {
  switch (candidate) {
    case 'high_xp_attack':
    case 'combat':
      return candidate;
    case 'retreat':
    case 'retreat_injured':
    case 'villages':
    case 'grab_villages':
    case 'village_hunt':
    case 'healing':
    case 'place_healers':
      return 'combat';
    default:
      return null;
  }
}

/**
 * Which of the engine's candidate actions a finished decision corresponds to.
 * The port scores with the rules engine rather than with RCA aspects, so the
 * band is read off what the decision *is*: a kill attack is `high_xp_attack`,
 * any other attack `combat`, a wounded unit falling back `retreat_injured`,
 * taking a village `villages`, resting to heal `healing`, a healer covering
 * wounded allies `place_healers`, the leader staying near its keep
 * `move_leader_to_keep`, and any other advance `move_to_targets`.
 */
function classifyDecision(
  state: GameState,
  data: WesnothData,
  side: number,
  unit: Unit,
  plan: UnitPlan,
  threat: Map<string, number>,
  enemies: readonly Unit[],
): string {
  if (plan.attack) {
    const evaluation = plan.attack.evaluation;
    const worth = evaluation.killChance >= 0.5 || plan.attack.target.level > unit.level;
    return worth ? 'high_xp_attack' : 'combat';
  }
  const wounded = unit.hitpoints * 2 < unit.maxHitpoints;
  const standing = threat.get(key(unit.x, unit.y)) ?? 0;
  const arriving = threat.get(key(plan.x, plan.y)) ?? 0;
  if (wounded && arriving < standing) return 'retreat_injured';
  const terrain = resolveTerrain(data, movetypeOf(data, unit), terrainCodeAt(state, plan.x, plan.y));
  const owner = villageOwnerAt(state, plan.x, plan.y);
  if (terrain.isVillage && owner !== side) return 'villages';
  if (wounded && terrain.heals > 0 && owner === side) return 'healing';
  if (unit.canRecruit) {
    const keep = (state.keeps.get(side) ?? [])[0];
    if (keep && hexDistance({ x: plan.x, y: plan.y }, keep) <= 1) return 'move_leader_to_keep';
  }
  if (hasHealingAbility(data, unit) && woundedAllyAdjacent(state, side, unit, plan.x, plan.y)) return 'place_healers';
  const target = nearestTarget(state, side, enemies, plan.x, plan.y);
  return target ? 'move_to_targets' : 'move_to_any_enemy';
}

function hasHealingAbility(data: WesnothData, unit: Unit): boolean {
  const abilities = [...(data.unitTypes[unit.typeId]?.abilities ?? []), ...unit.extraAbilities];
  return abilities.some((id) => /heal|cure|regenerat/.test(id));
}

function woundedAllyAdjacent(state: GameState, side: number, healer: Unit, x: number, y: number): boolean {
  return state.units.some((ally) =>
    ally.id !== healer.id &&
    ally.side === side &&
    ally.hitpoints > 0 &&
    ally.hitpoints < ally.maxHitpoints &&
    hexDistance({ x, y }, ally) === 1);
}
