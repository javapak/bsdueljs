// Source particle simulation: runs the game's .pcf definitions. No GPU here, so it also runs under node.
// Attribute defaults and integration follow the Source particle library as used by these files.
// The operators implemented are the ones reached by gameplay effects; anything else is listed by
// unsupported() and skipped rather than guessed at.
import { parsePCF } from './pcf.js';

const D2R = Math.PI / 180;
const rnd = (a, b) => a + Math.random() * (b - a);
const rndExp = (a, b, e) => a + Math.pow(Math.random(), e ?? 1) * (b - a);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const spline = (t) => t * t * (3 - 2 * t);
const bias = (x, b) => (b === 0.5 ? x : Math.pow(x, Math.log(b) / Math.log(0.5)));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rndDir = () => { for (;;) { const x = rnd(-1, 1), y = rnd(-1, 1), z = rnd(-1, 1), l = x * x + y * y + z * z; if (l > 1e-4 && l <= 1) { const s = 1 / Math.sqrt(l); return [x * s, y * s, z * s]; } } };
const get = (o, k, d) => (o[k] === undefined ? d : o[k]);

// A control point: position plus an orthonormal frame (forward/left/up, Source's x/y/z).
export function makeCP(pos, dir = [1, 0, 0], up = [0, 0, 1]) {
  const m = Math.hypot(dir[0], dir[1], dir[2]);
  const fwd = m > 1e-6 ? [dir[0] / m, dir[1] / m, dir[2] / m] : [1, 0, 0];
  const l = cross(up, fwd);
  const n = Math.hypot(...l) || 1;
  const left = n > 1e-4 ? l.map((x) => x / n) : [0, 1, 0];
  return { pos: [...pos], fwd, left, up: cross(fwd, left), prev: [...pos] };
}
const toWorld = (cp, v) => [cp.fwd[0] * v[0] + cp.left[0] * v[1] + cp.up[0] * v[2], cp.fwd[1] * v[0] + cp.left[1] * v[1] + cp.up[1] * v[2], cp.fwd[2] * v[0] + cp.left[2] * v[1] + cp.up[2] * v[2]];

function strength(o, t) {
  const a = o['operator start fadein'] || 0, b = o['operator end fadein'] || 0, c = o['operator start fadeout'] || 0, d = o['operator end fadeout'] || 0;
  if (!(a || b || c || d)) return 1;
  if (b > a) { if (t < a) return 0; if (t < b) return (t - a) / (b - a); } else if (t < a) return 0;
  if (d > c) { if (t >= d) return 0; if (t > c) return 1 - (t - c) / (d - c); }
  return 1;
}
const moveBoth = (p, x, y, z) => { p.x += x; p.y += y; p.z += z; p.px += x; p.py += y; p.pz += z; };
const addVel = (p, v, dt) => { p.px -= v[0] * dt; p.py -= v[1] * dt; p.pz -= v[2] * dt; };
const setPos = (p, a, dt, v) => { p.x = a[0]; p.y = a[1]; p.z = a[2]; p.px = a[0] - (v ? v[0] * dt : 0); p.py = a[1] - (v ? v[1] * dt : 0); p.pz = a[2] - (v ? v[2] * dt : 0); };

