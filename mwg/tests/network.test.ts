import assert from 'node:assert/strict';
import test from 'node:test';
import { WesnothNetworkSession } from '../src/simulation/network.ts';
import type { WebSocketLike } from 'mwg/core';

test('network session validates and unwraps lockstep Wesnoth actions', () => {
  let socket: WebSocketLike | undefined;
  const ticks: unknown[] = [];
  const statuses: string[] = [];
  const session = new WesnothNetworkSession({
    url: 'wss://test',
    createSocket: () => {
      socket = { readyState: 1, send: () => undefined, close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null };
      return socket;
    },
    onTick: (tick, actions) => ticks.push([tick, actions]),
    onStatus: (status) => statuses.push(status),
  });
  session.connect();
  socket?.onmessage?.({ data: JSON.stringify({ type: 'welcome', id: 'peer-a' }) });
  socket?.onmessage?.({ data: JSON.stringify({ type: 'tick', tick: 3, inputs: {
    'peer-a': { protocol: 'mwg-wesnoth', version: 1, action: { type: 'end_turn', side: 1, round: 2 } },
    'peer-b': { protocol: 'wrong', version: 1, action: { type: 'end_turn', side: 1, round: 2 } },
    'peer-c': null,
  } }) });
  assert.deepEqual(statuses, ['connected', 'invalid']);
  assert.deepEqual(ticks, [[3, { 'peer-a': { type: 'end_turn', side: 1, round: 2 }, 'peer-b': null, 'peer-c': null }]]);
});

test('network session submits a versioned action payload', () => {
  let sent = '';
  const session = new WesnothNetworkSession({
    url: 'wss://test',
    createSocket: () => ({ readyState: 1, send: (data) => { sent = data; }, close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null }),
  });
  session.connect();
  session.submit({ type: 'end_turn', side: 1, round: 1 });
  assert.deepEqual(JSON.parse(sent), { type: 'input', payload: { protocol: 'mwg-wesnoth', version: 1, action: { type: 'end_turn', side: 1, round: 1 } } });
});

test('network session sends and receives bounded chat messages', () => {
  let sent = '';
  let socket: WebSocketLike | undefined;
  const chats: unknown[] = [];
  const session = new WesnothNetworkSession({
    url: 'wss://test',
    createSocket: () => {
      socket = { readyState: 1, send: (data) => { sent = data; }, close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null };
      return socket;
    },
    onChat: (peer, text) => chats.push([peer, text]),
  });
  session.connect();
  session.sendChat('  hello\nworld  ');
  assert.deepEqual(JSON.parse(sent), { type: 'input', payload: { protocol: 'mwg-wesnoth-chat', version: 1, message: { text: 'hello world' } } });
  socket?.onmessage?.({ data: JSON.stringify({ type: 'tick', tick: 4, inputs: {
    'peer-b': { protocol: 'mwg-wesnoth-chat', version: 1, message: { text: 'ready' } },
  } }) });
  assert.deepEqual(chats, [['peer-b', 'ready']]);
  assert.throws(() => session.sendChat('x'.repeat(257)), /1-256/);
});

test('network session exchanges and validates the deterministic initial state', () => {
  let socket: WebSocketLike | undefined;
  const states: unknown[] = [];
  const session = new WesnothNetworkSession({
    url: 'wss://test',
    createSocket: () => {
      socket = { readyState: 1, send: () => undefined, close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null };
      return socket;
    },
    onInitialState: (state) => states.push(state),
  });
  session.connect();
  session.submitInitialState({ scenario: 'two-brothers-01', seed: 42 });
  socket?.onmessage?.({ data: JSON.stringify({ type: 'tick', tick: 0, inputs: {
    'peer-a': { protocol: 'mwg-wesnoth-sync', version: 1, state: { scenario: 'two-brothers-01', seed: 42 } },
  } }) });
  assert.deepEqual(states, [{ scenario: 'two-brothers-01', seed: 42 }]);
});

test('network session accepts a validated late-join snapshot', () => {
  let received: unknown;
  let socket: WebSocketLike | undefined;
  const session = new WesnothNetworkSession({
    url: 'wss://test',
    createSocket: () => {
      socket = { readyState: 1, send: () => undefined, close: () => undefined, onopen: null, onclose: null, onerror: null, onmessage: null };
      return socket;
    },
    onInitialState: (state) => { received = state; },
  });
  session.connect();
  socket?.onmessage?.({ data: JSON.stringify({ type: 'tick', tick: 0, inputs: {
    host: { protocol: 'mwg-wesnoth-sync', version: 1, state: {
      scenario: 'two-brothers-02', seed: 7, authority: true,
      snapshot: { version: 1, scenario: 'two-brothers-02', rngState: [1, 2, 3, 4], runtime: '{}', gold: {}, teams: [[1, 'allies'], [2, 'enemies']], units: [], recallList: [], journal: [] },
    } },
  } }) });
  assert.equal((received as { snapshot?: unknown }).snapshot !== undefined, true);
  assert.deepEqual((received as { snapshot: { teams?: unknown[] } }).snapshot.teams, [[1, 'allies'], [2, 'enemies']]);
});

test('peerOwnsSide binds peer pN to side N only', async () => {
  const { peerOwnsSide, HOST_PEER } = await import('../src/simulation/network.ts');
  assert.equal(HOST_PEER, 'p1');
  assert.equal(peerOwnsSide('p1', 1), true);
  assert.equal(peerOwnsSide('p2', 1), false);
  assert.equal(peerOwnsSide('p2', 2), true);
});
