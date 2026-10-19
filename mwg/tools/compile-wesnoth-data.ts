/**
 * Compiles real Wesnoth core data through MWL into the port's generated assets.
 *
 * Run with `npm run data`. Pipeline:
 *
 *   data/core/*.cfg
 *     -> src/simulation/wml.ts       (Wesnoth WML preprocessor + parser)
 *     -> src/adapters/from-mwl.ts    (Wesnoth nodes -> MWL nodes)
 *     -> mwg/mwl compileNodes        (framework schema validation + compile)
 *     -> src/adapters/from-mwl.ts    (MwlCompiledGame -> WesnothData / MapData)
 *     -> src/generated/*.ts          (typed data + inlined asset imports)
 *
 * The framework owns MWL; this tool owns the Wesnoth file layout and the
 * emitted output. Wesnoth-specific tag names, the Freelands map, and the
 * representative-tile renderer hints all live in the port, never in mwg.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWesnothCfg, extractSpecialDefinitions, extractTraitDefinitions, toMapData, toWesnothData, type MapData } from '../src/adapters/from-mwl.ts';
import { collectAnimationImages, normalizeImagePath } from '../src/adapters/unit-animations.ts';
import { parseColorPalettes, parseColorRanges, type ColorRange, type Rgb } from '../src/simulation/color-range.ts';
import { buildTerrainTiles, parseTerrainGraphics, pruneMissingFrames, type TgRuleSpec } from '../src/simulation/terrain-graphics.ts';
import { parseWml, WmlPreprocessor, type WmlNode } from '../src/simulation/wml.ts';
import { parse, parseTerrain, preprocess, type MwlNode } from 'mwg/mwl';
import type { UnitTypeDef } from '../src/simulation/types.ts';
import type { UnitAnimations } from '../src/simulation/animation.ts';
import { CAMPAIGN_DIRS } from './campaign-dirs.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mwgDir = path.resolve(here, '..');
const wesnothRoot = path.resolve(mwgDir, '..');
const dataDir = path.join(wesnothRoot, 'data');
const coreDir = path.join(dataDir, 'core');
const imagesDir = path.join(coreDir, 'images');
const soundsDir = path.join(coreDir, 'sounds');
const generatedDir = path.join(mwgDir, 'src', 'generated');
const assetsDir = path.join(mwgDir, 'src', 'assets', 'wesnoth');

const MACRO_FILES = ['traits.cfg', 'weapon_specials.cfg', 'abilities.cfg', 'schedules.cfg', 'sound-utils.cfg', 'special-notes.cfg', 'multiplayer.cfg'];
/**
 * The unit animation macros. `units.cfg` calls `{STANDING_ANIM_DIRECTIONAL ...}`
 * and friends; without these files those calls expand to nothing and the unit
 * types carry no `[standing_anim]`/`[attack_anim]` children at all. Loading the
 * two files turns 117 standing and 311 attack animations into 150 and 321.
 */
const ANIMATION_MACRO_FILES = ['animation-utils.cfg', 'animation-utils2.cfg'];
const MAP_FILE = path.join(dataDir, 'multiplayer', 'maps', '2p_The_Freelands.map');
const ERA_FILES = [path.join(dataDir, 'multiplayer', 'eras.cfg')];
const TERRAIN_GRAPHICS_DIR = path.join(coreDir, 'terrain-graphics');
const TERRAIN_GRAPHICS_MAIN = path.join(coreDir, 'terrain-graphics.cfg');
const TEAM_COLORS_FILE = path.join(coreDir, 'team-colors.cfg');

/** `add_color_info`: the `[color_range]`/`[color_palette]` data used to recolour units. */
function loadTeamColors(): { ranges: Record<string, ColorRange>; palettes: Record<string, Rgb[]>; defaults: string[] } {
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  const nodes = parseWml(wml.preprocessFile(TEAM_COLORS_FILE), TEAM_COLORS_FILE);
  const { ranges, defaults } = parseColorRanges(nodes);
  return { ranges, palettes: parseColorPalettes(nodes), defaults };
}

/**
 * Load the real terrain-graphics rules. `data/core/_main.cfg` includes the
 * `terrain-graphics/` directory (every macro definition plus the rules those
 * files emit directly) before `terrain-graphics.cfg`, which is why both are
 * preprocessed here in that order.
 */