const INIT = {
  'Lifetime Random'(o, p) { p.life = rndExp(get(o, 'lifetime_min', 0), get(o, 'lifetime_max', 0), o.lifetime_random_exponent); },
  'Lifetime Pre-Age Noise'(o, p) { p.age = Math.max(0, rnd(get(o, 'start age minimum', 0), get(o, 'start age maximum', 1))) * p.life; },
  'Radius Random'(o, p) { p.radius = p.radius0 = rndExp(get(o, 'radius_min', 1), get(o, 'radius_max', 1), o.radius_random_exponent); },
  'Alpha Random'(o, p) { p.a = p.a0 = rndExp(get(o, 'alpha_min', 255), get(o, 'alpha_max', 255), o.alpha_random_exponent) / 255; },
  'Color Random'(o, p) {
    const a = o.color1 ?? [255, 255, 255, 255], b = o.color2 ?? [255, 255, 255, 255], t = Math.random();
    p.r = p.r0 = (a[0] + (b[0] - a[0]) * t) / 255; p.g = p.g0 = (a[1] + (b[1] - a[1]) * t) / 255; p.b = p.b0 = (a[2] + (b[2] - a[2]) * t) / 255;
  },
  'Rotation Random'(o, p) { p.rot = (get(o, 'rotation_initial', 0) + rndExp(get(o, 'rotation_offset_min', 0), get(o, 'rotation_offset_max', 360), o.rotation_random_exponent)) * D2R; },
  'Rotation Speed Random'(o, p) { p.rotSpeed = (get(o, 'rotation_speed_constant', 0) + rndExp(get(o, 'rotation_speed_random_min', 0), get(o, 'rotation_speed_random_max', 360), o.rotation_speed_random_exponent)) * D2R; },
  'Rotation Yaw Flip Random'(o, p) { if (Math.random() < get(o, 'Flip Percentage', 0.5)) p.flip = 1; },
  'Sequence Random'(o, p, s) { const a = get(o, 'sequence_min', 0), b = get(o, 'sequence_max', 0); p.seq = o.linear ? a + (s.emitted % (b - a + 1)) : Math.floor(rnd(a, b + 1)); },
  'Sequence Two Random'() { /* second sequence: only blended in by the material's dual-sequence mode */ },
  'Trail Length Random'(o, p) { p.trail = rndExp(get(o, 'length_min', 0.1), get(o, 'length_max', 0.1), o.length_random_exponent); },
  'Position Within Sphere Random'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control_point_number', 0));
    const dmin = get(o, 'distance_min', 0), dmax = get(o, 'distance_max', 0);
    const db = o.distance_bias ?? [1, 1, 1], ab = o.distance_bias_absolute_value ?? [0, 0, 0];
    let d = rndDir();
    d = d.map((x, i) => (ab[i] ? Math.abs(x) : x) * db[i]);
    if (o['bias in local system']) d = toWorld(cp, d);
    const dist = rnd(dmin, dmax);
    const sp = rndExp(get(o, 'speed_min', 0), get(o, 'speed_max', 0), o.speed_random_exponent);
    const lo = o.speed_in_local_coordinate_system_min ?? [0, 0, 0], hi = o.speed_in_local_coordinate_system_max ?? [0, 0, 0];
    const lv = toWorld(cp, [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])]);
    setPos(p, [cp.pos[0] + d[0] * dist, cp.pos[1] + d[1] * dist, cp.pos[2] + d[2] * dist], dt, [d[0] * sp + lv[0], d[1] * sp + lv[1], d[2] * sp + lv[2]]);
  },
  'Position Within Box Random'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control point number', 0)), a = o.min ?? [0, 0, 0], b = o.max ?? [0, 0, 0];
    setPos(p, [cp.pos[0] + rnd(a[0], b[0]), cp.pos[1] + rnd(a[1], b[1]), cp.pos[2] + rnd(a[2], b[2])], dt);
  },
  'Position Along Ring'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control point number', 0)), th = get(o, 'thickness', 0), r0 = get(o, 'initial radius', 0);
    let ang;
    if (o['even distribution']) { const n = get(o, 'even distribution count', -1); ang = (2 * Math.PI * s.emitted) / (n > 0 ? n : Math.max(1, s.def.max_particles ?? 1000)); } else ang = rnd(0, 2 * Math.PI);
    const r = r0 + rnd(0, th);
    let v = [Math.cos(ang), Math.sin(ang), 0];
    const roll = get(o, 'roll', 0) * D2R, pitch = get(o, 'pitch', 0) * D2R, yaw = get(o, 'yaw', 0) * D2R;
    if (roll) v = [v[0], v[1] * Math.cos(roll) - v[2] * Math.sin(roll), v[1] * Math.sin(roll) + v[2] * Math.cos(roll)];
    if (pitch) v = [v[0] * Math.cos(pitch) + v[2] * Math.sin(pitch), v[1], -v[0] * Math.sin(pitch) + v[2] * Math.cos(pitch)];
    if (yaw) v = [v[0] * Math.cos(yaw) - v[1] * Math.sin(yaw), v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw), v[2]];
    v = toWorld(cp, v);
    const sp = rnd(get(o, 'min initial speed', 0), get(o, 'max initial speed', 0));
    const vel = v.map((x) => x * sp);
    if (get(o, 'XY velocity only', true) === false) vel[2] += rnd(-sp, sp);
    setPos(p, [cp.pos[0] + v[0] * r, cp.pos[1] + v[1] * r, cp.pos[2] + v[2] * r], dt, vel);
  },
  'Position From Chaotic Attractor'(o, p, s, dt) {
    const cp = s.cp(get(o, 'Relative Control point number', 0)), st = (s.attr ??= [0, 0, 0]);
    const a = get(o, 'Pickover A Parameter', -0.966918), b = get(o, 'Pickover B Parameter', 2.879879), c = get(o, 'Pickover C Parameter', 0.765145), d = get(o, 'Pickover D Parameter', 0.744728);
    const n = [Math.sin(a * st[1]) - st[2] * Math.cos(b * st[0]), st[2] * Math.sin(c * st[0]) - Math.cos(d * st[1]), Math.sin(st[0])];
    const dir = [n[0] - st[0], n[1] - st[1], n[2] - st[2]], len = Math.hypot(...dir) || 1;
    s.attr = n;
    const sc = get(o, 'Scale', 1), sp = rnd(get(o, 'Speed Min', 0), get(o, 'Speed Max', 0)) / len;
    setPos(p, [cp.pos[0] + n[0] * sc, cp.pos[1] + n[1] * sc, cp.pos[2] + n[2] * sc], dt, dir.map((x) => x * sp));
  },
  'Position Along Path Sequential'(o, p, s, dt) {
    const a = s.cp(get(o, 'start control point number', 0)).pos, b = s.cp(get(o, 'end control point number', 1)).pos;
    const n = get(o, 'particles to map from start to end', 100), t = (s.emitted % Math.max(1, n)) / Math.max(1, n);
    setPos(p, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], dt);
  },
  'Position From Parent Particles'(o, p, s, dt) {
    const q = s.parent?.particles;
    if (!q?.length) { setPos(p, s.cp(0).pos, dt); return; }
    const src = q[o['Random Parent Particle Distribution'] ? Math.floor(Math.random() * q.length) : s.emitted % q.length];
    p.parentP = src;
    setPos(p, [src.x, src.y, src.z], dt);
  },
  // Source picks a hitbox of the model at this control point; the host supplies bone positions instead.
  'Position on Model Random'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control_point_number', 0)), bones = s.host.bonesOf?.(cp.entity);
    if (!bones?.length) { setPos(p, cp.pos, dt); return; }
    const i = Math.floor(Math.random() * bones.length), b = bones[i], j = rndDir(), r = 3;
    p.bone = i; p.bx = j[0] * r; p.by = j[1] * r; p.bz = j[2] * r;
    setPos(p, [b[0] + p.bx, b[1] + p.by, b[2] + p.bz], dt);
  },
  'Position Modify Offset Random'(o, p, s) {
    const cp = s.cp(get(o, 'control_point_number', 0)), a = o['offset min'] ?? [0, 0, 0], b = o['offset max'] ?? [0, 0, 0];
    let v = [rnd(a[0], b[0]), rnd(a[1], b[1]), rnd(a[2], b[2])];
    if (o['offset in local space 0/1']) v = toWorld(cp, v);
    const k = o['offset proportional to radius 0/1'] ? p.radius : 1;
    moveBoth(p, v[0] * k, v[1] * k, v[2] * k);
  },
  'Position Modify Warp Random'(o, p, s) {
    const c = s.cp(get(o, 'control point number', 0)).pos, a = o['warp min'] ?? [1, 1, 1], b = o['warp max'] ?? [1, 1, 1];
    const w = [rnd(a[0], b[0]), rnd(a[1], b[1]), rnd(a[2], b[2])];
    for (const [k, q] of [['x', 0], ['y', 1], ['z', 2]]) { p[k] = c[q] + (p[k] - c[q]) * w[q]; p['p' + k] = c[q] + (p['p' + k] - c[q]) * w[q]; }
  },
  'Position Modify Place On Ground'(o, p, s) {
    const len = get(o, 'max trace length', 128), off = get(o, 'offset', 0);
    const hit = s.host.trace?.([p.x, p.y, p.z + len * 0.5], [p.x, p.y, p.z - len]);
    if (hit) moveBoth(p, 0, 0, hit[2] + off - p.z);
  },
  'Velocity Random'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control_point_number', 0)), sp = rnd(get(o, 'random_speed_min', 0), get(o, 'random_speed_max', 0));
    const lo = o.speed_in_local_coordinate_system_min ?? [0, 0, 0], hi = o.speed_in_local_coordinate_system_max ?? [0, 0, 0];
    const lv = toWorld(cp, [rnd(lo[0], hi[0]), rnd(lo[1], hi[1]), rnd(lo[2], hi[2])]), d = sp ? rndDir() : [0, 0, 0];
    addVel(p, [lv[0] + d[0] * sp, lv[1] + d[1] * sp, lv[2] + d[2] * sp], dt);
  },
  'Velocity Noise'(o, p, s, dt) {
    const a = o['output minimum'] ?? [0, 0, 0], b = o['output maximum'] ?? [0, 0, 0];
    let v = [rnd(a[0], b[0]), rnd(a[1], b[1]), rnd(a[2], b[2])];
    if (o['Apply Velocity in Local Space (0/1)']) v = toWorld(s.cp(get(o, 'Control Point Number', 0)), v);
    addVel(p, v, dt);
  },
  'Velocity Inherit from Control Point'(o, p, s, dt) {
    const cp = s.cp(get(o, 'control point number', 0)), k = get(o, 'velocity scale', 1), inv = s.lastDt > 0 ? k / s.lastDt : 0;
    addVel(p, [(cp.pos[0] - cp.prev[0]) * inv, (cp.pos[1] - cp.prev[1]) * inv, (cp.pos[2] - cp.prev[2]) * inv], dt);
  },
  'Remap Control Point to Vector'(o, p, s) {
    const cp = s.cp(get(o, 'input control point number', 0)), hi = o['input maximum'] ?? [1, 1, 1], out = o['output maximum'] ?? [1, 1, 1];
    if (get(o, 'output field', 6) === 6) { p.r = p.r0 = (cp.pos[0] / (hi[0] || 1)) * out[0]; p.g = p.g0 = (cp.pos[1] / (hi[1] || 1)) * out[1]; p.b = p.b0 = (cp.pos[2] / (hi[2] || 1)) * out[2]; }
  },
};

