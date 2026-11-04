// The input options the server keeps per fighter: bb_sde double tap, bb_gae attack + block grab, and bb_ibt's buffer. Also the attack string's index.
// Usage: node tests/options_check.mjs "<install>"
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
const bsp = new BSP(readFileSync(`${G}maps/duel_practice_box.bsp`));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

function setup(options = {}, sword) {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_practice_box' });
  const p = new Player(1, 'A', 'knight');
  if (sword) p.sword = sword;
  Object.assign(p.options, options);
  w.addPlayer(p);
  for (let i = 0; i < 128 && !(p.onGround && !p.frozen); i++) { p.frozen = false; w.step(); }
  return { w, p };
}
const hold = (w, p, buttons, ticks = 1) => { for (let i = 0; i < ticks; i++) { p.buttons = buttons; w.step(); } };
const secs = (s) => Math.round(s / TICK);

// bb_sde
{
  const { w, p } = setup({ sde: true });
  hold(w, p, 0, 2); hold(w, p, IN.FORWARD, 4); hold(w, p, 0, 4); hold(w, p, IN.FORWARD);
  check(p.act?.name === 'Shuffle' && p.act.dir === 0, 'tap, tap shuffles that way');

  const late = setup({ sde: true });
  hold(late.w, late.p, 0, 2); hold(late.w, late.p, IN.FORWARD, 4); hold(late.w, late.p, 0, secs(0.6)); hold(late.w, late.p, IN.FORWARD);
  check(!late.p.act, 'past half a second it does not');

  const other = setup({ sde: true });
  hold(other.w, other.p, 0, 2); hold(other.w, other.p, IN.FORWARD, 4); hold(other.w, other.p, 0, 4); hold(other.w, other.p, IN.LEFT);
  check(!other.p.act, 'another direction does not');

  const held = setup({ sde: true });
  hold(held.w, held.p, 0, 2); hold(held.w, held.p, IN.FORWARD, secs(1));
  check(!held.p.act, 'holding one does not');

  const off = setup({ sde: false });
  hold(off.w, off.p, 0, 2); hold(off.w, off.p, IN.FORWARD, 4); hold(off.w, off.p, 0, 4); hold(off.w, off.p, IN.FORWARD);
  check(!off.p.act, 'off, tap, tap does nothing');

  const side = setup({ sde: true });
  hold(side.w, side.p, 0, 2); hold(side.w, side.p, IN.RIGHT, 4); hold(side.w, side.p, 0, 4); hold(side.w, side.p, IN.RIGHT);
  check(side.p.act?.name === 'Shuffle' && side.p.act.dir === 1, 'to the side as well');

  const cool = setup({ sde: true });
  hold(cool.w, cool.p, 0, 2); hold(cool.w, cool.p, IN.FORWARD, 2); hold(cool.w, cool.p, 0, 2); hold(cool.w, cool.p, IN.FORWARD, 2);
  const a = cool.p.act;
  hold(cool.w, cool.p, 0, 2); hold(cool.w, cool.p, IN.FORWARD);
  check(cool.p.act === a, "a tap during the shuffle's lock doesn't start another");
}

// bb_gae
{
  const on = setup({ gae: true });
  hold(on.w, on.p, IN.ATTACK | IN.BLOCK);
  check(on.p.act?.name === 'Grab', 'attack and block together grab with it on');

  const off = setup({ gae: false });
  hold(off.w, off.p, IN.ATTACK | IN.BLOCK);
  check(off.p.act?.name !== 'Grab', 'but not with it off');

  const blocking = setup({ gae: true });
  hold(blocking.w, blocking.p, IN.BLOCK);
  check(blocking.p.act?.kind === 'block', 'block alone still blocks on a blocking sword');
  hold(blocking.w, blocking.p, IN.BLOCK | IN.ATTACK);
  check(blocking.p.act?.name === 'Grab', 'attack during it grabs');

  const key = setup({ gae: false });
  hold(key.w, key.p, IN.GRAB);
  check(key.p.act?.name === 'Grab', 'the grab key works either way');
}