function loadTerrainGraphicsRules(): TgRuleSpec[] {
  const files = fs
    .readdirSync(TERRAIN_GRAPHICS_DIR)
    .filter((name) => name.endsWith('.cfg'))
    .sort()
    .map((name) => path.join(TERRAIN_GRAPHICS_DIR, name));
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  wml.loadMacros(files);
  const nodes: WmlNode[] = [];
  for (const file of files) nodes.push(...parseWml(wml.preprocessFile(file), file));
  nodes.push(...parseWml(wml.preprocessFile(TERRAIN_GRAPHICS_MAIN), TERRAIN_GRAPHICS_MAIN));
  return parseTerrainGraphics(nodes, 'terrain-graphics.cfg');
}

const SCENARIO_DIR = path.join(mwgDir, 'src', 'scenarios');

/** First `file:` attribute on a `map` node anywhere in the tree, if any. */
function findMapFile(nodes: readonly MwlNode[]): string | undefined {
  for (const node of nodes) {
    if (node.tag === 'map' && node.attributes.file) return node.attributes.file;
    const nested = findMapFile(node.children);
    if (nested) return nested;
  }
  return undefined;
}

/** Resolve a scenario `.mwl`'s map `file:` reference the way `compile-scenario.ts` does. */
function scenarioMaps(): Array<{ width: number; height: number; codes: string[] }> {
  const resolved: Array<{ width: number; height: number; codes: string[] }> = [];
  if (!fs.existsSync(SCENARIO_DIR)) return resolved;
  for (const file of fs.readdirSync(SCENARIO_DIR).filter((name) => name.endsWith('.mwl')).sort()) {
    const source = fs.readFileSync(path.join(SCENARIO_DIR, file), 'utf8');
    const mapFile = findMapFile(parse(preprocess(source, { file }), file));
    if (!mapFile) continue;
    const candidates = [
      path.join(dataDir, mapFile),
      path.join(SCENARIO_DIR, mapFile),
      path.join(dataDir, 'campaigns', 'Two_Brothers', 'maps', mapFile),
    ];
    const mapPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!mapPath) continue;
    resolved.push(parseTerrain(fs.readFileSync(mapPath, 'utf8')));
  }
  return resolved;
}

/**
 * Only the transition art the shipped scenario maps can actually draw. The
 * rules reference the whole of `data/core/images/terrain` (39 MB across 8,514
 * files), but the port's seven maps use a small fraction; collecting the rest
 * would roughly double the single-file bundle for no visible gain. The runtime
 * still holds every rule, so new maps simply request more art at build time.
 */
function shippedTerrainImages(rules: TgRuleSpec[]): Set<string> {
  const images = new Set<string>();
  for (const map of scenarioMaps()) {
    // `collect` records every variant/variation a matched image could resolve
    // to, so one build per map is enough (the time of day only selects between
    // candidates the collector already keeps).
    buildTerrainTiles(
      rules,
      {
        width: map.width,
        height: map.height,
        terrainAt: (x, y) => map.codes[y * map.width + x] ?? 'Gg',
        drawBorder: true,
        tod: 'morning',
      },
      images,
    );
  }
  return images;
}

/**
 * Every named schedule compiled into the bundle (`schedules.cfg` macros).
 * `default` stays the scenario schedule; the rest (summer, winter, indoor
 * and underground variants) are selectable through `GameState.scheduleId`.
 */
const SCHEDULE_MACROS: Record<string, string> = {
  default: '{DEFAULT_SCHEDULE}',
  summer: '{SUMMER_SCHEDULE}',
  winter: '{WINTER_SCHEDULE}',
  indoors: '{INDOORS}',
  underground: '{UNDERGROUND}',
  deep_underground: '{DEEP_UNDERGROUND}',
};

/** Base terrain code -> representative real tile, relative to images/terrain. */
const TERRAIN_TILE: Record<string, string> = {
  Gg: 'grass/green.png',
  Gs: 'grass/semi-dry.png',
  Gd: 'grass/dry.png',
  Gll: 'grass/leaf-litter.png',
  Hh: 'hills/regular.png',
  Mm: 'mountains/basic.png',
  Ww: 'water/coast-tile.png',
  Wo: 'water/ocean-tile.png',
  Wwf: 'water/ford-tile.png',
  Ss: 'swamp/mud.png',
  Rr: 'flat/road.png',
  Rb: 'flat/road.png',
  Rd: 'flat/road.png',
  Re: 'flat/road.png',
  // Ch/Chr/Chw are castle tiles (human_castle, ruin, wall), not chasms; chasm
  // codes are Qx*. The first port mapping had this wrong and rendered castles
  // as the chasm abyss tile.
  Ch: 'castle/castle-tile.png',
  Chw: 'castle/castle-tile.png',
  Chr: 'castle/castle-tile.png',
  Kh: 'castle/keep-tile.png',
  Ce: 'castle/castle-tile.png',
  Tb: 'forest/mushroom-base.png',
  Uu: 'cave/earthy-floor.png',
  Uh: 'cave/earthy-floor.png',
  Ur: 'cave/earthy-floor.png',
  Xu: 'cave/earthy-floor.png',
  Aa: 'frozen/ice.png',
  Ai: 'frozen/ice.png',
};

