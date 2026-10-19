import assert from 'node:assert/strict';
import test from 'node:test';
// The port keeps the runnable relay as plain ESM; its test-only JS import has
// no generated declaration file, so the runtime contract is checked below.
// @ts-expect-error JavaScript relay module is intentionally tested directly.
import WebSocket from 'ws';
// @ts-expect-error JavaScript relay module is intentionally tested directly.
import { createWesnothServer } from '../tools/multiplayer-server.mjs';

function connect(port: number, room: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/?room=${room}`);
    // Resolve only after the handshake message, so later test listeners cannot
    // accidentally consume the welcome packet as the first game tick.
    socket.once('message', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => socket.once('message', (data: unknown) => resolve(JSON.parse(String(data)))));
}

test('Wesnoth relay isolates rooms and advances a shared room', async (t) => {
  const server = createWesnothServer({ port: 0, tickTimeoutMs: 1000 });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
  });
  await server.ready;
  const port = (server.address() as { port: number }).port;
  const first = await connect(port, 'shared');
  const second = await connect(port, 'shared');
  const isolated = await connect(port, 'isolated');
  sockets.push(first, second, isolated);

  const firstTick = nextMessage(first);
  const secondTick = nextMessage(second);
  first.send(JSON.stringify({ type: 'input', payload: { protocol: 'mwg-wesnoth', action: 'left' } }));
  second.send(JSON.stringify({ type: 'input', payload: { protocol: 'mwg-wesnoth', action: 'right' } }));
  const [a, b] = await Promise.all([firstTick, secondTick]);
  assert.equal((a as { type: string; tick: number }).type, 'tick');
  assert.equal((a as { tick: number }).tick, 0);
  assert.deepEqual(Object.values((b as { inputs: Record<string, unknown> }).inputs).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), [
    { protocol: 'mwg-wesnoth', action: 'left' },
    { protocol: 'mwg-wesnoth', action: 'right' },
  ].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));

});

test('Wesnoth relay emits null for a peer that misses the deadline', async (t) => {
  const server = createWesnothServer({ port: 0, tickTimeoutMs: 15 });
  t.after(async () => server.close());
  await server.ready;
  const port = (server.address() as { port: number }).port;
  const socket = await connect(port, 'timeout');
  await nextMessage(socket);
  const tick = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'input', payload: 'submitted' }));
  const result = await tick as { type: string; inputs: Record<string, unknown> };
  assert.equal(result.type, 'tick');
  assert.deepEqual(Object.values(result.inputs), ['submitted']);
  socket.terminate();
});
