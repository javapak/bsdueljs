// On every duel map: both spawns must be clear and on the ground, and a hull must be able to walk
// the straight line between them unless a visible (point-trace) obstacle really is in the way.
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
const G = process.argv[2] + '/berimbau/maps/';
const H = [[-13, -13, 0], [13, 13, 72]];
let bad = 0;
for (const m of ['duel_box', 'duel_practice_box', 'duel_temple', 'duel_monastery', 'duel_castle', 'duel_district', 'duel_winter']) {
  const b = new BSP(readFileSync(`${G}${m}.bsp`));
  await b.addPropCollision(async (p) => { try { return readFileSync(`${G}../${p}`); } catch { return null; } });
  const sp = b.entities.filter((e) => e.classname === 'berimbau_spawn' && e.origin).map((e) => ({ o: e.origin.split(' ').map(Number), d: e.duel, t: e.duelteam }));
  const out = [];
  for (const ar of b.entities.filter((e) => e.classname === 'berimbau_duel').map((e) => e.targetname).sort()) {
    const a = sp.filter((s) => s.d === ar && s.t === '1'), c = sp.filter((s) => s.d === ar && s.t === '2');
    let clear = 0, walls = 0, blocked = 0, total = 0;
    for (const p of [...a, ...c]) { const o = [p.o[0], p.o[1], p.o[2] + 2]; if (!b.traceBox(o, o, H[0], H[1]).startsolid) clear++; }
    for (const p of a) for (const q of c) {
      total++;
      // walk it in step-sized hops, stepping up/down like the movement code
      let at = [p.o[0], p.o[1], b.traceBox([p.o[0], p.o[1], p.o[2] + 8], [p.o[0], p.o[1], p.o[2] - 64], H[0], H[1]).endpos[2]];
      const dx = q.o[0] - p.o[0], dy = q.o[1] - p.o[1], L = Math.hypot(dx, dy), ux = dx / L * 4, uy = dy / L * 4;
      let ok = true;
      for (let i = 0; i < L / 4; i++) {
        const up = b.traceBox(at, [at[0], at[1], at[2] + 18], H[0], H[1]).endpos;
        const fw = b.traceBox(up, [up[0] + ux, up[1] + uy, up[2]], H[0], H[1]);
        if (fw.fraction < 1) { ok = false; break; }
        at = b.traceBox(fw.endpos, [fw.endpos[0], fw.endpos[1], fw.endpos[2] - 40], H[0], H[1]).endpos;
      }
      if (ok) continue;
      // is something actually there at chest height, or is this a false wall?
      const chest = b.traceBox([p.o[0], p.o[1], p.o[2] + 40], [q.o[0], q.o[1], q.o[2] + 40], [0, 0, 0], [0, 0, 0]);
      if (chest.fraction < 1) walls++; else blocked++;
    }
    out.push(`${ar}: spawns clear ${clear}/${a.length + c.length}, paths ${total - walls - blocked}/${total} walkable, ${walls} real walls, ${blocked} blocked`);
    if (clear < a.length + c.length || blocked) bad++;
  }
  console.log(m, '\n  ' + out.join('\n  '));
}
console.log(bad ? `FAIL ${bad} arena(s)` : 'PASS');
process.exit(bad ? 1 : 0);
