// Jiggle bones: capes and mask hair. Rules read from client.dll [1801d3400]; the parameters are the model's own.
// Matrices are flat 3x4 rows. A bone hangs along its Z axis: columns are left, up, forward, position.
const FLEXIBLE = 0x01, YAW = 0x04, PITCH = 0x08, ANGLE = 0x10, LENGTH = 0x20;
const PROC_JIGGLE = 5, BONE_SIZE = 216;
const STEP = 1 / 120, MAX_DT = 0.0333, MIN_DT = 0.001, RESET_AFTER = 0.5, SANITY_DOT = -0.9;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mix = (a, ka, b, kb) => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];

/**
 * mstudiojigglebone_t for each bone that has one
 * @param {Model} model The model.
 * @returns {Map<number, object>} Bone index to its jiggle parameters.
 */
export function jiggleInfo(model) {
  const { dv } = model, out = new Map(), table = dv.getInt32(160, true);
  model.bones.forEach((_, i) => {
    const o = table + i * BONE_SIZE;
    if (dv.getInt32(o + 164, true) !== PROC_JIGGLE) return;
    const q = o + dv.getInt32(o + 168, true), f = (k) => dv.getFloat32(q + k, true);
    out.set(i, {
      flags: dv.getInt32(q, true), length: f(4), tipMass: f(8),
      yawStiffness: f(12), yawDamping: f(16), pitchStiffness: f(20), pitchDamping: f(24), alongStiffness: f(28), alongDamping: f(32),
      angleLimit: f(36), minYaw: f(40), maxYaw: f(44), yawFriction: f(48), minPitch: f(56), maxPitch: f(60), pitchFriction: f(64),
    });
  });
  return out;
}

/**
 * The simulated state of one model's jiggle bones.
 */
export class JiggleBones {
  /**
   * @param {Map<number, object>} info From jiggleInfo.
   */
  constructor(info) { this.info = info; this.state = new Map(); }

  /**
   * The bone's matrix this frame, given where its parent and rest pose would put it
   * @param {number} bone Bone index.
   * @param {number} now Time in seconds.
   * @param {number[]} goal Where its parent and rest pose would put it.
   * @returns {number[]} The 3x4 matrix.
   */
  update(bone, now, goal) {
    const j = this.info.get(bone);
    const left = [goal[0], goal[4], goal[8]], up = [goal[1], goal[5], goal[9]], fwd = [goal[2], goal[6], goal[10]], base = [goal[3], goal[7], goal[11]];
    const goalTip = add(base, fwd, j.length);
    let s = this.state.get(bone);
    const reset = () => { s = { last: now, tip: goalTip, vel: [0, 0, 0], acc: [0, 0, 0] }; this.state.set(bone, s); };
    if (!s || now - s.last > RESET_AFTER) reset();
    // cl_jiggle_bone_sanity: never let a tip point straight away from its goal
    else if (dot(unit([goalTip[0] - base[0], goalTip[1] - base[1], goalTip[2] - base[2]]), unit([s.tip[0] - base[0], s.tip[1] - base[1], s.tip[2] - base[2]])) < SANITY_DOT) reset();
    const elapsed = now - s.last;
    const dt = elapsed < MIN_DT ? MIN_DT : Math.min(elapsed, MAX_DT);
    s.last = now;

    if (j.flags & FLEXIBLE) {
      // Gravity goes in once a frame and the spring forces build up over the substeps; all of it clears afterwards
      s.acc[2] -= j.tipMass;
      for (let left_ = dt; left_ > 0; left_ -= STEP) {
        const h = Math.min(left_, STEP);
        const err = [goalTip[0] - s.tip[0], goalTip[1] - s.tip[1], goalTip[2] - s.tip[2]];
        const yaw = j.yawStiffness * dot(left, err) - j.yawDamping * dot(left, s.vel);
        const pitch = j.pitchStiffness * dot(up, err) - j.pitchDamping * dot(up, s.vel);
        s.acc = add(add(s.acc, left, yaw), up, pitch);
        if (!(j.flags & LENGTH)) s.acc = add(s.acc, fwd, j.alongStiffness * dot(fwd, err) - j.alongDamping * dot(fwd, s.vel));
        s.vel = add(s.vel, s.acc, h);
        s.tip = add(s.tip, s.vel, h);
      }
      s.acc = [0, 0, 0];
      if (j.flags & YAW) this._limit(s, base, fwd, left, up, j.minYaw, j.maxYaw, j.yawFriction);
      if (j.flags & PITCH) this._limit(s, base, fwd, up, left, j.minPitch, j.maxPitch, j.pitchFriction);
      if (j.flags & ANGLE) this._cone(s, base, fwd, j.angleLimit);
    }

    const along = [s.tip[0] - base[0], s.tip[1] - base[1], s.tip[2] - base[2]];
    const forward = unit(along);
    if (j.flags & LENGTH) {
      s.vel = add(s.vel, forward, -dot(s.vel, forward));
      s.tip = add(base, forward, j.length);
    }
    const l = unit(cross(up, forward)), u = cross(forward, l);
    return [l[0], u[0], forward[0], base[0], l[1], u[1], forward[1], base[1], l[2], u[2], forward[2], base[2]];
  }

  // Keeps the tip inside an angular range in the plane of `axis` and forward: past the limit it's clipped onto the
  // limit's plane and loses its velocity through that plane; friction slows it from the next frame on.
  _limit(s, base, fwd, axis, other, min, max, friction) {
    const along = [s.tip[0] - base[0], s.tip[1] - base[1], s.tip[2] - base[2]];
    const a = Math.atan2(dot(axis, along), dot(fwd, along));
    if (a >= min && a <= max) return;
    const lim = a < min ? min : max, sn = Math.sin(lim), cs = Math.cos(lim);
    const limitAxis = mix(axis, cs, fwd, -sn), limitFwd = mix(axis, sn, fwd, cs);
    s.tip = add(add(base, other, dot(other, along)), limitFwd, dot(limitFwd, along));
    s.vel = add(s.vel, limitAxis, -dot(limitAxis, s.vel));
    s.acc = add(s.acc, s.vel, -friction);
  }

  /**
   * Keeps the tip inside a cone around forward, removing its velocity through the cone's surface.
   * @param {object} s The bone's state.
   * @param {number[]} base The bone's position.
   * @param {number[]} fwd The bone's goal direction.
   * @param {number} limit The cone's half angle in radians.
   */
  _cone(s, base, fwd, limit) {
    const along = [s.tip[0] - base[0], s.tip[1] - base[1], s.tip[2] - base[2]], len = Math.hypot(along[0], along[1], along[2]) || 1;
    const dir = [along[0] / len, along[1] / len, along[2] / len];
    if (dot(dir, fwd) >= Math.cos(limit)) return;
    const side = unit(add(dir, fwd, -dot(dir, fwd)));
    const onCone = mix(fwd, Math.cos(limit), side, Math.sin(limit)), normal = mix(fwd, -Math.sin(limit), side, Math.cos(limit));
    s.tip = add(base, onCone, len);
    s.vel = add(s.vel, normal, -dot(normal, s.vel));
  }
}
