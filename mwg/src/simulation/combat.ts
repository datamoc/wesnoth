/**
 * Combat resolution, ported from `src/actions/attack.cpp`:
 *
 * - `battle_context_unit_stats`: chance to hit, damage, and number of blows are
 *   computed in `battle_context_unit_stats::battle_context_unit_stats`
 *   (`attack.cpp` lines ~169-210 in the 1.19.27 checkout).
 * - `attack_type::modified_chance_to_hit` (`src/units/attack_type.cpp:852`) clamps
 *   `cth + accuracy - parry` to 0..100 and then applies `chance_to_hit` specials.
 * - `round_damage` (`src/utils/math.hpp:78`) rounds up or down towards the base
 *   damage; `damage_multiplier` starts at 100, adds the lawful/leadership bonus,
 *   and multiplies by the defender's resistance to the weapon's damage type.
 *
 * Ported through the data-driven value engine (`specials.ts`, mirroring
 * `src/units/abilities.cpp`): magical, marksman, honed-style accuracy, charge,
 * backstab (flank geometry in `game.ts`), swarm, drains, slow, poison,
 * petrify, berserk, firststrike, steadfast and `[disable]`. Diversion arrives
 * as a caller-computed flag (same flank geometry, -20 to the retaliation).
 * Plague spawns and feeding live in `game.ts`, which owns the unit list; the
 * `[plague]` spawn type is read here (`plagueTypeOf`).
 */

import type { AttackDef, SpecialDef, WesnothData } from './types.ts';
import { applies, attackEffects, compositeValue, effectsOf, hasTag, tagAttribute, unitAbilities } from './specials.ts';
import type { ResolvedTerrain } from './terrain.ts';
import { applyStatus, hasTraitMarker, type Unit } from './unit.ts';

export interface Strike {
  attacker: number;
  defender: number;
  hit: boolean;
  damage: number;
  killed: boolean;
}

export interface CombatExchange {
  attacker: number;
  defender: number;
  attackName: string;
  defenseName: string;
  attackerCth: number;
  defenderCth: number;
  strikes: Strike[];
  /** attacker and defender hitpoint totals after the exchange */
  attackerHp: number;
  defenderHp: number;
  attackerKilled: boolean;
  defenderKilled: boolean;
  /** the statuses the attacker's weapon inflicts on a hit */
  inflicts: { poisoned: boolean; slowed: boolean; petrified: boolean };
}

export interface AttackContext {
  data: WesnothData;
  /** current lawful bonus from the time-of-day schedule, e.g. 25, 0, -25 */
  lawfulBonus: number;
  /**
   * Percent damage from auras: leadership (+25 per level of the best adjacent
   * leader) and illumination (the hex counts as day for lawful units).
   */
  damageBonus?: number;
}

/** Ported from `src/utils/math.hpp:78`. */
export function roundDamage(baseDamage: number, bonus: number, divisor: number): number {
  if (baseDamage === 0) return 0;
  const rounding = Math.floor(divisor / 2) - (bonus <= divisor || divisor === 1 ? 0 : 1);
  return Math.max(1, Math.floor((baseDamage * bonus + rounding) / divisor));
}

/** `attack_type::modified_chance_to_hit`, restricted to the mainline specials. */
export function modifiedChanceToHit(baseCth: number, specials: string[], accuracy = 0, parry = 0): number {
  let cth = clamp(baseCth + accuracy - parry, 0, 100);
  for (const special of specials) {
    if (special === 'magical') cth = 70;
    else if (special === 'marksman') cth = Math.max(cth, 60);
  }
  return clamp(cth, 0, 100);
}

/** Time-of-day combat modifier, ported from `generic_combat_modifier` (`attack.cpp:1506`). */
export function lawfulCombatModifier(lawfulBonus: number, alignment: Unit['alignment'], fearless = false): number {
  let bonus: number;
  switch (alignment) {
    case 'lawful':
      bonus = lawfulBonus;
      break;
    case 'neutral':
      bonus = 0;
      break;
    case 'chaotic':
      bonus = -lawfulBonus;
      break;
    case 'liminal':
      // max_liminal_bonus is schedule-dependent; the default schedule has none,
      // so this matches the engine's own default of 0 in that case.
      bonus = -Math.abs(lawfulBonus);
      break;
    default:
      bonus = 0;
  }
  if (fearless) bonus = Math.max(bonus, 0);
  return bonus;
}

/**
 * Resistance % for a damage type, from the unit type's effective movetype: its
 * movetype merged with its own `[resistance]` (`src/units/types.cpp:298`).
 * Missing entries mean 100.
 */
