// Rollback netcode for two peers: each runs the whole sim and sends only inputs. The other side's inputs are predicted until they
// arrive, and a wrong guess rewinds to that frame and plays forward again. Nothing here knows about sockets; it takes a `send`
// function and is handed packets, so tests can run it through any network they like.
import { saveState, loadState, hashState } from './simstate.js';
import { packViewAngle, unpackViewAngle } from './sim.js';

const NEUTRAL = Object.freeze([0, 0, 0, 0, 0]);
/**
 * @param {number[]} i Buttons, yaw and pitch, then the camera's pitch and yaw packed by packViewAngle. Without those, the camera is taken to be the aim.
 * @returns {number[]} The form both peers simulate: whole buttons and single precision angles, so what's sent is exactly what's used.
 * Adding 0 turns -0 into 0: a sum with it can come out different in the last bit, and text formats like JSON drop the sign on the way over.
 */
export const packInput = (i) => [i[0] | 0, Math.fround(i[1]) + 0, Math.fround(i[2]) + 0, (i[3] ?? packViewAngle(i[2])) | 0, (i[4] ?? packViewAngle(i[1])) | 0];
/**
 * @param {object} p A packet from a session.
 * @returns {ArrayBuffer} It as bytes: 16 for each input. Binary keeps every bit of the angles. Any loadouts follow as JSON, which is rare.
 */
export function encodePacket(p) {
  const n = p.inputs.length, kit = p.loadouts?.length ? new TextEncoder().encode(JSON.stringify(p.loadouts)) : null;
  const out = new ArrayBuffer(28 + n * 16 + (kit?.length ?? 0)), v = new DataView(out);
  if (kit) new Uint8Array(out).set(kit, 28 + n * 16);
  v.setInt32(0, p.from, true); v.setInt32(4, n, true); v.setInt32(8, p.ack, true); v.setInt32(12, p.frame, true); v.setInt32(16, p.adv, true);
  v.setInt32(20, p.hash ? p.hash[0] : -1, true); v.setUint32(24, p.hash ? p.hash[1] : 0, true);
  p.inputs.forEach((inp, i) => { const o = 28 + i * 16; v.setInt32(o, inp[0], true); v.setFloat32(o + 4, inp[1], true); v.setFloat32(o + 8, inp[2], true); v.setInt16(o + 12, inp[3], true); v.setInt16(o + 14, inp[4], true); });
  return out;
}
/**
 * @param {ArrayBuffer} b From encodePacket.
 * @returns {object} The packet.
 */
export function decodePacket(b) {
  const v = new DataView(b), n = v.getInt32(4, true), inputs = new Array(n), hf = v.getInt32(20, true);
  for (let i = 0; i < n; i++) { const o = 28 + i * 16; inputs[i] = [v.getInt32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getInt16(o + 12, true), v.getInt16(o + 14, true)]; }
  const kit = b.byteLength > 28 + n * 16 ? JSON.parse(new TextDecoder().decode(new Uint8Array(b, 28 + n * 16))) : [];
  return { from: v.getInt32(0, true), inputs, ack: v.getInt32(8, true), frame: v.getInt32(12, true), adv: v.getInt32(16, true), hash: hf >= 0 ? [hf, v.getUint32(24, true)] : null, loadouts: kit };
}
const sameInput = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
// Frames between state hashes: about one second
const HASH_EVERY = 64;

/**
 * One peer's side of a match.
 */
