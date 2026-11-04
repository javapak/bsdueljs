// What a model gets lit by at a point: the map's ambient cube samples and world lights. The engine side of this
// (ranking, what falls into the cube) isn't in a shader, so it follows Source's usual rules [I]; the data is the map's.
const EMIT_SURFACE = 0, EMIT_POINT = 1, EMIT_SPOT = 2, EMIT_SKY = 3, EMIT_QUAKE = 4;
const SURF_SKY = 0x4, SURF_SKY2D = 0x2;
const MAX_LIGHTS = 4; // r_worldlights
const AMBIENT_MIN = 0.3, AMBIENT_FRACTION = 0.2, AMBIENT_FACTOR = 5; // r_ambientmin, r_ambientfraction, r_ambientfactor
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class WorldLighting {
  constructor(bsp) {
    this.bsp = bsp;
    const { dv } = bsp;
    const pick = (a, b) => (bsp.lump(a).len ? bsp.lump(a) : bsp.lump(b));
    this.index = pick(51, 52);
    this.ambient = pick(55, 56);
    this.leaves = bsp.lump(10);
    const wl = pick(54, 15);
    this.lights = [];
    for (let i = 0; i < wl.len / 100; i++) {
      const o = wl.off + i * 100, f = (k) => dv.getFloat32(o + k, true);
      const type = dv.getInt32(o + 52, true);
      if (type > EMIT_QUAKE) continue; // sky ambient is already in the cube samples
      let c = f(76), l = f(80), q = f(84);
      if (c === 0 && l === 0 && q === 0) q = 1;
      this.lights.push({
        pos: [f(0), f(4), f(8)], color: [f(12), f(16), f(20)], n: [f(24), f(28), f(32)], type,
        stopdot: f(60), stopdot2: f(64), exponent: f(68) || 1, radius: f(72), c, l, q,
      });
    }
    this.sky = this.lights.find((l) => l.type === EMIT_SKY) ?? null;
    // bsp_cubemap: where each of the map's reflection probes sits
    const cm = bsp.lump(42);
    this.cubemaps = [];
    for (let i = 0; i < cm.len / 16; i++) {
      const o = cm.off + i * 16;
      this.cubemaps.push([dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true)]);
    }
  }

  // The leaf's ambient samples, blended. Six faces, +x -x +y -y +z -z.
  ambientCube(p) {
    const { dv } = this.bsp;
    const leaf = this.bsp.pointLeaf(p), cube = new Float32Array(18);
    if (leaf < 0 || (leaf + 1) * 4 > this.index.len) return cube;
    const count = dv.getUint16(this.index.off + leaf * 4, true), first = dv.getUint16(this.index.off + leaf * 4 + 2, true);
    if (!count) return cube;
    const lo = this.leaves.off + leaf * 32;
    const mn = [0, 2, 4].map((k) => dv.getInt16(lo + 8 + k, true)), mx = [0, 2, 4].map((k) => dv.getInt16(lo + 14 + k, true));
    // [R engine.dll 1801781c0] every sample, weighted by 1/(d^2+1). Decoded at byte * 2^e: the table's 1/255 is undone by a 255.
    let total = 0;
    for (let i = 0; i < count; i++) {
      const o = this.ambient.off + (first + i) * 28;
      let d = 1;
      for (let k = 0; k < 3; k++) d += (mn[k] + (mx[k] - mn[k]) * dv.getUint8(o + 24 + k) / 255 - p[k]) ** 2;
      const w = 1 / d;
      total += w;
      for (let f = 0; f < 6; f++) {
        const c = o + f * 4, e = 2 ** dv.getInt8(c + 3);
        cube[f * 3] += dv.getUint8(c) * e * w; cube[f * 3 + 1] += dv.getUint8(c + 1) * e * w; cube[f * 3 + 2] += dv.getUint8(c + 2) * e * w;
      }
    }
    for (let i = 0; i < 18; i++) cube[i] /= total;
    return cube;
  }

  // Light reaching a point, before picking which ones the model keeps. 0 when blocked.
  _reach(light, p) {
    const { bsp } = this;
    if (light.type === EMIT_SKY) {
      const tr = bsp.traceBox(p, [p[0] - light.n[0] * 16384, p[1] - light.n[1] * 16384, p[2] - light.n[2] * 16384], [0, 0, 0], [0, 0, 0], 1);
      const ti = bsp.texinfo[tr.texinfo];
      return tr.fraction < 1 && ti && ti.flags & (SURF_SKY | SURF_SKY2D) ? 1 : 0;
    }
    const d = [light.pos[0] - p[0], light.pos[1] - p[1], light.pos[2] - p[2]];
    const dist = Math.hypot(d[0], d[1], d[2]) || 1;
    if (light.radius > 0 && dist > light.radius) return 0;
    const cos = -(d[0] * light.n[0] + d[1] * light.n[1] + d[2] * light.n[2]) / dist;
    let ratio = 1 / (light.c + light.l * dist + light.q * dist * dist);
    if (light.type === EMIT_SURFACE) { if (cos <= 0) return 0; ratio *= cos; }
    if (light.type === EMIT_SPOT) {
      if (cos <= light.stopdot2) return 0;
      if (cos < light.stopdot) ratio *= Math.pow((cos - light.stopdot2) / (light.stopdot - light.stopdot2), light.exponent);
    }
    if (ratio <= 0) return 0;
    return bsp.traceBox(p, light.pos, [0, 0, 0], [0, 0, 0], 1).fraction < 1 ? 0 : ratio;
  }

  // { cube: 6 rgb, lights: [{color, dir, pos, spot, atten}] }, strongest lights kept and the rest folded into the cube
  sample(p) {
    const cube = this.ambientCube(p);
    const hits = [];
    for (const l of this.lights) {
      const ratio = this._reach(l, p);
      if (ratio > 0) hits.push({ l, ratio, score: ratio * Math.max(l.color[0], l.color[1], l.color[2]) });
    }
    // [R shaderapidx9 r_force_first_dynamic_light_to_directional_for_csm] the sun is light 0, the one the shadow map applies to
    hits.sort((a, b) => (b.l.type === EMIT_SKY) - (a.l.type === EMIT_SKY) || b.score - a.score);
    for (const { l, ratio } of hits.slice(MAX_LIGHTS)) {
      const d = l.type === EMIT_SKY ? [-l.n[0], -l.n[1], -l.n[2]] : [l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      AXES.forEach((a, f) => {
        const w = Math.max(0, (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / len) * ratio;
        for (let k = 0; k < 3; k++) cube[f * 3 + k] += w * l.color[k];
      });
    }
    this._boost(cube, hits.slice(0, MAX_LIGHTS), p);
    const lights = hits.slice(0, MAX_LIGHTS).map(({ l }) => {
      const sky = l.type === EMIT_SKY, surface = l.type === EMIT_SURFACE, spot = l.type === EMIT_SPOT;
      const inner = surface ? 1 : l.stopdot, outer = surface ? 0 : l.stopdot2;
      return {
        color: [l.color[0], l.color[1], l.color[2], sky ? 1 : 0], dir: [l.n[0], l.n[1], l.n[2], spot || surface ? 1 : 0],
        pos: sky ? [p[0] - l.n[0] * 1e6, p[1] - l.n[1] * 1e6, p[2] - l.n[2] * 1e6, 0] : [l.pos[0], l.pos[1], l.pos[2], 0],
        spot: [surface ? 1 : l.exponent, 0, outer, inner > outer ? 1 / (inner - outer) : 1], atten: [l.c, l.l, l.q, 0],
      };
    });
    return { cube, lights };
  }

  // [R engine.dll 180161ce0] r_ambientboost: an ambient cube swamped by its direct lights is lifted toward r_ambientfraction of
  // them, unless it's already over r_ambientmin, and by no more than r_ambientfactor.
  _boost(cube, hits, p) {
    const lum = (r, g, b) => r * 0.3 + g * 0.59 + b * 0.11;
    let avg = 0, peak = 0;
    for (let f = 0; f < 6; f++) { const v = lum(cube[f * 3], cube[f * 3 + 1], cube[f * 3 + 2]); avg += v; peak = Math.max(peak, v); }
    avg /= 6;
    let direct = 0;
    for (const { l } of hits) {
      let at = 1;
      if (l.type !== EMIT_SKY) {
        const dist = Math.hypot(l.pos[0] - p[0], l.pos[1] - p[1], l.pos[2] - p[2]), den = l.c + l.l * dist + l.q * dist * dist;
        if (den > 1e-5) at = 1 / den;
      }
      direct += lum(l.color[0], l.color[1], l.color[2]) * at;
    }
    const target = direct * AMBIENT_FRACTION;
    if (avg >= AMBIENT_MIN || avg >= target || peak <= 0) return;
    const k = Math.min(target / peak, AMBIENT_FACTOR);
    for (let i = 0; i < 18; i++) cube[i] *= k;
  }

  nearestCubemap(p) {
    let best = -1, bestD = Infinity;
    this.cubemaps.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bestD) { bestD = d; best = i; } });
    return best;
  }
}
