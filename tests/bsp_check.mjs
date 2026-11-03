import { readFileSync } from 'node:fs';
import { BSP, CONTENTS_SOLID } from '../shared/bsp.js';
const root = process.argv[2];
for (const m of ['duel_box', 'duel_practice_box', 'duel_temple', 'duel_monastery', 'duel_district', 'duel_castle', 'duel_winter']) {
  const t0 = Date.now();
  const b = new BSP(readFileSync(`${root}/berimbau/maps/${m}.bsp`));
  const cls = {};
  for (const e of b.entities) cls[e.classname] = (cls[e.classname] || 0) + 1;
  const sp = b.entities.filter((e) => /spawn|duel|arena/i.test(e.classname || ''));
  const sprp = b.staticProps();
  console.log(m, 'parse ms', Date.now() - t0, 'ents', b.entities.length, 'faces', b.faces.length, 'dispTris', b.dispTris.length, 'pak', b.pakIndex().size, 'hdr', b.lightingHDR, 'sprp', sprp.ver, sprp.sz, sprp.props?.length, sprp.names?.length);
  console.log('  spawn-ish:', Object.entries(cls).filter(([k]) => /spawn|duel|arena|berimbau|trigger|logic_|bb_/i.test(k)).map(([k, v]) => k + ':' + v).join(' '));
  const s = sp.find((e) => e.origin);
  if (s) {
    const o = s.origin.split(' ').map(Number);
    const hull = [[-16, -16, 0], [16, 16, 72]];
    const start = [o[0], o[1], o[2] + 2];
    const inside = b.traceBox(start, start, hull[0], hull[1]);
    const down = b.traceBox(start, [o[0], o[1], o[2] - 4096], hull[0], hull[1]);
    const sky = b.traceBox(start, [o[0], o[1], o[2] + 8192], hull[0], hull[1]);
    const fw = b.traceBox(start, [o[0] + 8192, o[1], o[2] + 2], hull[0], hull[1]);
    console.log('  ', s.classname, o, 'startsolid', inside.startsolid, 'floor z', down.endpos[2].toFixed(2), 'n', down.normal.map((x) => +x.toFixed(2)), 'ceil z', sky.endpos[2].toFixed(1), 'wall x', fw.endpos[0].toFixed(1));
  }
}
