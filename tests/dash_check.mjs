// The charge dash: when it's allowed, what it does, and the vulnerable time after it.
// Usage: node tests/dash_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
await assets.preload('knight');
const bsp = new BSP(readFileSync(G + 'maps/duel_temple.bsp'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };
const DELAY = cvars.f('bb_dash_delay'), MULT = cvars.f('bb_dash_damage_multiplier');

const fight = () => {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_temple' });
  const p = new Player(1, 'A', 'knight'), q = new Player(2, 'B', 'knight');
  w.addPlayer(p); w.addPlayer(q);
  for (let i = 0; i < 40 / TICK && w.duel.state !== 'fight'; i++) w.step();
  return { w, p, q };
};
const press = (w, p, b, ticks = 1) => { p.buttons = b; for (let i = 0; i < ticks; i++) w.step(); };
const seconds = (s) => Math.ceil(s / TICK);
// held past tier 2: what it takes for this sword
const tier2 = (w, p) => cvars.f('bb_charge_tier2_time') * Number(w.sword(p).chargetime ?? 1);
const charged = (w, p) => { press(w, p, IN.ATTACK, seconds(tier2(w, p)) + 3); return p.act; };

{ // too early: tier 1 won't do
  const { w, p } = fight();
  press(w, p, IN.ATTACK, seconds(tier2(w, p) * 0.5));
  check('charging at tier 1', p.act?.attack && p.act.phase === 'charge' && !p.act.chargeTier, p.act?.chargeTier);
  press(w, p, IN.ATTACK | IN.ROLL, 2);
  check('roll does nothing below tier 2', p.act?.attack && p.act.phase === 'charge' && p.act.name !== 'AirDash', p.act?.name);
  check('and costs no cooldown', p.dashCooldown === 0);
}
{ // the dash itself
  const { w, p } = fight();
  const a = charged(w, p);
  check('reached tier 2', a?.chargeTier === 1, a?.chargeTier);
  press(w, p, IN.ATTACK | IN.ROLL);
  check('roll dashes', p.act?.name === 'AirDash', p.act?.name);
  check('the charge is gone', !p.act?.attack);
  check('with the dash\'s own animation', p.act?.anim === 'ACT_BB_DASH_N', p.act?.anim);
  check('its cooldown is bb_dash_delay', Math.abs(p.dashCooldown - DELAY) < TICK * 2, p.dashCooldown);
  check('the roll cooldown starts too', Math.abs(p.moveCooldown - (Math.min(p.act.dur, p.act.lockDur) + 0.2)) < TICK * 2, p.moveCooldown);
  const from = [...p.origin];
  press(w, p, 0, seconds(0.2));
  check('it moves you', Math.hypot(p.origin[0] - from[0], p.origin[1] - from[1]) > 20, Math.hypot(p.origin[0] - from[0], p.origin[1] - from[1]));
}
{ // only its own cooldown stands in the way
  const { w, p } = fight();
  charged(w, p);
  p.moveCooldown = 5;
  press(w, p, IN.ATTACK | IN.ROLL);
  check('a roll cooldown doesn\'t stop it', p.act?.name === 'AirDash', p.act?.name);
}
{ // once per cooldown; a roll is still fine when that cooldown ends
  const { w, p } = fight();
  charged(w, p);
  press(w, p, IN.ATTACK | IN.ROLL);
  press(w, p, 0, seconds(1.2));
  check('dash over, cooldown running', !p.act && p.dashCooldown > 0, `${p.act?.name} ${p.dashCooldown}`);
  charged(w, p);
  check('charged again', p.act?.chargeTier === 1);
  press(w, p, IN.ATTACK | IN.ROLL, 2);
  check('no second dash on the cooldown', p.act?.attack && p.act.phase === 'charge', p.act?.name);
  // let the attack out, then wait it off
  press(w, p, 0, seconds(DELAY));
  check('the cooldown runs out', p.dashCooldown === 0, p.dashCooldown);
  for (let i = 0; i < 400 && p.act; i++) press(w, p, 0);
  check('settled', !p.act, p.act?.name);
  charged(w, p);
  press(w, p, IN.ATTACK | IN.ROLL);
  check('then it works again', p.act?.name === 'AirDash', p.act?.name);
}
{ // not in the air
  const { w, p } = fight();
  charged(w, p);
  p.onGround = false;
  check('no dash off the ground', !w.canChargeDash(p));
  p.onGround = true;
  check('on it, yes', w.canChargeDash(p));
  p.dashCooldown = 0.1;
  check('nor on cooldown', !w.canChargeDash(p));
  p.dashCooldown = 0;
  p.act.phase = 'swing';
  check('nor once it\'s swinging', !w.canChargeDash(p));
}

{ // the multiplier, and only during the cooldown
  const { w, p } = fight();
  check('no change off cooldown', w.dashDamage(p, 20) === 20);
  p.dashCooldown = 1;
  check('1.5x on it', w.dashDamage(p, 20) === 20 * MULT && MULT === 1.5, w.dashDamage(p, 20));
}
{ // a grab's slice
  const { w, p, q } = fight();
  const run = (cool) => {
    q.health = 100; q.alive = true; q.dashCooldown = cool;
    q.act = { kind: 'thrown' };
    p.act = { sliced: false, cycle: 1, sliceCycle: 0, throwVictim: q.id };
    w.updateThrow(p);
    return 100 - q.health;
  };
  const normal = run(0), after = run(2);
  check('a grab hurts more after a dash', after === Math.trunc(normal * MULT), `${normal} then ${after}`);
}
{ // throwables
  const { w, p, q } = fight();
  const star = () => ({ id: 9, type: Object.keys(data.throwables)[0], owner: q.id, pos: [p.origin[0] + 30, p.origin[1], p.origin[2] + 36] });
  p.viewYaw = 0;
  const run = (cool) => {
    p.health = 100; p.alive = true; p.act = null; p.dashCooldown = cool;
    w.starHit(star(), p);
    return 100 - p.health;
  };
  check('facing it, a fighter blocks a throwable', run(0) === 0);
  const hit = run(2), base = cvars.f('bb_throwable_damage_player');
  check('not on the dash\'s cooldown', hit > 0, hit);
  check('and it hurts more', hit === Math.trunc(base * MULT), `${hit} vs ${base}`);
}
{ // a real sword hit, through the whole hit path
  const hitFor = (cool) => {
    const { w, p, q } = fight();
    q.origin = [p.origin[0] + 40, p.origin[1], p.origin[2]];
    p.yaw = p.viewYaw = 0;
    q.yaw = q.viewYaw = 180;
    q.dashCooldown = cool;
    press(w, p, IN.ATTACK, 3);
    press(w, p, 0, 1);
    const hp = q.health;
    w.resolveHit(p, q, [q.origin[0], q.origin[1], q.origin[2] + 40]);
    return hp - q.health;
  };
  const normal = hitFor(0), after = hitFor(2);
  check('a sword connects', normal > 0, normal);
  check('and hurts 1.5x after a dash', after === Math.trunc(normal * MULT) || Math.abs(after - normal * MULT) <= 1, `${normal} then ${after}`);
}
{ // the preview goes with any other action
  const { w, p } = fight();
  check('previewing while idle', !!w.previewAttack(p));
  charged(w, p);
  check('and on the charge', !!w.previewAttack(p));
  press(w, p, IN.ATTACK | IN.ROLL);
  check('not during the dash', w.previewAttack(p) === null, JSON.stringify(w.previewAttack(p)));
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