export class RollbackSession {
  /**
   * @param {object} o Options.
   * @param {World} o.world The world, already seated, at frame 0. Both peers start from the same seed and fighters.
   * @param {Player[]} o.fighters The two fighters, in the same order on both peers.
   * @param {number} o.me This peer's index in `fighters`.
   * @param {function(object): void} o.send Sends a packet to the other peer; it may be lost, late or out of order.
   * @param {number} [o.inputDelay] Ticks before this peer's presses take effect, which gives them time to arrive and cuts down on rollbacks.
   * 2 ticks is 31 ms, about Slippi's default of 2 frames at 60 fps.
   * @param {number} [o.remoteDelay] The other peer's, which needn't be the same.
   * @param {number} [o.maxRollback] The furthest back it can rewind. Past this it waits for the other peer, since a short freeze reads better than
   * a large snap. 8 ticks is 125 ms, about Slippi's limit.
   * @param {function(number): void} [o.onDesync] Called with the frame if the peers' states ever differ.
   * @param {function(object): object} [o.dress] Turns a loadout from either peer into the fields it sets on a fighter, the same way on both.
   */
  constructor({ world, fighters, me, send, inputDelay = 2, remoteDelay = inputDelay, maxRollback = 8, onDesync = () => {}, dress = (l) => l }) {
    Object.assign(this, { world, fighters, me, send, inputDelay, maxRollback, onDesync, dress });
    this.them = 1 - me;
    this.frame = 0;
    // Each side's inputs by frame. Everyone starts neutral for the frames before the first press can land.
    this.inputs = [new Map(), new Map()];
    // A change of loadout travels with an input, so it lands on the same frame on both peers and a rewind replays it
    this.loadouts = [new Map(), new Map()];
    this.nextKit = null;
    for (let f = 0; f < inputDelay; f++) this.inputs[me].set(f, NEUTRAL);
    for (let f = 0; f < remoteDelay; f++) this.inputs[1 - me].set(f, NEUTRAL);
    this.localHigh = inputDelay - 1; // newest local input
    this.remoteConfirmed = remoteDelay - 1; // every remote input up to here is known
    this.peerAck = inputDelay - 1; // every local input up to here has reached them
    this.remoteFrame = 0; this.remoteAdvantage = 0;
    this.used = new Map(); // what was assumed for the other peer, by frame
    this.rewindTo = null; // earliest frame that was simulated on a wrong guess
    this.snaps = new Map();
    this.hashNext = 0; this.hashes = new Map(); this.peerHashes = new Map(); this.hashOut = null;
    this.eventsByFrame = new Map(); this.delivered = new Map(); this.fresh = []; this.cancelled = [];
    this.stats = { rollbacks: 0, framesResimulated: 0, deepest: 0, stalls: 0, slowdowns: 0, mispredictions: 0 };
    this.desynced = null;
    this.slowT = 0; this.lead = 0;
  }

  /**
   * A packet from the other peer.
   * @param {object} p It: from (the first input's frame), inputs, ack, frame, adv, hash.
   */
  receive(p) {
    const remote = this.inputs[this.them];
    p.inputs.forEach((inp, i) => { const f = p.from + i; if (f > this.remoteConfirmed && !remote.has(f)) remote.set(f, inp); });
    // A loadout is sent for as long as its input is, so it's always here by the time that input is confirmed
    for (const [f, kit] of p.loadouts ?? []) if (f > this.remoteConfirmed) this.loadouts[this.them].set(f, kit);
    while (remote.has(this.remoteConfirmed + 1)) {
      const f = ++this.remoteConfirmed, was = this.used.get(f);
      // Nothing guesses a loadout, so any frame already played without one has to be played again, whatever the buttons were
      if (was && (!sameInput(was, remote.get(f)) || this.loadouts[this.them].has(f))) { this.stats.mispredictions++; if (this.rewindTo === null || f < this.rewindTo) this.rewindTo = f; }
    }
    if (p.ack > this.peerAck) this.peerAck = p.ack;
    if (p.frame > this.remoteFrame) { this.remoteFrame = p.frame; this.remoteAdvantage = p.adv; }
    if (p.hash) { this.peerHashes.set(p.hash[0], p.hash[1]); this.compareHash(p.hash[0]); }
  }

