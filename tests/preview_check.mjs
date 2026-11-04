// The attack preview: it names the attack a release really plays, its path, its fades and its target highlight.
// Usage: node tests/preview_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
import { TracerPreview, buildPath, smoothLine } from '../shared/tracerpreview.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
const CHARS = Object.keys(data.characters);
for (const c of CHARS) await assets.preload(c);
const bsp = new BSP(readFileSync(G + 'maps/duel_temple.bsp'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };

// In a live fight, so attacks can start
const fight = (character) => {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_temple' });
  const p = new Player(1, 'A', character), q = new Player(2, 'B', 'knight');
  w.addPlayer(p); w.addPlayer(q);
  for (let i = 0; i < 40 / TICK && w.duel.state !== 'fight'; i++) w.step();
  return { w, p, q };
};
const press = (w, p, b, ticks) => { p.buttons = b; for (let i = 0; i < ticks; i++) w.step(); };

for (const c of CHARS) {
  for (const stance of [0, 1, 2]) {
    for (const [dirName, key] of [['forward', IN.FORWARD], ['left', IN.LEFT], ['right', IN.RIGHT]]) {
      const { w, p } = fight(c);
      if (w.duel.state !== 'fight') { check(`${c} reached the fight`, false); continue; }
      w.setStance(p, stance);
      press(w, p, key, 2);
      const shown = w.previewAttack(p);
      if (!shown) continue;
      // tap: the shortest charge is tier 1, which is what's shown before you press
      press(w, p, key | IN.ATTACK, 2);
      const charging = w.previewAttack(p);
      for (let i = 0; i < 400 && p.act?.phase !== 'swing'; i++) press(w, p, key, 1);
      check(`${c} stance ${stance} ${dirName}: shown before the press is what swings`, p.act?.anim === shown.a, `${shown.a} vs ${p.act?.anim}`);
      check(`${c} stance ${stance} ${dirName}: and while charging`, charging?.a === p.act?.anim, `${charging?.a} vs ${p.act?.anim}`);
      check(`${c} stance ${stance} ${dirName}: and during the swing`, w.previewAttack(p)?.a === p.act?.anim);
    }
  }
}

{ // a longer charge shows the tier it would release at
  const { w, p } = fight('knight');
  press(w, p, IN.ATTACK, 2);
  const secs = cvars.f('bb_charge_tier3_time') * Number(w.sword(p).chargetime ?? 1) + 0.1;
  press(w, p, IN.ATTACK, Math.ceil(secs / TICK));
  const shown = w.previewAttack(p);
  check('a full charge shows tier 3', shown?.a === p.act.def.tier3?.animation, shown?.a);
  press(w, p, 0, 2);
  check('and that is what plays', p.act?.tier === 2 && p.act.anim === shown.a, `${p.act?.tier} ${p.act?.anim}`);
}
{ // down on a knee there's nothing to preview
  const { w, p } = fight('knight');
  p.kneeling = true;
  check('none while kneeling', w.previewAttack(p) === null);
}

{ // the smoothing: two passes on three points
  const out = smoothLine([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2);
  check('passes grow the line 2n-1', out.length === 9, out.length);
  check('keeps its ends', out[0].join() === '0,0,0' && out[8].join() === '10,10,0');
  const single = smoothLine([[0, 0, 0], [6, 0, 0]], 1);
  check('one pass is midpoints averaged', single.length === 3 && single[1].join() === '3,0,0', JSON.stringify(single));
}

const { w: wk, p: pk } = fight('knight');
const char = wk.char(pk), grip = char.root.boneByName.get('sword_grip');
const shown = wk.previewAttack(pk);
const cycles = data.tracers.knight[String(shown.a).toUpperCase()];
const path = buildPath(char, grip, shown.a, shown.l, cycles);
{ // the path
  check('there is one', !!path && cycles.length >= 2, shown.a);
  check('smoothing took the samples to 4n-3', path.strip.length === cycles.length * 4 - 3, `${path.strip.length} from ${cycles.length}`);
  check('one midpoint per sample', path.mids.length === cycles.length);
  check('arc length runs 0 to 1', path.mids[0].t === 0 && Math.abs(path.mids.at(-1).t - 1) < 1e-6);
  check('u only grows', path.strip.every((r, i) => !i || r.u >= path.strip[i - 1].u));
  const w0 = Math.hypot(...path.strip[0].a.map((v, k) => v - path.strip[0].b[k]));
  const w1 = Math.hypot(...path.strip.at(-1).a.map((v, k) => v - path.strip.at(-1).b[k]));
  check('60 wide where it starts', Math.abs(w0 - 60) < 0.01, w0);
  check('30 wide where it ends', Math.abs(w1 - 30) < 0.01, w1);
  check('nothing for an activity with no sequence', buildPath(char, grip, 'ACT_NOT_REAL', null, cycles) === null);
  check('nothing with one sample', buildPath(char, grip, shown.a, shown.l, [0.5]) === null);
}

{ // the fades
  const pv = new TracerPreview(), want = { a: 'A' };
  let builds = 0;
  const build = () => { builds++; return path; };
  const step = (w, swinging = false, n = 1) => { for (let i = 0; i < n; i++) pv.update(0.01, w, swinging, build); };
  step(want, false, 2);
  check('builds at once when there is nothing to fade', builds === 1 && pv.key === 'A');
  step(want, false, 12);
  check('fades in over an eighth of a second', pv.fade === 1, pv.fade);
  const d = pv.draw([0, 0, 0], 0, 0);
  check('settled: all shown', d.ranges[0] === 0 && d.ranges[1] === 1 && d.ranges[3] === -1, d.ranges);
  check('the strip has two vertices a row', d.count === path.strip.length * 2 && d.verts.length === d.count * 7);
  check('along runs 1 down to 0', d.verts[5] === 1 && d.verts.at(-2) === 0, `${d.verts[5]} ${d.verts.at(-2)}`);
  check('inner top follows along, outer top is 1', d.verts[4 + 7 * (path.strip.length - 1) * 2] === 0 && d.verts[11] === 1);
  step({ a: 'B' }, false, 1);
  check('a new attack starts the old one fading', pv.changed && pv.key === 'A' && pv.fade < 1 && builds === 1);
  const mid = pv.draw([0, 0, 0], 0, 0);
  check('fading out moves the back edge', mid.ranges[0] === 0 && mid.ranges[1] === pv.fade && Math.abs(mid.ranges[3] - (pv.fade - 0.05)) < 1e-6, mid.ranges);
  step({ a: 'B' }, false, 13);
  check('only swaps once it has gone', builds === 2 && pv.key === 'B');
  step({ a: 'B' }, true, 40);
  check('a swing wipes it past the top', pv.top === 1.8 && pv.draw([0, 0, 0], 0, 0).ranges[2] === 1.8);
  step({ a: 'B' }, false, 40);
  check('and it comes back', pv.top === 0);
  step(null, false, 14);
  check('no attack: nothing to draw', pv.key === null && pv.draw([0, 0, 0], 0, 0) === null);
}

{ // the target highlight
  const pv = new TracerPreview();
  pv.path = path;
  const mid = path.mids[Math.floor(path.mids.length / 2)];
  // straight on the middle of the path, in world: feet below the pivot
  const e = [mid.p[0], -mid.p[1], mid.p[2] + 36 - 36];
  for (let i = 0; i < 40; i++) pv.highlight(0.01, [0, 0, 0], 0, 0, [[mid.p[0], mid.p[1], mid.p[2] + 36 - 36]]);
  check('an enemy on the path lights it', pv.amount === 1, pv.amount);
  check('up to about where it touches', pv.position > 0 && pv.position <= 1, pv.position);
  const hitAt = pv.position;
  for (let i = 0; i < 40; i++) pv.highlight(0.01, [0, 0, 0], 0, 0, [[5000, 0, 0]]);
  check('it goes out with nobody there', pv.amount === 0, pv.amount);
  check('keeping its last place to fade from', pv.position === hitAt);
  void e;
  const empty = new TracerPreview();
  empty.amount = 1;
  empty.highlight(0.01, [0, 0, 0], 0, 0, []);
  check('no path: no highlight', empty.amount === 0);
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
