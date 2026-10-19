# Fidelity and deviation policy

ROADMAP P0 asks each subsystem for three things: an explicit **exactness
target**, the simplifications it accepts, and a **parity test** (or a stated
reason there is none). This file is that contract. `PORT_COVERAGE.md` remains
the ledger of individual features; a row here that says "exact" is a claim the
named test defends, and a row that says "shape" is a deliberate reduction that
must also appear in the ledger.

Exactness targets, strongest first:

- **exact**: bit-identical values or an identical decision to the engine on the
  same inputs, table included.
- **numeric**: the same formula and constants, verified against engine numbers,
  with individually listed reductions.
- **shape**: the same structure and ordering, with a smaller model inside.
- **presentation**: the same read on screen, not the same pixels.
- **absent**: the engine has it, this port does not.

| Subsystem | Target | Parity evidence | Accepted deviations |
| --- | --- | --- | --- |
| Data pipeline (2,598 `.cfg`, 673 unit types, 284 terrains, 38 movetypes, 24 races, 18 traits, 17 specials, 20 abilities, 21 eras/factions sets) | exact | `tests/p2.test.ts`, `tests/from-mwl.test.ts`, `tests/cfg-to-mwl.test.ts` compare the compiled tables against the real files, including a byte-identical check of the pre-MWL route | 184 campaign art files are absent from the checkout (`tests/campaign-units.test.ts`) |
| Terrain resolution, aliases, `default_base`, overlays, heals, income | numeric | `tests/simulation.test.ts`, `tests/p2.test.ts` | `vision_costs`/`jamming_costs` are not read; `default_base` merging inside the engine is not reproduced |
| Movement, ZoC, villages, teleport, hidden-unit discovery | numeric | `tests/simulation.test.ts`, `tests/p1.test.ts` | Teleport costs one move rather than the real path cost |
| Combat: CTH, damage, resistance, ToD, leadership, illumination, flanking, drain, plague, berserk, firststrike, swarm, charge, steadfast, slow, poison, petrify | numeric | `tests/specials.test.ts`, `tests/golden.test.ts` (seeded exchange with a recorded state hash), `tests/p1.test.ts` | `[chance_to_hit]`/`[damage]` WML value engines only cover mainline specials by id; `max_liminal_bonus` is 0; retaliation picks the best `number*damage` weapon instead of simulating the choice |
| Traits, advancement, AMLA | numeric | `tests/p1.test.ts` | The scene auto-takes the first advancement; AMLA `max_times` is not enforced |
| Vision, fog, shroud, hidden units (`hides`) | numeric | `tests/vision.test.ts` | Jamming is zero; shared vision only between sides of one declared team |
| Economy: income, upkeep, loyal, villages, difficulty bonuses | numeric | `tests/p1.test.ts`, `tests/leader.test.ts` | Per-difficulty WML (`#ifdef EASY`) is not preprocessed per difficulty |
| Time of day, schedules, `[time_area]` | exact | `tests/p2.test.ts` | None |
| WML preprocessor and parser | numeric | `tests/wml.test.ts` (37 cases), `tests/cfg-to-mwl.test.ts` | Unknown macros expand to nothing; unmatched `[+tag]` insertions are skipped |
| WML value and variable semantics (`$var`, `$(formula)`, WFL subset) | numeric | `tests/wml-value.test.ts`, `tests/expression.test.ts` | Maps are not carried in the hook scope; no reference fixtures from the C++ evaluator yet |
| Event lifecycle and ordering | exact | `tests/event-order.test.ts` (classification table plus the fired order) | The advancement trio fires after the rules layer applied the new type; `turn_refresh` runs before the port's end-of-side healing and income |
| WML filters | numeric | `tests/wml-filter.test.ts` | `[filter_adjacent]`, `[filter_vision]`, `[filter_ability]`, `formula=` and `lua_function=` are not ported |
| Scenario, campaign and difficulty loading | numeric | `tests/campaign-loader.test.ts`, `tests/campaign.test.ts`, `tests/p7.test.ts`, `tests/campaign-smoke.test.ts` (all 398 scenarios), `tests/compatibility.test.ts` (the compatibility gate) | Lua blocks are skipped (85 of them, all reported); `[story]` art and campaign intro/outro art are not ported |
| Rules state, save, reload, undo, redo, replay | exact for the port's own format | `tests/replay.test.ts`, `tests/sync.test.ts`, `tests/network.test.ts`, `tools/verify-browser.mjs` drives an undo/redo cycle in the real page | Save compatibility with the C++ `.gz` format is a documented non-goal; whiteboard undo is not ported |
| Determinism | exact | `tests/golden.test.ts` runs the same seed twice and compares a state hash | The seed starts from the wall clock; persisting it with the generator state is P9 |
| Rendering: terrain transitions | presentation | `tests/terrain-graphics.test.ts`, browser screenshots via `tools/verify-browser.mjs` | `[image] base=` is not applied as a pixel offset; `center=` is a whole-image offset, not a hex crop; terrain animations draw their first frame |
| Rendering: animations, halos, floating labels, minimap, team colours | presentation | `tests/animation.test.ts`, `tests/color-range.test.ts`, `tests/image-modifiers.test.ts` | South-east facing and the hit branch only; a side uses the `default=yes` colour range; `~RC` is a deterministic tint, not a palette swap |
| Text markup and i18n | presentation | `tests/text-markup.test.ts`, `tests/i18n.test.ts` | Pixi v8 has no underline; one shipped catalog (French) with 2/3-form plurals |
| UI: menus, dialogs, hotkeys, objectives, help | presentation | `tools/verify-browser.mjs` | The GUI2 data-driven widget layer is not parsed; the port rebuilds on framework widgets |
| AI | shape | `tests/ai.test.ts`, `tests/ai-candidates.test.ts` (bands read back from the engine's own files) | Decisions are ranked by the candidate's band rather than by dynamically scored candidates; Lua AI is absent |
| Multiplayer | shape | `tests/network.test.ts`, `tests/server.test.ts`, `tests/sync.test.ts` | The port's own protocol, not `wesnothd`'s wire format; no lobby screen |
| Audio and music | absent | None | 259 sound files are collected by the pipeline but nothing plays them |
| Map editor, add-ons | absent | None | Deliberate deferrals (ROADMAP section 5) |

## How a deviation is recorded

1. A comment at the point of deviation naming what the engine does and why the
   port differs.
2. A row in `PORT_COVERAGE.md`, updated in the same commit as the code.
3. A line in this file when the deviation is a subsystem's standing reduction
   rather than one feature's.

## What is not a deviation

Values and formulas transliterated from the C++ with the source file and line
range in a comment, real data files and art copied byte-for-byte with
provenance notes, and frameworks mechanisms (`mwg/core`, `mwg/mwl`) the port
consumes instead of reimplementing are the port's own code, not deviations from
it.