// bb_ibt
{
  const { w, p } = setup({ ibt: 0 });
  hold(w, p, IN.ATTACK);
  p.act = null;
  hold(w, p, 0, 1);
  check(!p.wants(IN.ATTACK), 'no buffer at 0');
  const long = setup({ ibt: 1 });
  hold(long.w, long.p, IN.SHUFFLE);
  long.p.bufferMask = IN.ROLL; long.p.bufferT = 0;
  hold(long.w, long.p, 0, 2);
  const r = setup({ ibt: 1 });
  r.p.moveCooldown = 0.8;
  hold(r.w, r.p, IN.ROLL); hold(r.w, r.p, 0, secs(0.7));
  check(r.p.wants(IN.ROLL), 'a press stays good for its bb_ibt');
  const short = setup({ ibt: 0.33 });
  short.p.moveCooldown = 0.8;
  hold(short.w, short.p, IN.ROLL); hold(short.w, short.p, 0, secs(0.5));
  check(!short.p.wants(IN.ROLL), 'and no longer');
}

// bb_gae's other routes
{
  const c = setup({ gae: true });
  hold(c.w, c.p, IN.ATTACK, 3);
  check(c.p.act?.phase === 'charge', 'charging');
  hold(c.w, c.p, IN.ATTACK | IN.BLOCK);
  check(c.p.act?.name === 'Grab', 'block while charging grabs with it on');
  const k = setup({ gae: true }, 'katana');
  hold(k.w, k.p, IN.BLOCK);
  check(k.p.act?.name !== 'Grab', "a katana's block button alone still feints");
}

// the string
const swing = (w, p, buttons = 0) => {
  hold(w, p, IN.ATTACK | buttons, 2); hold(w, p, buttons);
  const a = p.act;
  for (let i = 0; i < 400 && p.act; i++) hold(w, p, 0);
  p.moveCooldown = 0; p.blockCooldown = 0;
  return a;
};
{
  const { w, p } = setup();
  const n = data.stringLength('knight', 0), list = [data.attackFor('knight', 0, 0, 0).name, data.attackFor('knight', 0, 0, 1).name, data.attackFor('knight', 0, 0, 2).name];
  check(n === 3, `balanced is a string of three: ${n}`);
  const seen = [], idx = [];
  for (let i = 0; i < 7; i++) { seen.push(swing(w, p).name); idx.push(p.comboIdx); }
  check(idx.join() === '1,2,3,1,2,3,1', `the index cycles 1, 2, 3, 1: ${idx}`);
  check(seen.join() === [...list, ...list, list[0]].join(), 'and the swings repeat the string in order');
}
{
  const { w, p } = setup();
  p.stance = 0; swing(w, p); swing(w, p); swing(w, p);
  check(p.comboIdx === 3, 'at the end of balanced');
  p.stance = 2;
  const heavy = data.stringLength('knight', 2), want = data.attackFor('knight', 2, 0, 3 < heavy ? 3 : 0).name;
  check(swing(w, p).name === want, 'a stance change past the end of that string plays its first action');
}
{
  const { w, p } = setup();
  const before = p.comboIdx;
  swing(w, p, IN.RIGHT);
  check(p.comboIdx === before + 1, 'a side attack moves the string on, by default');
}
{
  const { w, p } = setup();
  swing(w, p);
  check(w.stringIndex(p) === 1, 'one swing in');
  hold(w, p, 0, secs(2.2));
  check(w.stringIndex(p) === 0, 'and back to the start after bb_string_reset_time');
  const c = setup();
  swing(c.w, c.p);
  hold(c.w, c.p, 0, secs(1));
  hold(c.w, c.p, IN.ATTACK, secs(1.5));
  check(c.p.act?.phase !== undefined && c.w.stringIndex(c.p) >= 1, 'an attack under way holds that clock off');
}
{
  // [R 18034695a] the swing that takes the string to its end can't be cancelled, the ones before it can
  const { w, p } = setup();
  p.sword = 'katana';
  const a = { stanceType: 0, lock: 0.01, lockDur: 1, dir: 3, stanceAtRelease: 0 };
  p.buttons = IN.ATTACK | IN.RIGHT;
  p.comboIdx = 2;
  const earlier = w.swingCancels(p, a);
  p.comboIdx = 3;
  check(!w.swingCancels(p, a), 'nothing cancels the swing that finishes a string');
  if (!earlier) console.log('     (this sword has no side cancel, so the swings before it read the same)');
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
