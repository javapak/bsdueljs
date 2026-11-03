#!/usr/bin/env node
// Duel dedicated server: authoritative 66-tick sim, WebSocket protocol, and HTTP for the browser
// client. Assets are read from the player's own install and never leave this machine's HTTP scope.
// Usage: node server/main.mjs [--game "<Blade Symphony dir>"] [--map duel_temple] [--port 27015] [--bot]
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { dirname, join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, TICK } from '../shared/sim.js';
import { makeBotBrain } from '../shared/bot.js';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  game: { type: 'string', default: resolve(here, '../../..') }, map: { type: 'string', default: 'duel_temple' }, port: { type: 'string', default: '27015' },
  bot: { type: 'boolean', default: false }, host: { type: 'string', default: '0.0.0.0' },
} });
const roots = [join(args.game, 'berimbau'), join(args.game, 'core')];
const findFile = (rel) => {
  const clean = normalize(rel).replace(/\\/g, '/');
  if (clean.startsWith('..') || clean.startsWith('/') || clean.includes('/../')) return null;
  for (const r of roots) { const p = join(r, clean); if (p.startsWith(r + sep) && existsSync(p) && statSync(p).isFile()) return p; }
  return null;
};
const need = (rel) => { const p = findFile(rel); if (!p) throw new Error('missing game file: ' + rel); return p; };