/** Overlay code -> representative real tile, relative to images/terrain. */
const OVERLAY_TILE: Record<string, string> = {
  '^V': 'village/camp-tile.png',
  '^Ve': 'village/camp-tile.png',
  '^Vh': 'village/camp-tile.png',
  '^Vhh': 'village/camp-tile.png',
  '^Vhs': 'village/camp-tile.png',
  '^Vht': 'village/camp-tile.png',
  '^Vhhr': 'village/camp-tile.png',
  '^Fp': 'forest/deciduous-summer.png',
  '^Fms': 'forest/deciduous-summer.png',
  '^Fds': 'forest/deciduous-summer.png',
  '^Fdw': 'forest/deciduous-summer.png',
  '^Fda': 'forest/deciduous-summer.png',
  '^Ft': 'forest/tropical/jungle-small.png',
  '^Tf': 'forest/tropical/jungle-small.png',
  '^Efm': 'forest/deciduous-summer.png',
  '^Fet': 'forest/deciduous-summer.png',
  '^Xm': 'mountains/basic.png',
};

const options = {
  dataDir,
  onFile: (filePath: string) => console.log(`  wml ${path.relative(wesnothRoot, filePath)}`),
};

/** Every `.cfg` under a directory, recursively, in a stable order. */
function walkCfgFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCfgFiles(full));
    else if (entry.name.endsWith('.cfg')) out.push(full);
  }
  return out.sort();
}

/**
 * A unit file may define a weapon special inline instead of through a macro
 * (`Sceptre_of_Fire/units/Caravan.cfg` writes `[specials][firststrike]
 * id=deterrentstrike ...`). The attack's `specials=` reference then names an id
 * no macro registered, so register the inline definition the same shape
 * `extractSpecialDefinitions` produces.
 */
