/**
 * Game state and the turn/economy rules around it. Constants are the real
 * `game_config` values (`src/game_config.cpp` in the 1.19.27 checkout):
 * base_income 2, village_income 1, village_support 1, rest_heal_amount 2,
 * kill_experience 8, combat_experience 1. Upkeep is one per unit level, reduced
 * by one per owned village, floored at zero (`team::calculate_upkeep`).
 */

import { hexNeighbors } from 'mwg';
import { FactionFog } from 'mwg/board';
import { applyPercentOrFlat, clearTurnStatuses, hasTraitMarker, makeUnit, poisonTick, type Rng, type Unit } from './unit.ts';
import { effectiveMovetype, resolveTerrain, splitCode, terrainIdForCode } from './terrain.ts';
import { isHidden, visibleHexesForUnit } from './vision.ts';
import type { ItemInstance, TimeAreaDef, TimeOfDayDef, WesnothData } from './types.ts';
import {
  abilitiesOf,
  attackNumbers,
  damagePerStrike,
  hasAbility,
  plagueTypeOf,
  resolveAttack,
  retaliationAttack,
  type AttackContext,
  type AttackNumbers,
  type CombatExchange,
} from './combat.ts';

export interface GameState {
  width: number;
  height: number;
  /** map terrain codes, `width * height`, row-major */
  terrainCodes: string[];
  /** village owner per cell: side number or null */
  villageOwner: (number | null)[];
  units: Unit[];
  /** side numbers present, in turn order */
  sides: number[];
  /** Team identity for shared vision and allied ZoC/combat rules. */
  teams: Map<number, string>;
  turn: number;
  round: number;
  /** index into the active schedule (see `activeSchedule`) */
  scheduleIndex: number;
  /** keep hexes per side, from the map's `N Kh` markers */
  keeps: Map<number, { x: number; y: number }[]>;
  /**
   * Sides whose scenario declares a `[side] leader=`. Such a side must have a
   * living `canrecruit` unit standing on a keep to recruit (`game_state::
   * can_recruit_on`); a side absent from this set is the port-authored skirmish
   * with no leader unit and keeps the pre-leader approximation. Optional so
   * existing snapshots and rule fixtures are unaffected.
   */
  leaderSides?: ReadonlySet<number>;
  /**
   * Per-team fog and shroud: the framework's `FactionFog` (`mwg/board`)
   * keeps what each side sees now and has ever seen. The port only supplies
   * the per-unit visible hexes (`vision.ts`); sides with the same explicit
   * team sync through one shared faction key.
   */
  fog: FactionFog;
  /** scenario `[time_area]` overrides, checked before the schedule */
  timeAreas: TimeAreaDef[];
  /** map items waiting for pickup */
  items: ItemInstance[];
  /** active named schedule id (a key of `data.schedules`, default `default`) */
  scheduleId: string;
  /** Runtime schedules installed by `[replace_schedule]`. */
  customSchedules?: Record<string, TimeOfDayDef[]>;
  /** Per-side economy overrides installed by `[modify_side]`. */
  sideRules?: Record<number, { villageSupport?: number }>;
  /** Temporary or multi-turn `[lift_fog]` locations, keyed by faction. */
  fogLifts?: Record<string, { x: number; y: number; untilTurn: number }[]>;
  /** Explicit `[place_shroud]` cells, keyed by faction. */
  forcedShroud?: Record<string, string[]>;
  /**
   * Bumped by `setTerrainAt`; the sight cache (`vision.ts`) and any other
   * derived view compare it instead of diffing the map.
   */
  terrainVersion?: number;
}

export interface NewGameOptions {
  scheduleId?: string;
  timeAreas?: TimeAreaDef[];
  items?: ItemInstance[];
  teams?: ReadonlyMap<number, string>;
}

export const BASE_INCOME = 2;
export const VILLAGE_INCOME = 1;
export const VILLAGE_SUPPORT = 1;
export const REST_HEAL = 2;
export const KILL_EXPERIENCE = 8;
export const COMBAT_EXPERIENCE = 1;
/** `poison_amount`, src/game_config.cpp:47. Poison cannot kill. */
export const POISON_AMOUNT = 8;

export function makeGame(
  width: number,
  height: number,
  terrainCodes: string[],
  keeps: Map<number, { x: number; y: number }[]>,
  options: NewGameOptions = {},
): GameState {
  return {
    width,
    height,
    terrainCodes,
    villageOwner: Array.from({ length: width * height }, () => null),
    units: [],
    sides: [1, 2],
    teams: new Map(options.teams ?? [[1, '1'], [2, '2']]),
    turn: 1,
    round: 1,
    scheduleIndex: 0,
    keeps,
    fog: new FactionFog(width, height),
    timeAreas: options.timeAreas ?? [],
    items: options.items ?? [],
    scheduleId: options.scheduleId ?? 'default',
    sideRules: {},
  };
}

/** Return the team key used by fog/shroud and allied-unit rules. */
export function teamOf(state: GameState, side: number): string {
  return state.teams.get(side) ?? String(side);
}

export function areAllied(state: GameState, first: number, second: number): boolean {
  return teamOf(state, first) === teamOf(state, second);
}

