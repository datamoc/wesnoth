/**
 * Terrain codes and wildcard matching, ported from `src/terrain/translation.cpp`.
 *
 * Wesnoth stores a terrain code as two 32-bit layers (`base` and `overlay`),
 * each built from up to four characters most-significant first
 * (`string_to_layer_`, translation.cpp:698-720). A match pattern is a list of
 * codes where `*` in a layer marks a wildcard byte and `!` toggles the sense of
 * every following entry (`terrain_matches`, translation.cpp:413-538). The
 * terrain-graphics builder uses exactly this to decide whether a rule applies.
 *
 * Also ported here: `read_builder_map` (translation.cpp:591-680) and the
 * builder's positional map walk (`terrain_builder::parse_mapstring`,
 * builder.cpp:796-838). In a `map="..."` rule each row is a comma-separated set
 * of chunks; a digit is a named anchor, `*` is "any terrain", `.` is an empty
 * placeholder and an empty chunk is ignored. Rows alternate column parity, so
 * two text lines describe one visual hex row.
 */

export const NO_LAYER = 0xffffffff;
/** `*` in the overlay when only a base is written (`WILDCARD`, translation.hpp:39). */
export const WILDCARD = 0x2a000000;
/** `'.' << 24`, the empty placeholder of a builder map. */
export const TB_DOT = 0x2e000000;
/** `'*' << 24`, the "any terrain" marker of a builder map. */
export const TB_STAR = 0x2a000000;

export interface TerrainCode {
  base: number;
  overlay: number;
}

export const NONE_TERRAIN: TerrainCode = { base: 0, overlay: NO_LAYER };

/** `string_to_layer_`: up to four characters, most significant first, NUL padded. */
export function encodeLayer(text: string): number {
  if (text.length === 0) return NO_LAYER;
  let result = 0;
  for (let i = 0; i < 4; i++) {
    const c = i < text.length ? text.charCodeAt(i) & 0xff : 0;
    result = ((result << 8) | c) >>> 0;
  }
  return result;
}

/** `string_to_number_`: split on the first `^`; the overlay falls back to `filler`. */
export function encodeCode(text: string, filler: number = NO_LAYER): TerrainCode {
  const trimmed = text.trim();
  if (trimmed === '') return { ...NONE_TERRAIN };
  const caret = trimmed.indexOf('^');
  if (caret === -1) return { base: encodeLayer(trimmed), overlay: filler };
  return { base: encodeLayer(trimmed.slice(0, caret)), overlay: encodeLayer(trimmed.slice(caret + 1)) };
}

/** Stable key for a code, used for `terrain_by_type_` buckets. */
export function codeKey(code: TerrainCode): string {
  return `${code.base},${code.overlay}`;
}

/** `get_layer_mask_`: `*` anywhere widens the mask from that byte on. */
export function layerMask(layer: number): number {
  const b0 = (layer >>> 24) & 0xff;
  const b1 = (layer >>> 16) & 0xff;
  const b2 = (layer >>> 8) & 0xff;
  const b3 = layer & 0xff;
  if (b0 === 0x2a) return 0x00000000;
  if (b1 === 0x2a) return 0xff000000;
  if (b2 === 0x2a) return 0xffff0000;
  if (b3 === 0x2a) return 0xffffff00;
  return 0xffffffff;
}

export function codeMask(code: TerrainCode): TerrainCode {
  if (code.overlay === NO_LAYER) {
    return { base: layerMask(code.base), overlay: 0xffffffff };
  }
  return { base: layerMask(code.base), overlay: layerMask(code.overlay) };
}

export function hasWildcard(code: TerrainCode): boolean {
  if (code.overlay === NO_LAYER) return layerMask(code.base) !== 0xffffffff;
  return layerMask(code.base) !== 0xffffffff || layerMask(code.overlay) !== 0xffffffff;
}

/** `t_translation::STAR`, the code `*` with no overlay. */
export const STAR: TerrainCode = { base: TB_STAR, overlay: NO_LAYER };
/** `t_translation::NOT`, the code `!`; it toggles the accumulated result. */
export const NOT_BASE = 0x21000000;

/**
 * `read_list`: a comma separated list of codes. The `filler` becomes the
 * overlay of every entry that writes only a base, which is how
 * `[terrain_graphics]` makes `type=Ch` mean "Ch with any overlay".
 */
export function parseTerrainList(text: string, filler: number = NO_LAYER): TerrainCode[] {
  if (text.trim() === '') return [];
  return text.split(',').map((chunk) => encodeCode(chunk, filler));
}

/**
 * `terrain_matches`: does `src` match the pattern list `dest`? A `!` toggles the
 * accumulated result for the entries that follow; a trailing `*` accepts
 * anything; otherwise each entry is compared exactly, then as a mask.
 */
