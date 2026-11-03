import { readFileSync } from 'node:fs';
import { Model, Character, buildMesh } from '../shared/mdl.js';
import { entityMatrix, matPoint } from '../shared/mathx.js';
const root = process.argv[2] + '/berimbau/';
const load = (p) => new Model(readFileSync(root + 'models/' + p), p);
const m = load('player/characters/knight/knight.mdl');
console.log(m.name, 'v', m.version, 'bones', m.bones.length, 'seqs', m.numSeq, 'anims', m.numAnim, 'hull', m.hullMin, m.hullMax, 'eye', m.eye);
console.log('includes', m.includes);
console.log('hitboxes', m.hitboxSets.map((s) => s.name + ':' + s.boxes.length), 'att', m.attachments.map((a) => a.name).join(','));
console.log('pose', m.poseParams.map((p) => `${p.name}[${p.start},${p.end}]`).join(' '));
console.log('tex', m.textures, m.cdtextures);
const incs = m.includes.map((i) => load(i.replace(/^models\//, '')));
for (const i of incs) console.log('inc', i.name, 'seqs', i.numSeq, 'anims', i.numAnim, 'includes', i.includes, 'bones', i.bones.length);
const nested = [];
for (const i of incs) for (const j of i.includes) nested.push(load(j.replace(/^models\//, '')));
const c = new Character(m, [...incs, ...nested]);
console.log('activities', c.byActivity.size, 'seqs', c.seqs.length);
for (const a of ['ACT_BB_B_IDLE', 'ACT_BB_B_RUN', 'ACT_BB_B_C1_T1', 'ACT_BB_A_C1_T1', 'ACT_BB_INTERCEPT', 'ACT_BB_BLOCK_LEFT', 'ACT_BB_KICK']) {
  const s = c.seqForActivity(a);
  if (!s) { console.log(a, 'MISSING'); continue; }
  const d = c._seqDescResolved(s);
  const dur = c.seqDuration(s);
  console.log(a, s.label, 'model', s.model.name, 'frames', d.numFrames, 'fps', d.fps, 'dur', dur.toFixed(3), 'loop', s.flags & 1, 'blend', s.groupSize, 'layers', s.numAutoLayers, 'move', c.seqMovement(s, 1).map((x) => +x.toFixed(1)));
}
const s = c.seqForActivity('ACT_BB_B_C1_T1');
const handNames = m.bones.filter((b) => /hand|sword|weapon/i.test(b.name)).map((b) => b.name);
console.log('hand/sword bones', handNames);
const world = entityMatrix([0, 0, 0], [0, 0, 0]);
for (const cy of [0, 0.25, 0.5, 0.75, 1]) {
  const pose = c.evalLayers([{ seq: s, cycle: cy, weight: 1 }]);
  const b = c.boneMatrices(pose, world);
  const hi = m.boneByName.get(handNames[0].toLowerCase());
  console.log('cycle', cy, handNames[0], [b[hi][3], b[hi][7], b[hi][11]].map((x) => +x.toFixed(1)));
}
const mesh = buildMesh(m, readFileSync(root + 'models/player/characters/knight/knight.vvd'), readFileSync(root + 'models/player/characters/knight/knight.dx90.vtx'));
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], mesh.positions[i + k]); mx[k] = Math.max(mx[k], mesh.positions[i + k]); }
let maxi = 0; for (const x of mesh.indices) maxi = Math.max(maxi, x);
console.log('mesh verts', mesh.positions.length / 3, 'tris', mesh.indices.length / 3, 'bounds', mn.map(x=>+x.toFixed(1)), mx.map(x=>+x.toFixed(1)), 'maxindex', maxi, 'meshes', mesh.meshes.map((x) => x.material + ':' + x.count).join(' '));