export function inside(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

export function cellIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

/**
 * Change one cell's terrain code. The state carries a revision so the sight
 * cache (`vision.ts`) and any other derived view can tell that the map moved
 * without diffing it.
 */
export function setTerrainAt(state: GameState, x: number, y: number, code: string): void {
  const index = cellIndex(state, x, y);
  if (index < 0 || index >= state.terrainCodes.length) return;
  state.terrainCodes[index] = code;
  state.terrainVersion = (state.terrainVersion ?? 0) + 1;
}

export function terrainCodeAt(state: GameState, x: number, y: number): string {
  return state.terrainCodes[cellIndex(state, x, y)] ?? 'Gg';
}

export function unitAt(state: GameState, x: number, y: number): Unit | undefined {
  return state.units.find((unit) => unit.x === x && unit.y === y);
}

export function villageOwnerAt(state: GameState, x: number, y: number): number | null {
  return state.villageOwner[cellIndex(state, x, y)];
}

export function ownsVillage(state: GameState, side: number, x: number, y: number): boolean {
  return villageOwnerAt(state, x, y) === side;
}

/**
 * The schedule list in force: the named schedule when the pipeline compiled
 * it (`data.schedules`, from every `*_SCHEDULE` macro in `schedules.cfg`),
 * else the legacy default list. Older snapshots predate `schedules`, so the
 * fallback keeps them working.
 */
export function activeSchedule(data: WesnothData, state: GameState) {
  return state.customSchedules?.[state.scheduleId] ?? data.schedules?.[state.scheduleId] ?? data.schedule;
}

/** Match one WML range list (1-based, e.g. `"3"`, `"1-5,8"`) against a 0-based coordinate. */
export function rangeCovers(ranges: string, coordinate: number): boolean {
  const wanted = coordinate + 1;
  for (const part of ranges.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const span = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (span) {
      if (wanted >= Number(span[1]) && wanted <= Number(span[2])) return true;
    } else if (Number(trimmed) === wanted) {
      return true;
    }
  }
  return false;
}

/** Does a `[time_area]` cover this hex (`src/tod_manager.cpp:391`)? */
export function timeAreaCovers(area: TimeAreaDef, x: number, y: number): boolean {
  return rangeCovers(area.xs, x) && rangeCovers(area.ys, y);
}

/**
 * The lawful bonus in force on one hex: the first covering `[time_area]` wins,
 * else the scenario schedule. The real engine indexes each area's own time
 * list by the shared turn counter; this port does the same.
 */
export function lawfulBonusAt(data: WesnothData, state: GameState, x: number, y: number): number {
  for (const area of state.timeAreas) {
    if (area.times.length > 0 && timeAreaCovers(area, x, y)) {
      return area.times[state.scheduleIndex % area.times.length]?.lawfulBonus ?? 0;
    }
  }
  const schedule = activeSchedule(data, state);
  return schedule[state.scheduleIndex % Math.max(1, schedule.length)]?.lawfulBonus ?? 0;
}

/**
 * Recompute fog and shroud memory for every side. Call after anything moves,
 * is recruited, or dies. Fog reads the last sync, so every rule that moves
 * units syncs; tests that teleport fixtures by hand sync explicitly.
 */
export function updateVision(state: GameState, data: WesnothData): void {
  const teams = new Map<string, number>();
  for (const side of state.sides) teams.set(teamOf(state, side), side);
  for (const faction of teams.keys()) {
    const placed = new Map<string, Unit>();
    for (const unit of state.units) {
      if (teamOf(state, unit.side) !== faction || unit.hitpoints <= 0 || unit.petrified) continue;
      placed.set(`${unit.x},${unit.y}`, unit);
    }
    state.fog.sync(
      faction,
      [...placed.values()],
      (source) => {
        const unit = placed.get(`${source.x},${source.y}`);
        if (!unit) return [];
        const blocked = new Set(state.forcedShroud?.[faction] ?? []);
        return [...visibleHexesForUnit(state, data, unit)]
          .map((index) => ({ x: index % state.width, y: Math.floor(index / state.width) }))
          .filter((cell) => !blocked.has(`${cell.x},${cell.y}`));
      },
    );
  }
}

/** Has this side never seen the hex (shroud, as opposed to mere fog)? */
export function isShrouded(state: GameState, side: number, x: number, y: number): boolean {
  const faction = teamOf(state, side);
  return (state.forcedShroud?.[faction] ?? []).includes(`${x},${y}`) || !state.fog.isExplored(faction, x, y);
}

/** Can this side not see the hex right now (fog, as of the last sync)? */
export function isFogged(state: GameState, _data: WesnothData, side: number, x: number, y: number): boolean {
  const faction = teamOf(state, side);
  if ((state.forcedShroud?.[faction] ?? []).includes(`${x},${y}`)) return true;
  const lifted = state.fogLifts?.[faction] ?? [];
  if (lifted.some((cell) => cell.x === x && cell.y === y && cell.untilTurn >= state.turn)) return false;
  return !state.fog.isVisible(teamOf(state, side), x, y);
}

/** Hexes adjacent to (x, y) that hold an enemy unit of `side` that emits ZoC. */
export function enemyZoc(state: GameState, side: number, x: number, y: number): boolean {
  for (const next of hexNeighbors(x, y)) {
    const unit = unitAt(state, next.x, next.y);
    if (unit && !areAllied(state, unit.side, side) && unit.level > 0) return true;
  }
  return false;
}

/** `skirmisher`: the unit ignores enemy zones of control when it moves. */
export function isSkirmisher(_state: GameState, unit: Unit, data?: WesnothData): boolean {
  if (!data) return false;
  return abilitiesOf(data, unit).some((ability) => ability.effects.some((effect) => effect.tag === 'skirmisher'));
}

/**
 * `leadership`: adjacent same-side allies of a lower level deal 25% more damage
 * per level of difference. The data writes this as the formula
 * `value="(25 * (level - other.level))"`, which the port evaluates for its
 * documented meaning; `cumulative=no` means only the best leader counts.
 */
export function leadershipBonus(state: GameState, data: WesnothData, unit: Unit): number {
  if (unit.petrified) return 0;
  let best = 0;
  for (const neighbour of hexNeighbors(unit.x, unit.y)) {
    const ally = unitAt(state, neighbour.x, neighbour.y);
    if (!ally || ally.id === unit.id || ally.side !== unit.side || ally.hitpoints <= 0 || ally.petrified) continue;
    if (!abilitiesOf(data, ally).some((ability) => ability.effects.some((effect) => effect.tag === 'leadership'))) continue;
    best = Math.max(best, Math.max(0, 25 * (ally.level - unit.level)));
  }
  return best;
}

/**
 * `illuminates`: while such a unit stands next to this hex, the time of day counts
 * as day (+25) for everyone, which is what the ability's WML sets up.
 */
export function illuminatedNear(state: GameState, data: WesnothData, unit: Unit): boolean {
  for (const neighbour of hexNeighbors(unit.x, unit.y)) {
    const neighbourUnit = unitAt(state, neighbour.x, neighbour.y);
    if (!neighbourUnit || neighbourUnit.hitpoints <= 0) continue;
    if (abilitiesOf(data, neighbourUnit).some((ability) => ability.effects.some((effect) => effect.tag === 'illuminates'))) return true;
  }
  return false;
}

/**
 * `backstab`: an enemy of the target standing on the hex beyond it, opposite the
 * attacker. The data uses a `[filter_opponent]` formula for this; the port
 * evaluates the rule itself.
 */
export function isFlanked(state: GameState, attacker: Unit, defender: Unit): boolean {
  const ax = attacker.x - defender.x;
  const ay = attacker.y - defender.y;
  let best: { x: number; y: number } | null = null;
  // The flanking hex is the neighbour furthest from the attacker - the far side of
  // the target - so the smallest dot product wins, and the attacker's own hex is
  // never a flank.
  let bestDot = Number.POSITIVE_INFINITY;
  for (const neighbour of hexNeighbors(defender.x, defender.y)) {
    if (neighbour.x === attacker.x && neighbour.y === attacker.y) continue;
    const dot = (neighbour.x - defender.x) * ax + (neighbour.y - defender.y) * ay;
    if (dot < bestDot) {
      bestDot = dot;
      best = neighbour;
    }
  }
  if (!best) return false;
  const flanker = unitAt(state, best.x, best.y);
  return Boolean(flanker && flanker.id !== attacker.id && !areAllied(state, flanker.side, defender.side) && !flanker.petrified && flanker.hitpoints > 0);
}

/** Statuses and effects a unit is immune to, from its trait markers. */
export function immunities(data: WesnothData, unit: Unit): string[] {
  const immune: string[] = [];
  if (hasTraitMarker(data, unit, 'status:unpoisonable')) immune.push('poison', 'slow');
  if (hasTraitMarker(data, unit, 'status:undrainable')) immune.push('drain');
  if (hasTraitMarker(data, unit, 'status:unplagueable')) immune.push('plague');
  return immune;
}

/** `[disable]` ids on the unit's weapons: specials it suppresses on the target. */
export function disablesOf(data: WesnothData, unit: Unit, attack: { specials: string[] }): string[] {
  const ids: string[] = [];
  for (const weapon of unit.attacks) {
    if (weapon !== attack) continue;
    for (const specialId of weapon.specials) {
      const definition = data.weaponSpecials[specialId];
      for (const effect of definition?.effects ?? []) {
        if (effect.tag !== 'disable') continue;
        const target = effect.attributes.disable ?? effect.attributes.id;
        if (target) ids.push(target);
      }
    }
  }
  return ids;
}

/**
 * End-of-turn healing for one side: friendly villages heal their `heals` value,
 * resting or `healthy` units heal the rest amount, and adjacent allies with a
 * `heals` ability (or `cures`/`unpoison`) heal and cure.
 */
export function endTurnHealing(state: GameState, data: WesnothData, side: number): number {
  let healed = 0;
  for (const unit of state.units) {
    if (unit.side !== side || unit.hitpoints <= 0 || unit.petrified) continue;
    const terrain = resolveTerrain(data, movetypeFor(data, unit), terrainCodeAt(state, unit.x, unit.y));
    let amount = 0;
    if (terrain.isVillage && villageOwnerAt(state, unit.x, unit.y) === side) amount = Math.max(amount, terrain.heals);
    if (unit.resting || hasTraitMarker(data, unit, 'healthy')) amount = Math.max(amount, REST_HEAL);
    let cured = false;
    for (const neighbour of hexNeighbors(unit.x, unit.y)) {
      const ally = unitAt(state, neighbour.x, neighbour.y);
      if (!ally || ally.id === unit.id || ally.side !== side || ally.hitpoints <= 0) continue;
      for (const ability of abilitiesOf(data, ally)) {
        for (const effect of ability.effects) {
          // `cures` and `unpoison` are `[heals]` effects with `poison=cured`
          // (`data/core/macros/abilities.cfg`): the cure replaces the healing.
          if (effect.tag === 'heals') {
            const poison = effect.attributes.poison;
            if ((poison === 'cured' || poison === 'unpoison') && unit.poisoned) {
              unit.poisoned = false;
              cured = true;
            }
            const value = Number(effect.attributes.value ?? 0);
            if (value > 0 && !cured) amount = Math.max(amount, value);
          }
          if (effect.tag === 'regenerates') amount = Math.max(amount, Number(effect.attributes.value ?? 8));
        }
      }
    }
    const before = unit.hitpoints;
    unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints + amount);
    healed += unit.hitpoints - before;
  }
  return healed;
}

