// Headless duel: boots the real sim on a real map with scripted fighters and checks observable rules.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
const root = process.argv[2]; const mapn = process.argv[3] || 'duel_practice_box';
const G = root + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
for (const k of ['knight', 'ryoku']) await assets.preload(k);
console.log('actions', Object.keys(data.actions).length, 'stances', Object.keys(data.stances).length, 'chars', Object.keys(data.characters), 'tracer activities knight', Object.keys(data.tracers.knight).length);
const miss = [];
for (const ch of Object.keys(data.characters)) {
  for (let s = 0; s < 4; s++) for (const d of [0, 1, 3]) for (let c = 0; c < 3; c++) if (!data.attackFor(ch, s, d, c)) miss.push(`${ch}/${s}/${d}/${c}`);
}
console.log('attack lookups missing:', miss.length, miss.slice(0, 8));
const bsp = new BSP(readFileSync(`${G}maps/${mapn}.bsp`));
const sp = bsp.entities.filter((e) => e.classname === 'berimbau_spawn');
console.log('spawn keys', Object.keys(sp[0]), 'duel ent', JSON.stringify(bsp.entities.find((e) => e.classname === 'berimbau_duel')).slice(0, 260));
const w = new World({ bsp, data, cvars, assets, map: mapn });
const a = new Player(1, 'A', 'knight'), b = new Player(2, 'B', 'ryoku');
w.addPlayer(a); w.addPlayer(b);
console.log('spawns', a.origin, a.yaw, b.origin, b.yaw, 'dist', Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1]).toFixed(0));
const counts = {};
const seen = [];
const run = (secs, f) => { for (let i = 0; i < secs / TICK; i++) { f?.(i); w.step(); for (const e of w.events) { counts[e.type] = (counts[e.type] || 0) + 1; if (['round_start', 'fight', 'round_end', 'duel_over', 'death', 'hit', 'blocked', 'parried', 'break_block', 'intercepted'].includes(e.type)) seen.push(e); } w.events.length = 0; } };
run(7);
const z0 = a.origin[2];
console.log('after warmup', w.duel.state, 'a', a.origin.map((x) => +x.toFixed(1)), 'onGround', a.onGround);
// movement: run forward 1s
const yaw = (p, q) => Math.atan2(q.origin[1] - p.origin[1], q.origin[0] - p.origin[0]) * 180 / Math.PI;
a.viewYaw = yaw(a, b); b.viewYaw = yaw(b, a);
a.buttons = IN.FORWARD; const p0 = [...a.origin];
run(1);
console.log('run 1s moved', Math.hypot(a.origin[0] - p0[0], a.origin[1] - p0[1]).toFixed(1), 'speed', Math.hypot(a.vel[0], a.vel[1]).toFixed(1));
a.buttons = 0; run(0.5);
const j0 = a.origin[2]; let apex = j0;
a.buttons = IN.JUMP; run(0.05); a.buttons = 0;
run(1.2, () => { apex = Math.max(apex, a.origin[2]); });
console.log('jump apex +', (apex - j0).toFixed(1), 'landed', a.onGround, 'z drift', (a.origin[2] - j0).toFixed(2));
// close to melee and swing until someone dies; both scripted
const brain = (p, q, block) => { p.viewYaw = yaw(p, q); const d = Math.hypot(p.origin[0] - q.origin[0], p.origin[1] - q.origin[1]); let bt = 0; if (d > 55) bt |= IN.FORWARD; else if (!block) { if (!p.act) bt |= IN.ATTACK; } else bt |= IN.BLOCK; p.buttons = bt; };
let hits0 = seen.length;
run(40, () => { brain(a, b, false); if (w.duel.state === 'fight' && b.health < 60) brain(b, a, true); else brain(b, a, false); });
console.log('after 40s', w.duel.state, 'round', w.duel.round, 'wins', w.duel.wins, 'hp', a.health, b.health, 'counts', counts);
for (const e of seen.slice(hits0, hits0 + 12)) console.log(' ', e.time.toFixed(2), e.type, e.damage ?? '', e.tier ?? '', e.delta ?? '', e.winner ?? '');
const t0 = Date.now(); for (let i = 0; i < 660; i++) { brain(a, b, false); brain(b, a, false); w.step(); w.events.length = 0; }
console.log('sim speed', ((Date.now() - t0) / 660).toFixed(3), 'ms/tick (budget 15.15)');
void z0;
