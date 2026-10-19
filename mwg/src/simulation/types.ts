/**
 * Compiled Wesnoth data shapes. The data pipeline (tools/compile-wesnoth-data.ts)
 * parses real core .cfg files into `src/generated/game-data.ts`, which exports a
 * `WesnothData` object of exactly these shapes. Nothing in this file depends on
 * Pixi or on node; the same types describe both the compiled bundle and tests.
 */

export interface TerrainDef {
  /** e.g. `grassland`, `elven_village` */
  id: string;
  /** map code, e.g. `Gg` or `^Ve` for overlays */
  code: string;
  /** alias chain, e.g. `["Gt"]`; `_bas` is resolved against the base terrain */
  aliasof: string[];
  /** movement alias override chain, when present */
  mvtAlias?: string[];
  /** default base for overlay terrain, e.g. `Gg` for `^Ve` */
  defaultBase?: string;
  /** healing on this terrain per turn (villages: 8) */
  heals: number;
  /** whether this terrain produces income (village) */
  givesIncome: boolean;
  /** `recruit_onto=yes`: a unit may be recruited onto this terrain (a castle). */
  recruitOnto?: boolean;
  /** `recruit_from=yes`: a leader must stand here to recruit (a keep). */
  recruitFrom?: boolean;
}

export interface MovetypeDef {
  name: string;
  movementCosts: Record<string, number>;
  /** defense % per terrain id, e.g. `{"flat": 60}` */
  defense: Record<string, number>;
  /** resistance % per damage type, e.g. `{"arcane": 90}` */
  resistance: Record<string, number>;
}

export type EffectApplyTo = 'attack' | 'hitpoints' | 'movement' | 'max_experience';

export interface EffectDef {
  applyTo: EffectApplyTo;
  range?: string;
  /** flat integers or percent strings like `-5%` */
  increase?: number | string;
  increaseTotal?: number | string;
  increaseDamage?: number | string;
}

export interface TraitDef {
  id: string;
  /** forced traits carry `availability=musthave` and are always applied */
  availability?: string;
  /**
   * Effect shapes the typed engine does not model yet: `loyal`, `fearless`,
   * `healthy`, `status:unpoisonable`. Recorded instead of dropped.
   */
  markers?: string[];
  effects: EffectDef[];
}

export interface AttackDef {
  name: string;
  description: string;
  type: string;
  range: string;
  damage: number;
  number: number;
  icon: string;
  /** Static weapon accuracy/parry modifiers used before chance-to-hit effects. */
  accuracy?: number;
  parry?: number;
  /** Wesnoth's defense-selection weight; <= 0 makes an attack ineligible as retaliation. */
  defenseWeight?: number;
  /** ids of weapon specials, e.g. `magical`, `marksman`, `firststrike` */
  specials: string[];
  /** the sound the game plays when this weapon strikes (`[attack] sound=`), as a file list */
  sound?: string;
}

export interface UnitTypeDef {
  id: string;
  name: string;
  /** the sound the engine plays when this unit dies (`[unit_type] die_sound=`) */
  dieSound?: string;
  /** the sound the engine plays when this unit is struck (`[unit_type] hit_sound=`) */
  hitSound?: string;
  image: string;
  hitpoints: number;
  movementType: string;
  movement: number;
  experience: number;
  level: number;
  alignment: 'lawful' | 'neutral' | 'chaotic' | 'liminal';
  advancesTo: string[];
  cost: number;
  /** ability registry ids from `abilities_list=`, e.g. `heals_8`, `leadership` */
  abilities: string[];
  /** `race=`; the race supplies the default trait count and its extra traits */
  race: string;
  /** `num_traits=` on the unit type, overriding the race's */
  numTraits?: number;
  /** `ignore_race_traits=yes`: do not inherit the race's traits */
  ignoreRaceTraits: boolean;
  /** trait ids declared inside the unit type itself */
  ownTraits: string[];
  /**
   * `[movement_costs]`/`[defense]`/`[resistance]` inside a unit type override
   * the movement type; keys are terrain categories or damage types.
   */
  movementCosts?: Record<string, string>;
  defense?: Record<string, string>;
  resistance?: Record<string, string>;
  /** portrait image, relative to the images directory (`profile=` in Wesnoth) */
  profile?: string;
  attacks: AttackDef[];
}

export interface TimeOfDayDef {
  id: string;
  /** % damage bonus for lawful units, e.g. 25 for day, -25 for night */
  lawfulBonus: number;
  /** display name, e.g. `Morning` */
  name: string;
}

/**
 * One named schedule from `data/core/macros/schedules.cfg` (default, summer,
 * winter, indoors, underground, deep_underground). The pipeline keeps the
 * default list in `WesnothData.schedule` for compatibility and every named
 * list in `WesnothData.schedules`.
 */
export interface ScheduleMap {
  [scheduleId: string]: TimeOfDayDef[];
}

/**
 * A `[time_area]`: a set of hexes with its own time list
 * (`src/tod_manager.cpp:391 add_time_area`). `xs`/`ys` keep the raw WML range
 * lists (1-based, e.g. `"1-5,8"`); `timeAreaCovers` in `game.ts` matches them.
 */
export interface TimeAreaDef {
  id: string;
  xs: string;
  ys: string;
  times: TimeOfDayDef[];
}

