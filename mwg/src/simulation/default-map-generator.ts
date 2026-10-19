// The engine's default random map generator.
//
// Source: `src/generators/default_map_generator_job.cpp` (height map, lakes, rivers,
// terrain conversion, castles, roads, villages), as reached by Lua's
// `wesnoth.map.generate(width, height, cfg)` (`src/scripting/mapgen_lua_kernel.cpp
// intf_default_generate`), which is what World Conquest's map scripts call.
//
// Deviations (PORT_COVERAGE.md "Default map generator"):
// - the random stream is a seeded 32-bit generator, not libstdc++'s `std::mt19937`, so
//   a given seed gives a different (equally valid) map than the C++ engine;
// - the Lua entry point passes no label map, so the engine's landform/village naming
//   (name_generator_factory) never runs there either, and is not ported.
//
// Pure: no DOM, no node imports.

export type WmlTable = { [key: string]: unknown };

interface Loc {
  x: number;
  y: number;
}

const GRASS_LAND = 'Gg';
const SHALLOW_WATER = 'Ww';
const DEEP_WATER = 'Wo';
const HUMAN_KEEP = 'Kh';
const HUMAN_CASTLE = 'Ch';
const DEFAULT_BORDER = 1;

/** mulberry32: a uint32 per call, standing in for the engine's `std::mt19937`. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
}

// ---------------------------------------------------------------- config access
function attr(cfg: WmlTable, name: string): string {
  const value = cfg[name];
  if (value === undefined || value === null) return '';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

function toInt(value: string, fallback = 0): number {
  if (value === '') return fallback;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDouble(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBool(value: string): boolean {
  return value === 'yes' || value === 'true' || value === '1';
}

/** The contents of every child with a tag; a config table lists children as `{ tag, contents }`. */
function childRange(cfg: WmlTable, tag: string): WmlTable[] {
  const out: WmlTable[] = [];
  for (let index = 1; ; index++) {
    const entry = cfg[String(index)] as WmlTable | undefined;
    if (!entry) break;
    if (entry['1'] === tag) out.push(entry['2'] as WmlTable);
  }
  return out;
}

function findChild(cfg: WmlTable, tag: string, key: string, value: string): WmlTable | undefined {
  return childRange(cfg, tag).find((child) => attr(child, key) === value);
}

// ---------------------------------------------------------------- terrain codes
/** `Gg^` and `Gg` are the same terrain; keep one spelling. */
function code(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('^') ? trimmed.slice(0, -1) : trimmed;
}

function readList(text: string): string[] {
  return text.split(',').map(code).filter((entry) => entry !== '');
}

// ---------------------------------------------------------------- hex geometry
/** Adjacent hexes in the engine's order: N, NE, SE, S, SW, NW (map_location.cpp). */
function adjacent(loc: Loc): Loc[] {
  const even = loc.x % 2 === 0;
  return [
    { x: loc.x, y: loc.y - 1 },
    { x: loc.x + 1, y: loc.y - (even ? 1 : 0) },
    { x: loc.x + 1, y: loc.y + (even ? 0 : 1) },
    { x: loc.x, y: loc.y + 1 },
    { x: loc.x - 1, y: loc.y + (even ? 0 : 1) },
    { x: loc.x - 1, y: loc.y - (even ? 1 : 0) },
  ];
}

function distanceBetween(a: Loc, b: Loc): number {
  const horizontal = Math.abs(a.x - b.x);
  const penalty = ((a.x % 2 === 0 && b.x % 2 !== 0 && a.y < b.y) || (b.x % 2 === 0 && a.x % 2 !== 0 && b.y < a.y)) ? 1 : 0;
  return Math.max(horizontal, Math.abs(a.y - b.y) + penalty + Math.floor(horizontal / 2));
}

