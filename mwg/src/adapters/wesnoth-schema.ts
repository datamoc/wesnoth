/**
 * Wesnoth's ability and weapon-special vocabulary, as an MWL schema extension.
 *
 * The framework owns MWL and knows nothing about `[damage]`, `[poison]` or
 * `[leadership]`; those tag names are Wesnoth's, so they live here, in the port,
 * and are passed to `compileNodes` as extra schemas.
 *
 * Every effect tag accepts any attribute and any child: the real macros carry
 * scalars (`multiply`, `value`, `apply_to`, `active_on`), formulas, and filter
 * children (`[filter_base_value]`, `[filter_opponent]`, `[filter_adjacent]`).
 * The port's rules read the ones they implement and record the rest, so a
 * definition is never silently dropped.
 */

import { schema01, type MwlTagSchema } from 'mwg/mwl';

/** A tag that only carries data: any attribute, any child. */
const open: MwlTagSchema = { openAttributes: 'string', openChildren: true, children: [] };

/** Effect tags the real macros actually use, from both macro files. */
/** Effect tags the real macros use, measured over both macro files. */
export const EFFECT_TAGS: readonly string[] = [
  // weapon specials (data/core/macros/weapon_specials.cfg)
  "berserk",
  "chance_to_hit",
  "damage",
  "damage_type",
  "disable",
  "drains",
  "firststrike",
  "petrifies",
  "plague",
  "poison",
  "slow",
  "stun",
  "swarm",
  // abilities (data/core/macros/abilities.cfg)
  "dummy",
  "heals",
  "hides",
  "illuminates",
  "leadership",
  "regenerate",
  "resistance",
  "skirmisher",
  "teleport",
  "tunnel",
  // unit and campaign declarations use these too
  "ambush",
  "arcane",
  "attacks",
  "concealment",
  "cures",
  "diversion",
  "extra_heal",
  "feeding",
  "guard",
  "heal_on_hit",
  "honed",
  "marksman",
  "magical",
  "nightstalk",
  "parry",
  "self_heal",
  "steadfast",
  "submerge",
  "swamp_lurk",
  "unpoison",
  "unwieldy",
  "accuracy",
];

/** Filter and helper tags that appear inside an effect. */
const HELPER_TAGS: readonly string[] = [
  "filter",
  "filter_self",
  "filter_opponent",
  "filter_attacker",
  "filter_defender",
  "filter_adjacent",
  "filter_base_value",
  "filter_weapon",
  "filter_location",
  "filter_attack",
  "filter_second",
  "affect_adjacent",
  "affect_self",
  "source",
  "target",
  "then",
  "else",
  "wml_exception",
];

export const wesnothSchema: Readonly<Record<string, MwlTagSchema>> = {
  ...schema01,
  // The real castle/keep flags (`gamemap::is_castle`/`is_keep` read these,
  // not the map-code prefix), so `Co`/`Ce`/`Ke` and their variants classify
  // like `Ch`/`Kh`. The framework schema predates them, so they are added here.
  terrain_type: {
    ...(schema01.terrain_type ?? {}),
    attributes: {
      ...(schema01.terrain_type?.attributes ?? {}),
      recruit_onto: 'boolean',
      recruit_from: 'boolean',
    },
  },
  // Wesnoth `[effect]` carries arbitrary attributes (`set_description`,
  // `set_icon`, `increase_damage`, ...) and children (`[set_specials]`), so it
  // stays open like the effect tags themselves.
  effect: {
    ...(schema01.effect ?? {}),
    openAttributes: "string",
    openChildren: true,
  },
  ...Object.fromEntries(EFFECT_TAGS.map((tag) => [tag, open])),
  ...Object.fromEntries(HELPER_TAGS.map((tag) => [tag, open])),
  global_traits: { attributes: { ids: 'string' } },
  // A race carries the traits its members may take, as `{TRAIT_DEXTROUS}`
  // expansions inside the `[race]` block.
  race: {
    attributes: {
      id: 'id',
      num_traits: 'integer',
      ignore_global_traits: 'boolean',
      race_traits: 'string',
    },
  },
  // Trait effects the typed engine does not model yet are kept as marker tags.
  trait: {
    ...(schema01.trait ?? {}),
    attributes: { ...(schema01.trait?.attributes ?? {}), availability: 'string' },
    children: ['effect', 'loyal', 'fearless', 'healthy', 'status', 'overlay'],
    openChildren: true,
  },
  loyal: open,
  fearless: open,
  healthy: open,
  status: open,
  overlay: open,
  ellipse: open,
  new_ability: open,
  // A unit type gains its ability registry list, which core WML writes as
  // `abilities_list=heals_8,cures`.
  unit_type: {
    ...(schema01.unit_type ?? {}),
    attributes: {
      ...(schema01.unit_type?.attributes ?? {}),
      abilities: "string",
      race: "id",
      num_traits: "integer",
      ignore_race_traits: "boolean",
      traits: "string",
      // The unit's own sound cues (`unit_type::die_sound`, and the hit sound the
      // engine plays when something strikes it), kept so the audio path reads
      // the game's own files instead of inventing ids.
      die_sound: "string",
      hit_sound: "string",
    },
    children: [...(schema01.unit_type?.children ?? []), "movement_costs", "defense", "resistance"],
    openChildren: true,
  },
  movement_costs: { openAttributes: "string", openChildren: true, children: [] },
  defense: { openAttributes: "string", openChildren: true, children: [] },
  resistance: { openAttributes: "string", openChildren: true, children: [] },
  // A special or ability is a named bag of effects.
  weapon_special: {
    attributes: { id: 'string', name: 'string', tag: 'id' },
    children: [...EFFECT_TAGS, ...HELPER_TAGS],
    openChildren: true,
  },
  ability: {
    attributes: { id: 'string', name: 'string', tag: 'id' },
    children: [...EFFECT_TAGS, ...HELPER_TAGS],
    openChildren: true,
  },
  // An era and its factions (`data/multiplayer/eras.cfg`, `factions/`).
  // Events and Lua inside an era are scenario behavior (P3/P8), not content,
  // so only the `[multiplayer_side]` declarations compile through.
  era: {
    // Era and faction ids are Wesnoth's (`era_default`, `Random`); the
    // framework `id` shape rejects underscores, so these stay plain strings.
    attributes: { id: 'string', name: 'string' },
    children: ['multiplayer_side'],
    openChildren: true,
  },
  multiplayer_side: {
    attributes: { id: 'string', name: 'string', image: 'string', leader: 'string', random_leader: 'string', recruit: 'string' },
    openChildren: true,
    children: [],
  },
  // Map items and object modifications (`data/core/macros/items.cfg`).
  // Effects reuse the trait-shaped vocabulary; unknown children stay open so
  // a scenario gift is never rejected for carrying P3 event tags.
  item: { openAttributes: 'string', openChildren: true, children: [] },
  object: { openAttributes: 'string', openChildren: true, children: [] },
};