const cvarTable = JSON.parse(readFileSync(join(here, '../shared/cvars_all.json')));
const cvars = new Cvars(cvarTable);
const data = await GameData.load(async (p) => readFileSync(need(p), 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(need(p)), data);
const SWORD_LABELS = { longsword: 'Longsword (block)', katana: 'Katana (feint not built yet: blocks)', foil: 'Foil (guard)', jian: 'Jian (parry)', scimitar: 'Scimitar (block)' };
for (const k of Object.keys(data.characters)) await assets.preload(k);
const bsp = new BSP(readFileSync(need(`maps/${args.map}.bsp`)));
const world = new World({ bsp, data, cvars, assets, map: args.map });
console.log(`map ${args.map}, ${Object.keys(data.characters).length} characters, ${Object.keys(data.actions).length} actions`);

// ---------------------------------------------------------------- WebSocket (RFC 6455, text frames)
function wsAccept(req, socket) {
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
  conns.add(conn);
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
}

// ---------------------------------------------------------------- game protocol
const conns = new Set();
let nextId = 1;
let botPlayer = null;
function addBot() {
  if (botPlayer) return;
  const chars = Object.keys(data.characters);
  botPlayer = new Player(nextId++, 'Bot', chars[Math.floor(Math.random() * chars.length)]);
  botPlayer.isBot = true;
  botPlayer.brain = makeBotBrain();
  world.addPlayer(botPlayer);
}
function removeBot() { if (botPlayer) { world.removePlayer(botPlayer.id); botPlayer = null; } }

function onMessage(c, m) {
  if (m.t === 'join') {
    if (c.player) return;
    if (world.players.filter((p) => !p.isBot).length >= 2) { c.send({ t: 'full' }); return; }
    const ch = data.characters[m.character] ? m.character : 'knight';
    removeBot();
    c.player = new Player(nextId++, String(m.name || 'Player').slice(0, 24), ch);
    if (Object.hasOwn(SWORD_LABELS, m.sword)) c.player.sword = m.sword;
    world.addPlayer(c.player);
    if (args.bot && world.players.length < 2) addBot();
    c.send({ t: 'welcome', id: c.player.id, map: args.map, tick: TICK });
    console.log(`${c.player.name} joined as ${ch}`);
  } else if (m.t === 'cmd' && c.player) {
    c.player.buttons = m.b | 0;
    if (Number.isFinite(m.y)) c.player.viewYaw = m.y;
    if (Number.isFinite(m.p)) c.player.pitch = Math.max(-89, Math.min(89, m.p));
    c.lastSeq = m.s;
  } else if (m.t === 'character' && c.player && data.characters[m.character]) {
    c.player.character = m.character;
  }
}
function onClose(c) {
  if (!conns.delete(c)) return;
  if (c.player) {
    console.log(`${c.player.name} left`);
    world.removePlayer(c.player.id);
    if (args.bot && world.players.filter((p) => !p.isBot).length === 1) addBot();
    if (!world.players.some((p) => !p.isBot)) removeBot();
  }
}

const rnd = (x) => Math.round(x * 100) / 100;
const rnd3 = (x) => Math.round(x * 1000) / 1000;
function snapshot() {
  const d = world.duel;
  return {
    t: 'snap', time: rnd(world.time), players: world.players.map((p) => {
      const an = world.animOf(p);
      return {
        id: p.id, n: p.name, c: p.character, o: p.origin.map(rnd), v: p.vel.map(rnd), y: rnd(p.yaw), p: rnd(p.pitch), hp: p.health, al: p.alive, g: p.onGround, st: p.stance, score: p.score, kn: p.kneeling, fz: p.frozen,
        hs: p.hitstop > 0 ? 1 : 0, an: { b: an.base, bc: rnd3(an.baseCycle), u: an.upper, uc: rnd3(an.upperCycle), mx: rnd3(an.mx), my: rnd3(an.my), sp: rnd(an.speed), af: an.armsFrom, ch: an.charge && [an.charge[0], an.charge[1], rnd3(an.charge[2]), rnd3(an.charge[3]), rnd3(an.charge[4])], ld: an.land && [rnd3(an.land[0]), rnd3(an.land[1])], lg: rnd3(an.legs) },
        a: p.act ? { n: p.act.name, ph: p.act.phase, ti: p.act.tier, ct: p.act.chargeTier, l: rnd(Math.max(0, p.act.lock)), cf: p.act.phase === 'charge' && p.act.chargeTotal > 0 ? rnd3(Math.min(1, p.act.t / p.act.chargeTotal)) : 0, tr: p.act.tracer?.length && p.act.tracerIdx > 0 && p.act.tracerIdx < p.act.tracer.length ? 1 : 0, pw: (p.act.kind === 'parry' || p.act.kind === 'kneelparry') && p.act.t <= p.act.parryWindow ? 1 : 0 } : null,
      };
    }),
    duel: { s: d.state, tm: rnd(Math.max(0, d.timer)), r: d.round, w: d.wins, f: d.fighters, win: d.winner, max: cvars.f('vs_duel_rounds') },
  };
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wgsl': 'text/plain' };
const webRoots = { '/shared/': join(here, '../shared'), '/': join(here, '../client') };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('Cache-Control', 'no-cache');
  if (path === '/api/info') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ map: args.map, characters: Object.fromEntries(Object.entries(data.characters).map(([k, v]) => [k, { name: v.unlocalizedname || k, model: v.model.replace(/\\/g, '/'), color: v.colorlist }])), swords: SWORD_LABELS, charSword: data.charSword, bot: args.bot }));
    return;
  }
  if (path.startsWith('/game/')) {
    const f = findFile(path.slice(6));
    if (!f) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', statSync(f).size);
    createReadStream(f).pipe(res);
    return;
  }
  const base = path.startsWith('/shared/') ? '/shared/' : '/';
  const rel = path === '/' ? 'index.html' : path.slice(base.length);
  const root = webRoots[base];
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep) || !existsSync(full) || !statSync(full).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', MIME[extname(full)] || 'application/octet-stream');
  createReadStream(full).pipe(res);
});
server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.url.startsWith('/ws')) { socket.destroy(); return; }
  wsAccept(req, socket);
});

// ---------------------------------------------------------------- main loop
let last = performance.now(), acc = 0, tickNo = 0, maxTickMs = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  while (acc >= TICK) {
    const t0 = performance.now();
    world.step();
    maxTickMs = Math.max(maxTickMs, performance.now() - t0);
    acc -= TICK;
    tickNo++;
    if (world.events.length) { const ev = world.events.splice(0); for (const c of conns) c.send({ t: 'ev', ev }); }
    if (tickNo % 2 === 0) { const s = snapshot(); for (const c of conns) c.send(s); }
  }
}, 5);
server.listen(+args.port, args.host, () => console.log(`duel server listening on http://localhost:${args.port}${args.bot ? ' (bot enabled)' : ''}`));