/**
 * One advancement the player may choose at full experience: an `advance:`
 * target from `advances_to`, or the default AMLA. Wesnoth offers per-type
 * `[advancement]` options with effects; the pipeline keeps only the
 * `advances_to` tree, so every type offers the default AMLA
 * (`AMLA_DEFAULT` in `data/core/macros/amla.cfg`: +3 max HP, +20% max XP,
 * heal to full, remove poison and slow) beside its listed advances. There is
 * no `max_times` cap yet; a unit may take the default AMLA any number of
 * times, which `PORT_COVERAGE.md` records.
 */
export interface AdvancementOption {
  id: string;
  label: string;
}

export function advancementOptions(data: WesnothData, unit: Unit): AdvancementOption[] {
  const type = data.unitTypes[unit.typeId];
  const options: AdvancementOption[] = [];
  for (const target of type?.advancesTo ?? []) {
    if (!data.unitTypes[target]) continue;
    options.push({ id: `advance:${target}`, label: `Advance to ${data.unitTypes[target].name || target}` });
  }
  options.push({ id: 'amla_default', label: 'AMLA: Max HP +3, Max XP +20%, heal and cure' });
  return options;
}

/**
 * Apply the player's advancement choice at full experience. An `advance:`
 * target rebuilds the unit from the new type (keeping id, name, side,
 * position and surplus experience); `amla_default` applies `AMLA_DEFAULT`.
 */
