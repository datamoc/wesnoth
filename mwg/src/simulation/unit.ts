/**
 * Unit instances and trait application, ported from `unit::apply_builtin_effect`
 * (`src/units/unit.cpp`) and `unit::generate_traits` (`unit.cpp:841`):
 * forced `musthave` traits first, then random picks up to the unit type's (or
 * its race's) `num_traits` from the type's own, race and global candidates.
 */

import type { AppliedObject, AttackDef, EffectDef, WesnothData } from './types.ts';

export type Alignment = 'lawful' | 'neutral' | 'chaotic' | 'liminal';

export interface Unit {
  id: number;
  /** Original WML instance id, when this unit came from scenario data. */
  wmlId?: string;
  /** Whether this unit is the side's recruit-capable leader. */
  canRecruit?: boolean;
  /** WML prevents the player from changing this unit's displayed name. */
  unrenamable?: boolean;
  typeId: string;
  name: string;
  image: string;
  side: number;
  x: number;
  y: number;
  hitpoints: number;
  maxHitpoints: number;
  movement: number;
  maxMovement: number;
  experience: number;
  maxExperience: number;
  level: number;
  alignment: Alignment;
  cost: number;
  traits: string[];
  attacks: AttackDef[];
  /**
   * Ability registry ids granted after creation (`[object]` pickups, scenario
   * gifts). The type's own `abilities_list` stays untouched; `abilitiesOf` in
   * `combat.ts` reads both.
   */
  extraAbilities: string[];
  /** Reversible scenario objects currently applied to this unit. */
  appliedObjects?: AppliedObject[];
  /** Per-unit movement costs installed by scenario objects/effects. */
  movementCostOverrides?: Record<string, number>;
  /** Chance-to-be-hit changes per terrain id installed by `[effect] apply_to=defense` (`effects.ts`). */
  defenseMods?: Record<string, number>;
  /** Resistance percentage points per damage type installed by `[effect] apply_to=resistance`. */
  resistanceMods?: Record<string, number>;
  /** `[effect] apply_to=recall_cost` */
  recallCost?: number;
  /** effect names the port has no unit field for, kept so nothing is silently dropped */
  effectMarkers?: string[];
  /** Presentation overlays installed by WML `[unit_overlay]`. */
  overlays?: { image: string; id?: string }[];
  /** campaign marker: loyal units do not consume upkeep */
  loyal?: boolean;
  /** WML presentation state: hidden units remain on the map but are not drawn. */
  hidden?: boolean;
  /** Last WML-directed facing, used by presentation animations. */
  facing?: string;
  /** WML unit presentation/rules metadata retained by modify_unit. */
  ellipse?: string;
  variation?: string;
  vision?: number;
  /** WML `[filter_recall]` restriction attached to this unit/leader. */
  recallFilter?: Record<string, string>;
  /** Per-unit WML variable table used by `[filter_wml]` and campaign logic. */
  variables?: Record<string, string | number | boolean>;
  /** Unit-specific recruits granted by `[set_extra_recruit]`. */
  extraRecruit?: string[];
  /** whether the unit has not moved this turn (rest healing eligibility) */
  resting: boolean;
  /** poisoned: loses `poison_amount` (8) hitpoints a turn until cured */
  poisoned: boolean;
  /** slowed: half damage and double movement cost, until its side's turn ends */
  slowed: boolean;
  /** petrified: cannot move or attack again */
  petrified: boolean;
}

/** Apply the status a hit inflicted; petrify is permanent, slow lasts a turn. */
export function applyStatus(unit: Unit, status: 'poisoned' | 'slowed' | 'petrified'): void {
  unit[status] = true;
}

/**
 * The damage a poisoned unit loses at the end of its own turn: `poison_amount`
 * (8, `src/game_config.cpp`). Poison never kills: the unit is left at 1
 * hitpoint (`src/actions/heal.cpp`).
 */
