/**
 * Port-owned MWL adapter.
 *
 * The framework owns MWL: parsing, schema, validation, compilation. This
 * adapter owns the Wesnoth translation in both directions for the current
 * playable slice:
 *
 *   Wesnoth-parsed nodes (src/simulation/wml.ts)
 *     -> MWL nodes (framework schema, validated)
 *     -> MwlCompiledGame
 *     -> WesnothData / MapData / GameState
 *
 * No Wesnoth type or value lives in the framework. Only this file knows that
 * `movement_type`, `specials_list`, and the Freelands map exist.
 *
 * `toGameState` reads a unit's `type` and `side` from `MwlWorld`, which now
 * carries them; its context maps are overrides for older snapshots.
 */

import fs from 'node:fs';
import { compileNodes, parseTerrain, type MwlCompiledGame, type MwlCompiledNode, type MwlNode, type MwlWorld } from 'mwg/mwl';
import { WmlPreprocessor, parseWml, type WmlLocation, type WmlNode, type WmlPreprocessorOptions } from '../simulation/wml.ts';
import type { AttackDef, EffectDef, EffectTree, EraDef, FactionDef, MovetypeDef, RaceDef, SpecialDef, TerrainDef, TimeOfDayDef, TraitDef, UnitTypeDef, WesnothData } from '../simulation/types.ts';
import type { UnitAnimations } from '../simulation/animation.ts';
import { extractAllUnitAnimations, normalizeImagePath } from './unit-animations.ts';
import { wesnothSchema } from './wesnoth-schema.ts';
import { makeGame, type GameState } from '../simulation/game.ts';
import { makeUnit } from '../simulation/unit.ts';

export interface MapData {
  width: number;
  height: number;
  /** row-major terrain codes, keep markers stripped */
  codes: string[];
  /** side number -> keep positions */
  keeps: Record<number, { x: number; y: number }[]>;
}

export interface WesnothMwlInput {
  /** parsed `[terrain_type]` roots from terrain.cfg */
  terrain: readonly WmlNode[];
  /** children of the `[units]` root from units.cfg (movetype, trait, unit_type) */
  units: readonly WmlNode[];
  /** parsed `[time]` roots from the expanded DEFAULT_SCHEDULE */
  schedule: readonly WmlNode[];
  /** extra named schedules: id plus its parsed `[time]` roots */
  extraSchedules?: readonly { id: string; times: readonly WmlNode[] }[];
  /** parsed `[era]` roots from eras.cfg (with expanded factions) */
  eras?: readonly WmlNode[];
  /** parsed `[weapon_special]` definitions from weapon_specials.cfg */
  weaponSpecials?: readonly WmlNode[];
  /** parsed `[ability]` definitions from abilities.cfg */
  abilities?: readonly WmlNode[];
  /** trait ids every race may take (the ones units.cfg instantiates itself) */
  globalTraits?: readonly string[];
  /** the chosen map, raw `.map` text plus a display name and provenance path */
  map?: { name: string; text: string; file?: string };
}

export interface WesnothCfgInput {
  /** Existing Wesnoth data directory used to resolve `{file.cfg}` includes. */
  dataDir: string;
  terrainFile: string;
  unitsFile: string;
  /**
   * Already-parsed unit sources compiled into the same registry as
   * `unitsFile`. The mainline campaigns define their own `[unit_type]`s, and a
   * campaign scenario references them by id, so the port compiles each shipped
   * campaign's `units/` with that campaign's own macros and hands the nodes in.
   */
  extraUnits?: readonly WmlNode[];
  /** Campaign-defined `[weapon_special]`/`[ability]`/`[trait]` registrations. */
  extraWeaponSpecials?: readonly WmlNode[];
  extraAbilities?: readonly WmlNode[];
  extraTraits?: readonly WmlNode[];
  macroFiles?: readonly string[];
  scheduleText?: string;
  /** extra named schedules: id plus the macro text expanding to `[time]` nodes */
  extraSchedules?: Record<string, string>;
  /**
   * Animation macro files (`data/core/macros/animation-utils*.cfg`). Loading
   * them expands `{STANDING_ANIM_DIRECTIONAL ...}` and friends into real
   * `[standing_anim]`/`[attack_anim]` children, which `extractAllUnitAnimations`
   * then reads. Without them those calls expand to nothing, as before.
   */
  animationMacroFiles?: readonly string[];
  /** era files to compile (e.g. `data/multiplayer/eras.cfg`) */
  eraFiles?: readonly string[];
  map?: { name: string; text: string; file?: string };
  defines?: Iterable<string>;
  onFile?: WmlPreprocessorOptions['onFile'];
}

/**
 * The compiled game plus the port-only data the same pass produced: the sound
 * assets the compiled nodes reference, and the unit animations extracted from
 * the parsed unit types. `MwlCompiledGame` stays framework-owned; this
 * intersection is the port's own sidecar.
 */
export type CompiledWesnothCfg = MwlCompiledGame & {
  /** real unit animations, by unit type id */
  unitAnimations: Record<string, UnitAnimations>;
};

