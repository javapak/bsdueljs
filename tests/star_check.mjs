// Thrown weapons against what server.dll does, in the real sim on real maps: where they leave from, how homing lets go, what stops them, who they can touch.
// Usage: node tests/star_check.mjs "<install>"
import { readFileSync, existsSync } from 'node:fs';
import { BSP, MASK_PLAYERSOLID } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
await assets.preload('ryoku'); await assets.preload('knight');
const maps = new Map();
const mapOf = (n) => { if (!maps.has(n)) maps.set(n, new BSP(readFileSync(`${G}maps/${n}.bsp`))); return maps.get(n); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const SPEED = cvars.f('bb_throwable_speed');
function fight(map = 'duel_temple') {
  const w = new World({ bsp: mapOf(map), data, cvars, assets, map, seed: 7 });
  const a = new Player(1, 'A', 'ryoku'), b = new Player(2, 'B', 'knight');
  a.look = data.defaultLook.ryoku; b.look = data.defaultLook.knight;
  w.addPlayer(a); w.addPlayer(b);
  for (let i = 0; i < 12 / TICK && w.duel.state !== 'fight'; i++) w.step();
  w.events.length = 0;
  return { w, a, b };
}
const face = (p, q) => { p.yaw = p.viewYaw = Math.atan2(q.origin[1] - p.origin[1], q.origin[0] - p.origin[0]) * 180 / Math.PI; p.pitch = 0; };
const star = (over) => ({ id: 900, owner: 1, arena: 0, type: 'ninjastar', pos: [0, 0, 0], vel: [SPEED, 0, 0], target: null, aim: [0, 0, 0], dir: [1, 0, 0], aimT: 0, homeT: 0, homeTotal: 0, steerT: 0, ...over });
const steps = (w, n) => { const ev = []; for (let i = 0; i < n; i++) { w.step(); ev.push(...w.events.splice(0)); } return ev; };

{ // [R 180383940] where it leaves from and what it aims at
  const { w, a, b } = fight();
  face(a, b);
  const z = a.origin[2];
  w.launchStar(a);
  const s = w.stars[0], d = Math.hypot(b.origin[0] - a.origin[0], b.origin[1] - a.origin[1], b.origin[2] + 36 - z - 48);
  check(s.pos[0] === a.origin[0] && s.pos[1] === a.origin[1] && s.pos[2] === z + 48, `leaves from the thrower's middle, 48 up: ${s.pos}`);
  check(s.target === b.id, 'picks the opponent in the crosshair as its target');
  check(Math.abs(s.aimT - d / SPEED * 0.9) < 1e-3, `aim time is 0.9 of the flight: ${s.aimT.toFixed(4)}`);
  check(Math.abs(s.homeTotal - ((d - 128) / 8960 + 0.2)) < 1e-6 && s.steerT === 1, `homing time is (distance - 128) / 8960 + 0.2: ${s.homeTotal.toFixed(4)}, with a second to steer`);
  check(Math.abs(Math.hypot(...s.vel) - SPEED) < 1e-6, 'leaves at full speed');
}
{ // a target that runs across is met where it's going
  const flight = (v, gap) => {
    const { w, a, b } = fight();
    b.origin = [a.origin[0] + gap, a.origin[1], a.origin[2]];
    a.yaw = a.viewYaw = 0; a.pitch = 0; b.yaw = b.viewYaw = 0; // back turned, so reaching them is a hit
    w.launchStar(a);
    b.vel = [0, v, 0];
    // only the star runs, so the target moves at exactly the velocity it reports
    for (let i = 0; i < 64 * 3 && w.stars.length; i++) { b.origin = [b.origin[0], b.origin[1] + v * TICK, b.origin[2]]; w.updateStars(); }
    return w.events.find((e) => e.type === 'star_hit')?.what;
  };
  check(flight(0, 300) === 'player', 'homing reaches someone standing still');
  check(flight(250, 600) === 'player', 'and someone running across at 250');
  check(flight(-300, 500) === 'player', 'or the other way at 300');
  check(flight(800, 400) !== 'player', 'but a target as fast as the star gets away');
}
{ // [R 1803850a0] once the target is well behind the way it set off, it lets go for good
  const { w, a, b } = fight();
  const x = b.origin.slice();
  const past = star({ owner: a.id, target: b.id, pos: [x[0] + 400, x[1], x[2] + 36], aimT: 1, homeT: 0.1, homeTotal: 0.5, steerT: 1 });
  w.starLetGo(past);
  check(past.target === null && past.aimT === 0, 'a target behind the star is dropped, along with the aiming');
  const ahead = star({ owner: a.id, target: b.id, pos: [x[0] - 400, x[1], x[2] + 36], aimT: 1, homeT: 0.1, homeTotal: 0.5, steerT: 1 });
  w.starLetGo(ahead);
  check(ahead.target === b.id, 'one still ahead is kept');
  b.alive = false;
  w.starLetGo(ahead);
  check(ahead.target === null, 'a dead one is dropped');
}
{ // [R 18038b070] the lead is the exact meeting point, not an estimate: fly straight at it and they arrive together
  const { w, a, b } = fight();
  const from = [0, 0, 0];
  b.origin = [1000, 0, -36]; b.vel = [0, 300, 0];
  const s = star({ owner: a.id, target: b.id, pos: from, vel: [SPEED, 0, 0], aim: [1000, 0, 0], homeT: 0, homeTotal: 1, steerT: 1, aimT: 1 });
  cvars.c.set('bb_throwable_angular_speed', 1e6);
  w.starSteer(s);
  cvars.c.delete('bb_throwable_angular_speed');
  const dx = s.vel[0] / SPEED, dy = s.vel[1] / SPEED, t = 1000 / s.vel[0], meet = [1000, 300 * t];
  check(Math.abs(dy * SPEED * t - meet[1]) < 1e-6 && Math.abs(Math.hypot(dx, dy) - 1) < 1e-6, `it heads for where the target will be: ${meet[1].toFixed(1)} units over, in ${t.toFixed(3)}s`);
}
{ // [R 180384b90, 1803855f0] with nothing to chase it steers for a second at most, then falls
  const { w, a } = fight();
  const s = star({ owner: a.id, pos: [0, 0, 0], vel: [SPEED, 0, 0], aim: [0, 100000, 0], aimT: 100, steerT: 1 });
  w.starSteer(s);
  check(s.vel[1] > 0 && Math.abs(Math.hypot(...s.vel) - SPEED) < 1e-6, 'steering turns it, at full speed');
  s.steerT = 0;
  const n = Math.hypot(...s.vel), z = s.vel[2];
  w.starSteer(s);
  check(Math.abs(s.vel[2] - (z / n * SPEED - TICK * cvars.f('bb_throwable_gravity'))) < 1e-6, 'out of steering time it takes gravity');
}
{ // [R 1803838e0] bb_throwable_life_duration only starts once it has landed: nothing runs out in the air
  const { w, a, b } = fight();
  b.origin = [99999, 99999, 99999];
  const o = [a.origin[0], a.origin[1], a.origin[2] + 60];
  const s = star({ owner: a.id, pos: o, vel: [0, 0, 1], aim: [o[0], o[1], o[2] + 1], aimT: 100, steerT: 100 });
  cvars.c.set('bb_throwable_speed', 1); cvars.c.set('bb_throwable_life_duration', 0.01);
  w.stars.push(s);
  steps(w, 32);
  check(w.stars.includes(s), 'still flying half a second past a life of 0.01');
  cvars.c.delete('bb_throwable_speed'); cvars.c.delete('bb_throwable_life_duration');
}
{ // [R 180384f00, 180373780] someone outside the match isn't there: it flies straight through and hurts nobody
  const { w, a, b } = fight();
  const by = new Player(3, 'Watcher', 'knight');
  by.reset(b.origin, 0); by.arena = 0;
  w.players.push(by);
  b.origin = [99999, 99999, 99999];
  const p = [by.origin[0] - 40, by.origin[1], by.origin[2] + 36];
  const s = star({ owner: a.id, pos: p, vel: [SPEED, 0, 0], aim: [p[0] + 1000, p[1], p[2]] });
  w.stars.push(s);
  const hit = w.starSweep(s, [p[0] + 80, p[1], p[2]], 8, 1);
  check(hit === null && !w.starEnemy(by, a.id, 0), 'one outside the duel is not in its way');
  check(w.starEnemy(a, 2, 0) && !w.starEnemy(a, 1, 0), 'the opponent is, and the thrower is not');
  check(w.starTarget(a) !== by, 'and it does not home on them');
}
{ // [R 180384050] player clips hold players, not throws. Finds a real one by comparing the two masks.
  let found = null;
  for (const m of ['duel_winter', 'duel_monastery', 'duel_temple', 'duel_castle', 'duel_district', 'duel_highrise']) {
    if (!existsSync(`${G}maps/${m}.bsp`)) continue;
    const b = mapOf(m);
    for (const e of b.entities.filter((x) => x.classname === 'berimbau_spawn' && x.origin)) {
      const o = e.origin.split(' ').map(Number); o[2] += 60;
      for (let deg = 0; deg < 360 && !found; deg += 3) for (const up of [0, 200, 500]) {
        const to = [o[0] + Math.cos(deg * Math.PI / 180) * 4000, o[1] + Math.sin(deg * Math.PI / 180) * 4000, o[2] + up];
        const clip = b.traceBox(o, to, [-1, -1, -1], [1, 1, 1], MASK_PLAYERSOLID), solid = b.traceBox(o, to, [-1, -1, -1], [1, 1, 1], 0x200400B);
        if (clip.fraction < solid.fraction - 0.02) { found = { m, o, to, clip }; break; }
      }
      if (found) break;
    }
    if (found) break;
  }
  check(!!found, found ? `found a player clip on ${found.m}` : 'found a player clip on some map');
  if (found) {
    const { w, a, b } = fight(found.m);
    b.origin = [99999, 99999, 99999];
    const d = [found.to[0] - found.o[0], found.to[1] - found.o[1], found.to[2] - found.o[2]], l = Math.hypot(...d), u = d.map((x) => x / l);
    const s = star({ owner: a.id, pos: found.o, vel: u.map((x) => x * SPEED), dir: u, aim: found.to, aimT: 100, steerT: 100 });
    w.stars.push(s);
    const wall = found.clip.fraction * l;
    let far = 0;
    for (let i = 0; i < 64 * 4 && w.stars.includes(s); i++) { far = Math.hypot(s.pos[0] - found.o[0], s.pos[1] - found.o[1], s.pos[2] - found.o[2]); steps(w, 1); }
    check(far > wall + 16, `flies on through the invisible wall at ${wall.toFixed(0)}: reached ${far.toFixed(0)}`);
  }
}
{ // [R 1803821c0] who reacts how
  const at = (label, setup, want) => {
    const { w, a, b } = fight();
    b.origin = [a.origin[0] + 100, a.origin[1], a.origin[2]]; a.vel = [0, 0, 0]; b.vel = [0, 0, 0]; b.dashCooldown = 0; b.act = null;
    b.yaw = b.viewYaw = 180;
    setup(b, w);
    const before = b.act?.name ?? null;
    const s = star({ owner: a.id, pos: [b.origin[0] - 24, b.origin[1], b.origin[2] + 36] });
    w.events.length = 0;
    w.starHit(s, b);
    const ev = w.events.splice(0).find((e) => e.type === 'star_hit');
    const now = b.act?.name ?? null, got = `${ev.what}, ${b.health === 100 ? 'unhurt' : 'hurt'}, ${now === before ? 'carries on' : now}`;
    check(got === want, `${label}: ${got}${got === want ? '' : ` (wanted ${want})`}`);
  };
  const charging = (b, w, phase) => {
    b.buttons = IN.ATTACK;
    for (let i = 0; i < 32 && !b.act?.attack; i++) w.step();
    b.buttons = 0; b.act.phase = phase; w.events.length = 0;
  };
  at('idle, facing it', () => {}, 'blocked, unhurt, AutoBlockThrowable');
  at('idle, back turned', (b) => { b.yaw = b.viewYaw = 0; }, 'player, hurt, InterruptUpper');
  at('rolling', (b, w) => { w.startAction(b, 'Roll', { force: true }); }, 'player, hurt, InterruptUpper');
  at('blocking, facing it', (b, w) => { w.startAction(b, 'Block', { force: true }); }, 'blocked, unhurt, AutoBlockThrowable');
  at('on the dash cooldown, facing it', (b) => { b.dashCooldown = 1; }, 'player, hurt, InterruptUpper');
  at('in Interrupt, back turned', (b, w) => { b.yaw = b.viewYaw = 0; w.startAction(b, 'Interrupt', { force: true }); }, 'blocked, unhurt, carries on');
  at('guarding, facing it', (b, w) => { w.startAction(b, 'Guard', { force: true }); }, 'blocked, unhurt, carries on');
  at('charging, facing it', (b, w) => charging(b, w, 'charge'), 'blocked, unhurt, carries on');
  at('charging, back turned', (b, w) => { charging(b, w, 'charge'); b.yaw = b.viewYaw = 0; }, 'player, hurt, carries on');
  at('mid swing, facing it', (b, w) => charging(b, w, 'swing'), 'player, hurt, carries on');
}
{ // [R 180382ec0] throws from two people knock each other away; [R 180381880] an enemy's swing bats one down
  const { w, a, b } = fight();
  const o = [a.origin[0], a.origin[1], a.origin[2] + 60];
  w.stars.push(star({ id: 901, owner: a.id, pos: o, aim: [o[0] + 1000, o[1], o[2]] }), star({ id: 902, owner: b.id, pos: [o[0] + 20, o[1], o[2]], vel: [-SPEED, 0, 0], aim: [o[0] - 1000, o[1], o[2]] }));
  const ev = steps(w, 1).filter((e) => e.type === 'star_hit');
  check(ev.length === 2 && ev.every((e) => e.what === 'blocked') && !w.stars.length, `two throws meeting take each other out: ${ev.map((e) => e.what)}`);
  const f = fight(), q = f.b;
  q.origin = [f.a.origin[0] + 300, f.a.origin[1], f.a.origin[2]];
  f.w.startAction(q, 'Roll', { force: true });
  const c = [q.origin[0] - 30, q.origin[1], q.origin[2] + 40];
  const box = { center: c, along: [0, 0, 1], sweepDir: [0, 1, 0], mn: [-20, -3, -3], mx: [20, 3, 3] };
  q.isSwinging = () => true; q.act.trDone = false; q.act.bladeRing = [{ box }, { box }];
  check(f.w.starBlade(star({ owner: f.a.id, pos: [c[0] - 10, c[1], c[2]] }), 10) === q, 'a blade within reach of bounds_tracer bats it down');
  check(f.w.starBlade(star({ owner: f.a.id, pos: [c[0] - 300, c[1], c[2]] }), 10) === null, 'one nowhere near it does not');
  check(f.w.starBlade(star({ owner: q.id, pos: [c[0] - 10, c[1], c[2]] }), 10) === null, "nor does the thrower's own");
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