export function resistanceOf(data: WesnothData, unit: Unit, damageType: string): number {
  // `[effect] apply_to=resistance` adds resistance points, which lower the damage multiplier
  const mod = unit.resistanceMods?.[damageType] ?? 0;
  const override = data.unitTypes[unit.typeId]?.resistance?.[damageType];
  if (override !== undefined) {
    const value = Number(override);
    if (Number.isFinite(value)) return value - mod;
  }
  const movetype = data.movetypes[data.unitTypes[unit.typeId]?.movementType ?? ''];
  return (movetype?.resistance[damageType] ?? 100) - mod;
}

/**
 * The ability definitions a unit owns: its type's `abilities_list` plus any
 * `extraAbilities` an `[object]` granted it after creation.
 */
export function abilitiesOf(data: WesnothData, unit: Unit): SpecialDef[] {
  return unitAbilities(data, [...(data.unitTypes[unit.typeId]?.abilities ?? []), ...(unit.extraAbilities ?? [])]);
}

/** Does the unit own an ability with this registry id (type list or object gift)? */
export function hasAbility(data: WesnothData, unit: Unit, id: string): boolean {
  return abilitiesOf(data, unit).some((ability) => ability.id === id);
}

/**
 * The `[plague]` spawn type of a weapon, if any (`WEAPON_SPECIAL_PLAGUE*` in
 * `data/core/macros/weapon_specials.cfg`). Plain `plague` reads the `type=`
 * attribute of the loaded definition (default `Walking Corpse`); an inline
 * `plague(Some Type)` carries its type in parentheses (noted as inline in the
 * parity test because no registry id can contain them).
 */
export function plagueTypeOf(data: WesnothData, weapon: AttackDef): string | null {
  for (const special of weapon.specials) {
    const inline = /^plague\((.+)\)$/.exec(special.trim());
    // Variants nest their parentheses (`plague((Fire Ant Egg))`); strip them.
    if (inline) {
      let inner = inline[1].trim();
      while (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1).trim();
      return inner || 'Walking Corpse';
    }
    if (special === 'plague') {
      const definition = data.weaponSpecials[special];
      const type = definition?.effects.find((effect) => effect.tag === 'plague')?.attributes.type;
      return (type ?? 'Walking Corpse').trim() || 'Walking Corpse';
    }
  }
  return null;
}

/**
 * The damage taken after `[resistance]` abilities (steadfast).
 *
 * The C++ works in resistance percent (`unit::resistance_value` is
 * `100 - effect.n()`), while a movetype stores the damage taken, so this
 * converts both ways: a unit taking 80% has 20% resistance, doubled to 40% by
 * steadfast, capped at 50%, and so takes 60%.
 */
export function resistanceAfterAbilities(data: WesnothData, unit: Unit, damageType: string): number {
  const taken = resistanceOf(data, unit, damageType);
  const effects = effectsOf(abilitiesOf(data, unit), 'resistance').filter((effect) =>
    applies(effect, { isAttacker: false }, 'defender'),
  );
  if (effects.length === 0) return taken;
  return 100 - compositeValue(effects, 100 - taken);
}

/** Everything a fight needs from one weapon, in one place. */
export interface AttackNumbers {
  /** chance to hit, after `[chance_to_hit]` (magical, marksman, ...) */
  cth: number;
  /** damage per strike, after `[damage]` (charge, backstab, ...) */
  damage: number;
  /** strikes, after `[attacks]` and `[swarm]` (swarm scales with hitpoints) */
  attacks: number;
  /** `[drains]`: percent of damage dealt healed back */
  drainPercent: number;
  /** `[heal_on_hit]`: flat hitpoints healed per hit */
  drainConstant: number;
  /** statuses this weapon inflicts on a hit */
  inflicts: { poisoned: boolean; slowed: boolean; petrified: boolean };
  /** `[berserk]` value: rounds to press the attack, or null */
  berserkRounds: number | null;
  firststrike: boolean;
  /** `[disable]` targets, recorded but not yet enforced */
  disables: string[];
}

export interface AttackNumberOptions {
  /** is the weapon's owner the attacker in this fight? */
  isAttacker: boolean;
  /** the other side's weapon, whose `apply_to=both` effects apply back */
  opponentWeapon?: AttackDef;
  /** base chance to hit before specials; defaults to a flat 60% */
  baseCth?: number;
  /** backstab only applies when the target is flanked (`attack.cpp`) */
  flanked?: boolean;
  /** special/ability ids the opponent's `[disable]` suppresses this fight */
  suppressed?: readonly string[];
  /** unit hitpoints for swarm scaling */
  hitpoints?: { current: number; max: number };
}