function tilesRadius(center: Loc, radius: number): Loc[] {
  const seen = new Map<string, Loc>([[`${center.x},${center.y}`, center]]);
  let ring: Loc[] = [center];
  for (let step = 0; step < radius; step++) {
    const next: Loc[] = [];
    for (const loc of ring) {
      for (const n of adjacent(loc)) {
        const key = `${n.x},${n.y}`;
        if (!seen.has(key)) {
          seen.set(key, n);
          next.push(n);
        }
      }
    }
    ring = next;
  }
  return [...seen.values()];
}

const key = (loc: Loc): string => `${loc.x},${loc.y}`;

// ---------------------------------------------------------------- the generator
type HeightMap = number[][];
type TerrainMap = string[][];

export interface GeneratorData {
  width: number;
  height: number;
  nplayers: number;
  nvillages: number;
  iterations: number;
  hillSize: number;
  castleSize: number;
  islandSize: number;
  islandOffCenter: number;
  maxLakes: number;
  linkCastles: boolean;
}

/** `intf_default_generate`: build the arguments from the script's config table. */
export function generatorDataFromConfig(width: number, height: number, cfg: WmlTable): GeneratorData {
  return {
    width,
    height,
    nplayers: toInt(attr(cfg, 'nplayers'), 2),
    nvillages: toInt(attr(cfg, 'nvillages')),
    iterations: toInt(attr(cfg, 'iterations')),
    hillSize: toInt(attr(cfg, 'hill_size')),
    castleSize: toInt(attr(cfg, 'castle_size')),
    islandSize: toInt(attr(cfg, 'island_size')),
    islandOffCenter: toInt(attr(cfg, 'island_off_center')),
    maxLakes: toInt(attr(cfg, 'max_lakes')),
    linkCastles: toBool(attr(cfg, 'link_castles')),
  };
}

export class MapGeneratorError extends Error {}

export class DefaultMapGenerator {
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  private random(modulus: number): number {
    return this.rng.next() % modulus;
  }

  /** Hills added up, normalised to 0-1000 (`generate_height_map`). */
  generateHeightMap(
    width: number,
    height: number,
    iterations: number,
    hillSize: number,
    islandSize: number,
    islandOffCenter: number,
    explicitCenter?: Loc,
  ): HeightMap {
    let centerX = Math.floor(width / 2);
    let centerY = Math.floor(height / 2);
    if (explicitCenter) {
      centerX = explicitCenter.x;
      centerY = explicitCenter.y;
    } else if (islandOffCenter !== 0) {
      switch (this.random(4)) {
        case 0: centerX += islandOffCenter; break;
        case 1: centerY += islandOffCenter; break;
        case 2: centerX = centerX < islandOffCenter ? 0 : centerX - islandOffCenter; break;
        default: centerY = centerY < islandOffCenter ? 0 : centerY - islandOffCenter; break;
      }
    }
    const res: HeightMap = Array.from({ length: width }, () => new Array<number>(height).fill(0));
    for (let i = 0; i < iterations; i++) {
      let isValley = false;
      const x1 = islandSize > 0 ? centerX - islandSize + this.random(islandSize * 2) : this.random(Math.max(1, width));
      const y1 = islandSize > 0 ? centerY - islandSize + this.random(islandSize * 2) : this.random(Math.max(1, height));
      if (islandSize !== 0) {
        const diffX = Math.abs(x1 - centerX);
        const diffY = Math.abs(y1 - centerY);
        const dist = Math.floor(Math.sqrt(diffX * diffX + diffY * diffY));
        isValley = dist > islandSize;
      }
      const radius = this.random(Math.max(1, hillSize)) + 1;
      const minX = x1 - radius > 0 ? x1 - radius : 0;
      const maxX = x1 + radius < res.length ? x1 + radius : res.length;
      const minY = y1 - radius > 0 ? y1 - radius : 0;
      const maxY = y1 + radius < height ? y1 + radius : height;
      for (let x2 = minX; x2 < maxX; x2++) {
        for (let y2 = minY; y2 < maxY; y2++) {
          const xDiff = x2 - x1;
          const yDiff = y2 - y1;
          const hillHeight = radius - Math.trunc(Math.sqrt(xDiff * xDiff + yDiff * yDiff));
          if (hillHeight > 0) {
            if (isValley) {
              if (hillHeight > res[x2][y2]) res[x2][y2] = 0;
              else res[x2][y2] -= hillHeight;
            } else {
              res[x2][y2] += hillHeight;
            }
          }
        }
      }
    }
    let highest = 0;
    let lowest = 100000;
    for (const column of res) {
      for (const h of column) {
        if (h > highest) highest = h;
        if (h < lowest) lowest = h;
      }
    }
    highest -= lowest;
    for (const column of res) {
      for (let y = 0; y < column.length; y++) {
        column[y] -= lowest;
        column[y] *= 1000;
        if (highest !== 0) column[y] = Math.trunc(column[y] / highest);
      }
    }
    return res;
  }