export function advanceUnitChoice(state: GameState, data: WesnothData, unit: Unit, choiceId: string): boolean {
  if (unit.experience < unit.maxExperience) return false;
  if (choiceId.startsWith('advance:')) {
    const target = choiceId.slice('advance:'.length);
    if (!data.unitTypes[unit.typeId]?.advancesTo.includes(target) || !data.unitTypes[target]) return false;
    const replacement = makeUnit(data, target, unit.side, unit.x, unit.y);
    replacement.id = unit.id;
    replacement.name = unit.name;
    replacement.experience = unit.experience - unit.maxExperience;
    replacement.movement = Math.min(replacement.maxMovement, unit.movement);
    const index = state.units.findIndex((candidate) => candidate.id === unit.id);
    if (index >= 0) state.units[index] = replacement;
    return true;
  }
  if (choiceId === 'amla_default') {
    unit.maxHitpoints += 3;
    unit.maxExperience = applyPercentOrFlat(unit.maxExperience, '20%');
    unit.experience = 0;
    unit.poisoned = false;
    unit.slowed = false;
    unit.hitpoints = unit.maxHitpoints;
    return true;
  }
  return false;
}

/**
 * Advancement with the engine's default pick: the first `advances_to` type,
 * else the default AMLA. The scene and the AI use this; the choice dialog
 * (when it exists) will call `advanceUnitChoice`. Wesnoth itself always asks
 * the player, so the auto-pick is a documented simplification.
 */
export function advanceUnit(state: GameState, data: WesnothData, unit: Unit): boolean {
  if (unit.experience < unit.maxExperience) return false;
  const type = data.unitTypes[unit.typeId];
  const target = type?.advancesTo?.[0];
  if (target && data.unitTypes[target]) return advanceUnitChoice(state, data, unit, `advance:${target}`);
  return advanceUnitChoice(state, data, unit, 'amla_default');
}

/**
 * Attack prediction for the interface: the chances, strikes and damage of a fight
 * without resolving it (`src/attack_prediction.cpp` does the same for the real
 * combat dialog).
 */
export interface AttackPrediction {
  attackName: string;
  cth: number;
  damage: number;
  strikes: number;
  defenderAttackName: string;
  defenderCth: number;
  defenderDamage: number;
  defenderStrikes: number;
}