function collectInlineSpecials(unitNodes: readonly WmlNode[]): WmlNode[] {
  const out: WmlNode[] = [];
  for (const unit of unitNodes) {
    if (unit.tag !== 'unit_type') continue;
    for (const attack of unit.children) {
      if (attack.tag !== 'attack') continue;
      for (const container of attack.children) {
        if (container.tag !== 'specials') continue;
        for (const special of container.children) {
          const id = special.attributes.id;
          // Wesnoth ids may contain spaces (`id=greater drains`), so only empty is invalid.
          if (!id) continue;
          out.push({
            tag: 'weapon_special',
            attributes: { id, tag: special.tag, ...(special.attributes.name === undefined ? {} : { name: special.attributes.name }) },
            children: [special],
            location: special.location,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Each shipped campaign's own `[unit_type]`s and the `[weapon_special]` /
 * `[ability]` / `[trait]` registry entries its units reference, parsed with core
 * macros plus that campaign's `utils/`. The scenario loader drops a `[unit]`
 * whose type is not in the registry (`campaign-loader.ts` "unit without a known
 * type"), and 371 such units used to disappear from the port's campaigns; the
 * campaigns' heroes and custom troops live here. A campaign that fails to
 * preprocess is reported and skipped so one broken file cannot stop the whole
 * data build.
 */
interface UnitSourceResult {
  units: WmlNode[];
  weaponSpecials: WmlNode[];
  abilities: WmlNode[];
  traits: WmlNode[];
}

/** Every `.cfg` directly inside a directory, in a stable order. */
function cfgFilesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.cfg')).map((name) => path.join(dir, name)) : [];
}

/**
 * Compile one `units/` tree with its own macro files (core macros plus the
 * source's own). A source that fails to preprocess is reported and skipped so
 * one broken file cannot stop the whole data build.
 */
function ingestUnitSource(label: string, unitsDir: string, macroFiles: readonly string[]): UnitSourceResult | null {
  const coreMacroFiles = [...MACRO_FILES, ...ANIMATION_MACRO_FILES].map((name) => path.join(coreDir, 'macros', name));
  try {
    const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
    wml.loadMacros([...coreMacroFiles, ...macroFiles]);
    const units: WmlNode[] = [];
    let files = 0;
    let types = 0;
    for (const file of walkCfgFiles(unitsDir)) {
      for (const node of parseWml(wml.preprocessFile(file), file)) {
        if (node.tag === 'units') {
          units.push(...node.children);
          types += node.children.filter((child) => child.tag === 'unit_type').length;
        } else if (['unit_type', 'movetype', 'trait', 'race', 'global_traits'].includes(node.tag)) {
          units.push(node);
          if (node.tag === 'unit_type') types += 1;
        }
      }
      files += 1;
    }
    const specials = extractSpecialDefinitions(wml, macroFiles);
    console.log(`  units ${label}: ${files} files, ${types} unit types, ${specials.weaponSpecials.length} specials, ${specials.abilities.length} abilities`);
    return { units, weaponSpecials: specials.weaponSpecials, abilities: specials.abilities, traits: extractTraitDefinitions(wml, macroFiles) };
  } catch (error) {
    console.warn(`  units ${label}: skipped (${(error as Error).message})`);
    return null;
  }
}

function compileCampaignUnits(): UnitSourceResult {
  const units: WmlNode[] = [];
  const weaponSpecials: WmlNode[] = [];
  const abilities: WmlNode[] = [];
  const traits: WmlNode[] = [];
  const merge = (result: UnitSourceResult | null): void => {
    if (!result) return;
    units.push(...result.units);
    weaponSpecials.push(...result.weaponSpecials);
    abilities.push(...result.abilities);
    traits.push(...result.traits);
  };
  for (const campaign of CAMPAIGN_DIRS) {
    const unitsDir = path.join(dataDir, 'campaigns', campaign, 'units');
    if (!fs.existsSync(unitsDir)) continue;
    merge(ingestUnitSource(campaign, unitsDir, cfgFilesIn(path.join(dataDir, 'campaigns', campaign, 'utils'))));
  }
  // `data/internal` holds unit types a scenario or an era references directly
  // (Liberty's `Rogue Mage`, `Shadow Mage`, `Dwarvish Witness`); their macro
  // resources live beside them.
  const internalDir = path.join(dataDir, 'internal');
  if (fs.existsSync(internalDir)) {
    for (const entry of fs.readdirSync(internalDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const unitsDir = path.join(internalDir, entry.name, 'units');
      if (!fs.existsSync(unitsDir)) continue;
      merge(ingestUnitSource(
        `internal/${entry.name}`,
        unitsDir,
        [...cfgFilesIn(path.join(internalDir, entry.name, 'utils')), ...walkCfgFiles(path.join(internalDir, 'resources')).filter((file) => file.endsWith('.cfg'))],
      ));
    }
  }
  weaponSpecials.push(...collectInlineSpecials(units));
  return { units, weaponSpecials, abilities, traits };
}

function collectAssets(
  units: Record<string, UnitTypeDef>,
  map: MapData,
  declared: readonly string[] = [],
  animationImages: Iterable<string> = [],
  terrainImages: Iterable<string> = [],
): Map<string, string> {
  // asset path (relative to images/) -> absolute source path
  const assets = new Map<string, string>();
  const missing: string[] = [];
  // Wesnoth resolves an image across every data root, and each campaign ships
  // its unit art under its own `images/`; a bare `units/garard.png` is not in
  // core. Search core first, then the shipped campaigns in their own order.
  // A campaign ships its art under its own `images/`, and `data/internal` units
  // under theirs; `data/internal` has no separate index, so enumerate it too.
  const internalDirs = fs.existsSync(path.join(dataDir, 'internal'))
    ? fs.readdirSync(path.join(dataDir, 'internal'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dataDir, 'internal', entry.name))
    : [];
  const imageRoots = [
    imagesDir,
    ...CAMPAIGN_DIRS.map((name) => path.join(dataDir, 'campaigns', name, 'images')),
    ...internalDirs.map((dir) => path.join(dir, 'images')),
    // the checkout's own `images/` (the title logo lives there, not under `data/core/images`)
    path.join(wesnothRoot, 'images'),
    // World Conquest ships its own item and unit art, run by its Lua rather than listed in unit files
    path.join(dataDir, 'campaigns', 'World_Conquest', 'images'),
  ].filter((dir) => fs.existsSync(dir));
  const soundRoots = [
    soundsDir,
    ...CAMPAIGN_DIRS.map((name) => path.join(dataDir, 'campaigns', name, 'sounds')),
    ...internalDirs.map((dir) => path.join(dir, 'sounds')),
  ].filter((dir) => fs.existsSync(dir));
  const add = (rawRel: string, roots: readonly string[] = imageRoots): void => {
    // A few campaign unit files spell the source root out fully
    // (`data/core/images/scenery/...`); the stored image is normalized the same
    // way, so the bundle key and the runtime path stay in step.
    const rel = normalizeImagePath(rawRel);
    // Image-modification suffixes (~BLIT, ~RC, ~CROP, ...) are not ported; the
    // standing image uses the base file before the first `~`.
    const range = rel.match(/\[([0-9]+)~([0-9]+)\]/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let index = start; index <= end; index += 1) add(rel.replace(range[0], String(index)), roots);
      return;
    }
    const alternatives = rel.match(/\[([0-9]+(?:,[0-9]+)+)\]/);
    if (alternatives) {
      for (const alternative of alternatives[1].split(',')) add(rel.replace(alternatives[0], alternative), roots);
      return;
    }
    const transform = rel.match(/~[A-Za-z][A-Za-z0-9_-]*(?:\(|$)/);
    const base = transform ? rel.slice(0, transform.index) : rel;
    const source = roots.map((candidate) => path.join(candidate, base)).find((candidate) => fs.existsSync(candidate));
    if (!source) throw new Error(`missing real asset: ${base}`);
    assets.set(base, source);
  };
  const addOptional = (rel: string, roots: readonly string[] = imageRoots): void => {
    try {
      add(rel, roots);
    } catch {
      // The engine skips a terrain frame whose file is absent and drops the
      // rule when none remain (builder.cpp:443-460), and a missing sound is a
      // silent non-play rather than a fatal load error, so neither stops the
      // build. Campaign data references a few sounds the checkout never had
      // (Dusk of Dawn's `fist-miss.ogg`).
      missing.push(rel);
    }
  };

  // The framework compiler collects every asset a node references, including
  // the campaign data's `profile=` portraits. Wesnoth logs a missing image and
  // falls back rather than failing to load, so a missing declared asset is
  // reported in `missing` and skipped (The Hammer of Thursagan's Dwarvish
  // Grenadier names a `portraits/grenadier.png` the checkout never had).
  for (const rel of declared) {
    if (/\.(?:wav|ogg|mp3|flac)$/i.test(rel)) addOptional(rel, soundRoots);
    else if (!/\.map$/i.test(rel)) addOptional(rel);
  }

  for (const unit of Object.values(units)) {
    if (unit.image) add(unit.image);
  }
  // Every frame of every unit animation, plus the sources embedded in their
  // image modifiers (`~BLIT(...)`), so the scene can draw them at runtime. A few
  // campaign frames are absent from the checkout (The South Guard's
  // `units/arand/arand-melee*.png`); Wesnoth skips a missing frame, so the
  // collector reports it instead of stopping the build.
  for (const rel of animationImages) addOptional(rel);
  for (const code of map.codes) {
    const base = code.split('^')[0];
    // Codes are `base` or `base^overlay` (with the caret); keep the caret.
    const overlayKey = code.includes('^') ? '^' + code.split('^').slice(1).flat().filter(Boolean)[0] : null;
    // The ground tile is always needed: an overlay is drawn on top of it.
    const ground = TERRAIN_TILE[base];
    if (ground) add(`terrain/${ground}`);
    const overlay = overlayKey ? OVERLAY_TILE[overlayKey] : undefined;
    if (overlay) add(`terrain/${overlay}`);
  }
  // Every scenario map shares one asset bundle, so collect all the art the
  // representative tables can draw, not only the map parsed above.
  for (const tile of Object.values(TERRAIN_TILE)) add(`terrain/${tile}`);
  for (const tile of Object.values(OVERLAY_TILE)) add(`terrain/${tile}`);
  // HUD art (the default theme's status icons and the time-of-day schedule
  // pictures, `data/themes/default.cfg`, `data/core/macros/schedules.cfg`).
  // World Conquest's Lua and WML name the pictures it places on the map and shows in dialogs;
  // nothing in the unit files lists them, so find them in the source.
  const wcDir = path.join(dataDir, 'campaigns', 'World_Conquest');
  const wcFiles: string[] = [];
  const collectWc = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'images' && entry.name !== 'sounds') collectWc(full);
      } else if (/\.(lua|cfg)$/.test(entry.name)) wcFiles.push(full);
    }
  };
  if (fs.existsSync(wcDir)) collectWc(wcDir);
  for (const file of wcFiles) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/[A-Za-z0-9_\-\/\.+]+\.png/g)) addOptional(match[0].replace(/^data\/core\/images\//, '').replace(/^images\//, ''));
  }
  // Title screen: the real background and logo (`src/gui/dialogs/title_screen.cpp`).
  addOptional('maps/titlescreen.webp');
  addOptional('misc/logo.png');
  for (const icon of ['gold', 'income', 'villages', 'units', 'upkeep', 'sand-clock']) addOptional(`themes/${icon}.png`);
  for (const tod of ['dawn', 'morning', 'afternoon', 'dusk', 'firstwatch', 'secondwatch']) addOptional(`misc/time-schedules/default/schedule-${tod}.png`);
  for (const tod of ['midday', 'midnight', 'indoors', 'underground']) addOptional(`misc/time-schedules/schedule-${tod}.png`);
  // The terrain-graphics transition engine draws far more art than the
  // representative tables: every image the 4,077 rules can reference, with
  // their `@V` variations, animation ranges and `~BLIT`/`~MASK` sources.
  for (const rel of terrainImages) addOptional(rel);
  if (missing.length > 0) console.log(`  assets skipped (${missing.length}, absent from the checkout)`);
  // Story parts are rendered by the dialogue box. Keep the campaign's actual
  // backgrounds in the same Vite asset bundle as portraits and unit art.
  const storyDir = path.join(dataDir, 'campaigns', 'Two_Brothers', 'scenarios');
  const storyImagesDir = path.join(dataDir, 'campaigns', 'Two_Brothers', 'images');
  if (fs.existsSync(storyDir)) {
    for (const file of fs.readdirSync(storyDir).filter((name) => name.endsWith('.cfg'))) {
      const source = fs.readFileSync(path.join(storyDir, file), 'utf8');
      for (const match of source.matchAll(/\bbackground\s*=\s*"?([^\s"\]]+)/g)) add(match[1], [storyImagesDir]);
    }
  }
  return assets;
}

