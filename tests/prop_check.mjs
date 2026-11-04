// Static prop collision on every duel map. The .phy decode has to agree with each model's own bounds, and a trace has to stop on
// a prop that the world alone would pass through. Usage: node tests/prop_check.mjs "<install>"
import { readFileSync, existsSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { Model } from '../shared/mdl.js';
import { parseConvexPieces } from '../shared/phy.js';
const G = process.argv[2] + '/berimbau/';
let fails = 0;
const check = (ok, m) => { if (!ok) { fails++; console.log('FAIL', m); } };
const read = async (p) => { const f = G + p; return existsSync(f) ? readFileSync(f) : null; };
for (const map of ['duel_temple', 'duel_monastery', 'duel_castle', 'duel_district', 'duel_winter', 'duel_box', 'duel_practice_box']) {
  const buf = readFileSync(`${G}maps/${map}.bsp`);
  const plain = new BSP(buf), bsp = new BSP(buf);
  await bsp.addPropCollision(read);
  const { names, props } = bsp.staticProps();
  let parsed = 0, outside = 0, models = 0;
  for (const name of names) {
    const phy = await read(name.replace(/\.mdl$/i, '.phy')), mdl = await read(name);
    if (!phy || !mdl) continue;
    const pieces = parseConvexPieces(phy);
    models++;
    if (!pieces.length) continue;
    parsed++;
    // the collision hull should sit inside what the model says its visible bounds are, give or take
    const m = new Model(mdl, name), mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const piece of pieces) for (const p of piece.points) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    const hmn = m.hullMin ?? m.viewMin, hmx = m.hullMax ?? m.viewMax;
    if (hmn && hmx) {
      const slack = 6 + 0.1 * Math.max(hmx[0] - hmn[0], hmx[1] - hmn[1], hmx[2] - hmn[2]);
      const ok = [0, 1, 2].every((k) => mn[k] >= hmn[k] - slack && mx[k] <= hmx[k] + slack);
      if (!ok) { outside++; console.log(`  ${name}: hull ${mn.map(Math.round)} .. ${mx.map(Math.round)} vs model ${hmn.map(Math.round)} .. ${hmx.map(Math.round)}`); }
    }
  }
  check(outside <= models * 0.05, `${map}: ${outside} of ${models} hulls outside their model's bounds`);
  // straight down onto solid props: at least some must stop higher than the world alone does
  let tested = 0, stopped = 0;
  for (const pr of props) {
    if (pr.solid !== 6) continue;
    const hull = bsp.propHulls.find((h) => h.mn[0] <= pr.origin[0] + 64 && h.mx[0] >= pr.origin[0] - 64 && h.mn[1] <= pr.origin[1] + 64 && h.mx[1] >= pr.origin[1] - 64 && h.mn[2] <= pr.origin[2] + 256 && h.mx[2] >= pr.origin[2] - 64);
    if (!hull) continue;
    const x = (hull.mn[0] + hull.mx[0]) / 2, y = (hull.mn[1] + hull.mx[1]) / 2, top = hull.mx[2] + 32, a = [x, y, top], b = [x, y, hull.mn[2] - 32];
    const w0 = plain.traceBox(a, b, [0, 0, 0], [0, 0, 0], 1), w1 = bsp.traceBox(a, b, [0, 0, 0], [0, 0, 0], 1);
    tested++;
    if (w1.fraction < w0.fraction - 1e-4) stopped++;
    check(w1.fraction <= w0.fraction + 1e-6, `${map}: props made a trace go further`);
  }
  if (tested) check(stopped > tested * 0.5, `${map}: only ${stopped} of ${tested} downward traces stopped on a prop`);
  console.log(map, 'solid props', props.filter((p) => p.solid === 6).length, 'hull pieces', bsp.propHulls.length, 'models with collision', parsed, 'of', models, 'traces stopped', stopped, 'of', tested);
}
console.log(fails ? `${fails} failed` : 'prop collision ok');
process.exit(fails ? 1 : 0);