export function predictAttack(state: GameState, data: WesnothData, attacker: Unit, defender: Unit, attackName?: string): AttackPrediction | null {
  const attack = attacker.attacks.find((candidate) => candidate.name === (attackName ?? attacker.attacks[0]?.name));
  if (!attack) return null;
  const defense = retaliationAttack(defender, attack.range);
  const defenderTerrain = resolveTerrain(data, movetypeFor(data, defender), terrainCodeAt(state, defender.x, defender.y));
  const attackerTerrain = resolveTerrain(data, movetypeFor(data, attacker), terrainCodeAt(state, attacker.x, attacker.y));
  const bonus = leadershipBonus(state, data, attacker);
  const back = leadershipBonus(state, data, defender);
  const attackerLawful = lawfulBonusAt(data, state, attacker.x, attacker.y);
  const defenderLawful = lawfulBonusAt(data, state, defender.x, defender.y);
  // Diversion (`abilities.cfg`): a diverting attacker with an enemy opposite
  // the target cuts the retaliation's accuracy by 20. The flank geometry is
  // shared with backstab; see `resolveAttack`.
  const diverted = hasAbility(data, attacker, 'diversion') && isFlanked(state, attacker, defender);
  const numbers: AttackNumbers = attackNumbers({ data, lawfulBonus: attackerLawful, damageBonus: bonus }, attacker, attack, {
    isAttacker: true,
    baseCth: 100 - defenderTerrain.defense,
    hitpoints: { current: attacker.hitpoints, max: attacker.maxHitpoints },
    flanked: isFlanked(state, attacker, defender),
    suppressed: [],
  });
  const counter: AttackNumbers | null = defense
    ? attackNumbers({ data, lawfulBonus: defenderLawful, damageBonus: back }, defender, defense, {
        isAttacker: false,
        baseCth: 100 - attackerTerrain.defense,
        hitpoints: { current: defender.hitpoints, max: defender.maxHitpoints },
        opponentWeapon: attack,
        suppressed: [],
      })
    : null;
  if (counter && diverted) counter.cth = Math.max(0, counter.cth - 20);
  return {
    attackName: attack.name,
    cth: numbers.cth,
    damage: damagePerStrike({ data, lawfulBonus: attackerLawful, damageBonus: bonus }, attacker, defender, attack, {
      opponentWeapon: defense ?? undefined,
    }),
    strikes: numbers.attacks,
    defenderAttackName: defense?.name ?? '',
    defenderCth: counter?.cth ?? 0,
    defenderDamage: defense
      ? damagePerStrike({ data, lawfulBonus: defenderLawful, damageBonus: back }, defender, attacker, defense, { opponentWeapon: attack })
      : 0,
    defenderStrikes: counter?.attacks ?? 0,
  };
}

/**
 * The movement type a unit uses: its movetype merged with the unit type's own
 * `[movement_costs]`/`[defense]`/`[resistance]` tables
 * (`src/units/types.cpp:298`, overwrite merge in `src/movetype.cpp:854`).
 */
function movetypeFor(data: WesnothData, unit: Unit) {
  return (
    effectiveMovetype(data, unit.typeId) ??
    data.movetypes[data.unitTypes[unit.typeId]?.movementType ?? ''] ??
    Object.values(data.movetypes)[0]
  );
}


export function recruit(state: GameState, data: WesnothData, side: number, typeId: string, x: number, y: number, rng: Rng = Math.random): Unit | null {
  if (state.turn !== side) return null;
  const type = data.unitTypes[typeId];
  if (!type) throw new Error(`unknown unit type "${typeId}"`);
  if (inside(state, x, y) === false) return null;
  if (unitAt(state, x, y)) return null;
  if (!isRecruitHex(state, data, side, x, y)) return null;
  const unit = makeUnit(data, typeId, side, x, y, rng);
  state.units.push(unit);
  updateVision(state, data);
  return unit;
}

/**
 * The terrain flag behind castle/keep classification (`gamemap::is_castle` /
 * `is_keep` read `recruit_onto`/`recruit_from`, not the code prefix). An overlay
 * that defines the flag wins over the base, the way a merged terrain code works.
 * Undefined only for compiled data that predates the flags.
 */
function terrainRecruitFlag(state: GameState, data: WesnothData, x: number, y: number, flag: 'recruitOnto' | 'recruitFrom'): boolean | undefined {
  const { base, overlay } = splitCode(terrainCodeAt(state, x, y));
  if (overlay) {
    const overlayDef = data.terrains[terrainIdForCode(data, overlay)];
    if (overlayDef?.[flag] !== undefined) return overlayDef[flag];
  }
  const baseDef = data.terrains[terrainIdForCode(data, base)];
  return baseDef?.[flag];
}

/**
 * Is this hex a castle, i.e. can a unit be recruited onto it? Wesnoth marks the
 * real castles (`Ch`, `Co`, `Ce`, keeps, and their winter/ruin variants) with
 * `recruit_onto=yes` (`data/core/terrain.cfg`), so the data decides rather than
 * the code's first two letters. Falls back to the human code prefixes only when
 * the compiled data predates the flag.
 */
