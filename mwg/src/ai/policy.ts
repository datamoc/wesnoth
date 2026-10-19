/**
 * AI policy: the tunable weights the planner reads, derived from the
 * difficulty the player chose and from a scenario's `[ai]` aspects.
 *
 * Wesnoth's real AI exposes dozens of aspects (`src/ai/composite/aspect.cpp`,
 * `[ai] aggression=`, `caution=`, `grouping=`, ...). The port keeps the three
 * that actually move a decision here, maps them onto the same names the real
 * WML uses, and records the rest as not ported in `PORT_COVERAGE.md`.
 */

import type { CandidateSetting } from './candidates.ts';

export type Difficulty = 'easy' | 'normal' | 'hard';

export type AiStage = 'recruitment' | 'healing' | 'combat' | 'villages' | 'movement';
export const DEFAULT_AI_STAGES: readonly AiStage[] = ['recruitment', 'healing', 'combat', 'villages', 'movement'];

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];

export interface AiPolicy {
  /** how strongly expected damage dealt is valued */
  aggression: number;
  /** how strongly expected damage taken and standing threat are avoided */
  caution: number;
  /** how strongly villages (income, support, healing) are valued */
  greed: number;
  /** how strongly units prefer to remain near allied units */
  grouping: number;
  /** how many units the side tries to field before saving gold */
  recruitLimit: number;
  /** gold the AI side starts the scenario with, on top of the scenario's own */
  bonusGold: number;
  /** extra income per turn the AI side receives */
  bonusIncome: number;
  /** 0 disables healing retreats; higher values pull wounded units to villages */
  healUrgency: number;
  /** Directives compiled from WML [goal]/[avoid] entries. */
  directives?: readonly AiDirective[];
  /** Enabled candidate-action phases, in the scenario's configured order. */
  stages: readonly AiStage[];
  /** A scenario's `[stage]`/`[candidate_action]` configuration (`src/ai/candidates.ts`). */
  candidates?: CandidateSetting;
}

export interface AiDirective {
  readonly kind: 'goal' | 'avoid';
  readonly x?: number;
  readonly y?: number;
  readonly radius: number;
  readonly value: number;
  readonly filter?: AiUnitFilter;
}

export interface AiUnitFilter {
  readonly id?: readonly string[];
  readonly side?: number;
  readonly type?: readonly string[];
  readonly notType?: readonly string[];
  readonly level?: number;
  readonly alignment?: readonly string[];
  readonly canRecruit?: boolean;
}

/**
 * The shipped default, close to Wesnoth's `[default_ai]` aspects: aggression
 * 0.4, caution 0.25 and grouping 0.5 in the real engine, scaled here into the
 * planner's own units. `normal` is the baseline; `easy` and `hard` are the
 * documented deltas.
 */
export const DEFAULT_POLICY: AiPolicy = {
  aggression: 1,
  caution: 0.9,
  greed: 1.1,
  grouping: 0.5,
  recruitLimit: 6,
  bonusGold: 0,
  bonusIncome: 0,
  healUrgency: 1,
  stages: DEFAULT_AI_STAGES,
};

export function policyFor(difficulty: Difficulty): AiPolicy {
  switch (difficulty) {
    case 'easy':
      return { ...DEFAULT_POLICY, aggression: 0.7, caution: 0.7, greed: 0.9, grouping: 0.35, recruitLimit: 4, bonusGold: -25, bonusIncome: -1, healUrgency: 0.7 };
    case 'hard':
      return { ...DEFAULT_POLICY, aggression: 1.3, caution: 1.1, greed: 1.2, grouping: 0.65, recruitLimit: 8, bonusGold: 50, bonusIncome: 1, healUrgency: 1.3 };
    default:
      return { ...DEFAULT_POLICY };
  }
}

/** The `[ai]` attributes the port reads, as the raw WML strings. */
export interface AiAspects {
  aggression?: string;
  caution?: string;
  greed?: string;
  grouping?: string;
  stages?: string;
  /** comma-separated candidate action ids a scenario's `[stage]` enables */
  candidates?: string;
  /** comma-separated candidate action ids a scenario disabled */
  disabledCandidates?: string;
  /** `id:score` pairs from `[candidate_action] max_score=` overrides */
  candidateScores?: string;
}

/**
 * Fold a scenario's `[ai]` attributes over a difficulty policy. The real
 * engine's `aggression`/`caution` are 0..1 fractions; the planner's weights are
 * their 1.0-centred equivalents, so `aggression=0.6` becomes a 1.5 multiplier
 * and `caution=0.1` a 0.4 multiplier.
 */
export function applyAspects(policy: AiPolicy, aspects: AiAspects | undefined): AiPolicy {
  if (!aspects) return policy;
  const next = { ...policy };
  const number = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const aggression = number(aspects.aggression);
  if (aggression !== null) next.aggression = policy.aggression * (aggression / 0.4);
  const caution = number(aspects.caution);
  if (caution !== null) next.caution = policy.caution * (caution / 0.25);
  const greed = number(aspects.greed);
  if (greed !== null) next.greed = policy.greed * (greed / 0.5);
  const grouping = number(aspects.grouping);
  // The real aspect is a formation preference. Keep the historical caution
  // nudge for compatibility, but retain a separate grouping weight so the
  // planner can score ally proximity directly.
  if (grouping !== null) next.caution = next.caution * (1 + grouping * 0.4);
  if (grouping !== null) next.grouping = policy.grouping * (grouping / 0.5);
  if (aspects.stages) next.stages = parseAiStages(aspects.stages);
  const candidates = parseCandidateSetting(aspects);
  if (candidates) next.candidates = candidates;
  return next;
}

/** Read a scenario's candidate-action configuration out of its `[ai]` blocks. */
export function parseCandidateSetting(aspects: AiAspects): CandidateSetting | null {
  const list = (value: string | undefined): string[] =>
    (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const scores: Record<string, number> = {};
  for (const entry of list(aspects.candidateScores)) {
    const [id, score] = entry.split(':');
    const parsed = Number(score);
    if (id && Number.isFinite(parsed) && parsed > 0) scores[id] = parsed;
  }
  const enabled = list(aspects.candidates);
  const disabled = list(aspects.disabledCandidates);
  if (!enabled.length && !disabled.length && !Object.keys(scores).length) return null;
  return {
    ...(enabled.length ? { enabled } : {}),
    ...(disabled.length ? { disabled } : {}),
    ...(Object.keys(scores).length ? { scores } : {}),
  };
}

/** Parse a comma-separated stage list emitted by the scenario loader. */
export function parseAiStages(value: string): readonly AiStage[] {
  const valid = new Set<AiStage>(DEFAULT_AI_STAGES);
  const stages = value.split(',').map((entry) => entry.trim()).filter((entry): entry is AiStage => valid.has(entry as AiStage));
  return stages.length ? [...new Set(stages)] : DEFAULT_AI_STAGES;
}
