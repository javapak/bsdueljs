// Timing against the game's own data: animation clocks in real time at the recovered playback rates, whatever
// the snapshot rate, and shuffle, roll and grab using the original's timing and the sequences' own root motion.
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK, animLayers } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
let checks = 0, fails = 0;
const check = (ok, m) => { checks++; if (!ok) { fails++; console.log('FAIL', m); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const [spawn] = new World({ bsp: new BSP(readFileSync(`${G}maps/duel_practice_box.bsp`)), data, cvars, assets }).duel.pickSpawnPair();
const steps = (w, n, f) => { for (let i = 0; i < n; i++) { f?.(i); w.step(); } };
const setup = async (ch, foe) => {
  await assets.preload(ch);
  const w = new World({ bsp: new BSP(readFileSync(`${G}maps/duel_practice_box.bsp`)), data, cvars, assets });
  w.duel.update = () => {};
  const p = new Player(1, 'a', ch);
  p.reset([spawn.o[0], spawn.o[1], spawn.o[2] + 1], 0);
  w.players.push(p);
  let q = null;
  if (foe) { q = new Player(2, 'b', ch); q.reset([spawn.o[0] + foe, spawn.o[1], spawn.o[2] + 1], 180); w.players.push(q); }
  steps(w, 30);
  return { w, p, q, c: assets.character(ch) };
};
const shuffleJumps = [], upperBody = [];
const c_layers = (p, w, ch) => { const L = animLayers(assets.character(ch), w.animOf(p)); return L.every((l) => l.seq); };
// How many wraps of a looping clock happen in a second, whether or not anyone reads the animation state.
const wraps = (w, p, secs, before) => { let n = 0, last = p.moveCycle; steps(w, Math.round(secs / TICK), (i) => { before?.(i); if (p.moveCycle < last) n++; last = p.moveCycle; }); return n + p.moveCycle; };

for (const ch of Object.keys(data.characters)) {
  // idle: exactly one cycle per sequence length, read every tick, every other tick, or never
  {
    const { w, p, c } = await setup(ch);
    const dur = c.seqDuration(c.seqForActivity(w.locomotion(p).base));
    for (const [label, read] of [['never', null], ['every tick', () => w.animOf(p)], ['every other tick', (i) => { if (i % 2) w.animOf(p); }]]) {
      const r0 = p.moveCycle, got = wraps(w, p, 3, read) - r0;
      check(near(got, 3 / dur, 0.03), `${ch} idle read ${label}: ${got.toFixed(3)} cycles, wanted ${(3 / dur).toFixed(3)}`);
    }
  }
  // run at sv_maxspeed: playback rate is max(1, speed / sv_maxspeed) [R 18037d550, 18013cb70]
  {
    const { w, p, c } = await setup(ch);
    p.buttons = IN.FORWARD;
    steps(w, 40);
    const speed = Math.hypot(p.vel[0], p.vel[1]);
    const dur = c.seqDuration(c.seqForActivity(w.locomotion(p).base));
    check(speed > 170, `${ch} run speed ${speed.toFixed(0)}`);
    const r = w.locomotion(p).rate;
    check(near(r, 1, 0.02), `${ch} run rate ${r.toFixed(3)}`);
    const start = p.moveCycle; let total = 0, last = start;
    steps(w, 22, () => { w.animOf(p); const d = p.moveCycle - last; total += d < 0 ? d + 1 : d; last = p.moveCycle; });
    check(near(total * 3, 1 / dur, 0.1), `${ch} run cycle rate ${(total * 3).toFixed(3)} /s, wanted ${(1 / dur).toFixed(3)}`);
  }
  // shuffle and roll: lock from the script, travel from the sequence's own root motion over the lock
  for (const [name, bit] of [['Shuffle', IN.SHUFFLE], ['Roll', IN.ROLL]]) {
    const { w, p, c } = await setup(ch);
    const o0 = [...p.origin];
    p.buttons = bit | IN.FORWARD;
    w.step();
    p.buttons = 0;
    check(p.act?.name === name, `${ch} ${name} did not start: ${p.act?.name}`);
    if (p.act?.name !== name) continue;
    const a = p.act, lock = a.lockDur, seq = a.seq, dur = a.dur;
    const scale = a.moveScale;
    const expectMove = c.seqMovement(seq, Math.min(1, lock / dur))[0] * scale;
    let ticks = 0;
    while (p.act === a && ticks < 300) { w.step(); ticks++; }
    check(near((ticks + 1) * TICK, lock, 0.04), `${ch} ${name} lasted ${((ticks + 1) * TICK).toFixed(3)}, lock ${lock}`);
    const moved = Math.hypot(p.origin[0] - o0[0], p.origin[1] - o0[1]);
    check(moved >= expectMove * 0.9, `${ch} ${name} moved ${moved.toFixed(1)}, sequence gives ${expectMove.toFixed(1)}`);
    // the delay before the next one is min(sequence, lock) + 0.2 [R 180378f10]
    const wait = Math.min(dur, lock) + 0.2;
    let again = 0;
    p.buttons = bit;
    while (p.act?.name !== name && again < 200) { w.step(); again++; }
    check(near((again + ticks + 1) * TICK, wait, 0.05), `${ch} ${name} repeat after ${((again + ticks + 1) * TICK).toFixed(3)}, wanted ${wait.toFixed(3)}`);
  }
  // shuffle jump: an attack cancels the shuffle once the sequence has bb_shufflecancel_time left [R 18034c360], and a
  // charging attack allows the jump [R 1803462a0], so the shuffle's speed at the cancel carries into the air
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.SHUFFLE | IN.FORWARD; w.step();
    const shuffle = p.act;
    p.buttons = IN.FORWARD | IN.JUMP; w.step();
    check(p.onGround && p.act === shuffle, `${ch} jumped out of a shuffle without an attack`);
    p.buttons = IN.FORWARD | IN.ATTACK; w.step();
    check(p.act === shuffle, `${ch} attack cancelled the shuffle ${shuffle.t.toFixed(3)}s in, too early`);
    const window = cvars.f('bb_shufflecancel_time');
    let n = 0, atCancel = 0, peak = 0;
    while (p.act === shuffle && n < 66) { atCancel = Math.hypot(p.vel[0], p.vel[1]); peak = Math.max(peak, atCancel); w.step(); n++; }
    check(p.act?.attack && p.act.phase === 'charge', `${ch} attack did not cancel the shuffle: ${p.act?.name}`);
    const left = shuffle.dur - shuffle.t;
    check(left <= window && left > window - 2 * TICK, `${ch} shuffle cancelled with ${left.toFixed(3)}s of sequence left, window ${window}`);
    check(atCancel >= peak * 0.95, `${ch} cancel at ${atCancel.toFixed(0)} u/s misses the shuffle's ${peak.toFixed(0)} u/s`);
    p.buttons = IN.FORWARD | IN.ATTACK | IN.JUMP; w.step();
    check(!p.onGround && p.act?.attack, `${ch} no jump from the shuffle's charge: ground ${p.onGround}`);
    const fast = Math.hypot(p.vel[0], p.vel[1]);
    const plain = await setup(ch);
    plain.p.buttons = IN.FORWARD | IN.JUMP; plain.w.step();
    const slow = Math.hypot(plain.p.vel[0], plain.p.vel[1]);
    check(fast > slow + atCancel * 0.7, `${ch} shuffle jump ${fast.toFixed(0)} u/s lost the ${atCancel.toFixed(0)} u/s shuffle, plain ${slow.toFixed(0)} u/s`);
    shuffleJumps.push(`${ch} ${fast.toFixed(0)} vs ${slow.toFixed(0)}`);
  }
  // a roll cancels the same way, on its own, longer window
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.ROLL | IN.FORWARD; w.step();
    const roll = p.act;
    p.buttons = IN.FORWARD | IN.ATTACK;
    let n = 0;
    while (p.act === roll && n < 66) { w.step(); n++; }
    check(p.act?.attack && roll.dur - roll.t <= cvars.f('bb_rollcancel_time'), `${ch} roll cancel: ${p.act?.name} with ${(roll.dur - roll.t).toFixed(3)}s of sequence left`);
  }
  // a charge carried past bb_air_stance_height_min becomes the air stance's attack, keeping its charge [R 18037b6b0]
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.ATTACK; steps(w, 3);
    const ground = p.act.def;
    p.buttons = IN.ATTACK | IN.JUMP; w.step();
    p.buttons = IN.ATTACK;
    check(!p.onGround && p.act.def === ground, `${ch} charge changed on leaving the ground: ${p.act.name}`);
    const min = cvars.f('bb_air_stance_height_min');
    let n = 0;
    while (w.heightAboveGround(p) <= min && n < 66) { w.step(); n++; }
    const t = p.act.t;
    w.step();
    const air = data.attackFor(ch, 3, p.act.dir, p.act.comboIdx);
    if (air) check(p.act.def === air && p.act.stanceType === 3, `${ch} charge above ${min}u stayed ${p.act.name}`);
    check(near(p.act.t, t + TICK, 1e-6), `${ch} charge time ${p.act.t} after the swap, was ${t}`);
    p.buttons = 0; w.step();
    if (air) check(p.act.phase === 'swing' && p.act.stanceType === 3, `${ch} air release gave ${p.act.name} stance ${p.act.stanceType}`);
  }
  // a release under that height stays the ground attack: air cancelling
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.JUMP; w.step();
    p.buttons = IN.ATTACK; w.step();
    const def = p.act?.def;
    p.buttons = 0; w.step();
    check(p.act?.phase === 'swing' && p.act.def === def && p.act.stanceType !== 3 && !p.onGround, `${ch} air cancel: ${p.act?.name} stance ${p.act?.stanceType} ground ${p.onGround}`);
  }
  // a tier with action_upperbody and no move_lock swings over running legs [R 180346630, 180345941]
  for (const [stance, dir] of [[0, 1], [0, 3], [1, 1], [1, 3], [2, 1], [2, 3]]) {
    const def = data.attackFor(ch, stance, dir, 0);
    if (def?.tier1?.action_upperbody !== '1') continue;
    const { w, p } = await setup(ch);
    p.stance = stance;
    const side = dir === 1 ? IN.RIGHT : IN.LEFT;
    p.buttons = IN.ATTACK | side; w.step();
    p.buttons = side; w.step();
    check(p.act?.phase === 'swing' && p.act.upperBody && !p.act.moveLock && !p.act.animMove, `${ch} ${def.name} t1 flags: upper ${p.act?.upperBody} lock ${p.act?.moveLock} anim ${p.act?.animMove}`);
    steps(w, 20);
    const an = w.animOf(p);
    check(an.upper === def.tier1.animation && an.base === (def.tier1.animation_lowerbody ?? an.base), `${ch} ${def.name} t1 layers: base ${an.base} upper ${an.upper}`);
    check(Math.hypot(p.vel[0], p.vel[1]) > 50, `${ch} ${def.name} t1 could not move: ${Math.hypot(p.vel[0], p.vel[1]).toFixed(0)} u/s`);
    upperBody.push(`${ch} ${def.name}`);
  }
  // an air-cancelled ground attack still falls: only air_move stops gravity [R 18036f615]
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.JUMP; w.step();
    p.buttons = IN.ATTACK; w.step();
    p.buttons = 0; w.step();
    const a = p.act;
    check(a?.phase === 'swing' && !a.airMove, `${ch} air cancel started ${a?.name}`);
    let n = 0, top = p.origin[2], vz = p.vel[2];
    while (!p.onGround && n < 80) { const was = p.vel[2]; w.step(); if (!p.onGround && p.act === a) { check(p.vel[2] < was, `${ch} ${a.name} did not fall: vz ${was.toFixed(1)} to ${p.vel[2].toFixed(1)}`); } n++; }
    check(p.onGround, `${ch} ${a.name} air cancel still airborne after ${(n * TICK).toFixed(2)}s`);
    void top; void vz;
  }
  // an air charge that lands becomes the ground stance's attack again
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.JUMP; w.step(); p.buttons = 0;
    let n = 0;
    while (!p.airStance && n < 66) { w.step(); n++; }
    p.buttons = IN.ATTACK; w.step();
    check(p.act?.stanceType === 3, `${ch} attack in the air used stance ${p.act?.stanceType}`);
    n = 0;
    while (!p.onGround && n < 200) { w.step(); n++; }
    w.step();
    if (p.act?.phase === 'charge') check(p.act.stanceType === p.stance && !p.airStance, `${ch} landed charge stayed stance ${p.act.stanceType}`);
  }
  // a jump pressed just before landing still fires: the input buffer [R 18037b470]
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.JUMP; w.step(); p.buttons = 0;
    let n = 0;
    while (!(p.vel[2] < -400) && n < 200) { w.step(); n++; } // close enough to landing to outlast bb_jumpcooldown
    p.buttons = IN.JUMP; w.step(); p.buttons = 0;
    check(!p.onGround, `${ch} landed before the buffered press`);
    n = 0;
    while (!p.onGround && n < 200) { w.step(); n++; }
    const left = cvars.f('bb_jumpcooldown');
    let fired = false;
    for (let i = 0; i < Math.ceil((left + 0.05) / TICK); i++) { w.step(); if (!p.onGround) fired = true; }
    check(fired, `${ch} buffered jump did not fire after landing`);
    // a press older than the buffer is gone
    const late = await setup(ch);
    late.p.buttons = IN.JUMP; late.w.step(); late.p.buttons = 0;
    let m = 0;
    while (!late.p.onGround && m < 200) { late.w.step(); m++; }
    steps(late.w, Math.ceil(0.4 / TICK));
    check(late.p.onGround, `${ch} an old jump press fired again`);
  }
  // an air attack's animation carries it for its animation_move_duration with no gravity, then it falls [R 18036e810]
  {
    const { w, p, c } = await setup(ch);
    p.origin[2] += 250; p.onGround = false; p.vel = [0, 0, 0];
    let n = 0;
    while (!p.airStance && n < 10) { w.step(); n++; }
    p.buttons = IN.ATTACK; w.step();
    const a = p.act;
    check(a?.stanceType === 3, `${ch} high attack used stance ${a?.stanceType}`);
    w.releaseAttack(p, 2);
    p.buttons = 0;
    const window = parseFloat(a.tierDef.animation_move_duration ?? '-1');
    if (a.animMove && window > 0) {
      const o = [...p.origin], m = c.seqMovement(a.seq, Math.min(1, window / a.dur));
      const scale = a.moveScale;
      steps(w, Math.round(window / TICK));
      const fwd = Math.hypot(p.origin[0] - o[0], p.origin[1] - o[1]), dz = p.origin[2] - o[2];
      if (!p.onGround) {
        check(near(fwd, Math.hypot(m[0], m[1]) * scale, 12), `${ch} ${a.name} moved ${fwd.toFixed(1)}, animation gives ${(Math.hypot(m[0], m[1]) * scale).toFixed(1)}`);
        check(near(dz, m[2] * scale, 12), `${ch} ${a.name} rose ${dz.toFixed(1)}, animation gives ${(m[2] * scale).toFixed(1)}`);
        const z = p.origin[2];
        steps(w, 8);
        check(p.onGround || p.origin[2] < z - 5, `${ch} ${a.name} did not fall after its window`);
      }
    }
    n = 0;
    while (!p.onGround && n < 400) { w.step(); n++; }
    if (p.act === a && a.def.landing && a.airMove) {
      check(a.touchedDown && near(a.lockDur, parseFloat(a.tierDef.land_lock_duration ?? '0.5'), 1e-6), `${ch} ${a.name} landing lock ${a.lockDur}`);
      check(p.touchdown?.anim === a.def.landing, `${ch} ${a.name} landing not blending: ${p.touchdown?.anim}`);
      check(a.trCount <= 0 || !a.trDone, `${ch} ${a.name} stopped tracing on touching down with ${a.trCount} samples left`);
      const first = w.animOf(p).touch?.[2] ?? 0;
      w.step();
      const second = w.animOf(p).touch?.[2] ?? 0;
      check(second > first && second < 1, `${ch} ${a.name} landing weight ${first} then ${second}, wanted a fade in`);
      const left = a.lock;
      let m = 0;
      while (p.act === a && m < 300) { w.step(); m++; }
      check(near(m * TICK, left, 0.04), `${ch} ${a.name} ran ${(m * TICK).toFixed(3)}s after landing, lock ${left}`);
    }
  }
  // a stance key during a charge waits for the swing to start, and changes on the next tick after [R 18037bc4a]
  {
    const { w, p } = await setup(ch);
    p.stance = 0;
    p.buttons = IN.ATTACK; steps(w, 3);
    p.buttons = IN.ATTACK | IN.STANCE_HEAVY; w.step();
    check(p.stance === 0 && p.queuedStance === 2, `${ch} stance key mid-charge: stance ${p.stance} queued ${p.queuedStance}`);
    p.buttons = 0; steps(w, 2);
    check(p.stance === 2 && p.queuedStance === -1, `${ch} queued stance not applied: ${p.stance} queued ${p.queuedStance}`);
  }
  // holding attack starts the next attack as soon as the lock ends
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.ATTACK; steps(w, 1);
    const first = p.act;
    p.buttons = 0; w.step(); p.buttons = IN.ATTACK;
    let n = 0;
    while (p.act === first && n < 400) { w.step(); n++; }
    check(p.act?.attack && p.act !== first, `${ch} holding attack after a swing gave ${p.act?.name}`);
  }
  // grab whiffs: it never starts a throw, and the action lasts its script lock
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.GRAB; w.step(); p.buttons = 0;
    check(p.act?.name === 'Grab', `${ch} grab did not start: ${p.act?.name}`);
    const a = p.act; let t = 0;
    while (p.act === a && t < 300) { w.step(); t++; }
    check(a.anim === 'ACT_BB_GRAB', `${ch} whiffed grab changed animation to ${a.anim}`);
    check(near((t + 1) * TICK, 1.0, 0.04), `${ch} whiffed grab lasted ${((t + 1) * TICK).toFixed(3)}`);
  }
  // grab lands: throw sequence for its full length, damage on the sequence's event, victim stays down, then both recover
  {
    const { w, p, q, c } = await setup(ch, 34);
    p.buttons = IN.GRAB; w.step(); p.buttons = 0;
    const hp = q.health;
    let ticks = 1;
    while (q.act?.name !== 'Thrown' && ticks < 30) { w.step(); ticks++; }
    check(q.act?.name === 'Thrown', `${ch} grab did not catch: ${q.act?.name}`);
    check(near(ticks * TICK, cvars.f('bb_grab_delay'), 0.04), `${ch} grab connected at ${(ticks * TICK).toFixed(3)}`);
    check(p.act?.anim === 'ACT_BB_THROW' && q.act?.anim === 'ACT_BB_THROW_REACTION', `${ch} throw anims ${p.act?.anim} ${q.act?.anim}`);
    const dur = c.seqDuration(c.seqForActivity('ACT_BB_THROW'));
    const slice = p.act.sliceCycle * dur;
    check(p.act.sliceCycle > 0 && p.act.sliceCycle < 1, `${ch} slice event cycle ${p.act.sliceCycle}`);
    let t = 0, hit = null;
    while (p.act?.anim === 'ACT_BB_THROW' && t < 300) { w.step(); t++; if (hit === null && q.health < hp) hit = t * TICK; }
    check(hit !== null && near(hit, slice, 0.04), `${ch} throw damage at ${hit}, event at ${slice.toFixed(3)}`);
    check(hp - q.health === cvars.f('bb_throw_damage'), `${ch} throw did ${hp - q.health} damage`);
    check(near(t * TICK, dur, 0.04), `${ch} throw lasted ${(t * TICK).toFixed(3)}, sequence ${dur.toFixed(3)}`);
    let k = 0;
    const seen = new Set();
    while (q.act && k < 300) { seen.add(q.act.name); w.step(); k++; }
    check(seen.has('KneelingFalling') && q.kneeling, `${ch} victim after throw: ${[...seen]} kneeling ${q.kneeling}`);
  }
  // grab broken inside the window: no damage, both deflect, the victim recovers sooner
  {
    const { w, p, q } = await setup(ch, 34);
    p.buttons = IN.GRAB; w.step(); p.buttons = 0;
    let n = 0;
    while (q.act?.name !== 'Thrown' && n < 30) { w.step(); n++; }
    steps(w, 10);
    const hp = q.health;
    q.buttons = IN.GRAB; w.step(); q.buttons = 0;
    check(p.act?.name === 'GrabDeflect' && q.act?.name === 'GrabDeflect', `${ch} break: ${p.act?.name} ${q.act?.name}`);
    check(q.act.lockDur < p.act.lockDur, `${ch} break bonus: victim ${q.act.lockDur} grabber ${p.act.lockDur}`);
    steps(w, 66);
    check(q.health === hp, `${ch} broken grab still did damage`);
  }
  // a late break does nothing
  {
    const { w, p, q } = await setup(ch, 34);
    p.buttons = IN.GRAB; w.step(); p.buttons = 0;
    let n = 0;
    while (q.act?.name !== 'Thrown' && n < 30) { w.step(); n++; }
    steps(w, Math.ceil((cvars.f('bb_grab_break_window') + 0.05) / TICK));
    q.buttons = IN.GRAB; w.step(); q.buttons = 0;
    check(q.act?.name === 'Thrown', `${ch} late break worked: ${q.act?.name}`);
  }
  // tier 2 announces itself when reached; tier 3 on the release the timer forces at the same moment [R 180345d8a, 180346ced]
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.ATTACK;
    const sword = data.swordFor(ch), m = parseFloat(sword.chargetime);
    const at = (t) => Math.ceil(t / TICK);
    steps(w, at(cvars.f('bb_charge_tier2_time') * m) - 2);
    const tiers = () => w.events.filter((e) => e.type === 'charge_tier' && e.id === p.id);
    check(tiers().length === 0, `${ch} charge tier fired early`);
    steps(w, 4);
    check(tiers().length === 1 && tiers()[0].tier === 1 && p.act?.phase === 'charge', `${ch} tier 2 not announced: ${JSON.stringify(tiers())}`);
    steps(w, at(cvars.f('bb_charge_tier3_time') * m) - at(cvars.f('bb_charge_tier2_time') * m));
    const t3 = tiers().filter((e) => e.tier === 2);
    check(t3.length === 1 && p.act?.phase !== 'charge' && p.act?.tier === 2, `${ch} timer release: ${JSON.stringify(t3)} ${p.act?.phase} tier ${p.act?.tier}`);
    check(t3[0]?.soft === !(parseInt(sword.tier3shouldknockdown) > 0), `${ch} soft flag ${t3[0]?.soft} for tier3shouldknockdown ${sword.tier3shouldknockdown}`);
  }
  // charge pose follows charge progress: at half the tier 3 time it sits at the remapped cycle
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.ATTACK;
    const t3 = cvars.f('bb_charge_tier3_time') * parseFloat(data.swordFor(ch).chargetime);
    steps(w, Math.round(t3 * 0.5 / TICK));
    const an = w.animOf(p);
    check(!!an.charge, `${ch} no charge layer while charging`);
    if (an.charge) {
      const want = (0.5 - 0.05) / 0.95;
      check(near(an.charge[2], want, 0.03), `${ch} charge cycle ${an.charge[2].toFixed(3)}, wanted ${want.toFixed(3)}`);
    }
    p.buttons = 0;
    steps(w, Math.ceil(0.4 / TICK));
    check(!w.animOf(p).charge, `${ch} charge pose still showing 0.4s after release`);
  }
}
for (const ch of Object.keys(data.characters)) {
  // downed: stays down until the player chooses, and every choice from the original works
  const down = async () => { const s = await setup(ch); s.w.startAction(s.p, 'KneelingFalling', { force: true }); steps(s.w, 40); return s; };
  {
    const { w, p } = await down();
    check(p.kneeling && !p.act, `${ch} not downed after the ground hit: ${p.kneeling} ${p.act?.name}`);
    check(w.animOf(p).base === 'ACT_BB_KNEELING', `${ch} downed anim ${w.animOf(p).base}`);
    const z = p.origin[2];
    steps(w, 200);
    check(p.kneeling && Math.abs(p.origin[2] - z) < 0.5, `${ch} got up by itself or floated`);
    p.buttons = IN.JUMP; w.step(); p.buttons = 0;
    check(p.act?.name === 'KneelingRecover' && !p.kneeling, `${ch} space: ${p.act?.name}`);
    check(p.vel[2] <= 0, `${ch} space also jumped`);
  }
  {
    const { w, p } = await down();
    p.buttons = IN.ATTACK; w.step(); p.buttons = 0;
    check(p.act?.attack && p.act.phase === 'swing' && p.act.tier === 2 && p.act.anim === 'ACT_BB_RECOVERY_ATTACK' && !p.kneeling, `${ch} recovery attack: ${p.act?.name} ${p.act?.phase} ${p.act?.tier} ${p.act?.anim}`);
    check(p.act?.damage === 30, `${ch} recovery attack damage ${p.act?.damage}`);
  }
  {
    const { w, p } = await down();
    p.buttons = IN.BLOCK; w.step(); p.buttons = 0;
    check(p.act?.name === 'KneelParry' && p.act.anim === 'ACT_BB_INTERCEPT', `${ch} intercept: ${p.act?.name} ${p.act?.anim}`);
  }
  {
    const { w, p } = await down();
    const o = [...p.origin];
    p.buttons = IN.BACK; w.step(); p.buttons = 0;
    check(p.act?.name === 'KneelRoll' && p.act.anim === 'ACT_BB_RECOVER_BACK', `${ch} roll: ${p.act?.name} ${p.act?.anim}`);
    steps(w, 30);
    check(Math.hypot(p.origin[0] - o[0], p.origin[1] - o[1]) > 5, `${ch} downed roll didn't move`);
  }
  // knockdown: a tier 3 hit goes to the ground hit, never a held falling pose
  {
    const { w, p, q } = await setup(ch, 30);
    p.act = { stanceType: 0, tier: 2, def: {}, dir: 0 };
    w.applyReaction(p, q, 0, { tier3shouldknockdown: '1' }, p.act);
    check(q.act?.name === 'KneelingFalling' && q.act.anim === 'ACT_BB_GROUND_HIT', `${ch} knockdown: ${q.act?.name} ${q.act?.anim}`);
    p.act = null;
    let air = 0;
    q.origin[2] += 60; q.onGround = false;
    const z0 = q.origin[2]; steps(w, 20);
    check(q.origin[2] < z0 - 5, `${ch} knocked down in the air hung at ${q.origin[2] - z0}`);
  }
  // charge: slows to the dampened speed, then builds to the cap
  {
    const { w, p } = await setup(ch);
    p.yaw = p.viewYaw = 0;
    const sp = () => Math.hypot(p.vel[0], p.vel[1]);
    p.buttons = IN.FORWARD | IN.ATTACK;
    const curve = [];
    steps(w, 180, (i) => { if (i % 33 === 0) curve.push(Math.round(sp())); });
    const top = sp();
    check(curve[1] < 175, `${ch} charge speed after 0.5s ${curve}`);
    check(top <= cvars.f('bb_chargeaccel_maxspeed') + 1, `${ch} charge over the cap ${top}`);
    if (ch === 'knight') console.log('charge speed every 0.5s', curve.join(' '));
  }
  // same-side swings never side-cancel; the opposite side does, late enough [R 1803467c0]
  {
    const { w, p } = await setup(ch, 400);
    p.sword = 'longsword';
    p.buttons = IN.LEFT | IN.ATTACK; steps(w, 2); p.buttons = IN.LEFT; steps(w, 2);
    const a = p.act;
    if (a?.phase === 'swing' && a.dir === 3) {
      let replaced = false;
      for (let i = 0; i < a.lockDur / TICK - 2 && p.act === a; i++) { p.buttons = IN.LEFT | IN.ATTACK; w.step(); }
      replaced = p.act !== a && a.lock > 0;
      check(!replaced, `${ch} ${a.name} cancelled into its own side with ${a.lock.toFixed(2)}s of lock left`);
    }
    p.sword = undefined;
  }
  // feint: a real charge on the block button, its release has no tracer and a cut lock, then a cooldown [R 180349300, 180349550]
  {
    const { w, p } = await setup(ch, 400);
    p.sword = 'katana';
    const seen = [];
    p.buttons = IN.BLOCK; w.step();
    const a = p.act;
    check(a?.feint && a.id === 3 && a.phase === 'charge', `${ch} block button didn't start a feint: ${a?.name}`);
    if (a?.feint) {
      seen.push(...w.events.filter((e) => e.type === 'feint'));
      check(seen.length === 1, `${ch} feint event ${seen.length}`);
      steps(w, 10);
      check(a.phase === 'charge', `${ch} feint released while the button was held`);
      const combo = p.comboIdx;
      p.buttons = 0; steps(w, 2);
      check(p.act === a && a.phase === 'swing' && a.trDone && !a.bladeRing.length, `${ch} feint release: ${a.phase} done ${a.trDone} samples ${a.bladeRing?.length}`);
      const want = parseFloat(a.tierDef.lock_duration ?? '-1') * cvars.f(a.stanceType === 3 ? 'bb_feint_air_cancel_amount' : 'bb_feint_cancel_amount');
      check(near(a.lockDur, want, 1e-6), `${ch} feint lock ${a.lockDur}, wanted ${want}`);
      check(p.comboIdx === combo, `${ch} feint advanced the string`);
      let hits = 0; const orig = w.resolveHit; w.resolveHit = () => { hits++; };
      steps(w, Math.ceil(want / TICK) + 2);
      w.resolveHit = orig;
      check(p.act !== a && hits === 0, `${ch} feint hit ${hits}, action ${p.act?.name}`);
      check(near(p.blockCooldown, cvars.f('bb_feint_cooldown'), 0.1), `${ch} feint cooldown ${p.blockCooldown}`);
    }
    // a charge can't be feinted, but the start of its swing can [R 180374f3c]
    p.blockCooldown = 0; p.buttons = 0; steps(w, 4);
    p.buttons = IN.ATTACK; steps(w, 3);
    const charge = p.act;
    if (charge?.phase === 'charge') {
      p.buttons = IN.ATTACK | IN.BLOCK; w.step();
      check(p.act === charge && !charge.feint, `${ch} feint replaced a charge: ${p.act?.name}`);
      p.buttons = 0; w.step();
      check(charge.phase === 'swing', `${ch} tap didn't release`);
      if (charge.bladeRing.length <= 1 && charge.phase === 'swing') {
        p.blockCooldown = 0; p.buttons = IN.BLOCK; w.step();
        check(p.act === charge && charge.feint && charge.phase === 'swing', `${ch} feint didn't cut the swing: ${p.act?.name}`);
      }
    }
    // a left click, then the block button while it charges: held through the release, the swing becomes a feint
    {
      const { w: w2, p: q } = await setup(ch, 400);
      q.sword = 'katana';
      q.buttons = IN.ATTACK; steps(w2, 2);
      const c2 = q.act;
      q.buttons = IN.ATTACK | IN.BLOCK; w2.step();
      check(q.act === c2 && !q.act.feint, `${ch} feint during a charge`);
      q.buttons = IN.BLOCK; steps(w2, 2);
      check(w2.events.some((e) => e.type === 'feint' && e.id === q.id), `${ch} left click then block didn't feint: ${q.act?.name} ${q.act?.phase}`);
      // [R 180372010] it stays on the swing's animation, with the time spent off the cut lock, and the string restarts
      check(q.comboIdx === 0, `${ch} feint didn't reset the string: ${q.comboIdx}`);
      if (q.act?.feint) {
        const cut = parseFloat(q.act.tierDef.lock_duration ?? '-1') * cvars.f(q.act.stanceType === 3 ? 'bb_feint_air_cancel_amount' : 'bb_feint_cancel_amount');
        check(near(q.act.lockDur, cut, 1e-6) && q.act.lock < cut && q.act.phase === 'swing' && q.act.t > 0 && q.act.trDone, `${ch} feint out of a swing: lock ${q.act.lock} of ${q.act.lockDur}, t ${q.act.t}`);
      }
      q.buttons = 0; q.sword = undefined;
    }
    p.buttons = 0; p.sword = undefined;
  }
  // blade samples: pitch moves them within its clamp, and the ends are whole units [R 180389b77, 18038603f]
  {
    const { w, p } = await setup(ch, 400);
    p.buttons = IN.ATTACK; steps(w, 3); p.buttons = 0; steps(w, 2);
    check(p.act?.phase === 'swing', `${ch} no swing to sample: ${p.act?.phase}`);
    if (p.act?.phase === 'swing') {
      const at = (pitch) => { p.pitch = pitch; return w.bladeSample(p, 0.5); };
      const flat = at(0), up = at(-60), down = at(40);
      check(flat.tip.concat(flat.base).every(Number.isInteger), `${ch} blade ends aren't whole: ${flat.tip}`);
      check(up.tip.join() !== flat.tip.join() && down.tip.join() !== flat.tip.join(), `${ch} pitch doesn't move the blade: ${flat.tip}`);
      // looking down leans the body forward, looking up leans it back
      const c = w.char(p), I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], pose = c.evalLayers([{ seq: p.act.seq, cycle: 0.5, weight: 1 }]);
      const head = c.root.boneByName.get('valvebiped.bip01_head1');
      const lean = (pitch) => c.boneMatrices(pose, I, { pitch, yaw: 0 })[head][3];
      check(lean(40) > lean(0) && lean(-60) < lean(0), `${ch} spine leans the wrong way: ${lean(-60)} ${lean(0)} ${lean(40)}`);
      check(at(-89).tip.join() === up.tip.join() && at(89).tip.join() === down.tip.join(), `${ch} pitch isn't clamped`);
    }
  }
  // the tracer: hits stop with the script's last sample; samples carry on for the extension, for clashes only [R 180388a24, 180388e18]
  {
    const { w, p } = await setup(ch, 400);
    let hits = 0; const orig = w.resolveHit; w.resolveHit = () => { hits++; };
    p.buttons = IN.ATTACK; steps(w, 3); p.buttons = 0; steps(w, 2);
    const a = p.act, keys = a.tracer?.length;
    if (a?.phase === 'swing' && keys) {
      let count = 0, afterZero = 0, tested = 0;
      const collect = w.collectHits;
      w.collectHits = (pl) => { if (pl === p && a.trCount > 0) tested++; collect.call(w, pl); };
      for (let i = 0; i < 4 / TICK && p.act === a && !a.trDone; i++) {
        const before = a.bladeRing.length; w.step();
        if (a.trCount === 0 && p.act === a) { if (a.bladeRing.length !== before || a.bladeRing.length === 20) afterZero++; }
        count++;
      }
      w.collectHits = collect;
      check(a.trCount === 0 || p.act !== a, `${ch} samples left: ${a.trCount}`);
      if (p.act === a) {
        const ticks = cvars.f('bb_tracer_parry_extension_duration') / TICK;
        check(afterZero >= 1 && afterZero <= Math.ceil(ticks) + 2, `${ch} extension sampled ${afterZero} ticks, wanted about ${ticks}`);
      }
    }
    w.resolveHit = orig;
  }
  // clash boxes: blades through the same space clash, blades apart don't, and a foil's reach is wider [R 180389580]
  {
    const { w, p } = await setup(ch, 400);
    const box = (s0, s1) => w.bladeBox(s0, s1);
    const seg = (x, y0, y1) => ({ base: [x, y0, 40], tip: [x, y1, 40] });
    const a = box(seg(0, 0, 40), seg(4, 0, 40)), b = box({ base: [2, 20, 0], tip: [2, 20, 40] }, { base: [2, 24, 0], tip: [2, 24, 40] });
    p.sword = 'longsword';
    check(w.boxesClash(p, a, b), `${ch} crossing blades don't clash`);
    const far = box({ base: [200, 20, 0], tip: [200, 20, 40] }, { base: [200, 24, 0], tip: [200, 24, 40] });
    check(!w.boxesClash(p, a, far), `${ch} distant blades clash`);
    let edge = 0;
    for (let d = 0; d < 100; d++) { const off = box({ base: [d, 20, 0], tip: [d, 20, 40] }, { base: [d, 24, 0], tip: [d, 24, 40] }); if (w.boxesClash(p, a, off)) edge = d; }
    p.sword = 'foil';
    let foil = 0;
    for (let d = 0; d < 100; d++) { const off = box({ base: [d, 20, 0], tip: [d, 20, 40] }, { base: [d, 24, 0], tip: [d, 24, 40] }); if (w.boxesClash(p, a, off)) foil = d; }
    check(foil > edge, `${ch} foil reach ${foil} isn't over ${edge}`);
    if (ch === 'knight') console.log('clash reach longsword', edge, 'foil', foil);
    p.sword = undefined;
  }
  // multi-hit: a sword's rate spaces out its hits, and a new attack isn't held back by the last one
  {
    const { w, p, q } = await setup(ch, 30);
    const sw = data.swordFor(ch);
    const gap = parseFloat(sw.multihitrateforwardx) * cvars.f('bb_timebetweenhits');
    p.yaw = 0;
    const seg = { base: [q.origin[0], q.origin[1], q.origin[2] + 60], tip: [q.origin[0], q.origin[1], q.origin[2] + 10] };
    p.act = { dir: 0, bladeRing: [seg, seg], trCount: 1, trNew: 1, stanceType: 0, tier: 0, def: {}, damage: 1, kbScale: 0, cycle: 0.5, lock: 1, attack: true, phase: 'swing' };
    p.lastHitTime = -100;
    let hits = 0; const orig = w.resolveHit; w.resolveHit = () => { hits++; };
    w.collectHits(p, 1);
    check(hits === 1, `${ch} first hit: ${hits}`);
    w.collectHits(p, 1);
    check(hits === 1, `${ch} hit again inside the multi-hit gap`);
    w.time += gap + TICK;
    w.collectHits(p, 1);
    check(hits === 2, `${ch} no hit after the gap of ${gap}: ${hits}`);
    p.act.bladeRing = [seg]; p.lastHitTime = -100; hits = 0;
    w.collectHits(p, 1);
    check(hits === 0, `${ch} first sample of a swing hit`);
    w.resolveHit = orig;
  }
}
for (const ch of Object.keys(data.characters)) {
  // jump: air drag bleeds off horizontal speed, the air poses come from the original, and landing plays
  {
    const { w, p } = await setup(ch);
    p.buttons = IN.JUMP | IN.FORWARD;
    w.step(); p.buttons = IN.FORWARD;
    const v0 = Math.hypot(p.vel[0], p.vel[1]), o0 = [...p.origin];
    check(!p.onGround && p.vel[2] > 300, `${ch} no jump: ${p.vel[2]}`);
    w.step();
    const v1 = Math.hypot(p.vel[0], p.vel[1]);
    check(v1 < v0, `${ch} no air drag ${v0.toFixed(1)} -> ${v1.toFixed(1)}`);
    const bases = new Set(); let t = 0, peak = 0, sawLand = false;
    while (!p.onGround && t < 300) { bases.add(w.animOf(p).base); w.step(); t++; peak = Math.max(peak, p.origin[2] - o0[2]); }
    check(bases.has('ACT_BB_A_RUN') && bases.has('ACT_BB_BALANCED_JUMP') && !bases.has('ACT_BB_FALLING'), `${ch} air poses ${[...bases]}`);
    w.step();
    check(p.airState === 2 && w.animOf(p).land?.[1] > 0, `${ch} no landing layer: state ${p.airState}`);
    if (ch === 'knight') console.log(`jump: ${(t * TICK).toFixed(2)}s in the air, ${peak.toFixed(0)} high, ${Math.hypot(p.origin[0] - o0[0], p.origin[1] - o0[1]).toFixed(0)} travelled, top speed ${v0.toFixed(0)}`);
    check(c_layers(p, w, ch), `${ch} jump layers don't resolve`);
  }
  // no turning before the round starts
  {
    const { w, p } = await setup(ch);
    p.frozen = true; const y = p.yaw;
    p.viewYaw = y + 90; steps(w, 10);
    check(p.yaw === y, `${ch} turned while frozen: ${p.yaw}`);
    p.frozen = false; steps(w, 2);
    check(p.yaw !== y, `${ch} facing stuck after the round started`);
  }
  // swords belong to the player, not the character
  for (const type of ['longsword', 'katana', 'foil', 'jian', 'scimitar']) {
    const { w, p } = await setup(ch);
    p.sword = type;
    check(w.sword(p) === data.swordTypes[type], `${ch} ${type}: wrong sword`);
    const tech = data.swordTypes[type].blocktech.toLowerCase();
    if (tech === 'feint') { p.buttons = IN.BLOCK; w.step(); p.buttons = 0; check(p.act?.feint, `${ch} ${type} didn't feint: ${p.act?.name}`); continue; }
    const want = { block: 'Block', parry: 'Parry', guard: 'Guard' }[tech];
    check(w.blockActionName(p) === want, `${ch} ${type}: ${w.blockActionName(p)}, tech ${tech}`);
    p.buttons = IN.BLOCK; w.step(); p.buttons = 0;
    check(p.act?.name === want, `${ch} ${type} block action ${p.act?.name}`);
  }
}
console.log('swords', JSON.stringify(data.charSword));
console.log(`move during t1 swing: ${upperBody.join(', ')}`);
console.log(`shuffle jump takeoff speed vs plain: ${shuffleJumps.join(", ")}`);
console.log(`${checks - fails}/${checks} timing checks passed`);
process.exit(fails ? 1 : 0);