/**
 * The numbers for one weapon in one fight, from the real definitions.
 * Mirrors `attack_type::modified_attacks`, `modified_damage` and
 * `modified_chance_to_hit` in `src/units/attack_type.cpp`.
 */
export function attackNumbers(ctx: AttackContext, owner: Unit, weapon: AttackDef, options: AttackNumberOptions): AttackNumbers {
  const definitions = [...attackEffects(ctx.data, weapon.specials), ...abilitiesOf(ctx.data, owner)].filter(
    (definition) => !(options.suppressed ?? []).includes(definition.id),
  );
  const context = { isAttacker: options.isAttacker };

  // `attack_type::modified_chance_to_hit` applies static weapon accuracy and
  // opposing weapon parry before composing `[chance_to_hit]`
  // (`src/units/attack_type.cpp:852-858`).
  const baseCth = clamp((options.baseCth ?? 60) + (weapon.accuracy ?? 0) - (options.opponentWeapon?.parry ?? 0), 0, 100);
  const cthEffects = effectsOf(definitions, 'chance_to_hit').filter((effect) => applies(effect, context, 'attacker'));
  const cth = clamp(compositeValue(cthEffects, baseCth), 0, 100);

  const damageEffects = effectsOf(definitions, 'damage').filter(
    (effect) =>
      applies(effect, context, 'attacker') &&
      // backstab is written with a `[filter_opponent]` formula in the data; the
      // port evaluates its meaning (an enemy behind the target) instead of the
      // formula, so the effect applies only when the caller reports a flank.
      (effect.attributes.id !== 'backstab' || options.flanked === true),
  );
  if (options.opponentWeapon) {
    // A charging attacker takes double damage from the counterattack, which the
    // C++ expresses as the charge effect being `apply_to=both`.
    const opponent = attackEffects(ctx.data, options.opponentWeapon.specials);
    for (const effect of effectsOf(opponent, 'damage'))
      if (applies(effect, { isAttacker: !options.isAttacker }, 'both')) damageEffects.push(effect);
  }
  const damage = compositeValue(damageEffects, weapon.damage);

  let attacks = compositeValue(effectsOf(definitions, 'attacks').filter((effect) => applies(effect, context, 'attacker')), weapon.number);
  if (hasTag(definitions, 'swarm') && options.hitpoints && options.hitpoints.max > 0) {
    // attack_type::modified_attacks: strikes scale with the unit's health.
    const swarm = effectsOf(definitions, 'swarm')[0];
    const minimum = Number(swarm?.attributes.swarm_attacks_min ?? 0);
    const maximum = Number(swarm?.attributes.swarm_attacks_max ?? attacks);
    attacks = Math.max(0, Math.round(minimum + ((maximum - minimum) * options.hitpoints.current) / options.hitpoints.max));
  }

  const drainPercent = hasTag(definitions, 'drains') ? compositeValue(effectsOf(definitions, 'drains'), 50) : 0;
  const drainConstant = compositeValue(effectsOf(definitions, 'heal_on_hit'), 0);
  const berserk = tagAttribute(definitions, 'berserk', 'value');

  return {
    cth,
    damage,
    attacks,
    drainPercent,
    drainConstant,
    inflicts: {
      poisoned: hasTag(definitions, 'poison'),
      slowed: hasTag(definitions, 'slow'),
      petrified: hasTag(definitions, 'petrifies'),
    },
    berserkRounds: hasTag(definitions, 'berserk') ? Number(berserk ?? 30) : null,
    firststrike: hasTag(definitions, 'firststrike'),
    disables: effectsOf(definitions, 'disable')
      .map((effect) => effect.attributes.disable ?? effect.attributes.id ?? effect.attributes.name ?? '')
      .filter(Boolean),
  };
}

/** Damage per strike: weapon damage, time of day, resistance, and slow. */
export function damagePerStrike(
  ctx: AttackContext,
  attacker: Unit,
  defender: Unit,
  attack: AttackDef,
  options: { opponentWeapon?: AttackDef; baseCth?: number; terrain?: ResolvedTerrain } = {},
): number {
  const numbers = attackNumbers(ctx, attacker, attack, {
    isAttacker: true,
    ...(options.opponentWeapon ? { opponentWeapon: options.opponentWeapon } : {}),
  });
  const resistance = resistanceAfterAbilities(ctx.data, defender, attack.type);
  const aura = ctx.damageBonus ?? 0;
  // `fearless` (the trait marker) ignores an unfavourable time of day.
  const fearless = hasTraitMarker(ctx.data, attacker, 'fearless');
  const multiplier = (100 + lawfulCombatModifier(ctx.lawfulBonus, attacker.alignment, fearless) + aura) * resistance;
  // src/actions/attack.cpp: a slowed unit rounds with divisor 20000, which halves
  // the damage the same way a 50% multiplier would.
  const divisor = attacker.slowed ? 20000 : 10000;
  return roundDamage(numbers.damage, Math.round(multiplier), divisor);
}