export function isCastleHex(state: GameState, data: WesnothData, x: number, y: number): boolean {
  if (!inside(state, x, y)) return false;
  const flagged = terrainRecruitFlag(state, data, x, y, 'recruitOnto');
  if (flagged !== undefined) return flagged;
  const { base } = splitCode(terrainCodeAt(state, x, y));
  return base === 'Ch' || base === 'Kh' || base === 'Chr' || base === 'Chw';
}

/** Is this hex a keep, i.e. must a recruiter stand on it (`recruit_from=yes`)? */
export function isKeepHex(state: GameState, data: WesnothData, x: number, y: number): boolean {
  if (!inside(state, x, y)) return false;
  const flagged = terrainRecruitFlag(state, data, x, y, 'recruitFrom');
  if (flagged !== undefined) return flagged;
  return splitCode(terrainCodeAt(state, x, y)).base === 'Kh';
}

/** A side's recruit-capable leaders: living, non-petrified `canrecruit` units. */
export function sideLeaders(state: GameState, side: number): Unit[] {
  return state.units.filter((unit) => unit.side === side && unit.canRecruit === true && unit.hitpoints > 0 && !unit.petrified);
}

/**
 * `game_state::can_recruit_on` (`src/game_state.cpp:320`): a living leader
 * standing on a keep may recruit onto any vacant castle hex connected to that
 * keep through castle hexes. Wesnoth also refuses a shrouded target; the port
 * omits that check because its fog is a per-turn presentation model and the
 * shipped scenarios recruit on their own explored keeps.
 */
export function canRecruitOn(state: GameState, data: WesnothData, leader: Unit, x: number, y: number): boolean {
  if (!isKeepHex(state, data, leader.x, leader.y)) return false;
  if (!inside(state, x, y) || !isCastleHex(state, data, x, y)) return false;
  if (unitAt(state, x, y)) return false;
  return castlePathExists(state, data, leader.x, leader.y, x, y);
}

/** Breadth-first walk over castle hexes, `castle_cost_calculator`'s a_star. */
function castlePathExists(state: GameState, data: WesnothData, fromX: number, fromY: number, toX: number, toY: number): boolean {
  const queue = [{ x: fromX, y: fromY }];
  const seen = new Set<number>([cellIndex(state, fromX, fromY)]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.x === toX && current.y === toY) return true;
    for (const next of hexNeighbors(current.x, current.y)) {
      if (!inside(state, next.x, next.y)) continue;
      const index = cellIndex(state, next.x, next.y);
      if (seen.has(index) || !isCastleHex(state, data, next.x, next.y)) continue;
      seen.add(index);
      queue.push(next);
    }
  }
  return false;
}

/**
 * May this side recruit onto `(x, y)`? A side with a living leader uses the real
 * `can_recruit_on` rule, so an empty keep (the leader walked away) or a dead
 * leader stops recruitment. A side whose scenario declares no `leader=` (the
 * port-authored skirmish) keeps the earlier approximation: a castle hex
 * connected to one of the side's keep markers.
 */
export function isRecruitHex(state: GameState, data: WesnothData, side: number, x: number, y: number): boolean {
  const leaders = sideLeaders(state, side);
  if (leaders.length > 0) return leaders.some((leader) => canRecruitOn(state, data, leader, x, y));
  if (state.leaderSides?.has(side)) return false;
  return legacyRecruitHex(state, data, side, x, y);
}

/**
 * The pre-leader approximation: the side's keep markers and any castle hex
 * connected to them. The marker itself counts even when the map's terrain is
 * not a real keep, which is how the port-authored rule fixtures place keeps.
 */
function legacyRecruitHex(state: GameState, data: WesnothData, side: number, x: number, y: number): boolean {
  const keeps = state.keeps.get(side) ?? [];
  if (keeps.length === 0 || !inside(state, x, y)) return false;
  if (keeps.some((keep) => keep.x === x && keep.y === y)) return true;
  if (!isCastleHex(state, data, x, y)) return false;
  const target = cellIndex(state, x, y);
  const queue = keeps.map((keep) => ({ x: keep.x, y: keep.y }));
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const index = cellIndex(state, current.x, current.y);
    if (seen.has(index)) continue;
    seen.add(index);
    if (index === target) return true;
    for (const next of hexNeighbors(current.x, current.y)) {
      if (inside(state, next.x, next.y) && isCastleHex(state, data, next.x, next.y)) queue.push(next);
    }
  }
  return false;
}

/**
 * The empty castle hexes a side may recruit onto, nearest to its first keep
 * first, so a caller that just wants "some free castle" (the scene's recruit
 * hotkey, a recall, the AI) does not need to know the connectivity rule.
 */
export function vacantRecruitHexes(state: GameState, data: WesnothData, side: number): { x: number; y: number }[] {
  const anchor = (state.keeps.get(side) ?? [])[0];
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (unitAt(state, x, y)) continue;
      if (!isRecruitHex(state, data, side, x, y)) continue;
      out.push({ x, y });
    }
  }
  if (anchor) out.sort((a, b) => (Math.abs(a.x - anchor.x) + Math.abs(a.y - anchor.y)) - (Math.abs(b.x - anchor.x) + Math.abs(b.y - anchor.y)));
  return out;
}

