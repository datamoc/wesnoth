import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

/**
 * Relay server for the port's lockstep protocol.
 *
 * A room advances when every connected peer submits one input, or when the
 * timeout expires. Missing inputs are represented as null, leaving turn and
 * game-rule policy to the client. The server never interprets Wesnoth data.
 */
export function createWesnothServer(options = {}) {
  const { port = 8787, tickTimeoutMs = 200 } = options;
  const wss = new WebSocketServer({ port });
  const rooms = new Map();
  let nextId = 1;

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { clients: new Map(), tick: 0, timer: null };
      rooms.set(name, room);
    }
    return room;
  }

  function arm(room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = room.clients.size > 0 ? setTimeout(() => advance(room), tickTimeoutMs) : null;
  }

  function advance(room) {
    const inputs = {};
    for (const [id, client] of room.clients) {
      inputs[id] = client.submitted ? client.input : null;
      client.submitted = false;
      client.input = null;
    }
    const message = JSON.stringify({ type: 'tick', tick: room.tick, inputs });
    room.tick += 1;
    for (const client of room.clients.values()) {
      if (client.socket.readyState === 1) client.socket.send(message);
    }
    arm(room);
  }

  function advanceIfReady(room) {
    if (room.clients.size > 0 && [...room.clients.values()].every((client) => client.submitted)) advance(room);
  }

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const roomName = url.searchParams.get('room') || 'default';
    const room = getRoom(roomName);
    const id = `p${nextId++}`;
    const client = { socket, input: null, submitted: false };
    room.clients.set(id, client);
    socket.send(JSON.stringify({ type: 'welcome', id }));
    if (!room.timer) arm(room);

    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message?.type !== 'input' || !room.clients.has(id)) return;
      client.input = message.payload ?? null;
      client.submitted = true;
      advanceIfReady(room);
    });

    socket.on('close', () => {
      room.clients.delete(id);
      if (room.clients.size === 0) {
        if (room.timer) clearTimeout(room.timer);
        rooms.delete(roomName);
      } else {
        advanceIfReady(room);
      }
    });
  });

  return {
    wss,
    ready: new Promise((resolve) => wss.once('listening', resolve)),
    address: () => wss.address(),
    close: () => new Promise((resolve) => {
      for (const room of rooms.values()) if (room.timer) clearTimeout(room.timer);
      // A close callback waits for clients to finish their WebSocket close
      // handshake. Terminate test/browser clients so shutdown is deterministic.
      for (const room of rooms.values()) for (const client of room.clients.values()) client.socket.terminate();
      rooms.clear();
      wss.close(() => resolve());
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createWesnothServer({ port: Number(process.argv[2] ?? 8787) });
  await server.ready;
  console.log(`Wesnoth lockstep server listening on ws://localhost:${server.address().port}`);
}
