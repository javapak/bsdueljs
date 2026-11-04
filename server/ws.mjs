// A minimal WebSocket server with no dependencies: the handshake, framing and text messages (RFC 6455). JSON both ways.
import crypto from 'node:crypto';

/**
 * Takes over an upgrade request.
 * @param {object} req The upgrade request.
 * @param {object} socket Its socket.
 * @param {function(object, object): void} onMessage Called with the connection and each message.
 * @param {function(object): void} onClose Called with the connection when it goes; it can be called more than once.
 * @returns {object} The connection, with send(object).
 */
export function acceptWebSocket(req, socket, onMessage, onClose) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = { socket, send(obj) {
    if (socket.destroyed) return;
    const pl = Buffer.from(JSON.stringify(obj));
    const hdr = pl.length < 126 ? Buffer.from([0x81, pl.length]) : pl.length < 65536 ? Buffer.from([0x81, 126, pl.length >> 8, pl.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(pl.length), 2); return h; })();
    socket.write(Buffer.concat([hdr, pl]));
  } };
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { socket.destroy(); return; }
      const mo = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      const pl = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) pl[i] ^= buf[mo + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl])); continue; }
      if (op === 1) { try { onMessage(conn, JSON.parse(pl.toString())); } catch (e) { console.warn('bad message', e.message); } }
    }
  });
  socket.on('close', () => onClose(conn));
  socket.on('error', () => onClose(conn));
  return conn;
}