const OP = {
  'Movement Basic'(o, s, dt, k) {
    const g = o.gravity ?? [0, 0, 0], drag = Math.max(0, get(o, 'drag', 0));
    const adj = (s.lastDt > 0 ? dt / s.lastDt : 1) * Math.pow(1 - drag, dt * 30);
    for (const p of s.particles) {
      s.force[0] = g[0]; s.force[1] = g[1]; s.force[2] = g[2];
      for (const f of s.forceFns) f(p, s.force);
      const x = p.x, y = p.y, z = p.z;
      p.x += (x - p.px) * adj + s.force[0] * dt * dt * k;
      p.y += (y - p.py) * adj + s.force[1] * dt * dt * k;
      p.z += (z - p.pz) * adj + s.force[2] * dt * dt * k;
      p.px = x; p.py = y; p.pz = z;
      for (const c of s.constraintFns) c(p, dt);
    }
  },
  'Lifespan Decay'(o, s) { for (const p of s.particles) if (p.age >= p.life) p.dead = true; },
  'Alpha Fade and Decay'(o, s) {
    const a0 = get(o, 'start_alpha', 1), a1 = get(o, 'end_alpha', 0), i0 = get(o, 'start_fade_in_time', 0), i1 = get(o, 'end_fade_in_time', 0.5), o0 = get(o, 'start_fade_out_time', 0.5), o1 = get(o, 'end_fade_out_time', 1);
    for (const p of s.particles) {
      const t = p.life > 0 ? p.age / p.life : 1;
      if (t >= 1) { p.dead = true; continue; }
      let v = 1;
      if (t < i1) v = i1 > i0 ? a0 + (1 - a0) * clamp01((t - i0) / (i1 - i0)) : 1;
      else if (t > o0) v = o1 > o0 ? 1 + (a1 - 1) * clamp01((t - o0) / (o1 - o0)) : a1;
      p.a = p.a0 * v;
    }
  },
  'Alpha Fade In Random'(o, s) {
    for (const p of s.particles) {
      p.fin ??= rnd(get(o, 'fade in time min', 0.25), get(o, 'fade in time max', 0.25));
      const span = get(o, 'proportional 0/1', true) ? p.fin * p.life : p.fin;
      if (p.age < span) p.a = p.a0 * spline(clamp01(p.age / (span || 1)));
    }
  },
  'Alpha Fade Out Random'(o, s) {
    const b = get(o, 'fade bias', 0.5), ease = get(o, 'ease in and out', true);
    for (const p of s.particles) {
      p.fout ??= rnd(get(o, 'fade out time min', 0.25), get(o, 'fade out time max', 0.25));
      const span = get(o, 'proportional 0/1', true) ? p.fout * p.life : p.fout, left = p.life - p.age;
      if (left < span) { const t = bias(clamp01(left / (span || 1)), b); p.a = p.a0 * (ease ? spline(t) : t); }
    }
  },
  'Alpha Fade In Simple'(o, s) { const f = get(o, 'proportional fade in time', 0.25); for (const p of s.particles) { const t = p.age / (p.life || 1); if (t < f) p.a = p.a0 * (t / f); } },
  'Alpha Fade Out Simple'(o, s) { const f = get(o, 'proportional fade out time', 0.25); for (const p of s.particles) { const t = 1 - p.age / (p.life || 1); if (t < f) p.a = p.a0 * clamp01(t / f); } },
  'Radius Scale'(o, s) {
    const t0 = get(o, 'start_time', 0), t1 = get(o, 'end_time', 1), a = get(o, 'radius_start_scale', 1), b = get(o, 'radius_end_scale', 1), ease = o.ease_in_and_out, sb = get(o, 'scale_bias', 0.5);
    for (const p of s.particles) {
      const t = p.age / (p.life || 1);
      if (t < t0 || t > t1) continue;
      let f = (t - t0) / ((t1 - t0) || 1);
      f = ease ? spline(f) : bias(f, sb);
      p.radius = p.radius0 * (a + (b - a) * f);
    }
  },
  'Color Fade'(o, s) {
    const c = o.color_fade ?? [255, 255, 255, 255], t0 = get(o, 'fade_start_time', 0), t1 = get(o, 'fade_end_time', 1), ease = get(o, 'ease_in_and_out', true);
    for (const p of s.particles) {
      const t = p.age / (p.life || 1);
      if (t < t0 || t > t1) continue;
      let f = (t - t0) / ((t1 - t0) || 1);
      if (ease) f = spline(f);
      p.r = p.r0 + (c[0] / 255 - p.r0) * f; p.g = p.g0 + (c[1] / 255 - p.g0) * f; p.b = p.b0 + (c[2] / 255 - p.b0) * f;
    }
  },
  'Rotation Basic'(o, s, dt) { for (const p of s.particles) p.rot += p.rotSpeed * dt; },
  'Movement Lock to Control Point'(o, s) {
    const cp = s.cp(get(o, 'control_point_number', 0)), x = cp.pos[0] - cp.prev[0], y = cp.pos[1] - cp.prev[1], z = cp.pos[2] - cp.prev[2];
    if (x || y || z) for (const p of s.particles) moveBoth(p, x, y, z);
  },
  'Movement Lock to Bone'(o, s) {
    const cp = s.cp(get(o, 'control_point_number', 0)), bones = s.host.bonesOf?.(cp.entity);
    if (bones) for (const p of s.particles) { const b = p.bone !== undefined && bones[p.bone]; if (b) moveBoth(p, b[0] + p.bx - p.x, b[1] + p.by - p.y, b[2] + p.bz - p.z); }
  },
  'Movement Dampen Relative to Control Point'(o, s) {
    const c = s.cp(get(o, 'control_point_number', 0)).pos, r = get(o, 'falloff range', 100) || 1, sc = get(o, 'dampen scale', 1);
    for (const p of s.particles) {
      const d = clamp01(1 - Math.hypot(p.x - c[0], p.y - c[1], p.z - c[2]) / r) * sc, k = clamp01(1 - d);
      p.px = p.x + (p.px - p.x) * k; p.py = p.y + (p.py - p.y) * k; p.pz = p.z + (p.pz - p.z) * k;
    }
  },
  'Set Control Point To Player'(o, s) {
    const pos = s.host.localPlayer?.(), off = o['Control Point Offset'] ?? [0, 0, 0];
    if (pos) s.setCP(get(o, 'Control Point Number', 1), makeCP([pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]]));
  },
  'Set child control points from particle positions'(o, s) {
    const first = get(o, 'First control point to set', 0), n = get(o, '# of control points to set', 1), fg = get(o, 'Group ID to affect', 0);
    void fg;
    for (const c of s.children) c.inst?.particles !== undefined && s.particles.slice(0, n).forEach((p, i) => c.inst.setCP(first + i, makeCP([p.x, p.y, p.z])));
  },
};

