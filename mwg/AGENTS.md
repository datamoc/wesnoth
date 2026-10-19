# Working in mwg-wesnoth

A genuine, block-by-block, honestly-documented TypeScript port of The Battle for
Wesnoth (GPL-2.0-or-later), built on the `mwg` game framework consumed as the
published npm package `@datamoc/mw_games` (aliased to `mwg` in `package.json`).
This directory (`mwg/`) lives inside a Wesnoth 1.19.27 source checkout for now;
the plan is to split it into its own repository the way `mwg-pixel-dungeon` was
split out of its original checkout. Treat these as durable project rules.

## Licensing boundary, do not blur this

- `mwg`/`@datamoc/mw_games` is a separate, generic, MPL-2.0 project maintained
  outside this checkout. No Wesnoth code, data, or assets may ever enter it.
  If the port needs a new generic capability, that capability stays
  game-agnostic in the framework's own repo.
- This port is GPL-2.0-or-later, matching Wesnoth. It legitimately reuses:
  - Wesnoth's real C++ source values and formulas, translated into TypeScript
    (never copied verbatim as C++ text), each cited with the source file and
    line range in a code comment.
  - Wesnoth's real data files (`data/core/*.cfg`) and real art assets, copied
    byte-for-byte by `tools/compile-wesnoth-data.ts` into `src/assets/wesnoth/`
    with provenance notes. See the tool's header comment.

## Documenting deviations, mandatory, not optional

Every simplification or deviation from the real C++ behaviour must be
documented in both:

1. A code comment at the point of deviation, explaining what the real engine
   does and why this port differs.
2. A row in `PORT_COVERAGE.md`, added or updated in the same commit as the code
   change: "Ported" (reproduces the real numbers/logic), "Simplified"
   (reproduces the shape with a stated reduction), or "Not ported" (Wesnoth has
   it, this port does not, at all).

Never silently drop a piece of real behaviour without a corresponding
"Not ported" line.

## Commands

```
npm run data     # compile real Wesnoth core data + copy art into src/generated, src/assets
npm run dev      # vite dev server
npm run check    # tsc --noEmit
npm test         # node --test "tests/**/*.test.ts"
npm run build    # tsc --noEmit && vite build && node tools/emit.mjs
npm run verify   # headless Chrome run of dist/index.html (needs npm run build first)
npm run verify:all -- --bot --turns 25   # every scenario (campaigns and multiplayer maps) in one headless Chrome session, the AI planner playing both sides; exits non-zero on any page error, empty map or hang
```

## Autoplay (Simulation Automatique)

Pour tester les campagnes et scénarios sans intervention humaine :

1. **Activer l'autoplay via l'URL** :
   - Ajoutez `#autoplay` à l'URL du jeu (ex: `http://localhost:5173/#freelands#autoplay`).
   - Le jeu simulera automatiquement les tours et passera les dialogues.
   - **Fonctionne uniquement dans un navigateur** (pas en mode headless avec Playwright).

2. **Tester manuellement** :
   - Lancez le serveur de développement :
     ```bash
     npm run dev
     ```
   - Ouvrez `http://localhost:5173/#freelands#autoplay` dans un navigateur.
   - Vérifiez que les tours sont simulés automatiquement.

3. **Limitations** :
   - En mode headless (Playwright), le jeu est gelé et les événements clavier ne sont pas déclenchés.
   - La commande `npm run verify -- --autoplay` vérifie uniquement que le jeu se charge sans erreurs.

> ⚠️ **Note** : L'autoplay force la fin des tours même pour les côtés contrôlés par un humain. Utilisez-le uniquement pour les tests.

`npm run data` reads `../data/core` relative to this directory and must be
re-run after any change to the data pipeline, and after pulling a newer Wesnoth
checkout. The generated files are deliberately not committed; `src/generated/`
and `src/assets/wesnoth/` are ignored.

`npm run verify -- --scenario <id> [--screenshot file]` is the browser gate the
roadmap asks for: it loads `dist/index.html` from `file://`, forces a few frames
(headless Chrome throttles `requestAnimationFrame`, so the scene's own update
loop will not run on its own), and exits non-zero if the scenario does not load,
the terrain layers are empty, no team-colour mapping was built, or any page
error was logged. Keep it working when touching the scene.

## Architecture

