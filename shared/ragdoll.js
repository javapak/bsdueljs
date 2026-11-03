// Death ragdolls. The bodies, masses, damping and joint limits are the model's own .phy; the solver is not the game's
// Havok, so how a body falls is an approximation. Each solid is a rigid body in the frame of its bone, solved with
// position-based dynamics and collided against the world as a capsule.
import { matMul, quatMatrix } from './mathx.js';

const SUBSTEPS = 4, GRAVITY = 800; // sv_gravity; the player's 3x multiplier is its own movement code
const MAX_SPEED = 2000;

export function parsePhy(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = dv.getInt32(0, true);
  const count = dv.getInt32(8, true);
  for (let i = 0; i < count; i++) o += 4 + dv.getInt32(o, true);
  const text = new TextDecoder('latin1').decode(bytes.subarray(o));
  const block = (name) => [...text.matchAll(new RegExp(`${name}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(/"([^"]+)"\s+"([^"]*)"/g)].map((k) => [k[1], k[2]])));
  const solids = block('solid').map((s) => ({ index: +s.index, name: s.name.toLowerCase(), mass: +s.mass, damping: +s.damping, rotdamping: +s.rotdamping, inertia: +s.inertia, volume: +s.volume }));
  const constraints = block('ragdollconstraint').map((c) => ({ parent: +c.parent, child: +c.child, min: [+c.xmin, +c.ymin, +c.zmin], max: [+c.xmax, +c.ymax, +c.zmax] }));
  return { solids, constraints };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qMul = (p, q) => [
  p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1],
  p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
  p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3],
  p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2],
];
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qRot = (q, v) => { const u = [q[0], q[1], q[2]], t = mul(cross(u, v), 2); return add(add(v, mul(t, q[3])), cross(u, t)); };
function matQuat(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m, t = a + e + i;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; return qNorm([(h - f) / s, (c - g) / s, (d - b) / s, s / 4]); }
  if (a > e && a > i) { const s = Math.sqrt(1 + a - e - i) * 2; return qNorm([s / 4, (b + d) / s, (c + g) / s, (h - f) / s]); }
  if (e > i) { const s = Math.sqrt(1 + e - a - i) * 2; return qNorm([(b + d) / s, s / 4, (f + h) / s, (c - g) / s]); }
  const s = Math.sqrt(1 + i - a - e) * 2;
  return qNorm([(c + g) / s, (f + h) / s, s / 4, (d - b) / s]);
}
const toLocalPoint = (m, p) => { const d = [p[0] - m[3], p[1] - m[7], p[2] - m[11]]; return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]]; };
const origin = (m) => [m[3], m[7], m[11]];

export class Ragdoll {
  // world: this frame's bones; prevWorld: last frame's, for the motion the body was already in; vel: the fighter's velocity
  constructor(char, def, bsp, pose, world, prevWorld, dt, vel) {
    Object.assign(this, { char, bsp, pose });
    this.time = 0;
    const byBone = new Map();
    this.bodies = def.solids.map((s) => {
      const bone = char.root.boneByName.get(s.name);
      if (bone === undefined) return null;
      const m = world[bone];
      // reach: the middle of the next solids down, or else the farthest child bone
      const named = new Set(def.solids.map((x) => x.name));
      const parentSolid = (i) => { let k = char.bones[i].parent; while (k >= 0 && !named.has(char.bones[k].name.toLowerCase())) k = char.bones[k].parent; return k; };
      const under = (i) => { let k = char.bones[i].parent; while (k >= 0) { if (k === bone) return true; k = char.bones[k].parent; } return false; };
      const next = [];
      let far = null, best = 0;
      world.forEach((w, i) => {
        if (i === bone || !under(i)) return;
        const l = toLocalPoint(m, origin(w)), d = Math.hypot(l[0], l[1], l[2]);
        if (named.has(char.bones[i].name.toLowerCase()) && parentSolid(i) === bone) next.push(l);
        if (d > best) { best = d; far = l; }
      });
      let tip = next.length ? mul(next.reduce(add, [0, 0, 0]), 1 / next.length) : far;
      if (!tip || Math.hypot(tip[0], tip[1], tip[2]) < 2) tip = far && best >= 2 ? far : [6, 0, 0];
      const L = Math.hypot(tip[0], tip[1], tip[2]);
      const radius = Math.max(1.5, Math.min(11, Math.sqrt(s.volume / (Math.PI * Math.max(L, 2)))));
      const c = mul(tip, 0.5);
      const q = matQuat(m);
      const x = add(origin(m), qRot(q, c));
      const inertia = Math.max(0.1, 0.25 * s.mass * (radius * radius + L * L / 3)) * Math.max(1, s.inertia / 5);
      const prev = prevWorld?.[bone] ?? m;
      const moved = mul(sub(origin(m), origin(prev)), dt > 0 ? 1 / dt : 0);
      const speed = Math.hypot(moved[0], moved[1], moved[2]);
      const v = add(speed > MAX_SPEED ? mul(moved, MAX_SPEED / speed) : moved, vel);
      const body = { solid: s, bone, c, x, q, v, w: [0, 0, 0], m: s.mass, I: inertia, ends: [mul(c, -1), c], radius, xp: x, qp: q };
      byBone.set(bone, body);
      return body;
    });
    this.byBone = byBone;
    // joints sit at the child bone's origin; limits are measured from the model's reference pose
    const refPose = { P: char.bones.map((b) => b.pos), Q: char.bones.map((b) => b.quat) };
    const ref = char.boneMatrices(refPose, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    this.joints = def.constraints.map((c) => {
      const a = this.bodies[c.parent], b = this.bodies[c.child];
      if (!a || !b) return null;
      const ma = world[a.bone], mb = world[b.bone];
      const anchorA = sub(toLocalPoint(ma, origin(mb)), a.c), anchorB = mul(b.c, -1);
      const rest = qMul(qConj(matQuat(ref[a.bone])), matQuat(ref[b.bone]));
      return { a, b, anchorA, anchorB, rest, min: c.min.map((d) => d * Math.PI / 180), max: c.max.map((d) => d * Math.PI / 180) };
    }).filter(Boolean);
    this.bodies = this.bodies.filter(Boolean);
    this.hull = (r) => [[-r, -r, -r], [r, r, r]];
  }

  // moves a body pair by a world correction applied at offsets ra, rb from their centers
  _solve(a, ra, b, rb, d) {
    const C = Math.hypot(d[0], d[1], d[2]);
    if (C < 1e-5) return;
    const n = mul(d, 1 / C);
    const ca = cross(ra, n), wa = 1 / a.m + dot(ca, ca) / a.I;
    let wb = 0;
    if (b) { const cb = cross(rb, n); wb = 1 / b.m + dot(cb, cb) / b.I; }
    const P = mul(n, C / (wa + wb));
    a.x = add(a.x, mul(P, 1 / a.m));
    this._spin(a, mul(cross(ra, P), 1 / a.I));
    if (b) {
      b.x = sub(b.x, mul(P, 1 / b.m));
      this._spin(b, mul(cross(rb, P), -1 / b.I));
    }
  }

  _spin(b, w) { b.q = qNorm(add4(b.q, mul4(qMul([w[0], w[1], w[2], 0], b.q), 0.5))); }

  _joint(j) {
    const { a, b } = j;
    const ra = qRot(a.q, j.anchorA), rb = qRot(b.q, j.anchorB);
    this._solve(a, ra, b, rb, sub(add(b.x, rb), add(a.x, ra)));
    // keep the child inside its limits, per axis of the child's frame
    let e = qMul(qConj(j.rest), qMul(qConj(a.q), b.q));
    if (e[3] < 0) e = mul4(e, -1);
    const s = Math.hypot(e[0], e[1], e[2]);
    const angle = 2 * Math.atan2(s, e[3]), k = s > 1e-6 ? angle / s : 2;
    const r = [e[0] * k, e[1] * k, e[2] * k];
    const fix = r.map((v, i) => (v < j.min[i] ? v - j.min[i] : v > j.max[i] ? v - j.max[i] : 0));
    if (fix[0] || fix[1] || fix[2]) {
      const w = qRot(b.q, fix), total = 1 / a.I + 1 / b.I;
      const dw = mul(w, 0.2 / total);
      this._spin(a, mul(dw, 1 / a.I));
      this._spin(b, mul(dw, -1 / b.I));
    }
  }

  _collide(b) {
    const [mn, mx] = this.hull(b.radius);
    b.touching = false;
    for (const end of b.ends) {
      let from = add(b.xp, qRot(b.qp, end));
      const to = add(b.x, qRot(b.q, end));
      let tr = this.bsp.traceBox(from, to, mn, mx, 1);
      // a capsule that starts inside something climbs out of the top of it
      if (tr.startsolid) {
        from = add(from, [0, 0, 64]);
        tr = this.bsp.traceBox(from, to, mn, mx, 1);
        if (tr.startsolid || tr.fraction >= 1) continue;
      } else if (tr.fraction >= 1) continue;
      b.touching = true;
      const r = qRot(b.q, end);
      const n = tr.normal, push = sub(tr.endpos, to);
      this._solve(b, r, null, null, add(mul(n, dot(push, n)), [n[0] * 0.02, n[1] * 0.02, n[2] * 0.02]));
      // friction: most of the sliding this substep goes
      const slid = sub(add(b.x, qRot(b.q, end)), add(b.xp, qRot(b.qp, end))), tangent = sub(slid, mul(n, dot(slid, n)));
      this._solve(b, r, null, null, mul(tangent, -0.6));
    }
  }

  step(dt) {
    if (dt <= 0 || this.asleep) return;
    this.time += dt;
    const h = Math.min(dt, 0.05) / SUBSTEPS;
    for (let n = 0; n < SUBSTEPS; n++) {
      for (const b of this.bodies) {
        b.v[2] -= GRAVITY * h;
        const lin = Math.max(0, 1 - b.solid.damping * 0.1 * h), ang = Math.max(0, 1 - b.solid.rotdamping * h);
        b.v = mul(b.v, lin); b.w = mul(b.w, ang);
        b.xp = b.x; b.qp = b.q;
        b.x = add(b.x, mul(b.v, h));
        b.q = qNorm(add4(b.q, mul4(qMul([b.w[0], b.w[1], b.w[2], 0], b.q), 0.5 * h)));
      }
      for (const j of this.joints) this._joint(j);
      for (const b of this.bodies) this._collide(b);
      for (const b of this.bodies) {
        b.v = mul(sub(b.x, b.xp), 1 / h);
        const speed = Math.hypot(b.v[0], b.v[1], b.v[2]);
        if (speed > MAX_SPEED) b.v = mul(b.v, MAX_SPEED / speed);
        let d = qMul(b.q, qConj(b.qp));
        if (d[3] < 0) d = mul4(d, -1);
        b.w = [d[0] * 2 / h, d[1] * 2 / h, d[2] * 2 / h];
        // resting contact loses its energy quickly, or the solver's corrections never die down
        if (b.touching) { b.v = mul(b.v, 0.92); b.w = mul(b.w, 0.92); }
      }
      // joints bleed relative spin, which a limit pressing against the floor would otherwise keep feeding
      for (const j of this.joints) {
        const rel = sub(j.b.w, j.a.w), total = 1 / j.a.I + 1 / j.b.I, imp = mul(rel, 0.15 / total);
        j.a.w = add(j.a.w, mul(imp, 1 / j.a.I));
        j.b.w = sub(j.b.w, mul(imp, 1 / j.b.I));
      }
    }
    // a body that has stayed slow goes to sleep, as physics objects do
    const fastest = Math.max(...this.bodies.map((b) => Math.hypot(b.v[0], b.v[1], b.v[2])));
    this.slow = fastest < 80 ? (this.slow ?? 0) + dt : 0;
    if (this.slow > 0.5) { this.asleep = true; for (const b of this.bodies) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; } }
  }

  // Solids take their body's frame; every other bone rides its parent in the pose it died in
  bones(world) {
    const { char, pose, byBone } = this;
    const out = new Array(char.bones.length);
    for (let i = 0; i < char.bones.length; i++) {
      const b = byBone.get(i), parent = char.bones[i].parent;
      if (b) {
        const m = quatMatrix(b.q, [0, 0, 0]);
        const o = sub(b.x, qRot(b.q, b.c));
        m[3] = o[0]; m[7] = o[1]; m[11] = o[2];
        out[i] = m;
      } else {
        const local = quatMatrix(pose.Q[i], pose.P[i]);
        out[i] = parent < 0 ? matMul(world, local) : matMul(out[parent], local);
      }
    }
    return out;
  }
}
const add4 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const mul4 = (a, s) => [a[0] * s, a[1] * s, a[2] * s, a[3] * s];
