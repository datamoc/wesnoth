# mwg-wesnoth

A genuine, block-by-block TypeScript port of [The Battle for
Wesnoth](https://www.wesnoth.org/) (GPL-2.0-or-later), built on the
[`mwg`](https://www.npmjs.com/package/@datamoc/mw_games) game framework and
running entirely client-side in the browser.

The plan for a full port, measured against the original engine and data, is in
`ROADMAP.md`; `PORT_COVERAGE.md` tracks what each block currently is.

This is an independent, unofficial port, not affiliated with or endorsed by
the Wesnoth project. The port is GPL-2.0-or-later, matching the game it ports;
`mwg` remains a separate MPL-2.0 framework and contains none of Wesnoth's
code, data, or assets.

## Status

In progress, not yet feature-complete. Every deviation from the real C++
behaviour is tracked in [`PORT_COVERAGE.md`](./PORT_COVERAGE.md), and
outstanding work is tracked in [`ROADMAP.md`](./ROADMAP.md). Broadly:

- Real Wesnoth core data is compiled at build time by
  `tools/compile-wesnoth-data.ts` through the framework's MWL layer and the
  port's `src/adapters/from-mwl.ts`: 284 terrain types, 38 movement types, the
  four common traits, 328 unit types (including the Spearman with its real
  7-3 pierce melee and 6-1 javelin), the DEFAULT_SCHEDULE time-of-day table,
  and the 2p The Freelands map. The MWL route reproduces the earlier output
  byte for byte.
- Real unit and terrain PNGs are copied byte-for-byte into `src/assets/` and
  inlined into the built page, which makes `dist/game.js` about 67 MB: 27 MB of
  unit portraits, the unit animation frames the scene draws, 5 MB of sound
  effects, the terrain-transition art the shipped maps use, and the compiled
  transition rules. It is a game payload, not a web page, and it opens from disk
  in about a second. Terrain now renders through the real terrain-graphics
  transition engine: `tools/compile-wesnoth-data.ts` compiles the 30
  `data/core/terrain-graphics/` rule files (4,077 rules) into
  `src/generated/terrain-transitions.ts`, and `src/simulation/terrain-codes.ts`
  plus `terrain-graphics.ts` reproduce `translation.cpp`'s codec/wildcard
  matching and `builder.cpp`'s builder-map walk, rotations, flags, per-hex noise
  and variant selection. Hexes blend at forest/castle/village/mountain edges
  instead of each drawing one representative tile. The pipeline copies only the
  transition art the shipped maps can draw (529 images, 5.6 MB) and prunes
  variations whose files are absent, the way `load_images` does.
- Units animate from the real data: `tools/compile-wesnoth-data.ts` loads the
  engine's animation macros, compiles `[standing_anim]`/`[idle_anim]`/
  `[movement_anim]`/`[attack_anim]`/`[death]` frames for 323 unit types into
  `src/generated/unit-animations.ts`, and the scene loops idle, walks along the
  move path, and plays attacks and deaths once. Per-side fog and shroud render as
  dimmed and opaque hexes, and combat damage, healing and poisoned/slowed/
  petrified status icons appear over units. The board is drawn in batched layers
  (one terrain layer, one merged overlay, persistent unit sprites, one pointer hit
  area), not a container per cell.
- Units are team-coloured by the real palette swap: `src/simulation/color-range.ts`
  transliterates `recolor_palette` from `src/color_range.cpp`, the compiled
  `data/core/team-colors.cfg` ranges and palettes drive it, and each side's
  textures have their magenta pixels mapped onto that side's shade (cached per
  texture and side) instead of a flat tint. Dialogue resolves `$variables` and
  Wesnoth markup (`<b>`, `<i>`, colour spans) through `src/ui/text-markup.ts` on
  MWG's markup contract, wrapping with `layoutMarkupLines` after styling.
- Move, attack and recruit can be undone and redone: MWG's `UndoHistory` keeps
  the last 32 snapshots and the port restores the runtime world, units, gold, RNG
  state and action journal from one, so `U`/Undo and `Y`/Redo (or the pause menu)
  step through the game's own state rather than replaying commands.
- Movement, zone of control, village capture, terrain defense, resistances,
  lawful/chaotic time-of-day damage, magical/marksman/firststrike specials,
  retaliation, combat and kill XP, upkeep, income, and village/rest healing are
  ported against their real C++ formulas. Traits are assigned per race and unit
  type, and abilities, advancement with a player-chosen AMLA, and attack
  prediction are in.
- The UI is a framework `WindowStack` (`mwg/two-d/ui`) themed by
  `src/ui/menus.ts`: a start screen, an Escape pause menu, a scenario picker,
  multi-slot save/load with delete and an autosave, an objectives dialog, a help
  screen and a rebinding preferences screen. Recruit and Recall are one list
  dialog with the real costs, and the board accepts mouse or touch.
- The opposing side is a real planner (`src/ai/`), not a script: it scores every
  reachable position and adjacent target with the engine's own `predictAttack`
  (so CTH, resistances, leadership, time of day and retaliation are the real
  rules), projects a per-hex threat map from the units it can see, values
  villages and healing, refuses trades that cannot kill, and spends real gold on
  the side's `recruit=` list. A campaign difficulty (and the scenarios'
  `[ai] aggression=/caution=` aspects) shifts its aggression, caution, greed,
  recruit limit and gold.
- The scenarios themselves are MWL, compiled into the build by
  `tools/compile-scenario.ts` and played by `src/main.ts` through `MwlRuntime`,
  so the browser scene is not a hard-coded setup. Seven exist: `freelands`,
  `courier`, and the five `two-brothers-01..05` slices. `freelands.mwl` is the
  skirmish on the real 2p_The_Freelands map; `courier.mwl` is the smallest
  scripted scenario, carrying a dispatch to the elven village within 4 rounds.
  Pick one with the `#name` URL hash, the `N` key, or the in-game Scenarios menu;
  without a hash the page opens on the main menu.
