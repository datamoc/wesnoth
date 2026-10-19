import assert from 'node:assert/strict';
import test from 'node:test';
import { makeGame } from '../src/simulation/game.ts';
import { syncStateHash } from '../src/simulation/sync.ts';

test('sync digest is deterministic and changes when game state changes', () => {
  const state = makeGame(2, 1, ['Gg', 'Gg'], new Map([[1, [{ x: 0, y: 0 }]]]));
  const first = syncStateHash(state, 'runtime', { 1: 10 }, [1, 2, 3, 4]);
  assert.equal(first, syncStateHash(state, 'runtime', { 1: 10 }, [1, 2, 3, 4]));
  state.round += 1;
  assert.notEqual(first, syncStateHash(state, 'runtime', { 1: 10 }, [1, 2, 3, 4]));
  const beforeTeams = syncStateHash(state, 'runtime', { 1: 10 }, [1, 2, 3, 4]);
  state.teams.set(2, '1');
  assert.notEqual(beforeTeams, syncStateHash(state, 'runtime', { 1: 10 }, [1, 2, 3, 4]));
});
