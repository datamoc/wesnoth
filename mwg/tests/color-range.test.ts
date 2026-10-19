/**
 * Team-colour palette recolouring (P4), ported from `src/color_range.cpp` and
 * `data/core/team-colors.cfg`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  basePalette,
  generateReferencePalette,
  packRgb,
  paletteMapping,
  parseColorPalettes,
  parseColorRanges,
  parseHexColor,
  recolorPalette,
  unpackRgb,
  type ColorRange,
  type Rgb,
} from '../src/simulation/color-range.ts';
import { remapPixels } from 'mwg/two-d/render';
import { parseWml, WmlPreprocessor } from '../src/simulation/wml.ts';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(mwgDir, '..', 'data');

const rgb = (hex: string): Rgb => {
  const color = parseHexColor(hex);
  assert.ok(color, `parse ${hex}`);
  return color;
};

// data/core/team-colors.cfg `[color_range] id=red rgb=FF0000,FFFFFF,000000,FF0000`
const RED: ColorRange = { mid: rgb('FF0000'), max: rgb('FFFFFF'), min: rgb('000000'), rep: rgb('FF0000') };
const MAGENTA = ['F49AC1', '3F0016', 'FDE9F1'].map(rgb);

test('recolor_palette follows the C++ branches', () => {
  // reference average is (244+154+193)/3 = 197
  const mapped = recolorPalette(RED, MAGENTA);
  // The average shade maps to the range's mid exactly.
  assert.deepEqual(mapped[0], { r: 255, g: 0, b: 0 });
  // A dark magenta blends mid and min: floor(28/197 * 255) = 36.
  assert.deepEqual(mapped[1], { r: 36, g: 0, b: 0 });
  // A bright one blends mid and max: floor((13/58) * 255) = 197 on the
  // highlight channels, so the light shade is (255, 197, 197).
  assert.deepEqual(mapped[2], { r: 255, g: 197, b: 197 });
});

test('the Wesnoth mapping swaps only palette pixels through MWG exact remap', () => {
  const mapping = paletteMapping(RED, MAGENTA);
  assert.equal(mapping.from.length, 3);
  assert.equal(mapping.to[0], packRgb({ r: 255, g: 0, b: 0 }));

  // Two magenta pixels and one unrelated pixel, as RGBA.
  const pixels = new Uint8ClampedArray([
    0xf4, 0x9a, 0xc1, 0xff,
    0x3f, 0x00, 0x16, 0xff,
    0x12, 0x34, 0x56, 0xff,
  ]);
  const out = remapPixels(pixels, mapping, 'exact');
  assert.deepEqual([...out], [255, 0, 0, 255, 36, 0, 0, 255, 0x12, 0x34, 0x56, 255]);
});

test('base palette and reference palette match the engine sizes', () => {
  assert.equal(basePalette().length, 509);
  const reference = generateReferencePalette(RED);
  assert.equal(reference.length, 509);
  // Every generated shade is red-dominant, like the engine's red range.
  for (const color of reference) assert.ok(color.r >= color.g && color.r >= color.b);
  assert.equal(packRgb(unpackRgb(0xf49ac1)), 0xf49ac1);
});

test('the real team-colors.cfg parses into ranges and palettes', async () => {
  const file = path.join(dataDir, 'core', 'team-colors.cfg');
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  const nodes = parseWml(wml.preprocessFile(file), file);
  const { ranges, defaults } = parseColorRanges(nodes);
  const palettes = parseColorPalettes(nodes);

  assert.equal(Object.keys(ranges).length, 48, `${Object.keys(ranges).length} color ranges`);
  assert.deepEqual(defaults.slice(0, 4), ['red', 'blue', 'green', 'purple']);
  assert.deepEqual(ranges.red, RED);
  assert.equal(palettes.magenta.length, 19, 'the magenta source palette');
  assert.ok(palettes.flag_green.length > 100, 'flag_green palette');
  assert.ok(palettes.ellipse_red.length > 100, 'ellipse_red palette');

  // Recolouring magenta onto every default range yields that range's mid colour
  // for the first (average) source pixel.
  for (const id of defaults.slice(0, 8)) {
    const mapping = paletteMapping(ranges[id], palettes.magenta);
    assert.equal(mapping.to[0], packRgb(ranges[id].mid), `${id} average shade`);
  }
});
