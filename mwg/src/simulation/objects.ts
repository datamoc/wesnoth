/**
 * Items and `[object]` modifications, ported from the `[object]`/`[item]`
 * handling in `src/units/unit.cpp` (effect application) and the item macros
 * in `data/core/macros/items.cfg` (`PICKUPPABLE_ITEM`: an `[item]` on a hex
 * plus an `[object]` the unit stepping on it may take).
 *
 * An object is a bag of trait-shaped numeric effects plus the extras objects
 * allow: `heal_full` and `remove=` under `apply_to=status`, and ability
 * gifts. The numeric effects use the same percent-or-flat rule as trait
 * effects (`applyPercentOrFlat` in `unit.ts`), so traits, AMLA and objects
 * share one arithmetic.
 *
 * Scenario files place items and wire their pickup events (P3 owns the event
 * engine); this module owns the content shape and the apply rule, so P2 can
 * prove items load and apply through MWL-shaped data.
 */

import type { AppliedObject, ItemInstance, ObjectDef, WesnothData } from './types.ts';
import type { Unit } from './unit.ts';
import type { WmlNode } from './wml.ts';

/**
 * Apply one object to a unit: numeric effects adjust maxima (and current
 * hitpoints/movement with them), `heal_full` restores to full, `remove=`
 * clears a status, and granted abilities land in `extraAbilities` where
 * `abilitiesOf` reads them.
 */
export function applyObject(data: WesnothData, unit: Unit, object: ObjectDef): void {
  const applied: AppliedObject = {
    object,
    hitpointsDelta: 0,
    movementDelta: 0,
    maxExperienceDelta: 0,
    attackDeltas: [],
    grantedAbilities: [],
  };
  for (const effect of object.effects) {
    switch (effect.applyTo) {
      case 'hitpoints': {
        if (effect.increaseTotal !== undefined) {
          const before = unit.maxHitpoints;
          unit.maxHitpoints = addPercentOrFlat(before, effect.increaseTotal);
          applied.hitpointsDelta += unit.maxHitpoints - before;
          unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints + (unit.maxHitpoints - before));
        }
        if (effect.healFull) unit.hitpoints = unit.maxHitpoints;
        break;
      }
      case 'movement': {
        if (effect.increase !== undefined) {
          const delta = Number(effect.increase);
          if (Number.isFinite(delta)) {
            unit.maxMovement += delta;
            unit.movement = Math.max(0, unit.movement + delta);
            applied.movementDelta += delta;
          }
        }
        break;
      }
      case 'max_experience': {
        if (effect.increase !== undefined) {
          const before = unit.maxExperience;
          unit.maxExperience = Math.max(0, addPercentOrFlat(unit.maxExperience, effect.increase));
          applied.maxExperienceDelta += unit.maxExperience - before;
        }
        break;
      }
      case 'attack': {
        if (effect.increaseDamage !== undefined) {
          unit.attacks.forEach((attack, index) => {
            if (!effect.range || effect.range === attack.range) {
              const before = attack.damage;
              attack.damage = addPercentOrFlat(attack.damage, effect.increaseDamage!);
              applied.attackDeltas.push({ index, delta: attack.damage - before });
            }
          });
        }
        break;
      }
      case 'movement_costs': {
        if (effect.movementCosts) {
          applied.previousMovementCosts = { ...(unit.movementCostOverrides ?? {}) };
          const next = effect.replace ? {} : { ...(unit.movementCostOverrides ?? {}) };
          for (const [terrain, raw] of Object.entries(effect.movementCosts)) {
            if (Number.isFinite(raw)) next[terrain] = raw >= 99 ? Number.POSITIVE_INFINITY : raw;
          }
          unit.movementCostOverrides = next;
        }
        break;
      }
      case 'status': {
        if (effect.remove === 'poisoned') unit.poisoned = false;
        else if (effect.remove === 'slowed') unit.slowed = false;
        else if (effect.remove === 'petrified') unit.petrified = false;
        break;
      }
      default:
        break;
    }
  }
  for (const ability of object.abilities) {
    if (data.abilities[ability] && !unit.extraAbilities.includes(ability)) {
      unit.extraAbilities.push(ability);
      applied.grantedAbilities.push(ability);
    }
  }
  (unit.appliedObjects ??= []).push(applied);
}