const FORCE = {
  'Pull towards control point'(o, s) {
    const c = s.cp(get(o, 'control point number', 0)).pos, amt = get(o, 'amount of force', 0), fp = get(o, 'falloff power', 2), st = strength(o, s.t);
    return (p, f) => {
      const x = c[0] - p.x, y = c[1] - p.y, z = c[2] - p.z, l = Math.hypot(x, y, z) || 1, m = (st * amt * Math.pow(l, -fp)) / l;
      f[0] += x * m; f[1] += y * m; f[2] += z * m;
    };
  },
  'random force'(o, s) {
    const a = o['min force'] ?? [0, 0, 0], b = o['max force'] ?? [0, 0, 0], st = strength(o, s.t);
    return (p, f) => { f[0] += rnd(a[0], b[0]) * st; f[1] += rnd(a[1], b[1]) * st; f[2] += rnd(a[2], b[2]) * st; };
  },
  'twist around axis'(o, s) {
    const cp = s.cp(get(o, 'control point', 0)), amt = get(o, 'amount of force', 0), st = strength(o, s.t);
    let ax = o['twist axis'] ?? [0, 0, 1];
    if (o['object local space axis 0/1']) ax = toWorld(cp, ax);
    return (p, f) => {
      const r = [p.x - cp.pos[0], p.y - cp.pos[1], p.z - cp.pos[2]], t = cross(r, ax), l = Math.hypot(...t) || 1, m = (amt * st) / l;
      f[0] += t[0] * m; f[1] += t[1] * m; f[2] += t[2] * m;
    };
  },
};

