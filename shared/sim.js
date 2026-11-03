// Authoritative duel simulation. Provenance of each rule is noted as:
//   [R addr]   recovered from server.dll at addr
//   [V]        verified port (combat.js, bit-identical to the C++/server.dll tests)
//   [I]        inferred: plausible behaviour, not yet confirmed against the binary
import * as C from './combat.js';
import { actionId, STANCE_KEYS } from './gamedata.js';
import { angleVectors, add, sub, scale, dot, cross, len, norm, entityMatrix, angleNorm, approachAngle, matPoint } from './mathx.js';
import { MASK_PLAYERSOLID } from './bsp.js';

export const TICK = 1 / 66;
export const IN = { ATTACK: 1, JUMP: 2, ROLL: 4, FORWARD: 8, BACK: 0x10, LEFT: 0x200, RIGHT: 0x400, GRAB: 0x20000, WALK: 0x40000, SHUFFLE: 0x400000, BLOCK: 0x800000, STANCE_FAST: 0x2000000, STANCE_BAL: 0x4000000, STANCE_HEAVY: 0x8000000 };
const HULL_MIN = [-13, -13, 0], HULL_MAX = [13, 13, 72];
const STEP = 18, BLADE_CLASH_DIST = 8;
// [I] forward/side input the charge dampen scales. cl_forwardspeed defaults to 450, but that hits the speed cap almost
// at once, leaving charge progress no effect and running faster than players report, so this uses sv_maxspeed's 175.
const CHARGE_INPUT = 175;
const num = (v, d = 0) => { const f = parseFloat(v); return Number.isNaN(f) ? d : f; };
const flag = (v) => v !== undefined && v !== '0' && String(v).toLowerCase() !== 'false';

export class Cvars {
  constructor(table) { this.t = table; this.c = new Map(); }
  f(name) { let v = this.c.get(name); if (v === undefined) { v = parseFloat(this.t[name]?.default ?? '0'); this.c.set(name, v); } return v; }
}

// ---------------------------------------------------------------------- player
export class Player {
  constructor(id, name, character) {
    Object.assign(this, { id, name, character, isBot: false, connected: true });
    this.score = 0;
    this.stance = 0;
    this.reset([0, 0, 0], 0);
  }

  reset(origin, yaw) {
    Object.assign(this, {
      origin: [...origin], vel: [0, 0, 0], yaw, viewYaw: yaw, pitch: 0, onGround: false,
      health: 100, alive: true, act: null, hitstop: 0, buttons: 0, prevButtons: 0,
      jumpCooldown: 0, jumpGravityT: 0, comboIdx: 0, comboIdxTime: 0, comboCount: 0, comboResetTime: 0,
      hitsThisSwing: 0, lastHitTime: -100, multiBlock: 0, turnRate: 0, turnRateTime: 0, blockCooldown: 0,
      moveCooldown: 0, animTime: 0, moveAmt: 0, frozen: false, forceImpulse: null,
      kneeling: false, airState: 0, airT: 0, landT: 0, landCycle: 0, airLandCycle: 0, moveCycle: 0, moveSeq: null, chargeCycle: 0, chargeFade: 0, chargeRun: 0, chargeAnims: null,
    });
  }

  get pressed() { return this.buttons & ~this.prevButtons; }
  isAttacking() { return !!this.act?.attack; }
  isSwinging() { return !!(this.act?.attack && this.act.phase === 'swing'); }
}

// ---------------------------------------------------------------------- world
export class World {
  constructor({ bsp, data, cvars, assets, map = '' }) {
    Object.assign(this, { bsp, data, cv: cvars, assets, map });
    this.time = 0;
    this.tickCount = 0;
    this.players = [];
    this.events = [];
    this.bladeCache = new Map();
    this.duel = new Duel(this);
  }

  emit(e) { this.events.push({ ...e, time: this.time }); }
  player(id) { return this.players.find((p) => p.id === id); }

  addPlayer(p) { this.players.push(p); this.duel.onPlayersChanged(); }
  removePlayer(id) { this.players = this.players.filter((p) => p.id !== id); this.duel.onPlayersChanged(); }

  step() {
    this.time += TICK; this.tickCount++;
    this.duel.update();
    for (const p of this.players) { if (p.isBot && p.brain) p.brain(p, this); }
    for (const p of this.players) this.tickPlayer(p);
    this.softCollide();
    for (const p of this.players) p.prevButtons = p.buttons;
  }

  // -------------------------------------------------------------------- per player
  tickPlayer(p) {
    const dt = TICK;
    if (p.onGround) p.jumpCooldown = Math.max(0, p.jumpCooldown - dt); // [R 18036f7d0]
    p.blockCooldown = Math.max(0, p.blockCooldown - dt);
    p.moveCooldown = Math.max(0, p.moveCooldown - dt);
    p.turnRateTime = Math.max(0, p.turnRateTime - dt);
    // [R 18037aa00] both fighters freeze during hitstop; [R 180388b60] the multi-hit timer doesn't count it
    if (p.hitstop > 0) { p.hitstop -= dt; p.lastHitTime += dt; return; }
    p.animTime += dt;
    if (p.alive && !p.frozen) { this.updateAction(p); this.dispatchInput(p); } else if (!p.alive) this.updateAction(p);
    this.updateYaw(p, dt);
    this.move(p, dt);
    this.advanceAnim(p);
    if (p.isSwinging() && !p.frozen) this.updateTracer(p);
  }

  // [R 180379df0] input priority order: current action update, shuffle, grab, roll, block, attack.
  // Shuffle, grab and roll read the held button, so holding one repeats it once its delay runs out.
  dispatchInput(p) {
    const pr = p.pressed;
    // stance change only outside attacks [I]
    if (!p.isAttacking()) {
      if (pr & IN.STANCE_BAL) this.setStance(p, 0);
      if (pr & IN.STANCE_FAST) this.setStance(p, 1);
      if (pr & IN.STANCE_HEAVY) this.setStance(p, 2);
    }
    if (p.kneeling) { this.dispatchKneeling(p); return; }
    if ((p.buttons & IN.SHUFFLE) && this.canEvade(p)) { this.startEvade(p, 'Shuffle'); return; }
    if ((p.buttons & IN.GRAB) && this.canGrab(p)) { this.startAction(p, 'Grab', { force: true, extra: { grabDone: false } }); return; }
    if (p.act && !this.canCancel(p)) return;
    if ((p.buttons & IN.ROLL) && this.canEvade(p)) { this.startEvade(p, 'Roll'); return; }
    // [R 180374d80] +block requires ground, no attack in progress and the post-attack cooldown elapsed
    if ((p.buttons & IN.BLOCK) && p.onGround && !p.isAttacking() && !p.blockCooldown && !p.act) {
      this.startAction(p, this.blockActionName(p), { dir: this.moveDir(p) });
      return;
    }
    if ((pr & IN.ATTACK) && !p.isAttacking()) this.startAttack(p);
  }

  // [R 180379df0, 18037b510] downed: jump gets up, block is the recovery intercept (also late in a roll),
  // attack is the recovery attack and a held move key rolls that way
  dispatchKneeling(p) {
    const a = p.act, b = p.buttons;
    if (!a || (a.kind === 'kneelroll' && a.lock <= 0.2)) {
      if (b & IN.JUMP) { p.kneeling = false; this.startAction(p, 'KneelingRecover', { force: true }); return; }
      if (b & IN.BLOCK) { this.startAction(p, 'KneelParry', { force: true }); return; }
    }
    if (a) return;
    if (p.pressed & IN.ATTACK) this.startAttack(p);
    else if (b & (IN.FORWARD | IN.BACK | IN.LEFT | IN.RIGHT)) this.startAction(p, 'KneelRoll', { dir: this.moveDir(p) });
  }

  // [R 180376fc0, 180379df0] needs the ground, no active lock and the shared combat-move delay elapsed
  canEvade(p) {
    const a = p.act;
    return p.onGround && p.moveCooldown <= 0 && !(a && (a.kind === 'block' || a.lock > 0));
  }

  // [R 180378f10] the next shuffle or roll waits for the shorter of sequence and lock, plus 0.2s
  startEvade(p, name) {
    const a = this.startAction(p, name, { dir: this.moveDir(p), force: true });
    if (a) p.moveCooldown = Math.min(a.dur, a.lockDur) + 0.2;
  }

  // [R 1803750d0] a grab can also replace a block or an attack that is still charging
  canGrab(p) {
    const a = p.act;
    return p.onGround && (!a || a.lock <= 0 || a.kind === 'block' || (a.attack && a.phase === 'charge'));
  }

  blockActionName(p) {
    // blockTech from the sword type [R 180374d80]: 0 Block, 1 Parry, 2 Guard. "block" is the default sword's tech.
    const tech = (this.sword(p).blocktech || 'block').toLowerCase();
    return tech === 'parry' ? 'Parry' : tech === 'guard' ? 'Guard' : 'Block';
  }

