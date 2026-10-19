/**
 * The terrain-graphics transition builder, ported from
 * `src/terrain/builder.cpp` and `src/terrain/builder.hpp`.
 *
 * A `[terrain_graphics]` rule is a set of `[tile]` terrain constraints at hex
 * offsets. `buildTerrainTiles` walks every rule over the map, tests the
 * constraints against the real terrain and per-tile flags, and records the
 * images that apply to each hex. It reproduces the C++ pipeline in order:
 *
 *   parseTerrainGraphics   parse [terrain_graphics] nodes into raw rules
 *   expandRules            `rotations=` / `rotate_rule` / `@R` replacement
 *   buildTerrainTiles      `build_terrains` + `rule_matches` + `apply_rule`
 *   resolveTileImages      `tile::rebuild_cache` variant selection
 *
 * The model is deliberately pure: no Pixi, no node imports. The data pipeline
 * compiles the real 30 rule files into `src/generated/terrain-transitions.ts`
 * through `parseTerrainGraphics`, and the browser scene calls
 * `buildTerrainTiles` per scenario.
 *
 * Deliberate reductions, documented in PORT_COVERAGE.md:
 * - `[image] base=` is applied in the engine only through the image locator's
 *   `center` cropping, which this port approximates as a whole-image offset; the
 *   `base` value is still kept for background/foreground classification.
 * - `image::is_empty_hex` masking is not reproduced, so an animated terrain
 *   frame that is the empty hex is drawn rather than skipped (it is transparent
 *   either way).
 */

import {
  encodeCode,
  codeKey,
  parseMapString,
  parseTerrainList,
  terrainMatches,
  WILDCARD,
  type TerrainCode,
} from './terrain-codes.ts';
import { parseFrameSpec } from './animation.ts';
import type { WmlNode } from './wml.ts';

/** `terrain_builder::UNITPOS` (builder.hpp): images at or above are foreground. */
export const UNITPOS = 54;

export interface TgVariantSpec {
  name: string;
  variations: string;
  tods: string[];
  hasFlags: string[];
}

export interface TgImageSpec {
  layer: number;
  /** base point inside the tile, 36 is the tile centre (`tilewidth_ / 2`). */
  baseX: number;
  baseY: number;
  /** true when the image was declared directly under `[terrain_graphics]`. */
  global: boolean;
  centerX: number;
  centerY: number;
  isWater: boolean;
  variants: TgVariantSpec[];
}

export interface TgConstraintSpec {
  x: number;
  y: number;
  /** raw terrain match list; `*` when the rule's map marks this hex as any terrain. */
  types: string;
  setFlags: string[];
  noFlags: string[];
  hasFlags: string[];
  noDraw: boolean;
  images: TgImageSpec[];
}

export interface TgRuleSpec {
  constraints: TgConstraintSpec[];
  locationX: number;
  locationY: number;
  modX: number;
  modY: number;
  probability: number;
  precedence: number;
  rotations: string[];
  file: string;
}

export interface BuiltTerrainImage {
  /** image path relative to `data/core/images`, modifiers included. */
  image: string;
  background: boolean;
  layer: number;
  baseY: number;
  /** pixel offset from the tile centre (Wesnoth's `[image] center=`). */
  offsetX: number;
  offsetY: number;
}

export interface BuiltTile {
  background: BuiltTerrainImage[];
  foreground: BuiltTerrainImage[];
}

