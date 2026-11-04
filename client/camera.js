// The third person camera. A port of client.dll's camera class at 180784778; its driver is 18027ff00, and the steps run in
// that order. Each one takes the view and moves it, so the options menu's sliders act on exactly what they do in the game.
import { angleVectors, angleNorm, sub, add, scale, dot, len } from '/shared/mathx.js';
import { cvar } from './settings.js';

const FLT_MAX = 3.4028234663852886e+38;
const pre = 'bb_cam_thirdperson_';
const cam = (name) => cvar(pre + name);
// [R 18027f425, 18027edf4] every trace here sweeps this box, against this mask
const HULL_MIN = [-7, -7, -5], HULL_MAX = [7, 7, 5], MASK = 0x210400b;
// [R 18027fa94] Bias(x, 0.65) as a power
const EVADE_BIAS = Math.log(0.65) / Math.log(0.5);
const approach = (from, to, step) => { const d = to - from; return d > step ? from + step : d < -step ? from - step : to; };

/**
 * One fighter's view: it keeps the smoothing state the game keeps on the camera object.
 */
export class ThirdPersonCamera {
  /**
   * @param {function(number[], number[], number[], number[], number): object} trace Sweeps a box through the world.
   */
  constructor(trace) { this.trace = trace; this.reset(); }

  /** [R 18027fe80] As the camera takes over. */
  reset() {
    this.evading = false; this.evadeT = 0; this.evadeDur = 0; this.evadeFrom = [0, 0, 0]; this.evadeFwd = [1, 0, 0];
    this.air = [0, 0, 0]; this.ground = [0, 0, 0]; this.groundW = 0;
    this.bank = 0; this.lastYaw = 0;
    this.body = [0, 0, cam('body_center_z')];
    this.floor = 56789;
    this.lagged = [0, 0, FLT_MAX];
  }

  /**
   * [R 18027fda0] What the mouse can reach
   * @param {number} pitch The view's pitch.
   * @returns {number} Clamped.
   */
  clampPitch(pitch) { return Math.max(cam('pitch_min'), Math.min(cam('pitch_max'), pitch)); }

  /**
   * [R 18027fdd0, 18027a0f0] What the fighter aims at, and what goes to the server, from the view this camera ended up on.
   * @param {number[]} angles The view it returned.
   * @returns {number[]} Pitch and yaw.
   */
  aim(angles) { return [angles[0] + cam('pitch_viewoffset'), angles[1] + cam('yaw_offset')]; }

  /**
   * [R 18027f330] Offsets from the eye, stopping at a wall.
   * @param {number[]} p The view's position.
   * @returns {number[]} Moved.
   */
  offsets(p) {
    return this.trace(p, [p[0] + cam('x_offset'), p[1] + cam('y_offset'), p[2] + cam('z_offset')], HULL_MIN, HULL_MAX, MASK).endpos;
  }

  /**
   * [R 18027f940] A roll or shuffle moves fast, so the view starts from where it was and eases over to the fighter, the more so
   * the more the move lies along the view.
   * @param {object} s This frame's state.
   * @param {number[]} eye The eye, before anything.
   * @param {number[]} p The view's position.
   * @param {number[]} angles The view.
   * @returns {number[]} Moved.
   */
  evade(s, eye, p, angles) {
    const roll = s.action === 'Roll', on = roll || s.action === 'Shuffle';
    if (on !== this.evading) {
      if (on) {
        this.evadeFrom = [...p];
        this.evadeFwd = angleVectors([0, s.yaw, 0]).forward;
        this.evadeT = this.evadeDur = cam(!roll ? 'shuffle_time' : (s.dir & ~2) === 0 ? 'roll_fwd_time' : 'roll_time');
      }
      this.evading = on;
    }
    if (this.evadeT <= 0) return p;
    const k = Math.abs(dot(angleVectors(angles).forward, this.evadeFwd));
    // [R 180515270] Hermite_Spline(0, 0, 1, t)
    const t = Math.pow(this.evadeT / this.evadeDur, EVADE_BIAS), h = 2 * t * t - t * t * t;
    this.evadeT -= s.dt;
    return add(p, scale(sub(this.evadeFrom, eye), h * k));
  }

  /**
   * [R 18027f570] In the air the view trails the fall and tips with it.
   * @param {object} s This frame's state.
   * @param {number[]} p The view's position.
   * @param {number[]} angles The view, changed in place.
   * @returns {number[]} Moved.
   */
  jump(s, p, angles) {
    const v = s.onGround ? [0, 0, 0] : [s.vel[0], s.vel[1], s.hitstop ? 0 : s.vel[2]];
    const k = Math.min(1, cam('jump_speed') * s.dt);
    this.air = this.air.map((a, i) => a + (v[i] - a) * k);
    const xy = cam('jump_scale_xy');
    angles[0] = Math.max(cam('jump_pitch_min'), Math.min(cam('jump_pitch_max'), angles[0] + cam('jump_angle_scale') * this.air[2]));
    return [p[0] - this.air[0] * xy, p[1] - this.air[1] * xy, p[2] - this.air[2] * cam('jump_scale_z')];
  }

  /**
   * [R 18027fba0] On the ground the view leads the run and widens a little, except during a roll or shuffle.
   * @param {object} s This frame's state.
   * @param {number[]} p The view's position.
   * @param {number} fov Field of view.
   * @returns {{p: number[], fov: number}} Both moved.
   */
  run(s, p, fov) {
    this.groundW = approach(this.groundW, s.action === 'Roll' || s.action === 'Shuffle' ? 0 : 1, cam('ground_offset_weight_speed') * s.dt);
    const v = s.onGround ? s.vel : [0, 0, 0], k = Math.min(1, cam('ground_speed') * s.dt);
    this.ground = this.ground.map((g, i) => g + (v[i] - g) * k);
    const m = Math.min(1, Math.hypot(this.ground[0], this.ground[1]) / cam('ground_fov_maxspeed'));
    return { p: add(p, scale(this.ground, cam('ground_scale_xy') * this.groundW)), fov: fov + m * cam('ground_fov_add') * this.groundW };
  }