  canCancel(p) {
    const a = p.act;
    if (a.locked === false) return true;
    return a.lock <= 0;
  }

  // [R 180374910] direction: 0 forward, 1 right, 2 back, 3 left
  moveDir(p) {
    const b = p.buttons, l = b & IN.LEFT, r = b & IN.RIGHT;
    if (!l && r) return 1;
    if (l && !r) return 3;
    if (b & IN.FORWARD) return 0;
    return b & IN.BACK ? 2 : 0;
  }

  setStance(p, s) {
    if (p.stance !== s) { p.stance = s; this.emit({ type: 'stance', id: p.id, stance: s }); }
  }

  setTurnRate(p, speed, dur) { p.turnRate = speed; p.turnRateTime = dur; }

  // -------------------------------------------------------------------- actions
  actionAnim(def, dir) {
    const a = def.animation;
    if (a && typeof a === 'object') {
      const key = ['forward', 'right', 'back', 'left'][dir] || 'forward';
      return a[key] || a.forward || a.right || a.left || a.falling || Object.values(a)[0];
    }
    return a;
  }

  char(p) { return this.assets.character(p.character); }
  sword(p) { return this.data.swordFor(p.character, p.sword); }

  seqInfo(p, activity) {
    const c = this.char(p);
    const seq = activity ? c.seqForActivity(activity) : null;
    return { seq, dur: seq ? c.seqDuration(seq) : 0 };
  }

  // [R 180344950] CAction start: lock_duration from script; negative or missing uses the sequence length
  startAction(p, name, opts = {}) {
    const def = this.data.action(name);
    if (!def) return null;
    if (p.act && !opts.force && !this.canCancel(p)) return null;
    const dir = opts.dir ?? 0;
    const anim = opts.anim ?? this.actionAnim(def, dir);
    const { seq, dur } = this.seqInfo(p, anim);
    let lock = opts.lock ?? num(def.lock_duration, -1);
    if (lock < 0) lock = dur;
    p.act = {
      id: actionId(name), name, def, anim, seq, dur, lock, lockDur: lock, t: 0, dir, cycle: 0,
      moveLock: flag(def.move_lock), animMove: flag(def.animation_move), rotLock: flag(def.rotation_lock),
      rotSpeed: num(def.rotation_speed, 0), moveScale: num(def.move_scale, 1), runScale: num(def.runspeedscale, 1),
      parryWindow: num(def.parry_window, 0), kind: String(def.factoryclass || '').toLowerCase(), ...opts.extra,
    };
    this.emit({ type: 'action', id: p.id, name: p.act.name });
    return p.act;
  }

  // [R 180374910] picks the attack from stance/direction/combo index, then CAttackAction charges
  startAttack(p) {
    let stance = p.stance;
    const airborne = !p.onGround && this.heightAboveGround(p) > this.cv.f('bb_air_stance_height_min');
    if (airborne) stance = 3;
    const dir = this.moveDir(p);
    if (this.time - p.comboIdxTime > this.cv.f('bb_combo_reset_time')) p.comboIdx = 0; // [I] combo string reset timing
    const def = p.kneeling ? this.data.action('RecoveryAttack') : this.data.attackFor(p.character, stance, dir, p.comboIdx);
    if (!def) return;
    p.hitsThisSwing = 0;
    p.lastHitTime = -100; // [R 1803744c0] every attack starts with its multi-hit timer clear
    const chargeTime = this.cv.f('bb_charge_tier3_time') * num(this.sword(p).chargetime, 1);
    p.act = {
      id: 39, name: def.name, def, attack: true, phase: 'charge', stanceType: stance, dir, tier: 0, t: 0, chargeTotal: chargeTime, lock: chargeTime, lockDur: chargeTime,
      anim: def.charge_animation, seq: this.seqInfo(p, def.charge_animation).seq, dur: 0, cycle: 0, moveLock: false, animMove: false, rotLock: false, rotSpeed: 0,
      moveScale: 1, runScale: 1, kind: 'attack', chargeTier: 0, landed: false,
      tracerIdx: 0, bladeRing: [],
    };
    this.emit({ type: 'attack_started', id: p.id, dir });
    // the recovery attack skips the charge and always swings at tier 3, and it stands you up
    if (p.kneeling) { p.kneeling = false; this.releaseAttack(p, 2); }
  }

  // [R 180346a70] release: tier from elapsed charge, animation/lock from the tierN block; lock <= seq + 0.2
  releaseAttack(p, forceTier) {
    const a = p.act, cv = this.cv;
    const mult = num(this.sword(p).chargetime, 1);
    const held = a.t;
    let tier = 0;
    if (held >= cv.f('bb_charge_tier3_time') * mult) tier = 2; else if (held >= cv.f('bb_charge_tier2_time') * mult) tier = 1;
    if (forceTier !== undefined) tier = forceTier;
    const tierDef = a.def['tier' + (tier + 1)] || a.def.tier1 || {};
    const anim = tierDef.animation;
    const { seq, dur } = this.seqInfo(p, anim);
    let lock = num(tierDef.lock_duration, dur);
    lock = Math.min(lock, dur + 0.2);
    Object.assign(a, {
      phase: 'swing', tier, tierDef, anim, seq, dur, t: 0, lock, lockDur: lock, cycle: 0,
      moveLock: flag(tierDef.move_lock ?? a.def.move_lock), animMove: flag(a.def.animation_move), rotLock: flag(tierDef.rotation_lock ?? a.def.rotation_lock),
      rotSpeed: num(a.def.rotation_speed, 0), moveScale: num(tierDef.move_scale ?? a.def.move_scale, 1),
      runScale: num(tierDef.runspeedscale, 1), damage: num(tierDef.damage, 10), kbScale: num(tierDef.knockback_scale ?? a.def.knockback_scale, 1),
      tracer: this.data.tracers[p.character]?.[String(anim).toUpperCase()] || [], tracerIdx: 0, prevCycle: 0,
    });
    p.blockCooldown = lock + cv.f('bb_block_post_attack_cooldown');
    p.comboIdx = (p.comboIdx + 1) % 3;
    p.comboIdxTime = this.time;
    this.emit({ type: 'swing', id: p.id, tier, stance: a.stanceType, dir: a.dir });
  }

  updateAction(p) {
    const a = p.act;
    if (!a) return;
    a.t += TICK;
    a.lock -= TICK;
    if (a.attack && a.phase === 'charge') {
      // [R 180345cf0] release when the button is up or the charge timer runs out
      if (!(p.buttons & IN.ATTACK) || a.lock <= 0 || this.cv.f('bb_nocharge')) this.releaseAttack(p);
      else {
        const t = a.t, m = num(this.sword(p).chargetime, 1);
        const ct = t >= this.cv.f('bb_charge_tier3_time') * m ? 2 : t >= this.cv.f('bb_charge_tier2_time') * m ? 1 : 0;
        if (ct !== a.chargeTier) { a.chargeTier = ct; this.emit({ type: 'charge_tier', id: p.id, tier: ct }); }
      }
      return;
    }
    if (a.dur > 0) { a.prevCycle = a.cycle; a.cycle = !a.attack && a.seq?.flags & 1 ? (a.t / a.dur) % 1 : Math.min(1, a.t / a.dur); }
    if (a.kind === 'grab') this.updateGrab(p);
    if (a.kind === 'thrown') this.updateThrown(p);
    if (p.act !== a) return;
    // block is held while the button is down [R 18034b3a0 family; hold semantics I]
    if (a.kind === 'block' && (p.buttons & IN.BLOCK) && a.lock <= 0) { a.lock = 0.0001; return; }
    if (a.lock <= 0 && p.alive) {
      if (a.kind === 'kill') return;
      p.act = null;
      if (a.attack) p.moveCooldown = this.cv.f('bb_shuffle_postattack_delay'); // [R 1803457e0]
      if (a.kind === 'thrown') this.startAction(p, 'KneelingFalling', { force: true }); // [R 18034d460]
      else if (a.kind === 'kneelingfalling') p.kneeling = true; // [R 18034c2a0]
    }
  }

  // -------------------------------------------------------------------- yaw
  updateYaw(p, dt) {
    if (p.frozen) return; // facing stays on the spawn until the round starts
    const a = p.act;
    let rate = 0;
    if (a) {
      if (a.rotLock && a.lock > 0) rate = 1e-6;
      else if (a.rotSpeed > 0) rate = a.rotSpeed;
      else if (a.attack) rate = num(this.data.stanceFor(p.character, a.stanceType)?.rotationspeed, 180);
    }
    if (p.turnRateTime > 0) rate = rate ? Math.min(rate, p.turnRate) : p.turnRate;
    if (rate > 0) p.yaw = approachAngle(p.viewYaw, p.yaw, rate * dt); else p.yaw = p.viewYaw;
  }

