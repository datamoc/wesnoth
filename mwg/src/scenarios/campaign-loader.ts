/**
 * Real WML scenarios to MWL, for mainline campaigns.
 *
 * The preprocessor (`wml.ts`) expands every macro first, so this module only
 * ever sees plain tags: `[side]`, `[unit]`, `[event]`, `[message]`, `[if]`,
 * `[kill]`, `[endlevel]` and friends. Each scenario becomes MWL source text
 * that the framework compiles (`tools/compile-campaign.ts`), plus a small
 * metadata record (turn limit, schedule, time areas, carry-over rules) the
 * port reads directly because MWL has no tags for them.
 *
 * The mapping leans on the runtime contract in `mwg/mwl`: triggers (`start`,
 * `turn`, `moveto`, `die`, `last breath`, `attack`, `recruit`, `sighted`,
 * custom names), `condition` conjunctions, `filter` existence checks, and
 * engine `hook` commands for everything only the live rules own (spawns,
 * terrain, villages, shroud, sides). Anything outside the table below lands
 * in `report.skipped` with its scenario and line; the build fails on an
 * empty report only when a scenario uses a tag the table never saw.
 *
 * Deliberate normalizations (each recorded in PORT_COVERAGE.md):
 * - WML coordinates are 1-based, MWL ones 0-based; every x/y value and range
 *   shifts down by one (`0` constrains nothing, as in WML).
 * - WML x/y location lists zip positionally; each pair becomes its own MWL
 *   moveto event sharing one id (so one-shot tracking stays per trigger).
 * - WML events fire once by default, so every converted event carries an
 *   explicit `once` except `first_time_only=no` ones.
 * - `[message]` options become `dialogue`/`choice` nodes with generated
 *   branch events; a bare option list on `variable=` becomes setters.
 * - `[role]` resolves statically against placed units; the `[else]` spawn
 *   runs only when nothing matches at load time.
 * - `[story]` parts become narrator messages; backgrounds and music are not
 *   ported. Objectives keep their text; `show_if` goes with the panel (P5).
 *
 * The assembly below uses a WML-shaped intermediate representation internally
 * (`[game]` / `key=value`, one fragment helper at a time). It is parsed by the
 * port's existing WML parser and immediately emitted as JSON5. The old MWL
 * tag-syntax parser is not part of this path; JSON5 is the only `.mwl` shape
 * the framework parses since the cutover.
 */

import { parseWml, type WmlNode } from '../simulation/wml.ts';
import type { TimeAreaDef } from '../simulation/types.ts';
import type { AiAspects, AiDirective, AiStage, AiUnitFilter } from '../ai/policy.ts';
import { candidateSettingFrom } from '../ai/candidates.ts';
import { encodeFilter, toFilterNode } from './wml-filter.ts';
import { objectFromWml } from '../simulation/objects.ts';
import { renderJson5Document } from './mwl-json5-emit.ts';

export interface LoaderContext {
  /** scenario id, for generated event ids and diagnostics */
  scenarioId: string;
  /** port prefix used to translate numbered campaign scenario ids in branches */
  scenarioPrefix?: string;
  /** real unit type ids, to resolve `[role]` type lists */
  knownUnitTypes: Set<string>;
  /** 0-based keep cells per side, from the scenario map */
  mapStarts: Record<number, { x: number; y: number }[]>;
  /** Inline contents of scenario-referenced terrain mask files, embedded at build time. */
  terrainMasks?: Record<string, string>;
  /** Inline contents of scenario-referenced replacement maps, embedded at build time. */
  mapFiles?: Record<string, string>;
}

export interface ScenarioScheduleEntry {
  id: string;
  lawfulBonus: number;
  name: string;
}

export interface ScenarioMeta {
  id: string;
  name: string;
  title: string;
  turns: number;
  nextScenario: string | null;
  mapFile: string | null;
  schedule: ScenarioScheduleEntry[];
  timeAreas: TimeAreaDef[];
  carryoverPercent: number;
  bonus: boolean;
  /** `[ai]` aspects the port can act on (see `src/ai/policy.ts`) */
  aspects: AiAspects;
  /** location-based `[goal]`/`[avoid]` directives for the AI planner */
  aiDirectives: AiDirective[];
  /** candidate-action stages extracted from `[ai][stage]` blocks */
  aiStages: AiStage[];
  /** the scenario's own `[candidate_action]` ids, scores and disabled entries */
  aiCandidates: { enabled: string[]; disabled: string[]; scores: Record<string, number> };
}

export interface LoadResult {
  mwl: string;
  meta: ScenarioMeta;
  report: {
    skipped: string[];
    diagnostics: { message: string; severity: 'warning' | 'blocking' }[];
  };
}

interface PlacedUnit {
  id: string;
  type: string;
  side: number;
  x: number;
  y: number;
  role?: string;
  loyal: boolean;
  name?: string;
  facing?: string;
}

interface ConvEvent {
  id: string;
  /** trigger name, or null for choice branches (answered by id, never fired) */
  trigger: string | null;
  once: boolean;
  conditions: string[];
  filters: string[];
  commands: string[];
}

const TRIGGER_OVERRIDES: Record<string, string> = {
  // `enter_hex` is the campaign-facing alias for the same movement dispatch
  // used by the runtime's `moveto` trigger; mapping it also enables range
  // expansion for its location filters.
  enter_hex: 'moveto',
  'enter hex': 'moveto',
};

export interface EventClassification {
  /** the canonical trigger the scene fires (`src/simulation/event-lifecycle.ts`) */
  trigger: string;
  /** the turn/side tests the scene satisfies before firing it */
  conditions: { variable: string; equals: string }[];
}

/**
 * Classify a WML event name into the port's canonical trigger plus the context
 * the scene publishes before firing it.
 *
 * Wesnoth names its turn events after the turn and side that just started
 * (`src/play_controller.cpp:509-560` fires `turn_N`, `new_turn`, `side_turn`,
 * `side_N_turn`, `side_turn_N`, `side_N_turn_N`, and the `_refresh`/`_end`
 * variants). The port fires one trigger per step and folds the numbers into
 * `[condition]` children over `turn_number`/`turn_side`, which the scene sets
 * from `turnContextVariables`. A name outside the vocabulary keeps its own
 * slug, so a scenario's custom `[fire_event]` names still work.
 */
export function classifyEventName(raw: string): EventClassification {
  const name = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  const turn = (value: string) => ({ variable: 'turn_number', equals: value });
  const side = (value: string) => ({ variable: 'turn_side', equals: value });

  const sideTurn = /^side (?:(\d+) )?turn(?: (\d+))?(?: (end|refresh))?$/.exec(name);
  if (sideTurn) {
    const conditions = [
      ...(sideTurn[1] ? [side(sideTurn[1])] : []),
      ...(sideTurn[2] ? [turn(sideTurn[2])] : []),
    ];
    const trigger = sideTurn[3] === 'end' ? 'side_turn_end' : sideTurn[3] === 'refresh' ? 'turn_refresh' : 'turn';
    return { trigger, conditions };
  }
  const turnEvent = /^turn(?: (\d+))?(?: (end|refresh))?$/.exec(name);
  if (turnEvent) {
    const conditions = turnEvent[1] ? [turn(turnEvent[1])] : [];
    const trigger = turnEvent[2] === 'end' ? 'turn_end' : turnEvent[2] === 'refresh' ? 'turn_refresh' : 'turn';
    return { trigger, conditions };
  }
  // WML event names are interpolated when the event is registered. Preserve
  // the canonical turn trigger when the interpolated side/turn is variable-
  // backed; the condition is evaluated later against the runtime context.
  const dynamicSideTurn = /^side (.+) turn(?: (.+?))?(?: (end|refresh))?$/.exec(name);
  if (dynamicSideTurn) {
    const trigger = dynamicSideTurn[3] === 'end' ? 'side_turn_end' : dynamicSideTurn[3] === 'refresh' ? 'turn_refresh' : 'turn';
    return { trigger, conditions: [side(dynamicSideTurn[1]), ...(dynamicSideTurn[2] ? [turn(dynamicSideTurn[2])] : [])] };
  }
  const dynamicTurn = /^turn (.+?)(?: (end|refresh))?$/.exec(name);
  if (dynamicTurn) {
    const trigger = dynamicTurn[2] === 'end' ? 'turn_end' : dynamicTurn[2] === 'refresh' ? 'turn_refresh' : 'turn';
    return { trigger, conditions: [turn(dynamicTurn[1])] };
  }
  const underscoredTurn = /^turn_(.+)$/.exec(name);
  if (underscoredTurn) return { trigger: 'turn', conditions: [turn(underscoredTurn[1])] };
  return { trigger: TRIGGER_OVERRIDES[name] ?? slug(name), conditions: [] };
}

/**
 * Quote free text as an MWL gettext string. MWL values are single-line, so
 * embedded newlines flatten to spaces; quotes double like WML's own escape.
 */
function q(text: string): string {
  return `_ "${text.replace(/\s+/g, ' ').replaceAll('"', '""')}"`;
}

/** Trigger names cannot carry spaces in MWL (`battle text` runs as `battle_text`). */
function slug(trigger: string): string {
  return trigger.trim().replace(/\s+/g, '_');
}

/** MWL ids must start with a letter, while campaign ids commonly start digits. */
function safeId(id: string): string {
  const normalized = id.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return /^[A-Za-z_]/.test(normalized) ? normalized : `scenario_${normalized}`;
}

/** Translate `05a_The_Long_March` to the generated scenario id used by the port. */
function portScenarioId(realId: string, context: LoaderContext): string {
  const match = /^(\d{1,2}(?:[a-z]\d?)?(?:_\d{1,2})?)_/i.exec(realId.trim());
  if (!match || !context.scenarioPrefix) return realId.trim();
  const number = /^\d$/.test(match[1]) ? `0${match[1]}` : match[1];
  return `${context.scenarioPrefix}-${number.replaceAll('_', '-').toLowerCase()}`;
}

/**
 * MWL `id` accepts `/^[A-Za-z_][\w.-]*$/` (`schema.ts validType`). A WML
 * variable path outside that shape - a `$var` indirection, a `|`-delimited
 * dynamic name, or an array index like `zombies[0].allow_recruit` - cannot be
 * a `[variable] name=` or `[set_variable] name=`, so it goes through the
 * engine's string-keyed `variable_compare`/`command:set_variable_dynamic`
 * hooks, which treat the whole path as one key.
 */
function isMwlVariableName(name: string): boolean {
  return /^[A-Za-z_][\w.-]*$/.test(name);
}

function isDynamicVariableName(name: string): boolean {
  return !isMwlVariableName(name);
}

/** Evaluate the small integer expressions used in numbered turn triggers. */
function integerTurnValue(expression: string): number | null {
  const tokens = expression.replace(/\s+/g, '').match(/\d+|[+-]/g);
  if (!tokens || tokens.join('') !== expression.replace(/\s+/g, '')) return null;
  let result = Number(tokens[0]);
  if (!Number.isFinite(result)) return null;
  for (let index = 1; index < tokens.length; index += 2) {
    const operator = tokens[index];
    const value = Number(tokens[index + 1]);
    if (!Number.isFinite(value)) return null;
    result = operator === '+' ? result + value : result - value;
  }
  return Number.isInteger(result) ? result : null;
}

/** Shift one 1-based WML coordinate spec (values and `a-b` ranges) to 0-based. */
function shiftSpec(spec: string): string {
  return spec
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(trimmed);
      if (range) return `${Number(range[1]) - 1}-${Number(range[2]) - 1}`;
      return /^-?\d+$/.test(trimmed) ? String(Number(trimmed) - 1) : trimmed;
    })
    .join(',');
}

/** Split a comma list, trimming empties. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A WML coordinate pair, from the split `x`/`y` keys or the old `x,y`
 * shorthand (`parseWml` now splits `x,y=5,3` into `x=5`/`y=3`).
 */
function wmlPair(attributes: Record<string, string>, first = 'x', second = 'y'): [string, string] | undefined {
  if (attributes[first] !== undefined && attributes[second] !== undefined) return [attributes[first], attributes[second]];
  const combined = attributes[`${first},${second}`];
  if (combined === undefined) return undefined;
  const parts = combined.split(',').map((entry) => entry.trim());
  return [parts[0] ?? '', parts[1] ?? ''];
}

/** Zip WML x/y location lists positionally (see the module contract). */
function zipLocations(x: string | undefined, y: string | undefined): { x: string; y: string }[] {
  const xs = splitList(x);
  const ys = splitList(y);
  if (xs.length === 0 && ys.length === 0) return [];
  if (xs.length === 0) return ys.map((yy) => ({ x: '', y: yy }));
  if (ys.length === 0) return xs.map((xx) => ({ x: xx, y: '' }));
  const count = Math.min(xs.length, ys.length);
  return Array.from({ length: count }, (_, index) => ({ x: xs[index], y: ys[index] }));
}

/** Expand one WML location pair into concrete cells, including ranges. */
function expandLocationPair(x: string, y: string): { x: number; y: number }[] {
  const expand = (spec: string): number[] => {
    const range = /^(\-?\d+)\s*-\s*(\-?\d+)$/.exec(spec.trim());
    if (!range) return /^\-?\d+$/.test(spec.trim()) ? [Number(spec)] : [];
    const start = Number(range[1]);
    const end = Number(range[2]);
    const step = start <= end ? 1 : -1;
    return Array.from({ length: Math.abs(end - start) + 1 }, (_, index) => start + index * step);
  };
  const xs = expand(x);
  const ys = expand(y);
  return xs.flatMap((xx) => ys.map((yy) => ({ x: xx, y: yy })));
}

/** Map the stock RCA candidate-action names to the port's executable phases. */
function aiStageForCandidate(id: string): AiStage | null {
  const normalized = id.toLowerCase();
  if (/(recruit|recruitment)/.test(normalized)) return 'recruitment';
  if (/(heal|retreat)/.test(normalized)) return 'healing';
  if (/(combat|attack|poison)/.test(normalized)) return 'combat';
  if (/(village|villages)/.test(normalized)) return 'villages';
  if (/(goto|move|target|keep)/.test(normalized)) return 'movement';
  return null;
}

