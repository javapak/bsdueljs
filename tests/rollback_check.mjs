// Rollback, on real game data. Saving and restoring must lose nothing: a fight that keeps rewinding has to match one that never did,
// bit for bit. Then two whole peers over a bad simulated network have to end up exactly where a perfect one would have put them.
// Usage: node tests/rollback_check.mjs "<install>"
import { readFileSync, existsSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Match, Cvars, IN, TICK } from '../shared/sim.js';
import { saveState, loadState, hashState } from '../shared/simstate.js';
import { RollbackSession, packInput, encodePacket, decodePacket } from '../shared/rollback.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
for (const k of ['knight', 'ryoku', 'pure', 'vanguard']) await assets.preload(k);
const bsp = new BSP(readFileSync(`${G}maps/duel_temple.bsp`));
await bsp.addPropCollision(async (p) => (existsSync(G + p) ? readFileSync(G + p) : null));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

const rng = (seed) => { let s = seed; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
const KEYS = [IN.ATTACK, IN.ATTACK, IN.ATTACK, IN.BLOCK, IN.FORWARD, IN.FORWARD, IN.LEFT, IN.RIGHT, IN.BACK, IN.JUMP, IN.ROLL, IN.SHUFFLE, IN.GRAB, IN.THROW, IN.STANCE_FAST, IN.STANCE_HEAVY, IN.SHEATHE, IN.BOW];
/** Someone playing: buttons change now and then, aimed roughly at where the other fighter is. */
function player(seed, me, them) {
  const r = rng(seed);
  let b = 0, pitch = -10;
  return () => {
    if (r() < 0.07) b ^= KEYS[Math.trunc(r() * KEYS.length)];
    if (r() < 0.04) b &= IN.ATTACK | IN.FORWARD;
    const yaw = Math.atan2(them.origin[1] - me.origin[1], them.origin[0] - me.origin[0]) * 180 / Math.PI;
    pitch = Math.max(-60, Math.min(40, pitch + (r() - 0.5) * 3));
    // Rounded so that the same aim can be replayed on another engine; the test's own Math.atan2 isn't part of the sim
    return packInput([b, Math.round(yaw + (r() - 0.5) * 50), Math.round(pitch)]);
  };
}
function match(chars = ['knight', 'ryoku'], swords = ['longsword', 'katana']) {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_temple', seed: 424242, arenas: Match.single });
  const P = [new Player(1, 'A', chars[0]), new Player(2, 'B', chars[1])];
  P[0].sword = swords[0]; P[1].sword = swords[1];
  w.duels[0].seat(P);
  return { w, P };
}
const apply = (p, inp) => { [p.buttons, p.viewYaw, p.pitch] = inp; };

// --- 1. the state is complete: saving, wrecking it and restoring puts back every bit
{
  const { w, P } = match(), r = rng(9);
  const pa = player(1, P[0], P[1]), pb = player(2, P[1], P[0]);
  for (let t = 0; t < 2000; t++) { apply(P[0], pa()); apply(P[1], pb()); w.step(); w.events.length = 0; }
  let wrong = 0, moved = 0;
  for (let t = 0; t < 400; t++) {
    const s = saveState(w), h = hashState(s);
    for (let i = 0; i < 1 + Math.trunc(r() * 12); i++) { apply(P[0], pa()); apply(P[1], pb()); w.step(); }
    if (hashState(saveState(w)) !== h) moved++;
    loadState(w, s);
    if (hashState(saveState(w)) !== h) wrong++;
    apply(P[0], pa()); apply(P[1], pb()); w.step(); w.events.length = 0;
  }
  check(moved > 390, `playing on changes the hash (${moved}/400), so the hash can see the state`);
  check(wrong === 0, `saved, played on and restored 400 times: ${wrong} wrong`);
  const s = saveState(w), s2 = hashState(s);
  apply(P[0], [IN.FORWARD, 10, 5]); w.step(); loadState(w, s); apply(P[0], [IN.BACK, 90, -5]); w.step(); loadState(w, s);
  check(hashState(s) === s2 && hashState(saveState(w)) === s2, 'a snapshot can be loaded again, and using it changes nothing');
}

// --- 2. rewinding changes nothing: a fight that keeps rewinding, even onto wrong inputs, matches one that never did
for (const [chars, swords] of [[['knight', 'ryoku'], ['longsword', 'katana']], [['pure', 'vanguard'], ['foil', 'jian']]]) {
  const T = 64 * 120;
  const ref = match(chars, swords);
  const pa = player(1, ref.P[0], ref.P[1]), pb = player(2, ref.P[1], ref.P[0]), log = [], hashes = [];
  const seen = {};
  for (let t = 0; t < T; t++) {
    const a = pa(), b = pb();
    log.push([a, b]);
    if (t % 8 === 0) hashes.push(hashState(saveState(ref.w)));
    apply(ref.P[0], a); apply(ref.P[1], b); ref.w.step();
    for (const e of ref.w.events) seen[e.type] = (seen[e.type] ?? 0) + 1;
    ref.w.events.length = 0;
  }
  const { w, P } = match(chars, swords), r = rng(77), snaps = new Map();
  const wrongInput = () => [Math.trunc(r() * 0x10000) & (IN.ATTACK | IN.BLOCK | IN.FORWARD | IN.LEFT | IN.JUMP | IN.ROLL), Math.fround(r() * 360 - 180), Math.fround(r() * 60 - 30)];
  let bad = -1, rewinds = 0, ticks = 0;
  for (let t = 0; t < T && bad < 0;) {
    snaps.set(t, saveState(w));
    if (t % 8 === 0 && hashState(snaps.get(t)) !== hashes[t / 8]) { bad = t; break; }
    apply(P[0], log[t][0]); apply(P[1], log[t][1]); w.step(); w.events.length = 0; ticks++;
    t++;
    snaps.delete(t - 40);
    if (r() < 0.03 && t > 20) {
      // play on past here on wrong guesses, as a misprediction does, then go back and do it right
      const depth = 1 + Math.trunc(r() * 16);
      for (let i = 0; i < depth; i++) { apply(P[0], wrongInput()); apply(P[1], wrongInput()); w.step(); ticks++; }
      w.events.length = 0;
      const back = Math.max(0, t - 1 - Math.trunc(r() * 16));
      loadState(w, snaps.get(back));
      t = back;
      rewinds++;
    }
  }
  const did = (seen.hit ?? 0) > 10 && (seen.swing ?? 0) > 20 && (seen.death ?? 0) >= 1;
  check(did, `${chars.join(' v ')}: a real fight, ${seen.swing} swings, ${seen.hit} hits, ${seen.death} deaths, ${seen.star_throw ?? 0} throws`);
  check(bad < 0, `${chars.join(' v ')}: ${rewinds} rewinds across ${ticks} simulated ticks match a straight run${bad >= 0 ? `: differs at tick ${bad}` : ''}`);
}

// --- 3. two peers over a bad network
/** A network with latency, jitter and loss, one way. Packets can overtake each other. */
class Wire {
  constructor(latency, jitter, loss, seed, deliver) { Object.assign(this, { latency, jitter, loss, r: rng(seed), deliver }); this.q = []; this.now = 0; }
  send(p) { if (this.r() >= this.loss) this.q.push({ at: this.now + this.latency + this.r() * this.jitter, p: decodePacket(encodePacket(p)) }); }
  advance(dt) { this.now += dt; for (let i = this.q.length - 1; i >= 0; i--) if (this.q[i].at <= this.now) { this.deliver(this.q[i].p); this.q.splice(i, 1); } }
}
function peers({ ms = 40, jitter = 0, loss = 0, start = 0, seconds = 60, asym = 1, delay = 2 }) {
  const A = match(), B = match();
  const desync = [];
  const wa = new Wire(ms * asym / 1000, jitter / 1000, loss, 5, (p) => sb.receive(p)), wb = new Wire(ms / 1000, jitter / 1000, loss, 6, (p) => sa.receive(p));
  const sa = new RollbackSession({ world: A.w, fighters: A.P, me: 0, send: (p) => wa.send(p), inputDelay: delay, onDesync: (f) => desync.push(f) });
  const sb = new RollbackSession({ world: B.w, fighters: B.P, me: 1, send: (p) => wb.send(p), inputDelay: delay, onDesync: (f) => desync.push(f) });
  const pa = player(1, A.P[0], A.P[1]), pb = player(2, B.P[1], B.P[0]);
  let worst = 0, cancelled = 0, fresh = 0;
  const T = Math.round(seconds / TICK);
  for (let t = 0; t < T; t++) {
    wa.advance(TICK); wb.advance(TICK);
    const t0 = performance.now();
    sa.tick(pa());
    const dt = performance.now() - t0;
    if (dt > worst) worst = dt;
    if (t >= start) sb.tick(pb());
    const ea = sa.takeEvents(); fresh += ea.fresh.length; cancelled += ea.cancelled.length;
    sb.takeEvents();
  }
  // let everything land, with nobody pressing anything new
  const idle = [0, 0, 0];
  for (let t = 0; t < 64 * 3; t++) { wa.advance(TICK); wb.advance(TICK); sa.tick(idle); sb.tick(idle); }
  return { sa, sb, A, B, desync, worst, fresh, cancelled };
}
const settle = (a, b) => {
  // run them to the same frame, on inputs both know by now
  const idle = [0, 0, 0];
  for (let i = 0; i < 400 && (a.frame !== b.frame || a.rewindTo !== null || b.rewindTo !== null); i++) { if (a.frame < b.frame) a.tick(idle); else if (b.frame < a.frame) b.tick(idle); else break; }
};
for (const net of [
  { name: 'LAN, 5 ms', ms: 5 },
  { name: '40 ms each way', ms: 40 },
  { name: '80 ms each way, jitter', ms: 80, jitter: 20 },
  { name: '120 ms each way, jitter, 5% loss', ms: 120, jitter: 30, loss: 0.05 },
  { name: '40 ms, 25% loss', ms: 40, jitter: 10, loss: 0.25 },
  { name: 'lopsided: 20 ms one way, 100 the other', ms: 100, asym: 0.2, jitter: 10 },
  { name: 'one peer starts half a second late', ms: 40, start: 32 },
]) {
  const r = peers(net), { sa, sb } = r;
  const f = Math.min(sa.frame, sb.frame), pct = (s) => (s.framesResimulated / Math.max(1, sa.frame) * 100).toFixed(0);
  const a = sa.hashes, b = sb.hashes;
  let compared = 0, differ = 0;
  for (const [k, h] of a) if (b.has(k)) { compared++; if (b.get(k) !== h) differ++; }
  check(!r.desync.length && differ === 0 && compared > 20, `${net.name}: ${compared} state hashes agree${differ ? `, ${differ} DIFFER` : ''}`);
  check(f > 60 * 64 * 0.9, `  it kept moving: ${f} frames of ${Math.round(63 * 64)}, ${sa.stats.stalls + sb.stats.stalls} stalled ticks, ${sa.stats.slowdowns + sb.stats.slowdowns} evening out`);
  console.log(`     rollbacks ${sa.stats.rollbacks}, deepest ${sa.stats.deepest} ticks, ${pct(sa.stats)}% extra simulation, worst tick ${r.worst.toFixed(2)} ms, events ${r.fresh} played, ${r.cancelled} taken back`);
  settle(sa, sb);
}

// --- 4. it agrees with the truth: replays what each peer actually sent with no network at all, and lands on the same hashes
{
  const seen = [[], []];
  const r0 = (() => {
    const A = match(), B = match();
    const wa = new Wire(0.06, 0.02, 0.05, 15, (p) => sb.receive(p)), wb = new Wire(0.06, 0.02, 0.05, 16, (p) => sa.receive(p));
    const sa = new RollbackSession({ world: A.w, fighters: A.P, me: 0, send: (p) => wa.send(p) }), sb = new RollbackSession({ world: B.w, fighters: B.P, me: 1, send: (p) => wb.send(p) });
    const pa = player(1, A.P[0], A.P[1]), pb = player(2, B.P[1], B.P[0]);
    // the inputs each peer settles on, frame by frame, before they can be pruned
    const note = (s, list) => { for (const f of s.inputs[s.me].keys()) if (!list[f]) list[f] = s.inputs[s.me].get(f); };
    for (let t = 0; t < 64 * 45; t++) { wa.advance(TICK); wb.advance(TICK); sa.tick(pa()); sb.tick(pb()); note(sa, seen[0]); note(sb, seen[1]); }
    for (let t = 0; t < 64 * 2; t++) { wa.advance(TICK); wb.advance(TICK); sa.tick([0, 0, 0]); sb.tick([0, 0, 0]); note(sa, seen[0]); note(sb, seen[1]); }
    return { sa, sb };
  })();
  const { w, P } = match();
  let compared = 0, differ = 0, frame = 0;
  const last = Math.max(...r0.sa.hashes.keys());
  for (; frame <= last; frame++) {
    const h = r0.sa.hashes.get(frame);
    if (h !== undefined) { compared++; if (hashState(saveState(w)) !== h) differ++; }
    apply(P[0], seen[0][frame] ?? [0, 0, 0]); apply(P[1], seen[1][frame] ?? [0, 0, 0]); w.step(); w.events.length = 0;
  }
  check(compared > 20 && differ === 0, `the rolled back game matches a straight replay of the same inputs: ${compared} hashes, ${differ} differ`);
}

// --- 5. the budget: the deepest rewind has to fit in a tick
{
  const { w, P } = match(), pa = player(1, P[0], P[1]), pb = player(2, P[1], P[0]);
  for (let t = 0; t < 64 * 20; t++) { apply(P[0], pa()); apply(P[1], pb()); w.step(); w.events.length = 0; }
  const times = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now(), s = saveState(w);
    for (let k = 0; k < 16; k++) { saveState(w); apply(P[0], pa()); apply(P[1], pb()); w.step(); }
    times.push(performance.now() - t0);
    w.events.length = 0;
    void s;
  }
  times.sort((a, b) => a - b);
  const p50 = times[150], p99 = times[297];
  check(p99 < 1000 / 64, `a 16 tick rewind, snapshots included: ${p50.toFixed(2)} ms typically, ${p99.toFixed(2)} ms at the 99th percentile, of a ${(1000 / 64).toFixed(1)} ms tick`);
  const s = saveState(w);
  console.log(`     one snapshot is ${JSON.stringify(s, (k, v) => (k === 'ref' || k === 'def' || k === 'tierDef' || k === 'seq' || k === 'moveSeq' ? undefined : v)).length} bytes as JSON`);
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