  // -------------------------------------------------------------------- movement (CBerimbauGameMovement)
  move(p, dt) {
    const cv = this.cv, a = p.act;
    const locked = p.frozen || !p.alive || p.kneeling || (a && a.moveLock && a.lock > 0);
    // wish direction, relative to the camera
    const { forward: f0, right: r0 } = angleVectors([0, p.viewYaw, 0]);
    let fm = 0, sm = 0;
    if (!locked) {
      if (p.buttons & IN.FORWARD) fm += 1;
      if (p.buttons & IN.BACK) fm -= cv.f('sv_backspeed');
      if (p.buttons & IN.RIGHT) sm += 1;
      if (p.buttons & IN.LEFT) sm -= 1;
    }
    let speed = cv.f('sv_maxspeed');
    if (a?.runScale && !locked) speed *= a.runScale;
    const charging = a?.attack && a.phase === 'charge';
    if (p.buttons & IN.WALK) speed *= cv.f('bb_movement_walkspeed_multiplier');
    let wish = [f0[0] * fm + r0[0] * sm, f0[1] * fm + r0[1] * sm, 0];
    let wl = Math.hypot(wish[0], wish[1]);
    let wishSpeed = wl > 0 ? Math.min(wl, 1) * speed : 0;
    // [R 18036f380] charging scales the move input by bb_chargeaccel_dampen
    if (charging && wl > 0) wishSpeed = Math.min(CHARGE_INPUT * wl * cv.f('bb_chargeaccel_dampen'), speed);
    if (wl > 0) wish = [wish[0] / wl, wish[1] / wl, 0];
    p.moveAmt = wishSpeed;

    this.gravity(p, dt);
    // [R 18036e190] jump: flat force + directional punch, gravity curve afterwards
    if ((p.buttons & IN.JUMP) && !(p.prevButtons & IN.JUMP) && p.onGround && !p.jumpCooldown && !locked && !a) {
      const dir = wl > 0 ? wish : [0, 0, 0];
      p.vel[0] += dir[0] * cv.f('bb_jump_punch');
      p.vel[1] += dir[1] * cv.f('bb_jump_punch');
      p.vel[2] += cv.f('bb_jumpforce');
      p.onGround = false;
      p.jumpCooldown = cv.f('bb_jumpcooldown');
      p.jumpGravityT = cv.f('bb_jumpgravity_time');
      this.emit({ type: 'jump', id: p.id });
    }

    if (p.onGround) {
      this.friction(p, dt);
      p.vel[2] = 0;
      if (a?.animMove && a.seq && a.lock > 0) this.rootMotion(p, dt);
      else this.accelerate(p, wish, wishSpeed, cv.f('sv_accelerate'), dt, charging);
      this.walkMove(p, dt);
    } else {
      this.airAccelerate(p, wish, wishSpeed, dt);
      if (a?.animMove && a.seq && a.lock > 0 && flag(a.def?.air_move)) this.rootMotion(p, dt);
      this.tryMove(p, dt);
      p.vel[2] -= p.gravityHalf;
    }
    this.categorize(p);
  }


  // [R 180370070, 18036f060] half the step before moving and half after, as Source does. Over the first
  // bb_jumpgravity_time the scale eases start -> peak -> end, softer while jump is held.
  gravity(p, dt) {
    p.gravityHalf = 0;
    if (p.onGround) return;
    const cv = this.cv;
    let g = cv.f('sv_gravity') * num(p.act?.tierDef?.gravity_scale ?? p.act?.def?.gravity_scale, 1);
    if (p.jumpGravityT > 0) {
      const be = cv.f('bb_jumpgravity_blend_end');
      const n = (1 - Math.min(1, p.jumpGravityT / cv.f('bb_jumpgravity_time'))) / be;
      if (n < 1) {
        const bias = cv.f('bb_jumpgravity_blend_peak') / be;
        const x = n >= bias ? (n - bias) * 0.5 / (1 - bias) + 0.5 : n * 0.5 / bias;
        const e = (1 - Math.cos(x * Math.PI)) * 0.5;
        const peak = cv.f((p.buttons & IN.JUMP) ? 'bb_jumpgravity_scale_peak_jump_pressed' : 'bb_jumpgravity_scale_peak_jump_released');
        g *= n >= bias ? peak + (cv.f('bb_jumpgravity_scale_end') - peak) * e : cv.f('bb_jumpgravity_scale_start') + (peak - cv.f('bb_jumpgravity_scale_start')) * e;
      }
      p.jumpGravityT = Math.max(0, p.jumpGravityT - dt);
    }
    p.gravityHalf = g * dt * 0.5;
    p.vel[2] -= p.gravityHalf;
    const mx = cv.f('sv_maxvelocity');
    for (let i = 0; i < 3; i++) p.vel[i] = Math.max(-mx, Math.min(mx, p.vel[i]));
  }

