// The built-in `[effect]`s of a unit modification (`[object]`, `[trait]`, `[advancement]`).
//
// Source: `unit::apply_builtin_effect` (`src/units/unit.cpp:2057-2400`) and
// `attack_type::apply_effect` (`src/units/attack_type.cpp`). The port's `Unit` is a reduced
// model of the engine's, so each effect is applied to the fields the port has; the ones it
// has no field for are recorded as markers on `unit.effectMarkers` and listed in
// PORT_COVERAGE.md ("Unit effects") instead of being dropped silently.
//
// Lua effects (`wesnoth.effects.*`, such as World Conquest's) are not here: the Lua kernel
// runs them first and falls back to this function for the built-in names.
import { applyPercentOrFlat, type Unit } from './unit.ts';
import type { WesnothData } from './types.ts';
import type { WmlNode } from './wml.ts';

function text(node: WmlNode, name: string): string {
  return node.attributes[name] ?? '';
}

function flag(node: WmlNode, name: string, fallback = false): boolean {
  const value = node.attributes[name];
  if (value === undefined) return fallback;
  return value === 'yes' || value === 'true';
}

/** `utils::apply_modifier(base, "N" | "N%")`, rounding like the engine. */
function modify(base: number, value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return base;
  return applyPercentOrFlat(base, trimmed);
}

/** Does an `[effect]`'s own attack filter (name, range, type, ...) select this weapon? */
function attackSelected(effect: WmlNode, attack: Unit['attacks'][number]): boolean {
  const name = text(effect, 'name');
  const range = text(effect, 'range');
  const type = text(effect, 'type');
  const specials = text(effect, 'has_special');
  if (name && !name.split(',').map((item) => item.trim()).includes(attack.name)) return false;
  if (range && !range.split(',').map((item) => item.trim()).includes(attack.range)) return false;
  if (type && !type.split(',').map((item) => item.trim()).includes(attack.type)) return false;
  if (specials && !specials.split(',').map((item) => item.trim()).some((id) => attack.specials.includes(id))) return false;
  return true;
}

