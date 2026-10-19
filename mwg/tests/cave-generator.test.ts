import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCave, seedFrom, type CaveConfig } from '../src/simulation/cave-generator.ts';
import { parseTerrain } from 'mwg/mwl';

const config: CaveConfig = {
  width: 45,
  height: 45,
  wall: 'Xu',
  clear: 'Uu',
  keep: 'Kud',
  castle: 'Cud',
  village: 'Uu^Vud',
  villageDensity: 60,
  chambers: [
    { id: 'player', xRange: [10, 15], yRange: [32, 38], size: 7, jagged: 40, passages: [{ destination: 'gold', width: 1, windiness: 5, chance: 70 }], starts: [{ side: 1, placeCastle: true }] },
    { id: 'gold', xRange: [30, 38], yRange: [5, 12], size: 8, jagged: 40, passages: [], starts: [{ side: 2, placeCastle: true }] },
  ],
  mustBeClear: [{ x: 20, y: 20 }],
  seed: seedFrom('sceptre-of-fire-04'),
};

test('the cave generator is deterministic and has the requested size', () => {
  assert.equal(generateCave(config), generateCave(config));
  const map = parseTerrain(generateCave(config));
  assert.equal(map.width, 45);
  assert.equal(map.height, 45);
});

test('the cave generator places a start per side and keeps scenario hexes walkable and connected', () => {
  const map = parseTerrain(generateCave(config));
  assert.ok(map.starts[1]?.length === 1 && map.starts[2]?.length === 1);
  const walkable = (x: number, y: number): boolean => map.codes[y * map.width + x] !== 'Xu';
  assert.ok(walkable(20, 20), 'a coordinate the scenario uses is carved');
  // flood fill from side 1's start reaches side 2's start
  const a = map.starts[1][0];
  const b = map.starts[2][0];
  const seen = new Set<number>([a.y * map.width + a.x]);
  const queue = [[a.x, a.y]];
  while (queue.length) {
    const [x, y] = queue.pop()!;
    const shift = x % 2 === 0 ? 1 : 0;
    for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x - 1, y - 1 + shift], [x - 1, y + shift], [x + 1, y - 1 + shift], [x + 1, y + shift]]) {
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height || !walkable(nx, ny) || seen.has(ny * map.width + nx)) continue;
      seen.add(ny * map.width + nx);
      queue.push([nx, ny]);
    }
  }
  assert.ok(seen.has(b.y * map.width + b.x), 'the two starts are connected');
});

test('an injected random stream replaces the seed and is advanced by the cave', async () => {
  const { Random } = await import('mwg/core');
  const stream = new Random.Generator(99);
  const first = generateCave({ ...config, random: stream });
  assert.equal(first, generateCave({ ...config, random: new Random.Generator(99) }), 'same stream state, same cave');
  assert.notEqual(first, generateCave({ ...config, random: stream }), 'the stream advanced, so the next cave differs');
});