  friction(p, dt) {
    const v = p.vel;
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp < 0.1) { v[0] = v[1] = v[2] = 0; return; }
    const stop = this.cv.f('sv_stopspeed');
    const control = sp < stop ? stop : sp;
    const drop = control * this.cv.f('sv_friction') * dt;
    const ns = Math.max(0, sp - drop) / sp;
    v[0] *= ns; v[1] *= ns; v[2] *= ns;
  }

  // [R 18036d440] accel lerps from 15 at speed 40 up to the given value at sv_maxspeed
  accelerate(p, wish, wishSpeed, accel, dt, charging = false) {
    const mx = this.cv.f('sv_maxspeed');
    const k = mx === 40 ? (wishSpeed - 40 < 0 ? 0 : 1) : Math.max(0, Math.min(1, (wishSpeed - 40) / (mx - 40)));
    let ac = (accel - 15) * k + 15;
    if (charging) {
      // [R 18036d440] wish speed grows with seconds charged up to the cap, at a reduced acceleration
      const cv = this.cv, run = num(this.sword(p).chargerunx, 1);
      ac *= cv.f('bb_chargeaccel_acceleration');
      wishSpeed = Math.min(wishSpeed * (p.act.t * cv.f('bb_chargeaccel_charge_multiplier') * run + cv.f('bb_chargeaccel_initialspeed')), cv.f('bb_chargeaccel_maxspeed'));
    }
    // [R 18036d440] the room left to accelerate is measured against total speed, whatever its direction
    const add_ = wishSpeed - Math.hypot(p.vel[0], p.vel[1], p.vel[2]);
    if (add_ <= 0) return;
    const as = Math.min(add_, ac * dt * wishSpeed);
    p.vel[0] += as * wish[0];
    p.vel[1] += as * wish[1];
  }

  // [R 18036d710] air drag keeps bb_air_drag of horizontal speed per 1/66s, then a small capped acceleration
  airAccelerate(p, wish, wishSpeed, dt) {
    const drag = Math.pow(num(p.act?.def?.air_drag_scale, this.cv.f('bb_air_drag')), dt * 66);
    p.vel[0] *= drag;
    p.vel[1] *= drag;
    const capped = Math.min(wishSpeed, 30);
    const cur = p.vel[0] * wish[0] + p.vel[1] * wish[1];
    const add_ = capped - cur;
    if (add_ <= 0) return;
    const as = Math.min(add_, this.cv.f('sv_airaccelerate') * wishSpeed * dt);
    p.vel[0] += as * wish[0];
    p.vel[1] += as * wish[1];
  }

  // [R 18036e810] while animation_move is on, velocity is the sequence's own motion this tick times move_scale
  rootMotion(p, dt) {
    const a = p.act, c = this.char(p);
    if (!a.dur) return;
    const c1 = a.cycle, c0 = Math.max(0, c1 - dt / a.dur);
    const m0 = c.seqMovement(a.seq, c0), m1 = c.seqMovement(a.seq, c1);
    const d = sub(m1, m0);
    const { forward: f, right: r } = angleVectors([0, p.yaw, 0]);
    // Source model local: +x forward, +y left
    const s = a.moveScale / dt;
    const tx = (f[0] * d[0] - r[0] * d[1]) * s, ty = (f[1] * d[0] - r[1] * d[1]) * s;
    p.vel[0] = tx;
    p.vel[1] = ty;
  }

  trace(a, b) { return this.bsp.traceBox(a, b, HULL_MIN, HULL_MAX, MASK_PLAYERSOLID); }

  walkMove(p, dt) {
    const v = p.vel;
    if (Math.hypot(v[0], v[1]) < 1) { v[0] = v[1] = 0; return; }
    const o = p.origin, dest = [o[0] + v[0] * dt, o[1] + v[1] * dt, o[2]];
    const t0 = this.trace(o, dest);
    if (t0.fraction === 1) { p.origin = t0.endpos; return; }
    // StepMove: try flat slide, then up-over-down; keep the farther horizontal result
    const startO = [...o], startV = [...v];
    this.tryMove(p, dt);
    const dnO = p.origin, dnV = p.vel;
    p.origin = startO; p.vel = [...startV];
    const up = this.trace(startO, [startO[0], startO[1], startO[2] + STEP]);
    if (!up.startsolid && !up.allsolid) p.origin = up.endpos;
    this.tryMove(p, dt);
    const dn = this.trace(p.origin, [p.origin[0], p.origin[1], p.origin[2] - STEP]);
    if (dn.normal[2] < 0.7 && dn.fraction < 1) { p.origin = dnO; p.vel = dnV; return; }
    if (!dn.startsolid) p.origin = dn.endpos;
    const d1 = (dnO[0] - startO[0]) ** 2 + (dnO[1] - startO[1]) ** 2;
    const d2 = (p.origin[0] - startO[0]) ** 2 + (p.origin[1] - startO[1]) ** 2;
    if (d1 >= d2) { p.origin = dnO; p.vel = dnV; } else p.vel[2] = dnV[2];
  }

  tryMove(p, dt) {
    const planes = [];
    const orig = [...p.vel];
    let left = dt;
    for (let bump = 0; bump < 4; bump++) {
      if (p.vel[0] === 0 && p.vel[1] === 0 && p.vel[2] === 0) break;
      const end = [p.origin[0] + p.vel[0] * left, p.origin[1] + p.vel[1] * left, p.origin[2] + p.vel[2] * left];
      const t = this.trace(p.origin, end);
      if (t.allsolid) { p.vel = [0, 0, 0]; return; }
      if (t.fraction > 0) { p.origin = t.endpos; planes.length = 0; }
      if (t.fraction === 1) break;
      left -= left * t.fraction;
      planes.push(t.normal);
      if (planes.length > 5) { p.vel = [0, 0, 0]; break; }
      const clip = (v, n) => { const b = dot(v, n) * 1.001; return [v[0] - n[0] * b, v[1] - n[1] * b, v[2] - n[2] * b]; };
      if (planes.length === 1 && p.onGround && t.normal[2] > 0.7) { p.vel = clip(p.vel, t.normal); continue; }
      let i, nv;
      for (i = 0; i < planes.length; i++) {
        nv = clip(orig, planes[i]);
        let j;
        for (j = 0; j < planes.length; j++) if (j !== i && dot(nv, planes[j]) < 0) break;
        if (j === planes.length) break;
      }
      if (i !== planes.length) p.vel = nv;
      else if (planes.length === 2) { const d = norm(cross(planes[0], planes[1])); p.vel = scale(d, dot(d, p.vel)); } else { p.vel = [0, 0, 0]; break; }
      if (dot(p.vel, orig) <= 0) { p.vel = [0, 0, 0]; break; }
    }
  }

  categorize(p) {
    const wasGround = p.onGround;
    if (p.vel[2] > 140) { p.onGround = false; return; }
    const t = this.trace(p.origin, [p.origin[0], p.origin[1], p.origin[2] - 2]);
    if (t.fraction < 1 && t.normal[2] >= 0.7) {
      p.onGround = true;
      if (!t.startsolid) p.origin = t.endpos;
      if (!wasGround) {
        p.jumpGravityT = 0;
        // [R 180345580] landing from an air attack caps XY speed
        if (p.act?.attack && p.act.stanceType === 3 && p.isSwinging()) {
          const mx = this.cv.f('bb_air_max_land_momentum');
          const s = Math.hypot(p.vel[0], p.vel[1]);
          if (s > mx) { p.vel[0] *= mx / s; p.vel[1] *= mx / s; }
          p.act.lock = Math.min(p.act.lock, 0.1);
        }
      }
    } else p.onGround = false;
  }

  heightAboveGround(p) {
    const t = this.trace(p.origin, [p.origin[0], p.origin[1], p.origin[2] - 256]);
    return p.origin[2] - t.endpos[2];
  }

  softCollide() {
    // bb_player_softcollision: overlapping fighters are pushed apart rather than blocked
    const P = this.players.filter((p) => p.alive);
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i], b = P[j];
        const dx = a.origin[0] - b.origin[0], dy = a.origin[1] - b.origin[1];
        const dz = Math.abs(a.origin[2] - b.origin[2]);
        const d = Math.hypot(dx, dy);
        if (d >= 26 || dz > 72) continue;
        const nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
        const str = this.cv.f('bb_player_softcollision_strengthNormal') * (1 - d / 26) * TICK;
        a.vel[0] += nx * str; a.vel[1] += ny * str;
        b.vel[0] -= nx * str; b.vel[1] -= ny * str;
      }
    }
  }

  // -------------------------------------------------------------------- tracer (CBerimbauTracer)
  // Blade samples at the .bst cycles are computed from the attack sequence alone, then cached in
  // model space. [R 1803867c0]: base = sword_grip + fwd*grip_offset, tip = base + fwd*length
  bladeLocal(p, seq, cycle) {
    const key = p.character + '|' + seq.label + '|' + cycle;
    let v = this.bladeCache.get(key);
    if (!v) {
      const c = this.char(p);
      const pose = c.evalLayers([{ seq, cycle, weight: 1 }]);
      const b = c.boneMatrices(pose, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      const m = b[c.root.boneByName.get('sword_grip')];
      const fwd = [m[0], m[4], m[8]];
      const grip = this.cv.f('bb_tracer_default_grip_offset'), L = this.cv.f('bb_tracer_default_length');
      const pos = [m[3], m[7], m[11]];
      v = { base: add(pos, scale(fwd, grip)), tip: add(pos, scale(fwd, grip + L)) };
      this.bladeCache.set(key, v);
    }
    return v;
  }

  bladeWorld(p, l) {
    const m = entityMatrix(p.origin, [0, p.yaw, 0]);
    return { base: matPoint(m, l.base), tip: matPoint(m, l.tip) };
  }

  updateTracer(p) {
    const a = p.act;
    if (!a.tracer?.length || a.tracerIdx >= a.tracer.length) return;
    const fresh = [];
    while (a.tracerIdx < a.tracer.length && a.tracer[a.tracerIdx] <= a.cycle) {
      const seg = this.bladeWorld(p, this.bladeLocal(p, a.seq, a.tracer[a.tracerIdx]));
      fresh.push(seg);
      a.bladeRing.push(seg);
      if (a.bladeRing.length > 20) a.bladeRing.shift();
      a.tracerIdx++;
    }
    // [R 180388c60]: clash first, then hits. Both fighters' live blades are compared. Hits are retested every
    // tick until the script ends, because the target can walk into a blade between samples.
    if (fresh.length) {
      const opp = this.findClash(p, fresh);
      if (opp) { this.applyClash(p, opp); return; }
    }
    this.collectHits(p, fresh.length);
  }

  // [R 1803890c0, geometry I] closest approach of the blades, replacing the bloat-box test of 180389580
  findClash(p, segs) {
    for (const q of this.players) {
      if (q === p || !q.alive || !q.isSwinging() || !q.act.bladeRing.length) continue;
      if (q.act.tracerIdx >= q.act.tracer.length && q.act.cycle > 1) continue;
      for (const s of segs) for (const t of q.act.bladeRing.slice(-6)) if (segSegDist(s.base, s.tip, t.base, t.tip) < BLADE_CLASH_DIST) return q;
    }
    return null;
  }

  fighter(p, sw) {
    const a = p.act;
    return {
      origin: p.origin.map(Math.fround), stanceType: a.stanceType, sheathedAttack: false, attackLanded: !!a.landed, actionId: a.id, tier: a.tier, direction: a.dir,
      characterIndex: 0, lockTimer: Math.fround(a.lock), absVelocity: p.vel.map(Math.fround),
      turnSelfX: fnum(sw.interceptturnselfx), turnOpponentX: fnum(sw.interceptturnopponentx), recoveryX: fnum(sw.interceptrecoveryx),
      forwardRecoveryX: fnum(sw.interceptforwardrecoveryx), sideRecoveryX: fnum(sw.interceptsiderecoveryx),
    };
  }

  applyClash(p, q) {
    const cv = this.cv;
    const r = C.resolveClash(this.fighter(p, this.sword(p)), this.fighter(q, this.sword(q)), {
      recoveryNormal: fnum(cv.f('bb_recovery_tier_normal')), recoveryBetter: fnum(cv.f('bb_recovery_tier_better')), recoveryWorse: fnum(cv.f('bb_recovery_tier_worse')),
      turnParryAngle: fnum(cv.f('bb_turnanimation_parry_angle')), kbParry: fnum(cv.f('bb_kb_parry')), kbAirParry: fnum(cv.f('bb_kb_air_parry')), kbAirParryUp: fnum(cv.f('bb_kb_air_parry_up')),
      kbKeepMomentum: !!cv.f('bb_kb_parry_keep_momentum'),
    });
    const [hi, lo] = r.swapped ? [q, p] : [p, q];
    const side = (pl, s) => {
      pl.hitstop = s.hitstop;
      pl.yaw = angleNorm(pl.yaw + (s.turnToward % 2 === 1 ? s.turnAmount : 0));
      this.setTurnRate(pl, cv.f('bb_turnrate_parry_offensive_speed'), cv.f('bb_turnrate_parry_offensive_duration'));
      if (s.staggered) {
        const lock = s.setLockTimer ? s.lockTimer : cv.f('bb_recovery_tier_normal');
        this.startAction(pl, 'Interrupt', { force: true, lock, anim: 'ACT_BB_PARRY_UPPER' });
        pl.vel = [...s.knockback];
      } else if (pl.act) pl.act.bladeRing = [];
    };
    side(lo, r.low); side(hi, r.high);
    this.emit({ type: 'parried', attacker: hi.id, defender: lo.id, delta: r.delta, dir: this.swingDir(hi, lo), pos: r.effectOrigin });
  }

  // [client 1803d7370] effect direction: the last few blade steps, or attacker minus victim before there are any
  swingDir(att, vic) {
    const r = att.act?.bladeRing || [];
    if (r.length < 2) return [att.origin[0] - vic.origin[0], att.origin[1] - vic.origin[1], att.origin[2] - vic.origin[2]];
    const a = r[Math.max(0, r.length - 6)].tip, b = r[r.length - 1].tip;
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  }

  poseWorld(p) {
    const c = this.char(p);
    const pose = c.evalLayers(animLayers(c, this.animOf(p)));
    return c.boneMatrices(pose, entityMatrix(p.origin, [0, p.yaw, 0]));
  }

  idleSeq(p) {
    const st = this.data.stanceFor(p.character, p.stance);
    return this.char(p).seqForActivity(st?.idle || 'ACT_BB_B_IDLE') || this.char(p).seqs[0];
  }

  // [R 180387640] newest samples first, at least max(new samples, bb_tracer_max_hit_tests + 1) of them. Each traces
  // base to tip, and if that is clear, the previous tip to this tip, so a fast blade can't step over a fighter.
  // Both are bb_tracer_thickness hull traces. The engine only tests hitboxes for true rays [R engine.dll 180257d40],
  // so these hit the fighter's bounding box rather than the model's hitboxes.
  // [R 180388c60] a swing's first sample never hits, and further hits wait multihitRate * bb_timebetweenhits
  collectHits(p, freshCount) {
    const cv = this.cv, thick = cv.f('bb_tracer_thickness');
    const a = p.act, sw = this.sword(p), ring = a.bladeRing;
    if (ring.length < 2) return;
    const rate = num(a.dir & 1 ? sw.multihitratesidex : sw.multihitrateforwardx, 1) * cv.f('bb_timebetweenhits');
    if (this.time - p.lastHitTime < rate) return;
    const box = [-thick, -thick, -thick], boxMax = [thick, thick, thick];
    const tests = Math.max(freshCount, cv.f('bb_tracer_max_hit_tests') + 1);
    for (let i = ring.length - 1, n = 0; i >= 0 && n < tests; i--, n++) {
      const s = ring[i];
      const w = this.bsp.traceBox(s.base, s.tip, box, boxMax, 1);
      // world interrupt [R cvar bb_tracer_world_interrupt_enabled; recovery bb_recovery_hit_world]
      if (cv.f('bb_tracer_world_interrupt_enabled') && !a.worldHit && w.fraction < 0.75 && !w.startsolid) {
        a.worldHit = true;
        this.emit({ type: 'world_hit', id: p.id, pos: w.endpos, normal: w.normal });
      }
      if (this.bladeHitsFighter(p, s.base, s.tip, w.startsolid ? 1 : w.fraction, thick)) return;
      if (w.fraction === 1 && i > 0) {
        const from = ring[i - 1].tip, w2 = this.bsp.traceBox(from, s.tip, box, boxMax, 1);
        if (this.bladeHitsFighter(p, from, s.tip, w2.startsolid ? 1 : w2.fraction, thick)) return;
      }
    }
  }

  // One trace against every other fighter's bounding box, stopped by the world at `reach`
  bladeHitsFighter(p, from, to, reach, thick) {
    for (const v of this.players) {
      if (v === p || !v.alive) continue;
      const mn = add(v.origin, HULL_MIN), mx = add(v.origin, HULL_MAX);
      const t = segHitT(from, to, mn, mx, thick);
      if (t < 0 || t > reach) continue;
      p.lastHitTime = this.time;
      this.resolveHit(p, v, add(from, scale(sub(to, from), t)));
      return true;
    }
    return false;
  }

  // [R 18036c180 / V] one sword hit
  resolveHit(att, vic, pos) {
    const cv = this.cv, sw = this.sword(att), a = att.act;
    const svd = {
      damageDotProductX: fnumOpt(sw.damagedotproductx), damageX: fnum(sw.damagex),
      stanceX: [fnum(sw.balanceddamagex), fnum(sw.fastdamagex), fnum(sw.heavydamagex), fnum(sw.airdamagex)],
      forwardX: fnum(sw.forwardattackdamagex), sideX: fnum(sw.sideattackdamagex), parryX: fnum(sw.parrydamagex), multiHitScale: fnum(sw.multihitscale),
      multiHitMinDamage: inum(sw.multihitmindamage), minDamageTier: [inum(sw.mindamagetier1), inum(sw.mindamagetier2), inum(sw.mindamagetier3)],
    };
    const dmgV = C.computeAttackDamage({
      attackerInAttackAction: true, tierDamage: a.damage, stanceType: a.stanceType, direction: a.dir, tier: a.tier, actionId: a.id,
      hitsThisSwing: att.hitsThisSwing, victimStunType: vic.act?.stun ?? 0, swingProgress: a.cycle, sword: svd,
    }, fnum(cv.f('bb_global_damagescale')));
    // [R 180373850, 180372bd0] knockback = dir * 3500 * phys_pushscale * (stance kb * action kb * global)
    const st = this.data.stanceFor(att.character, a.stanceType);
    const kb = num(st?.kb, 0.0725) * a.kbScale * cv.f('bb_global_kbscale') * num(sw.knockbackx, 1);
    const d = norm([vic.origin[0] - att.origin[0], vic.origin[1] - att.origin[1], 0]);
    const dmg = { force: [d[0] * 3500 * kb, d[1] * 3500 * kb, 0].map(Math.fround), damage: dmgV };
    const defForward = angleVectors([0, vic.yaw, 0]).forward.map(Math.fround);
    let result = C.HIT_LANDED, defense = C.DEF_NONE, blockedTrue = false;
    const breaksBlock = flag(sw.tier3shouldbreakblock), breaksParry = flag(sw.tier3shouldbreakparry);
    const dorg = vic.origin.map(Math.fround), aorg = att.origin.map(Math.fround);
    if (vic.act?.kind === 'block') {
      defense = C.DEF_BLOCK;
      const r = C.resolveBlock({ defenderOrigin: dorg, attackerOrigin: aorg, defenderForward: defForward, attackerInAttackAction: true, attackerTier: a.tier, swordBreaksBlockAtTier3: breaksBlock },
        { blockDotProduct: fnum(cv.f('bb_block_dotproduct')), blockChipDamage: fnum(cv.f('bb_block_chipdamage')), knockbackBlock: fnum(cv.f('bb_kb_block')) }, dmg);
      if (r.outcome === C.BLOCK_BLOCKED) { result = C.HIT_BLOCKED; blockedTrue = true; } else if (r.outcome === C.BLOCK_BROKEN) result = C.HIT_GUARD_BROKEN;
    } else if (vic.act?.kind === 'parry' || vic.act?.kind === 'kneelparry') {
      defense = C.DEF_PARRY;
      const r = C.resolveParry({ defenderOrigin: dorg, attackerOrigin: aorg, defenderForward: defForward, attackerHasAction: true, attackerTier: a.tier, attackerActionId: a.id, attackerStanceType: a.stanceType,
        swordBreaksParryAtTier3: breaksParry, inParryWindow: vic.act.t <= vic.act.parryWindow, attackerAbsVelocity: att.vel.map(Math.fround) },
      { knockbackIntercept: fnum(cv.f('bb_kb_intercept')), interceptMomentumScale: fnum(cv.f('bb_intercept_momentum_scale')), interceptTime: fnum(cv.f('bb_intercept_time')) }, dmg);
      if (r.outcome === C.PARRY_INTERCEPTED) {
        result = C.HIT_INTERCEPTED;
        // attacker forced into Parried, with the recovery from CInterrupt [R 18034b8c0]
        this.startAction(att, 'Parried', { force: true, lock: cv.f('bb_recovery_intercept') });
        att.vel = [...r.attackerVelocity];
        if (vic.act) vic.act.lock = r.defenderLockTimer;
        const hs = fnum(cv.f('bb_hitstop_time'));
        att.hitstop = hs; vic.hitstop = hs;
        this.emit({ type: 'intercepted', attacker: att.id, defender: vic.id, dir: this.swingDir(att, vic), pos });
        return;
      }
      if (r.outcome === C.PARRY_BROKEN) result = C.HIT_GUARD_BROKEN;
    }
    if (result === C.HIT_LANDED || result === C.HIT_GUARD_BROKEN) {
      const combo = { hitsThisSwing: att.hitsThisSwing, comboCount: att.comboCount, comboResetTime: Math.fround(att.comboResetTime) };
      const cr = C.applyComboScaling(combo, Math.fround(this.time), aorg, dorg, {
        scalingTime: fnum(cv.f('bb_combo_scaling_time')), scalingAttacks: cv.f('bb_combo_scaling_attacks') | 0, scalingKnockback: fnum(cv.f('bb_combo_scaling_knockback')), scalingDamage: fnum(cv.f('bb_combo_scaling_damage')),
        damageMinimum: fnum(cv.f('bb_combo_scaling_damage_minimum')), attackerPush: fnum(cv.f('bb_combo_scaling_attacker_push')), attackerPushMax: fnum(cv.f('bb_combo_scaling_attacker_push_max')),
      }, dmg);
      att.comboCount = combo.comboCount; att.comboResetTime = combo.comboResetTime;
      if (cr.scaled) { att.vel[0] += cr.attackerPush[0]; att.vel[1] += cr.attackerPush[1]; }
    }
    const o = C.resolveHitOutcome({
      defense, resultAfterDefense: result, blockReturnedTrue: blockedTrue, attackerDirection: a.dir, attackerTier: a.tier, attackerActionId: a.id, hitsThisSwing: att.hitsThisSwing,
      attackerLockTimer: Math.fround(a.lock), attackerForce: [0, 0, 0], hitImpulse: [0, 0, 0], turnSelfX: fnum(sw.interceptturnselfx), recoveryBonusOnHit: fnum(sw.recoverybonusonhit),
    }, { turnAttackAngle: fnum(cv.f('bb_turnanimation_attack_angle')), turnRateSpeed: fnum(cv.f('bb_turnrate_attack_speed')), turnRateDuration: fnum(cv.f('bb_turnrate_attack_duration')),
      hitstopTime: fnum(cv.f('bb_hitstop_time')), hitstopTimeMax: fnum(cv.f('bb_hitstop_time_max')), hitstopMultihitTime: fnum(cv.f('bb_hitstop_multihit_time')) });
    if (o.setLockTimer) a.lock = o.lockTimer;
    att.hitsThisSwing = o.hitsThisSwing;
    if (o.turnVictim) vic.yaw = angleNorm(vic.yaw + (o.hitDirection === 3 ? o.turnAmount : o.hitDirection === 1 ? -o.turnAmount : 0));
    if (o.slowVictimTurnRate && cv.f('bb_turnrate_attack_duration') > 0) this.setTurnRate(vic, cv.f('bb_turnrate_attack_speed'), cv.f('bb_turnrate_attack_duration'));
    att.hitstop = o.hitstop; vic.hitstop = o.hitstop;
    vic.health = Math.max(0, vic.health - Math.trunc(dmg.damage));
    vic.vel = [dmg.force[0], dmg.force[1], Math.max(vic.vel[2], dmg.force[2])];
    if (o.incrementMultiBlock) att.multiBlock++;
    this.emit({ type: result === C.HIT_BLOCKED ? 'blocked' : result === C.HIT_GUARD_BROKEN ? 'break_block' : 'hit', attacker: att.id, victim: vic.id, damage: Math.trunc(dmg.damage), tier: a.tier, stance: att.stance, dir: this.swingDir(att, vic), pos });
    if (vic.health <= 0) { this.kill(vic, att); return; }
    this.applyReaction(att, vic, result, sw, a);
  }

  // [R 18034b8c0, 18036ca10] recovery by attacker stance and outcome. Any hit clears the downed state, and
  // tier 3 with tier3shouldknockdown knocks straight down.
  applyReaction(att, vic, result, sw, a) {
    const cv = this.cv;
    vic.kneeling = false;
    if (result === C.HIT_BLOCKED) {
      this.startAction(vic, 'Block', { force: true, lock: cv.f('bb_recovery_block'), dir: a.dir === 3 ? 3 : 1 });
      const k = ['bb_recovery_balanced_blocked', 'bb_recovery_reverse_blocked', 'bb_recovery_heavy_blocked', 'bb_recovery_balanced_blocked'][a.stanceType];
      a.lock = Math.max(a.lock, cv.f(k) * 0.5); // [I] attacker recoil share
      return;
    }
    if (result === C.HIT_GUARD_BROKEN) { this.startAction(vic, 'Interrupt', { force: true, lock: cv.f('bb_recovery_unblockable'), anim: a.def.reaction }); return; }
    if (a.tier === 2 && flag(sw.tier3shouldknockdown)) { if (vic.act?.kind !== 'kneelingfalling') this.startAction(vic, 'KneelingFalling', { force: true }); return; }
    if (att.hitsThisSwing > 1 && !cv.f('bb_multihit_stun')) return;
    let lock = [cv.f('bb_recovery_hit_balanced'), cv.f('bb_recovery_hit_fast'), cv.f('bb_recovery_hit_heavy'), cv.f('bb_recovery_air')][a.stanceType];
    if (!vic.onGround) lock = cv.f('bb_recovery_air');
    this.startAction(vic, vic.onGround ? 'Interrupt' : 'AirInterrupt', { force: true, lock, anim: a.def.reaction || undefined });
  }

  // -------------------------------------------------------------------- grab
  // [R 180349790] the attempt opens after bb_grab_delay and closes bb_grab_duration later
  updateGrab(p) {
    const a = p.act, cv = this.cv, delay = cv.f('bb_grab_delay');
    if (a.throwVictim !== undefined) { this.updateThrow(p); return; }
    if (a.grabDone) return;
    if (a.t > delay + cv.f('bb_grab_duration')) { a.grabDone = true; return; }
    const v = this.grabTarget(p);
    if (!v) return;
    // [R 180349f40] two grabs started together deflect each other
    if (v.act?.kind === 'grab' && v.act.t < delay) {
      this.startAction(v, 'GrabDeflect', { force: true });
      this.startAction(p, 'GrabDeflect', { force: true });
      this.emit({ type: 'grab_break', id: p.id, victim: v.id });
      return;
    }
    if (a.t >= delay) { a.grabDone = true; this.startThrow(p, v); }
  }

  // [R 180379710] the closest fighter in range, in front, and within half a hull height
  grabTarget(p) {
    let best = null, range = this.cv.f('bb_grab_range'), minDot = this.cv.f('bb_grab_dot');
    const { forward: f } = angleVectors([0, p.yaw, 0]);
    for (const v of this.players) {
      if (v === p || !v.alive) continue;
      const to = sub(v.origin, p.origin);
      if (Math.abs(to[2]) > HULL_MAX[2] * 0.5) continue;
      to[2] = 0;
      const dist = len(to), d = dot(norm(to), f);
      if (d >= minDot && dist <= range) { best = v; range = dist; minDot = d; }
    }
    return best;
  }

  // [R 1803498f0] the victim is pulled in front of the grabber, both face each other, the grabber plays
  // ACT_BB_THROW for its full length and the victim plays Thrown
  startThrow(p, v) {
    const kind = v.act?.kind, name = v.act?.name;
    if (kind === 'kill' || name === 'Fall' || name === 'KneelingFalling' || name === 'RecoveryAttack') return;
    if (['Interrupt', 'InterruptUpper', 'Parried', 'HitReactionWeak', 'HitReactionStrong'].includes(name)) return;
    const a = p.act, to = sub(v.origin, p.origin);
    to[2] = 0;
    const d = norm(to), start = [p.origin[0] + d[0] * 28, p.origin[1] + d[1] * 28, p.origin[2] + 40];
    const t = this.trace(start, [start[0], start[1], start[2] - 80]);
    if (!t.allsolid && t.fraction < 1) v.origin = [...t.endpos];
    const yaw = Math.atan2(d[1], d[0]) * 180 / Math.PI;
    p.yaw = yaw;
    v.yaw = angleNorm(yaw + 180);
    p.vel = [0, 0, 0];
    v.vel = [0, 0, 0];
    this.startAction(v, 'Thrown', { force: true });
    const { seq, dur } = this.seqInfo(p, 'ACT_BB_THROW');
    // the damage comes from the sequence's own AE_BB_DAMAGE_SLICE event [R 180333660]
    const slice = seq?.model.seqEvents(seq).find((e) => e.name === 'AE_BB_DAMAGE_SLICE');
    Object.assign(a, { anim: 'ACT_BB_THROW', seq, dur, t: 0, cycle: 0, lock: dur, lockDur: dur, throwVictim: v.id, sliceCycle: slice?.cycle ?? 0, sliced: false });
    this.emit({ type: 'grab', attacker: p.id, victim: v.id });
  }

  updateThrow(p) {
    const a = p.act;
    if (a.sliced || a.cycle < a.sliceCycle) return;
    a.sliced = true;
    const v = this.player(a.throwVictim);
    if (!v?.alive || v.act?.kind !== 'thrown') return;
    const damage = this.cv.f('bb_throw_damage');
    v.health -= damage;
    this.emit({ type: 'hit', attacker: p.id, victim: v.id, damage, pos: [v.origin[0], v.origin[1], v.origin[2] + 40] });
    if (v.health <= 0) this.kill(v, p);
  }

  // [R 18034d490] pressing grab inside bb_grab_break_window frees both fighters; the victim recovers sooner
  updateThrown(p) {
    const a = p.act, cv = this.cv;
    if (!(p.pressed & IN.GRAB) || a.lockDur - a.lock >= cv.f('bb_grab_break_window')) return;
    const g = this.players.find((q) => q.act?.throwVictim === p.id);
    if (g) this.startAction(g, 'GrabDeflect', { force: true });
    const b = this.startAction(p, 'GrabDeflect', { force: true });
    if (b) { b.lock *= cv.f('bb_grab_break_bonus'); b.lockDur = b.lock; }
    this.emit({ type: 'grab_break', id: p.id, victim: g?.id });
  }

  kill(v, att) {
    v.alive = false;
    v.health = 0;
    this.startAction(v, 'Kill', { force: true, lock: 1e9, extra: { kind: 'kill' } });
    this.emit({ type: 'death', victim: v.id, attacker: att?.id });
    this.duel.onDeath(v, att);
  }

  // Animation state, shared by the client and server hitboxes. Mirrors CBerimbauPlayerAnimState.
  // [R 18037c590] locomotion activity: idle below 0.5 u/s, else walk or run
  // [R 18037e1b0] max ground speed: sv_maxspeed for run, times the walk multiplier for idle and walk
  // [R 18013d340] move_x = cos(yaw)*rate*scale, move_y = -sin(yaw)*rate*scale, yaw relative to the body;
  //               scale goes from 1 on the axes to sqrt(2) on diagonals (circle onto the square grid)
  // [R 18037d550] cycle rate = max(1, rate)
  locomotion(p) {
    const a = p.act, st = this.data.stanceFor(p.character, a?.attack ? a.stanceType : p.stance) || {};
    const speed = Math.hypot(p.vel[0], p.vel[1]);
    const moving = speed > 0.5;
    // [R 18037e790, 180379da0] walking: slow move input, or any defensive action
    const defending = a?.kind === 'block' || a?.kind === 'parry' || a?.kind === 'guard';
    const walking = moving && (!!(p.buttons & IN.WALK) || defending);
    let base = st.idle || 'ACT_BB_B_IDLE';
    if (p.kneeling) base = 'ACT_BB_KNEELING'; // [R 18037e570]
    else if (!p.onGround) base = p.vel[2] >= 20 ? 'ACT_BB_A_RUN' : 'ACT_BB_BALANCED_JUMP'; // [R 18037c590]
    else if (walking) base = st.walk || 'ACT_WALK';
    else if (moving) base = st.run || 'ACT_BB_B_RUN';
    const maxSpeed = this.cv.f('sv_maxspeed') * (moving && !walking ? 1 : this.cv.f('bb_movement_walkspeed_multiplier'));
    const rate = moving ? Math.max(0.01, Math.min(10, speed / maxSpeed)) : 0;
    return { st, base, speed, moving, rate };
  }

  // Animation clocks run once per simulated tick, so they keep real time however often animOf is read.
  advanceAnim(p) {
    const { base, rate, speed, moving } = this.locomotion(p);
    const c = this.char(p), seq = c.seqForActivity(base);
    const dur = (seq && c.seqDuration(seq)) || 1;
    const loop = seq && seq.flags & 1;
    if (!loop && p.moveSeq !== seq) p.moveCycle = 0;
    p.moveSeq = seq;
    const next = p.moveCycle + TICK * (loop ? Math.max(1, rate) : 1) / dur;
    p.moveCycle = loop ? next % 1 : Math.min(1, next);
    // [R 18037d080] air state: 0 ground, 1 airborne, 2 just landed. Non-attack actions in the air don't count.
    const act = p.act, stunned = ['Interrupt', 'InterruptUpper', 'Fall', 'Parried', 'HitReactionWeak', 'HitReactionStrong'].includes(act?.name);
    const air = !p.onGround && (!act || act.attack || stunned);
    if (p.airState === 2 && (air || p.landCycle >= 1)) p.airState = 0;
    if (p.airState === 0 && air) { p.airState = 1; p.airT = this.time; p.airLandCycle = 0; }
    else if (p.airState === 1 && !air) { p.airState = 2; p.landT = 1; p.landCycle = 0; }
    // [R 18037d2c0] the landing delta plays at its own speed; in the air it is scrubbed by vertical speed
    if (p.landT > 0) {
      p.landT = Math.max(0, p.landT - TICK);
      p.landCycle = Math.min(1, p.landCycle + TICK / Math.max(0.01, c.seqDuration(c.seqForActivity('ACT_BB_JUMP_LAND'))));
    } else if (!p.onGround && !act?.attack) {
      const target = Math.max(0, Math.min(1, (p.vel[2] - 200) * -0.004));
      p.airLandCycle += Math.max(-2 * TICK, Math.min(2 * TICK, target - p.airLandCycle));
    }
    // [R 18037cbd0] the charge pose is scrubbed by charge progress, fading in at 5/s and out at 3/s,
    // and blends from standing to running at 4/s. Once released, the same remap runs it back to zero.
    const a = p.act, charging = !!(a?.attack && a.phase === 'charge');
    if (charging) p.chargeAnims = [a.def.charge_animation, a.def.charge_animation_run || a.def.charge_animation];
    const prog = charging ? Math.min(1, a.t / a.chargeTotal) : p.chargeCycle;
    p.chargeCycle = Math.max(0, Math.min(1, (prog - 0.05) / 0.95));
    const runTarget = moving || !p.onGround ? 1 : 0;
    if (p.chargeCycle > 0 || p.chargeFade > 0) {
      const fadeStep = (charging ? 5 : 3) * TICK;
      p.chargeFade = Math.max(0, Math.min(1, p.chargeFade + (charging ? fadeStep : -fadeStep)));
      p.chargeRun += Math.max(-4 * TICK, Math.min(4 * TICK, runTarget - p.chargeRun));
    } else p.chargeRun = runTarget;
  }

  animOf(p) {
    const a = p.act;
    const { st, speed, moving, rate, base: loco } = this.locomotion(p);
    let base = loco;
    let mx = 0, my = 0;
    if (!p.onGround) {
      // [R 18037e890] in the air: direction of travel, scaled by total speed over 100
      const th = (Math.atan2(p.vel[1], p.vel[0]) * 180 / Math.PI - p.yaw) * Math.PI / 180;
      const f = moving ? Math.min(1, Math.hypot(p.vel[0], p.vel[1], p.vel[2]) * 0.01) : 0;
      mx = Math.cos(th) * f;
      my = -Math.sin(th) * f;
    } else if (moving) {
      const th = angleNorm(Math.atan2(p.vel[1], p.vel[0]) * 180 / Math.PI - p.yaw);
      const u = Math.abs(th) % 90;
      const v = Math.sin(Math.PI / 4 - Math.abs(u - 45) * Math.PI / 180 + Math.PI / 2);
      const sc = 1 + 0.41421 * Math.max(0, Math.min(1, (v - 1) * -3.41423));
      mx = Math.cos(th * Math.PI / 180) * rate * sc;
      my = -Math.sin(th * Math.PI / 180) * rate * sc;
    }
    let baseCycle = p.moveCycle, upper = null, upperCycle = 0;
    if (a && !(a.attack && a.phase === 'charge')) {
      if (flag(a.def?.action_upperbody)) {
        // Upper-body actions leave locomotion running, or use the action's own lower body.
        if (a.def.animation_lowerbody) base = a.def.animation_lowerbody;
        if (a.anim) { upper = a.anim; upperCycle = a.dur > 0 ? a.cycle : a.t % 1; }
      } else if (a.anim) {
        base = a.anim;
        baseCycle = a.dur > 0 ? a.cycle : a.t % 1;
        if (a.def?.animation_lowerbody && a.anim !== a.def.animation_lowerbody) { base = a.def.animation_lowerbody; upper = a.anim; upperCycle = baseCycle; }
      }
    }
    // Walk cycles have no stance arms of their own; they borrow the upper body the stance's run auto-layers.
    const armsFrom = base === (st.walk || 'ACT_WALK') ? (st.run || null) : null;
    const charge = p.chargeFade > 0 && p.chargeAnims ? [...p.chargeAnims, p.chargeCycle, (1 - p.chargeRun) * p.chargeFade, p.chargeRun * p.chargeFade] : null;
    let land = null;
    if (p.landT > 0) land = [p.landCycle, Math.max(0, Math.min(1, (1 - speed * 0.001) - (1 - p.landT)))];
    else if (!p.onGround && !a?.attack && !p.kneeling) land = [p.airLandCycle, 0.9];
    // [R 18037d7e0] an action in the air keeps the jump legs, fading in over 0.12s
    const legs = p.airState === 1 && a ? Math.max(0, Math.min(1, (this.time - p.airT) * 8.33333)) : 0;
    return { base, baseCycle, upper, upperCycle, mx, my, speed, armsFrom, charge, land, legs };
  }
}

