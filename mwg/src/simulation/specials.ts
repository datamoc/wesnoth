/**
 * Weapon specials and abilities, read from the real data and applied the way the
 * C++ does.
 *
 * The reference is `src/units/abilities.cpp` (`unit_abilities::effect::effect_impl`)
 * for how a list of effects combines into one value, and
 * `src/units/attack_type.cpp` (`modified_attacks`, `modified_damage`,
 * `modified_chance_to_hit`) for where each tag is used. The definitions come from
 * `data/core/macros/weapon_specials.cfg` and `abilities.cfg` through the data
 * pipeline, so the numbers are the game's own.
 *
 * Implemented here: the value engine (`value`, `add`, `sub`, `multiply`,
 * `divide`, `max_value`, `min_value`, `[filter_base_value]`, `cumulative`,
 * `active_on`) and the tags the fight needs. Ability auras that need
 * adjacency scanning (leadership, illuminates, heals) live in `game.ts`, and
 * terrain-based hides (ambush, concealment, submerge, swamp_lurk, nightstalk,
 * burrow) live in `vision.ts`. The reusable formula subset used by
 * `[filter_opponent]` and friends lives in `expression.ts`; engine-owned
 * geometry is still passed in by the caller where a formula needs map state.
 *
 * The framework's generic `composeEffects` (`mwg/mwl`) is intentionally not
 * used here: it stacks plain add/sub/multiply/divide/set modifiers, while
 * the C++ `effect_impl` this mirrors keeps the highest positive and lowest
 * negative `value` override, dedups `add`/`sub` per effect id, and clamps
 * with `max_value`/`min_value`. Same inputs, different numbers.
 */

import type { EffectTree, SpecialDef, WesnothData } from './types.ts';

/** Where an effect applies: `offense`, `defense`, or both (the default). */
export type ActiveOn = 'offense' | 'defense' | 'both';

export interface EffectContext {
  /** is the effect's owner the attacker in this fight? */
  readonly isAttacker: boolean;
}

function attributeValue(effect: EffectTree, name: string): string | undefined {
  const raw = effect.attributes[name];
  return raw === undefined ? undefined : raw.trim();
}