/** Read native Wesnoth CFG files and compile the supported subset through MWL. */
export function compileWesnothCfg(input: WesnothCfgInput): CompiledWesnothCfg {
  const options: WmlPreprocessorOptions = {
    dataDir: input.dataDir,
    defines: input.defines,
    onFile: input.onFile,
  };
  const wml = new WmlPreprocessor(options);
  wml.loadMacros([...(input.macroFiles ?? []), ...(input.animationMacroFiles ?? [])]);
  const terrain = parseWml(wml.preprocessFile(input.terrainFile), input.terrainFile);
  const units = [
    ...parseWml(wml.preprocessFile(input.unitsFile), input.unitsFile).flatMap((node) => node.tag === 'units' ? node.children : []),
    ...(input.extraUnits ?? []),
  ];
  const schedule = input.scheduleText === undefined ? [] : parseWml(wml.preprocessText(input.scheduleText), '<schedule macro>');
  const extraSchedules = Object.entries(input.extraSchedules ?? {}).map(([id, text]) => ({
    id,
    times: parseWml(wml.preprocessText(text), `<schedule ${id}>`),
  }));
  const eras = (input.eraFiles ?? []).flatMap((file) =>
    parseWml(wml.preprocessFile(file), file).flatMap((node) => (node.tag === 'era' ? [node] : [])),
  );
  const { weaponSpecials, abilities } = extractSpecialDefinitions(wml, input.macroFiles ?? []);
  const traits = extractTraitDefinitions(wml, input.macroFiles ?? []);
  // The traits `units.cfg` instantiates at its top level are the global set; races
  // add their own on top of it.
  const globalTraits = units.filter((node) => node.tag === 'trait').map((node) => node.attributes.id).filter(Boolean);
  const compiled = compileWesnothMwl({
    terrain,
    // Campaign `[trait]`s join the unit sources the same way their `[unit_type]`s do.
    units: [...units, ...traits, ...(input.extraTraits ?? [])],
    weaponSpecials: [...weaponSpecials, ...(input.extraWeaponSpecials ?? [])],
    abilities: [...abilities, ...(input.extraAbilities ?? [])],
    globalTraits,
    schedule,
    extraSchedules,
    eras,
    map: input.map,
  });
  // Animations are outside the typed gameplay slice, but their sound fields
  // still belong in the build manifest. Keep them as logical paths without
  // teaching MWG any Wesnoth animation rules.
  const sounds = new Set(compiled.assets);
  for (const root of [...terrain, ...units, ...schedule]) collectSoundAssets(root, sounds);
  return { ...compiled, assets: [...sounds].sort(), unitAnimations: extractAllUnitAnimations(units) };
}

/**
 * Read the real ability and weapon-special definitions out of the macro files.
 *
 * `data/core/macros/weapon_specials.cfg` defines `WEAPON_SPECIAL_CHARGE` as the
 * body `[damage] id=charge multiply=2 ... [/damage]`, and `abilities.cfg` defines
 * `ABILITY_LEADERSHIP` as `[leadership] id=leadership value="(25 * (...))" ...`.
 * Both are loaded as macros already, so calling each macro by name yields its
 * body; the effect's own `id` names the special, which is what unit attacks
 * reference (`specials=charge,slow`).
 */