const CONSTRAINT = {
  'Collision via traces'(o, s) {
    const bounce = get(o, 'amount of bounce', 0), slide = get(o, 'amount of slide', 0), trace = s.host.traceNormal;
    if (!trace) return null;
    return (p) => {
      const hit = trace([p.px, p.py, p.pz], [p.x, p.y, p.z]);
      if (!hit) return;
      const n = hit.normal, vx = p.x - p.px, vy = p.y - p.py, vz = p.z - p.pz, d = vx * n[0] + vy * n[1] + vz * n[2];
      p.x = hit.pos[0] + n[0] * 0.5; p.y = hit.pos[1] + n[1] * 0.5; p.z = hit.pos[2] + n[2] * 0.5;
      const tx = vx - n[0] * d, ty = vy - n[1] * d, tz = vz - n[2] * d;
      p.px = p.x - (tx * slide - n[0] * d * bounce); p.py = p.y - (ty * slide - n[1] * d * bounce); p.pz = p.z - (tz * slide - n[2] * d * bounce);
    };
  },
  'Constrain distance to path between two control points'() { return null; },
};

const LIST = (d, k) => d[k] || [];
export const RENDERERS = new Set(['render_animated_sprites', 'render_sprite_trail', 'render_rope']);

export class ParticleLibrary {
  constructor() { this.systems = new Map(); }
  add(text) { for (const [n, s] of parsePCF(text).systems) this.systems.set(n, s); }
  // Names reached from a root (children included)
  closure(name, seen = new Set()) {
    if (seen.has(name) || !this.systems.has(name)) return seen;
    seen.add(name);
    for (const c of LIST(this.systems.get(name), 'children')) if (c.child?.name) this.closure(c.child.name, seen);
    return seen;
  }
  // Function names in a closure the runtime doesn't implement
  unsupported(name) {
    const out = new Set();
    for (const n of this.closure(name)) {
      const d = this.systems.get(n);
      for (const o of LIST(d, 'initializers')) if (!INIT[o.functionName]) out.add('init:' + o.functionName);
      for (const o of LIST(d, 'operators')) if (!OP[o.functionName]) out.add('op:' + o.functionName);
      for (const o of LIST(d, 'forces')) if (!FORCE[o.functionName]) out.add('force:' + o.functionName);
      for (const o of LIST(d, 'constraints')) if (!CONSTRAINT[o.functionName]) out.add('constraint:' + o.functionName);
      for (const o of LIST(d, 'emitters')) if (!/^emit_(instantaneously|continuously)$/.test(o.functionName)) out.add('emit:' + o.functionName);
      for (const o of LIST(d, 'renderers')) if (!RENDERERS.has(o.functionName)) out.add('render:' + o.functionName);
    }
    return out;
  }
}

