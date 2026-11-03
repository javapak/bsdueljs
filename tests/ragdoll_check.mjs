// Every character's ragdoll, dropped from a standing pose on a real map: it stays connected, stays above the floor,
// comes to rest, and doesn't blow up. Usage: node tests/ragdoll_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { Cvars } from '../shared/sim.js';
import { entityMatrix } from '../shared/mathx.js';
import { parsePhy, Ragdoll } from '../shared/ragdoll.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
const bsp = new BSP(readFileSync(G + 'maps/duel_practice_box.bsp'));
const spawn = bsp.entities.find((e) => e.classname === 'berimbau_spawn').origin.split(' ').map(Number);
const floor = bsp.traceBox([spawn[0], spawn[1], spawn[2] + 40], [spawn[0], spawn[1], spawn[2] - 400], [0, 0, 0], [0, 0, 0], 1).endpos[2];
let fails = 0;
const check = (ok, m) => { if (!ok) { fails++; console.log('FAIL', m); } };
for (const key of Object.keys(data.characters)) {
  const c = await assets.preload(key);
  const def = parsePhy(readFileSync(G + data.characters[key].model.replace(/\\/g, '/').replace(/\.mdl$/i, '.phy')));
  check(def.solids.length > 5 && def.constraints.length === def.solids.length - 1, `${key} phy: ${def.solids.length} solids, ${def.constraints.length} joints`);
  const seq = c.seqForActivity('ACT_BB_B_IDLE') || c.seqs[0];
  const pose = c.evalLayers([{ seq, cycle: 0, weight: 1 }]);
  const world = entityMatrix([spawn[0], spawn[1], floor + 2], [0, 0, 0]);
  const start = c.boneMatrices(pose, world);
  const rag = new Ragdoll(c, def, bsp, pose, start, start, 1 / 60, [200, 0, 60]);
  const t0 = performance.now();
  let maxGap = 0, top = -Infinity;
  for (let i = 0; i < 300; i++) {
    rag.step(1 / 60);
    for (const j of rag.joints) {
      const q = (b, l) => { const u = [b.q[0], b.q[1], b.q[2]], cr = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], t = cr(u, l).map((v) => v * 2), s = cr(u, t); return [b.x[0] + l[0] + t[0] * b.q[3] + s[0], b.x[1] + l[1] + t[1] * b.q[3] + s[1], b.x[2] + l[2] + t[2] * b.q[3] + s[2]]; };
      const a = q(j.a, j.anchorA), b = q(j.b, j.anchorB);
      maxGap = Math.max(maxGap, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    top = Math.max(top, ...rag.bodies.map((b) => b.x[2]));
  }
  const ms = (performance.now() - t0) / 300;
  const bones = rag.bones(world);
  check(bones.every((m) => m.every(Number.isFinite)), `${key} went NaN`);
  const heights = rag.bodies.map((b) => b.x[2] - floor), speed = Math.max(...rag.bodies.map((b) => Math.hypot(...b.v)));
  check(Math.min(...heights) > -2, `${key} fell through the floor: ${Math.min(...heights).toFixed(1)}`);
  check(Math.max(...heights) < 30, `${key} still standing, highest body ${Math.max(...heights).toFixed(1)}`);
  check(speed < 40, `${key} never settled, ${speed.toFixed(1)} u/s`);
  check(maxGap < 6, `${key} joint opened by ${maxGap.toFixed(1)}`);
  check(top < floor + 120, `${key} launched to ${(top - floor).toFixed(0)}`);
  console.log(key, 'solids', def.solids.length, 'rest heights', Math.min(...heights).toFixed(1), Math.max(...heights).toFixed(1), 'speed', speed.toFixed(1), 'gap', maxGap.toFixed(2), `${ms.toFixed(2)} ms/step`);
}
console.log(fails ? `${fails} failed` : 'all ragdolls settled');
process.exit(fails ? 1 : 0);
