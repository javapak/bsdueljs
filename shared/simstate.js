// A world's game state as a value: saved, put back, and hashed, which is what rolling back and checking for a desync come down to.
// Anything on a fighter counts as state unless it's named below, so a field added later is saved and compared without anyone
// having to remember. A fighter's script data and models are shared by reference: the sim never writes to them.

// Script and model data, the same on every peer and never written
const SHARED = new Set(['def', 'tierDef', 'seq', 'moveSeq', 'model']);
// Who someone is and how they're connected, which differ between peers or don't touch the fight. Hashing them would report a false desync.
const NOT_STATE = new Set(['name', 'isBot', 'brain', 'connected', 'ping', 'viewArena', 'unready', 'losses', 'score', 'look', 'pickColor']);
const WORLD = ['time', 'tickCount', 'rngState', 'nextStar'];
const MATCH = ['state', 'timer', 'round', 'winner'];
const MATCH_OBJECTS = ['wins', 'results', 'fighters', 'last'];

/**
 * @param {*} v Plain state: numbers, strings, arrays and plain objects.
 * @returns {*} A deep copy. Anything else would be shared between snapshots without anyone meaning it to, so it throws.
 */
function copy(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) { const a = new Array(v.length); for (let i = 0; i < v.length; i++) a[i] = copy(v[i]); return a; }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error(`not plain game state: ${proto.constructor?.name}`);
  const o = {};
  for (const k of Object.keys(v)) o[k] = SHARED.has(k) ? v[k] : copy(v[k]);
  return o;
}

/**
 * @param {World} w The world.
 * @returns {object} Its game state, independent of it from here on.
 */
export function saveState(w) {
  const s = { players: new Array(w.players.length), stars: copy(w.stars), arenas: new Array(w.duels.length) };
  for (const k of WORLD) s[k] = w[k];
  for (let i = 0; i < w.players.length; i++) {
    const p = w.players[i], f = {};
    for (const k of Object.keys(p)) if (!NOT_STATE.has(k)) f[k] = SHARED.has(k) ? p[k] : copy(p[k]);
    s.players[i] = { ref: p, f };
  }
  for (let i = 0; i < w.duels.length; i++) {
    const d = w.duels[i], a = {};
    for (const k of MATCH) a[k] = d[k];
    for (const k of MATCH_OBJECTS) a[k] = copy(d[k]);
    s.arenas[i] = a;
  }
  return s;
}

/**
 * Puts a world back. The same fighter objects stay in it, so anything holding one still does, and a snapshot can be loaded again.
 * @param {World} w The world.
 * @param {object} s From saveState.
 */
export function loadState(w, s) {
  for (const k of WORLD) w[k] = s[k];
  w.stars = copy(s.stars);
  w.events.length = 0;
  w.players = s.players.map((e) => e.ref);
  for (const { ref: p, f } of s.players) {
    for (const k of Object.keys(p)) if (!NOT_STATE.has(k) && !(k in f)) delete p[k];
    for (const k of Object.keys(f)) p[k] = SHARED.has(k) ? f[k] : copy(f[k]);
  }
  s.arenas.forEach((a, i) => {
    const d = w.duels[i];
    for (const k of MATCH) d[k] = a[k];
    for (const k of MATCH_OBJECTS) d[k] = copy(a[k]);
  });
}

const bits = new Float64Array(1), words = new Uint32Array(bits.buffer);
const mix = (h, v) => Math.imul(h ^ v, 16777619) >>> 0;
function hashValue(h, v) {
  switch (typeof v) {
    case 'number': bits[0] = v === v ? v : NaN; return mix(mix(mix(h, 1), words[0]), words[1]);
    case 'string': h = mix(h, 2); for (let i = 0; i < v.length; i++) h = mix(h, v.charCodeAt(i)); return h;
    case 'boolean': return mix(h, v ? 3 : 4);
    case 'undefined': return mix(h, 5);
    default: break;
  }
  if (v === null) return mix(h, 6);
  if (Array.isArray(v)) { h = mix(h, 7); for (let i = 0; i < v.length; i++) h = hashValue(h, v[i]); return h; }
  h = mix(h, 8);
  for (const k of Object.keys(v).sort()) if (!SHARED.has(k) && k !== 'ref') h = hashValue(hashValue(h, k), v[k]);
  return h;
}
/**
 * The same state hashes the same on any engine, to the bit: two peers compare these to find a desync.
 * @param {object} s From saveState.
 * @returns {number} A 32 bit hash.
 */
export const hashState = (s) => hashValue(2166136261, s);
