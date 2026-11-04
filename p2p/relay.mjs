// The rollback experiment's only central piece: it introduces two peers and then has nothing more to do. It holds no game files and
// sees no gameplay. Two people give the same room name; if their game files and sim code match, each is told their seat and a shared
// seed, and the WebRTC setup messages pass through here until they're connected to each other.
// Usage: node p2p/relay.mjs [--port 27016] [--host 0.0.0.0]
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { acceptWebSocket } from '../server/ws.mjs';

/**
 * Pairs people up. One of these can serve any number of rooms.
 * @returns {function(object, object): void} Handles an upgrade request for a WebSocket.
 */
export function createRelay() {
  const rooms = new Map();
  const leave = (c) => {
    const room = c.room && rooms.get(c.room);
    if (!room) return;
    room.delete(c);
    for (const other of room) other.send({ t: 'gone' });
    if (!room.size) rooms.delete(c.room);
    c.room = null;
  };
  const onMessage = (c, m) => {
    if (m.t === 'join' && !c.room) {
      const name = String(m.room ?? '').slice(0, 64);
      const room = rooms.get(name) ?? new Set();
      if (room.size >= 2) { c.send({ t: 'full' }); return; }
      const [first] = room;
      // Different files or code would desync as soon as anything happened, so they don't get to start
      if (first && first.build !== String(m.build)) {
        c.send({ t: 'mismatch', yours: String(m.build), theirs: first.build });
        first.send({ t: 'mismatch', yours: first.build, theirs: String(m.build) });
        return;
      }
      c.room = name; c.build = String(m.build); c.hello = m.hello ?? null;
      room.add(c);
      rooms.set(name, room);
      if (first) {
        const seed = crypto.randomBytes(4).readUInt32LE(0);
        first.send({ t: 'paired', seat: 0, seed, other: c.hello });
        c.send({ t: 'paired', seat: 1, seed, other: first.hello });
      } else c.send({ t: 'waiting' });
    } else if (m.t === 'signal' && c.room) {
      for (const other of rooms.get(c.room) ?? []) if (other !== c) other.send({ t: 'signal', data: m.data });
    }
  };
  return (req, socket) => {
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    acceptWebSocket(req, socket, onMessage, leave);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values: args } = parseArgs({ options: { port: { type: 'string', default: '27016' }, host: { type: 'string', default: '0.0.0.0' } } });
  const server = http.createServer((req, res) => { res.statusCode = 426; res.end('This is a relay for peers. It has nothing else.'); });
  server.on('upgrade', createRelay());
  server.listen(+args.port, args.host, () => console.log(`relay listening on ${args.host}:${args.port}`));
}
