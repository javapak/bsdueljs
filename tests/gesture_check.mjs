// Bow, flourish, taunt, sit and sheathe: what starts them, how long they run, what they block, and the pose they leave.
// Usage: node tests/gesture_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK, animLayers } from '../shared/sim.js';
import { matMul } from '../shared/mathx.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
for (const k of Object.keys(data.characters)) await assets.preload(k);
const bsp = new BSP(readFileSync(`${G}maps/duel_practice_box.bsp`));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

/** A new fighter standing alone on the map. */
function setup(character = 'knight') {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_practice_box' });
  const p = new Player(1, 'A', character);
  w.addPlayer(p);
  for (let i = 0; i < 128 && !(p.onGround && !p.frozen); i++) { p.frozen = false; w.step(); }
  return { w, p };
}
const run = (w, p, seconds, buttons = 0) => { for (let i = 0; i < Math.round(seconds / TICK); i++) { p.buttons = buttons; w.step(); } };
const tap = (w, p, bit) => { p.buttons = bit; w.step(); p.buttons = 0; };

for (const [bit, name] of [[IN.BOW, 'Bow'], [IN.FLOURISH, 'Flourish'], [IN.TAUNT, 'Taunt']]) {
  const { w, p } = setup();
  tap(w, p, bit);
  check(p.act?.name === name, `${name} starts`);
  const dur = p.act.dur;
  check(dur > 0 && p.act.moveLock && p.act.rotLock, `${name} has an animation (${dur.toFixed(2)}s) and locks move and turn`);
  const from = [...p.origin];
  run(w, p, dur - 2 * TICK, IN.FORWARD);
  check(p.act?.name === name && Math.hypot(p.origin[0] - from[0], p.origin[1] - from[1]) < 0.01, `${name} holds still until its end`);
  run(w, p, 4 * TICK);
  check(!p.act, `${name} ends with its sequence`);
}

// stance picks the flourish and taunt
{
  const { w, p } = setup();
  const seen = [];
  for (const s of [0, 1, 2]) { p.stance = s; p.act = null; tap(w, p, IN.TAUNT); seen.push(p.act?.anim); }
  check(seen.join() === 'ACT_BB_B_TAUNT,ACT_BB_R_TAUNT,ACT_BB_H_TAUNT', `taunt follows the stance: ${seen.join(' ')}`);
}

// a lock holds a gesture off, and a gesture doesn't start while another's lock runs
{
  const { w, p } = setup();
  tap(w, p, IN.ROLL);
  check(p.act?.name === 'Roll', 'roll started');
  tap(w, p, IN.BOW);
  check(p.act?.name === 'Roll', "a roll's lock holds off a bow");
}

// sit: holds until input, stands up on input, then ends
{
  const { w, p } = setup();
  tap(w, p, IN.SIT);
  check(p.act?.name === 'Sit', 'sit starts');
  run(w, p, 5);
  check(p.act?.name === 'Sit' && !p.act.standing && p.act.anim === 'ACT_BB_SIT_DOWN', 'sits as long as nothing is pressed');
  const an = w.animOf(p);
  check(an.base === 'ACT_BB_SIT_DOWN' && an.baseCycle === 1, 'sitting holds the last frame of the sit down');
  run(w, p, TICK, IN.FORWARD);
  check(p.act?.standing && p.act.anim === 'ACT_BB_SIT_UP', 'moving plays the sit up');
  const up = p.act.dur;
  run(w, p, up - 2 * TICK);
  check(p.act?.standing, 'locked through the sit up');
  run(w, p, 4 * TICK);
  check(!p.act, 'free after the sit up');

  const r = setup();
  tap(r.w, r.p, IN.SIT);
  run(r.w, r.p, 0.5, IN.FORWARD);
  check(r.p.act?.name === 'Sit' && !r.p.act.standing, "input during the sit down waits for its lock");

  const air = setup();
  air.p.onGround = false;
  air.w.dispatchGesture(Object.assign(air.p, { buttons: IN.SIT }));
  check(!air.p.act, 'no sitting in the air');
}

// sheathe
for (const k of Object.keys(data.characters)) {
  const { w, p } = setup(k);
  tap(w, p, IN.SHEATHE);
  const dur = p.sheatheDur, want = assets.character(k).seqDuration(assets.character(k).seqForActivity('ACT_BB_SHEATHE_BACK'));
  check(p.sheatheT > 0 && !p.sheathed && !p.act && Math.abs(dur - want) < 1e-6, `${k}: sheathing takes the back animation's ${dur.toFixed(2)}s, and isn't an action`);
  run(w, p, dur / 2, IN.FORWARD);
  check(Math.hypot(p.vel[0], p.vel[1]) > 50, `${k}: can walk while sheathing`);
  check(w.animOf(p).sheathe?.[1] > 0.4 && w.animOf(p).sheathe?.[1] < 0.6, `${k}: the layer's cycle tracks the timer`);
  run(w, p, dur / 2 + 3 * TICK);
  check(p.sheathed && p.sheatheT === 0, `${k}: sheathed when it runs out`);
  run(w, p, 1);
  check(w.animOf(p).sheathe === null && w.animOf(p).base === 'ACT_IDLE', `${k}: layer gone; idles on ACT_IDLE`);
}

