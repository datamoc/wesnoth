# Roadmap to a full port

Numbered build order, rewritten as a plan for a **full** port of Battle for
Wesnoth 1.19.27 (GPL-2.0-or-later) to TypeScript on `mwg`.

This file is the plan. `PORT_COVERAGE.md` is the ledger: one row per feature,
marked Ported / Simplified / Not ported, with the original source path it was
translated from. A milestone is only Done when its
row in `PORT_COVERAGE.md` says so and its "done when" check runs.

Conventions:

- **Status**: Done / Next / Later.
- **Size**: S (< 1 week), M (1-3), L (3-8), XL (> 8), for one developer who
  knows this codebase.
- Every item cites the original implementation (`src/…`, `data/…`) so fidelity
  stays checkable, and gives a **done when** that a test or a browser run shows.
- Performance is a standing priority: rendering stays on the Pixi path, and
  anything that costs real frame time moves up the order.

---

## 1. The original, measured

The port is not translating a game design; it is re-implementing a 190k-line C++
engine that reads 615 MB of data. These are the numbers as of 1.19.27, produced
with `find`/`wc` over this checkout.

### Engine (1,338 files, ~189,900 LOC C++)

| Subsystem | LOC | What it is | Port target |
| --- | ---: | --- | --- |
| `src/gui/` (+ `src/widgets/`, 2,596) | 81,456 | GUI2 widget set, dialogs, layout engine | `mwg/two-d/ui`, plus a port-side dialog layer |
| `src/scripting/`, `src/lua/` | 22,821 | Lua VM binding and the WML↔Lua bridge | MWL hooks (no Lua VM), see P3 |
| `src/ai/` | 19,961 | stages, candidate actions, aspects, Lua AI | `src/ai/` (P6) |
| `src/units/` | 19,394 | unit type, unit instance, abilities, attack types, movetype | `src/simulation/` (P1, P2) |
| `src/editor/` | 13,745 | map editor | P10 (optional) |
| `src/tests/` | 9,740 | engine unit tests + WML test scenarios | parity suites (P10) |
| `src/formula/` | 9,283 | formula language (used by WML values) | `mwg/mwl/expression.ts` + P3 |
| `src/actions/` | 8,362 | attack, move, heal, create, vision | `src/simulation/` (P1) |
| `src/whiteboard/` | 6,830 | plan-and-execute moves in MP | P8 |
| `src/game_events/` | 4,262 | event dispatch, filters, `[if]`, `[while]`, `[foreach]` | `mwg/mwl/runtime.ts` + P3 |
| single-purpose modules | ~4,000 | `attack_prediction`, `carryover`, `recall_list_manager`, `replay*`, `savegame*`, `tod_manager`, `pathfind/`, `map/` (generator), `minimap`, `storyscreen`, `help/`, `halo`, `image_modifications`, `xBRZ`, `font/`, `network_asio`, `server/`, `synced_*`, `random_synced`, `seed_rng`, `addon/`, `achievements`, `statistics` | spread across P1..P10 |

### Content

| Thing | Count | Notes |
| --- | ---: | --- |
| `.cfg` files | 2,598 | 615 MB total |
| maps (`.map`) | 456 | |
| unit type files | 327 | 328 loaded types |
| terrain types | 284 | 1,524 attributes |
| movetypes | 38 | |
| ability macros | 19 | `data/core/macros/abilities.cfg` |
| weapon special macros | 18 | `data/core/macros/weapon_specials.cfg` |
| trait macros | 21 | `data/core/macros/traits.cfg` |
| campaigns | 21 | 10-89 `.cfg` each; Heir_To_The_Throne 89 cfg / 85 maps, Under_the_Burning_Suns 82, Eastern_Invasion 68 |
| multiplayer scenarios | 62 | plus 2 eras, 14 factions |
| terrain-graphics configs | 30 | `data/core/terrain-graphics/` |
| GUI widget configs | 207 | `data/gui/`, plus 6 themes |
| images | 19,370 | png/webp/jpg |
| sounds and music | 377 | wav/ogg |
| Lua files | 338 | campaign and AI scripts |
| files containing `[event]` | 447 | scenarios and campaign fragments |
| translation catalogs | 1,922 | `.po`, 484 MB |

### The port today

| Thing | Count |
| --- | ---: |
| hand-written TypeScript | ~6,000 lines, 26 files |
| MWL scenarios | 2 (`courier`, `freelands`), 254 lines |
| coverage rows in `PORT_COVERAGE.md` | ~110 |
| built page | one 44 MB IIFE that runs from `file://` |
| tests | 85 port, 1,419 framework |

That ratio is the honest headline: **about 2% of the engine's line count**, with
the data pipeline, one skirmish's rules, two scenarios, and a campaign slice
done. Everything below is the other 98%.

---

## 2. Done so far

| Milestone | Evidence |
| --- | --- |
| Real data pipeline through MWL | `npm run data` reads 2,598 `.cfg` files, emits `game-data.ts` byte-identical to the pre-MWL route apart from added `profile` fields |
| Playable skirmish on a real map | `#freelands`, 2p_The_Freelands, real terrain art, real combat/movement/economy rules |
| Content in MWL, not code | `src/scenarios/*.mwl` compiled by `tools/compile-scenario.ts`; `MwlRuntime` owns sides, gold, units, objectives |
| Story beats | `[event] on=moveto`, `[message]` with speaker and real portrait, dialogue box |
| Campaign slice | `courier` → `freelands` with gold and unit carry-over, victory/defeat screens, `src/campaign.ts` |
| `file://` single-file build | `dist/index.html` opens by double-clicking |

---

## 3. The ladder

Each phase is written so the game stays playable and provable at the end of it;
the "done when" lines are the acceptance tests.

### P0 - Product foundations (required before broadening the port)

These items are not Wesnoth subsystems, but they are necessary to make the
port maintainable and to prove that a feature is genuinely usable. They take
priority over optional breadth such as the editor, achievements, or Lua.

| Item | Priority | Size | Done when |
| --- | --- | --- | --- |
| Playable reference slice | Critical | S | A user can start a campaign, play a complete scenario, win or lose, continue to the next scenario, save, reload, recruit and recall without URL or developer tooling |
| Single authoritative game state | Critical | L | MWL runtime, rules engine and UI read/write one documented state model; no lossy synchronization path remains, and save/load round-trips it |
| WML compatibility matrix | High | M | Every consumed WML tag/attribute is classified as Ported, Simplified, Ignored, or Blocking; CI reports newly ignored blocking content per scenario. Done: `SCENARIO_COMPATIBILITY` carries the per-scenario counts and messages. `tools/compat-baseline.mjs` records them in `tests/compatibility-baseline.json`, and `tests/compatibility.test.ts` fails on a new blocking skip, an unseen skip pattern, or a rising total (398 diagnostic-bearing scenarios, 1,846 skips, 0 blocking; nested event bodies, compound conditions, dynamic unit movement, transient movement/input/presentation controls, recognized campaign Lua initializers, reversible object removal, fog reset and explicit shroud placement, dynamic time-area updates, leader-specific extra recruitment, reachable-location queries, client-only display/debug commands, runtime recruit-list replacement, dynamic `[repeat]`, `[for]`, `[unit_worth]`, `[transform_unit]`, `[random_placement]`, `[do_command]`, per-unit movement-cost overrides, `[petrify]`, side-level recall filters, unit variable tables, side variable tables, respawn-point search, global variable persistence, inline terrain masks, terrain-mask files, fire-event aliases, and undo callbacks are now audited rather than dropped) |
| WML/MWL diagnostics mode | High | M | A reproducible run can print the seed, event trace, variable changes, skipped tags and final state, and can reduce a failing scenario to a fixture. Run with `?diagnostics=1` (the scene logs the snapshot) or read `__WESNOTH__.diagnostics()` / `.trace`: seed and RNG state, world variables, the MWL trace of claimed events and variable writes, the action journal, the rules state, the compatibility report and the outcome |
| Fidelity and deviation policy | High | S | Each subsystem has an explicit exactness target, accepted simplifications, and a parity test or documented reason for the absence of one. `FIDELITY.md` states the five targets (exact, numeric, shape, presentation, absent) and assigns every subsystem one, with the test that defends it and its standing reductions |

