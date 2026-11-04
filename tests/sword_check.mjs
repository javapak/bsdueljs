// Every sword in the catalog lies along its grip when posed as it's held: blade down +X from the hand, at about full length.
// Usage: node tests/sword_check.mjs "<install>"
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { Model, buildMesh } from '../shared/mdl.js';
import { matMul, matPoint, rigidInverse } from '../shared/mathx.js';
const G = process.argv[2] + '/berimbau/';
// the catalog's spelling doesn't always match the file's case
const find = (p) => {
  if (existsSync(p)) return p;
  const hit = readdirSync(dirname(p)).find((f) => f.toLowerCase() === basename(p).toLowerCase());
  return hit ? join(dirname(p), hit) : p;
};
const load = (path) => {
  const base = G + path.replace(/\.mdl$/i, '');
  const model = new Model(readFileSync(find(base + '.mdl')), path);
  return { model, mesh: buildMesh(model, readFileSync(find(base + '.vvd')), readFileSync(find(base + '.dx90.vtx')), 0) };
};
// A sword's vertices in its grip's space, each by its own bone
const bounds = ({ model, mesh }, pose) => {
  const toGrip = rigidInverse(pose.world[model.boneByName.get('sword_grip')]);
  const skin = model.bones.map((b, i) => matMul(matMul(toGrip, pose.world[i]), b.poseToBone));
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const p = matPoint(skin[mesh.boneIdx[v * 3]], [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  }
  return { mn, mx };
};
const along = ({ mn, mx }) => mx[0] > 35 && mn[0] > -50 && mx[0] - mn[0] > 2 * Math.max(mx[1] - mn[1], mx[2] - mn[2]);

const swords = JSON.parse(readFileSync(G + 'scripts/items.json', 'latin1')).items.filter((i) => i.item_type === 'sword');
const seen = new Set();
let pass = 0, fail = 0, refOff = 0;
for (const it of swords) {
  if (seen.has(it.model)) continue;
  seen.add(it.model);
  const s = load(it.model), b = bounds(s, s.model.idlePose());
  if (!along(bounds(s, s.model.refPose()))) refOff++;
  if (along(b)) pass++;
  else { fail++; console.log('FAIL', it.name, it.model, b.mn.map((x) => +x.toFixed(1)), b.mx.map((x) => +x.toFixed(1))); }
}
console.log(`${pass}/${pass + fail} passed (${refOff} would be off in the reference pose)`);
process.exit(fail || !refOff ? 1 : 0);
