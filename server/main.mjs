#!/usr/bin/env node
// Duel dedicated server: authoritative 64-tick sim, WebSocket protocol, and HTTP for the browser
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
import { buildSnapshot } from '../shared/snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  game: { type: 'string', default: resolve(here, '../../..') }, map: { type: 'string', default: 'duel_temple' }, port: { type: 'string', default: '27015' },
  bot: { type: 'boolean', default: false }, host: { type: 'string', default: 'localhost' }, // changing this default to localhost so people do not accidentally expose even on lan...don't wanna hear about it.
} });
const roots = [join(args.game, 'berimbau'), join(args.game, 'core')];
/**
 * Finds a game file by relative path, and refuses any path that would leave the game folder.
 * @param {string} rel Path under the game.
 * @returns {string|null} The full path.
 */
const findFile = (rel) => {
  const clean = normalize(rel).replace(/\\/g, '/');
  if (clean.startsWith('..') || clean.startsWith('/') || clean.includes('/../')) return null;
  for (const r of roots) { const p = join(r, clean); if (p.startsWith(r + sep) && existsSync(p) && statSync(p).isFile()) return p; }
  return null;
};
/**
 * @param {string} rel Path under the game.
 * @returns {string} The full path; throws if missing.
 */
const need = (rel) => { const p = findFile(rel); if (!p) throw new Error('missing game file: ' + rel); return p; };

