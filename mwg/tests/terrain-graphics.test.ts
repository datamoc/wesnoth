/**
 * The terrain-graphics transition builder (P4.4).
 *
 * Two layers are locked here: the terrain-code wildcard matching and builder-map
 * walk ported from `src/terrain/translation.cpp`, and the rule build with the
 * real 30 rule files from `data/core/terrain-graphics/`.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildTerrainTiles,
  builtImageReferences,
  expandRules,
  parseTerrainGraphics,
  terrainImageReferences,
  UNITPOS,
  type TgRuleSpec,
} from '../src/simulation/terrain-graphics.ts';
import {
  codeKey,
  encodeCode,
  parseMapString,
  parseTerrainList,
  readBuilderMap,
  terrainMatches,
  WILDCARD,
} from '../src/simulation/terrain-codes.ts';
import { parseWml, WmlPreprocessor, type WmlNode } from '../src/simulation/wml.ts';

const mwgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(mwgDir, '..', 'data');

test('terrain codes encode like string_to_layer_', () => {
  assert.equal(encodeCode('Gg').base, 0x47670000);
  assert.equal(encodeCode('Gg').overlay, 0xffffffff, 'no overlay is NO_LAYER');
  assert.equal(encodeCode('Gg^Fp').overlay, 0x46700000);
  assert.equal(encodeCode('Ch').overlay, 0xffffffff);
  // A single code writes a wildcard overlay, so `type=Ch` means "Ch with any overlay".
  assert.equal(encodeCode('Ch', WILDCARD).overlay, WILDCARD);
  assert.equal(codeKey(encodeCode('Gg^Fp')), `${0x47670000},${0x46700000}`);
});

test('terrain wildcard matching follows translation.cpp', () => {
  const grass = encodeCode('Gg');
  const water = encodeCode('Ww');
  const forest = encodeCode('Gg^Fp');

  // A bare base matches any overlay.
  assert.ok(terrainMatches(forest, parseTerrainList('Gg', WILDCARD)));
  // `*` matches everything.
  assert.ok(terrainMatches(water, parseTerrainList('*')));
  // Overlay wildcards.
  assert.ok(terrainMatches(forest, parseTerrainList('*^F*')));
  assert.ok(terrainMatches(forest, parseTerrainList('G*', WILDCARD)));
  assert.ok(!terrainMatches(grass, parseTerrainList('*^F*')));
  // `!` toggles every following entry, which is how `!,Q*,X*,W*` excludes types.
  assert.ok(terrainMatches(grass, parseTerrainList('!,Q*,X*,W*', WILDCARD)));
  assert.ok(!terrainMatches(water, parseTerrainList('!,Q*,X*,W*', WILDCARD)));
  // An empty match list never matches.
  assert.ok(!terrainMatches(grass, []));
});

test('read_builder_map lays out the alternating-column rule map', () => {
  const map = readBuilderMap('\n, 2\n1 , 2\n, 3\n2');
  assert.equal(map.lines, 4);
  assert.equal(map.columns, 2);
  const parsed = parseMapString('\n, 2\n1 , 2\n, 3\n2');
  // `parse_mapstring` reads every column while the hex x advances by two, so a
  // two-column map still places an anchor at x=2.
  assert.deepEqual(parsed.anchors.get(2)?.map((loc) => `${loc.x},${loc.y}`), ['1,0', '2,1', '0,2']);
  assert.deepEqual(parsed.anchors.get(1), [{ x: 0, y: 1 }]);
  assert.deepEqual(parsed.anchors.get(3), [{ x: 1, y: 1 }]);
  assert.equal(parsed.constraints.length, 0);

  // A `*` chunk becomes a STAR constraint at its hex offset.
  const star = parseMapString('\n*\n,\n1');
  assert.deepEqual(star.anchors.get(1), [{ x: 0, y: 1 }]);
  assert.equal(star.constraints.length, 1);
  assert.equal(star.constraints[0].x, 0);
  assert.equal(star.constraints[0].y, 0);
});

test('rotations expand to concrete @R names', () => {
  const nodes = parseWml(
    `[terrain_graphics]
    map="
*
,
1"
        [tile]
            pos=1
            type=Gg
            set_no_flag=mark-@R0
            [image]
                name=edge-@R0.png
                layer=1
            [/image]
        [/tile]
        rotations=n,ne,se,s,sw,nw
    [/terrain_graphics]`,
    '<rotation-test>',
  );
  const rules = parseTerrainGraphics(nodes, '<rotation-test>');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].rotations, ['n', 'ne', 'se', 's', 'sw', 'nw']);
  const expanded = expandRules(rules);
  assert.equal(expanded.length, 6);
  const names = expanded.map((rule) => rule.constraints.flatMap((constraint) => constraint.images.flatMap((image) => image.variants.map((variant) => variant.name)))[0]);
  assert.deepEqual(names, ['edge-n.png', 'edge-ne.png', 'edge-se.png', 'edge-s.png', 'edge-sw.png', 'edge-nw.png']);
  const flags = expanded.map((rule) => rule.constraints.flatMap((constraint) => constraint.setFlags)[0]);
  assert.deepEqual(flags, ['mark-n', 'mark-ne', 'mark-se', 'mark-s', 'mark-sw', 'mark-nw']);
});

/** Load the real 30 rule files once; both integration tests share it. */
let realRules: TgRuleSpec[] | undefined;
function loadRealRules(): TgRuleSpec[] {
  if (realRules) return realRules;
  const dir = path.join(dataDir, 'core', 'terrain-graphics');
  const files = readdirSync(dir).filter((name) => name.endsWith('.cfg')).sort();
  const wml = new WmlPreprocessor({ dataDir, onFile: () => {} });
  wml.loadMacros(files.map((name) => path.join(dir, name)));
  const nodes: WmlNode[] = files.flatMap((name) => parseWml(wml.preprocessFile(path.join(dir, name)), name));
  nodes.push(...parseWml(wml.preprocessFile(path.join(dataDir, 'core', 'terrain-graphics.cfg')), 'terrain-graphics.cfg'));
  realRules = parseTerrainGraphics(nodes, 'terrain-graphics.cfg');
  return realRules;
}

