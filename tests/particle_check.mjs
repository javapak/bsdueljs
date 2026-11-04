// Runs every effect the game dispatches on real .pcf data: operators are implemented, particles appear,
// one-shot effects finish on their own, and a stopped looping effect drains.
// Usage: node tests/particle_check.mjs "<install>/berimbau"
import fs from 'node:fs';
import path from 'node:path';
import { ParticleLibrary, ParticleInstance, makeCP } from '../shared/particles.js';
const dir = path.join(process.argv[2], 'particles');
const lib = new ParticleLibrary();
for (const f of ['blade_sparks', 'player_generic', 'player_charging', 'player_blocking', 'impact_fx']) lib.add(fs.readFileSync(path.join(dir, f + '.pcf'), 'latin1'));
const host = { trace: () => null, traceNormal: () => null, bonesOf: () => [[0, 0, 40], [0, 10, 60]], localPlayer: () => [0, 0, 0] };
const ONE_SHOT = ['balanced_hit', 'light_hit', 'heavy_hit', 'wallhit_spark', 'smoke_ring', 'riposte_forward_fx', 'penetrate_fx', 'guard_fx', 'feint_fx', 'berimbau_player_charge', 'charge_tier3_forward'];
const LOOP = ['blocking_forward'];
let bad = 0;
const fail = (m) => { console.log('FAIL', m); bad++; };
const cps = () => [Object.assign(makeCP([0, 0, 50], [1, 0, 0]), { entity: 1 }), makeCP([1, 1, 1]), makeCP([0, 0, 90])];
const run = (name, stopAt) => {
  if (!lib.systems.has(name)) { fail(name + ' missing'); return; }
  const un = [...lib.unsupported(name)];
  if (un.length) console.log('  ', name, 'skips', un.join(', '));
  const inst = new ParticleInstance(lib, lib.systems.get(name), host, cps());
  let peak = 0, t = 0;
  for (; t < 12; t += 1 / 60) {
    if (stopAt && t >= stopAt) inst.stop();
    inst.step(1 / 60);
    let n = 0;
    for (const i of inst.visit()) {
      n += i.particles.length;
      for (const p of i.particles) if (![p.x, p.y, p.z, p.radius, p.a].every(Number.isFinite)) { fail(`${name}/${i.def.name} produced a non-finite particle`); return; }
    }
    peak = Math.max(peak, n);
    if (t > 0.3 && inst.done) break;
  }
  if (!peak) fail(name + ' emitted nothing');
  if (!inst.done) fail(name + ` still running after ${t.toFixed(1)}s`);
  console.log(`${inst.done ? 'ok  ' : 'BAD '} ${name}: peak ${peak}, finished at ${t.toFixed(2)}s`);
};
for (const n of ONE_SHOT) run(n);
for (const n of LOOP) run(n, 0.5);
// Map effects: every file in the manifest parses, each effect a map places is implemented and stays finite
const manifest = fs.readFileSync(path.join(dir, 'particles_manifest.txt'), 'latin1');
for (const m of manifest.matchAll(/"file"\s+"!?particles\/([^"]+)"/g)) lib.add(fs.readFileSync(path.join(dir, m[1]), 'latin1'));
const MAP_EFFECTS = ['snow_1', 'rain_heavy_768', 'raindrops_ground_768x768', 'district_sewersteam', 'Lightning_sky01', 'tiny_candle', 'tiny_torch', 'temple_firepit', 'tutorialmap_incense', 'butterfly_01', 'Monastery_courtyard_ivy_wind', 'water_spout', 'water_wheelpour', 'water_wheelland', 'map_winter_waterfall', 'map_winter_waterfall_wake', 'map_winter_waterfall_splash', 'map_winter_waterfall_landing', 'temple_water_edge', 'temple_water_landing', 'sweeper_particle1', 'particle_skybox_waves'];
for (const name of MAP_EFFECTS) {
  if (!lib.systems.has(name)) { fail(name + ' missing'); continue; }
  const un = [...lib.unsupported(name)];
  if (un.length) fail(`${name} skips ${un.join(', ')}`);
  const inst = new ParticleInstance(lib, lib.systems.get(name), host, [makeCP([0, 0, 500], [0, 0, -1], [1, 0, 0]), makeCP([0, 0, 0]), makeCP([100, 0, 0])]);
  let peak = 0;
  for (let t = 0; t < 4; t += 1 / 60) {
    inst.step(1 / 60);
    let n = 0;
    for (const i of inst.visit()) { n += i.particles.length; for (const p of i.particles) if (![p.x, p.y, p.z, p.radius, p.a].every(Number.isFinite)) { fail(`${name}/${i.def.name} non-finite`); break; } }
    peak = Math.max(peak, n);
  }
  console.log(`${peak ? 'ok  ' : 'idle'} ${name}: peak ${peak}`);
}
console.log(bad ? `${bad} failures` : 'all effects ok');
process.exit(bad ? 1 : 0);
