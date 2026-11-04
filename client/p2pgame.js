// A peer to peer duel in the browser: this page runs the whole sim itself, in a rollback session against the other player. It hands the
// rest of the client the same snapshots and events a server would send, so the renderer, HUD and audio don't know the difference.
import { GameData } from '/shared/gamedata.js';
import { CharacterStore } from '/shared/assets.js';
import { World, Player, Match, Cvars, TICK } from '/shared/sim.js';
import { RollbackSession, packInput, encodePacket, decodePacket } from '/shared/rollback.js';
import { buildSnapshot } from '/shared/snapshot.js';
import { connectPeer } from './peer.js';

// The code that decides what happens. A file that differs would desync, so peers compare a hash of these with the game files they read.
const SIM_CODE = ['sim', 'combat', 'detmath', 'mathx', 'mdl', 'bsp', 'phy', 'gamedata', 'assets', 'kv', 'simstate', 'rollback'].map((n) => `/shared/${n}.js`).concat('/shared/cvars_all.json');
const fnv = (bytes, h = 2166136261) => { for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0; return h; };
const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };

/**
 * Loads the sim's data, finds the other player and starts the match.
 * @param {object} o Options.
 * @param {string} o.relay The relay's WebSocket address.
 * @param {string} o.room The room two people agreed on.
 * @param {BSP} o.bsp The map, already loaded.
 * @param {Uint8Array} o.mapBytes Its file, for comparing.
 * @param {function(string): Promise<Uint8Array|null>} o.read Reads a game file.
 * @param {object} o.hello This player: name, character, item, look, color, options.
 * @param {Array} [o.iceServers] STUN or TURN servers.
 * @param {function(): number[]} o.input This player's buttons, yaw and pitch right now.
 * @param {function(object): void} o.onSnapshot Gets a snapshot, as from a server, each frame.
 * @param {function(object): void} o.onEvent Gets each event.
 * @param {function(string, boolean): void} o.onStatus Told what's going on, and whether it's an error.
 * @returns {Promise<object>} myId, session, world.
 */
export async function startP2PMatch({ relay, room, bsp, mapBytes, read, hello, iceServers = [], input, onSnapshot, onEvent, onStatus }) {
  onStatus('Loading the fight...');
  const seen = new Map();
  const bytes = async (p) => { const b = await read(p); if (b && !seen.has(p)) seen.set(p, fnv(new Uint8Array(b))); return b ? new Uint8Array(b) : null; };
  const text = async (p) => { const b = await bytes(p); if (!b) throw new Error('missing game file: ' + p); return latin1(b); };
  const cvarTable = await (await fetch('/shared/cvars_all.json')).json();
  const cvars = new Cvars(cvarTable);
  const data = await GameData.load(text, cvars);
  const assets = new CharacterStore(bytes, data);
  for (const k of Object.keys(data.characters)) await assets.preload(k);
  // Line endings depend on how the code was checked out, and don't change what it does
  for (const url of SIM_CODE) seen.set(url, fnv(new TextEncoder().encode((await (await fetch(url)).text()).replace(/\r/g, ''))));
  seen.set('map', fnv(mapBytes));
  const build = fnv(new TextEncoder().encode([...seen].sort((a, b) => (a[0] < b[0] ? -1 : 1)).join('\n'))).toString(16);
  const peer = await connectPeer({ relay, room, build, hello, iceServers, onStatus: (s) => onStatus(s, false) });

  // Both fighters from what each said about themselves, in seat order, the same on both sides
  const sides = peer.seat === 0 ? [hello, peer.other] : [peer.other, hello];
  const P = sides.map((h, i) => {
    const character = data.characters[h?.character] ? h.character : 'knight';
    const p = new Player(i + 1, String(h?.name || `Player ${i + 1}`).slice(0, 24), character);
    const item = data.swordItems.find((x) => x.id === h?.item);
    if (item) { p.sword = item.type; p.swordItem = item.id; }
    p.look = Array.isArray(h?.look) ? h.look : data.defaultLook[character];
    p.pickColor = h?.color ?? null;
    p.options = { gae: !!h?.options?.gae, sde: !!h?.options?.sde, ibt: Number.isFinite(h?.options?.ibt) ? Math.max(0, Math.min(2, h.options.ibt)) : 0.33 };
    return p;
  });
  const world = new World({ bsp, data, cvars, assets, map: 'p2p', seed: peer.seed, arenas: Match.single });
  world.duels[0].seat(P);
  const me = peer.seat, myId = P[me].id;
  const session = new RollbackSession({
    world, fighters: P, me,
    send: (p) => peer.send(encodePacket(p)),
    onDesync: (f) => { console.error(`desync at frame ${f}`); onStatus(`The two games no longer match (frame ${f}). This is a bug: results from here on can't be trusted.`, true); },
  });
  peer.onPacket = (b) => session.receive(decodePacket(b));
  let alive = true;
  peer.onClose = () => { alive = false; onStatus('The other player disconnected.', true); };

  // The session stands still while it waits, and a tab in the background only gets called now and then, so it catches up from a clock
  let last = performance.now(), acc = 0;
  const iv = setInterval(() => {
    if (!alive) { clearInterval(iv); return; }
    const now = performance.now();
    acc = Math.min(acc + (now - last) / 1000, 0.25);
    last = now;
    let moved = false;
    while (acc >= TICK) {
      acc -= TICK;
      moved = session.tick(packInput(input())) || moved;
      const { fresh } = session.takeEvents();
      for (const { event } of fresh) onEvent(event);
    }
    if (!moved) return;
    const s = buildSnapshot(world);
    s.time = world.time;
    s.duel = s.arenas[0];
    s.pv = P[me].alive ? world.previewAttack(P[me]) : null;
    onSnapshot(s);
  }, 2);
  onStatus('', false);
  return { myId, session, world, close: () => { alive = false; peer.close(); } };
}