export interface TerrainMapInput {
  width: number;
  height: number;
  /** the map code at a hex (`Gg^Fp`, `_off^_usr`, ...). */
  terrainAt: (x: number, y: number) => string;
  /** whether the map border is drawn; rules with `has_flag=_border` need it. */
  drawBorder?: boolean;
  /** current time of day, for `[variant] tod=`. */
  tod?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TILE_WIDTH = 72;

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * `config::attribute_value::to_int(default)`: an empty or non-numeric value
 * returns the default, which is why `probability={PROB}` with an empty `PROB`
 * still leaves the rule at 100.
 */
function intAttr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Split on commas that are not inside square brackets
 * (`utils::square_parenthetical_split`). Flags are written as
 * `a,b[c,d],e`, so a plain `split(',')` would cut inside the group.
 */
function squareSplit(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const c of value) {
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/**
 * The port's WML preprocessor keeps the parentheses around a parenthesized
 * macro argument, while Wesnoth's preprocessor strips them. `terrain_matches`
 * has no notion of parentheses, so strip every balanced outer pair here to
 * recover the value the engine actually sees (`(C*,K*)` -> `C*,K*`).
 */
function stripOuterParens(value: string): string {
  let text = value.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0 && i !== text.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function parseVariant(node: WmlNode, fallbackName: string, fallbackVariations: string): TgVariantSpec {
  const name = node.attributes.name ?? fallbackName;
  return {
    name,
    variations: node.attributes.variations ?? fallbackVariations,
    tods: splitList(node.attributes.tod),
    hasFlags: splitList(node.attributes.has_flag),
  };
}

function parseImages(nodes: WmlNode[], global: boolean, dx: number, dy: number): TgImageSpec[] {
  const out: TgImageSpec[] = [];
  for (const img of nodes) {
    if (img.tag !== 'image') continue;
    let baseX = TILE_WIDTH / 2 + dx;
    let baseY = TILE_WIDTH / 2 + dy;
    if (img.attributes.base) {
      const base = img.attributes.base.split(/[,\s]+/).map((entry) => Number.parseInt(entry, 10));
      if (base.length >= 2 && Number.isFinite(base[0]) && Number.isFinite(base[1])) {
        baseX = base[0];
        baseY = base[1];
      }
    }
    let centerX = -1;
    let centerY = -1;
    if (img.attributes.center) {
      const center = img.attributes.center.split(/[,\s]+/).map((entry) => Number.parseInt(entry, 10));
      if (center.length >= 2 && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
        centerX = center[0];
        centerY = center[1];
      }
    }
    const variations = img.attributes.variations ?? '';
    const variants: TgVariantSpec[] = img.children
      .filter((child) => child.tag === 'variant')
      .map((child) => parseVariant(child, img.attributes.name ?? '', variations));
    variants.push({
      name: img.attributes.name ?? '',
      variations,
      tods: [],
      hasFlags: [],
    });
    out.push({
      layer: Number.parseInt(img.attributes.layer ?? '0', 10) || 0,
      baseX: baseX - dx,
      baseY: baseY - dy,
      global,
      centerX,
      centerY,
      isWater: /^(1|yes|true)$/i.test(img.attributes.is_water ?? ''),
      variants,
    });
  }
  return out;
}

function constraintKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Read parsed `[terrain_graphics]` nodes into the raw transition model. */
export function parseTerrainGraphics(nodes: WmlNode[], file = '<terrain-graphics>'): TgRuleSpec[] {
  const rules: TgRuleSpec[] = [];
  for (const node of nodes) {
    if (node.tag !== 'terrain_graphics') continue;
    const constraints = new Map<string, TgConstraintSpec>();
    const rootImages = node.children.filter((child) => child.tag === 'image');

    const addConstraint = (
      x: number,
      y: number,
      types: string,
      tileImages: TgImageSpec[],
    ): TgConstraintSpec => {
      const key = constraintKey(x, y);
      let constraint = constraints.get(key);
      if (!constraint) {
        constraint = { x, y, types: '', setFlags: [], noFlags: [], hasFlags: [], noDraw: false, images: [] };
        constraints.set(key, constraint);
      }
      if (types !== '') constraint.types = types;
      const dx = x * (TILE_WIDTH * 3) / 4;
      const dy = y * TILE_WIDTH + (x % 2) * (TILE_WIDTH / 2);
      constraint.images.push(...parseImages(rootImages, true, dx, dy));
      constraint.images.push(...tileImages);
      return constraint;
    };

    // `map="..."`: named anchors and `*` star constraints, exactly as
    // parse_mapstring walks the builder map.
    const mapText = node.attributes.map ?? '';
    const anchors = new Map<number, Array<{ x: number; y: number }>>();
    if (mapText.trim() !== '') {
      const parsed = parseMapString(mapText);
      for (const star of parsed.constraints) addConstraint(star.x, star.y, '*', []);
      for (const [pos, locs] of parsed.anchors) anchors.set(pos, locs);
    }

    // `[tile]` entries: explicit `x`/`y` (or the `x,y` WML shorthand) and/or `pos`.
    for (const tile of node.children) {
      if (tile.tag !== 'tile') continue;
      const tileImages = parseImages(tile.children, false, 0, 0);
      const types = stripOuterParens(tile.attributes.type ?? '');
      let x: number | undefined;
      let y: number | undefined;
      if (tile.attributes['x,y'] !== undefined && tile.attributes.x === undefined && tile.attributes.y === undefined) {
        const parts = tile.attributes['x,y'].split(',').map((entry) => Number.parseInt(entry, 10));
        x = parts[0];
        y = parts[1];
      } else {
        if (tile.attributes.x !== undefined) x = Number.parseInt(tile.attributes.x, 10);
        if (tile.attributes.y !== undefined) y = Number.parseInt(tile.attributes.y, 10);
      }
      if (Number.isFinite(x) && Number.isFinite(y) && (x as number) >= 0 && (y as number) >= 0) {
        const constraint = addConstraint(x as number, y as number, types, tileImages);
        const setFlags = squareSplit(tile.attributes.set_flag);
        constraint.setFlags.push(...setFlags);
        constraint.hasFlags.push(...squareSplit(tile.attributes.has_flag));
        constraint.noFlags.push(...squareSplit(tile.attributes.no_flag));
        const setNoFlag = squareSplit(tile.attributes.set_no_flag);
        constraint.setFlags.push(...setNoFlag);
        constraint.noFlags.push(...setNoFlag);
        constraint.noDraw = /^(1|yes|true)$/i.test(tile.attributes.no_draw ?? '');
      }
      if (tile.attributes.pos !== undefined) {
        const pos = Number.parseInt(tile.attributes.pos, 10);
        for (const loc of anchors.get(pos) ?? []) {
          const constraint = addConstraint(loc.x, loc.y, types, tileImages);
          const setFlags = squareSplit(tile.attributes.set_flag);
          constraint.setFlags.push(...setFlags);
          constraint.hasFlags.push(...squareSplit(tile.attributes.has_flag));
          constraint.noFlags.push(...squareSplit(tile.attributes.no_flag));
          const setNoFlag = squareSplit(tile.attributes.set_no_flag);
          constraint.setFlags.push(...setNoFlag);
          constraint.noFlags.push(...setNoFlag);
          constraint.noDraw = /^(1|yes|true)$/i.test(tile.attributes.no_draw ?? '');
        }
      }
    }

    // Rule-level flags are appended to every constraint.
    const globalSet = splitList(node.attributes.set_flag);
    const globalNo = splitList(node.attributes.no_flag);
    const globalHas = splitList(node.attributes.has_flag);
    const globalSetNo = splitList(node.attributes.set_no_flag);
    for (const constraint of constraints.values()) {
      constraint.setFlags.push(...globalSet, ...globalSetNo);
      constraint.noFlags.push(...globalNo, ...globalSetNo);
      constraint.hasFlags.push(...globalHas);
    }

    if (constraints.size === 0) continue;
    rules.push({
      constraints: [...constraints.values()],
      locationX: intAttr(node.attributes.x, 0) - 1,
      locationY: intAttr(node.attributes.y, 0) - 1,
      modX: intAttr(node.attributes.mod_x, 0),
      modY: intAttr(node.attributes.mod_y, 0),
      probability: intAttr(node.attributes.probability, 100),
      precedence: intAttr(node.attributes.precedence, 0),
      rotations: node.attributes.rotations !== undefined ? node.attributes.rotations.split(',').map((entry) => entry.trim()) : [],
      file,
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Rotation (builder.cpp:482-680)
// ---------------------------------------------------------------------------

const LOC_ROTATIONS = [
  { ii: 1, ij: 0, ji: 0, jj: 1 },
  { ii: 1, ij: 1, ji: -1, jj: 0 },
  { ii: 0, ij: 1, ji: -1, jj: -1 },
  { ii: -1, ij: 0, ji: 0, jj: -1 },
  { ii: -1, ij: -1, ji: 1, jj: 0 },
  { ii: 0, ij: -1, ji: 1, jj: 1 },
];
const XY_ROTATIONS = [
  { xx: 1, xy: 0, yx: 0, yy: 1 },
  { xx: 1 / 2, xy: -3 / 4, yx: 1, yy: 1 / 2 },
  { xx: -1 / 2, xy: -3 / 4, yx: 1, yy: -1 / 2 },
  { xx: -1, xy: 0, yx: 0, yy: -1 },
  { xx: -1 / 2, xy: 3 / 4, yx: -1, yy: -1 / 2 },
  { xx: 1 / 2, xy: 3 / 4, yx: -1, yy: 1 / 2 },
];

function legacySumAssign(x: number, y: number, ax: number, ay: number): { x: number; y: number } {
  const parity = (x & 1) !== 0;
  let nx = x + ax;
  let ny = y + ay;
  if (ax > 0 && ax % 2 !== 0 && parity) ny++;
  if (ax < 0 && ax % 2 !== 0 && !parity) ny--;
  return { x: nx, y: ny };
}

/** A local, mutable mirror of a constraint used while rotating. */
interface MutableConstraint {
  x: number;
  y: number;
  types: string;
  setFlags: string[];
  noFlags: string[];
  hasFlags: string[];
  noDraw: boolean;
  images: TgImageSpec[];
}

function replaceRotateTokens(value: string, angle: number, rot: string[]): string {
  let out = value;
  let pos = 0;
  while ((pos = out.indexOf('@R', pos)) !== -1) {
    if (pos + 2 >= out.length) break;
    const digit = out.charCodeAt(pos + 2) - 48;
    let index = digit + angle;
    if (index >= 6) index -= 6;
    if (index >= 6) {
      pos += 2;
      continue;
    }
    const replacement = rot[index];
    out = out.slice(0, pos) + replacement + out.slice(pos + 3);
    pos += replacement.length;
  }
  return out;
}

function rotateConstraint(constraint: MutableConstraint, angle: number): void {
  const matrix = LOC_ROTATIONS[angle % 6];
  const vi = constraint.y - Math.trunc(constraint.x / 2);
  const vj = constraint.x;
  const ri = matrix.ii * vi + matrix.ij * vj;
  const rj = matrix.ji * vi + matrix.jj * vj;
  constraint.x = rj;
  constraint.y = ri + (rj >= 0 ? Math.trunc(rj / 2) : Math.trunc((rj - 1) / 2));
  const xy = XY_ROTATIONS[angle % 6];
  for (const image of constraint.images) {
    const vx = image.baseX - TILE_WIDTH / 2;
    const vy = image.baseY - TILE_WIDTH / 2;
    image.baseX = Math.trunc(xy.xx * vx + xy.xy * vy + TILE_WIDTH / 2);
    image.baseY = Math.trunc(xy.yx * vx + xy.yy * vy + TILE_WIDTH / 2);
  }
}

function cloneConstraint(constraint: TgConstraintSpec): MutableConstraint {
  return {
    x: constraint.x,
    y: constraint.y,
    types: constraint.types,
    setFlags: [...constraint.setFlags],
    noFlags: [...constraint.noFlags],
    hasFlags: [...constraint.hasFlags],
    noDraw: constraint.noDraw,
    images: constraint.images.map((image, index) => ({
      ...image,
      baseX: constraint.images[index].baseX,
      variants: image.variants.map((variant) => ({ ...variant, tods: [...variant.tods], hasFlags: [...variant.hasFlags] })),
    })),
  };
}

function rotateRule(rule: TgRuleSpec, angle: number, rot: string[]): TgRuleSpec {
  const constraints = rule.constraints.map((constraint) => {
    const mutable = cloneConstraint(constraint);
    rotateConstraint(mutable, angle);
    return mutable;
  });
  if (rot.length !== 6) {
    // The C++ bails before normalizing or replacing tokens when the list is
    // shorter than six entries, so the rule is used exactly as written.
    return { ...rule, constraints: constraints as TgConstraintSpec[] };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const constraint of constraints) {
    minX = Math.min(constraint.x, minX);
    minY = Math.min(2 * constraint.y + (constraint.x & 1), minY);
  }
  if ((minY & 1) !== 0 && (minX & 1) !== 0 && minX < 0) minY += 2;
  if ((minY & 1) === 0 && (minX & 1) !== 0 && minX > 0) minY -= 2;
  const offsetX = -minX;
  const offsetY = -Math.trunc((minY - 1) / 2);
  for (const constraint of constraints) {
    const shifted = legacySumAssign(constraint.x, constraint.y, offsetX, offsetY);
    constraint.x = shifted.x;
    constraint.y = shifted.y;
    constraint.setFlags = constraint.setFlags.map((flag) => replaceRotateTokens(flag, angle, rot));
    constraint.noFlags = constraint.noFlags.map((flag) => replaceRotateTokens(flag, angle, rot));
    constraint.hasFlags = constraint.hasFlags.map((flag) => replaceRotateTokens(flag, angle, rot));
    for (const image of constraint.images) {
      for (const variant of image.variants) variant.name = replaceRotateTokens(variant.name, angle, rot);
    }
  }
  return { ...rule, constraints: constraints as TgConstraintSpec[] };
}

/** `add_rotated_rules`: expand `rotations=` into up to six concrete rules. */
export function expandRules(rules: readonly TgRuleSpec[]): TgRuleSpec[] {
  const out: TgRuleSpec[] = [];
  for (const rule of rules) {
    if (rule.rotations.length === 0) {
      out.push(rule);
      continue;
    }
    for (let angle = 0; angle < rule.rotations.length; angle++) {
      if (rule.rotations[angle] === 'skip') continue;
      out.push(rotateRule(rule, angle, rule.rotations));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build (builder.cpp:1073-1210)
// ---------------------------------------------------------------------------

function hashStr(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (((h << 9) | (h >>> 23)) ^ text.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** `building_rule::get_hash`: sum of every variant image string. */
export function ruleHash(rule: TgRuleSpec): number {
  let hash = 0;
  for (const constraint of rule.constraints) {
    for (const image of constraint.images) {
      for (const variant of image.variants) hash = (hash + hashStr(variant.name)) >>> 0;
    }
  }
  if (hash === 0) hash = 105533;
  return hash;
}

/** `get_noise`: the deterministic per-hex, per-rule random word. */
function getNoise(x: number, y: number, index: number): number {
  const a = ((x + 92872973) ^ 918273) >>> 0;
  const b = ((y + 1672517) ^ 128123) >>> 0;
  const c = ((index + 127390) ^ 13923787) >>> 0;
  const ab = Math.imul(a, b) >>> 0;
  const abc = (Math.imul(ab, c) + ab + Math.imul(b, c) + Math.imul(a, c) + a + b + c) >>> 0;
  return Math.imul(abc, abc) >>> 0;
}

interface RuleConstraint {
  x: number;
  y: number;
  types: TerrainCode[];
  setFlags: string[];
  noFlags: string[];
  hasFlags: string[];
  noDraw: boolean;
  images: readonly TgImageSpec[];
}

interface ExpandedRule {
  constraints: RuleConstraint[];
  locationX: number;
  locationY: number;
  modX: number;
  modY: number;
  probability: number;
  precedence: number;
  hash: number;
}

function compileRules(rules: readonly TgRuleSpec[]): ExpandedRule[] {
  const expanded = expandRules(rules).map((rule) => ({
    constraints: rule.constraints.map((constraint) => ({
      x: constraint.x,
      y: constraint.y,
      types: parseTerrainList(constraint.types, WILDCARD),
      setFlags: constraint.setFlags,
      noFlags: constraint.noFlags,
      hasFlags: constraint.hasFlags,
      noDraw: constraint.noDraw,
      images: constraint.images,
    })),
    locationX: rule.locationX,
    locationY: rule.locationY,
    modX: rule.modX,
    modY: rule.modY,
    probability: rule.probability,
    precedence: rule.precedence,
    hash: ruleHash(rule),
  }));
  return expanded.sort((a, b) => a.precedence - b.precedence);
}

/**
 * Rotation expands the 4,077 raw rules into ~18,000 concrete ones, which is
 * worth doing once per rule set rather than once per scenario or per helper
 * call. The cache is keyed by array identity, so tests that build fresh rules
 * still get their own expansion.
 */
let compiledCache: { rules: readonly TgRuleSpec[]; compiled: ExpandedRule[] } | undefined;
function compileRulesCached(rules: readonly TgRuleSpec[]): ExpandedRule[] {
  if (compiledCache?.rules === rules) return compiledCache.compiled;
  const compiled = compileRules(rules);
  compiledCache = { rules, compiled };
  return compiled;
}

interface BuildState {
  width: number;
  height: number;
  drawBorder: boolean;
  codeAt: (x: number, y: number) => TerrainCode;
  flags: Map<string, Set<string>>;
  images: Map<string, Array<{ image: TgImageSpec; rand: number }>>;
}

function onTileMap(state: BuildState, x: number, y: number): boolean {
  return x >= -2 && y >= -2 && x <= state.width + 1 && y <= state.height + 1;
}

function onBoard(state: BuildState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

function hashLoc(x: number, y: number): string {
  return `${x},${y}`;
}

function ruleMatches(state: BuildState, rule: ExpandedRule, x: number, y: number, skip: RuleConstraint | null): boolean {
  if (rule.modX > 0 && ((x % rule.modX) + rule.modX) % rule.modX !== 0) return false;
  if (rule.modY > 0 && ((y % rule.modY) + rule.modY) % rule.modY !== 0) return false;
  if (rule.locationX >= 0 && rule.locationY >= 0 && (rule.locationX !== x || rule.locationY !== y)) return false;
  if (rule.probability !== 100) {
    const random = getNoise(x, y, rule.hash) % 100;
    if (random > rule.probability) return false;
  }
  for (const constraint of rule.constraints) {
    const tloc = legacySumAssign(x, y, constraint.x, constraint.y);
    if (!onTileMap(state, tloc.x, tloc.y)) return false;
    if (constraint !== skip && !terrainMatches(state.codeAt(tloc.x, tloc.y), constraint.types)) return false;
    const flags = state.flags.get(hashLoc(tloc.x, tloc.y));
    if (flags) {
      for (const flag of constraint.noFlags) if (flags.has(flag)) return false;
      for (const flag of constraint.hasFlags) if (!flags.has(flag)) return false;
    } else if (constraint.hasFlags.length > 0) {
      return false;
    }
  }
  return true;
}

function applyRule(state: BuildState, rule: ExpandedRule, x: number, y: number): void {
  const rand = getNoise(x, y, rule.hash);
  for (const constraint of rule.constraints) {
    const tloc = legacySumAssign(x, y, constraint.x, constraint.y);
    if (!onTileMap(state, tloc.x, tloc.y)) continue;
    const key = hashLoc(tloc.x, tloc.y);
    if (!constraint.noDraw) {
      const list = state.images.get(key) ?? [];
      for (const image of constraint.images) list.push({ image, rand });
      state.images.set(key, list);
    }
    const flags = state.flags.get(key) ?? new Set<string>();
    for (const flag of constraint.setFlags) flags.add(flag);
    state.flags.set(key, flags);
  }
}

function getVariations(name: string, variations: string): string[] {
  if (!name.includes('@V')) return [name];
  // A `[variant]`/`[image]` that names `@V` but lists no `variations` has the one
  // empty variation: the engine substitutes the empty string, so `elven2@V.png` is
  // `elven2.png` (`terrain_builder::rule_image::... variations`, builder.cpp). Leaving the
  // literal `@V` made every such hex's art a missing file.
  if (!variations) return [name.split('@V').join('')];
  const out: string[] = [];
  for (const variation of variations.split(';')) out.push(name.split('@V').join(variation));
  return out;
}

/** Every concrete file reference of one image expression (primary and modifiers). */
function imageReferenceStrings(expression: string): string[] {
  const primaryRaw = expression.split('~')[0].trim();
  if (primaryRaw === '') return [];
  const primary = `terrain/${primaryRaw}`;
  const out = [primary];
  for (const match of expression.matchAll(/[A-Za-z0-9_./-]+\.(?:png|webp|jpg|jpeg)/gi)) {
    if (match[0] === primaryRaw || match[0] === primary) continue;
    out.push(match[0]);
  }
  return out;
}

function variantMatches(variant: TgVariantSpec, flags: Set<string>, tod: string | undefined): boolean {
  for (const flag of variant.hasFlags) if (!flags.has(flag)) return false;
  if (variant.tods.length > 0 && (tod === undefined || !variant.tods.includes(tod))) return false;
  return true;
}

/**
 * `tile::rebuild_cache`: choose one image per attached rule image.
 *
 * When `collect` is given, every candidate the image could resolve to (all
 * variants, all `@V` variations, all animation frames) is recorded. The asset
 * pipeline uses this to copy exactly the art a shipped map can draw, without
 * having to guess which variation the per-hex noise will pick.
 */
function resolveTileImages(
  entries: Array<{ image: TgImageSpec; rand: number }>,
  flags: Set<string>,
  tod: string | undefined,
  collect?: Set<string>,
): BuiltTile {
  const sorted = [...entries].sort((a, b) => a.image.layer - b.image.layer || a.image.baseY - b.image.baseY);
  const background: BuiltTerrainImage[] = [];
  const foreground: BuiltTerrainImage[] = [];
  for (const entry of sorted) {
    const image = entry.image;
    if (collect) {
      for (const variant of image.variants) {
        if (variant.name === '') continue;
        for (const name of getVariations(variant.name, variant.variations)) {
          for (const frame of parseFrameSpec(name)) for (const reference of imageReferenceStrings(frame.image)) collect.add(reference);
        }
      }
    }
    const isBackground = image.layer < 0 || (image.layer === 0 && image.baseY < UNITPOS);
    const target = isBackground ? background : foreground;
    for (const variant of image.variants) {
      if (variant.name === '' || !variantMatches(variant, flags, tod)) continue;
      const variations = getVariations(variant.name, variant.variations);
      const rnd = Math.trunc(entry.rand / 7919);
      const chosen = variations[rnd % variations.length];
      const frames = parseFrameSpec(chosen);
      if (frames.length === 0) continue;
      const offsetX = image.global && image.centerX >= 0 && image.centerY >= 0 ? image.centerX - TILE_WIDTH / 2 : 0;
      const offsetY = image.global && image.centerX >= 0 && image.centerY >= 0 ? image.centerY - TILE_WIDTH / 2 : 0;
      // The engine prepends `terrain/` to the primary file (builder.cpp:452);
      // `~BLIT(...)`/`~MASK(...)` sources keep their own root-relative path.
      const frameImage = frames[0].image;
      const tilde = frameImage.indexOf('~');
      const prefixed = tilde === -1 ? `terrain/${frameImage}` : `terrain/${frameImage.slice(0, tilde)}${frameImage.slice(tilde)}`;
      target.push({ image: prefixed, background: isBackground, layer: image.layer, baseY: image.baseY, offsetX, offsetY });
      break;
    }
  }
  return { background, foreground };
}

/**
 * `build_terrains`: run every rule over the map and return, for every hex that
 * received an image, its background and foreground image lists in layer order.
 * Pass `collect` to also gather every image candidate the matched rules could
 * draw (the asset pipeline does this).
 */
export function buildTerrainTiles(rules: readonly TgRuleSpec[], input: TerrainMapInput, collect?: Set<string>): Map<string, BuiltTile> {
  const state: BuildState = {
    width: input.width,
    height: input.height,
    drawBorder: input.drawBorder ?? false,
    codeAt: (x, y) => encodeCode(onBoard(state, x, y) ? input.terrainAt(x, y) : '_off^_usr'),
    flags: new Map(),
    images: new Map(),
  };

  // `build_terrains` first pass: bucket hexes by terrain and seed the border flags.
  const terrainByType = new Map<string, Array<{ x: number; y: number }>>();
  for (let x = -2; x <= state.width; x++) {
    for (let y = -2; y <= state.height; y++) {
      const key = codeKey(state.codeAt(x, y));
      const list = terrainByType.get(key) ?? [];
      list.push({ x, y });
      terrainByType.set(key, list);
      const flags = new Set<string>();
      if (state.drawBorder && !onBoard(state, x, y)) flags.add('_border');
      else flags.add('_board');
      state.flags.set(hashLoc(x, y), flags);
    }
  }

  const compiled = compileRulesCached(rules);
  for (const rule of compiled) {
    // Pick the constraint whose matching terrain covers the fewest hexes; the
    // engine then anchors the rule on that constraint only.
    let minConstraint: RuleConstraint | null = null;
    let minSize = Number.POSITIVE_INFINITY;
    let minTypes: string[] = [];
    for (const constraint of rule.constraints) {
      let size = 0;
      const codes: string[] = [];
      for (const [key, locs] of terrainByType) {
        const code: TerrainCode = {
          base: Number.parseInt(key.split(',')[0], 10),
          overlay: Number.parseInt(key.split(',')[1], 10),
        };
        if (terrainMatches(code, constraint.types)) {
          size += locs.length;
          if (size >= minSize) break;
          codes.push(key);
        }
      }
      if (size < minSize) {
        minSize = size;
        minTypes = codes;
        minConstraint = constraint;
        if (minSize === 0) break;
      }
    }
    if (!minConstraint || minTypes.length === 0) continue;
    for (const key of minTypes) {
      for (const loc of terrainByType.get(key) ?? []) {
        const anchor = legacySumAssign(loc.x, loc.y, -minConstraint.x, -minConstraint.y);
        if (ruleMatches(state, rule, anchor.x, anchor.y, minConstraint)) applyRule(state, rule, anchor.x, anchor.y);
      }
    }
  }

  const tiles = new Map<string, BuiltTile>();
  for (const [key, entries] of state.images) {
    const flags = state.flags.get(key) ?? new Set<string>();
    const tile = resolveTileImages(entries, flags, input.tod, collect);
    if (tile.background.length === 0 && tile.foreground.length === 0) continue;
    tiles.set(key, tile);
  }
  return tiles;
}

/**
 * Every image file the transition rules can draw, for the asset pipeline. The
 * primary name is relative to `terrain/` in the data (the engine prepends it,
 * builder.cpp:452), while `~BLIT(...)`/`~MASK(...)` sources are relative to the
 * image root. Rotation tokens are resolved first, so each concrete frame is
 * collected.
 */
export function terrainImageReferences(rules: readonly TgRuleSpec[]): Set<string> {
  const out = new Set<string>();
  const pathPattern = /[A-Za-z0-9_./-]+\.(?:png|webp|jpg|jpeg)/gi;
  for (const rule of expandRules(rules)) {
    for (const constraint of rule.constraints) {
      for (const image of constraint.images) {
        for (const variant of image.variants) {
          for (const name of getVariations(variant.name, variant.variations)) {
            for (const frame of parseFrameSpec(name)) {
              const primary = frame.image.split('~')[0].trim();
              if (primary === '') continue;
              out.add(`terrain/${primary}`);
              for (const match of frame.image.matchAll(pathPattern)) {
                if (match[0] === primary || match[0] === `terrain/${primary}`) continue;
                out.add(match[0]);
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** The image references of the rules that actually apply to a built map. */
export function builtImageReferences(tiles: Map<string, BuiltTile>): Set<string> {
  const out = new Set<string>();
  const pathPattern = /[A-Za-z0-9_./-]+\.(?:png|webp|jpg|jpeg)/gi;
  for (const tile of tiles.values()) {
    for (const image of [...tile.background, ...tile.foreground]) {
      const primary = image.image.split('~')[0].trim();
      if (primary !== '') out.add(primary);
      for (const match of image.image.matchAll(pathPattern)) out.add(match[0]);
    }
  }
  return out;
}

/**
 * `terrain_builder::load_images` drops every frame whose file is absent
 * (builder.cpp:443-460), so a `@V` variation that has no art never gets picked.
 * The port cannot check image existence in the pure builder, so the data
 * pipeline prunes those variations once, with a filesystem predicate, before
 * emitting the rules.
 */
export function pruneMissingFrames(
  rules: readonly TgRuleSpec[],
  exists: (path: string) => boolean,
): TgRuleSpec[] {
  const hasFrame = (spec: string): boolean =>
    parseFrameSpec(spec).some((frame) => {
      const primary = frame.image.split('~')[0].trim();
      return primary !== '' && exists(`terrain/${primary}`);
    });

  return rules.map((rule) => ({
    ...rule,
    constraints: rule.constraints.map((constraint) => {
      const images = constraint.images.flatMap((image) => {
        const variants: TgVariantSpec[] = [];
        for (const variant of image.variants) {
          if (variant.name === '') continue;
          if (variant.name.includes('@V') && variant.variations === '') {
            if (hasFrame(variant.name.split('@V').join(''))) variants.push(variant);
          } else if (variant.name.includes('@V')) {
            const kept = variant.variations.split(';').filter((entry) => hasFrame(variant.name.split('@V').join(entry)));
            if (kept.length === 0) continue;
            variants.push({ ...variant, variations: kept.join(';') });
          } else if (hasFrame(variant.name)) {
            variants.push(variant);
          }
        }
        return variants.length === 0 ? [] : [{ ...image, variants }];
      });
      return { ...constraint, images };
    }),
  }));
}