  /**
   * One tick of real time.
   * @param {number[]} localInput This peer's buttons, yaw and pitch right now.
   * @returns {boolean} Whether the game moved on a frame. It holds still if the other peer is too far behind, or to let them catch up.
   */
  tick(localInput) {
    this.applyRollback();
    this.checkHashes();
    const behind = this.frame - this.remoteConfirmed > this.maxRollback;
    const ahead = this.shouldWait();
    if (behind) this.stats.stalls++; else if (ahead) this.stats.slowdowns++;
    const moving = !behind && !ahead;
    if (moving) {
      const at = this.frame + this.inputDelay;
      if (!this.inputs[this.me].has(at)) {
        this.inputs[this.me].set(at, packInput(localInput)); this.localHigh = at;
        if (this.nextKit) { this.loadouts[this.me].set(at, this.nextKit); this.nextKit = null; }
      }
    }
    this.sendInputs();
    if (moving) { this.stepFrame(this.frame); this.frame++; }
    this.prune();
    return moving;
  }

  /**
   * What this peer's fighter wears from the next set on.
   * @param {object} kit The loadout, as `dress` takes it. It goes through JSON here so both peers read exactly the same thing.
   */
  setLoadout(kit) { this.nextKit = JSON.parse(JSON.stringify(kit)); }

  /**
   * [the way GGPO keeps peers level] Two peers running the same speed but started apart stay apart, and the one ahead does all the
   * rolling back. Each reports how far ahead it thinks it is, and the one that's further ahead skips a tick now and then.
   * @returns {boolean} Whether to hold this tick.
   */
  shouldWait() {
    // averaged, since a lost packet makes the other peer's report look old for a moment
    this.lead += (this.advantage() - this.remoteAdvantage - this.lead) / 32;
    if (this.slowT > 0) { this.slowT--; return false; }
    if (this.lead < 2) return false;
    this.slowT = 8;
    return true;
  }

  /** @returns {number} How many frames ahead of the other peer's last report this one is. */
  advantage() { return this.frame - this.remoteFrame; }

  /** Rewinds to the first frame that was played on a wrong guess, and plays back up to now on what's known. */
  applyRollback() {
    if (this.rewindTo === null) return;
    const from = this.rewindTo, to = this.frame;
    this.rewindTo = null;
    if (from >= to) return;
    const snap = this.snaps.get(from);
    if (!snap) throw new Error(`no snapshot for frame ${from}, at ${to}`);
    loadState(this.world, snap);
    for (let f = from; f < to; f++) this.stepFrame(f);
    this.stats.rollbacks++;
    this.stats.framesResimulated += to - from;
    if (to - from > this.stats.deepest) this.stats.deepest = to - from;
  }

  /**
   * @param {number} who Which fighter.
   * @param {number} f The frame.
   * @returns {number[]} Their input, or for the other peer's unknown frames, the guess: their newest known input carried on.
   */
  inputFor(who, f) {
    const known = this.inputs[who].get(f);
    if (known) return known;
    // Only the other peer's future can be guessed. Guessing a frame that's known would silently split the two sims.
    if (who === this.me || f <= this.remoteConfirmed) throw new Error(`no input from ${who === this.me ? 'this' : 'the other'} peer for frame ${f}, at ${this.frame}`);
    return this.inputs[who].get(this.remoteConfirmed) ?? NEUTRAL;
  }

  /**
   * Saves the state before a frame, then plays it.
   * @param {number} f The frame.
   */
  stepFrame(f) {
    const w = this.world;
    this.snaps.set(f, saveState(w));
    const guess = this.inputFor(this.them, f);
    this.used.set(f, guess);
    for (let i = 0; i < 2; i++) {
      const p = this.fighters[i], inp = i === this.them ? guess : this.inputFor(i, f);
      [p.buttons, p.viewYaw, p.pitch] = inp;
      p.viewCone = [unpackViewAngle(inp[3]), unpackViewAngle(inp[4])];
      const kit = this.loadouts[i].get(f);
      if (kit) p.nextSetLoadout = this.dress(kit);
    }
    w.step();
    this.collectEvents(f);
  }