const cvarTable = JSON.parse(readFileSync(join(here, '../shared/cvars_all.json')));
const cvars = new Cvars(cvarTable);
const data = await GameData.load(async (p) => readFileSync(need(p), 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(need(p)), data);
const SWORD_LABELS = { longsword: 'Longsword (block)', katana: 'Katana (feint)', foil: 'Foil (guard)', jian: 'Jian (intercept)', scimitar: 'Scimitar (block)' };
for (const k of Object.keys(data.characters)) await assets.preload(k);
const bsp = new BSP(readFileSync(need(`maps/${args.map}.bsp`)));
await bsp.addPropCollision(async (p) => { const f = findFile(p); return f ? readFileSync(f) : null; });
const world = new World({ bsp, data, cvars, assets, map: args.map });
console.log(`map ${args.map}, ${Object.keys(data.characters).length} characters, ${Object.keys(data.actions).length} actions`);

// ---------------------------------------------------------------- WebSocket (RFC 6455, text frames)
/**
 * A minimal WebSocket server with no dependencies: the handshake, framing and text messages.
 * @param {object} req The upgrade request.
 * @param {object} socket Its socket.
 */
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
// With --bot, anyone alone in an arena's queue gets a bot; it goes as soon as there's a second person
const arenaBots = new Map();
/**
 * With --bot, gives anyone alone in an arena's queue a bot, and removes it once there's a second person.
 */
function syncBots() {
  if (!args.bot) return;
  for (const d of world.duels) {
    const people = d.queue.filter((p) => !p.isBot && !p.unready);
    const bot = arenaBots.get(d);
    if (people.length === 1 && !bot) {
      const chars = Object.keys(data.characters);
      const b = new Player(nextId++, 'Bot', chars[Math.floor(Math.random() * chars.length)]);
      b.isBot = true;
      b.brain = makeBotBrain();
      b.look = data.defaultLook[b.character];
      arenaBots.set(d, b);
      world.addPlayer(b, d.index);
    } else if (people.length !== 1 && bot) {
      arenaBots.delete(d);
      world.removePlayer(bot.id);
    }
  }
}
/**
 * vs_ready [R 180358f90]: joins the arena's queue or leaves it. A fighter stays for the match and leaves after it.
 * @param {Player} p The player.
 * @param {number} arena Arena index.
 */
function toggleReady(p, arena) {
  const cur = world.duels.find((d) => d.queue.includes(p));
  const to = world.duels[arena] ?? world.duels[0];
  // [I] a match against a bot has nobody to keep waiting, so it ends there
  const realMatch = cur?.fighters.includes(p.id) && cur.fighters.every((id) => !world.player(id)?.isBot);
  if (realMatch && cur === to) { p.unready = !p.unready; }
  else {
    if (cur) cur.drop(p.id);
    if (cur !== to) to.enqueue(p);
  }
  syncBots();
}

/**
 * What a client asks to wear, kept to items for this character: one skin, mask and cape, one attachment per slot,
 * and always a mask because the fighter models have no head of their own.
 * @param {number[]} ids Item ids asked for.
 * @param {string} ch Character key.
 * @returns {number[]} The ids allowed.
 */
function validLook(ids, ch) {
  const out = new Map();
  for (const id of Array.isArray(ids) ? ids : []) {
    const i = data.lookItems.find((x) => x.id === id);
    if (i && (!i.character || i.character === ch)) out.set(i.kind === 'attachment' ? i.slot : i.kind, i.id);
  }
  if (!out.has('mask')) for (const id of data.defaultLook[ch]) out.set('mask', id);
  return [...out.values()];
}

/**
 * The color picker's value, 0 to 255
 * @param {*} c What the client sent.
 * @returns {number[]|null} [r, g, b], or null if it isn't a color.
 */
const validColor = (c) => (Array.isArray(c) && c.length === 3 && c.every(Number.isFinite) ? c.map((x) => Math.max(0, Math.min(255, Math.round(x)))) : null);

/**
 * A client's message: 'join', 'view', 'ready', 'cmd' (buttons and aim, every 15ms), 'loadout' or 'character'.
 * @param {object} c The connection.
 * @param {object} m The message.
 */
function onMessage(c, m) {
  if (m.t === 'join') {
    if (c.player) return;
    const ch = data.characters[m.character] ? m.character : 'knight';
    c.player = new Player(nextId++, String(m.name || 'Player').slice(0, 24), ch);
    if (Object.hasOwn(SWORD_LABELS, m.sword)) c.player.sword = m.sword;
    const item = data.swordItems.find((i) => i.id === m.item);
    if (item) { c.player.sword = item.type; c.player.swordItem = item.id; }
    c.player.look = validLook(m.look, ch);
    c.player.pickColor = validColor(m.color);
    // Joining the server only spectates; ready joins an arena's queue, and a client can ask for that straight away
    if (m.queue) toggleReady(c.player, m.arena | 0);
    c.send({ t: 'welcome', id: c.player.id, map: args.map, tick: TICK });
    console.log(`${c.player.name} joined as ${ch}`);
  } else if (m.t === 'options' && c.player) {
    c.player.options = { gae: !!m.gae, sde: !!m.sde, ibt: Number.isFinite(m.ibt) ? Math.max(0, Math.min(2, m.ibt)) : 0.33 };
  } else if (m.t === 'view' && c.player) {
    c.player.viewArena = m.arena | 0;
  } else if (m.t === 'ready' && c.player) {
    toggleReady(c.player, m.arena | 0);
  } else if (m.t === 'cmd' && c.player) {
    c.player.buttons = m.b | 0;
    // the newest snapshot's time, echoed back: how far behind the client is
    if (Number.isFinite(m.e)) c.player.ping = Math.max(0, Math.round((world.time - m.e) * 1000));
    if (Number.isFinite(m.y)) c.player.viewYaw = m.y;
    if (Number.isFinite(m.p)) c.player.pitch = Math.max(-89, Math.min(89, m.p));
    c.lastSeq = m.s;
  } else if (m.t === 'loadout' && c.player) {
    // [I] from the customization screen in a match: takes effect when the next round starts
    const ch = data.characters[m.character] ? m.character : c.player.character, item = data.swordItems.find((i) => i.id === m.item);
    const next = { character: ch, look: validLook(m.look, ch), pickColor: validColor(m.color), ...(item ? { sword: item.type, swordItem: item.id } : {}) };
    // In the world it waits for the next round; watching, it applies now
    if (world.players.includes(c.player)) c.player.nextLoadout = next; else Object.assign(c.player, next);
  } else if (m.t === 'character' && c.player && data.characters[m.character]) {
    c.player.character = m.character;
  }
}
/**
 * @param {object} c The connection.
 */
function onClose(c) {
  if (!conns.delete(c)) return;
  if (c.player) {
    console.log(`${c.player.name} left`);
    world.removePlayer(c.player.id);
    syncBots();
  }
}

/**
 * Everything clients draw from, sent every second tick (32 a second).
 * @returns {object} The snapshot.
 */
const snapshot = () => buildSnapshot(world, (d) => [...conns].filter((c) => c.player && (c.player.viewArena ?? 0) === d.index && !world.duels.some((x) => x.queue.includes(c.player))).map((c) => [c.player.id, c.player.name, 0, 0, 0, c.player.ping ?? 0]));

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wgsl': 'text/plain' };
const webRoots = { '/shared/': join(here, '../shared'), '/': join(here, '../client') };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('Cache-Control', 'no-cache');
  if (path === '/api/info') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ map: args.map, characters: Object.fromEntries(Object.entries(data.characters).map(([k, v]) => [k, { name: v.unlocalizedname || k, model: v.model.replace(/\\/g, '/'), color: v.colorlist, desc: data.charText[k], menuIdle: v.menuidleanim, menuSelect: v.menuselectanim }])), tracers: data.tracers, swords: SWORD_LABELS, swordNames: Object.fromEntries(Object.keys(SWORD_LABELS).map((k) => [k, SWORD_LABELS[k].replace(/ \(.*/, '')])), charSword: data.charSword, charSwordItem: data.charSwordItem, swordItems: data.swordItems, lookItems: data.lookItems, defaultLook: data.defaultLook, throwables: data.throwables, charThrowable: Object.fromEntries(Object.entries(data.characters).map(([k, v]) => [k, v.throwableweapon])), swordSounds: Object.fromEntries(Object.entries(data.swordTypes).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([n]) => n.startsWith('sound')))])), strings: Object.fromEntries(Object.keys(data.characters).map((k) => [k, [0, 1, 2, 3].map((st) => { const f = data.stanceFor(k, st)?.forward; return (f?.['action[]'] || [f?.action]).filter(Boolean).length; })])), bot: args.bot }));
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
    if (tickNo % 2 === 0) { const s = snapshot(); for (const c of conns) c.send({ ...s, duel: s.arenas[c.player?.arena ?? 0], pv: c.player && world.players.includes(c.player) && c.player.alive ? world.previewAttack(c.player) : null }); }
  }
}, 5);
server.listen(+args.port, args.host, () => console.log(`duel server listening on http://${args.host ? args.host : 'localhost'}:${args.port}${args.bot ? ' (bot enabled)' : ''}`));