export function poisonTick(unit: Unit, amount: number): number {
  if (!unit.poisoned || unit.hitpoints <= 1) return 0;
  const dealt = Math.min(amount, unit.hitpoints - 1);
  unit.hitpoints -= dealt;
  return dealt;
}

/** Slow is cured when the unit's side finishes a turn. */
export function clearTurnStatuses(units: Iterable<Unit>): void {
  for (const unit of units) unit.slowed = false;
}

export type Rng = () => number;

let nextUnitId = 1;

export function makeUnit(data: WesnothData, typeId: string, side: number, x: number, y: number, rng: Rng = Math.random): Unit {
  return buildUnit(data, typeId, side, x, y, pickTraits(data, typeId, rng));
}

/**
 * Build a unit with an exact trait list instead of rolling one. The campaign
 * carry-over uses this so a recalled survivor keeps the traits it earned
 * (`unit::generate_traits` is skipped when the saved unit already has them);
 * the trait effects are applied exactly as they were the first time.
 */
export function makeUnitWithTraits(data: WesnothData, typeId: string, side: number, x: number, y: number, traitIds: readonly string[]): Unit {
  return buildUnit(data, typeId, side, x, y, [...traitIds]);
}

function buildUnit(data: WesnothData, typeId: string, side: number, x: number, y: number, traitIds: string[]): Unit {
  const type = data.unitTypes[typeId];
  if (!type) throw new Error(`unknown unit type "${typeId}"`);

  const traits = traitIds.map((id) => data.traits[id]).filter(Boolean);

  let maxHitpoints = type.hitpoints;
  let maxMovement = type.movement;
  let maxExperience = type.experience;
  const attacks = type.attacks.map((attack) => ({ ...attack }));

  for (const trait of traits) {
    for (const effect of trait.effects) {
      const result = applyEffect(effect, attacks, { maxHitpoints, maxMovement, maxExperience });
      maxHitpoints = result.maxHitpoints;
      maxMovement = result.maxMovement;
      maxExperience = result.maxExperience;
    }
  }

  return {
    id: nextUnitId++,
    typeId,
    name: type.name,
    image: type.image,
    side,
    x,
    y,
    hitpoints: maxHitpoints,
    maxHitpoints,
    movement: maxMovement,
    maxMovement,
    experience: 0,
    maxExperience,
    level: type.level,
    alignment: type.alignment,
    cost: type.cost,
    traits: traitIds.filter((id) => data.traits[id]),
    attacks,
    extraAbilities: [],
    appliedObjects: [],
    movementCostOverrides: {},
    overlays: [],
    resting: true,
    poisoned: false,
    slowed: false,
    petrified: false,
  };
}

/**
 * Every trait a unit type may take: its own, its race's extras (dextrous for
 * elves), and the global set unless the race opts out.
 */
export function traitCandidates(data: WesnothData, typeId: string): string[] {
  const type = data.unitTypes[typeId];
  if (!type) return [];
  const race = data.races[type.race];
  const ids = new Set<string>(type.ownTraits);
  if (race && !type.ignoreRaceTraits) for (const id of race.traits) ids.add(id);
  if (!race || !race.ignoreGlobalTraits) for (const id of data.globalTraits) ids.add(id);
  return [...ids].filter((id) => data.traits[id]);
}

/**
 * Trait selection, following `unit::generate_traits` (`src/units/unit.cpp:841`):
 * forced traits (`availability=musthave`, such as undead) always apply, then the
 * unit takes random ones until it has its `num_traits` (the unit type's, else the
 * race's, else 2).
 */
