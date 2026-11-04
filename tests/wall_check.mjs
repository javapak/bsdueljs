// Wall moves and throwables on a real map, driven through the input buttons.
// Usage: node tests/wall_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
await assets.preload('ryoku'); await assets.preload('knight');
const bsp = new BSP(readFileSync(G + 'maps/duel_practice_box.bsp'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };

const fresh = () => {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_practice_box' });
  const a = new Player(1, 'A', 'ryoku'), b = new Player(2, 'B', 'knight');
  w.addPlayer(a); w.addPlayer(b);
  for (let i = 0; i < 12 / TICK && w.duel.state !== 'fight'; i++) w.step();
  return { w, a, b };
};
const run = (w, seconds, each) => { for (let i = 0; i < seconds / TICK; i++) { each?.(i); w.step(); } };

// Stands a fighter 8 units from the nearest wall on +X or -X, looking at it; the other is parked far off
const atWall = (w, a, b) => {
  const o = a.origin, h = [[-13, -13, 0], [13, 13, 72]];
  for (const [yaw, dx] of [[0, 1], [180, -1]]) {
    const t = bsp.traceBox([o[0], o[1], o[2] + 1], [o[0] + dx * 4000, o[1], o[2] + 1], h[0], h[1]);
    if (t.fraction < 1 && Math.abs(t.normal[0]) > 0.9) {
      a.origin = [t.endpos[0] - dx * 8, o[1], o[2]];
      a.vel = [0, 0, 0]; a.yaw = a.viewYaw = yaw; a.pitch = 0; a.act = null; a.moveCooldown = 0;
      b.origin = [t.endpos[0] - dx * 500, o[1], o[2]];
      return dx;
    }
  }
  throw new Error('no wall');
};

{ // holding roll at a wall runs up it, and it runs its course: run, transition, slide, then free
  const { w, a, b } = fresh();
  const z0 = a.origin[2], dx = atWall(w, a, b);
  a.buttons = IN.ROLL; a.prevButtons = IN.ROLL;
  // Roll also started off the same button; a held Ctrl from a stand starts a roll first, so wait for the run
  let saw = new Set(), top = z0;
  run(w, 6, () => { if (a.act) saw.add(a.act.name); top = Math.max(top, a.origin[2]); if (a.act?.name === 'WallRun') { a.buttons = 0; } });
  check('runs up the wall', saw.has('WallRun'), [...saw]);
  check('gains height', top > z0 + 20, top - z0);
  check('moves on to the transition', saw.has('WallTransTo'), [...saw]);
  check('then the slide', saw.has('WallSlide'), [...saw]);
  check('ends on the ground, free', a.onGround && !a.act, [a.act?.name, a.origin]);
  void dx;
}

{ // jump during a run pushes off the wall, up, and away
  const { w, a, b } = fresh();
  const dx = atWall(w, a, b);
  a.buttons = IN.ROLL;
  for (let i = 0; i < 200 && a.act?.name !== 'WallRun'; i++) w.step();
  check('run starts for the jump test', a.act?.name === 'WallRun', a.act?.name);
  run(w, 0.25);
  a.buttons = IN.JUMP; a.prevButtons = 0;
  const vBefore = [...a.vel];
  w.step();
  check('becomes a wall flip', a.act?.name === 'WallFlip', a.act?.name);
  check('pushes away from the wall', a.vel[0] * dx < 0, [a.vel, vBefore]);
  check('and up', a.vel[2] > 0, a.vel);
  check('sets the wall delay', a.moveCooldown > 0.5, a.moveCooldown);
  a.buttons = 0;
  run(w, 3);
  check('lands free', a.onGround && !a.act, [a.act?.name]);
  check('landing clears the run count', a.wallRuns === 0, a.wallRuns);
}

{ // the count stops a sixth run and each run plays slower
  const { w, a, b } = fresh();
  atWall(w, a, b);
  a.buttons = IN.ROLL;
  for (let i = 0; i < 200 && a.act?.name !== 'WallRun'; i++) w.step();
  const first = a.act?.dur;
  a.act = null; a.moveCooldown = 0; a.wallRuns = 3; a.onGround = false;
  a.origin = [a.origin[0], a.origin[1], a.origin[2] + 40];
  w.step();
  check('a later run plays slower', a.act?.name === 'WallRun' && a.act.dur > first * 1.05, [a.act?.name, a.act?.dur, first]);
  a.act = null; a.moveCooldown = 0; a.wallRuns = 5; a.onGround = false; a.vel = [0, 0, 0];
  w.step();
  check('no sixth run', a.act?.name !== 'WallRun', a.act?.name);
}

const face = (a, b) => {
  const d = [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]], yaw = Math.atan2(d[1], d[0]) * 180 / Math.PI;
  a.yaw = a.viewYaw = yaw; a.pitch = 0;
};
const open = (w, a, b, gap) => {
  a.origin = [a.origin[0], a.origin[1], a.origin[2]];
  b.origin = [a.origin[0] - gap, a.origin[1], a.origin[2]];
  a.vel = [0, 0, 0]; b.vel = [0, 0, 0]; a.act = b.act = null; a.moveCooldown = 0; a.throwCooldown = 0; b.health = 100;
  face(a, b);
};