// Turns an animOf() result into sequence layers. Shared by the client and server hitboxes.
export function animLayers(c, an) {
  const base = c.seqForActivity(an.base ?? an.b) || c.seqForActivity('ACT_BB_B_IDLE') || c.seqs[0];
  const [px, py] = c.blendFor(base, an.mx, an.my);
  const out = [{ seq: base, cycle: an.baseCycle ?? an.bc, weight: 1, px, py }];
  const armsFrom = an.armsFrom ?? an.af;
  const run = armsFrom ? c.seqForActivity(armsFrom) : null;
  if (run) for (const a of c.autoLayers(run)) out.push({ seq: a, cycle: an.baseCycle ?? an.bc, weight: 1, px: 0.5, py: 0.5 });
  const up = an.upper ?? an.u;
  const s = up ? c.seqForActivity(up) : null;
  if (s) { const [ux, uy] = c.blendFor(s, an.mx, an.my); out.push({ seq: s, cycle: an.upperCycle ?? an.uc, weight: 1, px: ux, py: uy }); }
  const charge = an.charge ?? an.ch;
  if (charge) for (const i of [0, 1]) {
    const cs = c.seqForActivity(charge[i]);
    if (cs && charge[3 + i] > 0) { const [ux, uy] = c.blendFor(cs, an.mx, an.my); out.push({ seq: cs, cycle: charge[2], weight: charge[3 + i], px: ux, py: uy }); }
  }
  const land = an.land ?? an.ld;
  if (land && land[1] > 0) out.push({ seq: c.seqForActivity('ACT_BB_JUMP_LAND'), cycle: land[0], weight: land[1], px: 0.5, py: 0.5 });
  const legs = an.legs ?? an.lg;
  if (legs > 0) out.push({ seq: c.seqForActivity('ACT_BB_JUMP_LEGS'), cycle: 0, weight: legs, px: 0.5, py: 0.5 });
  return out;
}

