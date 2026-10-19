import { MWL_DEFAULT_CARRYOVER_PERCENTAGE } from 'mwg/mwl';

/**
 * Campaign flow: the scenario order and what carries over between scenarios.
 *
 * MWL 0.1 has no campaign tags, so the port owns this for now. The real
 * campaign's `[campaign]` node is compiled into `CampaignDefinition` by
 * `tools/compile-campaign.ts` (see `src/generated/campaigns.ts`), so the order
 * and the difficulties come from the campaign's own files. The carry-over rules
 * follow Wesnoth's `[endlevel]`: a percentage of the treasury carries forward
 * and every surviving unit of your side recalls into the next scenario with its
 * hitpoints, experience and traits. Wesnoth's own defaults are all survivors and
 * an 80% gold share (`src/game_config.cpp:50`, `gold_carryover_percentage`); both are kept here; scenario UI owns the explicit
 * recall-list interaction.
 */

/**
 * Share of the treasury that survives a scenario (Wesnoth's `[endlevel]` default, 80).
 * The value is the framework's `MWL_DEFAULT_CARRYOVER_PERCENTAGE`, which mirrors the same
 * engine constant; this port used to carry an invented 40.
 */
export const CARRYOVER_GOLD_PERCENT = MWL_DEFAULT_CARRYOVER_PERCENTAGE;

/** One `[difficulty]` of a campaign, after the core macros expand. */
export interface CampaignDifficulty {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly default: boolean;
}

/** A campaign's own files: identity, difficulty list and scenario chain. */
export interface CampaignDefinition {
  readonly id: string;
  readonly title: string;
  readonly abbrev: string;
  readonly icon: string;
  readonly description: string;
  readonly firstScenario: string;
  readonly scenarios: readonly string[];
  readonly difficulties: readonly CampaignDifficulty[];
  readonly defaultDifficulty: string;
}

/** A unit that recalls into the next scenario. Traits are preserved, not re-rolled. */
export interface CarryoverUnit {
  readonly typeId: string;
  readonly name: string;
  readonly hitpoints: number;
  readonly experience: number;
  readonly traits?: readonly string[];
  readonly loyal?: boolean;
  readonly extraAbilities?: readonly string[];
  /** the unit's WML id (`Konrad`), so later `[recall] id=`/`[kill] id=` still find it */
  readonly wmlId?: string;
  /** a side leader stays a leader when recalled */
  readonly canRecruit?: boolean;
}

/** What the next scenario starts with. */
export interface Carryover {
  readonly from: string;
  readonly to: string;
  readonly gold: number;
  readonly percent: number;
  /** early-finish gold, already included in `gold` */
  readonly bonus: number;
  readonly units: readonly CarryoverUnit[];
}

/** The scenario after `current` in campaign order, or null at the end. */
export function nextScenario(order: readonly string[], current: string): string | null {
  const index = order.indexOf(current);
  if (index === -1) return null;
  return order[index + 1] ?? null;
}

/** Resolve an `[endlevel]` branch, falling back to the campaign's default chain. */
export function nextScenarioWithOverride(
  order: readonly string[],
  current: string,
  override: string | undefined,
  available: (scenario: string) => boolean,
): string | null {
  // The availability check prevents malformed or stale WML targets from
  // escaping into the scene while preserving the ordinary campaign fallback.
  if (override && available(override)) return override;
  return nextScenario(order, current);
}

/** The unit fields the carry-over needs; the engine unit satisfies this. */
export interface CarryoverSourceUnit {
  readonly typeId: string;
  readonly name: string;
  readonly side: number;
  readonly hitpoints: number;
  readonly experience: number;
  readonly traits?: readonly string[];
  readonly loyal?: boolean;
  readonly extraAbilities?: readonly string[];
  readonly wmlId?: string;
  readonly canRecruit?: boolean;
}

export interface CarryoverInput {
  readonly from: string;
  readonly to: string;
  /** the side's treasury at the end of the scenario */
  readonly gold: number;
  readonly units: readonly CarryoverSourceUnit[];
  readonly side?: number;
  readonly percent?: number;
  /** early-finish gold (`[endlevel]` `bonus=yes`), added after the percentage */
  readonly bonusGold?: number;
}

/** What the next scenario inherits: a share of the gold plus any bonus, and the survivors. */
export function carryoverFor(input: CarryoverInput): Carryover {
  const side = input.side ?? 1;
  const percent = input.percent ?? CARRYOVER_GOLD_PERCENT;
  const bonus = Math.max(0, Math.floor(input.bonusGold ?? 0));
  const gold = Math.floor((Math.max(0, input.gold) * percent) / 100) + bonus;
  const units = input.units
    .filter((unit) => unit.side === side && unit.hitpoints > 0)
    .map((unit) => {
      const entry: CarryoverUnit = {
        typeId: unit.typeId,
        name: unit.name,
        hitpoints: unit.hitpoints,
        experience: unit.experience,
      };
      return {
        ...entry,
        ...(unit.traits?.length ? { traits: [...unit.traits] } : {}),
        ...(unit.loyal ? { loyal: true } : {}),
        ...(unit.extraAbilities?.length ? { extraAbilities: [...unit.extraAbilities] } : {}),
        ...(unit.wmlId ? { wmlId: unit.wmlId } : {}),
        ...(unit.canRecruit ? { canRecruit: true } : {}),
      };
    });
  return { from: input.from, to: input.to, gold, percent, bonus, units };
}

/** The victory screen's summary lines. */
export function describeCarryover(carryover: Carryover, goldBefore: number): string[] {
  const names = carryover.units.map((unit) => unit.name);
  const survivors = names.length === 0 ? 'None. The next scenario starts with its own units.' : names.join(', ');
  return [
    `Units carried over: ${survivors}`,
    `Gold carried over: ${carryover.gold} of ${goldBefore} (${carryover.percent}%)${carryover.bonus > 0 ? `, including a ${carryover.bonus} early-finish bonus` : ''}`,
    `Next scenario: ${carryover.to}`,
  ];
}