  /**
   * What happened in a frame, against what the game has already been told about it, so a rollback can take back a hit that
   * turned out to be a block. An event's whole content is its identity.
   * @param {number} f The frame.
   */
  collectEvents(f) {
    const w = this.world, now = w.events.map((e) => JSON.stringify(e)), told = this.delivered.get(f) ?? [];
    w.events.length = 0;
    const left = [...told];
    for (const key of now) {
      const i = left.indexOf(key);
      if (i >= 0) left.splice(i, 1); else this.fresh.push({ frame: f, event: JSON.parse(key) });
    }
    for (const key of left) this.cancelled.push({ frame: f, event: JSON.parse(key) });
    this.delivered.set(f, now);
  }

  /**
   * Takes what's happened since last asked.
   * @returns {{fresh: Array, cancelled: Array}} Events to play, and events already played that turned out not to happen.
   */
  takeEvents() {
    const out = { fresh: this.fresh, cancelled: this.cancelled };
    this.fresh = []; this.cancelled = [];
    return out;
  }

  /** Every local input they might not have, so a lost packet costs nothing once the next arrives. */
  sendInputs() {
    const from = this.peerAck + 1, list = [], mine = this.inputs[this.me];
    for (let f = from; f <= this.localHigh; f++) list.push(mine.get(f));
    const loadouts = this.loadouts[this.me].size ? [...this.loadouts[this.me]].filter(([f]) => f >= from) : [];
    this.send({ from, inputs: list, ack: this.remoteConfirmed, frame: this.frame, adv: this.advantage(), hash: this.hashOut, loadouts });
  }

  /** A frame's state is final once everything before it is confirmed. Hashes those at intervals to compare with the other peer. */
  checkHashes() {
    while (this.hashNext <= this.remoteConfirmed + 1 && this.hashNext < this.frame) {
      const f = this.hashNext, snap = this.snaps.get(f);
      if (!snap) throw new Error(`no snapshot to hash for frame ${f}`);
      const h = hashState(snap);
      this.hashes.set(f, h);
      this.hashOut = [f, h];
      this.compareHash(f);
      this.hashNext += HASH_EVERY;
    }
  }

  /**
   * @param {number} f A frame both may have hashed.
   */
  compareHash(f) {
    const a = this.hashes.get(f), b = this.peerHashes.get(f);
    if (a === undefined || b === undefined || this.desynced !== null) return;
    if (a !== b) { this.desynced = f; this.onDesync(f); }
  }

  /** Drops what no rewind or hash can need again. */
  prune() {
    const keep = Math.min(this.remoteConfirmed + 1, this.hashNext, this.rewindTo ?? Infinity);
    for (const f of this.snaps.keys()) { if (f >= keep) break; this.snaps.delete(f); }
    for (const m of [this.used, this.delivered]) for (const f of m.keys()) { if (f >= keep - 1) break; m.delete(f); }
    // their packets can arrive out of order, so these aren't in frame order. A peer that's behind still has to play what's confirmed.
    const theirs = Math.min(this.remoteConfirmed, this.frame);
    for (const f of this.inputs[this.them].keys()) if (f < theirs) this.inputs[this.them].delete(f);
    for (const f of this.loadouts[this.them].keys()) if (f < theirs) this.loadouts[this.them].delete(f);
    // a rewind can go back to anything not yet confirmed, and needs this peer's inputs for it even if they've arrived over there
    const mine = Math.min(this.peerAck + 1, this.remoteConfirmed, this.frame);
    for (const f of this.inputs[this.me].keys()) { if (f >= mine) break; this.inputs[this.me].delete(f); }
    for (const f of this.loadouts[this.me].keys()) { if (f >= mine) break; this.loadouts[this.me].delete(f); }
  }
}