test('the real rules build transitions on a synthetic forest map', () => {
  const rules = loadRealRules();
  assert.ok(rules.length > 1000, `${rules.length} rules`);
  assert.ok(rules.some((rule) => rule.rotations.length > 0), 'rotated rules present');

  const width = 10;
  const height = 10;
  const isForest = (x: number, y: number): boolean => x >= 3 && x <= 6 && y >= 3 && y <= 6;
  const terrainAt = (x: number, y: number): string => (isForest(x, y) ? 'Gg^Fp' : 'Gg');
  const tiles = buildTerrainTiles(rules, { width, height, terrainAt, drawBorder: true, tod: 'morning' });

  // A forest interior hex has a real base and forest canopy.
  const interior = tiles.get('4,4');
  assert.ok(interior, 'forest interior built');
  assert.ok(
    interior.background.some((image) => image.image.startsWith('terrain/forest/')),
    'forest art is drawn',
  );
  assert.ok(
    interior.background.some((image) => image.layer < 0),
    'the terrain base is a low-layer background image',
  );

  // A grass hex touching the forest receives the forest edge transition.
  const edge = tiles.get('2,4');
  assert.ok(edge, 'edge hex built');
  const edgeNames = [...edge.background, ...edge.foreground].map((image) => image.image);
  assert.ok(edgeNames.some((name) => name.startsWith('terrain/forest/')), `edge transition present: ${edgeNames.join(', ')}`);

  // Same inputs, same output: the build is deterministic (no Math.random).
  const again = buildTerrainTiles(rules, { width, height, terrainAt, drawBorder: true, tod: 'morning' });
  assert.deepEqual([...again.get('4,4')!.background], [...interior.background]);

  // `layer >= 0 && basey >= UNITPOS` is the engine's foreground split.
  for (const tile of tiles.values()) {
    for (const image of tile.foreground) assert.ok(image.layer >= 0 && image.baseY >= UNITPOS);
  }

  // The image collector sees the whole usable rule set, and the built set is a
  // subset of it (so shipped maps only copy what they can draw).
  const referenced = terrainImageReferences(rules);
  assert.ok(referenced.size > 500, `${referenced.size} referenced images`);
  const built = builtImageReferences(tiles);
  for (const image of built) assert.ok(referenced.has(image), `built image not referenced: ${image}`);
});