export function terrainMatches(src: TerrainCode, dest: readonly TerrainCode[]): boolean {
  if (dest.length === 0) return false;
  let result = true;
  for (const entry of dest) {
    if (entry.base === STAR.base && entry.overlay === STAR.overlay) return result;
    if (entry.base === NOT_BASE) {
      result = !result;
      continue;
    }
    if (src.base === entry.base && src.overlay === entry.overlay) return result;
    const mask = codeMask(entry);
    const maskedBase = (entry.base & mask.base) >>> 0;
    const maskedOverlay = (entry.overlay & mask.overlay) >>> 0;
    if (
      hasWildcard(entry) &&
      ((src.base & mask.base) >>> 0) === maskedBase &&
      ((src.overlay & mask.overlay) >>> 0) === maskedOverlay
    ) {
      return result;
    }
  }
  return !result;
}

/** `string_to_builder_number_`: a number is an anchor, anything else its first char. */
export function stringToBuilderNumber(text: string): TerrainCode {
  const trimmed = text.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') return { ...NONE_TERRAIN };
  const numeric = /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : -1;
  if (numeric === -1) return { base: (trimmed.charCodeAt(0) << 24) >>> 0, overlay: 0 };
  return { base: 0, overlay: numeric };
}

export interface BuilderMap {
  lines: number;
  columns: number;
  data: TerrainCode[];
}

const DOT_CODE: TerrainCode = { base: TB_DOT, overlay: 0 };

function isNewline(c: string): boolean {
  return c === '\n' || c === '\r';
}

/** `get_map_size`: line count and the widest comma separated row. */
function measureMap(text: string, start: number): { columns: number; lines: number } {
  let columns = 1;
  let lines = 0;
  let i = start;
  while (i < text.length) {
    let width = 1;
    lines++;
    while (i < text.length && !isNewline(text[i])) {
      if (text[i] === ',') width++;
      i++;
    }
    columns = Math.max(columns, width);
    while (i < text.length && isNewline(text[i])) i++;
  }
  return { columns, lines };
}

/** `read_builder_map`: a rectangle of codes, `.` filling the unused cells. */
export function readBuilderMap(text: string): BuilderMap {
  let offset = 0;
  while (offset < text.length && isNewline(text[offset])) offset++;
  if (offset + 1 >= text.length) return { lines: 0, columns: 0, data: [] };
  const { columns, lines } = measureMap(text, offset);
  const data: TerrainCode[] = new Array(lines * columns).fill(DOT_CODE).map(() => ({ ...DOT_CODE }));
  let x = 0;
  let y = 0;
  while (offset < text.length) {
    let separator = offset;
    while (separator < text.length && text[separator] !== ',' && !isNewline(text[separator])) separator++;
    const chunk = separator === offset ? '' : text.slice(offset, separator);
    const tile = stringToBuilderNumber(chunk);
    if (columns <= x || lines <= y) throw new Error('builder map is not a rectangle');
    data[y * columns + x] = tile;
    if (separator >= text.length) {
      offset = text.length;
    } else if (isNewline(text[separator])) {
      y++;
      x = 0;
      offset = separator + 1;
      while (offset < text.length && isNewline(text[offset])) offset++;
    } else {
      x++;
      offset = separator + 1;
    }
  }
  return { lines, columns, data };
}

export interface MapAnchor {
  x: number;
  y: number;
}

export interface MapStringConstraint {
  x: number;
  y: number;
  /** `*` means "any terrain"; the builder adds a STAR terrain constraint. */
  types: TerrainCode[];
}

export interface MapStringResult {
  constraints: MapStringConstraint[];
  /** every location a `pos=N` anchor refers to, keyed by N */
  anchors: Map<number, MapAnchor[]>;
  /** the map rows themselves, for diagnostics */
  rows: string[][];
}

/**
 * `terrain_builder::parse_mapstring`: turn a `map="..."` builder map into the
 * star constraints (at their hex offsets) and the `pos` anchor table.
 */
export function parseMapString(text: string): MapStringResult {
  const map = readBuilderMap(text);
  const result: MapStringResult = { constraints: [], anchors: new Map(), rows: [] };
  if (map.data.length === 0) return result;

  const first = map.data[0];
  let lineno = first.base === NONE_TERRAIN.base && first.overlay === NONE_TERRAIN.overlay ? 1 : 0;
  let x = lineno;
  let y = 0;
  for (let row = 0; row < map.lines; row++) {
    const rowCodes: string[] = [];
    for (let col = x; col < map.columns; col++) {
      const code = map.data[row * map.columns + col] ?? DOT_CODE;
      rowCodes.push(`${code.base},${code.overlay}`);
      if (code.base === TB_DOT) {
        // placeholder, nothing to add
      } else if (code.overlay !== 0) {
        const list = result.anchors.get(code.overlay) ?? [];
        list.push({ x, y });
        result.anchors.set(code.overlay, list);
      } else if (code.base === TB_STAR) {
        result.constraints.push({ x, y, types: [STAR] });
      } else {
        throw new Error(`invalid terrain in builder map: ${code.base},${code.overlay}`);
      }
      x += 2;
    }
    result.rows.push(rowCodes);
    if (lineno % 2 === 1) {
      y++;
      x = 0;
    } else {
      x = 1;
    }
    lineno++;
  }
  return result;
}