P0 is a release gate for every later phase: a feature is not considered
complete merely because it compiles or has an isolated unit test.

### MWG extraction backlog (audit du port)

Le port ne doit déplacer vers MWG que les mécanismes indépendants des règles
Wesnoth. Les règles de terrain, de combat, de villages, de temps légal et de
filtres WML restent dans l'adaptateur Wesnoth.

| Priorité | Élément repéré dans le port | Destination MWG proposée | Critère de sortie |
| --- | --- | --- | --- |
| Haute — fait | Recherche de cases atteignables pondérée, dupliquée dans `simulation/movement.ts` et `simulation/vision.ts` | `mwg/core/Pathfinding.ts` (`weightedFlood`) | Le port fournit ses coûts/ZoC/visibilité ; MWG fournit le parcours et ses tests |
| Haute | Primitives `inside`, `cellIndex` et clés de coordonnées | `mwg/core` : utilitaire de grille bornée et indexation row-major | Plus de duplication de l'indexation dans les systèmes de jeu ; hors limites testé |
| Haute | Chargement asynchrone, cache et libération des textures (`main.ts`) | `mwg/assets` / `mwg/two-d` | Le port ne gère plus directement `Assets.load`, le cache Pixi et les états de chargement |
| Moyenne — fait | Minimap tactique et rasterisation incrémentale | `mwg/two-d/render/Minimap` | La rasterisation persistante, les marqueurs multiples et l'information au survol sont fournis par MWG ; les couleurs et règles de visibilité restent portées |
| Moyenne — fait | Sauvegarde locale versionnée (`saveGame`/`loadGame`) | `mwg/core/SaveSystem` | Le port fournit le payload d'état ; slots et stockage sont désormais gérés par MWG |
| Moyenne | Journal des actions et point de reprise | `mwg/core/ActionJournal` | Mouvement, combat, recrutement et fin de tour produisent un journal rejouable |
| Basse, P4 | Affichage des animations d'acteurs | `mwg/two-d/render/AnimatedSprite` et `ActorAnimator` | Les timelines Wesnoth sont converties en animations MWG sans logique de campagne |
| Basse, UI | Labels flottants, boutons, fenêtres et sélection | `mwg/two-d/ui` | La scène ne dessine plus ses contrôles génériques avec `Graphics`/`Text` directement |

Déjà mutualisés et à ne pas redéplacer : géométrie hexagonale (`mwg/core`),
RNG déterministe (`mwg/core`), brouillard/exploration (`mwg/board/FactionFog`),
runtime MWL et traces (`mwg/mwl`), ainsi que les modificateurs d'image
(`mwg/two-d/render/ImageModifiers`).

### P1 - Rules completeness (turn one skirmish into any skirmish)

Goal: the current scene can fight **any** matchup in the default era, not just
Spearman-vs-Grunt.

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Full attack value engine: `[chance_to_hit]`, `[damage]`, `[attacks]`, `[resistance]`, `[damage_type]`, `backstab`-style conditional values | M | `src/units/attack_type.cpp`, `src/actions/attack.cpp`, `src/utils/math.hpp` | every `[attack]` in `data/core/units` resolves; values match a table generated from the C++ rules |
| Weapon specials as data (18 macros) | M | `data/core/macros/weapon_specials.cfg` | every real special fires in tests: unwieldy, berserk, backstab, plague, plague_type, slow, petrify, marksman, magical, honed, swarm, charge, guard, drain, firststrike, poison, stun, arcane |
| Abilities as data (19 macros) | M | `data/core/macros/abilities.cfg` | every real ability works: heals, extra_heal, unpoison, cures, regenerates, self_heal, steadfast, diversion, leadership, skirmisher, illuminates, teleport, ambush, burrow, nightstalk, concealment, submerge, swamp_lurk, feeding |
| Statuses and objects | M | `src/units/unit.cpp`, `[object]` in `data/core/macros` | poisoned/slowed/petrified persist, tick, and clear correctly |
| Advancement and AMLA | M | `src/units/unit.cpp`, `data/core/macros/amla.cfg`, `advances_to` trees | XP curve, level-up choice, AMLA, max level all match |
| Traits per race | S | `data/core/macros/traits.cfg`, race blocks in unit files | every trait applies its real effect and only to races that can take it |
| Movement completeness | M | `src/pathfind/pathfind.cpp`, `src/units/movetype.cpp` | flying, swimming, `[movement_costs]` overrides, ZoC, skirmisher exceptions |
| Vision: fog and shroud per side | M | `src/actions/vision.cpp`, `team_shared_vision.hpp` | vision cost per terrain, villages/castles extending sight, shared vision |
| Economy edge cases | S | `src/team.cpp`, `src/game_config.cpp` | loyal upkeep, level-based upkeep, village support, difficulty gold modifiers |
| Attack prediction | S | `src/attack_prediction.cpp` | CTH/expected-damage numbers shown before an attack match the engine's |

P1 status: **done**. Traits are selected per race and unit type
(18 traits, 24 races, forced `musthave` traits, the `loyal`/`fearless`/`healthy`
markers and undead immunities), abilities work (leadership, illuminates, heals,
regenerates, cures, skirmisher, teleport, diversion, feeding), and `[disable]`,
backstab, advancement with a player-chosen AMLA, loyal upkeep, slowed movement,
unit-type movement override tables and attack prediction are ported. Vision is
ported as a model: per-side fog and shroud over movement-cost sight, the six
hides abilities with adjacency reveal and discovery stops, hidden targeting
refusals, and plague spawns. Deliberate reductions: jamming is zero, all sides
are mutually hostile (no shared vision until P8 teams), teleport costs one
move, diversion reuses the backstab flank geometry, and the scene auto-takes
the first advancement. Fog/shroud hex overlays are P4 presentation.

P2 status: **done**. All 328 unit types, 284 terrains, 38 movetypes, 24 races,
18 traits, 17 specials and 20 abilities load, both eras compile with their
factions, all six named schedules compile with `[time_area]` overrides, items
and `[object]` gifts parse and apply, the 30 terrain-graphics rule files parse
into a transition model (rendering stays in P4), and `tests/p1.test.ts` plus
`tests/p2.test.ts` carry the data-parity checks.

Historical note, first P1 slice: the **fight engine** is in place - specials and
abilities are loaded as data (17 + 18 definitions, keyed by the registry ids units
reference), the composite value engine mirrors `abilities.cpp`, and CTH, damage,
strikes, swarm, drain, charge, steadfast, berserk, firststrike and the three
statuses all come from the game's own numbers (`src/simulation/specials.ts`,
`src/simulation/combat.ts`, 11 tests in `tests/specials.test.ts`).

