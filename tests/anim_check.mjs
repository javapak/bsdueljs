// Locomotion blending: for each move direction and speed, the blended sequence's own root motion must point
// where the player is really moving, and the stride must scale with speed. Every stance, every character.
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, animLayers, IN } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
const w = new World({ bsp: new BSP(readFileSync(`${G}maps/duel_practice_box.bsp`)), data, cvars, assets });
let checks = 0, fails = 0;
const fail = (m) => { fails++; if (fails < 15) console.log('FAIL', m); };
const blended = (c, seq, px, py) => {
  // bilinear root motion of the 3x3 grid, as _sampleSeq blends poses
  const m = seq.model, nx = seq.groupSize[0], ny = seq.groupSize[1];
  const fx = Math.min(nx - 1 - 1e-6, px * (nx - 1)), fy = Math.min(ny - 1 - 1e-6, py * (ny - 1));
  const ix = Math.floor(fx), iy = Math.floor(fy), sx = fx - ix, sy = fy - iy;
  const out = [0, 0];
  for (const [x, y, wt] of [[ix, iy, (1 - sx) * (1 - sy)], [ix + 1, iy, sx * (1 - sy)], [ix, iy + 1, (1 - sx) * sy], [ix + 1, iy + 1, sx * sy]]) {
    const v = m.animMovement(m.animDesc(m.seqAnimIndex(seq, x, y)), 1);
    out[0] += v[0] * wt; out[1] += v[1] * wt;
  }
  return out;
};
for (const k of Object.keys(data.characters)) {
  await assets.preload(k);
  const c = assets.character(k);
  const p = new Player(1, 'x', k);
  p.reset([0, 0, 0], 0); p.onGround = true;
  for (let st = 0; st < 3; st++) {
    p.stance = st;
    for (const yaw of [0, 37, 90, 200]) {
      p.yaw = yaw;
      for (let dir = 0; dir < 360; dir += 45) {
        const prev = [];
        for (const [speed, walk] of [[175, false], [90, false], [40, true], [20, true]]) {
          const r = dir * Math.PI / 180;
          p.vel = [Math.cos(r) * speed, Math.sin(r) * speed, 0];
          p.buttons = walk ? IN.WALK : 0;
          w.tickCount++;
          const an = w.animOf(p);
          const L = animLayers(c, { ...an });
          const seq = L[0].seq;
          if (seq.groupSize[0] !== 3) { fail(`${k} stance ${st}: ${an.base} isn't a 3x3 grid`); continue; }
          const mv = blended(c, seq, L[0].px, L[0].py);
          const local = (dir - yaw) * Math.PI / 180;
          const want = [Math.cos(local), Math.sin(local)];
          const l = Math.hypot(mv[0], mv[1]);
          checks++;
          const d = (mv[0] * want[0] + mv[1] * want[1]) / (l || 1);
          if (d < 0.97) fail(`${k} stance ${st} yaw ${yaw} dir ${dir} speed ${speed}: motion ${mv.map((x) => x.toFixed(0))} wanted ${want.map((x) => x.toFixed(2))}, dot ${d.toFixed(3)}`);
          prev.push({ l, speed, walk });
        }
        checks++;
        if (!(prev[1].l < prev[0].l * 0.75)) fail(`${k} stance ${st} dir ${dir}: stride didn't shrink with run speed ${prev[0].l.toFixed(0)} -> ${prev[1].l.toFixed(0)}`);
        checks++;
        if (!(prev[3].l < prev[2].l * 0.75)) fail(`${k} stance ${st} dir ${dir}: stride didn't shrink with walk speed ${prev[2].l.toFixed(0)} -> ${prev[3].l.toFixed(0)}`);
      }
    }
  }
  // charging keeps the legs moving: the running charge must leave the lower body to locomotion
  for (const n of Object.keys(data.actions)) {
    const def = data.actions[n];
    // air attacks intentionally reuse the full-body air charge: there are no running legs to keep
    if (!def.charge_animation_run || /_A_/.test(def.charge_animation_run)) continue;
    const s = c.seqForActivity(def.charge_animation_run);
    if (!s) continue;
    const wt = c._weights(s);
    const thigh = c.root.boneByName.get('valvebiped.bip01_l_thigh');
    checks++;
    if (wt[thigh] > 0.01) fail(`${k} ${n}: running charge overrides the legs (${def.charge_animation_run} weight ${wt[thigh]})`);
  }
}
console.log(`${checks - fails}/${checks} locomotion checks passed`);
process.exit(fails ? 1 : 0);