const fnum = (v) => (v === undefined || v === null ? null : Math.fround(typeof v === 'number' ? v : parseFloat(v)));
const fnumOpt = fnum;
const inum = (v) => (v === undefined || v === null ? null : parseInt(v, 10));

// Where along a->b the segment first enters the padded box, or -1 if it misses.
function segHitT(a, b, mn, mx, pad) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i], lo = mn[i] - pad, hi = mx[i] + pad;
    if (Math.abs(d) < 1e-6) { if (a[i] < lo || a[i] > hi) return -1; continue; }
    let u = (lo - a[i]) / d, v = (hi - a[i]) / d;
    if (u > v) { const t = u; u = v; v = t; }
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return -1;
  }
  return t0;
}

export function segSegDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const A = dot(d1, d1), E = dot(d2, d2), F = dot(d2, r);
  let s, t;
  if (A < 1e-9 && E < 1e-9) return len(r);
  if (A < 1e-9) { s = 0; t = Math.min(1, Math.max(0, F / E)); } else {
    const c = dot(d1, r);
    if (E < 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / A)); } else {
      const b = dot(d1, d2), den = A * E - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * F - c * E) / den)) : 0;
      t = (b * s + F) / E;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / A)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / A)); }
    }
  }
  return len(sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}

// ---------------------------------------------------------------------- duel (CBerimbauDuel)
// [R 18032c4c0, 18032d420, 18032df30] best of vs_duel_rounds; frozen warmup, fight, intermission, cooldown.
export class Duel {
  constructor(world) {
    this.w = world;
    this.state = 'waiting';
    this.timer = 0; this.round = 0; this.wins = {}; this.fighters = []; this.winner = null; this.last = null;
    this.arena = null;
  }

