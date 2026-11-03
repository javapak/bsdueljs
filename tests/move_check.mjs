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
  // multi-hit: a sword's rate spaces out its hits, and a new attack isn't held back by the last one
  {
    const { w, p, q } = await setup(ch, 30);
    const sw = data.swordFor(ch);
    const gap = parseFloat(sw.multihitrateforwardx) * cvars.f('bb_timebetweenhits');
    p.yaw = 0;
    const seg = { base: [q.origin[0], q.origin[1], q.origin[2] + 60], tip: [q.origin[0], q.origin[1], q.origin[2] + 10] };
    p.act = { dir: 0, bladeRing: [seg, seg], stanceType: 0, tier: 0, def: {}, damage: 1, kbScale: 0, cycle: 0.5, lock: 1, attack: true, phase: 'swing' };
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
    const want = { block: 'Block', parry: 'Parry', guard: 'Guard', feint: 'Block' }[tech];
    check(w.blockActionName(p) === want, `${ch} ${type}: ${w.blockActionName(p)}, tech ${tech}`);
    p.buttons = IN.BLOCK; w.step(); p.buttons = 0;
    check(p.act?.name === want, `${ch} ${type} block action ${p.act?.name}`);
  }
}
console.log('swords', JSON.stringify(data.charSword));
console.log(`${checks - fails}/${checks} timing checks passed`);
process.exit(fails ? 1 : 0);