  /**
   * [R 18027f0a0] Turning during an action leans the view.
   * @param {object} s This frame's state.
   * @param {number[]} angles The view, before anything, for the turn.
   * @returns {number} Degrees of roll to add.
   */
  roll(s, angles) {
    let want = angleNorm(angles[1] - this.lastYaw) * (0.01 / Math.max(s.dt, 1e-4));
    this.lastYaw = angles[1];
    if (!s.action) want = 0;
    const d = want - this.bank;
    if (Math.abs(d) > 0.01) this.bank += Math.min(1, cam('bank_speed') * s.dt) * Math.sign(d) * Math.max(Math.abs(d), 0.1);
    else this.bank = want;
    return this.bank * cam('bank_scale');
  }

  /**
   * [R 18027f1b0, client 1802c2721] The view rides the "chest" attachment, by what bb_cam_thirdperson_body_scale says.
   * @param {object} s This frame's state.
   * @param {number[]} p The view's position.
   * @returns {number[]} Moved.
   */
  bodyMotion(s, p) {
    if (!s.chest) return p;
    const want = s.alive ? s.chest : [0, 0, 8], k = Math.min(1, cam('body_speed') * s.dt);
    this.body = this.body.map((b, i) => b + (want[i] - b) * k);
    const c = cam('body_scale');
    return [p[0] + this.body[0] * c, p[1] + this.body[1] * c, p[2] + (this.body[2] - cam('body_center_z')) * c];
  }

  /**
   * [R 18027f6e0] The slider: 0 is off, and past that the view trails, up to bb_cam_thirdperson_lag_max.
   * @param {object} s This frame's state.
   * @param {number[]} p The view's position.
   * @returns {number[]} Moved.
   */
  lag(s, p) {
    const speed = cam('lag_speed');
    if (speed <= 0) { this.lagged = [...s.o]; return p; }
    if (this.lagged[2] === FLT_MAX) this.lagged = [...s.o];
    const d = sub(s.o, this.lagged), l = len(d), max = cam('lag_max'), rate = 10 - Math.min(speed, 1) * 7;
    let keep = max;
    if (l <= max + 0.1) {
      if (Math.abs(l - max) <= 0.01) keep = 0;
      else { const step = rate * s.dt * l; keep = l > step ? l - step : 0; }
    }
    const off = l > 0 ? scale(d, keep / l) : [0, 0, 0];
    this.lagged = sub(s.o, off);
    return sub(p, off);
  }

  /**
   * One frame.
   * @param {object} s This frame's state: dt, o (origin), vel, yaw (body), onGround, action, dir, hitstop, alive, chest (from the origin).
   * @param {number[]} viewAngles Pitch and yaw the mouse has set.
   * @returns {{eye: number[], angles: number[], fov: number}} The view.
   */
  update(s, viewAngles) {
    // [I] the default view vector's 64: nothing here read the fighter's own, and Source's table says 64
    const eye = [s.o[0], s.o[1], s.o[2] + 64];
    const angles = [viewAngles[0], viewAngles[1], 0];
    const roll = this.roll(s, angles);
    let p = this.offsets(eye);
    p = this.evade(s, eye, p, angles);
    p = this.jump(s, p, angles);
    const run = this.run(s, p, cvar('fov_desired'));
    p = run.p;
    if (s.hitstop) p = add(p, scale(angleVectors(angles).forward, cam('hitstop_push_fwd'))); // [R 18027f4f0]
    angles[2] = roll;
    p = this.bodyMotion(s, p);
    p = this.lag(s, p);
    return { eye: this.place(s, p, angles), angles, fov: run.fov };
  }

  /**
   * [R 28014a] Backs off along the view. The floor under the fighter, with its height eased, holds the camera up by turning
   * the line it backs along toward it, and the first wall stops it.
   * @param {object} s This frame's state.
   * @param {number[]} p Where the view looks from, before backing off.
   * @param {number[]} angles The view.
   * @returns {number[]} The camera's position.
   */
  place(s, p, angles) {
    const dist = cam('distance_ideal');
    let dir = angleVectors(angles).forward;
    const down = this.trace([s.o[0], s.o[1], s.o[2] + 10], [s.o[0], s.o[1], s.o[2] - 1024], HULL_MIN, HULL_MAX, MASK);
    const floor = down.startsolid ? s.o[2] : down.endpos[2];
    this.floor = Math.abs(floor - this.floor) > 350 ? floor : approach(this.floor, floor, 350 * s.dt);
    const end = sub(p, scale(dir, dist));
    if (end[2] < this.floor) {
      const d = [p[0] - end[0], p[1] - end[1], p[2] - this.floor], l = len(d);
      if (l > 0) dir = scale(d, 1 / l);
    }
    // [R 180280410] a start inside something moves up the line and tries again, up to ten times. The game knows how far along it
    // came out. [I] here each try steps a tenth along.
    let from = p, left = dist;
    for (let i = 0; i < 10; i++) {
      const tr = this.trace(from, sub(from, scale(dir, left)), HULL_MIN, HULL_MAX, MASK);
      if (tr.allsolid) return from;
      if (!tr.startsolid) return tr.endpos;
      from = sub(from, scale(dir, left * 0.1));
      left *= 0.9;
    }
    return p;
  }
}