export class ParticleInstance {
  constructor(lib, def, host, cps, parent = null) {
    Object.assign(this, { lib, def, host, parent });
    this.cps = cps; // shared with children unless a child gets its own via setCP
    this.particles = [];
    this.t = 0; this.lastDt = 0; this.emitted = 0;
    this.stopped = false;
    this.force = [0, 0, 0]; this.forceFns = []; this.constraintFns = [];
    const col = def.color ?? [255, 255, 255, 255];
    this.base = { r: col[0] / 255, g: col[1] / 255, b: col[2] / 255, a: col[3] / 255, radius: def.radius ?? 5, rot: (def.rotation ?? 0) * D2R, rotSpeed: (def.rotation_speed ?? 0) * D2R, seq: def.sequence_number ?? 0, trail: def['trail_length'] ?? 0.1 };
    this.maxP = def.max_particles ?? 1000;
    this.emitters = LIST(def, 'emitters').map((o) => ({ o, done: 0, acc: 0 }));
    this.pending = def.initial_particles ?? 0;
    this.children = LIST(def, 'children').filter((c) => c.child?.name && lib.systems.has(c.child.name)).map((c) => ({ delay: c.delay ?? 0, name: c.child.name, inst: null }));
  }

  cp(n) { return this.cps[n] ?? this.cps[0]; }
  setCP(n, c) { const old = this.cps[n]; if (old) c.prev = old.pos; if (old?.entity !== undefined && c.entity === undefined) c.entity = old.entity; this.cps[n] = c; }
  // Follows the same semantics as ParticleSystem_StopEmission: no new particles, existing ones finish.
  stop() { this.stopped = true; for (const c of this.children) { c.inst?.stop(); c.stopped = true; } }

