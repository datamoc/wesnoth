import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplay, decodeReplay, encodeReplay, replayActions, type WesnothAction, type WesnothEvent } from '../src/simulation/replay.ts';

const actions = [
  { sequence: 0, action: { type: 'move', unitId: 7, from: { x: 1, y: 2 }, to: { x: 2, y: 2 }, side: 1 } as WesnothAction, events: [{ type: 'resolved' } as WesnothEvent] },
  { sequence: 1, action: { type: 'end_turn', side: 1, round: 1 } as WesnothAction, events: [{ type: 'resolved' } as WesnothEvent] },
];

test('replay files round-trip with a deterministic header and commands', () => {
  const replay = createReplay('two-brothers-01', 1234, actions);
  const restored = decodeReplay(encodeReplay(replay));
  assert.deepEqual(restored, replay);
});

test('replay validation rejects gaps, unknown formats, and invalid JSON', () => {
  assert.throws(() => createReplay('arena', 1, [{ ...actions[1], sequence: 2 }]), /contiguous/);
  assert.throws(() => decodeReplay('{"format":"old","version":1}'), /unsupported replay format/);
  assert.throws(() => decodeReplay('not json'), /valid JSON/);
});

test('replay dispatcher applies commands in sequence order', () => {
  const replay = createReplay('arena', 9, actions);
  const seen: number[] = [];
  assert.equal(replayActions(replay, (_action, _events, sequence) => seen.push(sequence)), 2);
  assert.deepEqual(seen, [0, 1]);
});
