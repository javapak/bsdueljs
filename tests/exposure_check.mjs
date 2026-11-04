// The exposure rule on made-up frames: limits, direction, and the percent-bright search. Usage: node tests/exposure_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { Exposure, findPercentBright, tonemapSettings } from '../shared/exposure.js';
let fails = 0;
const check = (ok, m) => { if (!ok) { fails++; console.log('FAIL', m); } };
const run = (scene, settings = {}) => {
  const e = new Exposure();
  e.configure({ ...{ min: 0.5, max: 2, rate: 1, percentTarget: 60, percentBright: 2, minAvgLum: 3 }, ...settings });
  for (let i = 0; i < 2000; i++) { const lum = new Float32Array(1000).map((_, k) => Math.min(1, scene(k) * e.scale)); if (i % 6 === 0) e.measure(lum); e.step(1 / 60); }
  return e.scale;
};
const dark = (k) => (k < 10 ? 0.05 : 0.02), bright = (k) => (k < 50 ? 2 : 0.8), even = () => 0.3;
check(run(dark) > 1.9, `a dark frame should reach the cap, got ${run(dark)}`);
check(run(bright) < 0.6, `a blown frame should reach the floor, got ${run(bright)}`);
check(run(dark, { min: 0.75, max: 1.25 }) <= 1.25 + 1e-6, 'map cap ignored');
check(run(bright, { min: 0.75, max: 1.25 }) >= 0.75 - 1e-6, 'map floor ignored');
const counts = new Int32Array(16); counts[15] = 1000;
check(findPercentBright(counts, 1000, 2, 60) > 0.8, 'bright pixels should sit in the top bucket');
check(findPercentBright(new Int32Array(16), 0, 2, 60) === -1, 'empty histogram');
const G = process.argv[2] + '/berimbau/maps/';
for (const [map, min, max] of [['duel_temple', 0.75, 1.25], ['duel_practice_box', 0.75, 1.25], ['duel_castle', 0.5, 2]]) {
  const buf = readFileSync(G + map + '.bsp');
  const bsp = new BSP(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const l = bsp.lump(0);
  const s = tonemapSettings(new TextDecoder('latin1').decode(bsp.bytes.subarray(l.off, l.off + l.len)), bsp.entities.filter((e) => e.classname === 'env_tonemap_controller').map((e) => e.targetname));
  check(s.min === min && s.max === max, `${map} limits ${s.min}..${s.max}`);
  console.log(map, JSON.stringify(s));
}
console.log(fails ? `${fails} failed` : 'exposure ok', 'even', run(even).toFixed(2));
process.exit(fails ? 1 : 0);