- `src/simulation/` is pure game logic with no Pixi dependency and no node
  imports (except `wml.ts`, which is build-time tooling the browser bundle never
  imports). It runs under `node --test` directly.
  - `wml.ts`: the WML preprocessor/parser subset (see PORT_COVERAGE.md).
  - `types.ts`: compiled-data shapes.
  - `terrain.ts`: map code to terrain id, alias chains, movement/defense/heals.
  - `unit.ts`: unit instances and trait `[effect]` application.
  - `combat.ts`: CTH, damage, resistance, ToD bonus, strike exchange.
  - `movement.ts`: reachable cells, ZoC, village capture, teleport.
  - `vision.ts`: per-unit sight walks and `[hides]` abilities (per-side
    visible/explored storage is the framework's `FactionFog` in `game.ts`).
  - `objects.ts`: `[item]`/`[object]` parsing and application.
  - `terrain-graphics.ts`: terrain-graphics transition inputs (model only).
  - `animation.ts`: unit-animation frame model (frame-spec parsing, per-frame
    durations, frame-at-time); pure, so the pipeline and the scene share it.
  - `game.ts`: state, economy, healing, recruit, attack-with-rules.
- `src/scripting/` runs the real Wesnoth Lua. `lua-vm.ts` is the port's own pyroeis state (the
  framework's integration host omits debug/load needed by the real loader); `wesnoth-prelude.ts` and `game-prelude.ts` are the
  engine's C++ builtins re-implemented in Lua (template literals: no dollar-brace, no backticks);
  `game-host.ts` is the TypeScript side of `wesnoth.units`/`sides`/`map` over `GameState`;
  `kernel.ts` boots a `mapgen` or `game` kernel on the real `data/lua/core`;
  `world-conquest.ts` drives World Conquest II (generate a map in the mapgen kernel, start the
  game kernel on the scene's state, fire events, answer dialogs). `src/main.ts` has a World
  Conquest block (`luaGame`, `luaEvent`, `pumpLua`) that feeds the engine's event names to it.
  `tools/compile-lua.ts` bundles the Lua and World Conquest's WML into `src/generated`.
- `src/ai/` is the side planner, also pure and node-testable: `plan.ts` scores
  candidate positions and attacks with the engine's `predictAttack` and a threat
  map, `policy.ts` turns a difficulty and `[ai]` aspects into the planner's
  weights. `main.ts aiTurn` only executes the returned actions through the same
  `moveUnit`/`attackWithRules`/`placeRecruit` calls a human uses.
- `src/generated/` is the output of `npm run data`: `game-data.ts` (the parsed
  real data, typed as `WesnothData`), `assets.ts` (explicit imports of every
  copied PNG, so vite inlines them as base64 data URIs), `terrain-art.ts` (the
  representative base/overlay art tables, the fallback for a hex no transition
  rule matched), `terrain-transitions.ts` (the 4,077 real
  `[terrain_graphics]` rules, emitted as JSON and consumed by
  `buildTerrainTiles`), `team-colors.ts` (the real `[color_range]`/`[color_palette]`
  tables from `team-colors.cfg`, consumed by `color-range.ts`), `scenarios.ts`
  (every compiled MWL scenario, its campaign order and titles), and `campaigns.ts`
  (the compiled `[campaign]` definitions, from `tools/compile-campaign.ts`).
- `src/simulation/terrain-codes.ts` and `terrain-graphics.ts` are the
  terrain-graphics transition engine (P4.4). Keep the codec/matching in
  `terrain-codes.ts` and the rule build in `terrain-graphics.ts`; the scene only
  calls `buildTerrainTiles` and draws the returned background/foreground lists.
- `src/main.ts` is the Pixi scene: board rendering, input, the AI execution loop,
  and the HUD. It is driven by `MwlRuntime` over `src/generated/scenarios.ts`:
  the runtime owns sides, gold, the starting units, the start message, and the
  victory/defeat objectives. `src/simulation` still owns terrain rules,
  pathfinding, combat, and experience; the scene syncs those results into the
  runtime world and calls `MwlRuntime.evaluate()`. It imports `mwg`, `mwg/mwl`,
  and the simulation modules. `src/campaign.ts` holds the campaign order and the
  carry-over rules (a share of the gold and the surviving units), and `main.ts`
  draws the victory and defeat screens that use them. The board is batched: a
  static terrain layer, one merged overlay `Graphics`, persistent per-unit views
  advanced by `UNIT_ANIMATIONS` (`src/generated/unit-animations.ts`), and a single
  pointer hit area. `src/ui/menus.ts` is the only UI factory layer: it wraps
  `mwg/two-d/ui` (`WindowStack`, `Window`, `Button`, `ListView`, `RebindScreen`,
  `HelpScreen`) with the port's Wesnoth theme, and `main.ts` builds the main menu,
  pause menu, scenario picker, save/load, objectives, help and preferences from
  it. Keep new widgets in `src/ui/`, not hand-drawn in `main.ts`.
- Rendering asset rule: load textures with
  `Assets.load({ src, parser: 'loadTextures' })`. Pixi 8's `Texture.from(url)`
  only reads Pixi's own cache and never loads anything, so on an unloaded URL it
  yields no texture; `Sprite` then falls back to an empty texture silently, with
  no console error. This once made every sprite in the built page invisible
  while the HUD and `Graphics` hexes kept drawing.
- Terrain art rule: `rebuildTerrain` builds the real transition layers for the
  scenario map (`buildTerrainTiles`) and draws each returned image at its native
  size over a 72px source hex, foreground images above the unit layer. A hex no
  rule matched falls back to `addTerrainCell`, which draws the base tile from
  `TERRAIN_PATH` then the overlay art from `OVERLAY_PATH`. Wesnoth art is not all
  hex tiles: `mountains/basic.png` is a 180x216, 87% transparent sprite and must
  be drawn over a ground tile (`OVERLAY_ONLY`/`GROUND_FOR`), or it becomes a peak
  floating on black. Check a new image's size and alpha before using it as a base.
- `src/scenarios/*.mwl` are the scenarios. `freelands.mwl` is the skirmish;
  `courier.mwl` is the smallest scripted scenario. `tools/compile-scenario.ts`
  resolves each `[map] file=`, embeds the real map rows, compiles through
  `mwg/mwl`, and writes `src/generated/scenarios.ts` (`SCENARIOS`,
  `SCENARIO_ORDER`, `SCENARIO_TITLES`, `DEFAULT_SCENARIO`). Select one with the
  `#name` URL hash, the Scenarios menu, or `N` in the scene.
- `tools/compile-campaign.ts` compiles `data/campaigns/<name>/_main.cfg` into
  `src/generated/campaigns.ts` (`CAMPAIGNS`, `DEFAULT_CAMPAIGN`): the campaign's
  own id, title, difficulties and `next_scenario` chain. `src/campaign.ts` holds
  the `CampaignDefinition`/`Carryover` types and the carry-over rules; the scene
  plays the campaign's order and recalls survivors with `makeUnitWithTraits`, so
  their traits are not re-rolled.
- `src/scenarios/engine-hooks.ts` is the engine-hook boundary: the scenario says
  when, `src/simulation` says how. `command:attack`/`move`/`recruit`/
  `rest_heal`/`teleport` call `attackWithRules`, `moveUnit`, `recruit`,
  `restHealSide`, and `teleportUnit`; `command:kill_unit` removes whatever WML
  `[kill]` selects and is a no-op when nothing matches;
  `predicate:side_owns_villages`/`alive_units`/`turn_limit` read the rule-engine
  state and the scenario variables. Keep new scenario hooks here, not in
  `main.ts`.
- `src/adapters/from-mwl.ts` is the only Wesnoth-aware translation layer. It
  converts parsed Wesnoth nodes into MWL nodes, compiles them through
  `mwg/mwl` (`compileNodes`, validated against the framework schema), and reads
  the compiled game back into `WesnothData`, `MapData`, and `GameState`.
- `tools/compile-wesnoth-data.ts` is the data pipeline. It reads Wesnoth files
  with the shared `WmlPreprocessor`, hands them to the adapter, and emits the
  generated data and assets. It contains no Wesnoth type extraction any more.
  It compiles the default schedule plus the named variants (`summer`,
  `winter`, `indoors`, `underground`, `deep_underground`) and both eras
  (`era_default`, `era_heroes`) with their factions.

## MWL and the framework dependency

MWL (Modular World Language) is the framework's declarative authoring layer.
The framework owns the grammar, schema, compiler, and runtime; this port owns
only the Wesnoth adapter. Never put a Wesnoth type, tag name, or data table
into `MW_games`.

This port depends on the **published** package `@datamoc/mw_games`, aliased to
`mwg` in `package.json`:

```
"mwg": "npm:@datamoc/mw_games@^0.36.0"
```

`npm install` is all that is needed; there is no local checkout dependency.
Verified 2026-10-12 on 0.36.0 (with `@datamoc/pyroeis` ^0.6.0) with `check`, 361 tests and `build` green. To try
unreleased framework work, temporarily point the alias at a local checkout
(`"mwg": "file:../MW_games"`, after `npm run build:pkg` there), and switch back
before committing.

Since 0.31, the framework's `LockstepClient` rejects `ws:`/`http:` URLs unless
`allowInsecure` is set; `WesnothNetworkSession` only allows plain `ws:` for
localhost, and tests use `wss://`.

Only adopt a framework implementation when it is faithful to Wesnoth; where it
is a generic approximation, keep the port's code and record the overlap in
`PORT_COVERAGE.md`. The current split: `UndoHistory`, `applyImageModifiers`
(except `~CHAN`/`~BLEND`/`~ROTATE`, which `mwgSpritePath` filters out), and the
`parseMarkup`/`layoutMarkupLines`/`markupAccessibilityText` contract are
adopted; `terrain-graphics.ts`, `color-range.ts` and `parsePo` stay because
MWG's versions differ semantically.

With a local checkout the port imports the framework's **built `dist`**, so an edit is not
visible here until you run `npm run build:pkg` in `MW_games`. A stale dist fails
in confusing ways: an older asset collector rejected a valid image-modifier value
and `npm run data` died with `missing real asset: 50)`.

## Converting `.cfg` to `.mwl`

`tools/wesnoth-to-mwl.ts` is the CLI, and the rules live in
`src/adapters/wesnoth-to-mwl.ts` so they are testable:

```
npm run convert -- ../data/core/terrain.cfg --slice --report
npm run convert -- ../data/multiplayer/scenarios/2p_Hamlets.cfg --out /tmp/hamlets.mwl
```

`--all` (default) is the generic structural conversion: tags, attributes,
nesting and `_ "..."` gettext markers are preserved, so the result parses back to
the same tree. `--slice` runs the typed conversions (`terrain_type`, `movetype`,
`trait`, `unit_type`), flattens them to roots, and reports the tags it skipped.
`--macros a.cfg,b.cfg` loads macro definitions first; without them the
preprocessor expands unknown macros to nothing.

`tests/cfg-to-mwl.test.ts` locks both halves: a generic round trip on a real
scenario, and `terrain.cfg`/unit files that re-compile to the same `WesnothData`
as the direct in-memory route.

## The file:// constraint

Same rule as mwg and mwg-pixel-dungeon: the built page must run by
double-clicking `dist/index.html`. `vite.config.ts` emits one IIFE (`game.js`)
and inlines every PNG (`assetsInlineLimit: Number.MAX_SAFE_INTEGER`), and
`tools/emit.mjs` rewrites the entry tag from `type="module"` to `defer`.
Never regress this for convenience.

That makes the built `game.js` about **131 MB** (75 MB gzipped, measured
2026-10-12), because `npm run data` copies and inlines every asset the Wesnoth
data references: 35 MB of unit portraits across the 20 compiled campaigns,
11 MB of terrain art, 8 MB of unit art, 11 MB of sound effects, and the parsed
data itself (38 MB under `src/generated`). Nothing renders portraits or plays
sounds yet, so most of the weight is unused for now; that is accepted (this is a
game payload, not a web page) and it still opens from disk: `npm run verify`
loads `dist/index.html` from `file://` and reaches a playable scene. (The
earlier 44 MB / 0.6 s figures in this file were measured before the campaign
work added the portraits.) If a trim is ever wanted,
the lever is `collectAssets` in `tools/compile-wesnoth-data.ts`.

## Verification before reporting done

1. `npm run check` must be clean.
2. `npm test` must pass.
3. `npm run build` must be clean.
4. Browser verification: serve `dist/` on port 8000 and load it. Windows
   reserves dynamic-port-exclusion ranges that silently refuse binds
   (`WinError 10013`); run `netsh interface ipv4 show excludedportrange
   protocol=tcp` and pick a port outside every listed range before concluding
   serving is broken. Also check `netstat -ano | grep :<port>` for stale
   servers from earlier sessions serving a different directory, which has
   already burned one verification pass here.
   Same story for the Chrome profile the verify tools use: a browser left
   behind by a killed run keeps `.verify-chrome-profile*` locked, and a new
   Chrome will not open a locked profile. `tools/chrome-profile.mjs` now retries
   the delete and falls back to a per-process directory, so the fix is automatic;
   a stale `chrome.exe` from an earlier session still has to be killed by hand
   (`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` filtered on the
   profile path, then `Stop-Process`).
5. Screenshot and inspect the actual pixels, not just absence of errors.
   `window.__WESNOTH__` exposes `{ scene, state, data }` for fast inspection,
   the same way mwg-pixel-dungeon exposes its scene state.

## Conventions

- Relative imports carry an explicit `.ts` extension; Node's type-stripping
  test runner needs it.
- No em dash in prose. Use a comma, colon, parentheses, or a new sentence.
- Tests use Node's built-in runner over `.ts` directly; no test framework.
- Generated files are written only by `npm run data`; never edit them by hand.

## Reference material

- Real C++ source lives in `../src` relative to this directory. Values and
  formulas are cited by file and line range, e.g.
  `src/actions/attack.cpp:169-210` for the combat statistics block.
- Real data lives in `../data/core`. The pipeline reads `terrain.cfg`,
  `units.cfg` (with its unit includes), seven macro files (including
  `multiplayer.cfg` for the era factions), `../data/multiplayer/eras.cfg`,
  and one chosen multiplayer map.