  _emit(n, dt) {
    const s = this.base, inits = LIST(this.def, 'initializers');
    for (let i = 0; i < n && this.particles.length < this.maxP; i++) {
      const p = { x: this.cps[0].pos[0], y: this.cps[0].pos[1], z: this.cps[0].pos[2], px: 0, py: 0, pz: 0, age: 0, life: 1, radius: s.radius, radius0: s.radius, a: s.a, a0: s.a, r: s.r, g: s.g, b: s.b, r0: s.r, g0: s.g, b0: s.b, rot: s.rot, rotSpeed: s.rotSpeed, seq: s.seq, trail: s.trail };
      p.px = p.x; p.py = p.y; p.pz = p.z;
      for (const o of inits) INIT[o.functionName]?.(o, p, this, dt || 1 / 60);
      this.particles.push(p);
      this.emitted++;
    }
  }

  _runEmitters(dt) {
    if (this.stopped) return;
    if (this.pending > 0) { this._emit(this.pending, dt); this.pending = 0; }
    for (const e of this.emitters) {
      const o = e.o, st = get(o, 'emission_start_time', 0);
      if (this.t < st) continue;
      if (o.functionName === 'emit_instantaneously') {
        if (e.count === undefined) { const hi = get(o, 'num_to_emit', 100), lo = get(o, 'num_to_emit_minimum', -1); e.count = lo >= 0 ? Math.floor(rnd(lo, hi + 1)) : hi; }
        if (e.done < e.count) {
          const cap = get(o, 'maximum emission per frame', -1), n = cap > 0 ? Math.min(cap, e.count - e.done) : e.count - e.done;
          this._emit(n, dt); e.done += n;
        }
      } else if (o.functionName === 'emit_continuously') {
        const dur = get(o, 'emission_duration', 0);
        if (dur > 0 && this.t - st > dur) continue;
        e.acc += get(o, 'emission_rate', 100) * dt;
        const n = Math.floor(e.acc);
        e.acc -= n;
        if (n > 0) this._emit(n, dt);
      }
    }
  }