  private generateLake(terrain: TerrainMap, x: number, y: number, lakeFallOff: number, touched: Set<string>): boolean {
    if (x < 0 || y < 0 || x >= terrain.length || y >= terrain[0].length || lakeFallOff < 0) return false;
    terrain[x][y] = SHALLOW_WATER;
    touched.add(`${x},${y}`);
    const half = Math.trunc(lakeFallOff / 2);
    if (this.random(100) < lakeFallOff) this.generateLake(terrain, x + 1, y, half, touched);
    if (this.random(100) < lakeFallOff) this.generateLake(terrain, x - 1, y, half, touched);
    if (this.random(100) < lakeFallOff) this.generateLake(terrain, x, y + 1, half, touched);
    if (this.random(100) < lakeFallOff) this.generateLake(terrain, x, y - 1, half, touched);
    return true;
  }

  private shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.random(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  private generateRiverInternal(
    heights: HeightMap,
    terrain: TerrainMap,
    x: number,
    y: number,
    river: Loc[],
    seen: Set<string>,
    riverUphill: number,
  ): boolean {
    const onMap = x >= 0 && y >= 0 && x < heights.length && y < heights[heights.length - 1].length;
    if (onMap && river.length > 0 && heights[x][y] > heights[river[river.length - 1].x][river[river.length - 1].y] + riverUphill) return false;
    if (!onMap || terrain[x][y] === SHALLOW_WATER || terrain[x][y] === DEEP_WATER) {
      for (const loc of river) terrain[loc.x][loc.y] = SHALLOW_WATER;
      return true;
    }
    const here = { x, y };
    const next = this.shuffle(adjacent(here));
    seen.add(key(here));
    river.push(here);
    for (const loc of next) {
      if (!seen.has(key(loc)) && this.generateRiverInternal(heights, terrain, loc.x, loc.y, river, seen, riverUphill)) return true;
    }
    river.pop();
    return false;
  }

  private generateRiver(heights: HeightMap, terrain: TerrainMap, x: number, y: number, riverUphill: number): Loc[] {
    const river: Loc[] = [];
    const ok = this.generateRiverInternal(heights, terrain, x, y, river, new Set(), riverUphill);
    return ok ? river : [];
  }

  private randomPointAtSide(width: number, height: number): Loc {
    const side = this.random(4);
    if (side < 2) return { x: this.random(width), y: side === 0 ? 0 : height - 1 };
    return { x: side === 2 ? 0 : width - 1, y: this.random(height) };
  }

  /** `default_generate_map`: the whole pipeline, returning the map text. */
  generate(input: GeneratorData, cfg: WmlTable): string {
    const data = { ...input };
    if (data.width % 2 !== 0) throw new MapGeneratorError('Random maps with an odd width aren’t supported.');
    const castleConfig = childRange(cfg, 'castle')[0];

    // The map is built nine times too large; only the middle ninth is kept, the rest is
    // context for rivers and roads crossing the edge.
    data.width *= 3;
    data.height *= 3;
    const third = { w: Math.floor(data.width / 3), h: Math.floor(data.height / 3) };

    const heights = this.generateHeightMap(data.width, data.height, data.iterations, data.hillSize, data.islandSize, data.islandOffCenter);

    const flatland = attr(cfg, 'default_flatland') || GRASS_LAND;
    const grassland = code(flatland);
    const heightConversion = childRange(cfg, 'height').map((entry) => ({
      height: toInt(attr(entry, 'height')),
      to: attr(entry, 'terrain') ? code(attr(entry, 'terrain')) : GRASS_LAND,
    }));
    const terrain: TerrainMap = Array.from({ length: data.width }, () => new Array<string>(data.height).fill(grassland));
    for (let x = 0; x < heights.length; x++) {
      for (let y = 0; y < heights[x].length; y++) {
        for (const conversion of heightConversion) {
          if (heights[x][y] >= conversion.height) {
            terrain[x][y] = conversion.to;
            break;
          }
        }
      }
    }
    const startingPositions: { player: string; x: number; y: number }[] = [];

    // Lakes, each possibly sourcing a river.
    const lakeCount = data.maxLakes > 0 ? this.random(data.maxLakes) : 0;
    for (let lake = 0; lake < lakeCount; lake++) {
      for (let tries = 0; tries !== 100; tries++) {
        const x = this.random(data.width);
        const y = this.random(data.height);
        if (heights[x][y] <= toInt(attr(cfg, 'min_lake_height'))) continue;
        this.generateRiver(heights, terrain, x, y, toInt(attr(cfg, 'river_frequency')));
        this.generateLake(terrain, x, y, toInt(attr(cfg, 'lake_size')), new Set());
        break;
      }
    }

    // Flatland variants from a temperature map.
    const defaultDimensions = 40 * 40 * 9;
    const temperature = this.generateHeightMap(
      data.width,
      data.height,
      Math.trunc((toInt(attr(cfg, 'temperature_iterations')) * data.width * data.height) / defaultDimensions),
      toInt(attr(cfg, 'temperature_size')),
      0,
      0,
    );
    const converters = childRange(cfg, 'convert').map((entry) => ({
      minTemp: toInt(attr(entry, 'min_temperature'), -100000),
      maxTemp: toInt(attr(entry, 'max_temperature'), 100000),
      minHeight: toInt(attr(entry, 'min_height'), -100000),
      maxHeight: toInt(attr(entry, 'max_height'), 100000),
      from: readList(attr(entry, 'from')),
      to: attr(entry, 'to') ? code(attr(entry, 'to')) : '',
    }));
    for (let x = 0; x < data.width; x++) {
      for (let y = 0; y < data.height; y++) {
        for (const converter of converters) {
          if (
            converter.from.includes(terrain[x][y]) && heights[x][y] >= converter.minHeight && heights[x][y] <= converter.maxHeight
            && temperature[x][y] >= converter.minTemp && temperature[x][y] <= converter.maxTemp && converter.to !== ''
          ) {
            terrain[x][y] = converter.to;
            break;
          }
        }
      }
    }

    // Castles.
    const castles: Loc[] = [];
    const failed = new Set<string>();
    if (castleConfig) {
      const valid = readList(attr(castleConfig, 'valid_terrain'));
      const isValid = (x: number, y: number): boolean => x >= 0 && x < data.width && y >= 0 && y < data.height && valid.includes(terrain[x][y]);
      for (let player = 0; player !== data.nplayers; player++) {
        const minX = third.w + 3;
        const minY = third.h + 3;
        const maxX = third.w * 2 - 4;
        const maxY = third.h * 2 - 4;
        const minDistance = toInt(attr(castleConfig, 'min_distance'));
        let best: Loc | null = null;
        let bestRanking = 0;
        for (let x = minX; x !== maxX; x++) {
          for (let y = minY; y !== maxY; y++) {
            const loc = { x, y };
            if (failed.has(key(loc))) continue;
            const ranking = rankCastleLocation(x, y, isValid, minX, maxX, minY, maxY, minDistance, castles, bestRanking);
            if (ranking <= 0) failed.add(key(loc));
            if (ranking > bestRanking) {
              bestRanking = ranking;
              best = loc;
            }
          }
        }
        if (bestRanking === 0 || !best) {
          throw new MapGeneratorError('No valid castle location found. Too many or too few mountain hexes? (please check the ‘max hill size’ parameter)');
        }
        castles.push(best);
        failed.add(key(best));
      }
    }

    // Roads between random border points (and, optionally, between the castles).
    let roads = toInt(attr(cfg, 'roads'));
    if (data.linkCastles) roads += castles.length * castles.length;
    const roadCost = (loc: Loc, seed: number, windiness: number): number => {
      if (loc.x < 0 || loc.y < 0 || loc.x >= data.width || loc.y >= data.height) return Infinity;
      let wind = 1;
      if (windiness > 1) {
        const a = ((loc.x + 92872973) ^ 918273) >>> 0;
        const b = ((loc.y + 1672517) ^ 128123) >>> 0;
        const c = (Math.imul(a, b) + a + b + seed) >>> 0;
        const random = Math.imul(c, c) >>> 0;
        wind += Math.trunc((random % (windiness * 137)) / 137);
      }
      const entry = findChild(cfg, 'road_cost', 'terrain', terrain[loc.x][loc.y]);
      const base = entry ? toDouble(attr(entry, 'cost')) : Infinity;
      return wind * base;
    };
    const windiness = Math.max(1, toInt(attr(cfg, 'road_windiness')));
    const roadSeed = this.rng.next();
    for (let road = 0; road !== roads; road++) {
      let src = this.randomPointAtSide(third.w + 2, third.h + 2);
      let dst = this.randomPointAtSide(third.w + 2, third.h + 2);
      src = { x: src.x + third.w - 1, y: src.y + third.h - 1 };
      dst = { x: dst.x + third.w - 1, y: dst.y + third.h - 1 };
      if (data.linkCastles && road < castles.length * castles.length) {
        const srcCastle = Math.floor(road / castles.length);
        const dstCastle = road % castles.length;
        if (srcCastle >= dstCastle) continue;
        src = castles[srcCastle];
        dst = castles[dstCastle];
      } else if (src.x === dst.x || src.y === dst.y) {
        continue;
      }
      if (roadCost(src, roadSeed, windiness) >= 1000 || roadCost(dst, roadSeed, windiness) >= 1000) continue;
      const steps = aStar(src, dst, 10000, (loc) => roadCost(loc, roadSeed, windiness), data.width, data.height);
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (step.x < 0 || step.y < 0 || step.x >= data.width || step.y >= data.height) continue;
        const entry = findChild(cfg, 'road_cost', 'terrain', terrain[step.x][step.y]);
        if (!entry || Object.keys(entry).length === 0) continue;
        const bridge = attr(entry, 'convert_to_bridge');
        if (bridge !== '') {
          if (index === 0 || index + 1 === steps.length) continue;
          const last = steps[index - 1];
          const next = steps[index + 1];
          const adj = adjacent(step);
          const same = (p: Loc, q: Loc): boolean => p.x === q.x && p.y === q.y;
          let direction = -1;
          if ((same(last, adj[0]) && same(next, adj[3])) || (same(last, adj[3]) && same(next, adj[0]))) direction = 0;
          else if ((same(last, adj[1]) && same(next, adj[4])) || (same(last, adj[4]) && same(next, adj[1]))) direction = 1;
          else if ((same(last, adj[2]) && same(next, adj[5])) || (same(last, adj[5]) && same(next, adj[2]))) direction = 2;
          if (direction !== -1) {
            const items = bridge.split(',').map((item) => item.trim());
            if (direction < items.length && items[direction] !== '') terrain[step.x][step.y] = code(items[direction]);
            continue;
          }
        }
        const convertTo = attr(entry, 'convert_to');
        if (convertTo !== '') terrain[step.x][step.y] = code(convertTo);
      }
    }

    // Castles go in after the roads.
    const castleArray = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [0, 1], [-1, 1], [-2, 1], [-2, 0], [-2, -1], [-1, -2], [0, -2], [1, -2]];
    castles.forEach((castle, index) => {
      startingPositions.push({ player: String(index + 1), x: castle.x, y: castle.y });
      terrain[castle.x][castle.y] = HUMAN_KEEP;
      for (let i = 0; i < data.castleSize - 1; i++) terrain[castle.x + castleArray[i][0]][castle.y + castleArray[i][1]] = HUMAN_CASTLE;
    });