/**
 * Upkeep: one gold per level, except loyal units (the `loyal` trait marker) which
 * cost nothing, and level 0 units which also cost nothing. Villages support one
 * level each (`village_support`, `src/game_config.cpp`).
 */
export function upkeepFor(state: GameState, data: WesnothData, side: number): number {
  let levels = 0;
  for (const unit of state.units) {
    if (unit.side !== side) continue;
    if (hasTraitMarker(data, unit, 'loyal')) continue;
    levels += unit.level;
  }
  const villages = state.villageOwner.filter((owner) => owner === side).length;
  const villageSupport = state.sideRules?.[side]?.villageSupport ?? VILLAGE_SUPPORT;
  return Math.max(0, levels - villages * villageSupport);
}

export function incomeFor(state: GameState, data: WesnothData, side: number): number {
  const villages = state.villageOwner.filter((owner) => owner === side).length;
  return BASE_INCOME + villages * VILLAGE_INCOME - upkeepFor(state, data, side);
}

/**
 * End-of-turn statuses for one side: poison ticks, and slow wears off. Wesnoth
 * applies poison at the start of the poisoned side's turn; this port applies it
 * when that side's turn ends, which is the same once per round.
 */
export function endTurnStatuses(state: GameState, side: number): void {
  const amount = POISON_AMOUNT;
  for (const unit of state.units) {
    if (unit.side !== side || unit.hitpoints <= 0) continue;
    poisonTick(unit, amount);
  }
  clearTurnStatuses(state.units.filter((unit) => unit.side === side));
}

export function endTurn(state: GameState, data: WesnothData): void {
  const current = state.turn;
  const next = state.sides[(state.sides.indexOf(current) + 1) % state.sides.length];
  state.turn = next;
  state.scheduleIndex = (state.scheduleIndex + 1) % Math.max(1, activeSchedule(data, state).length);
  if (next === state.sides[0]) state.round++;

  for (const unit of state.units) {
    if (unit.side !== next) continue;
    unit.movement = unit.maxMovement;
    unit.resting = true;
    healUnit(state, data, unit);
  }
}

function healUnit(state: GameState, data: WesnothData, unit: Unit): void {
  if (unit.side !== state.turn) return;
  healUnitDirect(state, data, unit);
}

/** Rest + village healing for one unit, without the "whose turn" guard. */
function healUnitDirect(state: GameState, data: WesnothData, unit: Unit): number {
  let healing = 0;
  if (unit.resting) healing += REST_HEAL;
  const terrain = resolveTerrain(data, movetypeFor(data, unit), terrainCodeAt(state, unit.x, unit.y));
  if (terrain.isVillage && ownsVillage(state, unit.side, unit.x, unit.y)) {
    healing += terrain.heals;
  }
  const before = unit.hitpoints;
  unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints + healing);
  return unit.hitpoints - before;
}

/**
 * Real rest + village healing for every unit of a side. `endTurn` calls its
 * guarded form; this one is exposed so a scenario's `command:rest_heal` engine
 * hook can let MWL content decide when a side recuperates. Returns hitpoints
 * actually restored.
 */
export function restHealSide(state: GameState, data: WesnothData, side: number): number {
  let healed = 0;
  for (const unit of state.units) {
    if (unit.side !== side) continue;
    unit.resting = true;
    healed += healUnitDirect(state, data, unit);
  }
  return healed;
}

export function currentLawfulBonus(data: WesnothData, state: GameState): number {
  const schedule = activeSchedule(data, state);
  return schedule[state.scheduleIndex % Math.max(1, schedule.length)]?.lawfulBonus ?? 0;
}

export function attackContext(data: WesnothData, state: GameState): AttackContext {
  return { data, lawfulBonus: currentLawfulBonus(data, state) };
}

export interface AttackOutcome {
  exchange: CombatExchange;
  xpAwarded: { attacker: number; defender: number };
  /** survivors that levelled during the exchange, in the order they advanced */
  advancements: { unitId: number; fromType: string; toType: string }[];
  /** the unit a plague attack raised on the victim's hex, if any */
  plagueSpawn: Unit | null;
}

