// Authoritative duel simulation. Provenance of each rule is noted as:
//   [R addr]   recovered from server.dll at addr
//   [V]        verified port (combat.js, bit-identical to the C++/server.dll tests)
//   [I]        inferred: plausible behaviour, not yet confirmed against the binary
import * as C from './combat.js';
import { actionId, STANCE_KEYS } from './gamedata.js';
import { angleVectors, add, sub, scale, dot, cross, len, norm, entityMatrix, angleNorm, approachAngle, matPoint } from './mathx.js';
import { MASK_PLAYERSOLID } from './bsp.js';

export const TICK = 1 / 66;
// [R 18037b1eb] the player reset sets the entity gravity field to 3, multiplying sv_gravity
const PLAYER_GRAVITY_SCALE = 3;
// [R 18037b470] these presses are remembered; a new one replaces the old. The time is the client's bb_ibt default.
const BUFFERED_BUTTONS = 0x428807, INPUT_BUFFER_TIME = 0.33;
// [R 180454b60, 180450a80] Source's Gain() through a cosine; sharpness 0 makes Bias() pow(x, 0), so this is 0.5
function jumpGravityEase(n, bias, sharpness) {
  const x = n >= bias ? (n - bias) * 0.5 / (1 - bias) + 0.5 : n * 0.5 / bias;
  const b = (v) => Math.pow(v, Math.log(1 - sharpness) * -1.4427);
  const gain = x < 0.5 ? 0.5 * b(2 * x) : 1 - 0.5 * b(2 - 2 * x);
  return (1 - Math.cos(gain * Math.PI)) * 0.5;
}
export const IN = { ATTACK: 1, JUMP: 2, ROLL: 4, FORWARD: 8, BACK: 0x10, LEFT: 0x200, RIGHT: 0x400, GRAB: 0x20000, WALK: 0x40000, SHUFFLE: 0x400000, BLOCK: 0x800000, STANCE_FAST: 0x2000000, STANCE_BAL: 0x4000000, STANCE_HEAVY: 0x8000000 };
const HULL_MIN = [-13, -13, 0], HULL_MAX = [13, 13, 72];
const STEP = 18;
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
      bufferMask: 0, bufferT: 0, airStance: false, queuedStance: -1, touchdown: null,
    });
  }

  get pressed() { return this.buttons & ~this.prevButtons; }
  // [R 180379c10] held, or pressed within the input buffer
  wants(bit) { return !!(this.buttons & bit) || (this.bufferT > 0 && !!(this.bufferMask & bit)); }
  // [R 180379b80] the same, and using it spends the buffered press
  use(bit) { const w = this.wants(bit); if (w) this.bufferMask &= ~bit; return w; }
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
    // [R 18036f7d0] runs before movement: the ground clears the gravity timer and only there does the cooldown count
    if (p.onGround) { p.jumpGravityT = 0; p.jumpCooldown = Math.max(0, p.jumpCooldown - dt); }
    p.jumpGravityT = Math.max(0, p.jumpGravityT - dt);
    p.blockCooldown = Math.max(0, p.blockCooldown - dt);
    p.moveCooldown = Math.max(0, p.moveCooldown - dt);
    p.turnRateTime = Math.max(0, p.turnRateTime - dt);
    const pressed = p.pressed & BUFFERED_BUTTONS;
    if (pressed) { p.bufferMask = pressed; p.bufferT = INPUT_BUFFER_TIME; }
    // [R 18037aa00] both fighters freeze during hitstop; [R 180388b60] the multi-hit timer doesn't count it
    if (p.hitstop > 0) { p.hitstop -= dt; p.lastHitTime += dt; return; }
    p.animTime += dt;
    // [R 180379df0] stance first, then the current action, then new input
    if (p.alive && !p.frozen) { this.updateStance(p); this.updateAction(p); this.dispatchInput(p); } else if (!p.alive) this.updateAction(p);
    this.updateYaw(p, dt);
    p.bufferT = Math.max(0, p.bufferT - dt); // [R 18036fa86]
    const td = p.touchdown;
    if (td) {
      // [R 18037d2c0, 18037e7d0] the cycle runs through the land lock; the weight moves toward 1, then back to 0, at 7 per second
      td.t -= dt;
      const goal = td.t > 0 ? 1 : 0, step = 7 * dt;
      td.weight = Math.abs(goal - td.weight) <= step ? goal : td.weight + Math.sign(goal - td.weight) * step;
      if (td.t <= 0 && td.weight <= 0) p.touchdown = null;
    }
    this.move(p, dt);
    this.advanceAnim(p);
    if (p.isSwinging() && !p.frozen) this.updateTracer(p);
    // [R 180388b9a] a frozen fighter's hit timer stands still
    else if (p.frozen && p.lastHitTime > 0) p.lastHitTime += TICK;
  }

  stanceNow(p) { return p.airStance ? 3 : p.stance; }

  // [R 18037b6b0] Every tick. Past bb_air_stance_height_min off the ground the stance becomes air, and an attack still
  // charging becomes that stance's version, keeping its charge. Landing undoes it, so a release lower than that
  // height stays a ground attack.
  updateStance(p) {
    const a = p.act, charging = a?.attack && a.phase === 'charge', swinging = a?.attack && a.phase === 'swing';
    if (!p.onGround) {
      const airMove = a ? (charging ? flag(a.def.air_move) : a.airMove) : false;
      if (!p.airStance && (airMove || !a || charging) && this.heightAboveGround(p) > this.cv.f('bb_air_stance_height_min')) {
        p.airStance = true;
        if (charging && !airMove) this.swapCharge(p, 3);
      }
    } else if (p.airStance) {
      p.airStance = false;
      if (charging) this.swapCharge(p, p.stance);
    }
    // stance keys: a charge, or a swing in the air, queues the change until it can apply
    const pr = p.pressed;
    const key = pr & IN.STANCE_BAL ? 0 : pr & IN.STANCE_HEAVY ? 2 : pr & IN.STANCE_FAST ? 1 : -1;
    const want = key >= 0 ? key : p.queuedStance;
    if (want < 0) return;
    if (charging) { p.queuedStance = want; return; }
    if (!p.onGround && key >= 0 && swinging) { p.queuedStance = want; return; }
    if (p.onGround || key >= 0 || !p.airStance) { this.setStance(p, want); p.queuedStance = -1; }
  }

  // [R 1803723a0, 1803444f0] replaces the charging attack with the same direction and string slot in a stance;
  // elapsed charge time carries over
  swapCharge(p, stance) {
    const a = p.act, def = this.data.attackFor(p.character, stance, a.dir, a.comboIdx);
    if (!def) return;
    Object.assign(a, { name: def.name, def, stanceType: stance, anim: def.charge_animation, seq: this.seqInfo(p, def.charge_animation).seq });
  }

  // [R 180379df0] input priority order: current action update, shuffle, grab, roll, block, attack.
  // Everything reads held or buffered, so holding a button repeats it once it can run again.
  dispatchInput(p) {
    if (p.kneeling) { this.dispatchKneeling(p); return; }
    if (p.wants(IN.SHUFFLE) && this.canEvade(p)) { p.use(IN.SHUFFLE); this.startEvade(p, 'Shuffle'); return; }
    if (p.wants(IN.GRAB) && this.canGrab(p)) { p.use(IN.GRAB); this.startAction(p, 'Grab', { force: true, extra: { grabDone: false } }); return; }
    if (p.wants(IN.ROLL) && this.canEvade(p)) { p.use(IN.ROLL); this.startEvade(p, 'Roll'); return; }
    // [R 180374d80] +block requires ground, nothing locking, attack not held and the post-attack cooldown elapsed
    if (p.wants(IN.BLOCK) && p.onGround && !p.act && !(p.buttons & IN.ATTACK) && !p.blockCooldown) {
      p.use(IN.BLOCK);
      this.startAction(p, this.blockActionName(p), { dir: this.moveDir(p) });
      return;
    }
    // [R 18037a1bd] the current action decides whether anything new can start
    if (p.act && !this.canCancel(p) && !this.attackCancelsEvade(p)) return;
    if (!p.isAttacking() && p.use(IN.ATTACK)) this.startAttack(p);
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

  // [R 18034c360, 180344d10] a held attack replaces a shuffle or roll once the sequence's remaining time, not the
  // lock's, is within the cancel time
  attackCancelsEvade(p) {
    const a = p.act;
    if (!a || !(p.buttons & IN.ATTACK)) return false;
    const cancel = a.name === 'Shuffle' ? 'bb_shufflecancel_time' : a.name === 'Roll' ? 'bb_rollcancel_time' : null;
    return !!cancel && a.dur - a.t <= this.cv.f(cancel);
  }

  // [R 1803467c0] attack held late in a swing cancels it, on a swing to the opposite side or after a stance change,
  // if the sword allows it. "Late" is the stance's bb_side_cancel_percent_* of the lock remaining.
  swingCancels(p, a) {
    if (!p.wants(IN.ATTACK)) return false;
    const percent = this.cv.f(`bb_side_cancel_percent_${['balanced', 'fast', 'heavy', 'air'][a.stanceType]}`);
    if (percent <= 0 || percent * a.lockDur <= a.lock) return false;
    const f = this.data.stanceFor(p.character, a.stanceType)?.forward;
    const strings = (f?.['action[]'] || [f?.action]).filter(Boolean).length;
    if (a.comboIdx >= strings) return false;
    const sword = this.sword(p), dir = this.moveDir(p);
    if (flag(sword.cansidecancel) && ((a.dir === 3 && dir === 1) || (a.dir === 1 && dir === 3))) return true;
    return flag(sword.canstancecancel) && a.stanceAtRelease !== this.stanceNow(p);
  }

  // [R 18036e190, 1803462a0, 180343d80] the action decides: an attack allows a jump while charging or when it
  // isn't air_move; anything else follows its script's "jump" key
  canJumpInAction(a) {
    if (!a) return true;
    return a.attack ? a.phase === 'charge' || !a.airMove : flag(a.def?.jump);
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
      moveLock: flag(def.move_lock), airMove: flag(def.air_move), animMove: flag(def.animation_move), upperBody: flag(def.action_upperbody), lowerBody: def.animation_lowerbody, rotLock: flag(def.rotation_lock),
      rotSpeed: num(def.rotation_speed, 0), moveScale: num(def.move_scale, 1), runScale: num(def.runspeedscale, 1),
      parryWindow: num(def.parry_window, 0), kind: String(def.factoryclass || '').toLowerCase(), ...opts.extra,
    };
    this.emit({ type: 'action', id: p.id, name: p.act.name });
    return p.act;
  }

  // [R 180374910] picks the attack from stance/direction/combo index, then CAttackAction charges
  startAttack(p) {
    const stance = this.stanceNow(p);
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
      moveScale: 1, runScale: 1, kind: 'attack', chargeTier: 0, landed: false, comboIdx: p.comboIdx,
      bladeRing: [],
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
      // [R 180345941, 180345be6, 180346630, 180346737] once released these come from the tier: move_lock alone, animation_move
      // needs both levels, and the tier's action_upperbody lets the legs keep running under the swing
      moveLock: flag(tierDef.move_lock), airMove: flag(a.def.air_move) || flag(tierDef.air_move), animMove: flag(a.def.animation_move) && flag(tierDef.animation_move ?? '1'),
      upperBody: flag(tierDef.action_upperbody ?? a.def.action_upperbody), lowerBody: tierDef.animation_lowerbody ?? a.def.animation_lowerbody, rotLock: flag(tierDef.rotation_lock ?? a.def.rotation_lock),
      rotSpeed: num(a.def.rotation_speed, 0), moveScale: num(tierDef.move_scale ?? a.def.move_scale, 1),
      runScale: num(tierDef.runspeedscale, 1), damage: num(tierDef.damage, 10), kbScale: num(tierDef.knockback_scale ?? a.def.knockback_scale, 1),
      tracer: this.data.tracers[p.character]?.[String(anim).toUpperCase()] || [], trCycle: 0, trNew: 0, trDone: false, trExt: cv.f('bb_tracer_parry_extension_duration'), bladeRing: [], prevCycle: 0, stanceAtRelease: this.stanceNow(p),
    });
    p.blockCooldown = lock + cv.f('bb_block_post_attack_cooldown');
    p.comboIdx++; // [R 180374120] attackFor wraps it at the stance's string length
    p.comboIdxTime = this.time;
    // [R 180346ced] a sword that doesn't knock down plays the soft sound
    if (tier === 2) this.emit({ type: 'charge_tier', id: p.id, tier, soft: !flag(this.sword(p).tier3shouldknockdown) });
    a.trCount = a.tracer.length;
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
        // [R 180345d8a] tier 2 announces itself when reached; tier 3 waits for the release
        if (!a.chargeTier && a.t >= this.cv.f('bb_charge_tier2_time') * num(this.sword(p).chargetime, 1)) { a.chargeTier = 1; this.emit({ type: 'charge_tier', id: p.id, tier: 1 }); }
      }
      return;
    }
    if (a.attack && this.swingCancels(p, a)) {
      p.act = null;
      p.moveCooldown = this.cv.f('bb_shuffle_postattack_delay');
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

    // [R 18036f615] while an animation drives movement, an air_move or noclip_move action takes no gravity
    const animDriven = this.rootMotionActive(p);
    this.gravity(p, dt, animDriven && (a.airMove || flag(a.def?.noclip_move)));
    // [R 18036e190] jump: flat force + directional punch, gravity curve afterwards
    if (!animDriven && p.wants(IN.JUMP) && !(p.prevButtons & IN.JUMP) && p.onGround && !p.jumpCooldown && !p.frozen && p.alive && !p.kneeling && this.canJumpInAction(a)) {
      p.use(IN.JUMP);
      const dir = wl > 0 ? wish : [0, 0, 0];
      p.vel[0] += dir[0] * cv.f('bb_jump_punch');
      p.vel[1] += dir[1] * cv.f('bb_jump_punch');
      p.vel[2] += cv.f('bb_jumpforce') - p.gravityHalf; // the jump runs its own FinishGravity
      p.onGround = false;
      p.jumpCooldown = cv.f('bb_jumpcooldown');
      p.jumpGravityT = cv.f('bb_jumpgravity_time');
      this.emit({ type: 'jump', id: p.id });
    }

    if (animDriven) {
      this.rootMotion(p, dt);
      if (a.airMove && p.vel[2] > 0) p.onGround = false; // [R 18036eed1] upward motion leaves the ground
      if (p.onGround) { p.vel[2] = 0; this.walkMove(p, dt); } else { this.tryMove(p, dt); p.vel[2] -= p.gravityHalf; }
    } else if (p.onGround) {
      this.friction(p, dt);
      p.vel[2] = 0;
      this.accelerate(p, wish, wishSpeed, cv.f('sv_accelerate'), dt, charging);
      this.walkMove(p, dt);
    } else {
      this.airAccelerate(p, wish, wishSpeed, dt);
      this.tryMove(p, dt);
      p.vel[2] -= p.gravityHalf;
    }
    this.categorize(p);
  }


  // [R 180370070, 18036f060] half the step before moving and half after, as Source does, on the ground too.
  // Over bb_jumpgravity_time the scale goes start -> peak -> end, softer while jump is held.
  gravity(p, dt, off) {
    p.gravityHalf = 0;
    if (off) return;
    const cv = this.cv;
    let g = cv.f('sv_gravity') * PLAYER_GRAVITY_SCALE * num(p.act?.tierDef?.gravity_scale ?? p.act?.def?.gravity_scale, 1);
    if (p.jumpGravityT > 0) {
      const bs = cv.f('bb_jumpgravity_blend_start'), span = cv.f('bb_jumpgravity_blend_end') - bs;
      const n = (1 - Math.min(1, p.jumpGravityT / cv.f('bb_jumpgravity_time')) - bs) / span;
      if (n >= 0 && n < 1) {
        const bias = (cv.f('bb_jumpgravity_blend_peak') - bs) / span;
        const e = jumpGravityEase(n, bias, cv.f('bb_jumpgravity_scale_sharpness'));
        const peak = cv.f((p.buttons & IN.JUMP) ? 'bb_jumpgravity_scale_peak_jump_pressed' : 'bb_jumpgravity_scale_peak_jump_released');
        g *= n >= bias ? peak + (cv.f('bb_jumpgravity_scale_end') - peak) * e : cv.f('bb_jumpgravity_scale_start') + (peak - cv.f('bb_jumpgravity_scale_start')) * e;
      }
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
  // [R 1803447b0, 180345ad0, 1803459f0] the action's animation_move, for the tier's animation_move_duration if it has
  // one. An attack only moves this way after release, and an air_move one with a landing stops on touching down.
  rootMotionActive(p) {
    const a = p.act;
    if (!a?.animMove || !a.seq || !a.dur) return false;
    if (!a.attack && a.lock <= 0) return false;
    if (a.attack && (a.airMove && p.onGround && a.def.landing)) return false;
    const window = num(a.tierDef?.animation_move_duration ?? a.def?.animation_move_duration, -1);
    return (window < 0 || a.t <= window) && a.t <= a.dur + TICK;
  }

  // [R 18036e810] velocity comes from the sequence; height too for air_move, and noclip_move holds it level
  rootMotion(p, dt) {
    const a = p.act, c = this.char(p);
    const c1 = a.cycle, c0 = Math.max(0, c1 - dt / a.dur);
    const m0 = c.seqMovement(a.seq, c0), m1 = c.seqMovement(a.seq, c1);
    const d = sub(m1, m0);
    const { forward: f, right: r } = angleVectors([0, p.yaw, 0]);
    // Source model local: +x forward, +y left
    const s = a.moveScale / dt;
    const tx = (f[0] * d[0] - r[0] * d[1]) * s, ty = (f[1] * d[0] - r[1] * d[1]) * s;
    p.vel[0] = tx;
    p.vel[1] = ty;
    if (a.airMove) p.vel[2] = d[2] * s;
    else if (flag(a.def?.noclip_move)) p.vel[2] = 0;
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
        // [R 180345580, 18037d1da] an air_move swing touching down caps XY speed, takes the tier's land lock and
        // blends its landing sequence in over whatever is left of the swing
        const a = p.act;
        if (a && p.isSwinging() && a.airMove && a.def.landing && !a.touchedDown) {
          a.touchedDown = true;
          const mx = this.cv.f('bb_air_max_land_momentum');
          const s = Math.hypot(p.vel[0], p.vel[1]);
          if (s > mx) { p.vel[0] *= mx / s; p.vel[1] *= mx / s; }
          a.lock = a.lockDur = num(a.tierDef.land_lock_duration, 0.5); // [R 1803462f0]
          if (this.seqInfo(p, a.def.landing).seq) p.touchdown = { anim: a.def.landing, t: a.lock, total: a.lock, weight: 0 };
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
  // [R 1803867c0, 180389b00] One blade sample, posed fresh: the swing's sequence with move_x/move_y from the current
  // velocity, and the attacker's pitch split across the spine. base = sword_grip + fwd*grip_offset, tip = base + fwd*length.
  bladeSample(p, cycle) {
    const c = this.char(p), a = p.act, cv = this.cv;
    let mx = 0, my = 0;
    if (Math.abs(p.vel[0]) >= 0.01 || Math.abs(p.vel[1]) >= 0.01) {
      const l = Math.hypot(p.vel[0], p.vel[1]), vx = p.vel[0] / l, vy = p.vel[1] / l;
      const y = p.yaw * Math.PI / 180, cy = Math.cos(y), sy = Math.sin(y);
      const fwd = vx * cy + vy * sy, right = vx * sy - vy * cy;
      // the corners of the blend square need a longer vector to reach it
      const deg = ((Math.atan2(right, fwd) * 180 / Math.PI) % 90 + 90) % 90;
      const k = 1 + 0.41421 * Math.max(0, Math.min(1, (Math.sin(0.7854 - Math.abs(deg - 45) * 0.01745 + 1.5708) - 1) * -3.41423));
      mx = Math.max(-1, Math.min(1, fwd * k));
      my = Math.max(-1, Math.min(1, right * k));
    }
    const layers = [];
    // [R 180346b95] the tier's lower body sequence sits underneath at cycle 0
    const lower = a.lowerBody ? c.seqForActivity(a.lowerBody) : null;
    if (lower) { const [px, py] = c.blendFor(lower, mx, my); layers.push({ seq: lower, cycle: 0, weight: 1, px, py }); }
    const [px, py] = c.blendFor(a.seq, mx, my);
    layers.push({ seq: a.seq, cycle, weight: 1, px, py });
    const bones = c.boneMatrices(c.evalLayers(layers), entityMatrix(p.origin, [0, p.yaw, 0]), { pitch: this.aimPitch(p.pitch), yaw: p.yaw });
    const m = bones[c.root.boneByName.get('sword_grip')];
    const fwd = [m[0], m[4], m[8]], pos = [m[3], m[7], m[11]];
    const grip = cv.f('bb_tracer_default_grip_offset'), L = Math.trunc(cv.f('bb_tracer_default_length'));
    // [R 18038603f] the server stores both ends as whole units
    return { base: add(pos, scale(fwd, grip)).map(Math.trunc), tip: add(pos, scale(fwd, grip + L)).map(Math.trunc) };
  }

  // [R 180389b77]
  aimPitch(pitch) {
    const cv = this.cv;
    if (!cv.f('bb_tracer_pitchaiming_enable')) return 0;
    const v = pitch * cv.f('bb_tracer_pitchaiming_scale'), mn = cv.f('bb_tracer_pitchaiming_min');
    return v < mn ? mn : Math.min(cv.f('bb_tracer_pitchaiming_max'), v);
  }

  // [R 180385f70] appends a sample, keeping 20, and boxes it with the one before for the clash test
  pushBlade(p, cycle) {
    const a = p.act, seg = this.bladeSample(p, cycle), ring = a.bladeRing;
    ring.push(seg);
    if (ring.length > 20) ring.shift();
    if (ring.length >= 2) seg.box = this.bladeBox(ring[ring.length - 2], seg);
    a.trNew++;
  }

  // [R 180386145] The swept blade between two samples, as an oriented box. x runs along the blade and z along the swing.
  bladeBox(prev, cur) {
    const mid = (s) => scale(add(s.base, s.tip), 0.5);
    const mp = mid(prev), sweep = sub(mid(cur), mp);
    const center = add(mp, scale(sweep, 0.5));
    const along = normOr(add(normOr(sub(prev.tip, prev.base)), normOr(sub(cur.tip, cur.base))));
    const left = normOr(cross(sweep, along));
    const up = cross(along, left), right = scale(left, -1);
    const mn = [0, 0, 0], mx = [0, 0, 0];
    for (const q of [cur.tip, prev.tip, cur.base, prev.base]) {
      const d = sub(q, center);
      const v = [dot(d, along), dot(d, right), dot(d, up)];
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
    }
    const side = this.cv.f('bb_tracer_parry_bloat_side');
    mn[0] -= side; mn[1] -= side; mx[1] += side;
    mx[0] += this.cv.f('bb_tracer_parry_bloat_up');
    mx[2] += this.cv.f('bb_tracer_parry_bloat_fwd');
    return { center, along, sweepDir: normOr(sweep), mn, mx };
  }

  // [R 180388570] The server's clock is the sequence's own rate from the release, paused while frozen. Samples come at the
  // script's cycles; after the last one, every tick until the extension runs out. Those only count for clashes.
  updateTracer(p) {
    const a = p.act;
    if (a.trDone || !a.tracer) return;
    const ext = this.cv.f('bb_tracer_parry_extension_enabled');
    const prev = a.trCycle;
    if (prev < 1) a.trCycle = Math.min(1, prev + (a.dur > 0 ? TICK / a.dur : 1));
    const cur = a.trCycle;
    if (a.trCount <= 0) {
      if (ext && a.trExt > 0) a.trExt -= TICK; else { a.trDone = true; return; }
    }
    for (const key of a.tracer) {
      if (key > prev && key <= cur) { this.pushBlade(p, key); a.trCount--; }
    }
    if ((prev >= 1 || cur >= 1) && a.trCount > 0) a.trCount = 0;
    else if (a.trCount === 0 && ext) this.pushBlade(p, cur);
    // [R 180388c60] a clash first, then hits
    if (this.cv.f('bb_tracer_parry_enabled')) {
      const opp = this.findClash(p);
      if (opp) { this.applyClash(p, opp); return; }
      const guard = this.findGuard(p);
      if (guard) { this.applyGuard(p, guard); return; }
    }
    this.collectHits(p);
  }

  // [R 1803893bd, 18034b3a0, 1803873e0] A fighter in Guard holds a box at the sword grip. It has to be nearer the attacker's
  // eye than the fighter's own. The box is passed along with its back corner in both slots, so it reaches past the grip by
  // length_back and has a radius of 2*width. [I] its second axis is never filled in by the game; the blade's stands in.
  findGuard(p) {
    const ring = p.act.bladeRing, cv = this.cv;
    for (const q of this.players) {
      if (q === p || !q.alive || q.act?.id !== 2 || !q.act.seq) continue;
      const d = sub(p.origin, q.origin);
      if (dot(d, d) > 90000) continue;
      const c = this.char(q);
      const bones = c.boneMatrices(c.evalLayers([{ seq: q.act.seq, cycle: 0, weight: 1 }]), entityMatrix(q.origin, [0, q.yaw, 0]), { pitch: this.aimPitch(q.pitch), yaw: q.yaw });
      const m = bones[c.root.boneByName.get('sword_grip')];
      const center = [m[3], m[7], m[11]], along = [m[0], m[4], m[8]];
      const eye = (f) => [f.origin[0], f.origin[1], f.origin[2] + 64];
      const toGuard = sub(center, eye(p)), toEye = sub(eye(q), eye(p));
      if (dot(toGuard, toGuard) > dot(toEye, toEye)) continue;
      const w = cv.f('bb_guard_obb_width'), back = -cv.f('bb_guard_obb_length_back');
      const box = { center, along, sweepDir: along, mn: [back, -w, -w], mx: [back, -w, -w] };
      for (let i = ring.length - 1; i >= 1; i--) if (ring[i].box && this.boxesClash(p, ring[i].box, box)) return q;
    }
    return null;
  }

  // [R 18034b5c0] The guard takes the interrupt and both are pushed apart, by the attacker's stance. The swing itself carries on.
  applyGuard(p, q) {
    const cv = this.cv, st = p.act.stanceType;
    const [name, push] = st === 0 ? ['balanced', 0.3] : st === 2 ? ['heavy', 0.7] : ['fast', 0.2];
    const lock = cv.f(`bb_guard_recovery_${name}`), kb = cv.f(`bb_guard_knockback_${name}`) * push;
    const d = norm([q.origin[0] - p.origin[0], q.origin[1] - p.origin[1], 0]);
    this.startAction(q, 'Interrupt', { force: true, lock, anim: 'ACT_BB_PARRY_UPPER' });
    q.blockCooldown = lock + cv.f('bb_guard_delay');
    q.vel = [d[0] * kb, d[1] * kb, q.vel[2]];
    p.vel = [-d[0] * kb, -d[1] * kb, p.vel[2]];
    const hs = cv.f('bb_guard_hitstop');
    if (hs > 0) { p.hitstop = hs; q.hitstop = hs; }
    p.lastHitTime = this.time;
    this.emit({ type: 'guarded', attacker: p.id, defender: q.id, dir: this.swingDir(p, q), pos: add(q.origin, [0, 0, 40]) });
  }

  // [R 1803890c0] Newest samples first against the opponent's, within 300 units. Only a live tracer on the other side counts.
  findClash(p) {
    const mine = p.act.bladeRing;
    for (const q of this.players) {
      if (q === p || !q.alive || !q.isSwinging() || !q.act.bladeRing?.length || q.act.trDone) continue;
      const d = sub(p.origin, q.origin);
      if (dot(d, d) > 90000) continue;
      const theirs = q.act.bladeRing;
      for (let i = mine.length - 1; i >= 1; i--) for (let j = theirs.length - 1; j >= 1; j--) {
        if (mine[i].box && theirs[j].box && this.boxesClash(p, mine[i].box, theirs[j].box)) return q;
      }
    }
    return null;
  }

  // [R 180389580] Each box reduces to a segment and a radius of 2*sqrt(y*z); a foil doubles its own radius.
  // They clash if the segments pass within the larger of the two.
  boxesClash(p, a, b) {
    let ra = 2 * Math.sqrt(a.mx[1] * a.mx[2]);
    const rb = 2 * Math.sqrt(b.mx[1] * b.mx[2]);
    if (String(p.sword || this.data.charSword[p.character]).toLowerCase() === 'foil') ra *= 2;
    const seg = (s, r) => [add(s.center, scale(s.along, s.mx[0] - r)), add(s.center, scale(s.sweepDir, s.mn[0] + r))];
    const [a0, a1] = seg(a, ra), [b0, b1] = seg(b, rb);
    const close = closestOnSegments(a0, a1, b0, b1);
    if (!close) return false;
    return Math.hypot(close[0][0] - close[1][0], close[0][1] - close[1][1], close[0][2] - close[1][2]) < Math.max(ra, rb);
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

  // [R 180387640] Newest samples first, at least max(new samples, bb_tracer_max_hit_tests + 1) of them. Each traces
  // base to tip, and if that is clear, the previous tip to this tip, so a fast blade can't step over a fighter.
  // Both are bb_tracer_thickness hull traces. The engine only tests hitboxes for true rays [R engine.dll 180257d40],
  // so these hit the fighter's bounding box rather than the model's hitboxes.
  // [R 180388e18] Testing stops once the script's samples are used up, so its last sample never hits.
  // [R 180388de2] Further hits wait multihitRate * bb_timebetweenhits.
  collectHits(p) {
    const cv = this.cv, thick = cv.f('bb_tracer_thickness');
    const a = p.act, sw = this.sword(p), ring = a.bladeRing;
    const fresh = a.trNew;
    a.trNew = 0;
    if (a.trCount <= 0 || ring.length < 2) return;
    const rate = num(a.dir & 1 ? sw.multihitratesidex : sw.multihitrateforwardx, 1) * cv.f('bb_timebetweenhits');
    if (p.lastHitTime > 0 && this.time - p.lastHitTime < rate) return;
    const box = [-thick, -thick, -thick], boxMax = [thick, thick, thick];
    const tests = Math.min(20, Math.max(fresh - 1, cv.f('bb_tracer_max_hit_tests'))) + 1;
    for (let i = ring.length - 1, n = 0; i >= 0 && n < tests; i--, n++) {
      const s = ring[i];
      const w = this.bsp.traceBox(s.base, s.tip, box, boxMax, 1);
      if (this.bladeTrace(p, s.base, s.tip, w, thick)) return;
      if (w.fraction === 1 && i > 0) {
        const from = ring[i - 1].tip, w2 = this.bsp.traceBox(from, s.tip, box, boxMax, 1);
        if (this.bladeTrace(p, from, s.tip, w2, thick)) return;
      }
    }
  }

  // One trace: whichever it reaches first of a fighter's bounding box or the world
  bladeTrace(p, from, to, w, thick) {
    const reach = w.startsolid ? 1 : w.fraction;
    for (const v of this.players) {
      if (v === p || !v.alive) continue;
      const t = segHitT(from, to, add(v.origin, HULL_MIN), add(v.origin, HULL_MAX), thick);
      if (t < 0 || t > reach) continue;
      // [R 180372f47] a fighter in this action can't be hit
      if (v.act?.id !== 30) { p.lastHitTime = this.time; this.resolveHit(p, v, add(from, scale(sub(to, from), t))); }
      return true;
    }
    // [R 180372fd2] the world only interrupts a grounded swing, 20 units or more above the feet
    if (this.cv.f('bb_tracer_world_interrupt_enabled') && !p.act.worldHit && w.fraction < 1 && !w.startsolid && p.onGround && w.endpos[2] - p.origin[2] >= 20) {
      p.act.worldHit = true;
      this.emit({ type: 'world_hit', id: p.id, pos: w.endpos, normal: w.normal });
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
    this.emit({ type: result === C.HIT_BLOCKED ? 'blocked' : result === C.HIT_GUARD_BROKEN ? 'break_block' : 'hit', attacker: att.id, victim: vic.id, damage: Math.trunc(dmg.damage), tier: a.tier, stance: a.stanceType, dir: this.swingDir(att, vic), pos });
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
      if (a.upperBody) {
        // Upper-body actions leave locomotion running, or use the action's own lower body.
        if (a.lowerBody) base = a.lowerBody;
        if (a.anim) { upper = a.anim; upperCycle = a.dur > 0 ? a.cycle : a.t % 1; }
      } else if (a.anim) {
        base = a.anim;
        baseCycle = a.dur > 0 ? a.cycle : a.t % 1;
        if (a.lowerBody && a.anim !== a.lowerBody) { base = a.lowerBody; upper = a.anim; upperCycle = baseCycle; }
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
    const td = p.touchdown;
    const touch = td && td.weight > 0 ? [td.anim, 1 - Math.max(0, td.t) / td.total, td.weight] : null;
    return { base, baseCycle, upper, upperCycle, mx, my, speed, armsFrom, charge, land, legs, touch };
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
  const touch = an.touch ?? an.tl;
  if (touch) { const ts = c.seqForActivity(touch[0]); if (ts) out.push({ seq: ts, cycle: touch[1], weight: touch[2], px: 0.5, py: 0.5 }); }
  const land = an.land ?? an.ld;
  if (land && land[1] > 0) out.push({ seq: c.seqForActivity('ACT_BB_JUMP_LAND'), cycle: land[0], weight: land[1], px: 0.5, py: 0.5 });
  const legs = an.legs ?? an.lg;
  if (legs > 0) out.push({ seq: c.seqForActivity('ACT_BB_JUMP_LEGS'), cycle: 0, weight: legs, px: 0.5, py: 0.5 });
  return out;
}

const fnum = (v) => (v === undefined || v === null ? null : Math.fround(typeof v === 'number' ? v : parseFloat(v)));
const fnumOpt = fnum;
const inum = (v) => (v === undefined || v === null ? null : parseInt(v, 10));

const normOr = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
// [R 1803880a0] Closest points of the two lines, each then clamped into its segment's bounds. Null if near parallel or too short.
function closestOnSegments(p1, p2, p3, p4) {
  const p13 = sub(p1, p3), p43 = sub(p4, p3), p21 = sub(p2, p1);
  if (Math.abs(p43[0]) < 0.01 && Math.abs(p43[1]) < 0.01 && Math.abs(p43[2]) < 0.01) return null;
  if (Math.abs(p21[0]) < 0.001 && Math.abs(p21[1]) < 0.01 && Math.abs(p21[2]) < 0.01) return null;
  const d1343 = dot(p13, p43), d4321 = dot(p43, p21), d1321 = dot(p13, p21), d4343 = dot(p43, p43), d2121 = dot(p21, p21);
  const denom = d2121 * d4343 - d4321 * d4321;
  if (Math.abs(denom) < 0.01) return null;
  const mua = (d1343 * d4321 - d1321 * d4343) / denom, mub = (d1343 + d4321 * mua) / d4343;
  const clamp = (v, a, b) => v.map((x, k) => Math.min(Math.max(a[k], b[k]), Math.max(Math.min(a[k], b[k]), x)));
  return [clamp(add(p1, scale(p21, mua)), p1, p2), clamp(add(p3, scale(p43, mub)), p3, p4)];
}

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
    this.timer = 0; this.round = 0; this.wins = {}; this.results = []; this.fighters = []; this.winner = null; this.last = null;
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
    this.round = 0; this.winner = null; this.results = [];
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
    this.results.push(winner?.id ?? null);
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