    // Villages on a displaced grid.
    if (data.nvillages > 0) {
      const tilesPerVillage = Math.floor((data.width * data.height) / 9 / data.nvillages);
      let villageX = 1;
      let villageY = 1;
      while (villageX * villageY < tilesPerVillage) {
        if (villageX < villageY) villageX++;
        else villageY++;
      }
      const likedCache = new Map<string, string[]>();
      for (let vx = 0; vx < data.width; vx += villageX) {
        for (let vy = this.random(villageY); vy < data.height; vy += villageY) {
          const add = this.random(3);
          const x = vx + add - 1;
          const y = vy + add - 1;
          const res = placeVillage(terrain, x, y, 2, cfg, likedCache);
          if (!res || res.x < Math.floor(data.width / 3) || res.x >= Math.floor((data.width * 2) / 3) || res.y < Math.floor(data.height / 3) || res.y >= Math.floor((data.height * 2) / 3)) continue;
          const entry = findChild(cfg, 'village', 'terrain', terrain[res.x][res.y]);
          const convertTo = entry ? attr(entry, 'convert_to') : '';
          if (convertTo === '') continue;
          terrain[res.x][res.y] = code(convertTo);
        }
      }
    }

    return outputMap(terrain, startingPositions);
  }
}

function rankCastleLocation(
  x: number,
  y: number,
  isValid: (x: number, y: number) => boolean,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minDistance: number,
  others: Loc[],
  highest: number,
): number {
  const loc = { x, y };
  let avgDistance = 0;
  let lowest = 1000;
  for (const other of others) {
    const distance = distanceBetween(loc, other);
    if (distance < 6) return 0;
    if (distance < lowest) lowest = distance;
    if (distance < minDistance) return -1;
    avgDistance += distance;
  }
  if (others.length > 0) avgDistance = Math.floor(avgDistance / others.length);
  for (let i = x - 1; i <= x + 1; i++) for (let j = y - 1; j <= y + 1; j++) if (!isValid(i, j)) return 0;
  const xFromBorder = Math.min(x - minX, maxX - x);
  const yFromBorder = Math.min(y - minY, maxY - y);
  const borderRanking = minDistance - Math.min(xFromBorder, yFromBorder) + minDistance - xFromBorder - yFromBorder;
  const current = borderRanking * 2 + avgDistance * 10 + lowest * 10;
  const maxPossible = current + 11 * 11;
  if (maxPossible < highest) return current;
  let surrounding = 0;
  for (let xp = x - 5; xp <= x + 5; xp++) for (let yp = y - 5; yp <= y + 5; yp++) if (isValid(xp, yp)) surrounding++;
  return surrounding + current;
}