/**
 * Chance to hit: the terrain's defence sets the base (a unit standing on 60%
 * defence is hit 40% of the time), then `[chance_to_hit]` applies. Magical sets
 * it to 70, marksman to at least 60 (`data/core/macros/weapon_specials.cfg`).
 */
export function chanceToHit(
  ctx: AttackContext,
  _target: Unit,
  terrain: ResolvedTerrain,
  specials: string[],
  owner?: Unit,
): number {
  const definitions = [...attackEffects(ctx.data, specials), ...(owner ? abilitiesOf(ctx.data, owner) : [])];
  const effects = effectsOf(definitions, 'chance_to_hit').filter((effect) =>
    applies(effect, { isAttacker: false }, 'attacker'),
  );
  return clamp(compositeValue(effects, 100 - terrain.defense), 0, 100);
}

/** The defender's retaliation weapon: same range, best `number*damage`. */
export function retaliationAttack(defender: Unit, attackerRange: string): AttackDef | null {
  const candidates = defender.attacks.filter((attack) => attack.range === attackerRange && attack.number > 0 && (attack.defenseWeight ?? 1) > 0);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.number * b.damage - a.number * a.damage)[0];
}

export function hasSpecial(attack: AttackDef, id: string): boolean {
  return attack.specials.includes(id);
}

export interface ResolveAttackOptions {
  attacker: Unit;
  defender: Unit;
  attack: AttackDef;
  /** the defender's terrain, which decides the attacker's chance to hit */
  terrain: ResolvedTerrain;
  /** the attacker's terrain, which decides the retaliation's chance to hit */
  attackerTerrain?: ResolvedTerrain;
  rng?: () => number;
  /** time-of-day lawful bonus on each fighter's own hex (`[time_area]` aware) */
  attackerLawfulBonus?: number;
  defenderLawfulBonus?: number;
  /** leadership/illumination percentage for each side */
  attackerBonus?: number;
  defenderBonus?: number;
  /** is the defender flanked (an enemy behind it), for backstab? */
  defenderFlanked?: boolean;
  /** is the retaliation diverted (same flank geometry), for diversion (-20)? */
  defenderDiverted?: boolean;
  /** ids each side's `[disable]` suppresses on the other */
  suppressedForAttacker?: readonly string[];
  suppressedForDefender?: readonly string[];
  /** statuses or effects a side is immune to: poison, slow, drain, plague */
  attackerImmune?: readonly string[];
  defenderImmune?: readonly string[];
}