Still open beyond P1/P2: the filter formula language inside
`[filter_opponent]` and friends (backstab's and diversion's geometry is
evaluated directly instead); `max_times` caps on AMLA; shared vision between
allied sides (P8 teams); scenario-file placement of items and `[time_area]`
(P3 event engine); terrain-graphics rendering, fog/shroud overlays and unit
animations (P4).

### P2 - Content completeness (all of core, not a slice)

Goal: every mainline unit, terrain and movetype loads and behaves.

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| All 328 unit types with races, abilities, specials, AMLAs, `advances_to` | M | `data/core/units/` (327 files) | a generated table of ids, stats, attacks and abilities matches the WML |
| All 284 terrain types, aliases, `default_base`, overlays, `gives_income`, `heals` | S | `data/core/terrain.cfg` | resolution matches for every code in every mainline map |
| All 38 movetypes | S | `data/core/units.cfg` | movement/defense/resistance tables complete |
| Items, statuses, `[object]`-defined content | M | `data/core/` + campaign files | items load and apply through MWL |
| Schedules and ToD variants | S | `data/core/macros/schedules.cfg` | all schedules and `[time_area]` overrides |
| Eras and factions | M | `data/multiplayer/eras.cfg`, `factions/` | the default era's recruit lists and leaders come from data |
| Terrain graphics inputs | L | `data/core/terrain-graphics/*.cfg` (30) | the 30 rule files are parsed into a transition model (rendering lands in P4) |
| Data parity test | M | `src/game_data.cpp`, `src/units/types.cpp` | a script proves every field the C++ engine reads exists in `game-data.ts` |

### P3 - WML/MWL content engine (make mainline scenarios runnable)

Progress update: adjacent unit, adjacent-location, vision, ability, and unit
formula WML filters are implemented and covered by `tests/wml-filter.test.ts`;
event-level `filter_formula=` is handled by `predicate:wml_formula` and covered
by `tests/engine-hooks.test.ts`. Lua-backed filters remain deferred with the
Lua VM.

Progress update: `[sound_source]` and `[remove_sound_source]` now compile to
the positional MWG audio mixer, with distance falloff, repeat cadence, source
replacement/removal, and a listener following the active leader; story-part
music is also emitted before its narrator page.

Progress update: `[harm_unit]` now applies variable-backed damage to filtered
live units, preserves the primary/secondary attack selectors, and honors
`kill=yes`; unit modification hooks also cover experience, alignment, poison,
slow, recruitability, and attack damage type. The regenerated matrix is 398
scenarios, 16,311 skips, and 85 blocking Lua blocks.

Progress update: `[modify_ai]` now updates live candidate enable/disable lists
and appends positional goal/avoid directives for event-time AI changes. This
removes the 2,213 generic `[modify_ai]` skips; other AI tree paths remain a
documented reduction.

Progress update: pure-return Lua conditions now run through Pyroeis (the Lua VM
formerly published as Fengari) with the
WML variable table and `wesnoth.game_config.random_mode` exposed. Imperative
Lua blocks and the broad `wesnoth.*` campaign API remain explicit blockers.

Goal: a real mainline scenario file loads and plays.

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Preprocessor completeness | M | `src/serialization/preprocessor.cpp` | nested `#define`, `#arg`, `#ifdef/#ifndef/#else/#endif`, `{dir}`, `{file}`, `[+tag]`, `#textdomain`, unknown-macro pragma |
| WML parser completeness | M | `src/serialization/parser.cpp` | quoted/multi-line values, `+tag` merge, `$var` substitution, translatable strings |
| Event engine: filters | L | `src/game_events/` | side/team/unit/location/weapon/ability filters, `[filter_second]`, `[filter_condition]` |
| Control flow commands | M | `[if]`, `[while]`, `[foreach]`, `[switch]`, `[command]` | loops with real conditions, variables, nested events |
| Unit commands | L | `[store_unit]`, `[unstore_unit]`, `[modify_unit]`, `[unit]`, `[recall]`, `[kill]`, `[role]` | scenarios can spawn, delete, modify and recall units |
| Variables and formula | M | `src/formula/`, `src/variable.cpp` | the formula subset MWL exposes plus `[set_variable]` arithmetic |
| `[scenario]`/`[campaign]` loader | M | `data/campaigns/*/` | the port's `wml.ts` converts a real mainline scenario into MWL and runs it |
| Scenario compatibility report | M | `src/serialization/`, `src/tests/` | every compiled scenario emits counts for converted, simplified, ignored and blocking WML constructs; the build fails on unapproved blocking skips |
| Story screens and dialogues with options | M | `src/storyscreen/`, `[message] [option]` | a scenario's briefing and choices render and branch |
| `[endlevel]` and level results | S | `src/game_end_exceptions.*`, `src/carryover.cpp` | per-scenario result overrides, bonus turns, carryover rules from WML |
| Lua bridge decision | L | 338 `.lua` files | split in two: the formula subset (arithmetic, comparisons, named helpers, `where`) covers data-side values such as leadership's `(25 * (level - other.level))` and lands with the expression work; a real Lua VM is only worth it if unmodified mainline campaigns are a goal, and then it comes in as the optional script-host adapter (framework roadmap item 210) rather than a core dependency |
| First real target: **Two Brothers** (5 scenarios) | M | `data/campaigns/Two_Brothers/` (10 cfg, 4 maps) | playable start to finish from the original files |