{ // E throws at the spawn delay; the star homes on a fighter facing away and hurts
  const { w, a, b } = fresh();
  open(w, a, b, 300);
  b.yaw = b.viewYaw = a.yaw; // facing away
  const ev = []; const emit = w.emit.bind(w); w.emit = (e) => { ev.push(e); emit(e); };
  a.buttons = IN.THROW;
  w.step();
  check('throw starts', a.act?.name === 'ThrowWeapon', a.act?.name);
  run(w, data.action ? 0.8 : 0.8, () => { b.vel = [0, 0, 0]; });
  check('nothing thrown before the delay', w.stars.length === 0, w.stars.length);
  run(w, 0.2);
  check('thrown at the delay', ev.some((e) => e.type === 'star_throw'), ev.map((e) => e.type));
  a.buttons = 0;
  run(w, 2, () => { b.origin = [a.origin[0] - 300, a.origin[1], a.origin[2]]; });
  const hit = ev.find((e) => e.type === 'star_hit');
  check('hits the fighter', hit?.what === 'player', JSON.stringify(hit));
  check('deals its damage', b.health === 100 - cvars.f('bb_throwable_damage_player'), b.health);
  check('star is gone', w.stars.length === 0, w.stars.length);
}

{ // facing it while idle catches it, for no damage
  const { w, a, b } = fresh();
  open(w, a, b, 300);
  face(b, a);
  const ev = []; const emit = w.emit.bind(w); w.emit = (e) => { ev.push(e); emit(e); };
  a.buttons = IN.THROW;
  run(w, 1.0); a.buttons = 0;
  run(w, 2, () => { b.origin = [a.origin[0] - 300, a.origin[1], a.origin[2]]; b.vel = [0, 0, 0]; });
  const hit = ev.find((e) => e.type === 'star_hit');
  check('blocked when facing it', hit?.what === 'blocked', JSON.stringify(hit));
  check('no damage when blocked', b.health === 100, b.health);
}

{ // let go between the cancelable time and the spawn delay: no star. A held one honours the delay afterwards.
  const { w, a, b } = fresh();
  open(w, a, b, 300);
  a.buttons = IN.THROW;
  run(w, cvars.f('bb_throwable_cancelable_min_time') + 0.01);
  a.buttons = 0;
  run(w, 0.3);
  check('letting go cancels it', w.stars.length === 0 && a.act?.name !== 'ThrowWeapon', [w.stars.length, a.act?.name]);
}

{ // thrown at nothing it hits the world
  const { w, a, b } = fresh();
  a.act = null; a.yaw = a.viewYaw = 0; a.pitch = -30; b.origin = [a.origin[0] - 2000, a.origin[1], a.origin[2]];
  const ev = []; const emit = w.emit.bind(w); w.emit = (e) => { ev.push(e); emit(e); };
  a.buttons = IN.THROW;
  run(w, 1.0); a.buttons = 0;
  run(w, 8);
  check('world hit or expired', ev.some((e) => e.type === 'star_hit' && e.what === 'world') || w.stars.length === 0, ev.map((e) => e.what));
  a.act = null; a.throwCooldown = 0;
  a.buttons = IN.THROW; run(w, cvars.f('bb_throwable_cancelable_min_time') + 0.01); a.buttons = 0; w.step();
  check('the delay holds off the next', a.throwCooldown > 0 && a.act?.name !== 'ThrowWeapon', [a.throwCooldown, a.act?.name]);
  a.buttons = IN.THROW; w.step();
  check('no throw during the delay', a.act?.name !== 'ThrowWeapon', a.act?.name);
}

{ // a loadout chosen in a match waits for the next round
  const { w, a } = fresh();
  a.nextLoadout = { character: 'knight', sword: 'katana', swordItem: 1234, look: [65] };
  check('nothing changes before the round', a.character === 'ryoku' && a.swordItem !== 1234, a.character);
  w.duel.startRound(false);
  check('applies when the round starts', a.character === 'knight' && a.sword === 'katana' && a.swordItem === 1234 && a.look[0] === 65, [a.character, a.sword, a.swordItem, a.look]);
  check('and only once', a.nextLoadout === null, a.nextLoadout);
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
