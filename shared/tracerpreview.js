// The attack preview (C_Berimbau_Attack_Preview): the path the blade would take if you swung now, drawn around you.
// [R client 1802ba870 build and fades, 1802b9280 target highlight, 1802b9670 draw]
import { entityMatrix } from './mathx.js';

// bb_tracerPreview_inner, _outer, _quality, _fadein_rate, _fadeout_rate, _opacity
const INNER = 10, OUTER = 40, QUALITY = 2, FADE_RATE = 8;
export const OPACITY = 1;
const TOP_RATE = 5, SWING_TOP = 1.8, HIGHLIGHT_RATE = 5, HIT_BOX = 8, HIT_LEAD = 0.08;
const HULL_MIN = [-13, -13, 0], HULL_MAX = [13, 13, 72];
// The path is built with the feet 36 under the origin, and turned about that point with the aim
const PIVOT = 36;

const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * [R 1803f4e20] each pass adds the midpoints, then averages every inner point with its two neighbours
 * @param {number[][]} points The line.
 * @param {number} passes How many times.
 * @returns {number[][]} The smoothed line.
 */
export function smoothLine(points, passes) {
  let out = points;
  for (let n = 0; n < passes && out.length >= 2; n++) {
    const t = [];
    for (let i = 0; i < out.length - 1; i++) t.push(out[i], lerp3(out[i], out[i + 1], 0.5));
    t.push(out[out.length - 1]);
    const next = [t[0]];
    for (let i = 0; i + 2 < t.length; i++) next.push([0, 1, 2].map((k) => (t[i][k] + t[i + 1][k] + t[i + 2][k]) / 3));
    next.push(t[t.length - 1]);
    out = next;
  }
  return out;
}

/**
 * The swing's sequence posed at each of its tracer entries, with no movement or aim
 * @param {Character} char The character.
 * @param {number} gripBone sword_grip's index.
 * @param {string} anim The swing's activity.
 * @param {string} [lower] Its lower body activity.
 * @param {number[]} cycles The tracer's cycles.
 * @returns {{strip: Array, mids: Array}|null} Vertices for the ribbon, and its middle line for the target check.
 */
export function buildPath(char, gripBone, anim, lower, cycles) {
  const seq = char.seqForActivity(anim);
  if (!seq || !cycles?.length || gripBone === undefined) return null;
  const lowerSeq = lower ? char.seqForActivity(lower) : null;
  const world = entityMatrix([0, 0, 0], [0, 0, 0]);
  let inner = [], outer = [];
  for (const cycle of cycles) {
    const layers = [];
    if (lowerSeq) { const [px, py] = char.blendFor(lowerSeq, 0, 0); layers.push({ seq: lowerSeq, cycle: 0, weight: 1, px, py }); }
    const [px, py] = char.blendFor(seq, 0, 0);
    layers.push({ seq, cycle, weight: 1, px, py });
    const m = char.boneMatrices(char.evalLayers(layers), world)[gripBone];
    const at = (d) => [m[3] + m[0] * d, m[7] + m[4] * d, m[11] + m[8] * d - PIVOT];
    inner.push(at(INNER));
    outer.push(at(OUTER));
  }
  if (inner.length < 2) return null;
  // Twice as wide where the swing starts, down to its own width at the end
  outer = outer.map((p, i) => lerp3(p, lerp3(inner[i], p, 2), 1 - i / (outer.length - 1)));
  const mids = inner.map((p, i) => ({ p: lerp3(p, outer[i], 0.5), t: 0 }));
  let total = 0;
  for (let i = 1; i < mids.length; i++) { total += dist(mids[i].p, mids[i - 1].p); mids[i].t = total; }
  for (const q of mids) q.t /= Math.max(total, 1);
  inner = smoothLine(inner, QUALITY);
  outer = smoothLine(outer, QUALITY);
  let u = 0;
  const strip = inner.map((a, i) => {
    if (i) u += 0.25 / (OUTER - INNER) * dist(outer[i], outer[i - 1]);
    return { a, b: outer[i], u };
  });
  return { strip, mids };
}

const toward = (v, target, step) => (target - v > step ? v + step : target - v < -step ? v - step : target);
const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];

/**
 * How far along a to b the box first touches, or -1
 * @param {number[]} a Start.
 * @param {number[]} b End.
 * @param {number[]} mn Box minimum.
 * @param {number[]} mx Box maximum.
 * @returns {number} Fraction, or -1.
 */