### P4 - Presentation (make it look like Wesnoth)

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Terrain-graphics transition renderer | L | `data/core/terrain-graphics/`, `src/terrain/` | multi-hex transitions, `[tile]` rules, village/forest/castle edges blend like the original |
| Batched tile layers | M | `src/display.cpp`, `src/draw.cpp` | large maps (HttT's 85) render without per-cell containers, measured frame budget |
| Unit animations | L | `src/animated.cpp`, `[standing_anim]`, `[attack_anim]`, `[death]`, `[movement_anim]` | units idle, attack, die, and move along their path |
| Image modifiers | M | `src/image_modifications.cpp` | `~BLIT`, `~RC`, `~CROP`, `~CHAN`, `~CS`, `~FL`, `~SCALE` |
| Halos, floating text, damage labels | S | `src/halo.cpp`, `floating_label.cpp`, `floating_textbox.cpp` | healing, poison, damage numbers appear over units |
| Team colouring | S | `src/color_range.cpp`, `data/core/team-colors.cfg` | side colours recolour units and flags |
| Minimap, unit info, attack dialog | M | `src/minimap.cpp`, `src/gui/` | side panel shows turn, gold, income, terrain defense of the hovered hex |
| Font and text markup | M | `src/font/`, `src/tstring.cpp` | `<b>`, colours, `$vars` in labels, wrapping |
| xBRZ upscaling (optional) | S | `src/xBRZ/` | scaled pixel art looks as good as the original's |

P4 status: **partial, and now rendering transitions**. Unit animations are
ported end to end: the data pipeline
loads the real animation macros, compiles frames for 323 unit types into
`src/generated/unit-animations.ts`, and the scene loops idle, interpolates
movement, and plays attack and death once (`src/simulation/animation.ts` +
`tests/animation.test.ts`). The board is batched into a static terrain layer, one
merged overlay `Graphics` and persistent unit views behind a single pointer hit
area; status icons, damage/heal numbers, temporary `[halo]` images and fog/shroud overlays render. Deliberate
reductions: the south-east facing and the hit branch only; per-frame image
offsets and basic `[missile_frame]` projectile travel are applied, and temporary
`[halo]` images with `[halo_frame]` sequences now render; team colouring is a per-side tint,
and named/hex `~RC` is a deterministic tint approximation, not a palette swap.
The terrain-graphics **transition engine is now ported**: the 30 rule files
compile into 4,077 rules, `src/simulation/terrain-codes.ts` reproduces
`translation.cpp`'s codec and wildcard matching, and `buildTerrainTiles`
reproduces `builder.cpp`'s builder-map walk, rotations, flags, probability,
per-hex noise and background/foreground split. The pipeline prunes variations
whose art is absent and copies only the art the shipped maps draw, and the scene
draws the built layers around the unit layer. Deliberate reductions:
`[image] base=` is kept for classification but not applied as a pixel offset,
global `[image] center=` is a whole-image offset rather than a hex crop, terrain
animations are drawn at their first frame, and only the shipped maps' art is
bundled. **Team colouring and font markup are now ported too**:
`src/simulation/color-range.ts` transliterates `recolor_palette` and the real
`team-colors.cfg` ranges/palettes recolour unit textures per side
(`tests/color-range.test.ts`), and `src/ui/text-markup.ts` resolves `$variables`
and `<b>`/`<i>`/colour spans in dialogue with Pixi's word wrap. Deliberate
reductions: a side follows the `default=yes` range order (the port's side model
does not carry `[side] color=`), and Pixi v8 has no underline so `<u>` keeps its
text unstyled. xBRZ remains open.

### P5 - UI/UX shell

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Menus: main, scenario, campaign, load/save, preferences, credits | L | `src/game_initialization/`, `src/gui/` | the game can be started, saved and quit from the UI |
| Campaign-ready vertical slice | S | `src/main.ts`, `src/campaign.ts` | the reference campaign can be completed using only visible UI controls, including scenario selection, recruit/recall, victory/defeat and resume |
| GUI2-lite widget layer (or mwg-native replacement) | XL | `data/gui/` (207 cfgs), `src/widgets/` | layout from data, buttons/lists/sliders/dialogs; decide port-format vs rebuild early |
| Recruit and recall dialogs | M | `data/gui/`, recall rules in `src/team.cpp` | recruit by list, recall from the list, both with real costs |
| Objectives, turn and status dialogs | S | `data/core/macros/` | scenario objectives readable in-game |
| Help and encyclopedia | L | `src/help/`, `data/core/help.cfg` | terrain/unit/ability pages generated from data |
| Hotkeys and preferences | M | `data/core/hotkeys.cfg`, `src/preferences.*` | rebindable keys, persisted settings |
| Touch and responsive input | M | `src/gui/`, Pixi pointer events | the reference slice is usable with mouse, keyboard and touch at desktop and mobile viewport sizes |
| Achievements, statistics | S | `src/achievements.*`, `src/statistics.*` | optional, but wired to real events |

P5 status: **the shell is in**. One framework `WindowStack` owns every menu and
the keyboard; the port themes it in `src/ui/menus.ts` and builds the start screen,
the Escape/M pause menu, a scenario picker, multi-slot save/load with delete and
an autosave, an objectives dialog, a help screen and a rebinding preferences
screen on the framework's `Window`/`Button`/`ListView`/`HelpScreen`/`RebindScreen`.
Recruit and recall are one list dialog with the real costs and disabled rows.
Board input is pointer-based (mouse and touch) and the HUD wraps below 720px.
Still open: the GUI2 data-driven widget layer (the port rebuilt on framework
widgets instead of parsing `data/gui/`). The encyclopedia is generated from
compiled data, and achievements/statistics are wired to the Two Brothers slice;
the full catalog and detailed per-scenario breakdown remain open.

### P6 - AI

Goal: an opponent that plays a real game, then one that plays well.

| Rung | Size | Original | Done when |
| --- | --- | --- | --- |
| a. Recruit, attack, retreat with evaluation | M | `src/ai/` (20k LOC) | the AI wins against the current stand-in on every mainline map |
| b. Village grabbing, healing, unit preservation | M | `src/ai/default/` | AI income and unit survival approach the original's on the same maps |
| c. Threat maps, poison, ZoC-aware movement | M | `src/ai/` | measured win-rate parity on a fixed map set |
| d. Candidate action framework and aspects | L | `src/ai/composite/` | `[ai]` WML aspects and stages drive behaviour |
| e. Lua AI compatibility | XL | `data/multiplayer/eras.lua`, campaign AI | deferred with the Lua decision (P3) |
| f. Difficulty levels | S | `[ai]` + difficulty in scenarios | easy/normal/hard change gold, income and aggression like the original |

P6 status: **rungs a-c, d and f are in**. Rung d now runs the engine's own
candidate-action order: `src/ai/candidates.ts` holds the real ids and
`max_score` bands from `data/core/macros/ai_candidate_actions.cfg` (with the
enabled set of `data/ai/ais/ai_default_rca.cfg`), `planSide` classifies each
finished decision into the candidate it belongs to and emits them in band
order, and `[candidate_action]` ids, `max_score=` retuning and `enable=no`
reach the scheduler through the scenario's `[ai]` blocks. `tests/ai.test.ts`
and `tests/ai-candidates.test.ts` lock the band order, the disable path, the
override path and the table's agreement with the real data files. The rest of
this paragraph is the earlier state: `src/ai/plan.ts` is a scored
candidate-action loop: each unit scores every `reachable` position and adjacent
target, with expected damage dealt and taken coming from the engine's own
`predictAttack`, a per-hex threat map projected from the visible enemies, village
capture and healing values, and a refusal to trade into a kill. `src/ai/policy.ts`
turns a campaign difficulty (and the `[ai] aggression=/caution=/greed=/grouping=`
aspects, surfaced as scenario variables) into the planner's weights and the AI
sides' gold/income bonus; location-based `[goal]`/`[avoid]` directives also flow
through scenario variables into candidate-position scoring; `main.ts aiTurn` executes the plan through the same
`moveUnit`/`attackWithRules`/`placeRecruit` calls the human uses. 7 new tests in
`tests/ai.test.ts`; headless Chrome shows the side recruiting four units and
advancing, with no page errors. Still open: the composite stage/aspect framework,
filter-based goals and keep-away maps (d), and Lua AI (e). The threat projection
now evaluates defender-specific terrain CTH through the same prediction path as
attacks, `grouping` now has a separate ally-proximity score in addition to its
caution effect, ranged `[goal]`/`[avoid]` locations expand into concrete
keep-away directives, and stock `[stage]` candidate actions can enable or
disable the port's executable AI phases. Common unit-filter-based goals now
score proximity to live units using `id`, `side`, `type`, `not_type`, `level`,
`alignment`, and `canrecruit`; the full composite scheduler remains open.

### P7 - Campaign systems

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Campaign WML: `[campaign]`, scenario list, `[endlevel]` results | M | `data/campaigns/*/`, `src/campaign_type.hpp` | a campaign's own files define its order and rules |
| Recall list, carry-over percentages, bonus gold | M | `src/carryover.cpp`, `src/recall_list_manager.cpp` | survivors recall with traits intact (fixes the port's re-roll limitation) |
| Difficulty, early-finish bonuses, hero/loyal flags | M | `data/campaigns/*/` | a scenario checks and rewards difficulty and speed |
| Story screens between scenarios | S | `src/storyscreen/` | campaign intro/outro text and art |
| **Heir_To_The_Throne** end to end (89 cfg, 85 maps) | XL | `data/campaigns/Heir_To_The_Throne/` | the flagship campaign is completable |
| Other campaigns in size order | XL | `Under_the_Burning_Suns` (82), `Eastern_Invasion` (68), `The_Deceivers_Gambit` (58), `Secrets_of_the_Ancients` (56) | each finished campaign flips its row in `PORT_COVERAGE.md` |

P7 status: **real campaigns now define themselves**. `tools/compile-campaign.ts`
preprocesses `data/campaigns/Two_Brothers/_main.cfg` (so `{CAMPAIGN_DIFFICULTY}`
and `{DEFAULT_DIFFICULTY}` expand), compiles id/name/abbrev/icon/description,
the `first_scenario`, the `[difficulty]` list and the `next_scenario` chain into
`src/generated/campaigns.ts`, and the scene's New campaign menu picks a campaign
and a difficulty. The campaign's own order drives `next_scenario`, the N key and
the victory screen; difficulty selects the AI policy and its gold/income bonus.
Recall now rebuilds a survivor with its saved traits, loyalty and granted
abilities (`makeUnitWithTraits`) instead of re-rolling, and the early-finish
bonus (`[endlevel] bonus=yes`) is paid from the unused turns. Starting TB01 also
surfaced two P3 gaps that are now closed: `[kill]` is a no-op when its filter
matches nothing (`command:kill_unit`), and the turn-limit defeat predicate is
implemented (`predicate:turn_limit`), and live attack/death/recruit triggers now
receive the same subject context as moveto, including common ability/status
filters. Headless Chrome walks TB01 -> TB02 with 13
recalled units and no errors. South Guard's branch `next_scenario` choices now
survive WML conversion and select 05a/05b/05c and the following finale at
runtime. Liberty's eight scenarios are also compiled from its own campaign and
scenario files, Dusk of Dawn's five scenarios now compile from its own
campaign files as well, and Of Pearls and Pirates' six scenarios compile with
its four difficulty levels. The Hammer of Thursagan's 11 scenarios and four
difficulty levels now compile too, and Dead Water's 13 scenarios compile from
its campaign files after adding grouped macro-argument handling for WML arrays.
Descent Into Darkness's 13 scenarios, including the 07a/07b/07c branch, now
compile after adding dynamic variable names and ranged unit predicates. Sceptre
of Fire's 13 scenario documents now compile as well, including its 1-based
scenario numbering and 2p5/2t/3t/4t side branches. Northern Rebirth's 16
scenario documents now compile too, including compound ids such as 02_01 and
05a_02. Son of the Black-Eye's 19 scenario documents and The Rise of Wesnoth's
27 scenario documents now compile too, including its 04a/04b and 17a/17b/17c/17d
branches. The shared MWL runtime now also
evaluates hook-backed conditions emitted by real WML macros.
Still open: campaign intro/outro art and vertical
story pagination (scenario story backgrounds now render full-screen behind the
narrator dialogue), per-difficulty scenario WML (`#ifdef EASY`), and the
campaigns not yet listed in `tools/campaign-dirs.ts`.

The loader now emits `[set_variables]` as a runtime `command:set_variables`:
`[value]`/`[literal]` trees, append mode, and keyed `[split]` lists are preserved
with WML interpolation deferred until execution. The regenerated corpus is 398
scenarios with 1,728 skips, 1,728 warnings, and 0 blocking diagnostics.

**Heir_To_The_Throne ships.** The `{IF} THEN(...) {/IF}` idiom, `{/ELSEIF}`
closers, inline tags, `[ /elseif]` whitespace, `{EFFECT new_animation([...])}`
argument grouping, blank scenario ids and `[effect]` attributes all compiled, so
its 35 scenarios, unit types and specials produce MWL, and the campaign is in
`CAMPAIGN_DIRS` (15 campaigns). Shipping it needed the generated scenario
modules to be compact: `emitModule`'s tab-pretty output plus a per-node
`location` inflated `scenarios.ts` to ~82 MB and OOM'd the single-bundle build,
while compact JSON without locations is ~34 MB. `npm run build` now raises the
Node heap for that one bundle; true per-scenario lazy loading is still the P10
asset-budget item.

**The Deceivers' Gambit ships** (16 campaigns). Its conversion closed two more
WML semantics gaps: a `{PARAM}` inside a `#` comment is now left alone instead of
splicing the value into text the comment stripper then removes, and a mid-line
`#` comment inside a taken `#ifndef` branch is dropped like the top level (which
had left `type=arcane # …` failing MWL's `id` check). Wesnoth's range spelling in
unit filters (`level=0-2`) is now accepted by the port's scenario schema.

**Eastern Invasion and Under the Burning Suns ship** (18 campaigns, 343
scenarios, 666 unit types). EI surfaced a real converter bug: a `moveto` filter
whose `x`/`y` are ranges was expanded into one event per matching cell, so
`17b_All-In` alone produced 30k events and `scenarios.ts` reached 104 MB. The
filter now keeps Wesnoth's spelling and the runtime gained generic coordinate
matching (`matchesCoordinate`, a number, range or comma list), which cut
`scenarios.ts` to 17.7 MB. Marker traits with no `[effect]` (`deserter`) and ids
containing spaces (`greater drains`) are registered too.

**Legend of Wesmere ships** (19 campaigns). Its 24 documents live in
`scenarios/chapter1..5/`, so the MWL emitter and the `next_scenario` chain walk
now recurse and take each scenario's id from its filename stem; no other blocker
remained.

**Heir to the Throne Classic ships** (20 campaigns, 400 scenarios, 673 unit
types). Its tutorial scenarios are named from their ids (`tutorial`,
`2_Tutorial`), not from a numeric prefix, so `scenarioPortName` now slugs an id
with no leading number, and a campaign-wide `disambiguateScenarioNames` breaks
the `2_Tutorial` / `02_Blackwater_Port` collision by appending the id slug — the
same map the campaign chain and the MWL emitter share. The change also revealed
that Sceptre of Fire's `epilogue` scenario had been dropped (non-numeric id), so
it is compiled now. Still open: World Conquest, a Lua/era conquest mode rather
than a `[scenario]` chain.

Secrets of the Ancients' 22 scenario documents now compile too, which surfaced
and closed two WML semantics gaps:
`parseWmlValue` now reads quoted segments and `+` concatenation the way the real
tokenizer/parser do (so `"portraits/x.webp"~SCALE(93,93)` and `_ "a" + "b"` are
one value), and the loader translates WML comparison operators
(`less_than_equal_to`, `boolean_equals`) and routes non-id variable paths such as
`zombies[0].allow_recruit` through the string-keyed variable hooks instead of an
invalid MWL `[variable] name=`. Castle and keep terrain now carry the real
`recruit_onto`/`recruit_from` flags, so `Co`/`Ce`/`Ke` classify like `Ch`/`Kh`;
Two Brothers' `Ke` keep and `Ce` castles were previously invisible to the recruit
rule.

Each shipped campaign's own `units/` now compiles with that campaign's `utils/`
macros into the same registry as core (484 unit types), along with the campaign's
macro-defined `[weapon_special]`/`[ability]`/`[trait]`s and unit-inline specials.
Before this, the scenario loader silently dropped any `[unit]` whose `type=` was
not a core type, which lost 371 units across the port's campaigns (Descent Into
Darkness's hero `Malin Keshar`, The South Guard's `Veteran Fencer`, and their
troops). That is down to 13, and the 13 are `none`/`missing` difficulty
sentinels inside a `[if]` that never runs. Three more pieces closed the gap:
`[unit] type=$variable` placements (Sceptre of Fire's `WINTERENEMY` picks
`$typeofenemy` from a `rand=` list) now emit `command:spawn_dynamic` and resolve
at runtime, `[set_variable] rand=` picks through `command:set_variable_rand`, and
`data/internal`'s unit types (`Rogue Mage`, `Shadow Mage`, `Dwarvish Witness`)
compile alongside the campaigns. Two WML-fidelity bugs surfaced on the way and
are fixed: comma name groups (`x,y=5,3`, `range,type=melee,blade`) split into
separate attributes, `# define` with a space is a comment rather than a directive
(which had made `Son_Of_The_Black_Eye/utils/1-amla.cfg` unparsable), and a
parenthesized multi-word macro argument (`{ELF (Elvish Shyde) ...}`) keeps its
grouping through a nested call. Remaining campaign-data gaps: 184 campaign art
files are absent from this checkout and event-driven abilities keep only their
non-event effects.

### P8 - Multiplayer

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Side controllers, teams, per-side fog/shroud, shared vision | M | `src/side_controller.hpp`, `src/team.cpp` | two local sides play a real MP scenario |
| Lobby and game setup | L | `src/game_initialization/`, `data/gui/` | host a game, choose scenario/side/era |
| Deterministic RNG for replays and sync | M | `src/random_synced.cpp`, `src/seed_rng.cpp`, `src/mt_rng.cpp` | the same seed replays identically |
| Action journal shared by local and network play | M | `src/replay*.cpp`, `src/synced_*` | every player action has a serializable command record, and replaying the journal reaches the same final state |
| Replays | M | `src/replay*.cpp` | record and replay a game |
| Undo and whiteboard planning | L | `src/whiteboard/` (6.8k) | undo a move; plan multiple moves |
| Network transport | L | `src/network_asio.cpp`, `src/wesnothd_connection.cpp` | lockstep over WebSocket using `mwg/core` Multiplayer |
| Server | L | `src/server/` (wesnothd) | a relay that matches the port's protocol (not necessarily the C++ wire protocol) |
| OOS detection and chat | S | `src/synced_checkup.cpp`, `src/chat_events.cpp` | desyncs and bounded peer chat are visible |
| 62 MP scenarios + eras + factions | L | `data/multiplayer/` | the standard map pool is playable |

### P9 - Persistence

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Save format decision (native JSON vs Wesnoth `.gz`) | S | `src/savegame.cpp`, `src/serialization/` | documented choice, with rationale |
| Save/load of a scenario and a campaign | M | `src/save_index.cpp`, `saved_game.hpp` | save mid-scenario, reload, continue |
| Autosave and start-of-scenario saves | S | `src/savegame.cpp` | the game survives a browser reload |
| Replay files | S | `src/replay_recorder_base.cpp` | replays are files that can be shared |
| Seed and state reproducibility | S | `src/random_synced.cpp`, `src/seed_rng.cpp` | a saved seed plus action journal reproduces traits, combat, AI and the final serialized state |

### P10 - Tooling, quality, packaging

| Item | Size | Original | Done when |
| --- | --- | --- | --- |
| Data parity suite | M | `src/units/types.cpp`, `src/game_data.cpp` | CI fails if a WML field the engine reads is missing |
| Golden scenario runs | M | `src/tests/` (9,740) | scripted scenarios run headless and diff their outcome |
| Performance budgets and CI | M | `src/display.cpp`, draw path | large-map and combat-heavy turns meet a documented budget |
| Asset-size budget and lazy loading | M | `src/images/`, `src/desktop/` | the bundle has a documented size budget, large asset groups load on demand, and the offline build remains functional |
| i18n: `.po` loading, plurals, RTL | L | 1,922 catalogs, `src/language.cpp`, `mwg/i18n` | a translated run renders real strings. Done for nine shipped catalogs: `tools/compile-i18n.ts` compiles de/es/fr/it/ja/pl/ru/zh_CN/ar from the real `.po` files, `src/ui/language.ts` owns the choice (a preferences row, `?lang=xx`, saved setting) and the per-locale translator cache, plural slots follow each catalog's own `Plural-Forms`, and RTL locales switch dialogue alignment. Still open: the port's own interface strings, which the game's catalogs do not cover |
| Map editor | L | `src/editor/` (13.7k) | optional scene, after the game is complete |
| Add-on manager | L | `src/addon/` | optional, needs the WML surface to be complete first |
| Packaging: desktop, mobile, PWA | M | `src/desktop/`, `src/macosx/` | installable builds, touch input on mobile. Done for the web side: `tools/emit.mjs` emits `manifest.webmanifest`, a cache-first `sw.js` and the game's own `wesnoth-icon.png`, and the built page is installable and works offline when hosted, while the `file://` build stays the same single file (the manifest link and service-worker registration are injected only on http). Touch input already worked (pointer events); `npm run verify -- --mobile` now proves it at a phone viewport with touch emulation. Desktop shells (Electron/Tauri) and native mobile packaging remain open |
| Split to its own repository | S | this directory | when the port stops needing the C++ checkout to develop against |

### Additional backlog: gaps to close before calling the port complete

The phase tables above cover the original subsystem boundaries. This backlog
captures cross-phase work that is easy to miss because it is spread across the
engine, data files, or the browser product. These are roadmap items only; they
do not imply that the generic MWG framework should absorb Wesnoth-specific
rules.

Filter status correction: adjacent, vision, ability, formula, and radius filters are implemented and covered in `tests/wml-filter.test.ts`; only `lua_function=` remains intentionally unported.

| Item | Status | Size | Original | Done when |
| --- | --- | --- | --- | --- |
| Scenario lifecycle and event ordering audit | Done | M | `src/game_events/manager.cpp`, `src/game_events/event.cpp` | start, prestart, turn, moveto, sighted, attack, die, recruit, last breath, victory and defeat fire in the same order, including nested events and once flags. `src/simulation/event-lifecycle.ts` owns the sequence (`preload`, `unit_placed`, `prestart`, `start`, then per side `turn`/`new_turn`/`turn_refresh`/`side_turn_end` and once a round `turn_end`, plus `capture`, `petrified`, `pre_advance`/`advance`/`post_advance`, `enemies_defeated`, `time_over`), the loader classifies every WML spelling onto it, and `tests/event-order.test.ts` locks both the classification table and the fired order. Fixing it also repaired the dead turn conditions: `turn_number`/`turn_side` are published before each turn event, where before 1,419 compiled conditions were never satisfied |
| Complete WML filter algebra | Done | L | `src/filters/`, `src/game_events/` | `and`, `or`, `not`, `filter_wml`, `filter_location`, opponent/second-unit filters, ranges and variable-backed values pass fixture tests. `src/scenarios/wml-filter.ts` evaluates a filter tree against the live game with the engine's own semantics (comma-list membership and numeric ranges from `src/units/filter.cpp:329-620`, `[and]`/`[or]`/`[not]` folded in document order at `:263-276`, `[filter_wml]` as a config match, `[filter_location]` through the real terrain-code codec, `$vars` resolved before comparison), the loader encodes every event filter into one `predicate:wml_filter` node with the right subject (the trigger's unit, the mover for `moveto`, or any live unit for `turn`/`start`), and `tests/wml-filter.test.ts` locks each rule. Still open: `[filter_adjacent]`, `[filter_vision]`, `[filter_ability]`, `formula=` |
| WML expression and variable semantics | In progress | L | `src/formula/`, `src/variable.cpp` | `src/scenarios/wml-value.ts` ports Wesnoth's `vconfig::expand`/`do_interpolation` (`$name`, `$name|`, `$name?default|`, `$|`, nested `$(...)`, and the empty string for an unset variable or a formula that cannot be evaluated) and the WFL subset the campaigns use: `+ - * / % ^`, `..` concatenation, `~` ranges, `in`, element-wise `.+`/`.-`/`.*`/`./`, `d` dice, `where` bindings, comparisons, `and`/`or`/`not`, `min`/`max`/`floor`/`ceil`/`round`/`trunc`/`abs`/`sqrt`/`sum`/`if`/`length`/`size`, list literals and indexing; `[set_variable]` routes every present key (`value`, `formula`, `literal`, `to_variable`, `suffix`, `prefix`, `add`, `sub`, `multiply`, `divide`, `modulo`, `abs`, `root`, `power`, `round`, `min`, `max`, `string_length`) through the port instead of MWL's arithmetic guess. Still missing: maps (the hook scope carries no map values) and reference fixtures |
| Composite AI scheduler and target filters | Done | L | `src/ai/composite/`, `src/ai/default/` | recruitment, healing, combat, village, retreat and movement stages honor priorities, `[goal][criteria]`, keep-away maps and aspect overrides. `src/ai/candidates.ts` carries the engine's real candidate-action table and bands (read back from `data/core/macros/ai_candidate_actions.cfg` and `data/ai/ais/ai_default_rca.cfg` in `tests/ai-candidates.test.ts`), `planSide` classifies every decision into its candidate and emits them in band order, and a scenario's `[candidate_action]` ids, `max_score=` and `enable=no` reach the scheduler. Still open: `engine=lua` candidate actions, `spread_poison`, `castle_switch`, and target weighting beyond location criteria |
| Full rules edge-case matrix | In progress | L | `src/actions/`, `src/units/`, `src/attack_prediction.cpp` | poison, plague, drain, slow, petrify, berserk, firststrike, leadership, illumination, ambush, concealment, teleport, AMLA and death ordering match golden combats. `tests/rules-matrix.test.ts` holds the interactions (a petrifying hit ends the exchange mid-swing and the victim never retaliates, a plague unit is raised with no movement left in the turn that raised it, drain heals half the damage dealt while retaliation still hurts, feeding raises the killer's maximum hitpoints, a firststrike defender swings first, illumination lights its neighbours, a kill awards `1 + 8 * level` experience and an AMLA rounds its percentage like `utils::apply_modifier`, a mutual kill leaves nothing on the map). Poison, slow, swarm, charge, marksman, magical, steadfast, backstab and `[disable]` stay in `tests/specials.test.ts` and `tests/p1.test.ts`. Still open: an attack-prediction parity table against the engine's own numbers, and Lua-driven specials |
| Recruit, recall and leader lifecycle parity | Done | M | `src/actions/recruit.cpp`, `src/actions/recall.cpp`, `src/team.cpp` | castle ownership, leader replacement, recall costs, upkeep, income, limits, empty keeps and leader death match reference scenarios |
| Complete scenario metadata and campaign presentation | Next | M | `src/campaign_controller.cpp`, `src/storyscreen/`, `src/objectives.cpp` | campaign definitions, difficulty branches, objectives, story pages, music, portraits, victory/defeat and carryover are loaded from original files |
| Mainline campaign conversion at scale | In progress | XL | `data/campaigns/*/`, `src/campaign_type.hpp` | all 21 campaigns compile from their own files and each campaign has a headless start-to-finish smoke run; 20 compile today (Two Brothers, Heir to the Throne, Heir to the Throne Classic, South Guard, Liberty, Dusk of Dawn, Of Pearls and Pirates, Hammer of Thursagan, Dead Water, Descent Into Darkness, Sceptre of Fire, Northern Rebirth, Son of the Black-Eye, The Rise of Wesnoth, Winds of Fate, Secrets of the Ancients, The Deceivers' Gambit, Eastern Invasion, Under the Burning Suns, Legend of Wesmere), and each ships its own unit types, specials, abilities and traits; every unit placement in those campaigns resolves, including `type=$variable` runtime spawns; all 338 campaign scenarios start cleanly and each campaign's first scenario runs headlessly (`tests/campaign-smoke.test.ts`, no allowlist). World Conquest is an `[era]`/conquest mode with no `[campaign]` or `[scenario]`, so it is tracked with the MP-era row rather than here; the remaining work is the start-to-finish part, since the smoke run executes each scenario's setup body rather than a full mission |
| Multiplayer lobby and session lifecycle | Next | L | `src/game_initialization/`, `src/network/`, `src/server/` | players can create/join rooms, choose era/map/sides, ready up, reconnect, leave, observe and receive authoritative errors |
| Multiplayer protocol hardening | Next | M | `src/synced_checkup.cpp`, `src/synced_context.cpp`, `src/chat_events.cpp` | malformed messages, late input, timeout, reconnect, duplicate commands and version mismatch are rejected deterministically and surfaced in the UI |
| Full standard multiplayer rules | Next | XL | `data/multiplayer/`, `data/multiplayer/eras.cfg`, `data/multiplayer/factions/` | all 62 scenarios, random-map settings, both eras and every faction are playable with their own objectives, settings and opening rules |
| Persistence migrations and portable artifacts | Done | M | `src/savegame.cpp`, `src/save_index.cpp`, `src/replay/` | save/replay versions migrate or fail clearly, exports are downloadable, corrupt files are handled, and a saved action journal reproduces the final state. `src/simulation/save.ts` owns the payload, its validation and its migrations (version 1 has no seed/team list/recall list; a newer version is refused, not guessed), `exportSave`/`openSaveImport` read and write a tagged `.json` artifact, and `tests/save.test.ts` covers the round trip, the migration, eight classes of damaged file and the state hash of a restored save |
| Asset manifest, cache and loading observability | Done | M | `src/image.cpp`, `src/desktop/`, `src/audio/` | assets are hashed, lazy-loaded by scenario, released between scenarios, report load failures and remain functional in an offline `file://` build. `npm run data` writes `tests/asset-manifest.json` (6,185 files with size and SHA-256) and `tests/assets.test.ts` fails when the manifest drifts from disk, when the payload passes its 96MB budget, or when music (172MB, deliberately not inlined) appears in it. The scene releases its per-scenario texture caches on entry and records every asset it could not resolve, reported by `diagnostics()` and logged once per path |
| Audio and music pipeline | Done | M | `src/sound/`, `src/music/`, `data/core/sounds.cfg` | scenario music, ambient sounds, attack sounds, victory/defeat cues and volume preferences load from data without blocking the rules loop. `src/simulation/sounds.ts` resolves the game's own cues (an animation frame's `sound=`, `hit_sound=`/`die_sound=`, and `data/game_config.cfg`'s `[sounds]`/`[status]` tables, now parsed by the pipeline), `src/ui/audio.ts` feeds them to `mwg/audio` behind a gesture-unlocked, volume-aware surface, `[music]`/`[sound]` and a story part's `music=` compile to hooks, and preferences gain volume rows. Offline, 259 sound files are inlined and play; music is 172 MB and stays out of the bundle, playing when served beside the page. Positional `[sound_source]` ambience now uses listener-relative attenuation and repeat cadence; malformed sources remain harmless no-ops |
| Accessibility and input parity | Done | M | `src/gui/`, `src/hotkey/`, `src/preferences/` | keyboard-only play, focus order, readable contrast, reduced motion, scalable text, remappable hotkeys and touch controls pass a documented audit. The board is fully keyboard-drivable: arrows move a highlighted hex cursor, Enter selects, moves and attacks exactly as a click does, N cycles to the next unit with moves left, D describes the unit under the cursor, Escape deselects, and every menu is arrow/Enter driven. The defaults are Wesnoth's own (`data/core/hotkeys.cfg`): Space ends the selected unit's turn, Ctrl+Space ends the whole turn. Preferences add text size (100/125/150%), a high-contrast palette, a reduce-motion switch that follows the system setting until changed, volume, and the language; `applyWesnothTheme` rebuilds the framework theme from them and the motion switch shortens the scene's own animations. Hotkeys were already rebindable and input is pointer-based, so mouse, touch and keyboard all work. `tools/verify-browser.mjs` now dispatches real key events, drives the cursor and flips the accessibility preferences. Still open: a formal WCAG contrast audit of the port's own interface colours, and screen-reader text for the HUD (dialogue text already carries an accessible projection) |
| Browser compatibility and release validation | In progress | M | `src/desktop/`, `src/tests/`, project build scripts | Chrome, Firefox and a mobile viewport pass smoke tests; `file://`, hosted, offline and production builds have no console or network errors. `npm run verify` covers the `file://` build, `--serve` covers the hosted build over http (manifest and service worker live), and `--mobile` covers a 390x844 touch viewport; `npm run release` runs check, tests, build and all three passes, and each pass fails on any page error, failed request or console error. Still open: a Firefox pass (no driver is installed here) and a real offline reload after the service worker installs |
| Performance and memory regression suite | Done | M | `src/display.cpp`, `src/pathfind/`, `src/image.cpp` | large-map render, AI turn, pathfinding, scenario transition and asset memory budgets are measured in CI with thresholds and trend reports. `tools/perf-suite.ts` defines seven workloads over the real data and entry points (a 60x50 terrain build, 50 pathfinding floods, a full AI turn, 200 combat exchanges, every shipped scenario's runtime build, the largest scenario's entry, and the copied asset payload), `tools/perf-baseline.ts` records them in `tests/performance-baseline.json`, and `tests/performance.test.ts` fails at 2.5x the baseline plus fixed ceilings. `tools/verify-browser.mjs` adds the browser side: median and worst frame time for the real scene loop, the JS heap, texture and team-colour counts. Measuring it found and fixed a real cost: `updateVision` was re-flooding every unit's sight on every combat exchange (~84% of a fight's time), so sight sets are now cached per unit against a terrain revision, and the combat loop went from 2,136ms to 71ms per 200 exchanges |
| Licensing and source provenance audit | Later | S | `COPYING`, `data/`, `src/` | generated assets/data identify their source and license, notices ship with the build, and the MWG/Wesnoth license boundary remains clean |

---

## 4. Cross-cutting tracks

- **Determinism**: the port must be replayable. All game randomness flows
  through one seeded `mwg/core` `Generator` per scenario, injected as `Rng`
  into the pure simulation (which keeps `Math.random` defaults only so its
  layer never imports the framework). The seed still comes from the wall
  clock; persisting it with the generator state for identical replays is P9.
- **Performance**: batched rendering, typed data, no per-frame allocation in the
  rules loop. Measured, with a budget, in P10.
- **i18n**: every string from data stays a MWL message; the catalog route
  (`extractCatalog` → `mwg/i18n`) is already proven on the port's own content.
- **Provenance and licence**: `MW_games` stays MPL-2.0 and free of Wesnoth
  specifics; the port stays GPL-2.0-or-later with real art and cited rules.
- **Testing**: unit tests for rules, data-parity tests for content, headless
  browser runs for the whole game, and pixel checks for the render path.
- **Documentation**: `PORT_COVERAGE.md` grows with every commit; the deviation
  list is the contract with the original.

---

## 5. Non-goals and deliberate deferrals

These are choices, not omissions, and are revisited only if a real need appears.

- **Wesnoth's Lua VM.** 338 Lua files exist; embedding Lua would import a second
  language runtime and break the `file://` build's simplicity. Prefer MWL hooks
  and per-campaign rewrites, documented case by case.
- **Bit-for-bit savegame compatibility** with C++ Wesnoth. A native format is
  cheaper and honest; cross-loading saves is a separate, optional feature.
- **`wesnothd` wire-protocol compatibility.** The port's own protocol is enough
  for port-to-port play; interop is its own project.
- **UMC/add-on compatibility.** Mainline first; the add-on surface is enormous
  and version-dependent.
- **The map editor, achievements and statistics** are last, after the game runs.
- **xBRZ and other image upscaling** are cosmetic and can be dropped.

---

## 6. Definition of done (full portage)

The port is "full" when:

1. All 21 mainline campaigns are completable from their own `.cfg` files, or the
   remaining ones are documented with a reason.
2. All 62 multiplayer scenarios run, against the AI and over the network.
3. The default era's 328 unit types, 284 terrains and 38 movetypes behave as the
   original's, verified by the data-parity and rules tests.
4. Save, load, undo and replay work, and the same seed replays identically.
5. The render path matches the original's look: terrain transitions, animations,
   image modifiers, team colours, halos, minimap.
6. A translation catalog renders real strings, with plural forms.
7. The whole game still builds to one page that opens from `file://`.
8. `PORT_COVERAGE.md` has no "Not ported" row left that is reachable in mainline
   play, and every "Simplified" row is a documented, deliberate deviation.

---

## 7. The next six steps

Ordered for maximum playable progress per unit of work:

1. **P1 rules completeness** for one era's units (Loyalists vs Northerners):
   the full attack value engine plus 18 weapon specials and 19 abilities.
   Done, including vision, hides, teleport, diversion, feeding, plague and
   player-chosen AMLA.
2. **P2 content completeness**: all 328 unit types and 284 terrains loaded, with
   the data-parity test. Done, including eras, named schedules, `[time_area]`,
   items/`[object]` and the terrain-graphics transition inputs.
3. **P3 event engine + `[scenario]` loader**, then **Two Brothers** playable from
   its original files.
4. **P5 recruit and recall dialogs** plus the load/save menu, so a campaign can
   be played and resumed.
5. **P6 AI ladder** (rungs a-c), so the opponent stops being a stand-in.
6. **P4 terrain-graphics renderer and animations**, so the game looks right
   while the content work continues. Done, mostly: unit animations, the
   transition renderer, team-colour recolouring and font markup are ported
   (`src/simulation/terrain-codes.ts`, `terrain-graphics.ts`,
   `color-range.ts`, `src/ui/text-markup.ts`, plus their tests); xBRZ remains.