/** Remove the first matching object and reverse the deltas it contributed. */
export function removeObject(data: WesnothData, unit: Unit, objectId: string): boolean {
  const objects = unit.appliedObjects;
  if (!objects?.length) return false;
  const index = objects.findIndex((entry) => entry.object.id === objectId);
  if (index < 0) return false;
  const applied = objects.splice(index, 1)[0];
  unit.maxHitpoints = Math.max(1, unit.maxHitpoints - applied.hitpointsDelta);
  unit.hitpoints = Math.max(1, Math.min(unit.maxHitpoints, unit.hitpoints - applied.hitpointsDelta));
  unit.maxMovement = Math.max(0, unit.maxMovement - applied.movementDelta);
  unit.movement = Math.max(0, unit.movement - applied.movementDelta);
  unit.maxExperience = Math.max(0, unit.maxExperience - applied.maxExperienceDelta);
  if (applied.previousMovementCosts) unit.movementCostOverrides = applied.previousMovementCosts;
  for (const attack of applied.attackDeltas) {
    if (unit.attacks[attack.index]) unit.attacks[attack.index].damage -= attack.delta;
  }
  for (const ability of applied.grantedAbilities) {
    if (!objects.some((entry) => entry.grantedAbilities.includes(ability)) && !data.unitTypes[unit.typeId]?.abilities.includes(ability)) {
      unit.extraAbilities = unit.extraAbilities.filter((entry) => entry !== ability);
    }
  }
  return true;
}

function addPercentOrFlat(base: number, value: number | string): number {
  if (typeof value === 'number') return base + value;
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (match) return Math.round((base * (100 + Number(match[1]))) / 100);
  const flat = Number(value);
  return base + (Number.isFinite(flat) ? flat : 0);
}

/**
 * Pick up every untaken item on the unit's hex: apply its object and mark it
 * taken. Returns the object ids applied. Mirrors the `PICKUPPABLE_ITEM`
 * moveto shape (take on step, once).
 */
export function pickupItems(data: WesnothData, unit: Unit, items: ItemInstance[]): string[] {
  const applied: string[] = [];
  for (const item of items) {
    if (item.taken || item.x !== unit.x || item.y !== unit.y) continue;
    applyObject(data, unit, item.object);
    item.taken = true;
    applied.push(item.object.id);
  }
  return applied;
}

/**
 * Read an `[object]` node into data. Unknown `apply_to` values are dropped;
 * `effects` holds exactly what the rules will run, so a scenario gift is
 * never silently half-applied.
 */
export function objectFromWml(node: WmlNode): ObjectDef | null {
  if (node.tag !== 'object') return null;
  const effects: ObjectDef['effects'] = [];
  const abilities: string[] = [];
  for (const child of node.children) {
    if (child.tag !== 'effect') continue;
    const applyTo = child.attributes.apply_to;
    if (!applyTo) continue;
    if (applyTo === 'attack' || applyTo === 'hitpoints' || applyTo === 'movement' || applyTo === 'max_experience') {
      const effect: ObjectDef['effects'][number] = { applyTo };
      if (child.attributes.range) effect.range = child.attributes.range;
      if (child.attributes.increase !== undefined && child.attributes.increase !== '') effect.increase = parseEffectValue(child.attributes.increase);
      if (child.attributes.increase_total !== undefined && child.attributes.increase_total !== '') effect.increaseTotal = parseEffectValue(child.attributes.increase_total);
      if (child.attributes.increase_damage !== undefined && child.attributes.increase_damage !== '') effect.increaseDamage = parseEffectValue(child.attributes.increase_damage);
      if (child.attributes.heal_full === 'yes') effect.healFull = true;
      effects.push(effect);
    } else if (applyTo === 'movement_costs') {
      const table = child.children.find((grandchild) => grandchild.tag === 'movement_costs');
      const movementCosts: Record<string, number> = {};
      for (const [terrain, raw] of Object.entries(table?.attributes ?? {})) {
        const value = Number(raw);
        if (Number.isFinite(value)) movementCosts[terrain] = value;
      }
      effects.push({ applyTo, movementCosts, replace: child.attributes.replace === 'yes' });
    } else if (applyTo === 'status') {
      if (child.attributes.remove) effects.push({ applyTo, remove: child.attributes.remove });
      if (child.attributes.heal_full === 'yes') effects.push({ applyTo: 'hitpoints', healFull: true });
    } else if (applyTo === 'new_ability') {
      for (const ability of (child.attributes.abilities_list ?? child.attributes.id ?? '').split(',')) {
        const id = ability.trim();
        if (id) abilities.push(id);
      }
    }
  }
  return { id: node.attributes.id ?? '', effects, abilities };
}

/**
 * Read an `[item]` node with its inline `[object]` child, if it has one.
 * WML coordinates are 1-based; the port's state is 0-based.
 */
export function itemFromWml(node: WmlNode): ItemInstance | null {
  if (node.tag !== 'item') return null;
  const x = Number(node.attributes.x);
  const y = Number(node.attributes.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const objectNode = node.children.find((child) => child.tag === 'object');
  const object: ObjectDef = objectNode ? (objectFromWml(objectNode) ?? { id: '', effects: [], abilities: [] }) : { id: '', effects: [], abilities: [] };
  return { x: x - 1, y: y - 1, name: node.attributes.name, image: node.attributes.image ?? '', object, taken: false };
}

function parseEffectValue(raw: string): number | string {
  const trimmed = raw.trim();
  if (trimmed.endsWith('%')) return trimmed;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : trimmed;
}