/** A full fight: strikes both ways, statuses, drain, and berserk. */
export function resolveAttack(ctx: AttackContext, options: ResolveAttackOptions): CombatExchange {
  const { attacker, defender, attack, terrain } = options;
  const rng = options.rng ?? Math.random;
  const retaliationTerrain = options.attackerTerrain ?? terrain;

  const defense = retaliationAttack(defender, attack.range);
  const attackerNumbers = attackNumbers(ctx, attacker, attack, {
    isAttacker: true,
    baseCth: 100 - terrain.defense,
    hitpoints: { current: attacker.hitpoints, max: attacker.maxHitpoints },
    suppressed: options.suppressedForAttacker ?? [],
    ...(defense ? { opponentWeapon: defense } : {}),
  });
  const defenderNumbers = defense
    ? attackNumbers(ctx, defender, defense, {
        isAttacker: false,
        baseCth: 100 - retaliationTerrain.defense,
        hitpoints: { current: defender.hitpoints, max: defender.maxHitpoints },
        opponentWeapon: attack,
        flanked: false,
        suppressed: options.suppressedForDefender ?? [],
      })
    : null;

  // Diversion (`data/core/macros/abilities.cfg`, `sub=20`): the diverted
  // retaliation loses 20 accuracy. The caller reports the flank geometry.
  if (defenderNumbers && options.defenderDiverted) {
    defenderNumbers.cth = clamp(defenderNumbers.cth - 20, 0, 100);
  }
  const attackerCth = clamp(attackerNumbers.cth, 0, 100);
  const defenderCth = defenderNumbers ? clamp(defenderNumbers.cth, 0, 100) : 0;
  const strikes: Strike[] = [];

  /**
   * A petrifying hit ends the fight on the spot (`src/actions/attack.cpp:1080-1086`):
   * the engine zeroes the attacker's remaining attacks and marks the defender
   * petrified (`n_attacks_ = -1`), so neither side swings again. That is what
   * makes a cockatrice's gaze stop a fight mid-exchange.
   */
  let petrifiedStop = false;

  const doStrikes = (
    source: Unit,
    target: Unit,
    weapon: AttackDef,
    numbers: AttackNumbers,
    opponent: AttackDef,
    bonus: number,
    flanked: boolean,
    immune: readonly string[],
    lawfulBonus?: number,
  ): void => {
    const damage = damagePerStrike({ ...ctx, lawfulBonus: lawfulBonus ?? ctx.lawfulBonus, damageBonus: bonus }, source, target, weapon, {
      opponentWeapon: opponent,
    });
    void flanked;
    for (let i = 0; i < numbers.attacks; i++) {
      if (source.hitpoints <= 0 || target.hitpoints <= 0) break;
      const hit = rng() < numbers.cth / 100;
      const dealt = hit ? Math.min(damage, target.hitpoints) : 0;
      target.hitpoints -= dealt;
      strikes.push({ attacker: source.id, defender: target.id, hit, damage: dealt, killed: target.hitpoints <= 0 });
      if (!hit || dealt <= 0) continue;
      // Statuses land on a hit; drain heals the striker.
      if (numbers.inflicts.poisoned && !target.poisoned && !immune.includes('poison')) applyStatus(target, 'poisoned');
      if (numbers.inflicts.slowed && !target.slowed && !immune.includes('slow')) applyStatus(target, 'slowed');
      if (numbers.inflicts.petrified && !target.petrified && !immune.includes('petrify')) {
        applyStatus(target, 'petrified');
        petrifiedStop = true;
        break;
      }
      const drain = immune.includes('drain') ? 0 : numbers.drainPercent;
      const healed = Math.floor((dealt * drain) / 100) + numbers.drainConstant;
      if (healed > 0) source.hitpoints = Math.min(source.maxHitpoints, source.hitpoints + healed);
    }
  };

  const attackerFirst =
    !(defense && defenderNumbers && defenderNumbers.firststrike && !attackerNumbers.firststrike);

  // Berserk presses the fight until someone falls, or the round limit is reached.
  const berserkRounds = Math.max(attackerNumbers.berserkRounds ?? 1, defenderNumbers?.berserkRounds ?? 0);
  for (let round = 0; round < berserkRounds; round++) {
    if (attacker.hitpoints <= 0 || defender.hitpoints <= 0 || petrifiedStop) break;
    if (attackerFirst) {
      doStrikes(attacker, defender, attack, attackerNumbers, defense ?? attack, options.attackerBonus ?? 0, options.defenderFlanked ?? false, options.defenderImmune ?? [], options.attackerLawfulBonus);
      if (defense && defenderNumbers && defender.hitpoints > 0 && !petrifiedStop)
        doStrikes(defender, attacker, defense, defenderNumbers, attack, options.defenderBonus ?? 0, false, options.attackerImmune ?? [], options.defenderLawfulBonus);
    } else if (defense && defenderNumbers) {
      doStrikes(defender, attacker, defense, defenderNumbers, attack, options.defenderBonus ?? 0, false, options.attackerImmune ?? [], options.defenderLawfulBonus);
      if (attacker.hitpoints > 0 && !petrifiedStop)
        doStrikes(attacker, defender, attack, attackerNumbers, defense, options.attackerBonus ?? 0, options.defenderFlanked ?? false, options.defenderImmune ?? [], options.attackerLawfulBonus);
    }
    if (attackerNumbers.berserkRounds === null && defenderNumbers?.berserkRounds === null) break;
  }

  // Attacking consumes all remaining movement (attack.cpp: `attacker.moves = 0`).
  attacker.movement = 0;
  attacker.resting = false;

  return {
    attacker: attacker.id,
    defender: defender.id,
    attackName: attack.name,
    defenseName: defense?.name ?? '',
    attackerCth,
    defenderCth,
    strikes,
    attackerHp: attacker.hitpoints,
    defenderHp: defender.hitpoints,
    attackerKilled: attacker.hitpoints <= 0,
    defenderKilled: defender.hitpoints <= 0,
    // The petrifying flag drives the `petrified` event
    // (`src/actions/attack.cpp:1080-1086`).
    inflicts: attackerNumbers.inflicts,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