  spawns() {
    const b = this.w.bsp;
    const all = b.entities.filter((e) => e.classname === 'berimbau_spawn');
    const duels = b.entities.filter((e) => e.classname === 'berimbau_duel');
    return { all, duels };
  }

  onPlayersChanged() {
    const P = this.w.players;
    if (this.state === 'waiting' && P.length >= 2) this.beginMatch();
    else if (this.state !== 'waiting' && this.fighters.some((id) => !P.find((p) => p.id === id))) {
      this.state = 'waiting'; this.fighters = [];
      this.w.emit({ type: 'duel_aborted' });
      if (P.length >= 2) this.beginMatch(); else for (const p of P) { p.frozen = false; }
    } else if (P.length === 1) this.placeSolo(P[0]);
  }

  placeSolo(p) {
    const s = this.pickSpawnPair();
    p.reset(s[0].o, s[0].yaw);
    p.frozen = false;
  }

  // Spawns carry explicit arena and team keys: duel=<berimbau_duel targetname>, duelteam=1|2, spawnid.
  pickSpawnPair() {
    const b = this.w.bsp;
    const parse = (e) => ({ o: e.origin.split(' ').map(Number), yaw: parseFloat((e.angles || '0 0 0').split(' ')[1]), e });
    const list = b.entities.filter((e) => e.classname === 'berimbau_spawn' && e.origin).map(parse);
    const arenas = b.entities.filter((e) => e.classname === 'berimbau_duel').map((e) => e.targetname);
    const clear = (o) => !b.traceBox([o[0], o[1], o[2] + 2], [o[0], o[1], o[2] + 2], HULL_MIN, HULL_MAX).startsolid;
    for (const ar of [...arenas].sort()) {
      const team = (t) => list.filter((s) => s.e.duel === ar && s.e.duelteam === String(t)).sort((x, y) => (x.e.spawnid | 0) - (y.e.spawnid | 0)).find((s) => clear(s.o));
      const t1 = team(1), t2 = team(2);
      if (t1 && t2) return [t1, t2];
    }
    return [list[0], list[1] || list[0]];
  }