// what's locked out
{
  const { w, p } = setup();
  p.onGround = true; tap(w, p, IN.SHEATHE);
  const trying = (bit) => { p.bufferMask = 0; p.bufferT = 0; p.act = null; tap(w, p, bit); return p.act?.name; };
  check(!trying(IN.ROLL), 'no roll during the sheathe');
  check(!trying(IN.GRAB), 'no grab during the sheathe');
  check(!trying(IN.BLOCK), 'no block during the sheathe');
  check(!trying(IN.THROW), 'no throw during the sheathe');
  check(!trying(IN.BOW), 'no gesture during the sheathe');
  check(trying(IN.SHUFFLE) === 'Shuffle', 'a shuffle is allowed during the sheathe');
  run(w, p, 4);
  check(p.sheathed, 'sheathed');
  p.act = null;
  check(!trying(IN.BLOCK), 'no block while sheathed');
  check(trying(IN.BOW) === 'Bow' && p.sheathed, 'bowing stays sheathed');
  run(w, p, 3);
  check(trying(IN.TAUNT) === 'Taunt' && p.sheathed, 'a taunt stays sheathed: allow_sheathed');
  run(w, p, 3);
  check(trying(IN.FLOURISH) === 'Flourish' && !p.sheathed, 'a flourish draws at once');
}

// an attack from the scabbard or partway draws immediately
{
  const a = setup();
  tap(a.w, a.p, IN.SHEATHE);
  run(a.w, a.p, 0.3);
  tap(a.w, a.p, IN.ATTACK);
  check(a.p.isAttacking() && a.p.sheatheT === 0 && !a.p.sheathed, 'attacking cuts off a sheathe');
  const b = setup();
  tap(b.w, b.p, IN.SHEATHE);
  run(b.w, b.p, 4);
  tap(b.w, b.p, IN.ATTACK);
  check(b.p.isAttacking() && !b.p.sheathed, 'attacking from sheathed draws at once');
}

// drawing: layer on at once and runs out. Only an instant draw plays the grip, which then fades
{
  const { w, p } = setup();
  tap(w, p, IN.SHEATHE);
  run(w, p, 4);
  tap(w, p, IN.SHEATHE);
  check(p.sheathed && p.sheatheT > 0 && w.animOf(p).sheathe?.[2] === 1 && /_UNSHEATHE_/.test(w.animOf(p).sheathe[0]), 'drawing shows its layer at once');
  const dur = p.sheatheDur;
  run(w, p, dur + 2 * TICK);
  check(!p.sheathed && !/_GRIP$/.test(w.animOf(p).sheathe?.[0] ?? ''), 'a full draw has no grip');
  run(w, p, 2);
  check(w.animOf(p).sheathe === null, 'then nothing');
  tap(w, p, IN.SHEATHE);
  run(w, p, 4);
  tap(w, p, IN.ATTACK);
  check(/_GRIP$/.test(w.animOf(p).sheathe?.[0] ?? ''), 'an attack from the scabbard plays the grip');
  p.buttons = 0;
  run(w, p, 3);
  check(w.animOf(p).sheathe === null, 'and it fades');
}

// A round's reset clears it
{
  const { w, p } = setup();
  tap(w, p, IN.SHEATHE);
  run(w, p, 4);
  p.reset(p.origin, p.yaw);
  check(!p.sheathed && p.sheatheT === 0, 'a reset draws the sword');
}

// Every character's pose stays sane through it all, and at the end of sheathing the hand brings the grip to the attachment the sword then jumps to.
for (const k of Object.keys(data.characters)) {
  const c = assets.character(k);
  for (const end of ['BACK', 'HIP']) {
    const s = c.seqForActivity(`ACT_BB_SHEATHE_${end}`);
    const pose = c.evalLayers([{ seq: c.seqForActivity('ACT_IDLE'), cycle: 0, weight: 1, px: 0.5, py: 0.5 }, { seq: s, cycle: 1, weight: 1, px: 0.5, py: 0.5 }]);
    const world = c.boneMatrices(pose, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    const grip = c.root.boneByName.get('sword_grip'), at = c.root.attachments.find((a) => a.name === `anim_sheathe_${end.toLowerCase()}`);
    const m = matMul(world[at.bone], at.local), g = world[grip];
    const gap = Math.hypot(m[3] - g[3], m[7] - g[7], m[11] - g[11]);
    check(gap < 3, `${k} ${end}: hand ends ${gap.toFixed(2)}u from the attachment`);
  }
  check(animLayers(c, { base: 'ACT_IDLE', baseCycle: 0, mx: 0, my: 0, sheathe: ['ACT_BB_SHEATHE_BACK', 0.5, 1] }).length >= 2, `${k}: the layer reaches animLayers`);
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