function numberValue(effect: EffectTree, name: string): number | undefined {
  const raw = attributeValue(effect, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `apply_to=attacker|defender|both` and `active_on=offense|defense|both`.
 * `side = "both"` asks for the effects that hit both ways, which is how charge
 * doubles the damage its owner takes from a counterattack.
 */
export function applies(effect: EffectTree, context: EffectContext, side: 'attacker' | 'defender' | 'both'): boolean {
  const applyTo = attributeValue(effect, 'apply_to');
  if (applyTo && applyTo !== 'both' && applyTo !== side) return false;
  const activeOn = (attributeValue(effect, 'active_on') ?? 'both') as ActiveOn;
  if (activeOn === 'both') return true;
  return activeOn === 'offense' ? context.isAttacker : !context.isAttacker;
}

/** `[filter_base_value]`: greater_than / less_than / equals, the C++ subset. */
export function baseValueMatches(effect: EffectTree, base: number): boolean {
  const filter = effect.children.find((child) => child.tag === 'filter_base_value');
  if (!filter) return true;
  const greater = Number(filter.attributes.greater_than ?? Number.NaN);
  const less = Number(filter.attributes.less_than ?? Number.NaN);
  const equals = Number(filter.attributes.equals ?? Number.NaN);
  if (Number.isFinite(greater) && !(base > greater)) return false;
  if (Number.isFinite(less) && !(base < less)) return false;
  if (Number.isFinite(equals) && base !== equals) return false;
  return true;
}

/**
 * Combine a list of effects into one value: the port of
 * `unit_abilities::effect::effect_impl` for the non-cumulable path the attack
 * values use.
 *
 * - `value` sets the value (`cumulative=yes` means "at least the base"),
 *   keeping the highest positive and the lowest negative override;
 * - `max_value`/`min_value` clamp the result;
 * - `add` and `sub` accumulate per effect id (highest add, lowest sub);
 * - `multiply` and `divide` are plain factors, applied after the additions.
 */
export function compositeValue(effects: readonly EffectTree[], base: number): number {
  let setMin: number | null = null;
  let setMax: number | null = null;
  let maxValue: number | null = null;
  let minValue: number | null = null;
  const adds = new Map<string, number>();
  const subs = new Map<string, number>();
  const muls = new Map<string, number>();
  const divs = new Map<string, number>();

  for (const effect of effects) {
    const effectId = attributeValue(effect, 'id') ?? attributeValue(effect, 'name') ?? '';
    if (!baseValueMatches(effect, base)) continue;
    const value = numberValue(effect, 'value');
    if (value !== undefined) {
      const cumulative = attributeValue(effect, 'cumulative') === 'yes';
      const candidate = cumulative ? Math.max(base, value) : value;
      setMax = setMax === null ? candidate : Math.max(setMax, candidate);
      setMin = setMin === null ? candidate : Math.min(setMin, candidate);
    }
    const effectMax = numberValue(effect, 'max_value');
    if (effectMax !== undefined) maxValue = maxValue === null ? effectMax : Math.min(maxValue, effectMax);
    const effectMin = numberValue(effect, 'min_value');
    if (effectMin !== undefined) minValue = minValue === null ? effectMin : Math.max(minValue, effectMin);

    const add = numberValue(effect, 'add');
    if (add !== undefined) adds.set(effectId, Math.max(adds.get(effectId) ?? Number.NEGATIVE_INFINITY, add));
    const sub = numberValue(effect, 'sub');
    if (sub !== undefined) subs.set(effectId, Math.min(subs.get(effectId) ?? Number.POSITIVE_INFINITY, -sub));
    const multiply = numberValue(effect, 'multiply');
    if (multiply !== undefined) muls.set(effectId, Math.max(muls.get(effectId) ?? Number.NEGATIVE_INFINITY, multiply));
    const divide = numberValue(effect, 'divide');
    if (divide !== undefined && divide !== 0)
      divs.set(effectId, Math.max(divs.get(effectId) ?? Number.NEGATIVE_INFINITY, divide));
  }

  let valueSet = base;
  if (setMax !== null && setMin !== null) valueSet = Math.max(setMax, 0) + Math.min(setMin, 0);

  let addition = 0;
  for (const value of adds.values()) addition += value;
  let subtraction = 0;
  for (const value of subs.values()) subtraction += value;

  // `src/units/abilities.cpp: individual_value_double` scales the literal by 100 and
  // the composition divides it back, so `multiply=2` doubles and `multiply=0.5` halves.
  let multiplier = 1;
  for (const value of muls.values()) multiplier *= value;
  let divisor = 1;
  for (const value of divs.values()) divisor *= value;

  let composite = ((valueSet + addition + subtraction) * multiplier) / divisor;
  if (maxValue !== null && minValue !== null && minValue < maxValue)
    composite = Math.min(Math.max(composite, minValue), maxValue);
  else if (maxValue !== null) composite = Math.min(composite, maxValue);
  else if (minValue !== null) composite = Math.max(composite, minValue);
  return Math.round(composite);
}

/** The definitions a unit's attack carries, by the ids in `specials=`. */
export function attackEffects(data: WesnothData, specials: readonly string[]): SpecialDef[] {
  const found: SpecialDef[] = [];
  for (const id of specials) {
    const definition = data.weaponSpecials[id];
    if (definition) found.push(definition);
  }
  return found;
}

/** The definitions a unit's `abilities_list` names. */
export function unitAbilities(data: WesnothData, abilities: readonly string[]): SpecialDef[] {
  const found: SpecialDef[] = [];
  for (const id of abilities) {
    const definition = data.abilities[id];
    if (definition) found.push(definition);
  }
  return found;
}

/** Every effect of the given tag inside the definitions. */
export function effectsOf(definitions: readonly SpecialDef[], tag: string): EffectTree[] {
  const effects: EffectTree[] = [];
  for (const definition of definitions) for (const effect of definition.effects) if (effect.tag === tag) effects.push(effect);
  return effects;
}

/** Does any definition carry the given tag? Used for the flag-like specials. */
export function hasTag(definitions: readonly SpecialDef[], tag: string): boolean {
  return definitions.some((definition) => definition.effects.some((effect) => effect.tag === tag));
}

/** The first attribute found under the given tag, for flag-like specials. */
export function tagAttribute(definitions: readonly SpecialDef[], tag: string, name: string): string | undefined {
  for (const definition of definitions)
    for (const effect of definition.effects)
      if (effect.tag === tag && effect.attributes[name] !== undefined) return effect.attributes[name];
  return undefined;
}
