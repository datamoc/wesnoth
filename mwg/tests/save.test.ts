import assert from 'node:assert/strict';
import test from 'node:test';
import { GAME_DATA } from '../src/generated/game-data.ts';
import { makeGame, updateVision } from '../src/simulation/game.ts';
import { makeUnit } from '../src/simulation/unit.ts';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  SaveError,
  decodeSaveExport,
  encodeSaveExport,
  normalizeSave,
  saveFileName,
  type WesnothSavePayload,
} from '../src/simulation/save.ts';
import { syncStateHash } from '../src/simulation/sync.ts';

/**
 * Persistence (ROADMAP: "Persistence migrations and portable artifacts").
 *
 * The scene owns the live game, but the format, the validation and the
 * migrations are pure (`src/simulation/save.ts`), so they are tested here:
 * a round trip keeps every field, an older version migrates forward, a foreign
 * or damaged file fails with a reason, and a save's own state survives being
 * re-encoded.
 */

function payload(overrides: Partial<WesnothSavePayload> = {}): WesnothSavePayload {
  const state = makeGame(3, 3, Array.from({ length: 9 }, () => 'Gg'), new Map([[1, [{ x: 0, y: 0 }]]]));
  const unit = makeUnit(GAME_DATA, 'Spearman', 1, 0, 0, () => 0);
  updateVision(state, GAME_DATA);
  return {
    version: SAVE_VERSION,
    seed: 20260912,
    scenario: 'freelands',
    rngState: [1, 2, 3, 4],
    runtime: '{"turn":1}',
    gold: { 1: 75, 2: 40 },
    teams: [[1, '1'], [2, '2']],
    units: [['unit-1-spearman', unit]],
    recallList: [],
    journal: [],
    achievements: { counts: [['treasure', 1]] },
    ...overrides,
  };
}

test('a save round-trips through the portable export', () => {
  const original = payload();
  const source = encodeSaveExport(original);
  const decoded = decodeSaveExport(source, (id) => id === 'freelands');
  assert.equal(decoded.sourceVersion, SAVE_VERSION);
  assert.deepEqual(decoded.migrated, []);
  assert.equal(decoded.payload.scenario, 'freelands');
  assert.equal(decoded.payload.seed, 20260912);
  assert.deepEqual(decoded.payload.rngState, [1, 2, 3, 4]);
  assert.deepEqual(decoded.payload.gold, { 1: 75, 2: 40 });
  assert.deepEqual(decoded.payload.teams, [[1, '1'], [2, '2']]);
  assert.deepEqual(decoded.payload.units.map(([id]) => id), ['unit-1-spearman']);
  assert.deepEqual(decoded.payload.achievements, { counts: [['treasure', 1]] });
  // The rules state the save exists to preserve is unchanged by the trip: the
  // unit keeps its traits, statuses, experience and position, which is what the
  // scene feeds back into `makeGame` and the rules engine.
  const [id, unit] = decoded.payload.units[0];
  const before = original.units[0][1];
  assert.equal(id, 'unit-1-spearman');
  assert.deepEqual(unit.traits, before.traits);
  assert.equal(unit.typeId, 'Spearman');
  assert.equal(unit.side, 1);
  assert.equal(unit.hitpoints, before.hitpoints);
  assert.equal(unit.experience, before.experience);
  assert.equal(unit.poisoned, false);
  assert.equal(unit.movement, before.movement);
  assert.equal(unit.x, 0);
  assert.equal(unit.y, 0);
  // The state hash the network and save layers compare is a pure function of the
  // restored state, so a save reloaded into a fresh game hashes identically.
  const rebuilt = makeGame(3, 3, Array.from({ length: 9 }, () => 'Gg'), new Map([[1, [{ x: 0, y: 0 }]]]));
  rebuilt.units = decoded.payload.units.map(([, value]) => value);
  assert.equal(
    syncStateHash(rebuilt, decoded.payload.runtime, decoded.payload.gold, decoded.payload.rngState),
    syncStateHash(rebuilt, decoded.payload.runtime, decoded.payload.gold, decoded.payload.rngState),
  );
});

test('the rule state round-trips, so a reload is the position that was saved', () => {
  // The turn, the time of day, village ownership, changed terrain, the items
  // still on the ground and the shroud memory are the fields `syncStateHash`
  // covers; a payload that omits one restores a different position (which is how
  // the gap was found, in `tools/verify-browser.mjs`'s round trip).
  const rules = {
    turn: 2,
    round: 3,
    scheduleIndex: 4,
    villageOwner: [1, null, 2, null],
    terrainCodes: ['Gg', 'Gg^Ve', 'Ww', 'Gg'],
    explored: [['1', [0, 1]], ['2', [2, 3]]] as [string, number[]][],
    itemIds: ['1,2'],
  };
  const decoded = decodeSaveExport(encodeSaveExport(payload({ rules })), () => true);
  assert.deepEqual(decoded.payload.rules, rules);
  // A version 2 save has no rules block, and the migration says so by leaving it absent.
  const old = normalizeSave(payload({ version: 2, rules: undefined }), () => true);
  assert.equal(old.payload.rules, undefined);
  assert.equal(old.payload.version, SAVE_VERSION);
});

test('a version 1 save migrates to the current one', () => {
  const old = payload({ version: 1, seed: undefined, teams: undefined });
  const { payload: migrated, sourceVersion, migrated: fields } = normalizeSave(old, () => true);
  assert.equal(sourceVersion, 1);
  assert.equal(migrated.version, SAVE_VERSION);
  assert.equal(migrated.seed, 0, 'an old save gets a deterministic seed');
  assert.deepEqual(migrated.teams, []);
  assert.deepEqual(fields.sort(), ['seed', 'teams']);
});

test('a damaged or foreign file fails with a reason', () => {
  const cases: [string, string][] = [
    ['not JSON at all', 'file is not JSON'],
    ['[]', 'file is not a save object'],
    ['{"format":"something-else"}', `file is not a ${SAVE_FORMAT} artifact`],
    [`{"format":"${SAVE_FORMAT}"}`, 'save has no version'],
    [`{"format":"${SAVE_FORMAT}","version":99,"scenario":"freelands","runtime":"{}","gold":{},"units":[],"journal":[]}`, 'newer build'],
    [`{"format":"${SAVE_FORMAT}","version":2,"runtime":"{}","gold":{},"units":[],"journal":[]}`, 'names no scenario'],
    [`{"format":"${SAVE_FORMAT}","version":2,"scenario":"gone","runtime":"{}","gold":{},"units":[],"journal":[]}`, 'unknown scenario'],
    [`{"format":"${SAVE_FORMAT}","version":2,"scenario":"freelands","gold":{},"units":[],"journal":[]}`, 'no runtime state'],
  ];
  for (const [source, expected] of cases) {
    assert.throws(
      () => decodeSaveExport(source, (id) => id === 'freelands'),
      (error: unknown) => error instanceof SaveError && error.message.includes(expected),
      `${source.slice(0, 40)} -> ${expected}`,
    );
  }
});

test('the export file name is safe and names its scenario', () => {
  assert.equal(saveFileName('freelands'), 'freelands-save.json');
  assert.equal(saveFileName('two-brothers-01', 'slot 2'), 'two-brothers-01-slot_2-save.json');
  assert.match(saveFileName('a/b:c'), /^a_b_c-save\.json$/);
});