function copyAssets(assets: Map<string, string>): void {
  for (const [rel, source] of assets) {
    const dest = path.join(assetsDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    console.log(`  asset ${rel}`);
  }
}

/**
 * The asset manifest (ROADMAP: "Asset manifest, cache and loading
 * observability"). Every copied asset is recorded with its size and a SHA-256,
 * so CI can see exactly what a build ships, spot an asset that grew or changed
 * unexpectedly, and enforce the documented size budget. It is written under
 * `tests/` rather than `src/generated/` because the browser never reads it: the
 * assets are already inlined into the bundle as data URIs.
 */
function emitAssetManifest(assets: Map<string, string>): void {
  const entries: Record<string, { bytes: number; sha256: string }> = {};
  let total = 0;
  for (const [rel, source] of [...assets.entries()].sort()) {
    const bytes = fs.readFileSync(source);
    entries[rel] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
    total += bytes.length;
  }
  const target = path.join(mwgDir, 'tests', 'asset-manifest.json');
  fs.writeFileSync(target, `${JSON.stringify({ generated: true, count: Object.keys(entries).length, totalBytes: total, assets: entries }, null, '	')}
`, 'utf8');
  console.log(`  asset manifest ${Object.keys(entries).length} files, ${(total / 1048576).toFixed(1)}MB -> ${path.relative(mwgDir, target)}`);
}

function emitAssets(assets: Map<string, string>): void {
  const lines: string[] = [];
  lines.push('/// <reference types="vite/client" />');
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push('');
  const names: string[] = [];
  let index = 0;
  for (const rel of [...assets.keys()].sort()) {
    const name = `asset${index++}`;
    names.push(`  '${rel}': ${name}`);
    lines.push(`import ${name} from '../assets/wesnoth/${rel}';`);
  }
  lines.push('');
  lines.push('export const ASSET_URLS: Record<string, string> = {');
  lines.push(names.join(',\n'));
  lines.push('};');
  lines.push('');
  lines.push('export function assetUrl(path: string): string {');
  lines.push('  const url = ASSET_URLS[path];');
  lines.push('  if (!url) throw new Error(`no compiled asset for "${path}"`);');
  lines.push('  return url;');
  lines.push('}');
  fs.writeFileSync(path.join(generatedDir, 'assets.ts'), lines.join('\n'), 'utf8');
}

function emitData(data: ReturnType<typeof toWesnothData>, map: MapData): void {
  const lines: string[] = [];
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push("import type { WesnothData } from '../simulation/types.ts';");
  lines.push('');
  lines.push(`export const GAME_DATA: WesnothData = ${JSON.stringify(data, null, '\t')};`);
  lines.push('');
  lines.push(`export const GAME_MAP = ${JSON.stringify({ name: '2p_The_Freelands', ...map }, null, '\t')};`);
  fs.writeFileSync(path.join(generatedDir, 'game-data.ts'), lines.join('\n'), 'utf8');
}

/**
 * Emit the representative terrain-art tables. They live in the generated output
 * so the surface and the scene cannot drift apart, and they are documented as an
 * approximation: the real terrain-graphics transition engine is not ported.
 */
function emitTerrainArt(): void {
  const lines: string[] = [];
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push('// Base map code -> full tile image (terrain is 72px per hex in Wesnoth).');
  lines.push('export const TERRAIN_PATH: Record<string, string> = {');
  for (const [code, tile] of Object.entries(TERRAIN_TILE)) lines.push(`\t${code}: 'terrain/${tile}',`);
  lines.push('};');
  lines.push('');
  lines.push('// Overlay code (with caret) -> image drawn over the base tile.');
  lines.push('export const OVERLAY_PATH: Record<string, string> = {');
  for (const [code, tile] of Object.entries(OVERLAY_TILE)) lines.push(`\t'${code}': 'terrain/${tile}',`);
  lines.push('};');
  fs.writeFileSync(path.join(generatedDir, 'terrain-art.ts'), lines.join('\n'), 'utf8');
}

/**
 * Emit the compiled unit animations. They are presentation data (frames and
 * durations), generated from the same parsed unit types as `game-data.ts`, so
 * the scene never re-parses a `.cfg` at runtime.
 */
function emitAnimations(animations: Record<string, UnitAnimations>): void {
  const lines: string[] = [];
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push("import type { UnitAnimations } from '../simulation/animation.ts';");
  lines.push('');
  lines.push('// Real unit frames from data/core/units, by unit type id.');
  lines.push(`export const UNIT_ANIMATIONS: Record<string, UnitAnimations> = ${JSON.stringify(animations, null, '\t')};`);
  fs.writeFileSync(path.join(generatedDir, 'unit-animations.ts'), lines.join('\n'), 'utf8');
}

/**
 * Emit the compiled terrain-graphics rules. They are the real
 * `[terrain_graphics]` nodes of `data/core/terrain-graphics/`, already macro
 * expanded, so the scene never re-parses a `.cfg` at runtime. The builder in
 * `src/simulation/terrain-graphics.ts` rotates and applies them per scenario.
 */
function emitTerrainTransitions(rules: TgRuleSpec[]): void {
  const lines: string[] = [];
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push("import type { TgRuleSpec } from '../simulation/terrain-graphics.ts';");
  lines.push('');
  lines.push('// Real transition rules from data/core/terrain-graphics.cfg and its directory.');
  // Emitted as JSON text rather than an array literal: 4,077 rules of nested
  // objects exceed TypeScript's inference limit (TS2590) as a literal.
  lines.push(`export const TERRAIN_RULES: TgRuleSpec[] = JSON.parse(${JSON.stringify(JSON.stringify(rules))});`);
  lines.push('');
  fs.writeFileSync(path.join(generatedDir, 'terrain-transitions.ts'), lines.join('\n'), 'utf8');
}

/**
 * Emit the team-colour data. The scene recolours the magenta source palette
 * onto each side's range with `generateColorMapping`, so the range and palette
 * tables live next to the compiled game data.
 */
function emitTeamColors(
  ranges: Record<string, ColorRange>,
  palettes: Record<string, Rgb[]>,
  defaults: string[],
): void {
  const lines: string[] = [];
  lines.push('// Generated by tools/compile-wesnoth-data.ts - do not edit.');
  lines.push("import type { ColorRange, Rgb } from '../simulation/color-range.ts';");
  lines.push('');
  lines.push('// Real [color_range] entries from data/core/team-colors.cfg, by id.');
  lines.push(`export const COLOR_RANGES: Record<string, ColorRange> = ${JSON.stringify(ranges, null, '\t')};`);
  lines.push('');
  lines.push('// Real [color_palette] entries (the exact pixels that get recoloured).');
  lines.push(`export const COLOR_PALETTES: Record<string, Rgb[]> = ${JSON.stringify(palettes, null, '\t')};`);
  lines.push('');
  lines.push('// [color_range] entries with default=yes, in file order (the side colour order).');
  lines.push(`export const DEFAULT_COLOR_RANGES: string[] = ${JSON.stringify(defaults)};`);
  lines.push('');
  fs.writeFileSync(path.join(generatedDir, 'team-colors.ts'), lines.join('\n'), 'utf8');
}

function main(): void {
  console.log('compile-wesnoth-data:');
  fs.mkdirSync(generatedDir, { recursive: true });
  // Rebuild the asset tree from scratch: the transition-image set shrinks when
  // a scenario map stops needing art, and stale files would otherwise linger.
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const macroFiles = MACRO_FILES.map((name) => path.join(coreDir, 'macros', name));
  const animationMacroFiles = ANIMATION_MACRO_FILES.map((name) => path.join(coreDir, 'macros', name));
  console.log(`  macros ${MACRO_FILES.length} files, animation macros ${ANIMATION_MACRO_FILES.length} files`);

  const terrainFile = path.join(coreDir, 'terrain.cfg');
  const unitsFile = path.join(coreDir, 'units.cfg');
  const campaignUnits = compileCampaignUnits();
  const mapText = fs.readFileSync(MAP_FILE, 'utf8');
  const { default: defaultSchedule, ...extraSchedules } = SCHEDULE_MACROS;
  const compiled = compileWesnothCfg({
    dataDir,
    terrainFile,
    unitsFile,
    extraUnits: campaignUnits.units,
    extraWeaponSpecials: campaignUnits.weaponSpecials,
    extraAbilities: campaignUnits.abilities,
    extraTraits: campaignUnits.traits,
    macroFiles,
    animationMacroFiles,
    scheduleText: defaultSchedule,
    extraSchedules,
    eraFiles: ERA_FILES,
    map: { name: '2p_The_Freelands', text: mapText, file: path.relative(wesnothRoot, MAP_FILE).replaceAll('\\', '/') },
    onFile: options.onFile,
  });
  console.log(`  mwl roots ${compiled.roots.length}, assets referenced ${compiled.assets.length}, messages ${compiled.messages.length}`);

  const data = toWesnothData(compiled);
  // `data/game_config.cfg`'s `[sounds]` table is the engine's own cue list, so
  // the audio path reads it rather than guessing file names.
  const gameConfig = parseWml(fs.readFileSync(path.join(dataDir, 'game_config.cfg'), 'utf8'), 'game_config.cfg')[0];
  const sounds: Record<string, string> = {};
  const statusSounds: Record<string, string> = {};
  const soundsBlock = gameConfig?.children.find((child) => child.tag === 'sounds');
  for (const [key, value] of Object.entries(soundsBlock?.attributes ?? {})) sounds[key] = value;
  for (const status of soundsBlock?.children.filter((child) => child.tag === 'status') ?? []) {
    for (const [key, value] of Object.entries(status.attributes)) statusSounds[key] = value;
  }
  if (Object.keys(sounds).length) data.sounds = sounds;
  if (Object.keys(statusSounds).length) data.statusSounds = statusSounds;
  console.log(`  sounds ${Object.keys(sounds).length} cues, ${Object.keys(statusSounds).length} status cues`);
  const map = toMapData(compiled);
  console.log(
    `  terrains ${Object.keys(data.terrains).length}, movetypes ${Object.keys(data.movetypes).length}, traits ${Object.keys(data.traits).length}, unit types ${Object.keys(data.unitTypes).length}, schedule ${data.schedule.length}, schedules ${Object.keys(data.schedules ?? {}).length}, eras ${Object.keys(data.eras ?? {}).length}`,
  );
  console.log(`  map ${map.width}x${map.height} from ${path.relative(wesnothRoot, MAP_FILE)}`);

  const animationImages = new Set<string>();
  for (const animations of Object.values(compiled.unitAnimations)) {
    for (const image of collectAnimationImages(animations)) animationImages.add(image);
  }
  const animated = Object.values(compiled.unitAnimations).filter((entry) => entry.standing.length || entry.attacks.length).length;
  console.log(`  unit animations ${Object.keys(compiled.unitAnimations).length} types (${animated} drawable), ${animationImages.size} frame images`);

  const parsedTerrainRules = loadTerrainGraphicsRules();
  const missingFrames = parsedTerrainRules.length;
  const terrainRules = pruneMissingFrames(parsedTerrainRules, (relative) => fs.existsSync(path.join(imagesDir, relative)));
  const prunedVariations = terrainRules.reduce(
    (total, rule) => total + rule.constraints.reduce((sum, constraint) => sum + constraint.images.reduce((count, image) => count + image.variants.length, 0), 0),
    0,
  );
  console.log(`  terrain-graphics rules ${missingFrames}, ${prunedVariations} drawable variants`);
  const terrainImages = shippedTerrainImages(terrainRules);
  console.log(
    `  terrain-graphics rules ${terrainRules.length} (${new Set(terrainRules.map((rule) => rule.file)).size} files), ${terrainImages.size} images drawn by the shipped maps`,
  );

  const teamColors = loadTeamColors();
  console.log(
    `  team colours ${Object.keys(teamColors.ranges).length} ranges, ${Object.keys(teamColors.palettes).length} palettes, ${teamColors.defaults.length} default order`,
  );

  const assets = collectAssets(data.unitTypes, map, compiled.assets, animationImages, terrainImages);
  copyAssets(assets);
  emitAssets(assets);
  emitAssetManifest(assets);
  emitData(data, map);
  emitTerrainArt();
  emitTerrainTransitions(terrainRules);
  emitTeamColors(teamColors.ranges, teamColors.palettes, teamColors.defaults);
  emitAnimations(compiled.unitAnimations);
  console.log('  wrote src/generated/game-data.ts, assets.ts, terrain-art.ts, terrain-transitions.ts, team-colors.ts, and unit-animations.ts');
}

main();
