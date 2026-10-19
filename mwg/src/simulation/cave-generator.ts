// Cave map generator for the three campaign scenarios whose `[scenario]` has
// `map_generation=lua` with a `[generator] create_map=<< ...cave_map_generator... >>`
// (Heir to the Throne 31, Heir to the Throne Classic 17, Sceptre of Fire 4).
//
// Real engine: `data/core/lua/cave_map_generator.lua` and `src/mapgen.cpp`/`cave_map_generator`
// carve `[chamber]`s and `[passage]`s into a wall-filled grid, draw a random layout every
// time the scenario loads, and place `[item_location]` castles and villages.
//
// The carving itself is the framework's `roguelike.generateCave` (MWG 0.34, `shape: 'hex'`,
// seeded `random` stream); this file only maps the Wesnoth `[chamber]` data onto it and
// renders the result as Wesnoth terrain codes.
//
// Deviation (PORT_COVERAGE.md "Cave map generator"): the layout is generated once at
// build time from a seed derived from the scenario id (the engine rerolls per play-through),
// the framework's chamber growth and passage walk are a generic approximation of the
// engine's, and the grid is shifted one column so the framework's odd-q hex parity matches
// Wesnoth's border-inclusive coordinates; that costs the first inner column (x = 1), which
// stays wall. Not ported: `[chamber] [items]`, `[passage] chance` ranges beyond a single
// roll and the Lua generator's own `chamber_group` variations.
//
// Pure: no node imports, runs under `node --test` and in the build tool.

import { generateCave as carveCave } from 'mwg/roguelike';
import { hexNeighbors } from 'mwg';
import { Random } from 'mwg/core';

export interface CavePassage {
  destination: string;
  width: number;
  windiness: number;
  chance: number;
}

export interface CaveChamber {
  id: string;
  xRange: [number, number];
  yRange: [number, number];
  size: number;
  jagged: number;
  passages: CavePassage[];
  /** `[item_location] id=<side>`: a start marker, with a castle ring when `placeCastle` */
  starts: { side: number; placeCastle: boolean }[];
}

export interface CaveConfig {
  /** full grid width, border hexes included (the scenario says "plus 2 border hexes") */
  width: number;
  height: number;
  wall: string;
  clear: string;
  keep: string;
  castle: string;
  village: string;
  /** villages per 1000 clear hexes */
  villageDensity: number;
  chambers: CaveChamber[];
  /** 1-based map coordinates that scenario units or events use and that must be walkable */
  mustBeClear: { x: number; y: number }[];
  /** seeds the stream when no `random` is injected */
  seed: number;
  /** a stream to draw from instead of `seed`; the generator advances it */
  random?: Random.RandomSource;
}

/** Hash a string to a seed. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

export function generateCave(config: CaveConfig): string {
  const { width, height } = config;
  // Framework coordinates fx = x - 1, fy = y: the shift flips the column parity, which is
  // what makes the framework's hex neighbours the engine's (see the header note).
  const toFrame = (x: number): number => Math.max(1, x - 1);
  const cave = carveCave({
    width: width - 1,
    height,
    random: config.random ?? new Random.Generator(config.seed),
    shape: 'hex',
    chambers: config.chambers.map((chamber) => ({
      id: chamber.id,
      xRange: [toFrame(chamber.xRange[0]), toFrame(chamber.xRange[1])],
      yRange: chamber.yRange,
      size: Math.max(1, Math.round(chamber.size * 1.5)),
      jagged: chamber.jagged,
      passages: chamber.passages.map((passage) => ({ to: passage.destination, width: passage.width, windiness: passage.windiness, chance: passage.chance })),
    })),
    starts: config.chambers.flatMap((chamber) => chamber.starts.map((start) => ({ side: String(start.side), chamber: chamber.id, ring: start.placeCastle }))),
    villageDensity: config.villageDensity,
    mustBeClear: config.mustBeClear.map((point) => ({ x: toFrame(point.x), y: point.y })),
  });
  const { level } = cave;
  const inner = (x: number, y: number): boolean => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2;
  const codes: string[] = new Array(width * height).fill(config.wall);
  for (let fy = 0; fy < level.height; fy++) {
    for (let fx = 0; fx < level.width; fx++) {
      if (level.get(fx, fy) === 1) codes[fy * width + fx + 1] = config.clear;
    }
  }
  // Start markers: the keep in the chamber's centre, the castle ring around it.
  const starts = new Map<number, { x: number; y: number }>();
  for (const entry of cave.starts) {
    const x = entry.x + 1;
    const y = entry.y;
    const side = Number(entry.side);
    const wantsCastle = config.chambers.some((chamber) => chamber.starts.some((s) => s.side === side && s.placeCastle));
    codes[y * width + x] = config.keep;
    starts.set(side, { x, y });
    if (wantsCastle) {
      for (const neighbour of hexNeighbors(entry.x, entry.y)) {
        const nx = neighbour.x + 1;
        if (inner(nx, neighbour.y)) codes[neighbour.y * width + nx] = config.castle;
      }
    }
  }
  for (const village of cave.villages) codes[village.y * width + village.x + 1] = config.village;

  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const cells: string[] = [];
    for (let x = 0; x < width; x++) {
      const start = [...starts.entries()].find(([, at]) => at.x === x && at.y === y);
      cells.push(!inner(x, y) ? '_off^_usr' : start ? `${start[0]} ${codes[y * width + x]}` : codes[y * width + x]);
    }
    rows.push(cells.join(', '));
  }
  // Real `.map` files have no header and spell the border ring `_off^_usr`.
  return `${rows.join('\n')}\n`;
}