/** One `[multiplayer_side]` inside an `[era]`, e.g. Loyalists. */
export interface FactionDef {
  id: string;
  name: string;
  /** leader type ids (`leader=`), e.g. Lieutenant,Swordsman,... */
  leaders: string[];
  /** recruit type ids (`recruit=`), e.g. Spearman,Bowman,... */
  recruit: string[];
}

/** One `[era]` from `data/multiplayer/eras.cfg`, e.g. era_default. */
export interface EraDef {
  id: string;
  name: string;
  factions: FactionDef[];
}

/**
 * One effect inside an `[object]` (items, AMLA rewards, scenario gifts).
 * Trait effects only model `attack/hitpoints/movement/max_experience` with a
 * plain increase; objects additionally heal and clear statuses
 * (`data/core/macros/amla.cfg`).
 */
export interface ObjectEffect {
  applyTo: string;
  range?: string;
  increase?: number | string;
  increaseTotal?: number | string;
  increaseDamage?: number | string;
  /** `heal_full=yes`: restore to full after applying increases */
  healFull?: boolean;
  /** `remove=poisoned` / `remove=slowed` under `apply_to=status` */
  remove?: string;
  /** `[effect] apply_to=movement_costs` table, keyed by terrain id. */
  movementCosts?: Record<string, number>;
  /** Whether this effect replaces the existing per-unit table. */
  replace?: boolean;
}

/** An `[object]` modification: effects plus abilities it grants. */
export interface ObjectDef {
  id: string;
  effects: ObjectEffect[];
  /** ability registry ids the bearer gains while holding this */
  abilities: string[];
}

/** The reversible deltas recorded when an object is applied to a unit. */
export interface AppliedObject {
  object: ObjectDef;
  hitpointsDelta: number;
  movementDelta: number;
  maxExperienceDelta: number;
  attackDeltas: { index: number; delta: number }[];
  grantedAbilities: string[];
  /** Previous movement-cost overrides, so removing the object is reversible. */
  previousMovementCosts?: Record<string, number>;
}

/** A map-placed `[item]` with the `[object]` a unit picks up from it. */
export interface ItemInstance {
  x: number;
  y: number;
  /** WML item name used by `[store_items] item_name=`. */
  name?: string;
  image: string;
  object: ObjectDef;
  taken: boolean;
}

/**
 * One effect of an ability or weapon special, kept as the WML tree wrote it:
 * a tag (`damage`, `chance_to_hit`, `resistance`, `poison`, ...) with its
 * attributes and nested filters. The rules read these; the C++ equivalent is the
 * `unit_ability_t`/`active_ability` pair in `src/units/abilities.hpp`.
 */
export interface EffectTree {
  readonly tag: string;
  readonly attributes: Record<string, string>;
  readonly children: readonly EffectTree[];
}

/**
 * A `[weapon_special]` (from `data/core/macros/weapon_specials.cfg`) or an
 * `[ability]` (from `abilities.cfg`), by its real id: `charge`, `slow`,
 * `steadfast`, `leadership`, ...
 */
export interface SpecialDef {
  /** registry key a unit references: `heals_8`, `charge`, `cures` */
  readonly id: string;
  /** the effect tag the rules dispatch on: `heals`, `damage`, `slow` */
  readonly tag: string;
  readonly name: string;
  readonly effects: readonly EffectTree[];
}

/**
 * A race block from `data/core/units.cfg`: how many traits its units get, which
 * extra traits its members may take (`{TRAIT_DEXTROUS}` inside the block), and
 * whether the global traits apply at all.
 */
export interface RaceDef {
  id: string;
  numTraits: number;
  ignoreGlobalTraits: boolean;
  /** trait ids this race adds to the global set */
  traits: string[];
}

export interface WesnothData {
  /** terrain id -> def */
  terrains: Record<string, TerrainDef>;
  /** exact map code -> terrain id (including overlays like `Gg^Ve`) */
  terrainByCode: Record<string, string>;
  movetypes: Record<string, MovetypeDef>;
  traits: Record<string, TraitDef>;
  races: Record<string, RaceDef>;
  /**
   * The traits every race may take: the ones `units.cfg` instantiates at the top
   * level (strong, quick, intelligent, resilient). A race adds its own on top.
   */
  globalTraits: string[];
  unitTypes: Record<string, UnitTypeDef>;
  /** weapon special id -> definition (`data/core/macros/weapon_specials.cfg`) */
  weaponSpecials: Record<string, SpecialDef>;
  /** ability id -> definition (`data/core/macros/abilities.cfg`) */
  abilities: Record<string, SpecialDef>;
  /** the default schedule's times (kept for compatibility) */
  schedule: TimeOfDayDef[];
  /** every named schedule by id (`schedules.cfg`); absent in older snapshots */
  schedules?: Record<string, TimeOfDayDef[]>;
  /** every era by id (`data/multiplayer/eras.cfg`); absent in older snapshots */
  eras?: Record<string, EraDef>;
  /**
   * The UI and status sound ids from `data/game_config.cfg`'s `[sounds]` block
   * (`turn_bell`, `game_has_begun`, and a `status` group with `slowed`,
   * `poisoned`, `petrified`). The engine's `game_config::sounds` table, kept as
   * data so the audio path plays the game's own files.
   */
  sounds?: Record<string, string>;
  /** the status sounds, which `game_config.cfg` nests one level deeper */
  statusSounds?: Record<string, string>;
}
