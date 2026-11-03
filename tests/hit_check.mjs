// A tapped attack against a fighter standing still, at every range: the band of ranges that land must be
// continuous and reasonably wide, because a sword shouldn't pass through a stationary body.
// Usage: node tests/hit_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, IN, TICK } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
const chars = Object.keys(data.characters);
for (const k of chars) await assets.preload(k);
const bsp = new BSP(readFileSync(G + 'maps/duel_practice_box.bsp'));
const lands = (char, stance, dist) => {
  const w = new World({ bsp, data, cvars, assets, map: 'duel_practice_box' });
  const a = new Player(1, 'A', char), b = new Player(2, 'B', 'knight');
  w.addPlayer(a); w.addPlayer(b);
  for (let i = 0; i < 12 / TICK && w.duel.state !== 'fight'; i++) w.step();
  const place = () => { a.vel = [0, 0, 0]; b.vel = [0, 0, 0]; a.yaw = a.viewYaw = 0; b.yaw = b.viewYaw = 180; a.origin = [b.origin[0] - dist, b.origin[1], b.origin[2]]; };
  place();
  a.buttons = stance; w.step(); a.buttons = 0;
  for (let i = 0; i < 5; i++) w.step();
  place();
  a.buttons = IN.ATTACK;
  for (let i = 0; i < 3; i++) w.step();
  a.buttons = 0;
  let hit = false;
  for (let i = 0; i < 2.5 / TICK && !hit; i++) {
    w.step();
    hit = w.events.some((e) => e.type === 'hit' && e.attacker === 1);
    w.events.length = 0;
    if (!a.act && i > 20) break;
  }
  return hit;
};
let bad = 0;
for (const [label, stance] of [['heavy', IN.STANCE_HEAVY], ['balanced', IN.STANCE_BAL], ['fast', IN.STANCE_FAST]]) {
  for (const char of chars) {
    const ranges = [];
    for (let d = 20; d <= 160; d += 5) if (lands(char, stance, d)) ranges.push(d);
    const gaps = ranges.filter((d, i) => i && d - ranges[i - 1] > 5).length;
    const width = ranges.length ? ranges.at(-1) - ranges[0] : 0;
    const ok = ranges.length > 0 && gaps === 0 && width >= 30;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(9)}${char.padEnd(9)} ${ranges.length ? `${ranges[0]}-${ranges.at(-1)}` : 'never'}${gaps ? ` (${gaps} gaps)` : ''}`);
  }
}
console.log(bad ? `${bad} failures` : 'all hit bands continuous');
process.exit(bad ? 1 : 0);