function placeVillage(terrain: TerrainMap, x: number, y: number, radius: number, cfg: WmlTable, cache: Map<string, string[]>): Loc | null {
  let best: Loc | null = null;
  let bestRating = 0;
  for (const loc of tilesRadius({ x, y }, radius)) {
    if (loc.x < 0 || loc.y < 0 || loc.x >= terrain.length || loc.y >= terrain[0].length) continue;
    const t = terrain[loc.x][loc.y];
    const entry = findChild(cfg, 'village', 'terrain', t);
    if (!entry) continue;
    let liked = cache.get(t);
    if (!liked) {
      liked = readList(attr(entry, 'adjacent_liked'));
      cache.set(t, liked);
    }
    let rating = toInt(attr(entry, 'rating'));
    for (const adj of adjacent(loc)) {
      if (adj.x < 0 || adj.y < 0 || adj.x >= terrain.length || adj.y >= terrain[0].length) continue;
      rating += liked.filter((item) => item === terrain[adj.x][adj.y]).length;
    }
    if (rating > bestRating) {
      best = loc;
      bestRating = rating;
    }
  }
  return best;
}

/** `pathfind::a_star_search`: the cheapest route, [] when none is cheaper than `stopAt`. */
function aStar(src: Loc, dst: Loc, stopAt: number, cost: (loc: Loc) => number, width: number, height: number): Loc[] {
  const best = new Map<string, number>([[key(src), 0]]);
  const from = new Map<string, Loc>();
  const open: { loc: Loc; g: number; f: number }[] = [{ loc: src, g: 0, f: distanceBetween(src, dst) }];
  const closed = new Set<string>();
  while (open.length > 0) {
    let index = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[index].f) index = i;
    const current = open.splice(index, 1)[0];
    const currentKey = key(current.loc);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    if (current.loc.x === dst.x && current.loc.y === dst.y) {
      const route: Loc[] = [current.loc];
      let step = currentKey;
      while (from.has(step)) {
        const previous = from.get(step)!;
        route.push(previous);
        step = key(previous);
      }
      return route.reverse();
    }
    for (const n of adjacent(current.loc)) {
      if (n.x < 0 || n.y < 0 || n.x >= width || n.y >= height) continue;
      const stepCost = cost(n);
      if (!Number.isFinite(stepCost) || stepCost >= 1000) continue;
      const g = current.g + stepCost;
      if (g > stopAt) continue;
      const nKey = key(n);
      if (closed.has(nKey) || (best.has(nKey) && best.get(nKey)! <= g)) continue;
      best.set(nKey, g);
      from.set(nKey, current.loc);
      open.push({ loc: n, g, f: g + distanceBetween(n, dst) });
    }
  }
  return [];
}

