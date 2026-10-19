/**
 * The engine's candidate actions, as data.
 *
 * Wesnoth's default AI is a register-candidate-action (RCA) loop: a `[stage]`
 * holds candidate actions, each with a `max_score` band, and the loop keeps
 * asking the enabled ones for their best scored action until none wants to act
 * (`src/ai/composite/stage.cpp`, `ai_default_rca::candidate_action_evaluation_loop`).
 * The ids and bands below are the real ones, from
 * `data/core/macros/ai_candidate_actions.cfg`, and the enabled set is the
 * `main_loop` stage of `data/ai/ais/ai_default_rca.cfg`.
 *
 * The port cannot run that loop literally: its planner is greedy per unit and
 * returns a whole turn's plan, and its scores come from the rules engine's own
 * damage predictions rather than from an aspect-driven evaluation. So the port
 * classifies each finished decision into the candidate action it corresponds to
 * and emits the decisions in the engine's band order, which is what makes
 * recruitment precede combat, retreat precede attack, and healing follow it.
 * Anything the port has no capability for stays in the table as data, so a
 * scenario naming it in `[candidate_action]` is understood rather than dropped.
 */

/** What the port can actually do for a candidate action. */
export type PortCapability =
  | 'recruit'
  | 'retreat'
  | 'combat'
  | 'healing'
  | 'villages'
  | 'movement'
  | 'leader'
  | null;

export interface CandidateActionDef {
  /** the engine's own id, the string `[candidate_action] id=` names */
  readonly id: string;
  /** the engine's `max_score`: the band this action reports in, and its rank */
  readonly maxScore: number;
  /** the port capability that stands in for it, or null when it is not ported */
  readonly port: PortCapability;
}

/** The stock candidate actions, in the engine's own band order. */
export const CANDIDATE_ACTIONS: readonly CandidateActionDef[] = [
  { id: 'goto', maxScore: 200000, port: 'movement' },
  { id: 'recruit_rushers', maxScore: 196000, port: 'recruit' },
  { id: 'castle_switch', maxScore: 195000, port: null },
  { id: 'retreat_injured', maxScore: 192000, port: 'retreat' },
  { id: 'grab_villages', maxScore: 191000, port: 'villages' },
  { id: 'spread_poison', maxScore: 190000, port: null },
  { id: 'recruitment', maxScore: 180000, port: 'recruit' },
  { id: 'move_leader_to_goals', maxScore: 140000, port: 'leader' },
  { id: 'move_leader_to_keep', maxScore: 120000, port: 'leader' },
  { id: 'high_xp_attack', maxScore: 100010, port: 'combat' },
  { id: 'combat', maxScore: 100000, port: 'combat' },
  { id: 'place_healers', maxScore: 96000, port: 'healing' },
  { id: 'healing', maxScore: 80000, port: 'healing' },
  { id: 'villages', maxScore: 60000, port: 'villages' },
  { id: 'retreat', maxScore: 40000, port: 'retreat' },
  { id: 'village_hunt', maxScore: 30000, port: 'villages' },
  { id: 'move_to_targets', maxScore: 20000, port: 'movement' },
  { id: 'leader_shares_keep', maxScore: 10000, port: 'leader' },
  { id: 'move_to_any_enemy', maxScore: 1000, port: 'movement' },
];

const BY_ID = new Map(CANDIDATE_ACTIONS.map((action) => [action.id, action]));

/**
 * The `main_loop` stage of `data/ai/ais/ai_default_rca.cfg`, in the order the
 * engine's own `{AI_CA_*}` macros register it. `spread_poison` and
 * `castle_switch` are registered there too, but the file lists them as
 * candidates the port has no capability for.
 */
export const DEFAULT_CANDIDATE_IDS: readonly string[] = [
  'goto',
  'retreat_injured',
  'spread_poison',
  'recruitment',
  'move_leader_to_goals',
  'move_leader_to_keep',
  'high_xp_attack',
  'combat',
  'place_healers',
  'healing',
  'villages',
  'move_to_targets',
  'leader_shares_keep',
  'move_to_any_enemy',
];

/** A scenario's `[candidate_action]`/`[stage]` configuration, as the loader reads it. */
export interface CandidateSetting {
  /** the ids the scenario's stages enable, in order; empty means the default set */
  readonly enabled?: readonly string[];
  /** `[candidate_action] max_score=` overrides, by id */
  readonly scores?: Readonly<Record<string, number>>;
  /** ids a scenario disabled with `[candidate_action] enable=no` */
  readonly disabled?: readonly string[];
}

/**
 * The candidate actions a side runs, enabled set first, in the engine's band
 * order: the loop asks the highest band first, whatever order a scenario
 * registered them in.
 */
export function activeCandidates(setting: CandidateSetting = {}): CandidateActionDef[] {
  const enabled = setting.enabled?.length ? new Set(setting.enabled) : new Set(DEFAULT_CANDIDATE_IDS);
  for (const id of setting.disabled ?? []) enabled.delete(id);
  return CANDIDATE_ACTIONS
    .filter((action) => enabled.has(action.id))
    .map((action) => {
      const override = setting.scores?.[action.id];
      return override === undefined ? action : { ...action, maxScore: override };
    })
    .sort((a, b) => b.maxScore - a.maxScore);
}

/**
 * `[candidate_action]` attributes the port acts on. The engine reads
 * `max_score`, `score` and `enabled`; a scenario that retunes one action moves
 * it in the port's band order the same way it moves in the engine's.
 */
export function candidateSettingFrom(attributes: Record<string, string>): { id: string; maxScore?: number; enabled?: boolean } | null {
  const id = attributes.id ?? attributes.name ?? '';
  if (!id || !BY_ID.has(id)) return null;
  const maxScore = Number(attributes.max_score ?? attributes.score);
  const enabled = attributes.enable === undefined && attributes.enabled === undefined
    ? undefined
    : (attributes.enable ?? attributes.enabled) !== 'no' && (attributes.enable ?? attributes.enabled) !== 'false';
  return { id, ...(Number.isFinite(maxScore) && maxScore > 0 ? { maxScore } : {}), ...(enabled === undefined ? {} : { enabled }) };
}