- The two-brothers slices are a real campaign: `tools/compile-campaign.ts`
  compiles `data/campaigns/Two_Brothers/_main.cfg` into
  `src/generated/campaigns.ts` (title, abbreviation, description, the
  `[difficulty]` list and the `next_scenario` chain), and New campaign picks the
  campaign and difficulty. Carried-over survivors recall with their hitpoints,
  experience, traits and loyalty intact, and `[endlevel] bonus=yes` pays the
  turns you did not need.
- Scenario events and objectives call the real rules through engine hooks
  (`src/scenarios/engine-hooks.ts`): `command:attack`/`move`/`recruit`/
  `rest_heal` and the `predicate:side_owns_villages`/`alive_units` objectives.
  For example, `on=turn` fires `command:rest_heal` for side 2 with the port's
  real rest + village healing, and a second victory condition is "side 1 holds
  three villages", evaluated directly against the rule engine.

## Running

```
npm install
npm run data     # only needed after pulling a newer Wesnoth checkout
npm run build    # then open dist/index.html directly, no server needed
```

For development: `npm run dev`, then open the address vite prints.

`npm test` runs the node test suite (data parity, the rules engine, the combat
and AI models, the terrain-transition builder and the team-colour recolouring).
`npm run check` is the strict TypeScript pass. After a build, `npm run verify`
boots the single-file page in headless Chrome, drives a few frames, steps an
undo/redo cycle, and fails if a scenario does not load, the terrain layers are
empty, no team-colour mapping was built, the undo cursor does not move or the
page logged an error:

```
npm run verify -- --scenario freelands --screenshot verify.png
```

To read Wesnoth data as MWL, convert a file and print what survives:

```
npm run convert -- ../data/core/terrain.cfg --slice --report
npm run convert -- ../data/multiplayer/scenarios/2p_Hamlets.cfg --out /tmp/hamlets.mwl
```

`--all` keeps every tag, attribute and `_ "..."` marker; `--slice` keeps what the
port consumes and reports the rest. See `AGENTS.md` for the details.

## Campaign

Two Brothers is a real campaign: `tools/compile-campaign.ts` reads
`data/campaigns/Two_Brothers/_main.cfg`, so the campaign's own files give the
title, the difficulties and the scenario order (`two-brothers-01` through
`05_Epilogue`). New campaign on the start screen picks the campaign and then a
difficulty; the difficulty drives the enemy AI and its gold. The free-play
scenarios `courier` and `freelands` remain in `SCENARIO_ORDER`. Winning a
scenario starts the next in the campaign order with what survived:

- every surviving unit of side 1 is added to the recall list; open the Recruit /
  Recall list by clicking your keep, pay 20 gold for a survivor, and it appears on
  your keep with its wounds, experience, traits and loyalty intact;
- a share of your treasury carries over (40%, Wesnoth's `[endlevel]` default),
  plus the early-finish bonus when the scenario declares one.

The victory and defeat screens say what carried and what to press. A defeat
takes nothing forward: R retries the scenario from its own start. S autosaves and
the pause menu's Save / Load lists named slots.

## Controls

- Click one of your units (gold marker), then a highlighted hex to move, or an
  adjacent enemy unit to attack with the unit's strongest attack.
- Click an empty hex or another of your units to change selection.
- Click your keep to open the Recruit / Recall list (only in scenarios that
  declare a `recruit` list).
- A golden ring marks a `unit_at` objective hex: move the required unit there.
- Space, Enter or a click advances a dialogue box (the box owns the input while it is open).
- Space or Enter ends your turn; the AI side moves immediately.
- Escape or M opens the pause menu (Resume, Scenarios, Save, Load, Objectives,
  Preferences, Help, Quit to main menu).
- O opens the objectives, O again or Escape closes it.
- R restarts the current scenario; N switches to the next one; S autosaves.
- Every control can be rebound in Preferences, and the bindings persist.

## Provenance

The port uses MWG 0.36.0 and `@datamoc/pyroeis` 0.6.0. Pyroeis is the Lua 5.4.6
VM the port used to take as `@datamoc/fengari`, renamed by its maintainer and
followed by the framework, so the port's own Wesnoth bridge and MWG's optional
Lua host are one installed package. Its browser package
replaces the earlier local `os.platform()` shim and Vite alias. World Conquest runs its
real Lua through the Wesnoth bridge, with per-operation execution budgets and
an indexed bundled filesystem. The generic MWG integration host excludes
`debug`, `os` and `load`, which the real loader still requires.

`npm run lua:translate` exports the World Conquest scripts as JavaScript review
candidates to `.lua-translated/`, with source hashes, warnings, exports and
required globals in `report.json`. To translate another campaign, run
`npm run lua:translate -- ../data/campaigns/<name>/lua --out <directory>`.
The output is GPL-2.0-or-later and never loaded by the game. Even output without
warnings needs semantic review and Lua/JavaScript parity tests before adoption.
Pyroeis 0.6 preserves Lua truth semantics for translated `or` expressions;
mixed WML tables, module returns and dynamic indices still need review.

The data pipeline reads the surrounding Wesnoth 1.19.27 checkout (`../data` and
`../src` relative to this directory). Terrain, unit, trait, and schedule
definitions come from `data/core/terrain.cfg`, `data/core/units.cfg` and its
included unit files, and `data/core/macros/`. Art comes from
`data/core/images/`. No generated file is edited by hand; see `AGENTS.md` for
the rules this port is built under.