function sweep(a, b, mn, mx) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-6) { if (a[k] < mn[k] || a[k] > mx[k]) return -1; continue; }
    let n = (mn[k] - a[k]) / d, f = (mx[k] - a[k]) / d;
    if (n > f) [n, f] = [f, n];
    t0 = Math.max(t0, n); t1 = Math.min(t1, f);
    if (t0 > t1) return -1;
  }
  return t0;
}

/**
 * What's drawn for the local fighter, with its fades.
 */
export class TracerPreview {
  constructor() {
    this.key = null; this.path = null;
    this.fade = 0; this.top = 0; this.changed = false;
    this.amount = 0; this.position = 0;
  }

  /**
   * want: { a: animation, l: lower body } or null. build(want) makes the path. Fades the old path out, swaps, fades in.
   * @param {number} dt Seconds.
   * @param {{a: string, l: string}|null} want The attack, from World.previewAttack.
   * @param {boolean} swinging A swing is under way.
   * @param {function(object): object} build Builds the path, as buildPath does.
   */
  update(dt, want, swinging, build) {
    const key = want?.a ?? null;
    this.changed = key !== this.key;
    // a released swing wipes it away from the top
    this.top = toward(this.top, swinging ? SWING_TOP : 0, TOP_RATE * dt);
    const target = this.changed ? 0 : 1;
    if (this.fade !== target) { this.fade = toward(this.fade, target, FADE_RATE * dt); return; }
    if (this.changed) { this.key = key; this.path = key ? build(want) : null; }
  }

  /**
   * [R 1802b9280] Sweeps the path's middle against each enemy; the part of the path up to the first touch lights up.
   * @param {number} dt Seconds.
   * @param {number[]} origin Fighter's position.
   * @param {number} aim View pitch.
   * @param {number} yaw Fighter's yaw.
   * @param {number[][]} enemies Their positions.
   */
  highlight(dt, origin, aim, yaw, enemies) {
    const mids = this.path?.mids;
    if (!mids || mids.length < 2) { this.amount = 0; return; }
    const m = entityMatrix([origin[0], origin[1], origin[2] + PIVOT], [aim, yaw, 0]);
    const world = mids.map((q) => apply(m, q.p));
    let best = 2;
    for (const e of enemies) {
      const mn = [0, 1, 2].map((k) => e[k] + HULL_MIN[k] - HIT_BOX), mx = [0, 1, 2].map((k) => e[k] + HULL_MAX[k] + HIT_BOX);
      for (let i = 1; i < world.length; i++) {
        const f = sweep(world[i - 1], world[i], mn, mx);
        if (f < 0) continue;
        best = Math.min(best, Math.min(1, mids[i - 1].t + (mids[i].t - mids[i - 1].t) * f + HIT_LEAD));
        break;
      }
    }
    const hit = best <= 1;
    this.amount = toward(this.amount, hit ? 1 : 0, HIGHLIGHT_RATE * dt);
    if (hit) this.position = best;
  }

  /**
   * Vertices as x y z, then the shader's texcoord: u, top, along (1 at the swing's start), across
   * @param {number[]} origin Fighter's position.
   * @param {number} aim View pitch.
   * @param {number} yaw Fighter's yaw.
   * @returns {object|null} verts, count, ranges, amount, position.
   */
  draw(origin, aim, yaw) {
    const strip = this.path?.strip;
    if (!strip || strip.length < 2 || (this.fade <= 0 && this.changed)) return null;
    const m = entityMatrix([origin[0], origin[1], origin[2] + PIVOT], [aim, yaw, 0]), n = strip.length;
    const verts = new Float32Array(n * 14);
    strip.forEach((r, i) => {
      const along = 1 - i / (n - 1);
      verts.set([...apply(m, r.a), r.u, along, along, 0, ...apply(m, r.b), r.u, 1, along, 1], i * 14);
    });
    const f = this.fade, ch = this.changed;
    return {
      verts, count: n * 2,
      // $FADE_FRONT, $FADE_BACK, $FADE_TOP, $FADE_ANIMATE
      ranges: [ch ? 0 : 1 - f, ch ? f : 1, this.top, f > 0 && f < 1 ? (ch ? f - 0.05 : 1 - f + 0.05) : -1],
      amount: this.amount, position: 1 - this.position,
    };
  }
}