export function attackWithRules(state: GameState, data: WesnothData, attacker: Unit, defender: Unit, attackName: string, rng: Rng = Math.random): AttackOutcome {
  if (areAllied(state, attacker.side, defender.side)) throw new Error('allied units cannot attack each other');
  const attack = attacker.attacks.find((candidate) => candidate.name === attackName);
  if (!attack) throw new Error(`unknown attack "${attackName}"`);
  // A hidden unit cannot be targeted at all: the attacker cannot see it
  // (`abilities.cfg`: hidden units "remain undetected by [their] enemies").
  // Adjacent enemies always see through hiding, so melee against a neighbour
  // is unaffected; only ranged strikes at a hidden hex are refused.
  if (isHidden(state, data, defender, attacker.side, lawfulBonusAt(data, state, defender.x, defender.y))) {
    throw new Error(`target hidden by ${hidesIdOf(data, defender) ?? 'terrain'}`);
  }
  const defenderTerrain = resolveTerrain(data, movetypeFor(data, defender), terrainCodeAt(state, defender.x, defender.y));
  const attackerTerrain = resolveTerrain(data, movetypeFor(data, attacker), terrainCodeAt(state, attacker.x, attacker.y));
  const illuminatedAttacker = illuminatedNear(state, data, attacker);
  const illuminatedDefender = illuminatedNear(state, data, defender);
  const flanked = isFlanked(state, attacker, defender);
  const exchange = resolveAttack(
    attackContext(data, state),
    {
      attacker,
      defender,
      attack,
      terrain: defenderTerrain,
      attackerTerrain,
      rng,
      attackerLawfulBonus: illuminatedAttacker ? 25 : lawfulBonusAt(data, state, attacker.x, attacker.y),
      defenderLawfulBonus: lawfulBonusAt(data, state, defender.x, defender.y),
      attackerBonus: leadershipBonus(state, data, attacker),
      defenderBonus: leadershipBonus(state, data, defender),
      defenderFlanked: flanked,
      // Diversion rides the same geometry as backstab: an enemy of the target
      // on the far side lets the diverting attacker cut the retaliation by 20.
      defenderDiverted: hasAbility(data, attacker, 'diversion') && flanked,
      suppressedForAttacker: disablesOf(data, defender, retaliationAttack(defender, attack.range) ?? attack),
      suppressedForDefender: disablesOf(data, attacker, attack),
      attackerImmune: immunities(data, attacker),
      defenderImmune: immunities(data, defender),
    },
  );
  void illuminatedDefender;

  const victimX = defender.x;
  const victimY = defender.y;
  const victimTerrain = defenderTerrain;

  // Plague (`WEAPON_SPECIAL_PLAGUE*`): a victim killed by a plague attack is
  // replaced by the plague type on the killer's side. Undead and units in
  // villages are immune, and the spawn needs a known type and its hex.
  const plagueType = exchange.defenderKilled ? plagueTypeOf(data, attack) : null;
  let plagueSpawned: Unit | null = null;
  if (plagueType && data.unitTypes[plagueType] && !immunities(data, defender).includes('plague') && !victimTerrain.isVillage) {
    const spawned = makeUnit(data, plagueType, attacker.side, victimX, victimY, rng);
    // The engine raises the plague unit with no attacks and no movement left
    // (`src/actions/attack.cpp:1200-1204`): it is created during the killer's
    // turn, so it must not act in it.
    spawned.movement = 0;
    state.units.push(spawned);
    plagueSpawned = spawned;
  }
  // Feeding (`data/lua/feeding.lua`): the killer gains 1 maximum hitpoint
  // (and the point itself) unless the victim is immune to plague.
  if (exchange.defenderKilled && attacker.hitpoints > 0 && hasAbility(data, attacker, 'feeding') && !immunities(data, defender).includes('plague')) {
    attacker.maxHitpoints += 1;
    attacker.hitpoints = Math.min(attacker.maxHitpoints, attacker.hitpoints + 1);
  }

  // Combat XP: 1 for each survivor, 8 per level of a killed opponent.
  const xpAwarded = { attacker: 0, defender: 0 };
  xpAwarded.attacker += COMBAT_EXPERIENCE;
  if (exchange.defenderKilled) xpAwarded.attacker += KILL_EXPERIENCE * defender.level;
  if (!exchange.attackerKilled) xpAwarded.defender += COMBAT_EXPERIENCE;
  if (exchange.attackerKilled) xpAwarded.defender += KILL_EXPERIENCE * attacker.level;

  attacker.experience += xpAwarded.attacker;
  defender.experience += xpAwarded.defender;
  // A survivor that filled its experience bar advances on the spot. The engine
  // fires `pre_advance`/`advance`/`post_advance` around this
  // (`src/actions/advancement.cpp:284-405`), so the type change is reported back
  // to the scene, which fires the three events in order.
  const advancements: { unitId: number; fromType: string; toType: string }[] = [];
  const advance = (unit: Unit, fromType: string): void => {
    if (unit.hitpoints <= 0 || !advanceUnit(state, data, unit) || unit.typeId === fromType) return;
    advancements.push({ unitId: unit.id, fromType, toType: unit.typeId });
  };
  const attackerType = attacker.typeId;
  const defenderType = defender.typeId;
  advance(attacker, attackerType);
  advance(defender, defenderType);

  if (exchange.defenderKilled) state.units = state.units.filter((unit) => unit.id !== defender.id);
  if (exchange.attackerKilled) state.units = state.units.filter((unit) => unit.id !== attacker.id);

  updateVision(state, data);

  return { exchange, xpAwarded, advancements, plagueSpawn: plagueSpawned };
}

/** The `[hides]` ability id concealing a unit's terrain, if its terrain qualifies. */
function hidesIdOf(data: WesnothData, unit: Unit): string | null {
  for (const id of [...(data.unitTypes[unit.typeId]?.abilities ?? []), ...(unit.extraAbilities ?? [])]) {
    const definition = data.abilities[id];
    for (const effect of definition?.effects ?? []) {
      if (effect.tag === 'hides' && effect.attributes.id) return effect.attributes.id;
    }
  }
  return null;
}