  beginMatch() {
    const P = this.w.players.slice(0, 2);
    this.fighters = P.map((p) => p.id);
    this.wins = Object.fromEntries(P.map((p) => [p.id, 0]));
    this.round = 0; this.winner = null;
    this.startRound(true);
  }

  startRound(first) {
    const cv = this.w.cv;
    this.round++;
    const pair = this.pickSpawnPair();
    this.fighters.forEach((id, i) => {
      const p = this.w.player(id);
      if (!p) return;
      const s = pair[i % pair.length];
      p.reset([s.o[0], s.o[1], s.o[2] + 1], s.yaw);
      p.frozen = true;
    });
    this.state = 'warmup';
    this.timer = first ? cv.f('vs_duel_warmup_time_initial') : cv.f('vs_duel_warmup_time_intermediate');
    this.w.emit({ type: 'round_start', round: this.round, warmup: this.timer, maxRounds: cv.f('vs_duel_rounds') });
  }

  update() {
    const cv = this.w.cv;
    if (this.state === 'waiting') return;
    this.timer -= TICK;
    switch (this.state) {
      case 'warmup':
        if (this.timer <= 0) {
          this.state = 'fight'; this.timer = cv.f('vs_duel_timelimit');
          for (const id of this.fighters) { const p = this.w.player(id); if (p) p.frozen = false; }
          this.w.emit({ type: 'fight' });
        }
        break;
      case 'fight':
        if (this.timer <= 0) {
          // [I] time up: higher remaining health wins the round, equal health is a draw
          const [a, b] = this.fighters.map((id) => this.w.player(id));
          if (a && b) this.endRound(a.health === b.health ? null : a.health > b.health ? a : b, 'timeup');
        }
        break;
      case 'intermission':
        if (this.timer <= 0) this.afterIntermission();
        break;
      case 'cooldown':
        if (this.timer <= 0) { if (this.w.players.length >= 2) this.beginMatch(); else this.state = 'waiting'; }
        break;
      default:
    }
  }

  onDeath(v, att) {
    if (this.state !== 'fight') return;
    this.endRound(att && this.fighters.includes(att.id) ? att : this.w.player(this.fighters.find((id) => id !== v.id)), 'kill');
  }

  endRound(winner, why) {
    const cv = this.w.cv;
    if (winner) this.wins[winner.id] = (this.wins[winner.id] || 0) + 1;
    this.state = 'intermission';
    this.timer = cv.f('vs_duel_intermission_time');
    this.last = { winner: winner?.id ?? null, why };
    this.w.emit({ type: 'round_end', winner: winner?.id ?? null, why, wins: this.wins });
  }

  afterIntermission() {
    const cv = this.w.cv;
    const need = Math.floor(cv.f('vs_duel_rounds') / 2) + 1;
    const champ = this.fighters.find((id) => (this.wins[id] || 0) >= need);
    if (champ !== undefined || this.round >= cv.f('vs_duel_rounds') + 4) {
      this.winner = champ ?? null;
      const p = champ !== undefined ? this.w.player(champ) : null;
      if (p) p.score++;
      this.state = 'cooldown';
      this.timer = cv.f('vs_duel_cooldown_time');
      this.w.emit({ type: 'duel_over', winner: champ ?? null, wins: this.wins });
    } else this.startRound(false);
  }
}
void STANCE_KEYS;