export function extractSpecialDefinitions(
  wml: WmlPreprocessor,
  macroFiles: readonly string[],
): { weaponSpecials: WmlNode[]; abilities: WmlNode[] } {
  const weaponSpecials: WmlNode[] = [];
  const abilities: WmlNode[] = [];
  for (const file of macroFiles) {
    // A campaign file may hold both kinds (`Winds_of_Fate/utils/abilities.cfg`
    // defines `WEAPON_SPECIAL_BLAST`), and a campaign file that holds a special
    // need not be named after it (`Secrets_of_the_Ancients/utils/zombie-
    // utils.cfg` defines `WEAPON_SPECIAL_SOTA_PLAGUE`), so the macro name
    // decides first and the file name is only the fallback.
    const fallback: 'weapon_special' | 'ability' | null = /weapon_special/i.test(file) ? 'weapon_special' : /abilities/i.test(file) ? 'ability' : null;
    // Parameterized macros (`#define WEAPON_SPECIAL_PLAGUE_TYPE TYPE`) are called
    // by units with an argument; a parameterless call still yields a usable
    // definition, while one whose id needs the argument (`plague()`) is skipped.
    const names = [...fs.readFileSync(file, 'utf8').matchAll(/^#define\s+(\w+)/gm)].map((match) => match[1]);
    for (const name of names) {
      const tag = name.startsWith('WEAPON_SPECIAL') ? 'weapon_special' : name.startsWith('ABILITY') ? 'ability' : fallback;
      if (!tag) continue;
      const target = tag === 'weapon_special' ? weaponSpecials : abilities;
      const expanded = parseWml(wml.preprocessText(`{${name}}`), `<${tag} ${name}>`);
      for (const node of expanded) {
        // Units reference the registry id (`abilities_list=heals_8`), which the
        // macro writes as `unique_id`; the tag says what the rules should do.
        const id = node.attributes.unique_id ?? node.attributes.id;
        // Wesnoth ids may contain spaces (`id=greater drains` in Eastern Invasion), so the
        // only shape to reject is an empty one.
        if (!id) continue;
        target.push({
          tag,
          attributes: {
            id,
            tag: node.tag,
            ...(node.attributes.name === undefined ? {} : { name: node.attributes.name }),
          },
          children: [node],
          location: node.location,
        });
      }
    }
  }
  return { weaponSpecials, abilities };
}

/**
 * Read every `[trait]` definition from `data/core/macros/traits.cfg`.
 *
 * A trait macro's body is the `[trait]` block itself; parameterized ones are
 * skipped here because their inline uses carry the real arguments. Only the
 * globally available traits are instantiated by `units.cfg`, while the rest -
 * dextrous, loyal, healthy, undead - exist only where a race or a unit type
 * pulls them in, so they are collected from the macro file directly.
 */
export function extractTraitDefinitions(wml: WmlPreprocessor, macroFiles: readonly string[]): WmlNode[] {
  const traits: WmlNode[] = [];
  for (const file of macroFiles) {
    if (!/traits/i.test(file)) continue;
    // Parameterized traits (`#define TRAIT_FERAL_MUSTHAVE ...`) work without
    // arguments too; one that would need them yields an unusable id and is skipped.
    const names = [...fs.readFileSync(file, 'utf8').matchAll(/^#define\s+(\w+)/gm)].map((match) => match[1]);
    if (!names.length) continue;
    const expanded = parseWml(wml.preprocessText(names.map((name) => `{${name}}`).join('\n')), '<trait macros>');
    for (const node of expanded) {
      const id = node.attributes.id;
      if (node.tag === 'trait' && id && /^[A-Za-z0-9_.:+-]+$/.test(id)) traits.push(node);
    }
  }
  return traits;
}

function collectSoundAssets(node: WmlNode, assets: Set<string>): void {
  for (const [name, value] of Object.entries(node.attributes)) {
    if (name !== 'sound' && !name.endsWith('_sound')) continue;
    for (const part of splitAssetList(value)) {
      const trimmed = part.trim();
      if (!/\.(?:wav|ogg|mp3|flac)$/i.test(trimmed)) continue;
      const transform = trimmed.match(/~[A-Za-z][A-Za-z0-9_-]*(?:\(|$)/);
      assets.add((transform ? trimmed.slice(0, transform.index) : trimmed).trim());
    }
  }
  for (const child of node.children) collectSoundAssets(child, assets);
}

function splitAssetList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') parenDepth += 1;
    else if (value[index] === ')' && parenDepth > 0) parenDepth -= 1;
    else if (value[index] === '[') bracketDepth += 1;
    else if (value[index] === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (value[index] === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** Convert parsed Wesnoth nodes to MWL nodes for the playable slice. */
export function wesnothNodesToMwl(input: WesnothMwlInput): MwlNode[] {
  const nodes: MwlNode[] = [];
  for (const node of input.terrain) {
    const converted = terrainToMwl(node);
    if (converted) nodes.push(converted);
  }
  for (const node of input.units) {
    if (node.tag === 'movetype') {
      const converted = movetypeToMwl(node);
      if (converted) nodes.push(converted);
    } else if (node.tag === 'trait') {
      const converted = traitToMwl(node);
      if (converted) nodes.push(converted);
    } else if (node.tag === 'unit_type') {
      const converted = unitTypeToMwl(node);
      if (converted) nodes.push(converted);
    } else if (node.tag === 'race') {
      const converted = raceToMwl(node);
      if (converted) nodes.push(converted);
    } else if (node.tag === 'global_traits') {
      nodes.push(mwlNode('units.cfg', 'global_traits', { ...node.attributes }, [], node.location));
    }
  }
  for (const node of input.weaponSpecials ?? []) {
    const converted = specialToMwl('weapon_special', node);
    if (converted) nodes.push(converted);
  }
  for (const node of input.abilities ?? []) {
    const converted = specialToMwl('ability', node);
    if (converted) nodes.push(converted);
  }
  if (input.globalTraits?.length) nodes.push(mwlNode('units.cfg', 'global_traits', { ids: input.globalTraits.join(',') }));
  if (input.schedule.length) nodes.push(scheduleToMwl(input.schedule, 'default'));
  for (const extra of input.extraSchedules ?? []) {
    if (extra.times.length) nodes.push(scheduleToMwl(extra.times, extra.id));
  }
  for (const node of input.eras ?? []) {
    const converted = eraToMwl(node);
    if (converted) nodes.push(converted);
  }
  if (input.map) nodes.push(mapToMwl(input.map));
  return nodes;
}

/**
 * A `[weapon_special]` or `[ability]`: same shape in and out. The effect
 * children are Wesnoth's own vocabulary (`[damage]`, `[poison]`, `[leadership]`,
 * ...), which the port's schema extension declares, so they pass through
 * structurally and the rules read them.
 */
function specialToMwl(tag: 'weapon_special' | 'ability', node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attributes: Record<string, string> = { id };
  if (node.attributes.name) attributes.name = node.attributes.name;
  if (node.attributes.tag) attributes.tag = node.attributes.tag;
  // An event-only ability's macro body is the `[event]` itself; drop it at the
  // registry level as well as deeper, the schema has no place for it.
  return mwlNode('macros', tag, attributes, node.children.filter((child) => child.tag !== 'event').map(specialEffectToMwl), node.location);
}

/**
 * Keep an effect tree exactly as written, attributes and nesting included.
 * Event-driven abilities (Descent Into Darkness's `DID_SOUL_EATER1` wraps its
 * behaviour in `[event]` handlers) cannot pass through the effect schema, so the
 * handlers are dropped and the remaining effects still compile.
 */
function specialEffectToMwl(node: WmlNode): MwlNode {
  return mwlNode(
    'macros',
    node.tag,
    { ...node.attributes },
    node.children.filter((child) => child.tag !== 'event').map(specialEffectToMwl),
    node.location,
  );
}

/** Convenience: convert, validate, and compile in one call. */
export function compileWesnothMwl(input: WesnothMwlInput): MwlCompiledGame {
  return compileNodes(wesnothNodesToMwl(input), { file: 'wesnoth-core', schemas: wesnothSchema });
}

/** `.cfg` tags the typed slice conversion understands. */
export const SLICE_TAGS: readonly string[] = ['terrain_type', 'movetype', 'trait', 'unit_type'];

/**
 * Convert one parsed Wesnoth node with the typed slice rules, or `null` when the
 * tag is outside the slice. Used by the `.cfg` -> `.mwl` converter, which walks
 * a whole file; `wesnothNodesToMwl` does the same for the loaded pipeline inputs.
 */
export function wesnothNodeToMwl(node: WmlNode): MwlNode | null {
  switch (node.tag) {
    case 'terrain_type':
      return terrainToMwl(node);
    case 'movetype':
      return movetypeToMwl(node);
    case 'trait':
      return traitToMwl(node);
    case 'unit_type':
      return unitTypeToMwl(node);
    default:
      return null;
  }
}

/** Read the compiled data back into the port's existing WesnothData shape. */
export function toWesnothData(game: MwlCompiledGame): WesnothData {
  const terrains: Record<string, TerrainDef> = {};
  const terrainByCode: Record<string, string> = {};
  const movetypes: Record<string, MovetypeDef> = {};
  const traits: Record<string, TraitDef> = {};
  const races: Record<string, RaceDef> = {};
  let globalTraits: string[] = [];
  const unitTypes: Record<string, UnitTypeDef> = {};
  const weaponSpecials: Record<string, SpecialDef> = {};
  const abilities: Record<string, SpecialDef> = {};
  const schedule: TimeOfDayDef[] = [];
  const schedules: Record<string, TimeOfDayDef[]> = {};
  const eras: Record<string, EraDef> = {};

  for (const root of game.roots) {
    switch (root.tag) {
      case 'terrain_type': {
        const terrain = compiledTerrain(root);
        if (terrain) {
          terrains[terrain.id] = terrain;
          terrainByCode[terrain.code] = terrain.id;
        }
        break;
      }
      case 'movetype': {
        const movetype = compiledMovetype(root);
        if (movetype) movetypes[movetype.name] = movetype;
        break;
      }
      case 'trait': {
        const trait = compiledTrait(root);
        if (trait) traits[trait.id] = trait;
        break;
      }
      case 'race': {
        const race = compiledRace(root);
        if (race) races[race.id] = race;
        break;
      }
      case 'global_traits':
        globalTraits = splitList(root.attributes.ids);
        break;
      case 'unit_type': {
        const unitType = compiledUnitType(root);
        if (unitType) unitTypes[unitType.id] = unitType;
        break;
      }
      case 'weapon_special': {
        const special = compiledSpecial(root);
        if (special) weaponSpecials[special.id] = special;
        break;
      }
      case 'ability': {
        const special = compiledSpecial(root);
        if (special) abilities[special.id] = special;
        break;
      }
      case 'schedule': {
        const times: TimeOfDayDef[] = [];
        for (const time of root.children) if (time.tag === 'time') times.push(compiledTime(time));
        const id = root.attributes.id ?? 'default';
        schedules[id] = times;
        if (id === 'default') schedule.push(...times);
        break;
      }
      case 'era': {
        const era = compiledEra(root);
        if (era) eras[era.id] = era;
        break;
      }
    }
  }

  return { terrains, terrainByCode, movetypes, traits, races, globalTraits, unitTypes, weaponSpecials, abilities, schedule, schedules, eras };
}

/**
 * Read the compiled map node back into the port's MapData shape. Row parsing
 * is the framework's `parseTerrain` (`mwg/mwl`): same comma codes and
 * `N code` keeps, plus `\r\n` handling the port's copy lacked. Only the
 * keep table is renamed (`starts` to `keeps`), which is the one Wesnothism
 * the framework must never learn.
 */
export function toMapData(game: MwlCompiledGame): MapData {
  const node = game.roots.find((root) => root.tag === 'map');
  if (!node) throw new Error('compiled MWL has no [map] node');
  const parsed = parseTerrain(node.attributes.terrain ?? '');
  return { width: parsed.width, height: parsed.height, codes: [...parsed.codes], keeps: { ...parsed.starts } };
}

export interface GameStateContext {
  data: WesnothData;
  map: MapData;
  /** optional override for units whose world entry has no type (older saves) */
  unitTypes?: Record<string, string>;
  /** optional override for units whose world entry has no side */
  sides?: Record<string, number>;
}

/**
 * Build the port's GameState from an MWL world.
 *
 * `MwlWorld` now carries a unit's `type` and `side`, so this reads them
 * directly; the context maps are overrides for older snapshots that predate
 * those fields.
 */
export function toGameState(world: MwlWorld, context: GameStateContext): GameState {
  const keeps = new Map<number, { x: number; y: number }[]>();
  for (const [side, cells] of Object.entries(context.map.keeps)) keeps.set(Number(side), cells);
  const state = makeGame(context.map.width, context.map.height, context.map.codes, keeps);

  const sideNumbers = Object.keys(world.sides).map(Number).filter(Number.isFinite);
  if (sideNumbers.length) state.sides = sideNumbers;
  if (state.sides.includes(world.turn)) state.turn = world.turn;

  for (const [id, entry] of Object.entries(world.units)) {
    if (!entry.alive) continue;
    const typeId = context.unitTypes?.[id] ?? entry.type;
    if (!typeId) continue;
    // MWL keys a side by its id (a string), the port numbers sides; convert at the boundary.
    const worldSide = entry.side === undefined ? undefined : Number(entry.side);
    const side = context.sides?.[id] ?? (Number.isFinite(worldSide) ? worldSide : undefined) ?? state.sides[0];
    const unit = makeUnit(context.data, typeId, side, entry.x, entry.y);
    unit.hitpoints = Math.min(entry.hp, unit.maxHitpoints);
    state.units.push(unit);
  }
  return state;
}

// ---------------------------------------------------------------- conversion

const location = (file: string, source?: WmlLocation) => source ?? ({ file, line: 0, column: 0 });

function mwlNode(file: string, tag: string, attributes: Record<string, string>, children: MwlNode[] = [], source?: WmlLocation): MwlNode {
  return { tag, attributes, children, location: location(file, source) };
}

/** Set an id-typed attribute only when non-empty, so the schema's id check holds. */
function putId(attributes: Record<string, string>, name: string, value: string | undefined): void {
  if (value) attributes[name] = value;
}

function normalizedAlignment(value: string | undefined): UnitTypeDef['alignment'] {
  return value === 'lawful' || value === 'chaotic' || value === 'liminal' || value === 'neutral' ? value : 'neutral';
}

function terrainToMwl(node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  const code = node.attributes.string;
  if (!id || !code) return null;
  const attributes: Record<string, string> = { id, string: code };
  if (node.attributes.aliasof) attributes.aliasof = node.attributes.aliasof;
  if (node.attributes.mvt_alias) attributes.mvt_alias = node.attributes.mvt_alias;
  if (node.attributes.default_base) attributes.default_base = node.attributes.default_base;
  attributes.heals = String(numberAttr(node, 'heals') ?? 0);
  attributes.gives_income = node.attributes.gives_income === 'yes' ? 'true' : 'false';
  attributes.recruit_onto = node.attributes.recruit_onto === 'yes' ? 'true' : 'false';
  attributes.recruit_from = node.attributes.recruit_from === 'yes' ? 'true' : 'false';
  return mwlNode('terrain.cfg', 'terrain_type', attributes, [], node.location);
}

function movetypeToMwl(node: WmlNode): MwlNode | null {
  const name = node.attributes.name;
  if (!name) return null;
  const children: MwlNode[] = [];
  for (const child of node.children) {
    if (child.tag === 'movement_costs' || child.tag === 'defense' || child.tag === 'resistance') {
      children.push(mwlNode('units.cfg', child.tag, { ...child.attributes }, [], child.location));
    }
  }
  return mwlNode('units.cfg', 'movetype', { name }, children, node.location);
}

/**
 * Effect `apply_to` values the typed engine does not model, measured over
 * `data/core/macros/traits.cfg`: defence modifiers, hero/Loyal markers, immunity
 * statuses and the script-driven ability slots. They are kept as markers so a
 * trait is never silently dropped; the rules read the ones they implement.
 */
const TRAIT_MARKERS = ['defense', 'ellipse', 'fearless', 'healthy', 'loyal', 'new_ability', 'overlay', 'status'];

function traitToMwl(node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attributes: Record<string, string> = { id };
  if (node.attributes.availability) attributes.availability = node.attributes.availability;
  const children: MwlNode[] = [];
  for (const child of node.children) {
    if (child.tag !== 'effect') continue;
    const effect = effectToMwl(child);
    if (effect) {
      children.push(effect);
      continue;
    }
    // `apply_to=loyal` and friends: keep the shape as a marker instead of
    // dropping the trait, so upkeep, poison immunity and fearless survive.
    const applyTo = child.attributes.apply_to;
    if (!applyTo || !TRAIT_MARKERS.includes(applyTo)) continue;
    const markerAttributes: Record<string, string> = {};
    if (child.attributes.add) markerAttributes.add = child.attributes.add;
    children.push(mwlNode('units.cfg', applyTo, markerAttributes, [], child.location));
  }
  // A marker trait carries no `[effect]` at all; its behaviour lives in events
  // (Eastern Invasion's `deserter`). Keep it so units that take it resolve.
  return mwlNode('units.cfg', 'trait', attributes, children, node.location);
}

/**
 * A `[race]` block: how many traits its units take, whether the global traits
 * apply, and the extra traits the block pulls in with macros (`{TRAIT_DEXTROUS}`
 * expands to a `[trait]` child inside the race).
 */
function raceToMwl(node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attributes: Record<string, string> = { id };
  if (node.attributes.num_traits) attributes.num_traits = node.attributes.num_traits;
  if (node.attributes.ignore_global_traits === 'yes') attributes.ignore_global_traits = 'yes';
  const traits = node.children.filter((child) => child.tag === 'trait').map((child) => child.attributes.id).filter(Boolean);
  if (traits.length) attributes.race_traits = traits.join(',');
  return mwlNode('units.cfg', 'race', attributes, [], node.location);
}

function effectToMwl(node: WmlNode): MwlNode | null {
  const applyTo = node.attributes.apply_to;
  if (!applyTo || !['attack', 'hitpoints', 'movement', 'max_experience'].includes(applyTo)) return null;
  const attributes: Record<string, string> = { apply_to: applyTo };
  if (node.attributes.range) attributes.range = node.attributes.range;
  for (const name of ['increase', 'increase_total', 'increase_damage']) {
    if (node.attributes[name] !== undefined && node.attributes[name] !== '') attributes[name] = node.attributes[name];
  }
  return mwlNode('units.cfg', 'effect', attributes, [], node.location);
}

function unitTypeToMwl(node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attacks: MwlNode[] = [];
  for (const child of node.children) {
    if (child.tag !== 'attack') continue;
    const name = child.attributes.name;
    if (!name) continue;
    const attributes: Record<string, string> = {
      name,
      description: child.attributes.description ?? '',
      type: child.attributes.type ?? '',
      range: child.attributes.range ?? '',
      damage: String(numberAttr(child, 'damage') ?? 0),
      number: String(numberAttr(child, 'number') ?? 0),
      icon: child.attributes.icon ?? '',
      specials: [
        ...attackSpecials(child),
        ...(child.attributes.defense_weight !== undefined ? [`__wesnoth_defense_weight:${child.attributes.defense_weight}`] : []),
      ].join(','),
    };
    if (child.attributes.accuracy !== undefined) attributes.accuracy = child.attributes.accuracy;
    if (child.attributes.parry !== undefined) attributes.parry = child.attributes.parry;
    if (child.attributes.sound) attributes.sound = child.attributes.sound;
    attacks.push(mwlNode('units.cfg', 'attack', attributes, [], child.location));
  }
  const attributes: Record<string, string> = {
    id,
    name: node.attributes.name ?? '',
    // Preserve the complete path. The renderer resolves its base asset and
    // applies the supported Wesnoth modifiers at draw time.
    image: normalizeImagePath(node.attributes.image ?? ''),
    hitpoints: String(numberAttr(node, 'hitpoints') ?? 1),
    movement: String(numberAttr(node, 'movement') ?? 0),
    experience: String(numberAttr(node, 'experience') ?? 0),
    level: String(numberAttr(node, 'level') ?? 0),
    alignment: normalizedAlignment(node.attributes.alignment),
    // `advances_to=null` is Wesnoth's way of saying "no advancement".
    advances_to: (node.attributes.advances_to ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '' && entry !== 'null')
      .join(','),
    cost: String(numberAttr(node, 'cost') ?? 0),
  };
  for (const name of ['image_icon', 'profile']) if (node.attributes[name]) attributes[name] = normalizeImagePath(node.attributes[name]);
  if (node.attributes.abilities_list) attributes.abilities = node.attributes.abilities_list;
  if (node.attributes.race) attributes.race = node.attributes.race;
  if (node.attributes.num_traits) attributes.num_traits = node.attributes.num_traits;
  if (node.attributes.ignore_race_traits === 'yes') attributes.ignore_race_traits = 'yes';
  for (const name of ['die_sound', 'hit_sound']) if (node.attributes[name]) attributes[name] = node.attributes[name];
  const ownTraits = node.children.filter((child) => child.tag === 'trait').map((child) => child.attributes.id).filter(Boolean);
  if (ownTraits.length) attributes.traits = ownTraits.join(',');
  // A few core unit types have no movement type; an empty value is not a valid
  // id, so the attribute is omitted and the reader defaults it back to ''.
  putId(attributes, 'movement_type', node.attributes.movement_type);
  const tables: MwlNode[] = [];
  for (const tag of ['movement_costs', 'defense', 'resistance']) {
    const table = node.children.find((child) => child.tag === tag);
    if (table) tables.push(mwlNode('units.cfg', tag, { ...table.attributes }, [], table.location));
  }
  return mwlNode('units.cfg', 'unit_type', attributes, [...attacks, ...tables], node.location);
}

function attackSpecials(attack: WmlNode): string[] {
  const specials = new Set<string>();
  const list = attack.attributes.specials_list;
  if (list) for (const id of list.split(',')) if (id.trim()) specials.add(id.trim());
  for (const child of attack.children) {
    if (child.tag !== 'specials') continue;
    for (const special of child.children) {
      const id = special.attributes.id;
      if (id) specials.add(id);
    }
  }
  return [...specials];
}

function scheduleToMwl(times: readonly WmlNode[], id: string): MwlNode {
  const children = times
    .filter((time) => time.tag === 'time')
    .map((time) =>
      mwlNode('schedules.cfg', 'time', {
        id: time.attributes.id ?? '',
        name: time.attributes.name ?? '',
        lawful_bonus: String(numberAttr(time, 'lawful_bonus') ?? 0),
      }, [], time.location),
    );
  return mwlNode('schedules.cfg', 'schedule', { id }, children, times[0]?.location);
}

/**
 * An `[era]` with its factions. Only `[multiplayer_side]` declarations
 * compile through: `[event]`/`[lua]` children are scenario behavior owned by
 * P3 (events) and P8 (lobby/AI), and the framework schema stays free of them.
 */
function eraToMwl(node: WmlNode): MwlNode | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attributes: Record<string, string> = { id };
  if (node.attributes.name) attributes.name = node.attributes.name;
  const children: MwlNode[] = [];
  for (const child of node.children) {
    if (child.tag !== 'multiplayer_side' || !child.attributes.id) continue;
    const side: Record<string, string> = { id: child.attributes.id };
    for (const name of ['name', 'image', 'leader', 'random_leader', 'recruit']) {
      if (child.attributes[name]) side[name] = child.attributes[name];
    }
    children.push(mwlNode('eras.cfg', 'multiplayer_side', side, [], child.location));
  }
  if (!children.length) return null;
  return mwlNode('eras.cfg', 'era', attributes, children, node.location);
}

function mapToMwl(map: { name: string; text: string; file?: string }): MwlNode {
  const attributes: Record<string, string> = { name: map.name, terrain: map.text };
  if (map.file) attributes.file = map.file;
  return mwlNode(map.file ?? 'map', 'map', attributes);
}

function numberAttr(node: WmlNode, name: string): number | undefined {
  const raw = node.attributes[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------- read-back

function compiledTerrain(node: MwlCompiledNode): TerrainDef | null {
  const id = node.attributes.id;
  const code = node.attributes.string;
  if (!id || !code) return null;
  return {
    id,
    code,
    aliasof: splitList(node.attributes.aliasof),
    mvtAlias: node.attributes.mvt_alias ? splitList(node.attributes.mvt_alias) : undefined,
    defaultBase: node.attributes.default_base || undefined,
    heals: Number(node.attributes.heals ?? 0),
    givesIncome: node.attributes.gives_income === 'true',
    recruitOnto: node.attributes.recruit_onto === 'true',
    recruitFrom: node.attributes.recruit_from === 'true',
  };
}

function compiledMovetype(node: MwlCompiledNode): MovetypeDef | null {
  const name = node.attributes.name;
  if (!name) return null;
  const movementCosts: Record<string, number> = {};
  const defense: Record<string, number> = {};
  const resistance: Record<string, number> = {};
  for (const child of node.children) {
    if (child.tag === 'movement_costs') for (const [key, value] of Object.entries(child.attributes)) movementCosts[key] = Number(value);
    if (child.tag === 'defense') for (const [key, value] of Object.entries(child.attributes)) defense[key] = Number(value);
    if (child.tag === 'resistance') for (const [key, value] of Object.entries(child.attributes)) resistance[key] = Number(value);
  }
  return { name, movementCosts, defense, resistance };
}

/** Read a compiled `[weapon_special]`/`[ability]` back into a definition. */
function compiledSpecial(node: MwlCompiledNode): SpecialDef | null {
  const id = node.attributes.id;
  if (!id) return null;
  return {
    id,
    tag: node.attributes.tag ?? node.children[0]?.tag ?? '',
    name: node.attributes.name ?? id,
    effects: node.children.map(compiledEffectTree),
  };
}

/** `[movement_costs]`/`[defense]`/`[resistance]` inside a unit type. */
function readTables(node: MwlCompiledNode): Pick<UnitTypeDef, 'movementCosts' | 'defense' | 'resistance'> {
  const tables: {
    movementCosts?: Record<string, string>;
    defense?: Record<string, string>;
    resistance?: Record<string, string>;
  } = {};
  for (const child of node.children) {
    if (child.tag === 'movement_costs') tables.movementCosts = { ...child.attributes };
    else if (child.tag === 'defense') tables.defense = { ...child.attributes };
    else if (child.tag === 'resistance') tables.resistance = { ...child.attributes };
  }
  return tables;
}

/** Keep an effect tree as data: tag, attributes, and nested filters. */
function compiledEffectTree(node: MwlCompiledNode): EffectTree {
  return { tag: node.tag, attributes: { ...node.attributes }, children: node.children.map(compiledEffectTree) };
}

function compiledTrait(node: MwlCompiledNode): TraitDef | null {
  const id = node.attributes.id;
  if (!id) return null;
  const effects: EffectDef[] = [];
  const markers: string[] = [];
  for (const child of node.children) {
    if (child.tag === 'effect') {
      const effect = compiledEffect(child);
      if (effect) effects.push(effect);
      continue;
    }
    // `loyal`, `fearless`, `healthy`, `status` (with its `add=`) and `overlay`.
    markers.push(child.attributes.add ? `${child.tag}:${child.attributes.add}` : child.tag);
  }
  // A marker trait may legitimately have no effects or markers of its own.
  return {
    id,
    ...(node.attributes.availability ? { availability: node.attributes.availability } : {}),
    ...(markers.length ? { markers } : {}),
    effects,
  };
}

/** Read a compiled `[race]` block. */
function compiledRace(node: MwlCompiledNode): RaceDef | null {
  const id = node.attributes.id;
  if (!id) return null;
  return {
    id,
    numTraits: Number(node.attributes.num_traits ?? 2),
    ignoreGlobalTraits: node.attributes.ignore_global_traits === 'yes',
    traits: splitList(node.attributes.race_traits),
  };
}

function compiledEffect(node: MwlCompiledNode): EffectDef | null {
  const applyTo = node.attributes.apply_to as EffectDef['applyTo'];
  if (!applyTo || !['attack', 'hitpoints', 'movement', 'max_experience'].includes(applyTo)) return null;
  const effect: EffectDef = { applyTo };
  if (node.attributes.range) effect.range = node.attributes.range;
  const increase = parseValue(node.attributes.increase);
  const increaseTotal = parseValue(node.attributes.increase_total);
  const increaseDamage = parseValue(node.attributes.increase_damage);
  if (increase !== undefined) effect.increase = increase;
  if (increaseTotal !== undefined) effect.increaseTotal = increaseTotal;
  if (increaseDamage !== undefined) effect.increaseDamage = increaseDamage;
  return effect;
}

function compiledUnitType(node: MwlCompiledNode): UnitTypeDef | null {
  const id = node.attributes.id;
  if (!id) return null;
  const attacks: AttackDef[] = [];
  for (const child of node.children) {
    if (child.tag !== 'attack') continue;
    const name = child.attributes.name;
    if (!name) continue;
    const specials = splitList(child.attributes.specials);
    const weightMarker = specials.find((special) => special.startsWith('__wesnoth_defense_weight:'));
    const defenseWeight = weightMarker ? Number(weightMarker.slice('__wesnoth_defense_weight:'.length)) : undefined;
    attacks.push({
      name,
      description: child.attributes.description ?? '',
      type: child.attributes.type ?? '',
      range: child.attributes.range ?? '',
      damage: Number(child.attributes.damage ?? 0),
      number: Number(child.attributes.number ?? 0),
      icon: child.attributes.icon ?? '',
      ...(Number.isFinite(Number(child.attributes.accuracy)) ? { accuracy: Number(child.attributes.accuracy) } : {}),
      ...(Number.isFinite(Number(child.attributes.parry)) ? { parry: Number(child.attributes.parry) } : {}),
      ...(Number.isFinite(defenseWeight) ? { defenseWeight } : {}),
      ...(child.attributes.sound ? { sound: child.attributes.sound } : {}),
      specials: specials.filter((special) => !special.startsWith('__wesnoth_defense_weight:')),
    });
  }
  const alignment = node.attributes.alignment as UnitTypeDef['alignment'];
  return {
    id,
    name: node.attributes.name ?? '',
    image: node.attributes.image ?? '',
    hitpoints: Number(node.attributes.hitpoints ?? 1),
    movementType: node.attributes.movement_type ?? '',
    movement: Number(node.attributes.movement ?? 0),
    experience: Number(node.attributes.experience ?? 0),
    level: Number(node.attributes.level ?? 0),
    alignment: ['lawful', 'neutral', 'chaotic', 'liminal'].includes(alignment) ? alignment : 'neutral',
    advancesTo: splitList(node.attributes.advances_to),
    cost: Number(node.attributes.cost ?? 0),
    abilities: splitList(node.attributes.abilities),
    race: node.attributes.race ?? '',
    ...(node.attributes.num_traits ? { numTraits: Number(node.attributes.num_traits) } : {}),
    ignoreRaceTraits: node.attributes.ignore_race_traits === 'yes',
    ownTraits: splitList(node.attributes.traits),
    ...readTables(node),
    ...(node.attributes.profile ? { profile: node.attributes.profile } : {}),
    ...(node.attributes.die_sound ? { dieSound: node.attributes.die_sound } : {}),
    ...(node.attributes.hit_sound ? { hitSound: node.attributes.hit_sound } : {}),
    attacks,
  };
}

function compiledTime(node: MwlCompiledNode): TimeOfDayDef {
  return {
    id: node.attributes.id ?? '',
    lawfulBonus: Number(node.attributes.lawful_bonus ?? 0),
    name: node.attributes.name ?? '',
  };
}

function compiledEra(node: MwlCompiledNode): EraDef | null {
  const id = node.attributes.id;
  if (!id) return null;
  const factions: FactionDef[] = [];
  for (const child of node.children) {
    if (child.tag !== 'multiplayer_side' || !child.attributes.id) continue;
    factions.push({
      id: child.attributes.id,
      name: child.attributes.name ?? child.attributes.id,
      leaders: splitList(child.attributes.leader),
      recruit: splitList(child.attributes.recruit),
    });
  }
  if (!factions.length) return null;
  return { id, name: node.attributes.name ?? id, factions };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseValue(raw: string | undefined): number | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const trimmed = raw.trim();
  if (trimmed.endsWith('%')) return trimmed;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