/** The middle ninth plus the border, rows of comma-separated codes, starts as `N code`. */
function outputMap(terrain: TerrainMap, starts: { player: string; x: number; y: number }[]): string {
  const width = terrain.length;
  const height = terrain[0].length;
  const beginX = Math.floor(width / 3) - DEFAULT_BORDER;
  const endX = Math.floor((width * 2) / 3) + DEFAULT_BORDER;
  const beginY = Math.floor(height / 3) - DEFAULT_BORDER;
  const endY = Math.floor((height * 2) / 3) + DEFAULT_BORDER;
  const rows: string[] = [];
  for (let y = beginY; y < endY; y++) {
    const cells: string[] = [];
    for (let x = beginX; x < endX; x++) {
      const start = starts.find((entry) => entry.x === x && entry.y === y);
      cells.push(start ? `${start.player} ${terrain[x][y]}` : terrain[x][y]);
    }
    rows.push(cells.join(', '));
  }
  return `${rows.join('\n')}\n`;
}

/** The Lua entry point: `wesnoth.map.generate(width, height, cfg)`. */
export function generateDefaultMap(width: number, height: number, cfg: WmlTable, fallbackSeed: number): string {
  const seed = cfg.seed === undefined ? fallbackSeed : Math.trunc(Number(cfg.seed));
  const generator = new DefaultMapGenerator(seed);
  return generator.generate(generatorDataFromConfig(width, height, cfg), cfg);
}
