// Jiggle bones on the game's cape: stays at its length, inside its limits, settles, and doesn't depend on frame rate.
// Usage: node tests/jiggle_check.mjs "<install>/berimbau"
import fs from 'node:fs';
import path from 'node:path';
import { Model } from '../shared/mdl.js';
import { JiggleBones, jiggleInfo } from '../shared/jiggle.js';

const root = process.argv[2];
const read = (p) => { const b = fs.readFileSync(path.join(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };
const close = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

const info = jiggleInfo(new Model(read('models/attachments/capes/half_cape.mdl')));
check('half cape has jiggle bones', info.size === 21, info.size);
const [bone, j] = [...info][0];
check('reads the model parameters', j.flags === 0x2d && j.length === 4 && j.tipMass === 400 && j.yawStiffness === 500, JSON.stringify(j));

// A bone hanging out level along +X: left +Y, up +Z, forward +X
const goal = (x = 0, y = 0, z = 100) => [0, 0, 1, x, 1, 0, 0, y, 0, 1, 0, z];
const tip = (m) => [m[3] + m[2] * j.length, m[7] + m[6] * j.length, m[11] + m[10] * j.length];
const run = (fps, seconds, move) => {
  const b = new JiggleBones(info);
  let t = 0, m;
  for (let i = 0; i < seconds * fps; i++, t += 1 / fps) {
    m = b.update(bone, t, goal(...(move ? move(t) : [])));
    check('stays at its length', close(Math.hypot(m[2], m[6], m[10]), 1), m);
    const st = b.state.get(bone);
    const a = [st.tip[0] - m[3], st.tip[1] - m[7], st.tip[2] - m[11]];
    check('tip at the length constraint', close(Math.hypot(...a), j.length, 1e-3), Math.hypot(...a));
    const pitch = Math.atan2(a[2], a[0]);
    check('inside the pitch limit', pitch >= j.minPitch - 1e-3 && pitch <= j.maxPitch + 1e-3, pitch);
    const yaw = Math.atan2(a[1], a[0]);
    check('inside the yaw limit', yaw >= j.minYaw - 1e-3 && yaw <= j.maxYaw + 1e-3, yaw);
  }
  return { b, m };
};

// With no motion it hangs under gravity against its pitch spring, the same at any frame rate above the 30Hz clamp
const settle = (fps) => { const { m } = run(fps, 6); return tip(m); };
const a = settle(60), c = settle(144);
check('gravity pulls the tip down', a[2] < 100, a);
check('nothing pushes it sideways', close(a[1], 0, 1e-2), a);
console.log(`settled tip at 60fps ${a.map((x) => x.toFixed(2))}, 144fps ${c.map((x) => x.toFixed(2))}`);

// Moving sideways trails the tip behind the bone
const moving = run(60, 2, (t) => [0, t * 400, 100]);
const st = moving.b.state.get(bone);
check('moving trails the tip behind its goal', st.tip[1] - moving.m[7] < -1, st.tip[1] - moving.m[7]);

// Long gaps reset it instead of swinging
const b = new JiggleBones(info);
b.update(bone, 0, goal());
b.update(bone, 1 / 60, goal());
const after = b.update(bone, 5, goal(1000, 0, 100));
check('a gap over half a second resets to the goal', close(b.state.get(bone).tip[0], 1000 + j.length, 0.5), b.state.get(bone).tip);
check('the bone follows the goal after a reset', close(after[3], 1000));

// Every jiggle model an item uses reads cleanly
const items = JSON.parse(fs.readFileSync(path.join(root, 'scripts/items.json'), 'latin1')).items;
let kinds = new Set();
for (const p of new Set(items.filter((i) => i.model && ['mask', 'cape', 'attachment'].includes(i.item_type)).map((i) => i.model))) {
  for (const v of jiggleInfo(new Model(read(p))).values()) {
    kinds.add(v.flags);
    check(`${p} sane parameters`, v.length > 0 && v.tipMass >= 0 && Number.isFinite(v.yawStiffness), JSON.stringify(v));
  }
}
check('only the kinds implemented: flexible, yaw, pitch, angle, length', [...kinds].every((f) => !(f & 0x42)), [...kinds].map((f) => f.toString(16)));

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