  step(dt) {
    if (dt <= 0) return;
    this._runEmitters(dt);
    for (const p of this.particles) p.age += dt;
    this.forceFns = LIST(this.def, 'forces').filter((o) => FORCE[o.functionName]).map((o) => FORCE[o.functionName](o, this));
    this.constraintFns = LIST(this.def, 'constraints').map((o) => CONSTRAINT[o.functionName]?.(o, this)).filter(Boolean);
    for (const o of LIST(this.def, 'operators')) {
      const fn = OP[o.functionName];
      if (!fn) continue;
      const k = strength(o, this.t);
      if (k > 0) fn(o, this, dt, k);
    }
    if (this.particles.some((p) => p.dead)) this.particles = this.particles.filter((p) => !p.dead);
    for (const c of this.children) {
      if (!c.inst && !c.stopped && this.t >= c.delay) c.inst = new ParticleInstance(this.lib, this.lib.systems.get(c.name), this.host, this.cps, this);
      c.inst?.step(dt);
    }
    this.t += dt; this.lastDt = dt;
  }

  // Finished once nothing can emit and everything alive has gone
  get done() {
    if (this.particles.length) return false;
    for (const c of this.children) if (c.stopped ? c.inst && !c.inst.done : !c.inst || !c.inst.done) return false;
    if (this.stopped) return true;
    for (const e of this.emitters) {
      const o = e.o;
      if (o.functionName === 'emit_instantaneously') { if (e.count === undefined || e.done < e.count) return false; } else { const dur = get(o, 'emission_duration', 0); if (dur === 0 || this.t - get(o, 'emission_start_time', 0) <= dur) return false; }
    }
    return this.pending <= 0;
  }

  * visit() { yield this; for (const c of this.children) if (c.inst) yield* c.inst.visit(); }
}