export function pickTraits(data: WesnothData, typeId: string, rng: Rng): string[] {
  const candidates = traitCandidates(data, typeId);
  const forced = candidates.filter((id) => data.traits[id].availability === 'musthave');
  const type = data.unitTypes[typeId];
  const count = type?.numTraits ?? data.races[type?.race ?? '']?.numTraits ?? 2;
  const pool = candidates.filter((id) => !forced.includes(id));
  const picked = [...forced];
  while (picked.length < count && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/** Does a unit carry a trait marker such as `loyal` or `status:unpoisonable`? */
export function hasTraitMarker(data: WesnothData, unit: Unit, marker: string): boolean {
  return (marker === 'loyal' && unit.loyal === true) || unit.traits.some((id) => (data.traits[id]?.markers ?? []).includes(marker));
}

/** Remove a runtime trait and undo its built-in numeric effects. */
export function removeTrait(data: WesnothData, unit: Unit, traitId?: string): boolean {
  const ids = traitId ? [traitId] : [...unit.traits];
  let removed = false;
  for (const id of ids) {
    const index = unit.traits.indexOf(id);
    if (index < 0) continue;
    const trait = data.traits[id];
    unit.traits.splice(index, 1);
    removed = true;
    if (id === 'loyal') unit.loyal = false;
    if (!trait) continue;
    for (const effect of trait.effects) {
      if (effect.applyTo === 'hitpoints' && effect.increaseTotal !== undefined) {
        unit.maxHitpoints = Math.max(1, undoPercentOrFlat(unit.maxHitpoints, effect.increaseTotal));
        unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints);
      } else if (effect.applyTo === 'movement' && effect.increase !== undefined) {
        unit.maxMovement = Math.max(0, unit.maxMovement - Number(effect.increase));
        unit.movement = Math.min(unit.maxMovement, unit.movement);
      } else if (effect.applyTo === 'max_experience' && effect.increase !== undefined) {
        unit.maxExperience = Math.max(0, undoPercentOrFlat(unit.maxExperience, effect.increase));
      } else if (effect.applyTo === 'attack' && effect.increaseDamage !== undefined) {
        for (const attack of unit.attacks) {
          if (!effect.range || effect.range === attack.range) attack.damage = undoPercentOrFlat(attack.damage, effect.increaseDamage);
        }
      }
    }
  }
  return removed;
}


export interface UnitNumbers {
  maxHitpoints: number;
  maxMovement: number;
  maxExperience: number;
}

/** Apply one trait [effect] to unit numbers and attacks; returns the new numbers. */
export function applyEffect(effect: EffectDef, attacks: AttackDef[], numbers: UnitNumbers): UnitNumbers {
  const out = { ...numbers };
  switch (effect.applyTo) {
    case 'hitpoints': {
      if (effect.increaseTotal !== undefined) out.maxHitpoints = applyPercentOrFlat(out.maxHitpoints, effect.increaseTotal);
      break;
    }
    case 'movement': {
      if (effect.increase !== undefined) out.maxMovement += Number(effect.increase);
      break;
    }
    case 'max_experience': {
      if (effect.increase !== undefined) out.maxExperience = Math.max(0, applyPercentOrFlat(out.maxExperience, effect.increase));
      break;
    }
    case 'attack': {
      if (effect.increaseDamage !== undefined) {
        for (const attack of attacks) {
          if (!effect.range || effect.range === attack.range) {
            attack.damage = applyPercentOrFlat(attack.damage, effect.increaseDamage);
          }
        }
      }
      break;
    }
  }
  return out;
}

/**
 * Wesnoth effect values may be flat integers or percent strings: `4`, `-5%`,
 * `20%`. Percentages round to the nearest integer, matching the engine's
 * `round_damage`-style application for trait effects.
 */
export function applyPercentOrFlat(base: number, value: number | string): number {
  if (typeof value === 'number') return base + value;
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match) {
    const percent = Number(match[1]);
    return Math.round((base * (100 + percent)) / 100);
  }
  return base + Number(value);
}

function undoPercentOrFlat(current: number, value: number | string): number {
  if (typeof value === 'number') return current - value;
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match) return Math.round((current * 100) / (100 + Number(match[1])));
  return current - Number(value);
}