export function applyEffect(data: WesnothData, unit: Unit, effect: WmlNode): void {
  const applyTo = text(effect, 'apply_to');
  switch (applyTo) {
    case 'hitpoints': {
      const setHp = text(effect, 'set');
      const setTotal = text(effect, 'set_total');
      const increaseTotal = text(effect, 'increase_total');
      const increase = text(effect, 'increase');
      const violateMax = flag(effect, 'violate_maximum');
      if (setHp) unit.hitpoints = setHp.endsWith('%') ? Math.trunc((Number(setHp.slice(0, -1)) * unit.maxHitpoints) / 100) : Number(setHp);
      if (setTotal) unit.maxHitpoints = setTotal.endsWith('%') ? Math.trunc((Number(setTotal.slice(0, -1)) * unit.maxHitpoints) / 100) : Number(setTotal);
      if (increaseTotal) {
        const before = unit.maxHitpoints;
        unit.maxHitpoints = modify(unit.maxHitpoints, increaseTotal);
        // `set_max_hitpoints` keeps the current total in step with the new maximum
        unit.hitpoints += Math.max(0, unit.maxHitpoints - before);
      }
      if (unit.maxHitpoints < 1) unit.maxHitpoints = 1;
      if (flag(effect, 'heal_full')) unit.hitpoints = unit.maxHitpoints;
      if (increase) unit.hitpoints = modify(unit.hitpoints, increase);
      if (unit.hitpoints > unit.maxHitpoints && !violateMax) unit.hitpoints = unit.maxHitpoints;
      if (unit.hitpoints < 1) unit.hitpoints = 1;
      break;
    }
    case 'movement': {
      const oldMax = unit.maxMovement;
      if (text(effect, 'set')) unit.maxMovement = Number(text(effect, 'set'));
      if (text(effect, 'increase')) unit.maxMovement = modify(unit.maxMovement, text(effect, 'increase'));
      if (unit.maxMovement < 0) unit.maxMovement = 0;
      unit.movement = Math.max(0, Math.min(unit.maxMovement, unit.movement + (unit.maxMovement - oldMax)));
      break;
    }
    case 'max_experience': {
      if (text(effect, 'set')) unit.maxExperience = Number(text(effect, 'set'));
      if (text(effect, 'increase')) unit.maxExperience = Math.max(1, modify(unit.maxExperience, text(effect, 'increase')));
      break;
    }
    case 'recall_cost': {
      const current = unit.recallCost ?? 20;
      if (text(effect, 'set')) unit.recallCost = Number(text(effect, 'set'));
      else if (text(effect, 'increase')) unit.recallCost = modify(current, text(effect, 'increase'));
      break;
    }
    case 'attack': {
      for (const attack of unit.attacks) {
        if (!attackSelected(effect, attack)) continue;
        if (text(effect, 'set_name')) attack.name = text(effect, 'set_name');
        if (text(effect, 'set_description')) attack.description = text(effect, 'set_description');
        if (text(effect, 'set_type')) attack.type = text(effect, 'set_type');
        if (text(effect, 'set_range')) attack.range = text(effect, 'set_range');
        if (text(effect, 'set_icon')) attack.icon = text(effect, 'set_icon');
        if (text(effect, 'set_damage')) attack.damage = Number(text(effect, 'set_damage'));
        if (text(effect, 'increase_damage')) attack.damage = Math.max(0, modify(attack.damage, text(effect, 'increase_damage')));
        if (text(effect, 'set_attacks')) attack.number = Number(text(effect, 'set_attacks'));
        if (text(effect, 'increase_attacks')) attack.number = Math.max(0, modify(attack.number, text(effect, 'increase_attacks')));
        if (text(effect, 'increase_accuracy')) attack.accuracy = (attack.accuracy ?? 0) + Number(text(effect, 'increase_accuracy'));
        if (text(effect, 'increase_parry')) attack.parry = (attack.parry ?? 0) + Number(text(effect, 'increase_parry'));
        for (const specials of effect.children.filter((child) => child.tag === 'set_specials')) {
          if (text(specials, 'mode') !== 'append') attack.specials = [];
          for (const special of specials.children) {
            const id = special.attributes.id ?? special.tag;
            if (!attack.specials.includes(id)) attack.specials.push(id);
          }
        }
        for (const specials of effect.children.filter((child) => child.tag === 'remove_specials')) {
          const ids = new Set(Object.values(specials.attributes).join(',').split(',').map((item) => item.trim()));
          attack.specials = attack.specials.filter((id) => !ids.has(id));
        }
      }
      break;
    }
    case 'new_attack': {
      unit.attacks.push({
        name: text(effect, 'name'),
        description: text(effect, 'description') || text(effect, 'name'),
        type: text(effect, 'type') || 'blade',
        range: text(effect, 'range') || 'melee',
        damage: Number(text(effect, 'damage')) || 0,
        number: Number(text(effect, 'number')) || 1,
        icon: text(effect, 'icon'),
        specials: effect.children
          .filter((child) => child.tag === 'specials')
          .flatMap((specials) => specials.children.map((special) => special.attributes.id ?? special.tag)),
      });
      break;
    }
    case 'remove_attacks': {
      unit.attacks = unit.attacks.filter((attack) => !attackSelected(effect, attack));
      break;
    }
    case 'movement_costs': {
      const costs = effect.children.find((child) => child.tag === 'movement_costs');
      if (!costs) break;
      const next = flag(effect, 'replace') ? {} : { ...(unit.movementCostOverrides ?? {}) };
      for (const [terrain, raw] of Object.entries(costs.attributes)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        const base = next[terrain] ?? 0;
        const result = flag(effect, 'replace') ? value : base + value;
        next[terrain] = result >= 99 ? Number.POSITIVE_INFINITY : result;
      }
      unit.movementCostOverrides = next;
      break;
    }
    case 'defense': {
      const defenses = effect.children.find((child) => child.tag === 'defense');
      if (!defenses) break;
      const next = flag(effect, 'replace') ? {} : { ...(unit.defenseMods ?? {}) };
      for (const [terrain, raw] of Object.entries(defenses.attributes)) {
        const value = Number(raw);
        if (Number.isFinite(value)) next[terrain] = (flag(effect, 'replace') ? 0 : next[terrain] ?? 0) + value;
      }
      unit.defenseMods = next;
      break;
    }
    case 'resistance': {
      const resistances = effect.children.find((child) => child.tag === 'resistance');
      if (!resistances) break;
      const next = flag(effect, 'replace') ? {} : { ...(unit.resistanceMods ?? {}) };
      for (const [damageType, raw] of Object.entries(resistances.attributes)) {
        const value = Number(raw);
        if (Number.isFinite(value)) next[damageType] = (next[damageType] ?? 0) + value;
      }
      unit.resistanceMods = next;
      break;
    }
    case 'alignment': {
      const alignment = text(effect, 'set');
      if (alignment === 'lawful' || alignment === 'neutral' || alignment === 'chaotic' || alignment === 'liminal') unit.alignment = alignment;
      break;
    }
    case 'new_ability': {
      for (const abilities of effect.children.filter((child) => child.tag === 'abilities')) {
        for (const ability of abilities.children) {
          const id = ability.attributes.id ?? ability.tag;
          if (data.abilities[id] && !unit.extraAbilities.includes(id)) unit.extraAbilities.push(id);
        }
      }
      break;
    }
    case 'remove_ability': {
      for (const abilities of effect.children.filter((child) => child.tag === 'abilities')) {
        for (const ability of abilities.children) {
          const id = ability.attributes.id ?? ability.tag;
          unit.extraAbilities = unit.extraAbilities.filter((existing) => existing !== id);
        }
      }
      break;
    }
    case 'status': {
      const add = text(effect, 'add');
      const remove = text(effect, 'remove');
      if (add === 'poisoned') unit.poisoned = true;
      if (add === 'slowed') unit.slowed = true;
      if (remove === 'poisoned') unit.poisoned = false;
      if (remove === 'slowed') unit.slowed = false;
      if (remove === 'petrified') unit.petrified = false;
      break;
    }
    case 'loyal': {
      unit.loyal = true;
      break;
    }
    case 'fearless':
    case 'healthy':
    case 'zoc':
    case 'vision':
    case 'jamming':
    case 'max_attacks':
    case 'ellipse':
    case 'image_mod':
    case 'new_animation':
    case 'profile':
    case 'type':
    case 'variation':
    case 'gender':
    case 'experience':
    default: {
      // Presentation-only or not modelled by the port's unit: remembered, not applied.
      (unit.effectMarkers ??= []).push(applyTo);
      if (applyTo === 'experience' && text(effect, 'increase')) unit.experience = Math.max(0, modify(unit.experience, text(effect, 'increase')));
      break;
    }
  }
}