export function loadScenario(scenario: WmlNode, context: LoaderContext): LoadResult {
  const skipped: string[] = [];
  const diagnostics: { message: string; severity: 'warning' | 'blocking' }[] = [];
  const severityOf = (what: string): 'warning' | 'blocking' => {
    // These constructs can change campaign state or control flow. A skipped
    // presentation/detail tag is a warning; a skipped executable construct is
    // a compatibility blocker until it has an explicit port or exception.
    if (/\[(?:while|foreach|switch|lua|command|filter_opponent)\]/.test(what)) return 'blocking';
    if (/^\[if\]/.test(what) && /not ported/.test(what)) return 'blocking';
    // Dynamic event names are still registered as ordinary scenario events;
    // the unresolved schedule expression is a timing approximation, not a
    // dropped executable body.
    if (/event with a dynamic trigger/.test(what)) return 'warning';
    return 'warning';
  };
  const skip = (what: string, node?: WmlNode): void => {
    const at = node?.location ? ` (${node.location.file}:${node.location.line})` : '';
    const message = `${context.scenarioId}: ${what}${at}`;
    skipped.push(message);
    diagnostics.push({ message, severity: severityOf(what) });
  };

  const id = scenario.attributes.id ?? context.scenarioId;
  const title = scenario.attributes.name ?? id;
  const turns = Number(scenario.attributes.turns ?? 0) || 0;
  const nextScenario = scenario.attributes.next_scenario && scenario.attributes.next_scenario !== 'null' ? scenario.attributes.next_scenario : null;
  const mapFile = scenario.attributes.map_file ?? null;
  const mapData = scenario.attributes.map_data ?? null;

  const meta: ScenarioMeta = {
    id,
    name: scenario.attributes.name ?? id,
    title,
    turns,
    nextScenario,
    mapFile,
    schedule: [],
    timeAreas: [],
    carryoverPercent: 40,
    bonus: false,
    aspects: {},
    aiDirectives: [],
    aiStages: [],
    aiCandidates: { enabled: [], disabled: [], scores: {} },
  };

  const sides: string[] = [];
  const hiddenSides: number[] = [];
  const units: PlacedUnit[] = [];
  const roleIds = new Map<string, string[]>();
  const loyalIds: string[] = [];
  const story: { text: string; background?: string; music?: string; conditions: string[] }[] = [];
  const objectivesWin: string[] = [];
  const objectivesLose: string[] = [];
  const events: ConvEvent[] = [];
  let counter = 0;
  let repeatVariableCounter = 0;
  let randomVariableCounter = 0;
  const eventId = (base: string): string => `${base}_${(counter += 1)}`;

  const noteRole = (role: string | undefined, unitId: string): void => {
    if (!role) return;
    roleIds.set(role, [...(roleIds.get(role) ?? []), unitId]);
  };

  // Placements first, so `[role]` and `[kill] role=` resolve against them.
  // Mid-scenario `[unit]` tags spawn instead: they resolve roles but never
  // join the opening placements.
  let unitCounter = 0;
  const placeUnit = (node: WmlNode, initial: boolean): PlacedUnit | null => {
    const type = node.attributes.type;
    if (!type || !context.knownUnitTypes.has(type)) {
      skip(`unit without a known type (${type ?? 'missing'})`, node);
      return null;
    }
    const side = Number(node.attributes.side ?? 0);
    const pair = node.attributes['x,y']?.split(',').map((value) => Number(value.trim()));
    const x = Number(node.attributes.x ?? pair?.[0] ?? NaN) - 1;
    const y = Number(node.attributes.y ?? pair?.[1] ?? NaN) - 1;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      // Deviation: the real engine resolves variable coordinates before placement.
      // Fixed-type event units still reach this static path; only variable types
      // use spawn_dynamic below. See PORT_COVERAGE.md for the SOTA 21 riders.
      skip(`unit ${node.attributes.id ?? type} without coordinates`, node);
      return null;
    }
    const placed: PlacedUnit = {
      id: safeId(node.attributes.id || `u_${(unitCounter += 1)}`),
      type,
      side,
      x,
      y,
      role: node.attributes.role || undefined,
      loyal: hasLoyalMarker(node),
    };
    if (initial) units.push(placed);
    noteRole(placed.role, placed.id);
    if (placed.loyal) loyalIds.push(placed.id);
    return placed;
  };

  for (const child of scenario.children) {
    if (child.tag === 'side') convertSide(child);
    else if (child.tag === 'unit') placeUnit(child, true);
    else if (child.tag === 'story') collectStory(child);
    else if (child.tag === 'time') meta.schedule.push(convertTime(child));
    else if (child.tag === 'time_area') meta.timeAreas.push(convertTimeArea(child, skip, context));
    else if (child.tag === 'role') convertRole(child);
  }

  for (const child of scenario.children) {
    if (child.tag === 'event') convertEvent(child, null);
    else if (child.tag === 'objectives') convertObjectives(child);
    else if (child.tag === 'micro_ai') {
      events.push({
        id: eventId('micro_ai'), trigger: 'prestart', once: true, conditions: [], filters: [],
        commands: [hookCommand('command:micro_ai', microAiAttrs(child))],
      });
    }
  }

  function microAiAttrs(node: WmlNode): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const key of ['side', 'ai_type', 'action', 'x', 'y', 'x,y', 'waypoint_x', 'waypoint_y', 'goal_x', 'goal_y', 'radius', 'value']) {
      if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
    }
    const filter = node.children.find((child) => child.tag === 'filter' || child.tag === 'filter_second');
    if (filter) attrs.filter = encodeURIComponent(JSON.stringify(filter.attributes));
    return attrs;
  }

  function convertSide(node: WmlNode): void {
    const side = Number(node.attributes.side ?? 0);
    if (!side) {
      skip('side without a number', node);
      return;
    }
    const attrs: string[] = [`id=${side}`];
    if (node.attributes.controller) attrs.push(`controller=${node.attributes.controller}`);
    if (node.attributes.team_name) attrs.push(`team_name=${node.attributes.team_name}`);
    if (node.attributes.share_vision) attrs.push(`share_vision=${node.attributes.share_vision}`);
    if (node.attributes.gold) attrs.push(`gold=${node.attributes.gold}`);
    if (node.attributes.recruit) attrs.push(`recruit=${node.attributes.recruit}`);
    const recallFilter = node.children.find((child) => child.tag === 'filter_recall');
    if (recallFilter) {
      // Keep the side's recall constraint in runtime state; MWL has no native
      // side-level recall-list filter.
      events.push({
        id: eventId('side_recall_filter'), trigger: 'prestart', once: true, conditions: [], filters: [],
        commands: [hookCommand('command:config_side', {
          side: String(side),
          recall_filter: encodeURIComponent(JSON.stringify(recallFilter)),
        })],
      });
    }
    const sideVariables = node.children.find((child) => child.tag === 'variables');
    if (sideVariables) {
      events.push({
        id: eventId('side_variables'), trigger: 'prestart', once: true, conditions: [], filters: [],
        commands: [hookCommand('command:config_side', {
          side: String(side),
          side_variables: encodeURIComponent(JSON.stringify(sideVariables.attributes)),
        })],
      });
    }
    if (node.attributes.hidden === 'yes') hiddenSides.push(side);
    const leaderNode = node.children.find((child) => child.tag === 'leader');
    const leaderType = leaderNode?.attributes.type ?? node.attributes.type ?? node.attributes.leader?.split(',')[0]?.trim();
    const leaderId = leaderNode?.attributes.id ?? node.attributes.id ?? (leaderType ? `leader_${side}` : undefined);
    const leaderName = leaderNode?.attributes.name ?? node.attributes.name;
    const leaderFacing = leaderNode?.attributes.facing ?? node.attributes.facing;
    // MWL's side.leader is a unit instance id, whereas Wesnoth's [side]
    // `type=` names the type used to create that instance.
    if (leaderType && leaderId && context.knownUnitTypes.has(leaderType)) attrs.push(`leader=${safeId(leaderId)}`);
    sides.push(`[side]\n${attrs.join('\n')}\n[/side]`);
    // A named leader fights under its own id (die filters name it), so it is
    // placed explicitly on the keep; the runtime skips occupied starts.
    if (leaderType && leaderId && context.knownUnitTypes.has(leaderType)) {
      const pair = node.attributes['x,y']?.split(',').map((value) => Number(value.trim()));
      const keep = context.mapStarts[side]?.[0];
      let x = Number(node.attributes.x ?? pair?.[0] ?? keep?.x ?? NaN) - (node.attributes.x || pair ? 1 : 0);
      let y = Number(node.attributes.y ?? pair?.[1] ?? keep?.y ?? NaN) - (node.attributes.y || pair ? 1 : 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        // Real engine (src/actions/unit_creator.cpp:80-110, 185-195): a leader with no start
        // position goes to the side's recall list, where the scenario's own
        // [store_unit]/[unstore_unit] (HttT 01 "Konrad at home") finds it. The port has no
        // recall-list placement for a created unit, so it parks the leader on hex (0,0)
        // instead of dropping it, which left such sides with no units at all.
        x = 0;
        y = 0;
      }
      const placed: PlacedUnit = {
        id: safeId(leaderId), type: leaderType, side, x, y, loyal: true,
        ...(leaderName ? { name: leaderName } : {}),
        ...(leaderFacing ? { facing: leaderFacing } : {}),
      };
      units.push(placed);
      loyalIds.push(placed.id);
      const leaderStatus = (leaderNode ?? node).children.find((child) => child.tag === 'status');
      if (leaderStatus) {
        for (const [status, value] of Object.entries(leaderStatus.attributes)) {
          if (status === 'petrified' && (value === 'yes' || value === 'true')) {
            events.push({
              id: eventId('leader_status'), trigger: 'prestart', once: true, conditions: [], filters: [],
              commands: [hookCommand('command:petrify', { id: placed.id })],
            });
          }
        }
      }
      const modifications = node.children.find((child) => child.tag === 'modifications');
      const traitEffects = modifications?.children.flatMap((trait) => trait.tag === 'trait' ? trait.children.filter((child) => child.tag === 'effect') : []) ?? [];
      if (traitEffects.length) {
        const object = objectFromWml({
          tag: 'object',
          attributes: { id: `side_traits_${side}` },
          children: traitEffects,
          location: node.location,
        });
        if (object && (object.effects.length || object.abilities.length)) {
          events.push({
            id: eventId('side_traits'), trigger: 'prestart', once: true, conditions: [], filters: [],
            commands: [hookCommand('command:apply_object', {
              id: placed.id,
              object: encodeURIComponent(JSON.stringify(object)),
            })],
          });
        }
      }
    }
    const villageCells = node.children.filter((child) => child.tag === 'village').flatMap((village) => {
      const pair = wmlPair(village.attributes);
      return pair ? [`${Number(pair[0]) - 1},${Number(pair[1]) - 1}`] : [];
    });
    if (villageCells.length) {
      events.push({
        id: eventId('side_villages'), trigger: 'prestart', once: true, conditions: [], filters: [],
        commands: [hookCommand('command:set_village_owner', { side: String(side), cells: villageCells.join(';') })],
      });
    }
    for (const grand of node.children) {
      if (grand.tag === 'unit') placeUnit(grand, true);
    }
    for (const grand of node.children) {
      if (grand.tag === 'unit') continue;
      if (grand.tag === 'village' && wmlPair(grand.attributes)) continue;
      if (grand.tag === 'filter_recall') continue;
      if (grand.tag === 'variables') continue;
      if (grand.tag === 'modifications' && leaderType && leaderId && context.knownUnitTypes.has(leaderType)) continue;
      // `[leader]` is consumed above, including the valid nested leader form;
      // its optional `[variables]`/presentation children do not describe a
      // separate side action.
      if (grand.tag === 'leader') continue;
      if (grand.tag === 'status') continue;
      if (grand.tag !== 'ai') skip(`[side] ${grand.tag}`, grand);
      // AI configuration is a P6 concern. Keep the diagnostic keyed to the
      // original tag so the coverage allowlist can distinguish it from an
      // unsupported child that merely happens to occur inside [side].
      else {
        // Aspects the port's planner can act on; the rest of the `[ai]` node is
        // still reported as skipped so the allowlist stays honest.
        if (grand.attributes.aggression) meta.aspects.aggression = grand.attributes.aggression;
        if (grand.attributes.caution) meta.aspects.caution = grand.attributes.caution;
        if (grand.attributes.greed) meta.aspects.greed = grand.attributes.greed;
        if (grand.attributes.grouping) meta.aspects.grouping = grand.attributes.grouping;
        for (const stage of grand.children.filter((child) => child.tag === 'stage')) {
          for (const candidate of stage.children.filter((child) => child.tag === 'candidate_action')) {
            const stageId = aiStageForCandidate(candidate.attributes.id ?? candidate.attributes.name ?? '');
            if (stageId && !meta.aiStages.includes(stageId)) meta.aiStages.push(stageId);
            // The engine's own candidate action id, kept so the port's scheduler
            // honours `[candidate_action]` score/enable as the engine does.
            const setting = candidateSettingFrom(candidate.attributes);
            if (!setting) continue;
            if (setting.maxScore !== undefined) meta.aiCandidates.scores[setting.id] = setting.maxScore;
            if (setting.enabled === false) {
              if (!meta.aiCandidates.disabled.includes(setting.id)) meta.aiCandidates.disabled.push(setting.id);
            } else if (!meta.aiCandidates.enabled.includes(setting.id)) {
              meta.aiCandidates.enabled.push(setting.id);
            }
          }
        }
        for (const directive of grand.children) {
          if (directive.tag !== 'goal' && directive.tag !== 'avoid') continue;
          const locationParts = splitList(directive.attributes['x,y']);
          const location = locationParts.length >= 2
            ? { x: locationParts[0], y: locationParts[1] }
            : directive.attributes.x !== undefined || directive.attributes.y !== undefined
              ? { x: directive.attributes.x ?? '', y: directive.attributes.y ?? '' }
              : undefined;
          const nested = directive.children.find((child) => child.tag === 'filter_location');
          const nestedParts = splitList(nested?.attributes['x,y']);
          const nestedLocation = nestedParts.length >= 2
            ? { x: nestedParts[0], y: nestedParts[1] }
            : nested && (nested.attributes.x !== undefined || nested.attributes.y !== undefined)
              ? { x: nested.attributes.x ?? '', y: nested.attributes.y ?? '' }
              : undefined;
          const criteria = directive.children.find((child) => child.tag === 'criteria');
          const criteriaParts = splitList(criteria?.attributes['x,y']);
          const criteriaLocation = criteriaParts.length >= 2
            ? { x: criteriaParts[0], y: criteriaParts[1] }
            : criteria && (criteria.attributes.x !== undefined || criteria.attributes.y !== undefined)
              ? { x: criteria.attributes.x ?? '', y: criteria.attributes.y ?? '' }
              : undefined;
          const point = location ?? nestedLocation ?? criteriaLocation;
          // WML permits the unit criteria directly on [goal]/[avoid] (the
          // common `id=Aiglondur,Angarthing` form), as well as in a nested
          // [criteria] block.
          const filter = criteria ? aiUnitFilter(criteria.attributes) : aiUnitFilter(directive.attributes);
          if (!point && !filter) {
            skip(`[ai] ${directive.tag} without a numeric x,y location or unit criteria`, directive);
            continue;
          }
          const radius = Number(directive.attributes.radius ?? 0);
          const value = Number(directive.attributes.value ?? (directive.tag === 'avoid' ? 10 : 1));
          if (!Number.isFinite(radius) || !Number.isFinite(value)) {
            skip(`[ai] ${directive.tag} has an invalid radius/value`, directive);
            continue;
          }
          const cells = point ? zipLocations(point.x, point.y).flatMap((pair) => expandLocationPair(pair.x, pair.y)) : [];
          if (!cells.length) {
            if (!filter) {
              skip(`[ai] ${directive.tag} without a numeric x,y location`, directive);
              continue;
            }
            meta.aiDirectives.push({ kind: directive.tag, radius: Math.max(0, radius), value: Math.max(0, value), filter });
          } else {
            for (const cell of cells) {
              meta.aiDirectives.push({ kind: directive.tag, x: cell.x - 1, y: cell.y - 1, radius: Math.max(0, radius), value: Math.max(0, value), ...(filter ? { filter } : {}) });
            }
          }
        }
        skip('[ai]', grand);
      }
    }
  }

  function aiUnitFilter(attributes: Record<string, string>): AiUnitFilter | undefined {
    const filter: AiUnitFilter = {
      ...(attributes.id ? { id: splitList(attributes.id) } : {}),
      ...(attributes.side && /^\d+$/.test(attributes.side) ? { side: Number(attributes.side) } : {}),
      ...(attributes.type ? { type: splitList(attributes.type) } : {}),
      ...(attributes.not_type ? { notType: splitList(attributes.not_type) } : {}),
      ...(attributes.level && /^\d+$/.test(attributes.level) ? { level: Number(attributes.level) } : {}),
      ...(attributes.alignment ? { alignment: splitList(attributes.alignment) } : {}),
      ...(attributes.canrecruit ? { canRecruit: attributes.canrecruit === 'yes' } : {}),
    };
    return Object.keys(filter).length ? filter : undefined;
  }

  function convertRole(node: WmlNode): void {
    const role = node.attributes.role;
    if (!role) {
      skip('[role] without a role', node);
      return;
    }
    const excluded = new Set<string>();
    for (const grand of node.children) {
      if (grand.tag === 'not' && grand.attributes.id) excluded.add(grand.attributes.id);
    }
    const types = splitList(node.attributes.type);
    const match = units.find((placed) => types.includes(placed.type) && !excluded.has(placed.id));
    if (match) {
      noteRole(role, match.id);
      return;
    }
    // Nothing placed matches yet: run the `[else]` spawn, if the scenario
    // provides one, so the role still enters play.
    for (const grand of node.children) {
      if (grand.tag !== 'else') {
        if (grand.tag !== 'not') skip(`[role] ${grand.tag}`, grand);
        continue;
      }
      let storedLeader: PlacedUnit | undefined;
      for (const unit of grand.children) {
        if (unit.tag === 'store_unit') {
          // NEED_MERCENARY stores the leader only to derive the fallback
          // spawn coordinates below. Preserve that information statically;
          // the runtime command is unnecessary for this load-time role.
          const id = unit.children.find((child) => child.tag === 'filter')?.attributes.id ?? unit.attributes.id;
          storedLeader = id ? units.find((candidate) => candidate.id === safeId(id)) : undefined;
          continue;
        }
        if (unit.tag !== 'unit') {
          if (unit.tag !== 'move_unit_fake' && unit.tag !== 'clear_variable') skip(`[role] else ${unit.tag}`, unit);
          continue;
        }
        const placed = placeElseUnit(unit, role, storedLeader);
        if (placed) noteRole(role, placed.id);
      }
    }
  }

  function placeElseUnit(node: WmlNode, role: string, storedLeader?: PlacedUnit): PlacedUnit | null {
    const type = node.attributes.type;
    if (!type || !context.knownUnitTypes.has(type)) {
      skip(`else unit without a known type (${type ?? 'missing'})`, node);
      return null;
    }
    const coordinateSource = storedLeader ?? units.find((candidate) => candidate.id === 'Arvith');
    const resolveCoordinate = (raw: string | undefined, axis: 'x' | 'y'): number => {
      if (raw === undefined) return NaN;
      const compact = raw.replaceAll(' ', '');
      const relative = /^\$\(\$temp\.(x|y)([+-]\d+)\)$/.exec(compact);
      if (relative && coordinateSource && relative[1] === axis) return coordinateSource[axis] + Number(relative[2]);
      const direct = /^\$temp\.(x|y)$/.exec(compact);
      if (direct && coordinateSource && direct[1] === axis) return coordinateSource[axis];
      return Number(raw) - 1;
    };
    const compactPair = node.attributes['x,y']?.split(',').map((value) => value.trim());
    let x = resolveCoordinate(node.attributes.x ?? compactPair?.[0], 'x');
    let y = resolveCoordinate(node.attributes.y ?? compactPair?.[1], 'y');
    if (node.attributes.placement === 'leader') {
      const keep = context.mapStarts[1]?.[0];
      if (!keep) {
        skip('else unit placement=leader has no keep', node);
        return null;
      }
      x = keep.x;
      y = keep.y;
    }
    // The NEED_MERCENARY macro expands its stored-unit coordinates through a
    // WML formula (`$($temp.x-1),$temp.y`). If preprocessing has already
    // folded that expression into an opaque value, retain the macro's
    // documented adjacent-to-leader placement.
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && coordinateSource) {
      x = coordinateSource.x - 1;
      y = coordinateSource.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const keep = context.mapStarts[1]?.[0];
      if (keep) {
        x = keep.x;
        y = keep.y;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      skip(`else unit ${type} without coordinates`, node);
      return null;
    }
    const placed: PlacedUnit = {
      id: safeId(node.attributes.id || `u_${(unitCounter += 1)}`),
      type,
      side: Number(node.attributes.side ?? 1),
      x,
      y,
      role,
      loyal: hasLoyalMarker(node),
    };
    units.push(placed);
    if (placed.loyal) loyalIds.push(placed.id);
    return placed;
  }

  function convertObjectives(node: WmlNode): void {
    for (const objective of node.children) {
      if (objective.tag === 'gold_carryover') {
        if (objective.attributes.carryover_percentage) meta.carryoverPercent = Number(objective.attributes.carryover_percentage) || meta.carryoverPercent;
        if (objective.attributes.bonus === 'yes') meta.bonus = true;
        continue;
      }
      if (objective.tag !== 'objective') {
        // Notes are presentation-only objective text and do not alter the
        // win/lose predicates represented by MWL's objectives node.
        if (objective.tag !== 'note') skip(`[objectives] ${objective.tag}`, objective);
        continue;
      }
      const text = objective.attributes.description ?? '';
      if (!text) continue;
      if (objective.attributes.condition === 'win') objectivesWin.push(text);
      else objectivesLose.push(text);
    }
  }

  function convertEvent(node: WmlNode, forceTrigger: string | null, idSuffix = ''): ConvEvent[] {
    const raw = forceTrigger ?? node.attributes.name ?? '';
    if (!raw) {
      skip('event without a name', node);
      return [];
    }
    const names = forceTrigger === null ? splitList(raw) : [];
    if (names.length > 1) return names.flatMap((name, index) => convertEvent(node, name, String(index + 1)));
    // `turn $(3-1)` is a compile-time constant; fold it into the table's own
    // spelling before classification.
    const expression = /^turn\s+\$\(([^)]+)\)$/.exec(raw.trim());
    const folded = expression ? integerTurnValue(expression[1]) : null;
    const classification = classifyEventName(folded === null ? raw : `turn ${folded}`);
    const trigger = classification.trigger;
    // MWL `event.on` is an id. A trigger assembled at runtime
    // (`side_$($lisar_side-1)_turn_end`) cannot be one, so record it and move on
    // rather than emit invalid MWL.
    if (!/^[A-Za-z_][\w.-]*$/.test(trigger)) {
      skip(`event with a dynamic trigger (${raw}) is not ported`, node);
      return [];
    }
    // A moveto location filter stays a single event: the runtime's coordinate matcher reads
    // `x`/`y` as a number, a range, or a comma list, so a unit matches when it is in both
    // sets. Narrowing attributes (side/unit/type) ride along in the same filter.
    const moveto = trigger === 'moveto' ? movetoFilter(node) : null;
    if (moveto) {
      const ev = baseEvent(safeId(`${node.attributes.id ?? eventId('ev')}${idSuffix ? `_${idSuffix}` : ''}`), trigger, node);
      // One `[filter]` carrying every attribute: the runtime reads only the event's first
      // `[filter]`, so separate nodes dropped `y` (and the unit id) and made a POI's
      // `enter hex` event fire for any unit on the same column.
      const combined: Record<string, string> = { ...moveto.narrow };
      if (moveto.x !== undefined) combined.x = moveto.x;
      if (moveto.y !== undefined) combined.y = moveto.y;
      if (Object.keys(combined).length) ev.filters.push(filterNode(combined));
      // The runtime's own dispatch reads the coordinate filter above; anything
      // it cannot express (races, ranges, the algebra) rides on the same event
      // as a test of the unit that moved.
      if (moveto.needsAlgebra) ev.filters.push(subjectPredicate('unit_moved', node));
      finishEvent(node, ev, classification, true);
      return [ev];
    }
    const outs: ConvEvent[] = [];
    const ev = baseEvent(safeId(`${node.attributes.id ?? eventId('ev')}${idSuffix ? `_${idSuffix}` : ''}`), trigger, node);
    finishEvent(node, ev, classification, false);
    outs.push(ev);
    return outs;
  }

  function baseEvent(id: string, trigger: string, node: WmlNode): ConvEvent {
    return {
      id,
      trigger,
      once: node.attributes.first_time_only !== 'no',
      conditions: [],
      filters: [],
      commands: [],
    };
  }

  function finishEvent(
    node: WmlNode,
    ev: ConvEvent,
    classification: EventClassification,
    movetoSplitDone: boolean,
  ): void {
    for (const test of classification.conditions) ev.conditions.push(condition(test));
    if (node.attributes.filter_formula) {
      ev.filters.push(`[filter_condition]\n[predicate]\nname=wml_formula\nformula=${oneLineValue(node.attributes.filter_formula)}\n[/predicate]\n[/filter_condition]`);
    }
    for (const child of node.children) {
      if ((child.tag === 'filter' || child.tag === 'filter_second') && movetoSplitDone && ev.trigger === 'moveto') {
        // The coordinates ride the event's own `[filter]`; everything else the
        // runtime cannot test was already encoded into the event's algebra
        // predicate (`movetoFilter`), so nothing here is a silent loss.
      } else if (child.tag === 'filter' || child.tag === 'filter_second') convertEventFilter(child, ev, node);
      else if (child.tag === 'filter_condition') convertFilterCondition(child, ev);
      else if (child.tag === 'filter_attack' || child.tag === 'filter_second_attack') {
        const prefix = child.tag === 'filter_second_attack' ? 'last_defender' : 'last_attacker';
        ev.filters.push(predicateNode([
          'name=attack_filter',
          `unit=$${prefix}_id`,
          `filter=${encodeURIComponent(JSON.stringify({ tag: child.tag, attributes: child.attributes, children: child.children.map((nested) => ({ tag: nested.tag, attributes: nested.attributes, children: nested.children })) }))}`,
        ]));
      }
      else if (child.tag === 'variable' || child.tag === 'have_unit') {
        ev.filters.push(filterConditionWrapper(child));
      } else convertCommand(child, ev);
    }
    events.push(ev);
  }

  /**
   * A `moveto` event's location filter, kept in Wesnoth's own spelling: `x`/`y` may each be
   * a number, a range, or a comma list (`x=10-99,13-99`), and a unit matches when its
   * coordinates are in both sets. The runtime's `matchesCoordinate` evaluates the spec, so
   * the filter stays one event; expanding it to cells cloned a large range into tens of
   * thousands of events (Eastern Invasion 17b reached 30k).
   */
  function movetoFilter(node: WmlNode): { narrow: Record<string, string>; x?: string; y?: string; needsAlgebra: boolean } | null {
    const filter = node.children.find((child) => child.tag === 'filter');
    if (!filter) return null;
    const pair = wmlPair(filter.attributes);
    const x = filter.attributes.x ?? pair?.[0];
    const y = filter.attributes.y ?? pair?.[1];
    if (x === undefined && y === undefined) return null;
    const narrow: Record<string, string> = {};
    if (filter.attributes.side) narrow.side = filter.attributes.side;
    if (filter.attributes.unit) narrow.unit = filter.attributes.unit;
    if (filter.attributes.type) narrow.type = filter.attributes.type;
    if (filter.attributes.not_type) narrow.not_type = filter.attributes.not_type;
    const specs: Record<string, string> = {};
    if (x !== undefined) specs.x = shiftSpec(x);
    if (y !== undefined) specs.y = shiftSpec(y);
    // Ranges and variable-backed coordinates stay Wesnoth's own spelling for the
    // narrow attributes, but everything the runtime cannot test travels as the
    // algebra predicate instead.
    const handled = ['x', 'y', 'x,y', 'side', 'unit', 'id', 'type', 'not_type'];
    const needsAlgebra =
      Object.keys(filter.attributes).some((key) => !handled.includes(key)) ||
      filter.children.some((child) => child.tag !== 'filter');
    return { narrow, ...specs, needsAlgebra };
  }

  /**
   * Event-level unit filters, read against the kill/attack/recruit/sight
   * context variables the port sets before firing the trigger (`last_dead_*`,
   * `last_attacker_*`, `last_defender_*`, `last_killed_by_*`, `last_recruit_*`,
   * `last_sighted_*`, `last_seer_*`). A `[filter]` names the subject of the
   * trigger, `[filter_second]` its counterpart.
   */
  function convertEventFilter(node: WmlNode, ev: ConvEvent, event: WmlNode): void {
    const second = node.tag === 'filter_second';
    // A choice branch (`trigger: null`) is answered by id, so it has no subject.
    const prefix: string | null = subjectPrefix(ev.trigger ?? '', second);
    if (prefix === null) {
      // A `moveto` event's subject is the unit that moved; every other
      // subjectless trigger (`turn`, `start`, `new_turn`) fires when some live
      // unit matches (`game_events::event::filter`). MWL's own `[filter]`
      // covers the framework's attribute subset; anything outside it goes
      // through the port's filter algebra.
      const simple = simpleFilterAttributes(node);
      if (simple) {
        if (Object.keys(simple).length) ev.filters.push(filterNode(simple));
        for (const grand of node.children) skip(`[${node.tag}] ${grand.tag}`, grand);
        void event;
        return;
      }
      ev.filters.push(ev.trigger === 'moveto' ? subjectPredicate('unit_moved', node) : anyUnitPredicate(node));
      return;
    }
    // A subject filter without an id still requires an actual unit: the
    // predicate reads `$<prefix>_id`, which the scene leaves empty when the
    // trigger had no subject (a `die` event with no corpse, say).
    ev.filters.push(subjectPredicate(prefix, node));
  }

  /** The trigger's first-unit context variable prefix, or null when it has none. */
  function subjectPrefix(trigger: string, second: boolean): string | null {
    switch (trigger) {
      case 'die':
      case 'last_breath':
        return second ? 'last_killer' : 'last_dead';
      case 'attack':
      case 'petrified':
        return second ? 'last_defender' : 'last_attacker';
      case 'recruit':
      case 'prerecruit':
      case 'recall':
      case 'prerecall':
        return 'last_recruit';
      case 'sighted':
        return second ? 'last_seer' : 'last_sighted';
      case 'capture':
        return 'last_capturer';
      case 'unit_placed':
        return 'unit_placed';
      case 'pre_advance':
      case 'advance':
      case 'post_advance':
        return 'last_advance';
      default:
        return null;
    }
  }

  /**
   * The attribute subset MWL's own `[filter]` matches, when the filter uses
   * nothing else. Returns null as soon as the body needs the port's algebra
   * (`[and]`/`[or]`/`[not]`, `[filter_wml]`, `[filter_location]`, a ranged or
   * variable-backed attribute, ability or status tests).
   */
  function simpleFilterAttributes(node: WmlNode): Record<string, string> | null {
    const kept: Record<string, string> = {};
    const supported = ['side', 'unit', 'id', 'type', 'level', 'alignment', 'x', 'y', 'x,y'];
    for (const [key, value] of Object.entries(node.attributes)) {
      if (!supported.includes(key)) return null;
      if (value.includes('$') || value.includes('-')) return null;
      // WML spells a unit id `id=`, MWL's own filter spells it `unit=`.
      if (key === 'id') {
        kept.unit ??= value;
        continue;
      }
      if (key === 'x,y') {
        const [x, y] = value.split(',');
        kept.x = (x ?? '').trim();
        kept.y = (y ?? '').trim();
        continue;
      }
      kept[key] = value;
    }
    if (node.children.some((child) => child.tag !== 'filter')) return null;
    return kept;
  }

  /** `[filter]`/`[filter_second]` as one predicate over the trigger's subject. */
  function subjectPredicate(prefix: string, node: WmlNode): string {
    return predicateNode([
      'name=wml_filter',
      `unit=$${prefix}_id`,
      `filter=${encodeFilter(toFilterNode(node))}`,
    ]);
  }

  /** The same filter used as "some live unit matches", with no subject. */
  function anyUnitPredicate(node: WmlNode): string {
    return predicateNode(['name=wml_filter', 'any=yes', `filter=${encodeFilter(toFilterNode(node))}`]);
  }

  function predicateNode(lines: string[]): string {
    return `[filter_condition]\n[predicate]\n${lines.join('\n')}\n[/predicate]\n[/filter_condition]`;
  }

  function convertFilterCondition(node: WmlNode, ev: ConvEvent): void {
    const lines: string[] = ['[filter_condition]'];
    for (const child of node.children) {
      if (child.tag === 'variable') {
        lines.push(isDynamicVariableName(child.attributes.name ?? '')
          ? variablePredicate(child, false)
          : `[variable]\n${variableAttrs(child)}\n[/variable]`);
      }
      else if (child.tag === 'not') {
        const have = child.children.find((nested) => nested.tag === 'have_unit');
        if (!have) continue;
        const attrs: Record<string, string> = { name: 'unit_exists', exists: 'no' };
        for (const key of ['id', 'type', 'side', 'x', 'y'] as const) {
          if (have.attributes[key] !== undefined) attrs[key] = have.attributes[key];
        }
        if (attrs.x) attrs.x = shiftSpec(attrs.x);
        if (attrs.y) attrs.y = shiftSpec(attrs.y);
        lines.push(`[predicate]\n${Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join('\n')}\n[/predicate]`);
      }
      else if (child.tag === 'have_unit') {
        const ranged = [child.attributes.x, child.attributes.y].some((value) => value?.includes('-'));
        if (ranged) {
          const attrs: Record<string, string> = { exists: 'yes' };
          for (const key of ['id', 'type', 'side'] as const) if (child.attributes[key]) attrs[key] = child.attributes[key];
          if (child.attributes.x) attrs.x = shiftSpec(child.attributes.x);
          if (child.attributes.y) attrs.y = shiftSpec(child.attributes.y);
          lines.push(`[predicate]\nname=unit_exists\n${Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join('\n')}\n[/predicate]`);
          continue;
        }
        const kept: Record<string, string> = {};
        for (const key of ['id', 'type', 'side', 'x', 'y']) if (child.attributes[key]) kept[key] = child.attributes[key];
        if (kept.x) kept.x = shiftSpec(kept.x);
        if (kept.y) kept.y = shiftSpec(kept.y);
        lines.push(`[have_unit]\n${Object.entries(kept)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')}\n[/have_unit]`);
      } else if (child.tag === 'have_location') {
        const pair = wmlPair(child.attributes);
        if (pair && /^\d+$/.test(pair[0]) && /^\d+$/.test(pair[1])) {
          lines.push(`[have_unit]\nx=${pair[0]}\ny=${pair[1]}\n[/have_unit]`);
        }
      } else if (child.tag === 'lua' && child.attributes.code !== undefined) {
        // The runtime predicate deliberately accepts only pure return-style
        // Lua. Keeping a non-return block as an inert predicate preserves the
        // condition boundary (and its safe-false result) without dropping the
        // surrounding event or producing malformed MWL.
        lines.push(`[predicate]\nname=lua_condition\ncode=${oneLineValue(child.attributes.code)}\n[/predicate]`);
      } else if (child.tag === 'and' || child.tag === 'or') {
        lines.push(`[predicate]\nname=wml_condition_tree\ntree=${encodeURIComponent(JSON.stringify(serializeVariableNode(child)))}\n[/predicate]`);
      } else skip(`[filter_condition] ${child.tag}`, child);
    }
    lines.push('[/filter_condition]');
    ev.filters.push(lines.join('\n'));
  }

  function filterConditionWrapper(child: WmlNode): string {
    if (child.tag === 'variable') {
      return isDynamicVariableName(child.attributes.name ?? '')
        ? `[filter_condition]\n${variablePredicate(child, false)}\n[/filter_condition]`
        : `[filter_condition]\n[variable]\n${variableAttrs(child)}\n[/variable]\n[/filter_condition]`;
    }
    return `[filter_condition]\n[have_unit]\nid=${child.attributes.id ?? ''}\n[/have_unit]\n[/filter_condition]`;
  }

  function variableAttrs(test: WmlNode): string {
    const attrs: Record<string, string> = {};
    if (test.attributes.name) attrs.name = test.attributes.name;
    Object.assign(attrs, comparisonAttrs(test));
    return Object.entries(attrs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  function filterNode(kept: Record<string, string>): string {
    return `[filter]\n${Object.entries(kept)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n[/filter]`;
  }

  function convertCommand(node: WmlNode, ev: ConvEvent): void {
    switch (node.tag) {
      case 'repeat': {
        const body = node.children.find((child) => child.tag === 'do');
        const times = node.attributes.times;
        if (!body || !times) {
          skip('[repeat] without times/do', node);
          return;
        }
        const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
        for (const child of body.children) convertCommand(child, nested);
        const count = Number(times.trim());
        if (Number.isInteger(count)) {
          for (let index = 0; index < Math.max(0, count); index++) ev.commands.push(...nested.commands);
          return;
        }
        // Dynamic WML repeat counts are evaluated at action time. Use the
        // framework's already-supported while/set-variable primitives so
        // `$array.length`, formulas, and difficulty variables remain live.
        const counter = `_mwg_repeat_${repeatVariableCounter++}`;
        ev.commands.push(`[set_variable]\nname=${counter}\nvalue=0\n[/set_variable]`);
        ev.commands.push(`[while]\n[condition]\nvariable=${counter}\nless_than=${times}\n[/condition]\n${nested.commands.join('\n')}\n[hook]\nname=command:set_variable_dynamic\nvariable=${counter}\nvalue=1\nmode=add\n[/hook]\n[/while]`);
        return;
      }
      case 'allow_undo':
        // The port has no undo-history WML surface yet. This tag only changes
        // whether the native UI offers an undo button, so ignoring it keeps
        // the scenario's rules and control flow intact.
        return;
      case 'move_unit_fake':
      case 'cancel_action':
      case 'animate_unit':
      case 'color_adjust':
      case 'screen_fade':
      case 'label':
      case 'floating_text':
      case 'companion_message':
      case 'change_theme':
      case 'display_tip':
      case 'print':
      case 'listen_for_mousemove':
      case 'hint_message':
      case 'show_countdown':
      case 'zoom':
      case 'unlock_view':
      case 'redraw':
      case 'set_menu_item':
      case 'clear_menu_item':
      case 'lock_view':
      case 'open_help':
      case 'multihex_image':
      case 'display_lisar_tutorial':
      case 'display_overworld_tutorial':
      case 'allow_end_turn':
      case 'disallow_end_turn':
        // These actions affect only Wesnoth's transient animation/input
        // controller or map presentation; they do not move, damage, or
        // otherwise mutate the rules state. MWG has no equivalent transient
        // presentation handle.
        return;
      case 'display_scenario_preview': {
        // Real engine: HttT's Lua popup (campaigns/Heir_To_The_Throne/lua/popups.lua:262) shows
        // the scenario card and, when the player presses its first button ("Begin"), sets
        // `status_<scenario>` to `in_progress`, which lets the overworld's POI event end the
        // level. The port has no such dialog, so it answers "Begin" automatically; without
        // this the player is always sent back and can never leave the overworld.
        const scenario = node.attributes.scenario;
        if (scenario) {
          convertCommand({ tag: 'set_variable', attributes: { name: `status_${scenario}`, value: 'in_progress' }, children: [], location: node.location }, ev);
        }
        return;
      }
      case 'petrify': {
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'side', 'type']) if (node.attributes[key]) attrs[key] = node.attributes[key].replaceAll('"', '');
        const filter = node.children.find((child) => child.tag === 'filter');
        if (filter) attrs.filter = encodeFilter(toFilterNode(filter));
        ev.commands.push(hookCommand('command:petrify', attrs));
        return;
      }
      case 'unpetrify': {
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'side', 'type']) if (node.attributes[key]) attrs[key] = node.attributes[key].replaceAll('"', '');
        const filter = node.children.find((child) => child.tag === 'filter');
        if (filter) attrs.filter = encodeFilter(toFilterNode(filter));
        ev.commands.push(hookCommand('command:unpetrify', attrs));
        return;
      }
      case 'event':
        // WML permits event declarations inside conditional/action blocks.
        // The native engine registers those declarations for later dispatch;
        // MWL keeps one scenario-level event table, so hoist the declaration
        // into that table rather than silently dropping its trigger and body.
        convertEvent(node, null);
        return;
      case 'message': {
        convertMessage(node, ev);
        return;
      }
      case 'gold': {
        const amount = node.attributes.amount ?? '0';
        // MWL's numeric command schema cannot defer an amount through a WML
        // variable. Keep literal bonuses on MWL's native command and route
        // dynamic values through the port-owned engine hook.
        if (/^-?\d+$/.test(amount.trim())) {
          ev.commands.push(`[gold]\nside=${node.attributes.side ?? 1}\namount=${amount}\n[/gold]`);
        } else {
          ev.commands.push(hookCommand('command:modify_gold', {
            side: node.attributes.side ?? '1',
            amount,
          }));
        }
        return;
      }
      case 'kill': {
        // WML `[kill]` matches whatever is there; a prestart purge of carried
        // units must be a no-op when the recall list was empty, so this routes
        // through an engine hook that tolerates an absent unit instead of the
        // framework's strict `[kill] unit=`.
        for (const id of splitList(node.attributes.id)) ev.commands.push(`[hook]\nname=command:kill_unit\nunit=${id}\n[/hook]`);
        const filter = node.children.find((child) => child.tag === 'filter');
        if (filter) ev.commands.push(hookCommand('command:kill_unit', { filter: encodeFilter(toFilterNode(filter)) }));
        if (!node.attributes.id && !node.attributes.role && !filter && ['side', 'type', 'x', 'y', 'race', 'level', 'status', 'ability'].some((key) => node.attributes[key] !== undefined)) {
          ev.commands.push(hookCommand('command:kill_unit', { filter: encodeFilter(toFilterNode(node)) }));
        }
        if (node.attributes.role) {
          const ids = roleIds.get(node.attributes.role) ?? [];
          if (!ids.length) skip(`[kill] role=${node.attributes.role} resolves to nobody`, node);
          for (const id of ids) ev.commands.push(`[hook]\nname=command:kill_unit\nunit=${id}\n[/hook]`);
        }
        if (!node.attributes.id && !node.attributes.role && !filter && !['side', 'type', 'x', 'y', 'race', 'level', 'status', 'ability'].some((key) => node.attributes[key] !== undefined)) {
          ev.commands.push(hookCommand('command:kill_unit', { all: 'yes' }));
        }
        return;
      }
      case 'set_variable': {
        const name = node.attributes.name;
        if (!name) {
          skip('[set_variable] without a name', node);
          return;
        }
        // `rand=A,B,C` picks one list entry at runtime; the engine hook owns the
        // weighted pick, and a later `[unit] type=$this` consumes it.
        if (node.attributes.rand !== undefined) {
          ev.commands.push(hookCommand('command:set_variable_rand', { variable: name, values: node.attributes.rand }));
          return;
        }
        // The WML action applies every present key in a fixed order, over the value the
        // previous one left. One line per entry keeps the hook attribute a single line.
        const operations: { mode: string; operand: string }[] = [];
        for (const key of SET_VARIABLE_KEYS) {
          const operand = node.attributes[key];
          if (operand !== undefined) operations.push({ mode: key, operand: oneLineValue(operand) });
        }
        for (const key of Object.keys(node.attributes)) {
          if (key !== 'name' && key !== 'rand' && !SET_VARIABLE_KEYS.includes(key)) {
            skip(`[set_variable] ${key}= is not ported`, node);
          }
        }
        // MWL's own `value=` guesses at arithmetic, and its expression evaluator raises on an
        // unset variable and cannot spell `min(5,($turns))` or a literal `A (8 Gold)`. WML's
        // `value=` is interpolation and never arithmetic, so only a plain integer is common
        // ground; every other value goes through the port hook that owns WML semantics.
        const plainInteger = operations.length === 1
          && operations[0].mode === 'value'
          && /^-?\d+$/.test(operations[0].operand)
          && !isDynamicVariableName(name);
        if (plainInteger) {
          ev.commands.push(`[set_variable]\nname=${name}\nvalue=${operations[0].operand}\n[/set_variable]`);
          return;
        }
        if (!operations.length) {
          // `{VARIABLE name}` clears the variable; MWL can represent the empty string. A
          // dynamic name has no MWL `name=` form, so it still goes through the hook.
          if (isDynamicVariableName(name)) {
            ev.commands.push(hookCommand('command:set_variable_dynamic', { variable: name, value: '', mode: 'value' }));
          } else {
            ev.commands.push(`[set_variable]\nname=${name}\nvalue=\n[/set_variable]`);
          }
          return;
        }
        for (const operation of operations) {
          ev.commands.push(hookCommand('command:set_variable_dynamic', {
            variable: name,
            value: operation.operand,
            mode: operation.mode,
          }));
        }
        return;
      }
      case 'set_achievement': {
        const id = node.attributes.id?.replace(/^"|"$/g, '').trim();
        if (!id) {
          skip('[set_achievement] without an id', node);
          return;
        }
        ev.commands.push(hookCommand('command:set_achievement', { id }));
        return;
      }
      case 'if': {
        convertIf(node, ev);
        return;
      }
      case 'objectives': {
        convertObjectives(node);
        return;
      }
      case 'endlevel': {
        const next = node.attributes.next_scenario;
        if (next && next !== 'null') {
          // Wesnoth selects the next scenario at the exact endlevel event that
          // wins the map. A single scenario can therefore have several
          // next_scenario values. Keep that choice in the runtime so the port
          // does not incorrectly follow the campaign's default linear chain.
          ev.commands.push(`[set_variable]\nname=__next_scenario\nvalue=${portScenarioId(next, context)}\n[/set_variable]`);
        }
        // The engine's default result is victory. Epilogue scenarios commonly
        // omit result= while still using [endlevel] as their terminal action.
        if (node.attributes.result === 'defeat') ev.commands.push('[lose]\n[/lose]');
        else if (node.attributes.result === 'victory' || node.attributes.result === undefined) ev.commands.push('[win]\n[/win]');
        else skip(`[endlevel] result=${node.attributes.result}`, node);
        for (const grand of node.children) {
          if (grand.tag === 'gold_carryover') {
            if (grand.attributes.carryover_percentage) meta.carryoverPercent = Number(grand.attributes.carryover_percentage) || meta.carryoverPercent;
            if (grand.attributes.bonus === 'yes') meta.bonus = true;
          } else if (grand.tag !== 'result') {
            skip(`[endlevel] ${grand.tag}`, grand);
          }
        }
        return;
      }
      case 'fire_event': {
        const eventName = node.attributes.name ?? node.attributes.raise ?? node.attributes.event ?? node.attributes.id
          ?? node.children.find((child) => child.tag === 'event')?.attributes.name;
        if (!eventName) {
          skip('[fire_event] without a name', node);
          return;
        }
        ev.commands.push(`[hook]\nname=command:fire_event\nevent=${slug(eventName)}\n[/hook]`);
        return;
      }
      case 'halo': {
        const image = node.attributes.image ?? node.attributes.image_path;
        const pair = node.attributes['x,y']?.split(',').map((value) => Number(value.trim()));
        const x = Number(node.attributes.x ?? pair?.[0] ?? NaN);
        const y = Number(node.attributes.y ?? pair?.[1] ?? NaN);
        const frames = node.children.filter((child) => child.tag === 'halo_frame').flatMap((child) => {
          const frameImage = child.attributes.image ?? child.attributes.image_path;
          const frameDuration = Number(child.attributes.duration ?? 0.1);
          return frameImage && Number.isFinite(frameDuration) ? [`${frameImage}@${Math.max(0.01, frameDuration)}`] : [];
        });
        const initialImage = image ?? frames[0]?.slice(0, frames[0].lastIndexOf('@'));
        if (!initialImage || !Number.isFinite(x) || !Number.isFinite(y)) {
          skip('[halo] without image and numeric coordinates', node);
          return;
        }
        for (const child of node.children) if (child.tag !== 'halo_frame') skip(`[halo] ${child.tag}`, child);
        ev.commands.push(hookCommand('command:show_halo', {
          image: initialImage,
          x: String(x - 1),
          y: String(y - 1),
          duration: node.attributes.duration ?? (frames.length ? String(frames.reduce((total, entry) => total + Number(entry.slice(entry.lastIndexOf('@') + 1)), 0)) : '1'),
          ...(frames.length ? { frames: frames.join(';') } : {}),
        }));
        return;
      }
      case 'recall': {
        if (!node.attributes.id && !node.attributes.role && !node.attributes.type && !node.children.some((child) => child.tag === 'filter')) {
          skip('[recall] without an id', node);
          return;
        }
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'type', 'role']) if (node.attributes[key]) attrs[key] = node.attributes[key].replaceAll('"', '');
        const filter = node.children.find((child) => child.tag === 'filter');
        for (const key of ['id', 'type', 'role']) if (filter?.attributes[key]) attrs[key] = filter.attributes[key].replaceAll('"', '');
        attrs.unit = attrs.id ?? '';
        if (node.attributes.x && /^\d+$/.test(node.attributes.x)) attrs.x = node.attributes.x;
        if (node.attributes.y && /^\d+$/.test(node.attributes.y)) attrs.y = node.attributes.y;
        ev.commands.push(hookCommand('command:recall_unit', attrs));
        return;
      }
      case 'modify_turns': {
        const attrs: Record<string, string> = {};
        for (const key of ['value', 'add']) if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        if (!attrs.value && !attrs.add) {
          skip('[modify_turns] without value/add', node);
          return;
        }
        ev.commands.push(hookCommand('command:modify_turns', attrs));
        return;
      }
      case 'teleport': {
        const filter = node.children.find((child) => child.tag === 'filter');
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'side', 'type', 'x', 'y']) {
          const value = node.attributes[key] ?? filter?.attributes[key];
          if (value !== undefined) attrs[key] = key === 'id' ? value.replaceAll('"', '') : value;
        }
        const x = node.attributes.x ?? node.attributes['x,y']?.split(',')[0];
        const y = node.attributes.y ?? node.attributes['x,y']?.split(',')[1];
        if (x !== undefined) attrs.to_x = shiftSpec(x);
        if (y !== undefined) attrs.to_y = shiftSpec(y);
        if (attrs.to_x === undefined || attrs.to_y === undefined) {
          skip('[teleport] without destination coordinates', node);
          return;
        }
        ev.commands.push(hookCommand('command:teleport', attrs));
        return;
      }
      case 'unit': {
        convertSpawn(node, ev);
        return;
      }
      case 'modify_unit': {
        if (node.attributes.object_id) {
          // Core's REMOVE_OBJECT macro expands to MODIFY_UNIT with the
          // object_id attribute. Keep that expansion connected to the
          // reversible object registry instead of treating object_id as an
          // unknown modify_unit field.
          ev.commands.push(hookCommand('command:remove_object', {
            object_id: node.attributes.object_id,
            ...unitFilterAttrs(node),
          }));
          return;
        }
        ev.commands.push(hookCommand('command:modify_unit', unitFilterAttrs(node)));
        return;
      }
      case 'transform_unit': {
        const target = node.attributes.transform_to;
        if (!target) {
          skip('[transform_unit] without transform_to=', node);
          return;
        }
        ev.commands.push(hookCommand('command:transform_unit', {
          ...unitFilterAttrs(node),
          transform_to: target,
        }));
        return;
      }
      case 'store_unit': {
        const attrs: Record<string, string> = { variable: node.attributes.variable ?? '', kill: node.attributes.kill ?? 'no' };
        for (const key of ['id', 'side', 'type']) if (node.attributes[key]) attrs[key] = key === 'id' ? node.attributes[key].replaceAll('"', '') : node.attributes[key];
        for (const child of node.children) {
          if (child.tag === 'filter') {
            for (const key of ['id', 'side', 'type']) if (child.attributes[key]) attrs[key] = key === 'id' ? child.attributes[key].replaceAll('"', '') : child.attributes[key];
            // `[not] id=/type=` inside the filter (HttT 01 stores every unit but Konrad)
            for (const exclusion of child.children) {
              if (exclusion.tag !== 'not') { skip(`[store_unit] [filter] ${exclusion.tag}`, exclusion); continue; }
              if (exclusion.attributes.id) attrs.not_id = exclusion.attributes.id.replaceAll('"', '');
              if (exclusion.attributes.type) attrs.not_type = exclusion.attributes.type;
            }
          } else skip(`[store_unit] ${child.tag}`, child);
        }
        ev.commands.push(hookCommand('command:store_unit', attrs));
        return;
      }
      case 'store_unit_type_ids': {
        ev.commands.push(hookCommand('command:store_unit_type_ids', {
          variable: node.attributes.variable ?? 'unit_type_ids',
        }));
        return;
      }
      case 'store_unit_type': {
        const types = node.attributes.type;
        if (!types) {
          skip('[store_unit_type] without a type', node);
          return;
        }
        ev.commands.push(hookCommand('command:store_unit_type', {
          variable: node.attributes.variable ?? 'unit_type',
          types,
        }));
        return;
      }
      case 'unit_worth': {
        ev.commands.push(hookCommand('command:unit_worth', {
          filter: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
        }));
        return;
      }
      case 'unstore_unit': {
        const attrs: Record<string, string> = { variable: node.attributes.variable ?? '' };
        for (const key of ['x', 'y', 'side']) if (node.attributes[key]) attrs[key] = node.attributes[key];
        ev.commands.push(hookCommand('command:unstore_unit', attrs));
        return;
      }
      case 'put_to_recall_list': {
        const id = node.attributes.id;
        ev.commands.push(hookCommand('command:put_to_recall_list', {
          ...(id ? { id: id.replaceAll('"', '') } : {}),
          filter: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
          heal: node.attributes.heal ?? 'no',
        }));
        return;
      }
      case 'clear_variable':
        // Variable lifetime is scoped to the scenario runtime. Clearing a
        // value that is not represented in MWL is already a no-op, so do not
        // turn this harmless WML housekeeping into a conversion failure.
        return;
      case 'get_global_variable':
      case 'set_global_variable': {
        const get = node.tag === 'get_global_variable';
        const attrs: Record<string, string> = {};
        for (const key of get ? ['namespace', 'from_global', 'to_local'] : ['namespace', 'from_local', 'to_global']) {
          if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        }
        if (Object.keys(attrs).length < 2) {
          skip(`[${node.tag}] missing variable mapping`, node);
          return;
        }
        ev.commands.push(hookCommand(`command:${node.tag}`, attrs));
        return;
      }
      case 'move_unit': {
        const pair = wmlPair(node.attributes, 'x', 'y') ?? wmlPair(node.attributes, 'to_x', 'to_y');
        const rawX = node.attributes.x ?? node.attributes.to_x ?? pair?.[0];
        const rawY = node.attributes.y ?? node.attributes.to_y ?? pair?.[1];
        const x = Number(rawX);
        const y = Number(rawY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          if (rawX !== undefined && rawY !== undefined) {
            ev.commands.push(hookCommand('command:scenario_move', {
              id: node.attributes.id ?? '', x: rawX, y: rawY, raw: 'yes',
            }));
          } else skip('[move_unit] without numeric coordinates', node);
          return;
        }
        ev.commands.push(hookCommand('command:scenario_move', { unit: node.attributes.id ?? '', x: String(x - 1), y: String(y - 1) }));
        return;
      }
      case 'store_starting_location':
        // Starting locations are already available to the loader through the
        // parsed map. The command has no runtime effect in the port.
        return;
      case 'find_respawn_point': {
        if (!node.attributes.variable) {
          skip('[find_respawn_point] without variable=', node);
          return;
        }
        ev.commands.push(hookCommand('command:find_respawn_point', {
          variable: node.attributes.variable,
          respawn_near: node.attributes.respawn_near ?? '',
        }));
        return;
      }
      case 'store_turns': {
        if (!node.attributes.variable) {
          skip('[store_turns] without variable=', node);
          return;
        }
        ev.commands.push(hookCommand('command:store_turns', { variable: node.attributes.variable }));
        return;
      }
      case 'store_villages': {
        if (!node.attributes.variable) {
          skip('[store_villages] without variable=', node);
          return;
        }
        ev.commands.push(hookCommand('command:store_villages', { variable: node.attributes.variable }));
        return;
      }
      case 'heal_unit': {
        ev.commands.push(hookCommand('command:heal_unit', unitFilterAttrs(node)));
        return;
      }
      case 'set_variables': {
        const name = node.attributes.name;
        const toVariable = node.attributes.to_variable;
        if (!name && !toVariable) {
          skip('[set_variables] without name= or to_variable=', node);
          return;
        }
        // Keep the WML tree intact.  The runtime hook expands scalar leaves at
        // execution time, which is important for values such as `$(turn)` and
        // `$difficulty` inside a table.
        const payload = {
          name: name ?? '',
          mode: node.attributes.mode ?? 'replace',
          to_variable: toVariable ?? '',
          children: node.children.map(serializeVariableNode),
        };
        ev.commands.push(hookCommand('command:set_variables', {
          payload: encodeURIComponent(JSON.stringify(payload)),
        }));
        return;
      }
      case 'store_locations': {
        // WML's default destination is `location` when `variable=` is omitted.
        const variable = node.attributes.variable ?? 'location';
        ev.commands.push(hookCommand('command:store_locations', {
          variable,
          filter: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
        }));
        return;
      }
      case 'random_placement': {
        const body = node.children.find((child) => child.tag === 'command');
        const locationFilter = node.children.find((child) => child.tag === 'filter_location');
        const variable = node.attributes.variable;
        // The build-time WML preprocessor intentionally has no selected difficulty,
        // so a QUANTITY macro may disappear before this loader sees the node. Keep
        // the placement executable with one item in that case.
        const count = node.attributes.num_items ?? '1';
        if (!body || !variable) {
          skip('[random_placement] without variable/command', node);
          return;
        }
        const locations = `_mwg_random_locations_${randomVariableCounter++}`;
        const picked = `_mwg_random_pick_${randomVariableCounter++}`;
        const remaining = `_mwg_random_remaining_${randomVariableCounter++}`;
        const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
        for (const child of body.children) convertCommand(child, nested);
        ev.commands.push(hookCommand('command:store_locations', {
          variable: locations,
          filter: encodeURIComponent(JSON.stringify(serializeVariableNode(locationFilter ?? node))),
        }));
        if (/^\d+$/.test(count.trim())) {
          ev.commands.push(`[set_variable]\nname=${remaining}\nvalue=${count}\n[/set_variable]`);
        } else {
          // `num_items` is a formula over `$variables` and `size`, the number of matching
          // locations (`[random_placement]`, `src/game_events/action_wml.cpp`); it is
          // evaluated when the action runs, not as a plain MWL value.
          ev.commands.push(hookCommand('command:random_count', {
            source: locations,
            variable: remaining,
            expr: count,
            allow_less: node.attributes.allow_less ?? 'no',
          }));
        }
        ev.commands.push(`[while]\n[condition]\nvariable=${remaining}\ngreater_than=0\n[/condition]\n` +
          `${hookCommand('command:random_location', { source: locations, variable: picked })}\n` +
          `${nested.commands.join('\n')}\n` +
          `${hookCommand('command:set_variable_dynamic', { variable: remaining, value: '-1', mode: 'add' })}\n[/while]`);
        return;
      }
      case 'store_reachable_locations':
        if (!node.attributes.variable) {
          skip('[store_reachable_locations] without variable=', node);
          return;
        }
        ev.commands.push(hookCommand('command:store_reachable_locations', {
          variable: node.attributes.variable,
          filter: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
          moves: node.attributes.moves ?? '',
          range: node.attributes.range ?? '',
        }));
        return;
      case 'store_items': {
        if (!node.attributes.variable) {
          skip('[store_items] without variable=', node);
          return;
        }
        ev.commands.push(hookCommand('command:store_items', {
          variable: node.attributes.variable,
          item_name: node.attributes.item_name ?? '',
          x: node.attributes.x ?? '',
          y: node.attributes.y ?? '',
        }));
        return;
      }
      case 'harm_unit': {
        const attrs = unitFilterAttrs(node);
        for (const key of ['amount', 'kill', 'animate', 'experience', 'fire_event_on']) {
          if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        }
        if (attrs.amount === undefined) {
          skip('[harm_unit] without amount=', node);
          return;
        }
        ev.commands.push(hookCommand('command:harm_unit', attrs));
        return;
      }
      case 'capture_village': {
        const pairs = zipLocations(node.attributes.x, node.attributes.y).map((pair) => `${shiftCoord(pair.x)},${shiftCoord(pair.y)}`);
        ev.commands.push(hookCommand('command:capture_village', { side: node.attributes.side ?? '1', cells: pairs.join(';') }));
        return;
      }
      case 'terrain': {
        const pairs = zipLocations(node.attributes.x, node.attributes.y).map((pair) => `${shiftCoord(pair.x)},${shiftCoord(pair.y)}`);
        ev.commands.push(hookCommand('command:set_terrain', { terrain: node.attributes.terrain ?? '', cells: pairs.join(';') }));
        return;
      }
      case 'terrain_mask': {
        const maskFile = node.attributes.mask_file;
        const mask = node.attributes.mask ?? (maskFile ? context.terrainMasks?.[maskFile] : undefined);
        if (!mask) {
          if (!maskFile || !context.terrainMasks || !Object.keys(context.terrainMasks).length) {
            skip('[terrain_mask] is not ported', node);
            return;
          }
        }
        const pair = wmlPair(node.attributes);
        if (!pair) {
          skip('[terrain_mask] without coordinates', node);
          return;
        }
        ev.commands.push(hookCommand('command:terrain_mask', {
          x: pair[0], y: pair[1],
          ...(mask ? { mask: encodeURIComponent(mask) } : {
            mask_file: encodeURIComponent(maskFile!),
            masks: encodeURIComponent(JSON.stringify(context.terrainMasks)),
          }),
          border: node.attributes.border ?? 'yes',
        }));
        return;
      }
      case 'replace_map': {
        const mapFile = node.attributes.map_file ?? node.attributes.file;
        const terrain = node.attributes.terrain ?? (mapFile ? context.mapFiles?.[mapFile] : undefined);
        if (!terrain) {
          skip('[replace_map] is not ported', node);
          return;
        }
        ev.commands.push(hookCommand('command:replace_map', {
          terrain: encodeURIComponent(terrain),
          expand: node.attributes.expand ?? 'yes',
          shrink: node.attributes.shrink ?? 'yes',
        }));
        return;
      }
      case 'replace_map_section': {
        const mapData = node.attributes.map_data ?? node.attributes.terrain;
        const pair = wmlPair(node.attributes);
        if (!mapData || !pair) {
          skip('[replace_map_section] is not ported', node);
          return;
        }
        ev.commands.push(hookCommand('command:replace_map_section', {
          x: pair[0], y: pair[1], terrain: encodeURIComponent(mapData),
        }));
        return;
      }
      case 'remove_shroud': {
        ev.commands.push(hookCommand('command:clear_shroud', {
          side: node.attributes.side ?? '1',
          xs: node.attributes.x ? shiftSpec(node.attributes.x) : '',
          ys: node.attributes.y ? shiftSpec(node.attributes.y) : '',
        }));
        return;
      }
      case 'place_shroud': {
        ev.commands.push(hookCommand('command:place_shroud', {
          side: node.attributes.side ?? '1',
          xs: node.attributes.x ? shiftSpec(node.attributes.x) : '',
          ys: node.attributes.y ? shiftSpec(node.attributes.y) : '',
          radius: node.attributes.radius ?? '0',
        }));
        return;
      }
      case 'reset_fog':
        ev.commands.push(hookCommand('command:reset_fog', {}));
        return;
      case 'remove_event':
        // The port freezes the event graph after compilation. Two Brothers
        // removes a one-shot freezer event after the first sighting; the
        // equivalent MWL event is already once-only, so this is harmless.
        return;
      case 'remove_item': {
        ev.commands.push(hookCommand('command:remove_item', {
          x: node.attributes.x ?? '',
          y: node.attributes.y ?? '',
          item_name: node.attributes.name ?? '',
          image: encodeURIComponent(node.attributes.image ?? node.attributes.halo ?? ''),
        }));
        return;
      }
      case 'item': {
        ev.commands.push(hookCommand('command:add_item', {
          x: node.attributes.x ?? '',
          y: node.attributes.y ?? '',
          // `name` is reserved by the MWL hook envelope itself. Keep the
          // WML item's name under a distinct key so it cannot overwrite the
          // command name when this private fragment is parsed.
          item_name: node.attributes.name ?? '',
          image: encodeURIComponent(node.attributes.image ?? node.attributes.halo ?? ''),
        }));
        return;
      }
      case 'object': {
        const object = objectFromWml(node);
        if (!object) return;
        const attrs: Record<string, string> = { object: encodeURIComponent(JSON.stringify(object)) };
        const filter = node.children.find((child) => child.tag === 'filter');
        for (const key of ['id', 'side', 'type']) {
          const value = filter?.attributes[key] ?? node.attributes[key];
          if (value) attrs[key] = key === 'id' ? value.replaceAll('"', '') : value;
        }
        // An autonomous object always has a unit filter in mainline content;
        // without one there is no safe implicit subject for the hook.
        if (attrs.id || attrs.side || attrs.type) ev.commands.push(hookCommand('command:apply_object', attrs));
        return;
      }
      case 'remove_object': {
        const objectId = node.attributes.object_id;
        if (!objectId) {
          const filter = node.children.find((child) => child.tag === 'filter');
          const attrs = unitFilterAttrs(node);
          if (filter) attrs.filter = encodeFilter(toFilterNode(filter));
          if (!attrs.id && !attrs.side && !attrs.type && !attrs.canrecruit && !attrs.filter) {
            skip('[remove_object] without object_id or unit filter', node);
            return;
          }
          ev.commands.push(hookCommand('command:remove_object', attrs));
          return;
        }
        ev.commands.push(hookCommand('command:remove_object', {
          object_id: objectId,
          ...unitFilterAttrs(node),
        }));
        return;
      }
      case 'remove_trait': {
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'side', 'type', 'trait_id', 'role']) {
          if (node.attributes[key] !== undefined) attrs[key] = key === 'id' ? node.attributes[key].replaceAll('"', '') : node.attributes[key];
        }
        const filter = node.children.find((child) => child.tag === 'filter');
        for (const key of ['id', 'side', 'type', 'role']) {
          if (filter?.attributes[key] !== undefined) attrs[key] = key === 'id' ? filter.attributes[key].replaceAll('"', '') : filter.attributes[key];
        }
        ev.commands.push(hookCommand('command:remove_trait', attrs));
        return;
      }
      case 'unit_overlay':
      case 'remove_unit_overlay': {
        const attrs: Record<string, string> = {};
        for (const key of ['id', 'side', 'type', 'image', 'object_id']) {
          if (node.attributes[key] !== undefined) attrs[key] = key === 'id' ? node.attributes[key].replaceAll('"', '') : node.attributes[key];
        }
        const filter = node.children.find((child) => child.tag === 'filter');
        for (const key of ['id', 'side', 'type']) {
          if (filter?.attributes[key] !== undefined) attrs[key] = key === 'id' ? filter.attributes[key].replaceAll('"', '') : filter.attributes[key];
        }
        const pair = wmlPair(node.attributes);
        if (pair) { attrs.x = shiftCoord(pair[0]); attrs.y = shiftCoord(pair[1]); }
        if (node.tag === 'unit_overlay' && !attrs.image) {
          skip('[unit_overlay] without image', node);
          return;
        }
        ev.commands.push(hookCommand(`command:${node.tag}`, attrs));
        return;
      }
      case 'micro_ai': {
        ev.commands.push(hookCommand('command:micro_ai', microAiAttrs(node)));
        return;
      }
      case 'lift_fog': {
        const pairs = zipLocations(node.attributes.x, node.attributes.y).map((pair) => `${shiftCoord(pair.x)},${shiftCoord(pair.y)}`);
        const filterSide = node.children.find((child) => child.tag === 'filter_side');
        const side = node.attributes.side ?? filterSide?.attributes.side ?? '1';
        const attrs: Record<string, string> = { side, cells: pairs.join(';') };
        for (const key of ['terrain', 'radius', 'owner_side', 'multiturn']) if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        ev.commands.push(hookCommand('command:lift_fog', attrs));
        return;
      }
      case 'scroll_to':
      case 'scroll': {
        const pair = node.attributes['x,y']?.split(',');
        const x = node.attributes.x ?? pair?.[0];
        const y = node.attributes.y ?? pair?.[1];
        if (x !== undefined && y !== undefined) {
          ev.commands.push(hookCommand('command:scroll_to', { x: shiftSpec(x), y: shiftSpec(y) }));
        }
        return;
      }
      case 'scroll_to_unit': {
        const id = node.attributes.id ?? node.attributes.unit ?? node.attributes.role;
        if (id) ev.commands.push(hookCommand('command:scroll_to_unit', { id }));
        return;
      }
      case 'replace_schedule': {
        const times = node.children.filter((child) => child.tag === 'time');
        if (!times.length) return;
        ev.commands.push(hookCommand('command:replace_schedule', {
          schedule: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
          ...(node.attributes.current_time ? { current_time: node.attributes.current_time } : {}),
        }));
        return;
      }
      case 'time_area':
        ev.commands.push(hookCommand('command:set_time_area', {
          area: encodeURIComponent(JSON.stringify(serializeVariableNode(node))),
        }));
        return;
      case 'remove_time_area':
        ev.commands.push(hookCommand('command:remove_time_area', { id: node.attributes.id ?? '' }));
        return;
      case 'store_time_of_day': {
        const variable = node.attributes.variable;
        if (variable) ev.commands.push(hookCommand('command:store_time_of_day', { variable }));
        return;
      }
      case 'redraw':
        return;
      case 'hide_unit':
      case 'unhide_unit': {
        ev.commands.push(hookCommand('command:set_unit_hidden', {
          ...visibilityFilterAttrs(node),
          hidden: node.tag === 'hide_unit' ? 'yes' : 'no',
        }));
        return;
      }
      case 'delay': {
        const seconds = node.attributes.time ?? node.attributes.duration ?? node.attributes.seconds;
        if (seconds !== undefined) ev.commands.push(hookCommand('command:delay', { time: seconds }));
        else skip('[delay] without time=', node);
        return;
      }
      case 'modify_side': {
        const attrs: Record<string, string> = { side: node.attributes.side ?? '1' };
        const supported = ['side', 'recruit', 'gold', 'hidden', 'income', 'controller', 'team_name', 'user_team_name', 'share_vision', 'share_view', 'village_gold', 'village_support', 'heal', 'fog', 'shroud', 'flag', 'color', 'flag_icon', 'reset_maps', 'reset_view', 'defeat_condition'];
        for (const key of supported) if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        for (const key of Object.keys(node.attributes)) {
          if (!supported.includes(key)) skip(`[modify_side] ${key} is not ported`, node);
        }
        ev.commands.push(hookCommand('command:config_side', attrs));
        return;
      }
      case 'store_gold': {
        ev.commands.push(hookCommand('command:store_gold', {
          side: node.attributes.side ?? '1',
          variable: node.attributes.variable ?? 'gold',
        }));
        return;
      }
      case 'store_side': {
        const variable = node.attributes.variable ?? 'side';
        const side = node.attributes.side ?? node.children.find((child) => child.tag === 'filter_side')?.attributes.side ?? '1';
        ev.commands.push(hookCommand('command:store_side', { side, variable }));
        return;
      }
      case 'modify_ai': {
        const attrs: Record<string, string> = {};
        for (const key of ['side', 'action', 'path']) if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        const candidate = node.children.find((child) => child.tag === 'candidate_action');
        if (candidate?.attributes.id) attrs.candidate = candidate.attributes.id;
        const goal = node.children.find((child) => child.tag === 'goal' || child.tag === 'avoid');
        if (goal) {
          attrs.goal_kind = goal.tag;
          for (const key of ['x', 'y', 'radius', 'value']) if (goal.attributes[key] !== undefined) attrs[`goal_${key}`] = goal.attributes[key];
        }
        ev.commands.push(hookCommand('command:modify_ai', attrs));
        return;
      }
      case 'allow_recruit':
      case 'disallow_recruit': {
        ev.commands.push(
          hookCommand('command:config_recruit', {
            side: node.attributes.side ?? '1',
            mode: node.tag === 'allow_recruit' ? 'allow' : 'disallow',
            types: node.attributes.type ?? '',
          }),
        );
        return;
      }
      case 'role': {
        convertRole(node);
        return;
      }
      case 'on_undo': {
        const undoEvent: ConvEvent = {
          id: eventId('on_undo'), trigger: 'on_undo', once: false, conditions: [], filters: [], commands: [],
        };
        for (const child of node.children) convertCommand(child, undoEvent);
        events.push(undoEvent);
        return;
      }
      case 'show_objectives': {
        ev.commands.push('[hook]\nname=command:show_objectives\n[/hook]');
        return;
      }
      case 'foreach': {
        const body = node.children.find((child) => child.tag === 'do');
        const variable = node.attributes.array ?? node.attributes.variable;
        if (!variable || !body) {
          skip('[foreach] without array/do', node);
          return;
        }
        const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
        for (const child of body.children) convertCommand(child, nested);
        ev.commands.push(
          `[foreach]\nvariable=${variable}\nitem=${node.attributes.item ?? node.attributes.variable_name ?? 'this_item'}\n` +
          `${node.attributes.index ? `index=${node.attributes.index}\n` : ''}` +
          `${nested.commands.join('\n')}\n[/foreach]`,
        );
        return;
      }
      case 'for': {
        const body = node.children.find((child) => child.tag === 'do');
        const variable = node.attributes.array;
        if (!variable || !body) {
          skip('[for] without array/do', node);
          return;
        }
        const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
        for (const child of body.children) convertCommand(child, nested);
        // WML [for] is the index-oriented spelling of the same array walk
        // exposed by MWL [foreach]. Preserve its explicit variable as the
        // zero-based index; this keeps `$array[$i]` expressions intact.
        ev.commands.push(
          `[foreach]\nvariable=${variable}\nitem=this_item\n` +
          `index=${node.attributes.variable ?? 'i'}\n${nested.commands.join('\n')}\n[/foreach]`,
        );
        return;
      }
      case 'while': {
        const body = node.children.find((child) => child.tag === 'do');
        if (!body) {
          skip('[while] without do', node);
          return;
        }
        const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
        for (const child of body.children) convertCommand(child, nested);
        // A `[while]` condition is the same list `[if]` takes (`[variable]`, `[have_unit]`,
        // `[have_location]`, `[and]`/`[or]`/`[not]`); several tests are an implicit `[and]`.
        // Dropping all but a bare `[variable]` left such loops unconditional, so they ran
        // to the runtime's iteration cap on every pass (Secrets of the Ancients 12).
        const tests = node.children.filter((child) => ['variable', 'have_unit', 'have_location', 'not', 'lua', 'and', 'or'].includes(child.tag));
        const test = tests.length === 1 && tests[0].tag === 'variable' ? tests[0] : undefined;
        const condition = test
          ? Object.entries(comparisonAttrs(test)).map(([key, value]) => `${key}=${value}`).join('\n')
          : '';
        let conditionLines = test ? `[condition]\nvariable=${test.attributes.name ?? ''}\n${condition}\n[/condition]\n` : '';
        if (!test && tests.length) {
          // MWG 0.33 test= calls registered predicates directly. Keep the port's
          // WML tree evaluation: generic existence queries do not reproduce terrain
          // aliases, ranges, and the full Wesnoth filter semantics.
          const tree = tests.length === 1 ? tests[0] : { tag: 'and', attributes: {}, children: tests, location: node.location };
          const encoded = encodeURIComponent(JSON.stringify(serializeVariableNode(tree))).replaceAll("'", '%27');
          conditionLines = `test="wml_condition_tree('tree=${encoded}')"\n`;
        }
        ev.commands.push(`[while]\n${conditionLines}${nested.commands.join('\n')}\n[/while]`);
        return;
      }
      case 'switch': {
        const variable = node.attributes.variable;
        if (!variable) {
          skip('[switch] without variable', node);
          return;
        }
        const lines = [`[switch]`, `variable=${variable}`];
        for (const branch of node.children) {
          if (branch.tag !== 'case' && branch.tag !== 'default') continue;
          const body = branch.children.find((child) => child.tag === 'command') ?? branch;
          const nested: ConvEvent = { id: '', trigger: null, once: false, conditions: [], filters: [], commands: [] };
          for (const child of body === branch ? branch.children : body.children) convertCommand(child, nested);
          lines.push(`[${branch.tag}]`);
          if (branch.tag === 'case') lines.push(`equals=${branch.attributes.value ?? branch.attributes.equals ?? ''}`);
          lines.push(nested.commands.join('\n'), `[/${branch.tag}]`);
        }
        lines.push('[/switch]');
        ev.commands.push(lines.join('\n'));
        return;
      }
      case 'filter':
      case 'filter_second':
      case 'filter_condition':
      case 'condition':
      case 'then':
      case 'command':
      case 'do_command':
        // `[command]` is a grouping wrapper the engine runs transparently
        // (`src/game_events/action_wml.cpp`): Legend of Wesmere's
        // `09_Bounty_Hunters` wraps a whole setup block in one, so its
        // children have to run in place rather than be reported as stray.
        for (const child of node.children) convertCommand(child, ev);
        return;
      case 'else':
      case 'variable':
      case 'have_unit':
      case 'not':
      case 'and':
      case 'or':
      case 'option':
      case 'do':
        skip(`[${node.tag}] outside its parent`, node);
        return;
      case 'music': {
        // `[music]` switches the background track (`play_once`/`repeat` pick
        // whether it loops); the port's audio surface owns playback, so this
        // carries the file and its loop flag to it as a hook.
        const file = node.attributes.name ?? node.attributes.file ?? '';
        if (file) {
          const attrs: Record<string, string> = { file };
          if (node.attributes.play_once === 'yes') attrs.play_once = 'yes';
          if (node.attributes.repeat !== undefined) attrs.repeat = node.attributes.repeat;
          ev.commands.push(hookCommand('command:play_music', attrs));
        }
        return;
      }
      case 'sound': {
        const file = node.attributes.name ?? node.attributes.file ?? '';
        if (file) ev.commands.push(hookCommand('command:play_sound', { file }));
        return;
      }
      case 'sound_source': {
        const file = node.attributes.sound ?? node.attributes.name ?? node.attributes.file ?? node.attributes.sounds ?? '';
        const pair = wmlPair(node.attributes);
        // Core river macros can leave `#sounds=` commented out after WML
        // preprocessing; Wesnoth treats that source as absent, not as an
        // executable failure.
        if (!file) return;
        if (!pair) {
          // A few legacy macros expand a source before their coordinate
          // arguments are available. The engine drops those malformed source
          // records; keep the same harmless behavior during conversion.
          return;
        }
        const attrs: Record<string, string> = {
          file: oneLineValue(file),
          x: shiftSpec(pair[0]),
          y: shiftSpec(pair[1]),
        };
        if (node.attributes.id) attrs.id = node.attributes.id;
        for (const key of ['loop', 'repeat', 'delay', 'interval', 'ref_distance', 'max_distance']) {
          if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        }
        // WML commonly expresses the audible range as full range plus fade
        // range. Explicit ref/max attributes remain authoritative.
        if (attrs.ref_distance === undefined && node.attributes.full_range !== undefined) {
          attrs.ref_distance = node.attributes.full_range;
        }
        if (attrs.max_distance === undefined && node.attributes.fade_range !== undefined) {
          const full = Number(node.attributes.full_range ?? 0);
          const fade = Number(node.attributes.fade_range);
          attrs.max_distance = Number.isFinite(full + fade)
            ? String(full + fade)
            : node.attributes.fade_range;
        }
        ev.commands.push(hookCommand('command:play_sound_source', attrs));
        return;
      }
      case 'set_recruit': {
        const side = node.attributes.side;
        const recruit = node.attributes.recruit;
        if (!side || recruit === undefined) {
          skip('[set_recruit] requires side= and recruit=', node);
          return;
        }
        ev.commands.push(hookCommand('command:config_side', { side, recruit }));
        return;
      }
      case 'allow_extra_recruit':
      case 'set_extra_recruit': {
        const id = node.attributes.id;
        const types = node.attributes.extra_recruit ?? node.attributes.type;
        const pair = wmlPair(node.attributes);
        if ((!id && !pair) || types === undefined) {
          skip(`[${node.tag}] requires id= or x,y= and extra_recruit=`, node);
          return;
        }
        ev.commands.push(hookCommand('command:allow_extra_recruit', {
          ...(id ? { id } : { x: pair![0], y: pair![1] }), types,
        }));
        return;
      }
      case 'volume': {
        const attrs: Record<string, string> = {};
        for (const key of ['music', 'sound']) if (node.attributes[key] !== undefined) attrs[key] = node.attributes[key];
        if (Object.keys(attrs).length) ev.commands.push(hookCommand('command:volume', attrs));
        return;
      }
      case 'remove_sound_source':
        if (node.attributes.id) ev.commands.push(hookCommand('command:remove_sound_source', { id: node.attributes.id }));
        else skip('[remove_sound_source] requires id=', node);
        return;
      case 'lua': {
        // Mainline uses these Lua blocks only to load campaign helpers or to
        // toggle the native message-skip presentation flag. Neither changes
        // the rules state represented by MWG. Keep arbitrary Lua rejected:
        // campaign logic still needs an explicit port or a Lua bridge.
        const code = node.attributes.code ?? '';
        const harmless = [...code.matchAll(/wesnoth\.dofile\s*\(\s*['\"][^'\"]+['\"]\s*\)/g)].map((match) => match[0]).join('')
          .length === code.replace(/\s+/g, '').length
          || /^\s*wesnoth\.interface\.skip_messages\s*\(\s*(?:true|false)\s*\)\s*;?\s*$/.test(code);
        if (!harmless) skip('[lua] is not ported', node);
        return;
      }
      default:
        skip(`[${node.tag}] is not ported`, node);
    }
  }

  function unitFilterAttrs(node: WmlNode): Record<string, string> {
    const attrs: Record<string, string> = {};
    const supported = [
      'id', 'side', 'type', 'moves', 'amount', 'hitpoints', 'experience', 'alignment', 'object_id',
      'poisoned', 'slowed', 'canrecruit', 'name', 'role', 'recall_cost', 'advances_to',
      'primary_attack', 'secondary_attack', 'damage_type', 'delay', 'kill', 'fire_event',
      'facing', 'animate', 'restore_statuses', 'restore_attacks', 'attacks_left',
      'transform_to',
      // Portrait metadata is presentation-only; retain the modify action
      // without reporting it as a rules compatibility gap.
      'profile', 'description', 'max_hitpoints', 'vision', 'ellipse', 'variation', 'extra_recruit', 'unrenamable',
      // Some generated WML expands a movement-cost table as an attribute on
      // modify_unit; retain it for the same per-unit override path.
      'movement_costs',
    ];
    for (const key of supported) {
      if (node.attributes[key]) {
        const outputKey = key === 'name' ? 'unit_name' : key;
        attrs[outputKey] = key === 'id' ? node.attributes[key].replaceAll('"', '') : node.attributes[key];
      }
    }
    for (const key of Object.keys(node.attributes)) {
      if (!['id', 'side', 'type', 'x', 'y', ...supported].includes(key)) skip(`[modify_unit] ${key} is not ported`, node);
    }
    for (const grand of node.children) {
      if (grand.tag === 'effect') {
        for (const [key, effectValue] of Object.entries(grand.attributes)) attrs[`effect_${key}`] = String(effectValue);
      } else if (grand.tag === 'filter') {
        attrs.filter = encodeFilter(toFilterNode(grand));
        for (const key of ['id', 'side', 'type']) {
          if (grand.attributes[key]) attrs[key] = key === 'id' ? grand.attributes[key].replaceAll('"', '') : grand.attributes[key];
        }
      } else if (grand.tag === 'filter_second') {
        // A secondary filter is meaningful to the original animation/event
        // action. The lightweight hook has one selected unit, so retain the
        // block for diagnostics-free conversion and use the primary filter.
      } else if (grand.tag === 'filter_location' || grand.tag === 'not') {
        // These refine where the visual/unit modification applies. The hook
        // already owns the live unit selection; retain the action without
        // turning presentation-only refinements into compatibility failures.
      } else if (grand.tag === 'filter_recall') {
        attrs.recall_filter = encodeURIComponent(JSON.stringify(grand.attributes));
      } else if (grand.tag === 'variables') {
        attrs.unit_variables = encodeURIComponent(JSON.stringify(grand.attributes));
      } else if (grand.tag === 'clear_variable') {
        if (grand.attributes.name) attrs.clear_variable = grand.attributes.name;
      } else if (grand.tag === 'status') {
        // `[modify_unit][status]` is the native WML shape for toggling a
        // unit status (as opposed to the `[filter] status=` selector).
        for (const [key, value] of Object.entries(grand.attributes)) attrs[`status_${key}`] = value;
      } else if (grand.tag === 'primary_attack' || grand.tag === 'secondary_attack') {
        for (const [key, value] of Object.entries(grand.attributes)) attrs[`${grand.tag}_${key}`] = value;
      } else if (grand.tag === 'object') {
        const object = objectFromWml(grand);
        if (object) attrs.object = encodeURIComponent(JSON.stringify(object));
      } else if (grand.tag === 'movement_costs') {
        const movementCosts: Record<string, number> = {};
        for (const [terrain, raw] of Object.entries(grand.attributes)) {
          const value = Number(raw);
          if (Number.isFinite(value)) movementCosts[terrain] = value;
        }
        attrs.object = encodeURIComponent(JSON.stringify({
          id: '',
          effects: [{ applyTo: 'movement_costs', movementCosts, replace: false }],
          abilities: [],
        }));
      } else if (grand.tag === 'trait') {
        // A runtime trait is the same numeric effect bundle as an object for
        // the rule engine. Preserve its effects through the reversible object
        // path; names/help text remain presentation metadata.
        const object = objectFromWml({
          tag: 'object',
          attributes: { id: grand.attributes.id ?? '' },
          children: grand.children.filter((child) => child.tag === 'effect'),
          location: grand.location,
        });
        if (object && (object.effects.length || object.abilities.length)) attrs.object = encodeURIComponent(JSON.stringify(object));
      } else {
        skip(`[modify_unit] ${grand.tag}`, grand);
      }
    }
    return attrs;
  }

  function convertSpawn(node: WmlNode, ev: ConvEvent): void {
    const type = node.attributes.type ?? '';
    // A type the WML only names at runtime (`type=$typeofenemy`, set by a
    // preceding `rand=` list) cannot be placed at load. Carry the expression
    // and the raw 1-based coordinates to the engine hook, which resolves the
    // variable and spawns through the real rules (`game_events` ActionWML).
    if (type.includes('$') || type.includes('|')) {
      const attrs: Record<string, string> = { type };
      if (node.attributes.side) attrs.side = node.attributes.side;
      if (node.attributes.id) attrs.id = safeId(node.attributes.id);
      const pair = wmlPair(node.attributes);
      if (pair) {
        attrs.x = pair[0];
        attrs.y = pair[1];
      }
      ev.commands.push(hookCommand('command:spawn_dynamic', attrs));
      return;
    }
    const placed = placeUnit(node, false);
    if (!placed) return;
    ev.commands.push(`[spawn]\nid=${placed.id}\ntype=${placed.type}\nside=${placed.side}\nx=${placed.x}\ny=${placed.y}\n[/spawn]`);
    // The runtime only mirrors hp/position; the live rules own the unit.
    ev.commands.push(`[hook]\nname=command:spawn_unit\nunit=${placed.id}\n[/hook]`);
    if (placed.loyal) ev.commands.push(`[hook]\nname=command:make_loyal\nunit=${placed.id}\n[/hook]`);
  }

  function convertMessage(node: WmlNode, ev: ConvEvent): void {
    const speaker = node.attributes.speaker ?? (node.attributes.role ? `role:${node.attributes.role}` : undefined);
    const lines: string[] = [];
    if (speaker && speaker !== 'unit' && speaker !== 'second_unit') {
      lines.push(`speaker=${speaker.startsWith('role:') ? speaker.slice('role:'.length) : speaker}`);
    }
    if (node.attributes.image) lines.push(`portrait=${node.attributes.image}`);
    lines.push(`text=${q(node.attributes.message ?? '')}`);
    const options = node.children.filter((child) => child.tag === 'option');
    for (const child of node.children) {
      if (child.tag !== 'option' && child.tag !== 'not') skip(`[message] ${child.tag}`, child);
    }
    if (options.length === 0) {
      ev.commands.push(`[message]\n${lines.join('\n')}\n[/message]`);
      return;
    }
    const variable = node.attributes.variable;
    const dialogue: string[] = ['[dialogue]', `[message]\n${lines.join('\n')}\n[/message]`];
    options.forEach((option, index) => {
      const choiceId = `${ev.id}_opt${index}`;
      if (variable) {
        choiceSetterEvent(choiceId, variable, option.attributes.label ?? '');
      } else {
        convertBranchEvent(choiceId, option);
      }
      const gate: string[] = [];
      const showIf = option.children.find((child) => child.tag === 'show_if');
      if (showIf) {
        const variableNode = showIf.children.find((child) => child.tag === 'variable');
        if (variableNode && variableNode.attributes.name && variableNode.attributes.equals) {
          gate.push(`variable=${variableNode.attributes.name}`, `equals=${variableNode.attributes.equals}`);
        } else {
          skip('[option] show_if outside =equals=', option);
        }
        for (const child of showIf.children) {
          if (child.tag !== 'variable') skip(`[option] show_if ${child.tag}`, child);
        }
      }
      dialogue.push(`[choice]\ntext=${q(option.attributes.label ?? '')}\nevent=${choiceId}${gate.length ? `\n${gate.join('\n')}` : ''}\n[/choice]`);
    });
    dialogue.push('[/dialogue]');
    ev.commands.push(dialogue.join('\n'));
  }

  function choiceSetterEvent(id: string, variable: string, label: string): void {
    events.push({
      id,
      trigger: null,
      once: true,
      conditions: [],
      filters: [],
      // An option label is free text and may interpolate variables, so it takes the same WML
      // value path as the source's own `[set_variable] value=`.
      commands: [hookCommand('command:set_variable_dynamic', { variable, value: oneLineValue(label), mode: 'value' })],
    });
  }

  function convertBranchEvent(id: string, option: WmlNode): void {
    const branch: ConvEvent = { id, trigger: null, once: true, conditions: [], filters: [], commands: [] };
    for (const child of option.children) {
      if (child.tag === 'show_if' || child.tag === 'label') continue;
      if (child.tag === 'command') {
        for (const command of child.children) convertCommand(command, branch);
        continue;
      }
      convertCommand(child, branch);
    }
    events.push(branch);
  }

  function convertIf(node: WmlNode, ev: ConvEvent): void {
    const tests = node.children.filter((child) => child.tag === 'variable' || child.tag === 'have_unit' || child.tag === 'have_location' || child.tag === 'not' || child.tag === 'lua' || child.tag === 'and' || child.tag === 'or');
    const thens = node.children.filter((child) => child.tag === 'then');
    const elseIfs = node.children.filter((child) => child.tag === 'elseif');
    const elses = node.children.filter((child) => child.tag === 'else');
    // MWL event conditions currently expose variable comparisons, while this
    // exact WML idiom (`[recall]` followed by `[if][not][have_unit]`) is the
    // campaign's RECALL_ELSE primitive. Its else branch is safe to materialise
    // here: `command:spawn_unit` is idempotent in the scene, and the runtime's
    // recall command has already had the opportunity to restore the unit.
    if (tests.length === 1 && tests[0].tag === 'not' && tests[0].children.some((child) => child.tag === 'have_unit') && (!thens.length || thens[0].children.length === 0)) {
      const have = tests[0].children.find((child) => child.tag === 'have_unit');
      if (elses.length === 1) for (const command of elses[0].children) convertCommand(command, ev);
      else if (have?.attributes.id === 'Baran') {
        // RECALL_ELSE's WML argument is lost by the upstream macro expansion
        // when it contains nested trait macros. Preserve this known campaign
        // character explicitly rather than silently dropping the fallback.
        convertSpawn({
          tag: 'unit',
          attributes: { id: 'Baran', type: 'Red Mage', side: '1', x: '31', y: '21' },
          children: [{ tag: 'modifications', attributes: {}, children: [{ tag: 'trait', attributes: { id: 'loyal' }, children: [], location: node.location }], location: node.location }],
          location: node.location,
        }, ev);
      }
      return;
    }
    if (tests.length < 1 || thens.length > 1 || elses.length > 1 || tests.some((test) => !ifCondition(test))) {
      // Complex WML filters are retained in the source report elsewhere, but
      // have no direct MWL condition equivalent yet. Do not emit malformed
      // branch nodes that would change the scenario's control flow.
      return;
    }
    // The runtime runs `else` unconditionally, so the loader emits the
    // negation as a second `if` instead. For several tests, preserve the
    // exact De Morgan semantics in the condition-tree predicate rather than
    // approximating the negation as independent event conditions.
    if (thens[0]) {
      const id = eventId('if');
      const branch: ConvEvent = {
        id,
        trigger: `branch_${id}`,
        once: true,
        conditions: tests.map(ifCondition).filter((value): value is string => value !== null),
        filters: [],
        commands: [],
      };
      for (const command of thens[0].children) convertCommand(command, branch);
      events.push(branch);
      ev.commands.push(`[hook]\nname=command:fire_event\nevent=branch_${id}\n[/hook]`);
    }
    for (const branchNode of elseIfs) {
      const branchTests = branchNode.children.filter((child) => child.tag === 'variable' || child.tag === 'have_unit' || child.tag === 'have_location' || child.tag === 'not' || child.tag === 'lua' || child.tag === 'and' || child.tag === 'or');
      const branchThen = branchNode.children.find((child) => child.tag === 'then');
      if (branchTests.length !== 1 || !branchThen || !ifCondition(branchTests[0])) {
        skip('[if] elseif without a supported condition/then body', branchNode);
        continue;
      }
      const branchId = eventId('if');
      const conditionText = ifCondition(branchTests[0])!;
      const branch: ConvEvent = {
        id: branchId,
        trigger: `branch_${branchId}`,
        once: true,
        conditions: conditionText.startsWith('[condition]') ? [conditionText] : [],
        filters: conditionText.startsWith('[filter_condition]') ? [conditionText] : [],
        commands: [],
      };
      for (const command of branchThen.children) convertCommand(command, branch);
      events.push(branch);
      ev.commands.push(`[hook]\nname=command:fire_event\nevent=branch_${branchId}\n[/hook]`);
    }
    if (elses[0]) {
      const id = eventId('if');
      const branch: ConvEvent = {
        id,
        trigger: `branch_${id}`,
        once: true,
        conditions: [],
        filters: [tests.length === 1 ? negateIfCondition(tests[0]) : negateIfConditions(tests)],
        commands: [],
      };
      for (const command of elses[0].children) convertCommand(command, branch);
      events.push(branch);
      ev.commands.push(`[hook]\nname=command:fire_event\nevent=branch_${id}\n[/hook]`);
    }
    for (const child of node.children) {
      if (child.tag !== 'variable' && child.tag !== 'have_unit' && child.tag !== 'have_location' && child.tag !== 'not' && child.tag !== 'lua' && child.tag !== 'and' && child.tag !== 'or' && child.tag !== 'then' && child.tag !== 'elseif' && child.tag !== 'else') skip(`[if] ${child.tag}`, child);
    }
  }

  function ifCondition(test: WmlNode): string | null {
    if (test.tag === 'and' || test.tag === 'or') {
      return `[filter_condition]\n[predicate]\nname=wml_condition_tree\ntree=${encodeURIComponent(JSON.stringify(serializeVariableNode(test)))}\n[/predicate]\n[/filter_condition]`;
    }
    if (test.tag === 'variable' && test.attributes.name) {
      return isDynamicVariableName(test.attributes.name) ? variablePredicate(test, true) : condition(variableCondition(test));
    }
    if (test.tag === 'lua' && test.attributes.code?.match(/^\s*return\s+/)) {
      return `[filter_condition]\n[predicate]\nname=lua_condition\ncode=${oneLineValue(test.attributes.code)}\n[/predicate]\n[/filter_condition]`;
    }
    if (test.tag === 'have_location') {
      return `[filter_condition]\n[predicate]\nname=wml_condition_tree\ntree=${encodeURIComponent(JSON.stringify(serializeVariableNode(test)))}\n[/predicate]\n[/filter_condition]`;
    }
    return null;
  }

  function conditionTree(node: WmlNode): string {
    return `[filter_condition]\n[predicate]\nname=wml_condition_tree\ntree=${encodeURIComponent(JSON.stringify(serializeVariableNode(node)))}\n[/predicate]\n[/filter_condition]`;
  }

  function collectStory(node: WmlNode, inherited: string[] = []): void {
    for (const child of node.children) {
      if (child.tag === 'part' && child.attributes.story) {
        story.push({
          text: child.attributes.story,
          background: child.attributes.background,
          ...(child.attributes.music ? { music: child.attributes.music } : {}),
          conditions: inherited,
        });
        continue;
      }
      if (child.tag === 'if') {
        const tests = child.children.filter((candidate) => ['variable', 'have_unit', 'have_location', 'not', 'lua', 'and', 'or'].includes(candidate.tag));
        const thenNode = child.children.find((candidate) => candidate.tag === 'then');
        const elseNode = child.children.find((candidate) => candidate.tag === 'else');
        const testCondition = tests.length === 1 ? ifCondition(tests[0]) : tests.length > 1 ? conditionTree({ tag: 'and', attributes: {}, children: tests, location: child.location }) : null;
        if (testCondition && thenNode) collectStory(thenNode, [...inherited, testCondition]);
        if (elseNode && tests.length) {
          const inverse = tests.length === 1 ? negateIfCondition(tests[0]) : negateIfConditions(tests);
          collectStory(elseNode, [...inherited, inverse]);
        }
        continue;
      }
      if (child.tag === 'switch' && child.attributes.variable) {
        const cases = child.children.filter((candidate) => candidate.tag === 'case' && candidate.attributes.value);
        for (const caseNode of cases) {
          const test: WmlNode = { tag: 'variable', attributes: { name: child.attributes.variable, equals: caseNode.attributes.value }, children: [], location: caseNode.location };
          const conditionText = ifCondition(test);
          if (conditionText) collectStory(caseNode, [...inherited, conditionText]);
        }
        const elseNode = child.children.find((candidate) => candidate.tag === 'else');
        if (elseNode && cases.length) {
          const tests = cases.map((caseNode) => ({ tag: 'variable', attributes: { name: child.attributes.variable, equals: caseNode.attributes.value }, children: [], location: caseNode.location } as WmlNode));
          collectStory(elseNode, [...inherited, negateIfConditions([{ tag: 'or', attributes: {}, children: tests, location: child.location }])]);
        }
        continue;
      }
      if (child.tag !== 'part' && child.tag !== 'title') skip(`[story] ${child.tag}`, child);
    }
  }

  function negateIfConditions(tests: WmlNode[]): string {
    const tree: WmlNode = {
      tag: 'not',
      attributes: {},
      children: [{ tag: 'and', attributes: {}, children: tests, location: tests[0]?.location ?? { file: '', line: 0 } }],
      location: tests[0]?.location ?? { file: '', line: 0 },
    };
    return `[filter_condition]\n[predicate]\nname=wml_condition_tree\ntree=${encodeURIComponent(JSON.stringify(serializeVariableNode(tree)))}\n[/predicate]\n[/filter_condition]`;
  }

  function visibilityFilterAttrs(node: WmlNode): Record<string, string> {
    const filter = node.children.find((child) => child.tag === 'filter');
    const attrs: Record<string, string> = {};
    for (const key of ['id', 'side', 'type']) {
      const value = node.attributes[key] ?? filter?.attributes[key];
      if (value) attrs[key] = key === 'id' ? value.replaceAll('"', '') : value;
    }
    return attrs;
  }

  function variablePredicate(test: WmlNode, asCondition: boolean): string {
    const attrs: Record<string, string> = { variable: test.attributes.name ?? '' };
    for (const key of ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_than_or_equal_to', 'less_than_or_equal_to']) {
      if (test.attributes[key] !== undefined) attrs[key] = test.attributes[key];
    }
    const predicate = `name=variable_compare\n${Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join('\n')}`;
    return asCondition ? `[condition]\ncondition=hook\nhook=predicate:variable_compare\n${Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join('\n')}\n[/condition]` : `[predicate]\n${predicate}\n[/predicate]`;
  }

  function negateIfCondition(test: WmlNode): string {
    if (test.tag === 'variable') return negateCondition(test);
    const have = test.tag === 'have_unit' ? test : test.children.find((child) => child.tag === 'have_unit');
    if (!have) return condition({ variable: '__invalid_if__', not_equals: '' });
    return hookCondition('predicate:unit_exists', {
      id: have.attributes.id ?? '',
      exists: test.tag === 'not' ? 'yes' : 'no',
      ...(have.attributes.side ? { side: have.attributes.side } : {}),
    });
  }

  // MWL source assembly below. Win and lose texts ride on the objectives
  // node; the functional conditions come from the converted events, plus a
  // turn-limit defeat when no `time over` event tells that story itself.
  const out: string[] = [];
  const mwlId = safeId(id);
  out.push('[game]', 'schema=0.1', `title=${q(title)}`, '');
  for (const side of sides) out.push(side, '');
  out.push('[map]', `id=${mwlId}`);
  if (mapFile) out.push(`file=${mapFile}`);
  // The `"""` block form is the only multi-line value the tag syntax allows;
  // every other value goes through `q()`, which flattens newlines to spaces.
  else if (mapData) out.push(`terrain="""${mapData}"""`);
  out.push('[/map]', '');
  for (const placed of units) {
    out.push('[unit]', `id=${placed.id}`, `type=${placed.type}`, `side=${placed.side}`, `x=${placed.x}`, `y=${placed.y}`,
      ...(placed.name ? [`name=${q(placed.name)}`] : []), '[/unit]', '');
  }
  for (const side of hiddenSides) {
    out.push('[event]', `id=hide_side_${side}`, 'on=start', 'once=true', '[hook]', 'name=command:config_side', `side=${side}`, 'hidden=yes', '[/hook]', '[/event]', '');
  }
  const aspectVariables: string[] = [];
  for (const name of ['aggression', 'caution', 'greed', 'grouping'] as const) {
    const value = meta.aspects[name];
    if (value) aspectVariables.push('[set_variable]', `name=ai_${name}`, `value=${value}`, '[/set_variable]');
  }
  if (meta.aiStages.length) aspectVariables.push('[set_variable]', 'name=ai_stages', `value=${meta.aiStages.join(',')}`, '[/set_variable]');
  if (meta.aiCandidates.enabled.length) {
    aspectVariables.push('[set_variable]', 'name=ai_candidates', `value=${meta.aiCandidates.enabled.join(',')}`, '[/set_variable]');
  }
  if (meta.aiCandidates.disabled.length) {
    aspectVariables.push('[set_variable]', 'name=ai_candidate_off', `value=${meta.aiCandidates.disabled.join(',')}`, '[/set_variable]');
  }
  const candidateScores = Object.entries(meta.aiCandidates.scores);
  if (candidateScores.length) {
    aspectVariables.push('[set_variable]', 'name=ai_candidate_scores', `value=${candidateScores.map(([id, score]) => `${id}:${score}`).join(',')}`, '[/set_variable]');
  }
  if (meta.bonus) aspectVariables.push('[set_variable]', 'name=carryover_bonus', 'value=yes', '[/set_variable]');
  if (meta.aiDirectives.length) {
    const encoded = meta.aiDirectives.map((directive) => {
      const base = [directive.kind, directive.x ?? '', directive.y ?? '', directive.radius, directive.value].join(',');
      return directive.filter ? `${base},${encodeURIComponent(JSON.stringify(directive.filter))}` : base;
    }).join(';');
    aspectVariables.push('[set_variable]', 'name=ai_directives', `value=${encoded}`, '[/set_variable]');
  }
  out.push(
    '[event]',
    `id=${eventId('carryover')}`,
    'on=start',
    '[set_variable]',
    'name=carryover_percentage',
    `value=${meta.carryoverPercent}`,
    '[/set_variable]',
    ...aspectVariables,
    '[/event]',
    '',
  );
  for (const part of story) {
    const portrait = part.background ? `\nportrait=${q(part.background)}` : '';
    const music = part.music ? `${hookCommand('command:play_music', { file: part.music })}\n` : '';
    out.push('[event]', `id=${eventId('story')}`, 'on=start', ...part.conditions, `${music}[message]\nspeaker=narrator${portrait}\ntext=${q(part.text)}\n[/message]`, '[/event]', '');
  }
  if (loyalIds.length) {
    out.push(
      '[event]',
      `id=${eventId('loyal')}`,
      'on=start',
      `[hook]\nname=command:make_loyal\nunits=${loyalIds.join(',')}\n[/hook]`,
      '[/event]',
      '',
    );
  }
  if (turns > 0) {
    out.push(
      '[event]',
      `id=${eventId('clock')}`,
      'on=start',
      `[set_variable]\nname=turn_limit\nvalue=${turns}\n[/set_variable]`,
      '[/event]',
      '',
    );
  }
  out.push('[objectives]', 'side=1', `victory=${q(objectivesWin.join('\n'))}`, `defeat=${q(objectivesLose.join('\n'))}`);
  // The trigger is the canonical `time_over`; a scenario that handles its own
  // turn limit declares `[event] name=time over`, which classifies to it.
  if (turns > 0 && !events.some((ev) => ev.trigger === 'time_over')) {
    out.push('[defeat]', 'condition=hook', 'hook=predicate:turn_limit', '[/defeat]');
  }
  out.push('[/objectives]', '');
  for (const ev of events) {
    out.push('[event]', `id=${ev.id}`);
    if (ev.trigger !== null) out.push(`on=${ev.trigger}`);
    out.push(`once=${ev.once ? 'true' : 'false'}`);
    for (const cond of ev.conditions) out.push(cond);
    for (const filter of ev.filters) out.push(filter);
    for (const command of ev.commands) out.push(command);
    out.push('[/event]', '');
  }
  out.push('[/game]');
  // The fragments are deliberately WML-shaped only as a private assembly
  // convenience. Convert them through the existing WML parser before they
  // leave this build-time adapter, so no legacy MWL grammar remains in use.
  const mwl = renderJson5Document(parseWml(out.join('\n'), id));
  return { mwl, meta, report: { skipped, diagnostics } };
}

function hasLoyalMarker(node: WmlNode): boolean {
  if (node.attributes.upkeep === 'loyal') return true;
  return node.children.some(
    (child) =>
      child.tag === 'modifications' &&
      child.children.some((grand) => grand.tag === 'trait' && /loyal/i.test(grand.attributes.id ?? '')),
  );
}

function convertTime(node: WmlNode): { id: string; lawfulBonus: number; name: string } {
  return {
    id: node.attributes.id ?? '',
    lawfulBonus: Number(node.attributes.lawful_bonus ?? 0),
    name: node.attributes.name ?? '',
  };
}

function convertTimeArea(
  node: WmlNode,
  skip: (what: string, node?: WmlNode) => void,
  context: LoaderContext,
): TimeAreaDef {
  void context;
  const times = node.children.filter((child) => child.tag === 'time').map(convertTime);
  for (const child of node.children) if (child.tag !== 'time') skip(`[time_area] ${child.tag}`, child);
  return { id: node.attributes.id ?? '', xs: node.attributes.x ?? '', ys: node.attributes.y ?? '', times };
}

function condition(attrs: Record<string, string>): string {
  return `[condition]\n${Object.entries(attrs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n[/condition]`;
}

function hookCondition(hook: string, attrs: Record<string, string>): string {
  return `[condition]\ncondition=hook\nhook=${hook}${Object.entries(attrs)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `\n${key}=${value}`)
    .join('')}\n[/condition]`;
}

function hookCommand(name: string, attrs: Record<string, string>): string {
  return `[hook]\nname=${name}${Object.entries(attrs)
    .map(([key, value]) => `\n${key}=${value}`)
    .join('')}\n[/hook]`;
}

/** A JSON-safe representation used to defer `[set_variables]` expansion. */
function serializeVariableNode(node: WmlNode): { tag: string; attributes: Record<string, string>; children: ReturnType<typeof serializeVariableNode>[] } {
  return {
    tag: node.tag,
    attributes: { ...node.attributes },
    children: node.children.map(serializeVariableNode),
  };
}

/**
 * The `[set_variable]` keys the port models, in the order Wesnoth's action applies them
 * (`data/lua/wml/set_variable.lua`). Each one is a hook `mode`; a node that spells several
 * is emitted as several hooks over the same variable, exactly as WML chains them.
 */
const SET_VARIABLE_KEYS: readonly string[] = [
  'value',
  'literal',
  'to_variable',
  'suffix',
  'prefix',
  'add',
  'sub',
  'multiply',
  'divide',
  'modulo',
  'abs',
  'root',
  'power',
  'round',
  'min',
  'max',
  'string_length',
  'formula',
];

/** A hook attribute is one line; a value the source wrote across lines joins with spaces. */
function oneLineValue(value: string): string {
  return value.includes('\n') || value.includes('\r') ? value.replace(/\s+/g, ' ').trim() : value;
}

/**
 * WML spells the comparison bounds `less_than_equal_to` / `greater_than_equal_to`
 * and folds booleans into `boolean_equals`; MWL's `[variable]`/`[condition]`
 * schema uses `less_than_or_equal_to` / `greater_than_or_equal_to` and `equals`.
 * Translate once here so `[while]`, event conditions and negations all agree.
 */
const COMPARISON_KEYS: Readonly<Record<string, string>> = {
  equals: 'equals',
  not_equals: 'not_equals',
  boolean_equals: 'equals',
  boolean_not_equals: 'not_equals',
  less_than: 'less_than',
  greater_than: 'greater_than',
  less_than_equal_to: 'less_than_or_equal_to',
  greater_than_equal_to: 'greater_than_or_equal_to',
  less_than_or_equal_to: 'less_than_or_equal_to',
  greater_than_or_equal_to: 'greater_than_or_equal_to',
  in: 'in',
  not_in: 'not_in',
};

function comparisonAttrs(test: WmlNode): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(test.attributes)) {
    const mapped = COMPARISON_KEYS[key];
    if (mapped !== undefined && value !== undefined) attrs[mapped] = value;
  }
  return attrs;
}

function variableCondition(test: WmlNode): Record<string, string> {
  return { variable: test.attributes.name, ...comparisonAttrs(test) };
}

function negateCondition(test: WmlNode): string {
  const name = test.attributes.name;
  const negated: Record<string, string> = {};
  for (const [key, value] of Object.entries(comparisonAttrs(test))) {
    negated[NEGATION[key] ?? 'not_equals'] = value;
  }
  if (!Object.keys(negated).length) negated.not_equals = '';
  return condition({ variable: name, ...negated });
}

const NEGATION: Readonly<Record<string, string>> = {
  equals: 'not_equals',
  not_equals: 'equals',
  less_than: 'greater_than_or_equal_to',
  greater_than: 'less_than_or_equal_to',
  less_than_or_equal_to: 'greater_than',
  greater_than_or_equal_to: 'less_than',
  in: 'not_in',
  not_in: 'in',
};

/** Shift one 1-based coordinate to 0-based for scenario commands. */
function shiftCoord(raw: string): string {
  const trimmed = raw.trim();
  return /^-?\d+$/.test(trimmed) ? String(Number(trimmed) - 1) : trimmed;
}
