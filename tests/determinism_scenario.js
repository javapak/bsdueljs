// A seeded fight, replayed identically by Node and by browsers, for tests/determinism_check.mjs. Reports a hash of the whole game
// state at checkpoints, so two engines can be compared bit for bit. Loaded the same way in both, so it can't import from node:.
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';

export const MATCHUPS = [['knight', 'ryoku', 'longsword', 'katana'], ['pure', 'vanguard', 'foil', 'jian'], ['phalanx', 'knight', 'scimitar', 'katana']];
const SECONDS = 150, EVERY = 8;
// What's read-only script or model data, and what's a person's connection rather than the game
const SKIP = new Set(['def', 'tierDef', 'seq', 'moveSeq', 'model', 'brain', 'ping', 'connected', 'viewArena', 'name']);

const bits = new Float64Array(1), words = new Uint32Array(bits.buffer);
const mix = (h, v) => Math.imul(h ^ v, 16777619) >>> 0;
function hashValue(h, v) {
  switch (typeof v) {
    case 'number': bits[0] = v === v ? v : NaN; h = mix(h, 1); h = mix(h, words[0]); return mix(h, words[1]);
    case 'string': h = mix(h, 2); for (let i = 0; i < v.length; i++) h = mix(h, v.charCodeAt(i)); return h;
    case 'boolean': return mix(h, v ? 3 : 4);
    case 'undefined': return mix(h, 5);
    case 'function': return h;
    default: break;
  }
  if (v === null) return mix(h, 6);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) { h = mix(h, 7); for (let i = 0; i < v.length; i++) h = hashValue(h, v[i]); return h; }
  h = mix(h, 8);
  for (const k of Object.keys(v).sort()) if (!SKIP.has(k)) { h = hashValue(hashValue(h, k), v[k]); }
  return h;
}

/** The state as plain data, with each double shown with its exact bits. */
function plain(v) {
  if (typeof v === 'number') { bits[0] = v; return `${v} ${words[1].toString(16)}:${words[0].toString(16)}`; }
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, plain);
  const o = {};
  for (const k of Object.keys(v).sort()) if (!SKIP.has(k)) o[k] = plain(v[k]);
  return o;
}

/** The same keys pressed and the same mouse moved, whichever engine asks. */
function inputs(seed) {
  let s = seed, b = 0, yaw = 0, pitch = -10;
  const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const keys = [IN.ATTACK, IN.ATTACK, IN.ATTACK, IN.BLOCK, IN.FORWARD, IN.FORWARD, IN.LEFT, IN.RIGHT, IN.BACK, IN.JUMP, IN.ROLL, IN.SHUFFLE, IN.GRAB, IN.THROW, IN.STANCE_FAST, IN.STANCE_BAL, IN.STANCE_HEAVY, IN.BOW, IN.TAUNT, IN.SIT, IN.SHEATHE];
  return (target) => {
    if (r() < 0.07) b ^= keys[Math.trunc(r() * keys.length)];
    if (r() < 0.04) b &= IN.ATTACK | IN.FORWARD;
    yaw = Math.fround(target + (r() - 0.5) * 50);
    pitch = Math.fround(Math.max(-60, Math.min(40, pitch + (r() - 0.5) * 3)));
    return [b, yaw, pitch];
  };
}

/**
 * Runs every matchup.
 * @param {object} o Where things come from.
 * @param {function(string): Promise<string>} o.text Reads a game file as Latin-1 text.
 * @param {function(string): Promise<Uint8Array|null>} o.bytes Reads a game file's bytes, or null if there's none.
 * @param {Object} o.cvarTable shared/cvars_all.json.
 * @param {number} [o.dumpTick] Also return the full state at this tick, to see what differs.
 * @returns {Promise<object>} Each matchup's checkpoint hashes, and how much actually happened in it.
 */
export async function runScenario({ text, bytes, cvarTable, dumpTick = -1 }) {
  // anything still using this gets a repeatable answer, and is counted
  let rs = 12345, randomCalls = 0;
  const realRandom = Math.random;
  Math.random = () => { randomCalls++; return (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296; };
  const cvars = new Cvars(cvarTable);
  const data = await GameData.load(text, cvars);
  const assets = new CharacterStore(bytes, data);
  for (const k of new Set(MATCHUPS.flatMap((m) => m.slice(0, 2)))) await assets.preload(k);
  const bsp = new BSP(await bytes('maps/duel_temple.bsp'));
  await bsp.addPropCollision?.(bytes);
  const out = [];
  for (const [ca, cb, sa, sb] of MATCHUPS) {
    const w = new World({ bsp, data, cvars, assets, map: 'duel_temple', seed: 987654321 });
    const a = new Player(1, 'A', ca), b = new Player(2, 'B', cb);
    a.sword = sa; b.sword = sb;
    w.addPlayer(a); w.addPlayer(b);
    const ia = inputs(11), ib = inputs(22), hashes = [], happened = {};
    let dump = null;
    const ticks = Math.round(SECONDS / TICK);
    const facing = (me, them) => { const dx = them.origin[0] - me.origin[0], dy = them.origin[1] - me.origin[1]; let best = 0, bestD = Infinity; for (let i = 0; i < 72; i++) { const c = TABLE[i], d = Math.abs(c[0] * dy - c[1] * dx) + (c[0] * dx + c[1] * dy < 0 ? 1e6 : 0); if (d < bestD) { bestD = d; best = i * 5; } } return best; };
    for (let t = 0; t < ticks; t++) {
      [a.buttons, a.viewYaw, a.pitch] = ia(facing(a, b));
      [b.buttons, b.viewYaw, b.pitch] = ib(facing(b, a));
      w.step();
      for (const e of w.events) happened[e.type] = (happened[e.type] ?? 0) + 1;
      w.events.length = 0;
      // the wider state goes in too: every checkpoint must also agree on the animation the blade reads
      if (t === dumpTick) dump = plain({ time: w.time, a, b, stars: w.stars, animA: w.animOf(a), animB: w.animOf(b), duel: { s: w.duels[0].state, t: w.duels[0].timer, r: w.duels[0].round, wins: w.duels[0].wins } });
      if (t % EVERY === 0) {
        let h = hashValue(2166136261, [w.time, w.tickCount, w.nextStar, w.rngState ?? 0]);
        h = hashValue(h, a); h = hashValue(h, b); h = hashValue(h, w.stars);
        h = hashValue(h, w.animOf(a)); h = hashValue(h, w.animOf(b));
        const d = w.duels[0];
        h = hashValue(h, [d.state, d.timer, d.round, d.wins, d.results, d.winner ?? null]);
        hashes.push(h);
      }
    }
    out.push({ match: `${ca} v ${cb}`, hashes, happened, dump });
  }
  Math.random = realRandom;
  return { results: out, randomCalls };
}
// Facing is read off a fixed table of whole angles, so that picking one doesn't depend on the math being tested
const TABLE = [];
for (let i = 0, c = 1, s = 0; i < 72; i++) { TABLE.push([c, s]); const nc = c * 0.9961946980917455 - s * 0.08715574274765817; s = s * 0.9961946980917455 + c * 0.08715574274765817; c = nc; }
