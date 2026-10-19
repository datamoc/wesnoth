/**
 * Colour ranges and palette recolouring, ported from `src/color_range.cpp` and
 * the `[color_range]` / `[color_palette]` data in `data/core/team-colors.cfg`.
 *
 * A `[color_range]` is four reference colours (average/mid, highlight/max,
 * shadow/min, and a high-contrast minimap colour). Wesnoth recolours unit art
 * by mapping a source palette (the `magenta` entry of `[color_palette]`, the
 * exact RGB values the artists painted team-coloured pixels with) onto the
 * shades of a target range: `generate_color_mapping(range, magenta)` is what
 * `~RC(magenta>range)` and the team-colour pass use.
 *
 * `recolor_palette` is transliterated from `color_range.cpp:29-62`; the
 * arithmetic (integer average, float ratio, truncating cast, clamp to 255) and
 * the branch order are kept so the mapped shades match the engine's.
 */

import type { WmlNode } from './wml.ts';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ColorRange {
  mid: Rgb;
  max: Rgb;
  min: Rgb;
  rep: Rgb;
}

export function packRgb(color: Rgb): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

export function unpackRgb(packed: number): Rgb {
  return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
}

/** `color_t::from_hex_string`: six hex digits, `RRGGBB`. */
export function parseHexColor(text: string): Rgb | undefined {
  const trimmed = text.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function average(color: Rgb): number {
  return Math.floor((color.r + color.g + color.b) / 3);
}

const clamp255 = (value: number): number => Math.max(0, Math.min(255, value));

/**
 * `recolor_palette`: map each source colour onto the range's shades. Colours at
 * or below the first source colour's average blend the range's mid and min;
 * brighter ones blend mid and max.
 */
export function recolorPalette(range: ColorRange, oldRgb: readonly Rgb[]): Rgb[] {
  const out: Rgb[] = [];
  const referenceAvg = oldRgb.length > 0 ? average(oldRgb[0]) : 255;
  for (const old of oldRgb) {
    const oldAvg = average(old);
    let mapped: Rgb;
    if (referenceAvg !== 0 && oldAvg <= referenceAvg) {
      const ratio = oldAvg / referenceAvg;
      mapped = {
        r: clamp255(Math.trunc(ratio * range.mid.r + (1 - ratio) * range.min.r)),
        g: clamp255(Math.trunc(ratio * range.mid.g + (1 - ratio) * range.min.g)),
        b: clamp255(Math.trunc(ratio * range.mid.b + (1 - ratio) * range.min.b)),
      };
    } else if (referenceAvg !== 255) {
      const ratio = (255 - oldAvg) / (255 - referenceAvg);
      mapped = {
        r: clamp255(Math.trunc(ratio * range.mid.r + (1 - ratio) * range.max.r)),
        g: clamp255(Math.trunc(ratio * range.mid.g + (1 - ratio) * range.max.g)),
        b: clamp255(Math.trunc(ratio * range.mid.b + (1 - ratio) * range.max.b)),
      };
    } else {
      mapped = { ...range.mid };
    }
    out.push(mapped);
  }
  return out;
}

/** `base_palette`: 509 blue-shaded entries `generate_reference_palette` maps. */
export function basePalette(): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 255; i !== 0; i--) {
    out.push({ r: 0, g: 0, b: i });
    const j = 255 - i;
    if (j !== 0) out.push({ r: j, g: j, b: 255 });
  }
  return out;
}

export function generateReferencePalette(range: ColorRange): Rgb[] {
  return recolorPalette(range, basePalette());
}

/** `generate_color_mapping` in the `{from, to}` shape MWG's exact remap takes. */
export function paletteMapping(range: ColorRange, oldRgb: readonly Rgb[]): { from: number[]; to: number[] } {
  return { from: oldRgb.map(packRgb), to: recolorPalette(range, oldRgb).map(packRgb) };
}

/** `color_range(const std::vector<color_t>&)`: first is mid, then max, min, rep. */
export function colorRangeFromColors(colors: readonly Rgb[]): ColorRange {
  const mid = colors[0] ?? { r: 128, g: 128, b: 128 };
  return {
    mid,
    max: colors[1] ?? { r: 255, g: 255, b: 255 },
    min: colors[2] ?? { r: 0, g: 0, b: 0 },
    rep: colors[3] ?? mid,
  };
}

function splitColors(value: string | undefined): Rgb[] {
  if (!value) return [];
  const out: Rgb[] = [];
  for (const entry of value.split(',')) {
    const color = parseHexColor(entry);
    if (color) out.push(color);
  }
  return out;
}

/** Parse `[color_range]` nodes (`add_color_info`, game_config.cpp:466-490). */
export function parseColorRanges(nodes: readonly WmlNode[]): { ranges: Record<string, ColorRange>; defaults: string[] } {
  const ranges: Record<string, ColorRange> = {};
  const defaults: string[] = [];
  for (const node of nodes) {
    if (node.tag !== 'color_range') continue;
    const id = node.attributes.id;
    const colors = splitColors(node.attributes.rgb);
    if (!id || colors.length === 0) continue;
    ranges[id] = colorRangeFromColors(colors);
    if (/^(1|yes|true)$/i.test(node.attributes.default ?? '')) defaults.push(id);
  }
  return { ranges, defaults };
}

/** Parse `[color_palette]` nodes: each attribute is a named list of exact RGB values. */
export function parseColorPalettes(nodes: readonly WmlNode[]): Record<string, Rgb[]> {
  const palettes: Record<string, Rgb[]> = {};
  for (const node of nodes) {
    if (node.tag !== 'color_palette') continue;
    for (const [name, value] of Object.entries(node.attributes)) {
      const colors = splitColors(value);
      if (colors.length > 0) palettes[name] = colors;
    }
  }
  return palettes;
}
