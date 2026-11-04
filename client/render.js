// WebGPU renderer: BSP world with HDR lightmaps, displacements with 2-way blending,
// static props, skinned characters and a sword blade. Source is z-up, right-handed.
import { parseKV, kvGet } from '/shared/kv.js';
import { parseVTF, decodeLevel, isBCFormat } from './vtf.js';
import { Model, buildMesh } from '/shared/mdl.js';
import { JiggleBones, jiggleInfo } from '/shared/jiggle.js';
import { SURF_TRANS, SURF_NODRAW, SURF_SKY, SURF_SKY2D, SURF_TRIGGER, SURF_SKIP, SURF_HINT } from '/shared/bsp.js';
const SURF_BUMPLIGHT = 0x800;
import { matMul, quatMatrix, rigidInverse } from '/shared/mathx.js';
import { WorldLighting } from './lighting.js';
import { propMatrix } from '/shared/phy.js';
import { Exposure, tonemapSettings } from '/shared/exposure.js';

// LightmappedGeneric and WorldVertexTransition, ported from lightmappedgeneric_ps30. Output is linear light times the
// tonemap scale (cLightScale.x), which the game's sRGB framebuffer write encodes. CSM shadows aren't in yet.
const WORLD_WGSL = /* wgsl */`
override CUT: f32 = -1.0;
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f, csm: array<mat4x4f, 3>, csmColor: vec4f, csmParam: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var lm: texture_2d<f32>;
@group(0) @binding(3) var lmSamp: sampler;
@group(0) @binding(6) var lmSun: texture_2d<f32>;
@group(0) @binding(4) var csmTex: texture_depth_2d;
@group(0) @binding(5) var csmSamp: sampler_comparison;
// [R lightmappedgeneric_ps30] nine taps: corners 1/16, edges 1/8, center 1/4
fn csmPcf(uv: vec2f, z: f32) -> f32 {
  let t = vec2f(1.0 / 3072.0, 1.0 / 1024.0);
  var s = textureSampleCompareLevel(csmTex, csmSamp, uv, z) * 0.25;
  for (var i = 0; i < 4; i++) {
    let a = vec2f(select(-1.0, 1.0, (i & 1) == 0), select(-1.0, 1.0, (i & 2) == 0));
    s += textureSampleCompareLevel(csmTex, csmSamp, uv + a * t, z) * 0.0625;
    s += textureSampleCompareLevel(csmTex, csmSamp, uv + select(vec2f(0, a.y), vec2f(a.x, 0), (i & 1) == 0) * t, z) * 0.125;
  }
  return s;
}
fn csmCascade(i: i32, c: vec4f) -> f32 { return csmPcf(vec2f((c.x * 0.5 + 0.5 + f32(i)) / 3.0, 0.5 - c.y * 0.5), c.z - 0.00015); }
// 1 lit, 0 shadowed; the first cascade holding the point, blended into the next near its edge, fading out with distance
fn csmShadow(w: vec3f) -> f32 {
  if (cam.csmColor.w == 0.0) { return 1.0; }
  var s = 1.0;
  let c0 = cam.csm[0] * vec4f(w, 1); let c1 = cam.csm[1] * vec4f(w, 1); let c2 = cam.csm[2] * vec4f(w, 1);
  let e0 = max(abs(c0.x), abs(c0.y)); let e1 = max(abs(c1.x), abs(c1.y)); let e2 = max(abs(c2.x), abs(c2.y));
  if (e0 < 0.98) { s = csmCascade(0, c0); if (e0 > 0.8) { s = mix(s, csmCascade(1, c1), (e0 - 0.8) / 0.18); } }
  else if (e1 < 0.98) { s = csmCascade(1, c1); if (e1 > 0.8) { s = mix(s, csmCascade(2, c2), (e1 - 0.8) / 0.18); } }
  else if (e2 < 0.98) { s = csmCascade(2, c2); }
  let d = w - cam.eye.xyz;
  return mix(s, 1.0, saturate(dot(d, d) * cam.csmParam.x + cam.csmParam.y));
}
// tint: lightmap tint. env: envmap tint, contrast. flags: bump (1 normal, 2 ssbump), envmap, mask (1 bump alpha, 2 inverted base alpha, 3 texture), selfillum.
// opts: saturation, unlit, detail, detail scale. extra: seamless scale, detail blend factor.
struct M { tint: vec4f, env: vec4f, flags: vec4f, opts: vec4f, extra: vec4f };
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
@group(1) @binding(2) var bump0: texture_2d<f32>;
@group(1) @binding(3) var bump1: texture_2d<f32>;
@group(1) @binding(4) var mask: texture_2d<f32>;
@group(1) @binding(5) var detail: texture_2d<f32>;
@group(1) @binding(6) var envmap: texture_cube<f32>;
@group(1) @binding(7) var<uniform> m: M;
struct V { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) luv: vec2f, @location(3) blend: f32, @location(4) lstep: f32, @location(5) n: vec3f, @location(6) s: vec3f, @location(7) t: vec3f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) luv: vec2f, @location(2) blend: f32, @location(3) w: vec3f, @location(4) lstep: f32, @location(5) n: vec3f, @location(6) s: vec3f, @location(7) t: vec3f };
@vertex fn vs(v: V) -> O { var o: O; o.p = cam.vp * vec4f(v.pos, 1); o.uv = v.uv; o.luv = v.luv; o.blend = v.blend; o.w = v.pos; o.lstep = v.lstep; o.n = v.n; o.s = v.s; o.t = v.t; return o; }
fn finish(c: vec3f) -> vec4f {
  let x = clamp(c * cam.fog.w, vec3f(0), vec3f(1));
  return vec4f(select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308)), 1);
}
// [R lightmappedgeneric_ps30] $seamless_scale samples three planes, weighted by the normal
fn tex(t: texture_2d<f32>, i: O) -> vec4f {
  if (m.extra.x <= 0.0) { return textureSample(t, samp, i.uv); }
  let w = i.n * i.n; let p = i.w * m.extra.x;
  return textureSample(t, samp, p.zy) * w.x + textureSample(t, samp, p.xz) * w.y + textureSample(t, samp, p.xy) * w.z;
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  var c = mix(tex(t0, i), tex(t1, i), i.blend);
  if (c.a < CUT) { discard; }
  let d = textureSample(detail, samp, i.uv * m.opts.w).rgb;
  if (m.opts.z > 0.0) { c = vec4f(c.rgb * mix(vec3f(1), 2.0 * d, m.extra.y), c.a); }
  if (m.opts.y > 0.0) { return finish(c.rgb); }
  let nt = mix(tex(bump0, i), tex(bump1, i), i.blend);
  let flat_ = textureSampleLevel(lm, lmSamp, i.luv, 0).rgb;
  let l1 = textureSampleLevel(lm, lmSamp, i.luv + vec2f(i.lstep, 0), 0).rgb;
  let l2 = textureSampleLevel(lm, lmSamp, i.luv + vec2f(i.lstep * 2.0, 0), 0).rgb;
  let l3 = textureSampleLevel(lm, lmSamp, i.luv + vec2f(i.lstep * 3.0, 0), 0).rgb;
  const B0 = vec3f(0.816496611, 0, 0.577350259);
  const B1 = vec3f(-0.408248335, 0.707106769, 0.577350259);
  const B2 = vec3f(-0.408248216, -0.707106829, 0.577350259);
  let s0 = textureSampleLevel(lmSun, lmSamp, i.luv, 0).r;
  let s1 = textureSampleLevel(lmSun, lmSamp, i.luv + vec2f(i.lstep, 0), 0).r;
  let s2 = textureSampleLevel(lmSun, lmSamp, i.luv + vec2f(i.lstep * 2.0, 0), 0).r;
  let s3 = textureSampleLevel(lmSun, lmSamp, i.luv + vec2f(i.lstep * 3.0, 0), 0).r;
  let blocked = 1.0 - csmShadow(i.w);
  var light = flat_ - s0 * cam.csmColor.rgb * blocked;
  var ts = vec3f(0, 0, 1);
  if (m.flags.x == 1.0) {
    ts = nt.xyz * 2.0 - 1.0;
    var dp = vec3f(saturate(dot(ts, B0)), saturate(dot(ts, B1)), saturate(dot(ts, B2)));
    dp *= dp;
    light = (dp.x * l1 + dp.y * l2 + dp.z * l3 - dot(dp, vec3f(s1, s2, s3)) * cam.csmColor.rgb * blocked) / dot(dp, vec3f(1));
  } else if (m.flags.x == 2.0) {
    ts = normalize(B0 * nt.x + B1 * nt.y + B2 * nt.z);
    light = nt.x * l1 + nt.y * l2 + nt.z * l3 - (nt.x * s1 + nt.y * s2 + nt.z * s3) * cam.csmColor.rgb * blocked;
  }
  light = max(light, vec3f(0));
  light *= m.tint.rgb;
  var out_ = c.rgb * light;
  if (m.flags.w > 0.0) { out_ = mix(out_, c.rgb, c.a); }
  let N = normalize(i.s) * ts.x + normalize(i.t) * ts.y + normalize(i.n) * ts.z;
  let eye = cam.eye.xyz - i.w;
  var spec = textureSample(envmap, samp, 2.0 * dot(N, eye) * N - dot(N, N) * eye).rgb;
  let maskTex = tex(mask, i).rgb;
  if (m.flags.y > 0.0) {
    if (m.flags.z == 1.0) { spec *= nt.a; } else if (m.flags.z == 2.0) { spec *= 1.0 - c.a; } else if (m.flags.z == 3.0) { spec *= maskTex; }
    spec *= m.env.rgb;
    spec = mix(spec, spec * spec, m.env.w);
    spec = mix(vec3f(dot(spec, vec3f(0.299, 0.587, 0.114))), spec, m.opts.x);
    out_ += spec;
  }
  return finish(out_);
}`;
// [R water_ps30] the flow map, fresnel and refraction. The live game reflects a second render of the scene; here the
// reflection comes from the material's cubemap, the same sampling as the shader's envmap variant.
const WATER_WGSL = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f, csm: array<mat4x4f, 3>, csmColor: vec4f, csmParam: vec4f };
struct W { inv: mat4x4f, right: vec4f, up: vec4f, time: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var lm: texture_2d<f32>;
@group(0) @binding(3) var edge: sampler;
@group(0) @binding(4) var scene: texture_2d<f32>;
@group(0) @binding(5) var depth: texture_depth_2d;
@group(0) @binding(6) var<uniform> w: W;
// flow: 1/world uv scale, 1/normal uv scale, bump strength, has flow map. flow2: interval, scroll distance, noise scale, time scale.
// tint: reflect tint, refract amount. fog: color, enabled. range: fog start, end, lightmap fog, 1 for the Refract shader.
// A Refract material uses flow2 as the normal map's scroll per second and tint as $refracttint.
struct M { flow: vec4f, flow2: vec4f, tint: vec4f, fog: vec4f, range: vec4f };
@group(1) @binding(0) var normalMap: texture_2d<f32>;
@group(1) @binding(1) var flowMap: texture_2d<f32>;
@group(1) @binding(2) var noise: texture_2d<f32>; // the refract tint texture on a Refract material
@group(1) @binding(3) var envmap: texture_cube<f32>;
@group(1) @binding(4) var<uniform> m: M;
struct V { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) luv: vec2f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) luv: vec2f, @location(2) w: vec3f, @location(3) cw: f32 };
@vertex fn vs(v: V) -> O { var o: O; o.p = cam.vp * vec4f(v.pos, 1); o.uv = v.uv; o.luv = v.luv; o.w = v.pos; o.cw = o.p.w; return o; }
fn surfaceNormal(i: O) -> vec3f {
  if (m.flow.w == 0.0) { return vec3f(textureSample(normalMap, samp, i.uv).xy * 2.0 - 1.0, 1.0); }
  // Two scrolling layers half a cycle apart, each jumping to a new place while the other is at full weight
  let world = vec2f(i.w.x, -i.w.y);
  let t = w.time.x * m.flow2.w / (2.0 * m.flow2.x) + textureSample(noise, samp, world * m.flow2.z).g;
  let flow = textureSample(flowMap, samp, i.uv * m.flow.x).xy * 2.0 - 1.0;
  let scroll = flow * m.flow2.y;
  let strength = (dot(flow, flow) + 0.1) * m.flow.z;
  let base = world * m.flow.y;
  let f1 = fract(t + 0.5);
  let a = textureSample(normalMap, samp, base + floor(t + 0.5) * 0.311 + 0.5 + scroll * f1).xy;
  let f2 = fract(t);
  let b = textureSample(normalMap, samp, base + floor(t) * 0.311 + scroll * f2).xy;
  let n = (mix(b, a, abs(f2 * 2.0 - 1.0)) * 2.0 - 1.0) * strength;
  return vec3f(n, sqrt(max(1.0 - dot(n, n), 0.0)));
}
fn toLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn fromLinear(c: vec3f) -> vec3f { let x = clamp(c, vec3f(0), vec3f(1)); return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308)); }
// How far the view ray travels under the surface, at this pixel of the depth buffer
fn underwater(uv: vec2f, size: vec2f, surface: vec3f) -> f32 {
  let z = textureLoad(depth, vec2i(clamp(uv, vec2f(0), vec2f(1)) * size), 0);
  let h = w.inv * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  let below = h.xyz / h.w;
  return select(0.0, length(below - surface), below.z < surface.z);
}
// [R refract_ps] the scene through a scrolling normal map and a tint; the offset is in clip space, so it shrinks with distance
fn refractShader(i: O) -> vec4f {
  let n = textureSample(normalMap, samp, i.uv + m.flow2.xy * w.time.x).xy * 2.0 - 1.0;
  let tint = textureSample(noise, samp, i.uv).rgb * m.tint.rgb;
  let uv = i.p.xy / vec2f(textureDimensions(scene)) + n * m.tint.w / max(i.cw, 1.0) * vec2f(0.5, -0.5);
  return vec4f(fromLinear(toLinear(textureSampleLevel(scene, edge, uv, 0.0).rgb) * tint), 1.0);
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let N = surfaceNormal(i);
  if (m.range.w > 0.0) { return refractShader(i); }
  let toEye = cam.eye.xyz - i.w;
  let E = normalize(toEye);
  let ne = dot(N, E);
  let x = exp(saturate(ne) * -9.28) + 0.0425;
  let fresnel = (1.04 - 1.04 * x) * 0.05 + (1.04 * x - 0.04);
  let reflected = textureSample(envmap, samp, 2.0 * ne * N - dot(N, N) * E).rgb * m.tint.rgb;
  let size = vec2f(textureDimensions(scene));
  let uv0 = i.p.xy / size;
  // The fog factor kept in the refraction target's alpha fades the distortion out at the shore
  let fogAt = fn_fog(underwater(uv0, size, i.w));
  let uv1 = uv0 + vec2f(dot(w.right.xyz, N), -dot(w.up.xyz, N)) * m.tint.w * select(1.0, fogAt, m.fog.w > 0.0);
  // Refraction can't pick up what's above the surface: fall back to the straight-through pixel
  let d1 = underwater(uv1, size, i.w);
  let uv = select(uv0, uv1, d1 > 0.0);
  var refr = toLinear(textureSampleLevel(scene, edge, uv, 0.0).rgb);
  if (m.fog.w > 0.0) {
    var fog = m.fog.rgb;
    if (m.range.z > 0.0) { fog *= 2.0 * textureSampleLevel(lm, edge, i.luv, 0.0).rgb; }
    refr = mix(refr, fog * cam.fog.w, fn_fog(underwater(uv, size, i.w)));
  }
  return vec4f(fromLinear(refr + fresnel * reflected * cam.fog.w), 1.0);
}
fn fn_fog(d: f32) -> f32 { return saturate((d - m.range.x) / max(m.range.y - m.range.x, 0.001)); }`;
// VertexLitGeneric and its phong path, shared by props and characters. Ported from phong_ps30.
const MODEL_COMMON = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f, csm: array<mat4x4f, 3>, csmColor: vec4f, csmParam: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var csmTex: texture_depth_2d;
@group(0) @binding(3) var csmSamp: sampler_comparison;
// [R lightmappedgeneric_ps30] nine taps: corners 1/16, edges 1/8, center 1/4
fn csmPcf(uv: vec2f, z: f32) -> f32 {
  let t = vec2f(1.0 / 3072.0, 1.0 / 1024.0);
  var s = textureSampleCompareLevel(csmTex, csmSamp, uv, z) * 0.25;
  for (var i = 0; i < 4; i++) {
    let a = vec2f(select(-1.0, 1.0, (i & 1) == 0), select(-1.0, 1.0, (i & 2) == 0));
    s += textureSampleCompareLevel(csmTex, csmSamp, uv + a * t, z) * 0.0625;
    s += textureSampleCompareLevel(csmTex, csmSamp, uv + select(vec2f(0, a.y), vec2f(a.x, 0), (i & 1) == 0) * t, z) * 0.125;
  }
  return s;
}
fn csmCascade(i: i32, c: vec4f) -> f32 { return csmPcf(vec2f((c.x * 0.5 + 0.5 + f32(i)) / 3.0, 0.5 - c.y * 0.5), c.z - 0.00015); }
// 1 lit, 0 shadowed; the first cascade holding the point, blended into the next near its edge, fading out with distance
fn csmShadow(w: vec3f) -> f32 {
  if (cam.csmColor.w == 0.0) { return 1.0; }
  var s = 1.0;
  let c0 = cam.csm[0] * vec4f(w, 1); let c1 = cam.csm[1] * vec4f(w, 1); let c2 = cam.csm[2] * vec4f(w, 1);
  let e0 = max(abs(c0.x), abs(c0.y)); let e1 = max(abs(c1.x), abs(c1.y)); let e2 = max(abs(c2.x), abs(c2.y));
  if (e0 < 0.98) { s = csmCascade(0, c0); if (e0 > 0.8) { s = mix(s, csmCascade(1, c1), (e0 - 0.8) / 0.18); } }
  else if (e1 < 0.98) { s = csmCascade(1, c1); if (e1 > 0.8) { s = mix(s, csmCascade(2, c2), (e1 - 0.8) / 0.18); } }
  else if (e2 < 0.98) { s = csmCascade(2, c2); }
  let d = w - cam.eye.xyz;
  return mix(s, 1.0, saturate(dot(d, d) * cam.csmParam.x + cam.csmParam.y));
}
// tint: $color2. fres: fresnel ranges, boost. env: tint, mask from the normal map's alpha. spec: tint (x < 0 uses albedo), rim exponent.
// ctl: mask from base alpha, mask from luminance, exponent override, invert mask. rim: phong, rimlight, rim boost, rim mask.
// has: diffuse warp, specular warp, envmap, albedo tint. misc: selfillum, unlit.
// misc also: non-phong mask (1 normal alpha, 2 inverted base alpha), contrast. ext: saturation.
// uvBase, uvBump: $basetexturetransform and $bumptransform, two rows each. The exponent map follows the base's.
struct M { tint: vec4f, fres: vec4f, env: vec4f, spec: vec4f, ctl: vec4f, rim: vec4f, has: vec4f, misc: vec4f, ext: vec4f, uvBase: array<vec4f, 2>, uvBump: array<vec4f, 2> };
fn baseUv(uv: vec2f) -> vec2f { let p = vec3f(uv, 1); return vec2f(dot(m.uvBase[0].xyz, p), dot(m.uvBase[1].xyz, p)); }
fn bumpUv(uv: vec2f) -> vec2f { let p = vec3f(uv, 1); return vec2f(dot(m.uvBump[0].xyz, p), dot(m.uvBump[1].xyz, p)); }
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var specWarp: texture_2d<f32>;
@group(1) @binding(2) var diffWarp: texture_2d<f32>;
@group(1) @binding(3) var normalMap: texture_2d<f32>;
@group(1) @binding(4) var specExp: texture_2d<f32>;
@group(1) @binding(5) var<uniform> m: M;
fn finish(c: vec3f) -> vec4f {
  let x = clamp(c * cam.fog.w, vec3f(0), vec3f(1));
  return vec4f(select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308)), 1);
}
fn worldNormal(ts: vec3f, n: vec3f, t: vec4f) -> vec3f {
  let N = normalize(n); let T = normalize(t.xyz);
  return normalize(T * ts.x + cross(N, T) * t.w * ts.y + N * ts.z);
}
fn fresnel(f: f32) -> f32 {
  let f2 = f * f;
  if (0.5 - f2 >= 0.0) { return 2.0 * f2 * (m.fres.y - m.fres.x) + m.fres.x; }
  return mix(m.fres.y, m.fres.z, 2.0 * f2 - 1.0);
}
`;
const PROP_WGSL = MODEL_COMMON + /* wgsl */`
override CUT: f32 = -1.0;
@group(2) @binding(0) var envmap: texture_cube<f32>;
struct V { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(8) tan: vec4f, @location(3) m0: vec4f, @location(4) m1: vec4f, @location(5) m2: vec4f, @location(9) c0: vec4f, @location(10) c1: vec4f, @location(11) c2: vec4f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) n: vec3f, @location(2) w: vec3f, @location(3) t: vec4f, @location(4) c0: vec3f, @location(5) c1: vec3f, @location(6) c2: vec3f, @location(7) sun: vec3f };
@vertex fn vs(v: V) -> O {
  var o: O;
  let w = vec3f(dot(v.m0, vec4f(v.pos, 1)), dot(v.m1, vec4f(v.pos, 1)), dot(v.m2, vec4f(v.pos, 1)));
  o.p = cam.vp * vec4f(w, 1); o.uv = v.uv; o.w = w;
  o.n = vec3f(dot(v.m0.xyz, v.n), dot(v.m1.xyz, v.n), dot(v.m2.xyz, v.n));
  o.t = vec4f(dot(v.m0.xyz, v.tan.xyz), dot(v.m1.xyz, v.tan.xyz), dot(v.m2.xyz, v.tan.xyz), v.tan.w);
  // [R phong_vs30] the baked colors decode as (2c)^2.2
  o.c0 = pow(v.c0.rgb * 2.0, vec3f(2.2)); o.c1 = pow(v.c1.rgb * 2.0, vec3f(2.2)); o.c2 = pow(v.c2.rgb * 2.0, vec3f(2.2));
  o.sun = vec3f(v.c0.a, v.c1.a, v.c2.a);
  return o;
}
// [R phong_ps30, baked vertex lighting] three colors along the bump basis. No world lights reach it, so no phong highlight.
@fragment fn fs(i: O) -> @location(0) vec4f {
  let c = textureSample(t0, samp, baseUv(i.uv)); if (c.a < CUT) { discard; }
  let nt = textureSample(normalMap, samp, bumpUv(i.uv));
  if (m.misc.y > 0.0) { return finish(c.rgb); }
  let ts = nt.xyz * 2.0 - 1.0;
  var dp = vec3f(saturate(dot(ts, vec3f(0.816496611, 0, 0.577350259))), saturate(dot(ts, vec3f(-0.408248335, 0.707106769, 0.577350259))), saturate(dot(ts, vec3f(-0.408248216, -0.707106829, 0.577350259))));
  dp *= dp;
  let lit = csmShadow(i.w);
  let light = (dp.x * i.c0 + dp.y * i.c1 + dp.z * i.c2 + dot(dp, i.sun) * cam.csmColor.rgb * lit) / dot(dp, vec3f(1));
  let N = worldNormal(ts, i.n, i.t);
  let view = normalize(cam.eye.xyz - i.w);
  var ref_ = textureSample(envmap, samp, 2.0 * dot(N, view) * N - view).rgb;
  var envMask: f32;
  if (m.rim.x > 0.0) {
    // [R phong_ps30]
    envMask = mix(c.a, mix(nt.a, c.a, m.ctl.x), m.env.w);
    envMask = mix(envMask, 1.0 - envMask, m.ctl.w);
    ref_ *= m.env.rgb;
  } else {
    // [R vertexlit_and_unlit_generic_bump_ps30] tinted, then contrast and saturation
    envMask = select(select(1.0, 1.0 - c.a, m.misc.z == 2.0), nt.a, m.misc.z == 1.0);
    ref_ *= m.env.rgb * envMask;
    envMask = 1.0;
    ref_ = mix(ref_, ref_ * ref_, m.misc.w);
    ref_ = mix(vec3f(dot(ref_, vec3f(0.299, 0.587, 0.114))), ref_, m.ext.x);
  }
  var diffuse = c.rgb * m.tint.rgb * light;
  if (m.misc.x > 0.0) { diffuse = mix(diffuse, c.rgb, c.a); }
  return finish(diffuse + ref_ * envMask * m.has.z);
}`;
const SKIN_WGSL = MODEL_COMMON + /* wgsl */`
override CUT: f32 = -1.0;
struct Light { color: vec4f, dir: vec4f, pos: vec4f, spot: vec4f, atten: vec4f };
struct B { m: array<mat3x4f, 128>, tint: vec4f, ch: array<vec4f, 6>, cube: array<vec4f, 6>, lights: array<Light, 4>, count: vec4f };
@group(2) @binding(0) var<uniform> b: B;
@group(3) @binding(0) var envmap: texture_cube<f32>;
struct V { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) w: vec3f, @location(4) idx: vec4u, @location(8) tan: vec4f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) n: vec3f, @location(2) wp: vec3f, @location(3) t: vec4f, @location(4) atten: vec4f };
fn xf(i: u32, p: vec4f) -> vec3f { return p * b.m[i]; }
// [R phong_vs30] per-vertex falloff; a directional light stays at 1
fn falloff(l: Light, wp: vec3f) -> f32 {
  let d = l.pos.xyz - wp;
  let d2 = dot(d, d); let inv = inverseSqrt(d2);
  let a = 1.0 / dot(l.atten.xyz, vec3f(1.0, d2 * inv, d2));
  let s = min(pow(max((dot(l.dir.xyz, -d * inv) - l.spot.z) * l.spot.w, 1e-4), l.spot.x), 1.0);
  let r = a + l.dir.w * (a * s - a);
  return r + l.color.w * (1.0 - r);
}
@vertex fn vs(v: V) -> O {
  var o: O;
  let p4 = vec4f(v.pos, 1); let n4 = vec4f(v.n, 0); let t4 = vec4f(v.tan.xyz, 0);
  let wp = xf(v.idx.x, p4) * v.w.x + xf(v.idx.y, p4) * v.w.y + xf(v.idx.z, p4) * v.w.z;
  let wn = xf(v.idx.x, n4) * v.w.x + xf(v.idx.y, n4) * v.w.y + xf(v.idx.z, n4) * v.w.z;
  let wt = xf(v.idx.x, t4) * v.w.x + xf(v.idx.y, t4) * v.w.y + xf(v.idx.z, t4) * v.w.z;
  o.p = cam.vp * vec4f(wp, 1); o.uv = v.uv; o.n = wn; o.wp = wp; o.t = vec4f(wt, v.tan.w);
  for (var k = 0; k < 4; k++) { o.atten[k] = select(0.0, falloff(b.lights[k], wp), f32(k) < b.count.x); }
  return o;
}
fn ambient(n: vec3f) -> vec3f {
  let s = n * n;
  let x = select(b.cube[1].xyz, b.cube[0].xyz, n.x >= 0.0); let y = select(b.cube[3].xyz, b.cube[2].xyz, n.y >= 0.0); let z = select(b.cube[5].xyz, b.cube[4].xyz, n.z >= 0.0);
  return s.x * x + s.y * y + s.z * z;
}
// [R phong_ps30, dynamic lights]
@fragment fn fs(i: O) -> @location(0) vec4f {
  let c0 = textureSample(t0, samp, baseUv(i.uv)); if (c0.a < CUT) { discard; }
  let nt = textureSample(normalMap, samp, bumpUv(i.uv));
  let ex = textureSample(specExp, samp, baseUv(i.uv));
  // [R phong_ps30, proxy client.dll 1802b1350] $phongexponenttintmaskenable: the exponent texture's blue is how much of the
  // base becomes its own brightness in the fighter's color; below 0.01 it's left alone
  var c = c0;
  if (m.ext.y > 0.0 && b.tint.a > 0.0 && ex.b >= 0.01) {
    let grey = dot(c0.rgb, vec3f(0.3, 0.59, 0.11));
    c = vec4f(mix(c0.rgb, grey * mix(vec3f(1), b.tint.rgb, ex.b), b.tint.a), c0.a);
  }
  if (m.misc.y > 0.0) { return finish(c.rgb); }
  let N = worldNormal(nt.xyz * 2.0 - 1.0, i.n, i.t);
  let view = normalize(cam.eye.xyz - i.wp);
  let NdotV = dot(N, view);
  let f = 1.0 - saturate(NdotV);
  let fres = fresnel(f);
  let lum = dot(c0.rgb, vec3f(0.3, 0.59, 0.11));
  let specMaskRaw = mix(mix(nt.a, c.a, m.ctl.x), lum, m.ctl.y);
  var mask = mix(c.a, specMaskRaw, m.env.w);
  mask = mix(mask, 1.0 - mask, m.ctl.w);
  let exponent = select(1.0 + 149.0 * ex.r, m.ctl.z, m.ctl.z != 0.0);
  let rimMask = mix(1.0, ex.a, m.rim.w);
  let specTint = select(mix(vec3f(1), c.rgb, ex.g * m.has.w), m.spec.rgb, m.spec.x >= 0.0);
  let refl = 2.0 * NdotV * N - view;
  var diffuse = ambient(N);
  var spec = vec3f(0); var rim = vec3f(0);
  let sunLit = csmShadow(i.wp);
  for (var k = 0; k < 4; k++) {
    if (f32(k) >= b.count.x) { break; }
    let l = b.lights[k];
    let col = l.color.rgb * i.atten[k] * select(1.0, sunLit, l.color.w > 0.0);
    let L = normalize(l.pos.xyz - i.wp);
    let ndl = saturate(dot(N, L));
    let wrap = (ndl * ndl + ndl) * 0.5;
    diffuse += col * select(vec3f(wrap), textureSampleLevel(diffWarp, samp, vec2f(wrap, wrap), 0).rgb, m.has.x > 0.0);
    let rdl = saturate(dot(refl, L));
    let s = pow(max(rdl, 1e-5), exponent);
    let warp = select(vec3f(fres), textureSampleLevel(specWarp, samp, vec2f(s, fres), 0).rgb, m.has.y > 0.0);
    spec += col * s * warp * ndl;
    rim += col * pow(max(rdl, 1e-5), m.spec.w) * ndl;
  }
  spec *= specTint * specMaskRaw * m.fres.w * m.rim.x;
  let f4 = f * f * f * f * rimMask * m.rim.y;
  var out_ = max(spec, rim * f4);
  out_ += ambient(view) * f4 * m.rim.z * saturate(N.z);
  out_ += textureSample(envmap, samp, refl).rgb * m.env.rgb * mask * m.has.z;
  let tinted = mix(vec3f(1), m.tint.rgb, 1.0);
  var lit = c.rgb * tinted * diffuse;
  if (m.misc.x > 0.0) { lit = mix(lit, c.rgb, c.a); }
  return finish(lit + out_);
}`;
// bb_charge: drawn over a character while charging. Ported from bb_charge_vs30/ps30; the normal map's
// tangent frame comes from screen derivatives because the mesh has no tangents here.
const CHARGE_WGSL = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var tCharge: texture_2d<f32>;
@group(1) @binding(1) var tNoise: texture_2d<f32>;
@group(1) @binding(2) var tNormal: texture_2d<f32>;
// ch[0] amount, pulse phase, flow time, flow scale; ch[1] color; ch[2] noise amount, noise base scale, specular boost, glow boost
// ch[3] fresnel power min, max, fresnel amount; ch[4] darken inner, outer, rim strength, rim power; ch[5] rim color
struct B { m: array<mat3x4f, 128>, tint: vec4f, ch: array<vec4f, 6> };
@group(2) @binding(0) var<uniform> b: B;
struct V { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) w: vec3f, @location(4) idx: vec4u };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) n: vec3f, @location(2) wp: vec3f, @location(3) nx: vec4f, @location(4) nz: vec2f, @location(5) tri: vec3f };
fn xf(i: u32, p: vec4f) -> vec3f { return p * b.m[i]; }
@vertex fn vs(v: V) -> O {
  var o: O;
  let p4 = vec4f(v.pos, 1); let n4 = vec4f(v.n, 0);
  let wp = xf(v.idx.x, p4) * v.w.x + xf(v.idx.y, p4) * v.w.y + xf(v.idx.z, p4) * v.w.z;
  let wn = xf(v.idx.x, n4) * v.w.x + xf(v.idx.y, n4) * v.w.y + xf(v.idx.z, n4) * v.w.z;
  o.p = cam.vp * vec4f(wp, 1); o.uv = v.uv; o.n = wn; o.wp = wp;
  let s = b.ch[0].w; let t = b.ch[0].z;
  o.nx = vec4f(v.pos.x * s, v.pos.y * s, v.pos.x * s, (v.pos.z - t) * s);
  o.nz = vec2f(v.pos.y * s, (v.pos.z - t) * s);
  o.tri = abs(vec3f(v.n.z, v.n.y, v.n.x));
  return o;
}
@fragment fn fs(i: O, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let amount = b.ch[0].x;
  // [R bb_charge_ps30 vFace] the models wind the other way from WebGPU's default front face
  let view = normalize(cam.eye.xyz - i.wp) * select(1.0, -1.0, ff);
  let nt = textureSample(tNormal, samp, i.uv);
  let ts = pow(nt.xyz, vec3f(1.0 / 2.2)) * 2.0 - 1.0;
  let dpx = dpdx(i.wp); let dpy = dpdy(i.wp); let dux = dpdx(i.uv); let duy = dpdy(i.uv);
  let N = normalize(i.n);
  let T = dpx * duy.y - dpy * dux.y; let Bt = dpy * dux.x - dpx * duy.x;
  let k = max(max(dot(T, T), dot(Bt, Bt)), 1e-8);
  let n = normalize(T / sqrt(k) * ts.x + Bt / sqrt(k) * ts.y + N * ts.z);
  let fres = clamp(1.0 - dot(view, n), 1e-4, 1.0);
  let pulse = 0.5 + 0.5 * sin(b.ch[0].y);
  let pf = pulse + (1.0 - pulse) * fres;
  let nA = textureSample(tNoise, samp, i.nx.xy).x * i.tri.x + textureSample(tNoise, samp, i.nx.zw).x * i.tri.y + textureSample(tNoise, samp, i.nz).x * i.tri.z;
  let noise = clamp((nA - textureSample(tNoise, samp, i.uv * b.ch[2].y).x) * b.ch[2].x, 0.0, 1.0);
  let mask = textureSample(tCharge, samp, i.uv).a;
  let spec = nt.a * b.ch[2].z;
  let body = pf * (mask * b.ch[2].w - noise - spec) + spec;
  let a2 = amount * amount; let a6 = a2 * a2 * a2;
  let power = a6 * b.ch[3].y + (1.0 - a6) * b.ch[3].x;
  let rimF = clamp(exp(log(fres) * power) * b.ch[3].z - noise, 0.0, 1.0);
  let glow = rimF + body;
  let dark = fres * b.ch[4].y + (1.0 - fres) * b.ch[4].x;
  let alpha = max(dark, glow) * amount;
  let R = exp(log(fres) * b.ch[4].w) * b.ch[4].z;
  let col = glow * b.ch[1].rgb;
  // [R bb_charge_ps30] the target is the backbuffer format, so the rim color, far past 1, clamps before it's blended
  let a = saturate(R * (R - alpha) + alpha);
  return vec4f((1.0 - min(R, 1.0)) * col * amount + saturate(R * b.ch[5].rgb) * a, a);
}`;
// Effects: particles and swing trails, premultiplied so additive and blended share one pipeline.
const FX_WGSL = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var scene: texture_2d<f32>;
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
struct M { overbright: f32, soft: f32, refract: f32, additive: f32, texAlpha: f32, near: f32, far: f32, pad: f32 };
@group(1) @binding(2) var<uniform> m: M;
struct V { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) uv2: vec2f, @location(3) c: vec4f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) uv2: vec2f, @location(2) c: vec4f, @location(3) w: f32 };
@vertex fn vs(v: V) -> O { var o: O; o.p = cam.vp * vec4f(v.pos, 1); o.uv = v.uv; o.uv2 = v.uv2; o.c = v.c; o.w = o.p.w; return o; }
fn softFade(p: vec4f, w: f32) -> f32 {
  if (m.soft <= 0.0) { return 1.0; }
  let d = textureLoad(depth, vec2i(p.xy), 0);
  let z = m.near * m.far / (m.far - d * (m.far - m.near));
  return clamp((z - w) / m.soft, 0.0, 1.0);
}
@fragment fn fs(i: O) -> @location(0) vec4f {
  let t = textureSample(t0, samp, i.uv);
  let t2 = textureSample(t1, samp, i.uv2);
  let a = mix(1.0, t.a, m.texAlpha) * i.c.a * softFade(i.p, i.w) * mix(1.0, t2.a, m.texAlpha);
  // Source adds in linear light. The canvas here is gamma-encoded, and a linear value added directly is the
  // closer match at mid tones; encoding it first would inflate the soft tails of every glow.
  let tex = t.rgb * t2.rgb;
  let lit = select(pow(tex, vec3f(1.0 / 2.2)), tex, m.additive > 0.5);
  let rgb = lit * i.c.rgb * a * m.overbright;
  return vec4f(rgb, a * (1.0 - m.additive));
}
@fragment fn fsRefract(i: O) -> @location(0) vec4f {
  let t = textureSample(t0, samp, i.uv);
  let n = pow(t.rgb, vec3f(1.0 / 2.2)) * 2.0 - 1.0;
  let size = vec2f(textureDimensions(scene));
  // Source applies the offset in clip space, so distortion shrinks with distance
  let uv = i.p.xy / size + n.xy * m.refract * i.c.a / max(i.w, 1.0) * vec2f(0.5, -0.5);
  return vec4f(textureSampleLevel(scene, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb, 1.0);
}`;
const LINE_WGSL = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
struct V { @location(0) pos: vec3f, @location(1) c: vec4f };
struct O { @builtin(position) p: vec4f, @location(0) c: vec4f };
@vertex fn vs(v: V) -> O { var o: O; o.p = cam.vp * vec4f(v.pos, 1); o.c = v.c; return o; }
@fragment fn fs(i: O) -> @location(0) vec4f { return i.c; }`;
// [R sky_ps20b] the face's texture, scaled and tonemapped. Faces are picked as the engine lays them out.
const SKY_WGSL = /* wgsl */`
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
struct S { inv: mat4x4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> s: S;
@group(0) @binding(3) var rt: texture_2d<f32>;
@group(0) @binding(4) var lf: texture_2d<f32>;
@group(0) @binding(5) var bk: texture_2d<f32>;
@group(0) @binding(6) var ft: texture_2d<f32>;
@group(0) @binding(7) var up: texture_2d<f32>;
@group(0) @binding(8) var dn: texture_2d<f32>;
struct O { @builtin(position) p: vec4f, @location(0) c: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O { var o: O; let x = f32(i32(i & 1u) * 4 - 1); let y = f32(i32(i >> 1u) * 4 - 1); o.p = vec4f(x, y, 0.99999, 1); o.c = vec2f(x, y); return o; }
fn face(t: texture_2d<f32>, st: vec2f) -> vec3f { return textureSampleLevel(t, samp, vec2f(st.x + 1.0, 1.0 - st.y) * 0.5, 0).rgb; }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let w = s.inv * vec4f(i.c, 1, 1);
  let d = w.xyz / w.w - cam.eye.xyz;
  let a = abs(d);
  var c: vec3f;
  if (a.x >= a.y && a.x >= a.z) {
    c = select(face(lf, vec2f(d.y, d.z) / a.x), face(rt, vec2f(-d.y, d.z) / a.x), d.x > 0.0);
  } else if (a.y >= a.z) {
    c = select(face(ft, vec2f(-d.x, d.z) / a.y), face(bk, vec2f(d.x, d.z) / a.y), d.y > 0.0);
  } else {
    c = select(face(dn, vec2f(-d.y, d.x) / a.z), face(up, vec2f(-d.y, -d.x) / a.z), d.z > 0.0);
  }
  let x = clamp(c * cam.fog.w, vec3f(0), vec3f(1));
  return vec4f(select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308)), 1);
}`;
// Lightmaps as HDR with 4 bytes a texel, so the bumped atlas fits
function rgb9e5(r, g, b) {
  const m = Math.max(r, g, b);
  if (m <= 0) return 0;
  let e = Math.max(0, Math.floor(Math.log2(Math.min(m, 65408))) + 16);
  let s = 2 ** (e - 24);
  if (Math.round(Math.min(m, 65408) / s) >= 512) { e++; s *= 2; }
  const c = (v) => Math.min(511, Math.round(v / s));
  return (c(r) | (c(g) << 9) | (c(b) << 18) | (e << 27)) >>> 0;
}
const WORLD_STRIDE = 18;
const CSM_DIST = 400; // [R client.dll 18010ab9b] no controller asking otherwise
const LIGHT_DATA = 128 * 12 + 4 + 24; // where the light block starts in a character's uniform data
const on = (v) => v !== undefined && v !== '' && v !== '0';
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// The engine's surface basis: S from normal x T, T from S x normal, S flipped on mirrored texture mappings
function tangents(ti, n) {
  const sv = [ti.tv[0], ti.tv[1], ti.tv[2]], tv = [ti.tv[4], ti.tv[5], ti.tv[6]];
  const S = norm3(cross3(n, norm3(tv))), T = norm3(cross3(S, n));
  return [dot3(cross3(sv, tv), n) < 0 ? S.map((c) => -c) : S, T];
}
// "[r g b]" is 0..1, "{r g b}" is 0..255, and a bare number fills all three
// "center x y scale x y rotate r translate x y" as Source composes it: to the center, scale, rotate, then back and across.
function uvTransform(v) {
  const n = (k, def) => { const m = new RegExp(`${k}\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)`, 'i').exec(String(v ?? '')); return m ? [+m[1], +m[2]] : def; };
  const [cx, cy] = n('center', [0.5, 0.5]), [sx, sy] = n('scale', [1, 1]), [tx, ty] = n('translate', [0, 0]);
  const r = (parseFloat(/rotate\s+(-?[\d.]+)/i.exec(String(v ?? ''))?.[1]) || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
  return [sx * cs, -sy * sn, -cx * sx * cs + cy * sy * sn + cx + tx, 0, sx * sn, sy * cs, -cx * sx * sn - cy * sy * cs + cy + ty, 0];
}

function vmtColor(v, def) {
  if (v === undefined) return def;
  const n = String(v).match(/-?[\d.]+(?:e-?\d+)?/gi)?.map(Number);
  if (!n?.length) return def;
  const c = n.length >= 3 ? n.slice(0, 3) : [n[0], n[0], n[0]];
  return /\{/.test(v) ? c.map((x) => x / 255) : c;
}
const gammaToLinear = (x) => Math.pow(Math.max(0, x), 2.2);

/**
 * The WebGPU renderer: the world, props, characters, particles, and shadows.
 */
export class Renderer {
  constructor(canvas, device, format, fetchGame) {
    Object.assign(this, { canvas, device, format, fetchGame });
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    this.exposure = new Exposure();
    this.lastFrameT = 0;
    this.bc = device.features.has('texture-compression-bc');
    this.texCache = new Map();
    this.vmtCache = new Map();
    this.camBuf = device.createBuffer({ size: 336, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
    this.lmSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.fxSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.fallback = this._solid([127, 127, 127, 255]);
    this.white = this._solid([255, 255, 255, 255]);
    this.flatNormal = this._solid([128, 128, 255, 255], 'rgba8unorm');
    this.noExp = this._solid([0, 0, 0, 255], 'rgba8unorm');
    this.blackCube = this._solid([0, 0, 0, 255], 'rgba8unorm', 6);
    this.meshes = new Map();
    this.propBatches = [];
    this.worldDraws = [];
    this.waterDraws = [];
    this.lines = [];
    this._pipelines();
    this.resize();
  }

  _solid(c, format = 'rgba8unorm-srgb', layers = 1) {
    const t = this.device.createTexture({ size: [1, 1, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    for (let z = 0; z < layers; z++) this.device.queue.writeTexture({ texture: t, origin: [0, 0, z] }, new Uint8Array(c), { bytesPerRow: 4 }, [1, 1]);
    return t;
  }

  _pipelines() {
    const d = this.device;
    const depth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    const target = [{ format: this.format }];
    this.g0World = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.g0Obj = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } }] });
    this.gWorldMat = d.createBindGroupLayout({ entries: [
      ...[0, 1, 2, 3, 4, 5].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.gModelMat = d.createBindGroupLayout({ entries: [
      ...[0, 1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.gEnv = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } }] });
    this.bgBlackEnv = d.createBindGroup({ layout: this.gEnv, entries: [{ binding: 0, resource: this.blackCube.createView({ dimension: 'cube' }) }] });
    this.gBones = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const mod = (code) => d.createShaderModule({ code });
    const wm = mod(WORLD_WGSL);
    const both = (desc) => [d.createRenderPipeline(desc), d.createRenderPipeline({ ...desc, fragment: { ...desc.fragment, constants: { CUT: 0.5 } } })];
    [this.pWorld, this.pWorldCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0World, this.gWorldMat] }),
      vertex: { module: wm, entryPoint: 'vs', buffers: [{ arrayStride: WORLD_STRIDE * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }, { shaderLocation: 2, offset: 20, format: 'float32x2' }, { shaderLocation: 3, offset: 28, format: 'float32' },
        { shaderLocation: 4, offset: 32, format: 'float32' }, { shaderLocation: 5, offset: 36, format: 'float32x3' }, { shaderLocation: 6, offset: 48, format: 'float32x3' }, { shaderLocation: 7, offset: 60, format: 'float32x3' }] }] },
      fragment: { module: wm, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth,
    });
    this.g0Water = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.gWaterMat = d.createBindGroupLayout({ entries: [
      ...[0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    // The customization screen's backdrop [I]: matched to the reference, the .res only says the panel clears translucent
    const bd = mod(`
struct O { @builtin(position) p: vec4f, @location(0) c: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O { var o: O; let x = f32(i32(i & 1u) * 4 - 1); let y = f32(i32(i >> 1u) * 4 - 1); o.p = vec4f(x, y, 0.999, 1); o.c = vec2f(x, y); return o; }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let d = length((i.c - vec2f(-0.35, 0.05)) * vec2f(0.8, 1.05));
  return vec4f(vec3f(mix(0.9, 0.3, smoothstep(0.0, 1.35, d))), 1);
}`);
    this.pBackdrop = d.createRenderPipeline({ layout: 'auto', vertex: { module: bd, entryPoint: 'vs' }, fragment: { module: bd, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' } });
    const blit = mod(`
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> O { var o: O; let x = f32(i32(i & 1u) * 4 - 1); let y = f32(i32(i >> 1u) * 4 - 1); o.p = vec4f(x, y, 0, 1); o.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5); return o; }
@fragment fn fs(i: O) -> @location(0) vec4f { return vec4f(textureSampleLevel(tex, samp, i.uv, 0.0).rgb, 1); }`);
    this.pBlit = d.createRenderPipeline({ layout: 'auto', vertex: { module: blit, entryPoint: 'vs' }, fragment: { module: blit, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list' } });
    this.blitSamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const wtr = mod(WATER_WGSL);
    this.pWater = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Water, this.gWaterMat] }),
      vertex: { module: wtr, entryPoint: 'vs', buffers: [{ arrayStride: WORLD_STRIDE * 4, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }, { shaderLocation: 2, offset: 20, format: 'float32x2' }] }] },
      fragment: { module: wtr, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.waterBuf = d.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pm = mod(PROP_WGSL);
    [this.pProp, this.pPropCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gModelMat, this.gEnv] }),
      vertex: { module: pm, entryPoint: 'vs', buffers: [
        { arrayStride: 64, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 8, offset: 48, format: 'float32x4' }] },
        { arrayStride: 48, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }, { shaderLocation: 4, offset: 16, format: 'float32x4' }, { shaderLocation: 5, offset: 32, format: 'float32x4' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 9, offset: 0, format: 'unorm8x4' }, { shaderLocation: 10, offset: 4, format: 'unorm8x4' }, { shaderLocation: 11, offset: 8, format: 'unorm8x4' }] }] },
      fragment: { module: pm, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth,
    });
    const sm = mod(SKIN_WGSL);
    [this.pSkin, this.pSkinCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gModelMat, this.gBones, this.gEnv] }),
      vertex: { module: sm, entryPoint: 'vs', buffers: [{ arrayStride: 64, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' }, { shaderLocation: 4, offset: 44, format: 'uint8x4' }, { shaderLocation: 8, offset: 48, format: 'float32x4' }] }] },
      fragment: { module: sm, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth,
    });
    const lm = mod(LINE_WGSL);
    this.pTri = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] })] }),
      vertex: { module: lm, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }] },
      fragment: { module: lm, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'zero' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.triBG = d.createBindGroup({ layout: this.pTri.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    this.triBuf = d.createBuffer({ size: 28 * 3 * 2 * 256, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const sk = mod(SKY_WGSL);
    this.pSky = d.createRenderPipeline({ layout: 'auto', vertex: { module: sk, entryPoint: 'vs' }, fragment: { module: sk, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' } });
    this.csmTex = d.createTexture({ size: [3072, 1024], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.csmSamp = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.bg0Obj = d.createBindGroup({ layout: this.g0Obj, entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.samp }, { binding: 2, resource: this.csmTex.createView() }, { binding: 3, resource: this.csmSamp }] });
    this._csmPipelines();
    // charge overlay: same vertices as the skinned pass, blended over it
    this.gCharge = d.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })) });
    const cm = mod(CHARGE_WGSL);
    this.pCharge = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gCharge, this.gBones] }),
      vertex: { module: cm, entryPoint: 'vs', buffers: [{ arrayStride: 64, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' }, { shaderLocation: 4, offset: 44, format: 'uint8x4' }] }] },
      fragment: { module: cm, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    // effects
    this.gFx0 = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.gFx1 = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    const fm = mod(FX_WGSL);
    const fxBase = {
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.gFx0, this.gFx1] }),
      vertex: { module: fm, entryPoint: 'vs', buffers: [{ arrayStride: 44, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }, { shaderLocation: 2, offset: 20, format: 'float32x2' }, { shaderLocation: 3, offset: 28, format: 'float32x4' }] }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    };
    this.pFx = d.createRenderPipeline({ ...fxBase, fragment: { module: fm, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] } });
    this.pFxRefract = d.createRenderPipeline({ ...fxBase, fragment: { module: fm, entryPoint: 'fsRefract', targets: [{ format: this.format }] } });
    this.fxVB = d.createBuffer({ size: 240000 * 44, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // the exposure histogram's view of the frame: its center region, small, read back now and then
    const hm = mod(/* wgsl */`
      @group(0) @binding(0) var t: texture_2d<f32>;
      @group(0) @binding(1) var s: sampler;
      struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f };
      @vertex fn vs(@builtin(vertex_index) i: u32) -> O { var o: O; let x = f32(i32(i & 1u) * 4 - 1); let y = f32(i32(i >> 1u) * 4 - 1); o.p = vec4f(x, y, 0, 1); o.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5); return o; }
      // [R client.dll] mat_exposure_center_region_x, _y
      @fragment fn fs(i: O) -> @location(0) vec4f { return textureSampleLevel(t, s, (i.uv - 0.5) * vec2f(0.9, 0.85) + 0.5, 0); }`);
    this.pHist = d.createRenderPipeline({ layout: 'auto', vertex: { module: hm, entryPoint: 'vs' }, fragment: { module: hm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
    this.histTex = d.createTexture({ size: [64, 36], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.histBuf = d.createBuffer({ size: 256 * 36, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.histSamp = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.histBusy = false;
    this.histFrame = 0;
  }

  // Depth-only draws for the shadow atlas; a material with cutouts samples its base texture
  _csmPipelines() {
    const d = this.device;
    this.gDepth = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    const head = /* wgsl */`
      @group(0) @binding(0) var<uniform> vp: mat4x4f;
      @group(0) @binding(1) var samp: sampler;
      @group(1) @binding(0) var t0: texture_2d<f32>;
      @fragment fn cut(@location(0) uv: vec2f) -> @location(0) vec4f { if (textureSample(t0, samp, uv).a < 0.5) { discard; } return vec4f(0); }
      struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f };`;
    const pipes = (code, layouts, buffers) => {
      const module = d.createShaderModule({ code: head + code });
      const base = { layout: d.createPipelineLayout({ bindGroupLayouts: layouts }), vertex: { module, entryPoint: 'vs', buffers }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBiasSlopeScale: 2 } };
      return [d.createRenderPipeline(base), d.createRenderPipeline({ ...base, fragment: { module, entryPoint: 'cut', targets: [] } })];
    };
    [this.pDepthWorld, this.pDepthWorldCut] = pipes(`
      @vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> O { var o: O; o.p = vp * vec4f(pos, 1); o.uv = uv; return o; }`,
    [this.gDepth, this.gWorldMat], [{ arrayStride: WORLD_STRIDE * 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }] }]);
    [this.pDepthProp, this.pDepthPropCut] = pipes(`
      @vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @location(3) m0: vec4f, @location(4) m1: vec4f, @location(5) m2: vec4f) -> O {
        var o: O; let w = vec3f(dot(m0, vec4f(pos, 1)), dot(m1, vec4f(pos, 1)), dot(m2, vec4f(pos, 1))); o.p = vp * vec4f(w, 1); o.uv = uv; return o; }`,
    [this.gDepth, this.gModelMat], [{ arrayStride: 64, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 24, format: 'float32x2' }] },
      { arrayStride: 48, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }, { shaderLocation: 4, offset: 16, format: 'float32x4' }, { shaderLocation: 5, offset: 32, format: 'float32x4' }] }]);
    [this.pDepthSkin, this.pDepthSkinCut] = pipes(`
      struct B { m: array<mat3x4f, 128> };
      @group(2) @binding(0) var<uniform> b: B;
      @vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @location(3) w: vec3f, @location(4) idx: vec4u) -> O {
        var o: O; let p4 = vec4f(pos, 1); let wp = (p4 * b.m[idx.x]) * w.x + (p4 * b.m[idx.y]) * w.y + (p4 * b.m[idx.z]) * w.z; o.p = vp * vec4f(wp, 1); o.uv = uv; return o; }`,
    [this.gDepth, this.gModelMat, this.gBones], [{ arrayStride: 64, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' }, { shaderLocation: 4, offset: 44, format: 'uint8x4' }] }]);
    this.csmSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.csmCascades = [0, 1, 2].map(() => {
      const buf = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { buf, bg: d.createBindGroup({ layout: this.gDepth, entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: this.csmSampler }] }) };
    });
  }

  // [R client.dll 180176dc0] Log-spaced splits out to the shadow distance. Each cascade is a sphere around its slice of the view,
  // snapped to whole texels so edges hold still while the camera moves. Clip space, with z along the sun.
  _updateCascades(view) {
    const sun = this.lighting?.sky;
    if (!sun) return false;
    const fwd = norm3(sun.n);
    const right = norm3(cross3(fwd, Math.abs(fwd[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1])), up = cross3(right, fwd);
    const near = 4, far = CSM_DIST, aspect = this.canvas.width / this.canvas.height;
    const k = Math.tan(view.fovY / 2), k2 = k * k * (1 + aspect * aspect);
    let lo = near;
    this.csmSpheres = [];
    for (let i = 0; i < 3; i++) {
      const hi = near * Math.pow(far / near, (i + 1) / 3) + 0.1;
      const mid = (lo + hi) / 2 * (1 + k2), z = Math.min(hi, mid);
      const c = [view.eye[0] + view.fwd[0] * z, view.eye[1] + view.fwd[1] * z, view.eye[2] + view.fwd[2] * z];
      const r = Math.ceil(Math.sqrt((hi - z) ** 2 + hi * hi * k2));
      const texel = 2 * r / 1024;
      const cx = Math.round(dot3(c, right) / texel) * texel, cy = Math.round(dot3(c, up) / texel) * texel, cz = dot3(c, fwd);
      const back = 4000, range = 5000;
      // column major: x' = (right.p - cx) / r, y' = (up.p - cy) / r, z' = (fwd.p - cz + back) / range
      const m = new Float32Array([
        right[0] / r, up[0] / r, fwd[0] / range, 0,
        right[1] / r, up[1] / r, fwd[1] / range, 0,
        right[2] / r, up[2] / r, fwd[2] / range, 0,
        -cx / r, -cy / r, (back - cz) / range, 1]);
      this.csmSpheres.push({ right, up, cx, cy, r, m });
      this.device.queue.writeBuffer(this.csmCascades[i].buf, 0, m);
      lo = hi;
    }
    return true;
  }

  _drawCascades(enc, view) {
    const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.csmTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    this.csmSpheres.forEach((s, i) => {
      pass.setViewport(i * 1024, 0, 1024, 1024, 0, 1);
      pass.setScissorRect(i * 1024, 0, 1024, 1024);
      pass.setBindGroup(0, this.csmCascades[i].bg);
      const visible = (c, rad) => Math.abs(dot3(c, s.right) - s.cx) < s.r + rad && Math.abs(dot3(c, s.up) - s.cy) < s.r + rad;
      if (this.worldVB) {
        pass.setVertexBuffer(0, this.worldVB);
        let piped = null;
        for (const dr of this.worldDraws) {
          if (dr.noShadow || !visible(dr.center, dr.radius)) continue;
          const p = dr.cut ? this.pDepthWorldCut : this.pDepthWorld;
          if (p !== piped) { pass.setPipeline(p); piped = p; }
          pass.setBindGroup(1, dr.bg);
          pass.draw(dr.count, 1, dr.first, 0);
        }
      }
      for (const b of this.propBatches) {
        pass.setVertexBuffer(0, b.mesh.vb);
        pass.setVertexBuffer(1, b.inst);
        pass.setIndexBuffer(b.mesh.ib, 'uint32');
        for (const sub of b.mesh.subs) {
          if (sub.noShadow) continue;
          pass.setPipeline(sub.cut ? this.pDepthPropCut : this.pDepthProp);
          pass.setBindGroup(1, sub.bg);
          for (let k = 0; k < b.draws.length; k++) if (visible(b.draws[k].origin, b.mesh.radius)) pass.drawIndexed(sub.count, 1, sub.start, 0, k);
        }
      }
      for (const c of view.characters) {
        pass.setBindGroup(2, c.bones.bg);
        pass.setVertexBuffer(0, c.mesh.vb);
        pass.setIndexBuffer(c.mesh.ib, 'uint32');
        for (const sub of c.mesh.subs) {
          if (sub.noShadow) continue;
          pass.setPipeline(sub.cut ? this.pDepthSkinCut : this.pDepthSkin);
          pass.setBindGroup(1, sub.bg);
          pass.drawIndexed(sub.count, 1, sub.start, 0, 0);
        }
      }
    });
    pass.end();
  }

  // Particle and trail materials, read from the game's .vmt
  async fxMaterial(key) {
    const d = this.device;
    const vm = await this._vmt(key, null);
    const p = vm?.p || {};
    const num = (k, def) => { const v = parseFloat(p[k]); return Number.isNaN(v) ? def : v; };
    const refract = vm?.shader === 'refract';
    const baseName = refract ? p.$normalmap : p.$basetexture;
    const b0 = baseName ? await this._tex(baseName, null) : null;
    const b1 = p.$texture2 ? await this._tex(p.$texture2, null) : null;
    const additive = num('$additive', 0) !== 0;
    const translucent = additive || num('$translucent', 0) !== 0 || num('$vertexalpha', 0) !== 0;
    const soft = num('$depthblend', 0) !== 0 ? num('$depthblendscale', 50) : 0;
    const u = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tex = b0 || this.white;
    d.queue.writeBuffer(u, 0, new Float32Array([num('$overbrightfactor', 1), soft, num('$refractamount', 0), additive ? 1 : 0, 1, this.near ?? 4, this.far ?? 16000, 0]));
    const col = String(p.$color ?? '').match(/-?[\d.]+/g)?.map(Number);
    return {
      key, refract, sheet: tex.sheet, additive, needsSort: !additive && !refract && translucent, minSize: num('$minsize', 0), color: col?.length === 3 ? col : [1, 1, 1],
      bg: d.createBindGroup({ layout: this.gFx1, entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: (b1 || this.white).createView() }, { binding: 2, resource: { buffer: u } }] }),
    };
  }

  resize() {
    const w = Math.max(1, Math.round(this.canvas.clientWidth * Math.min(devicePixelRatio, 2))), h = Math.max(1, Math.round(this.canvas.clientHeight * Math.min(devicePixelRatio, 2)));
    if (this.canvas.width === w && this.canvas.height === h && this.depth) return;
    this.canvas.width = w; this.canvas.height = h;
    this.depth?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.sceneCopy?.destroy();
    this.sceneCopy = this.device.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.bgFx0 = null;
    this.bg0Water = null;
    this.bgPreview = null;
  }

  // ---------------------------------------------------------------- materials
  async _vmt(name, pak) {
    const key = name.toLowerCase().replace(/\\/g, '/').replace(/\.vmt$/, '');
    if (this.vmtCache.has(key)) return this.vmtCache.get(key);
    const pr = (async () => {
      const buf = await this.fetchGame('materials/' + key + '.vmt', pak);
      if (!buf) return null;
      const nodes = parseKV(new TextDecoder('latin1').decode(buf));
      if (!nodes.length) return null;
      const shader = nodes[0].key.toLowerCase();
      const body = Array.isArray(nodes[0].value) ? nodes[0].value : [];
      if (shader === 'patch') {
        const inc = kvGet(body, 'include');
        const base = inc ? await this._vmt(inc.replace(/^materials[\\/]/i, ''), pak) : null;
        const ins = kvGet(body, 'insert') || []; const rep = kvGet(body, 'replace') || [];
        const r = { ...(base || { shader: 'patch', p: {} }) };
        r.p = { ...r.p };
        for (const x of [...(Array.isArray(ins) ? ins : []), ...(Array.isArray(rep) ? rep : [])]) if (!Array.isArray(x.value)) r.p[x.key.toLowerCase()] = x.value;
        return r;
      }
      const p = {};
      for (const x of body) if (!Array.isArray(x.value)) p[x.key.toLowerCase()] = x.value;
      const proxies = body.find((x) => x.key.toLowerCase() === 'proxies')?.value;
      const scroll = Array.isArray(proxies) ? proxies.find((x) => x.key.toLowerCase() === 'texturescroll')?.value : null;
      if (Array.isArray(scroll)) p.textureScroll = Object.fromEntries(scroll.map((x) => [x.key.toLowerCase(), x.value]));
      return { shader, p };
    })();
    this.vmtCache.set(key, pr);
    return pr;
  }

  static cutout(vm) {
    const on = (k) => vm?.p?.[k] !== undefined && vm.p[k] !== '0';
    return on('$alphatest') || on('$translucent') || on('$decal');
  }

  // linear: normal maps and masks hold data, so they skip the sRGB decode
  async _tex(name, pak, linear = false) {
    const key = name.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
    const cacheKey = linear ? key + '#linear' : key;
    if (this.texCache.has(cacheKey)) return this.texCache.get(cacheKey);
    const pr = (async () => {
      const buf = await this.fetchGame('materials/' + key + '.vtf', pak);
      if (!buf) return null;
      try { return this._upload(parseVTF(buf), linear); } catch (e) { console.warn('vtf', key, e.message); return null; }
    })();
    this.texCache.set(cacheKey, pr);
    return pr;
  }

  // Cubemaps: built maps ship an HDR copy next to the LDR one
  async _cube(name, pak) {
    const key = 'cube:' + name.toLowerCase().replace(/\\/g, '/');
    if (this.texCache.has(key)) return this.texCache.get(key);
    const pr = (async () => {
      const base = name.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
      const buf = await this.fetchGame(`materials/${base}.hdr.vtf`, pak) ?? await this.fetchGame(`materials/${base}.vtf`, pak);
      if (!buf) return null;
      try { return this._upload(parseVTF(buf), false); } catch (e) { console.warn('cube', base, e.message); return null; }
    })();
    this.texCache.set(key, pr);
    return pr;
  }

  // [R sky_ps20b] six separately sized faces
  async _loadSky(bsp, pak) {
    const d = this.device;
    const sky = bsp.entities.find((e) => e.classname === 'worldspawn')?.skyname;
    this.bgSky = null;
    if (!sky) return;
    const faces = await Promise.all(['rt', 'lf', 'bk', 'ft', 'up', 'dn'].map(async (sfx) => {
      const name = `skybox/${sky}${sfx}`;
      const vm = await this._vmt(name, pak);
      return (await this._tex(vm?.p?.$hdrbasetexture ?? vm?.p?.$basetexture ?? name, pak)) ?? this.fallback;
    }));
    const inv = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.skyInv = inv;
    this.bgSky = d.createBindGroup({ layout: this.pSky.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: samp }, { binding: 2, resource: { buffer: inv } },
      ...faces.map((t, i) => ({ binding: 3 + i, resource: t.createView() }))] });
  }

  _upload(t, linear = false) {
    if (window.duelDebug?.noTex) return linear ? this.flatNormal : this.white;
    const d = this.device;
    const faces = t.flags & 0x4000 ? 6 : 1, cube = faces === 6;
    if (t.fmt === 24) {
      const tex = d.createTexture({ size: [t.w, t.h, faces], mipLevelCount: t.levels.length, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      t.levels.forEach((l, i) => {
        for (let z = 0; z < faces; z++) d.queue.writeTexture({ texture: tex, mipLevel: i, origin: [0, 0, z] }, t.buf.subarray(l.off + z * l.size, l.off + (z + 1) * l.size), { bytesPerRow: l.w * 8 }, [l.w, l.h]);
      });
      return tex;
    }
    const bcName = this.bc ? isBCFormat(t.fmt) : null;
    const bc = bcName && linear ? bcName.replace('-srgb', '') : bcName;
    // BC textures need width/height multiples of 4 at the base
    const useBC = bc && t.w % 4 === 0 && t.h % 4 === 0;
    const levels = useBC ? t.levels.filter((l) => l.w >= 4 && l.h >= 4) : t.levels;
    const tex = d.createTexture({ size: [t.w, t.h, faces], mipLevelCount: levels.length, format: useBC ? bc : linear ? 'rgba8unorm' : 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    levels.forEach((l, i) => {
      for (let z = 0; z < faces; z++) {
        if (useBC) {
          const blk = t.fmt === 15 || t.fmt === 14 ? 16 : 8;
          const bytes = t.buf.subarray(l.off + z * l.size, l.off + (z + 1) * l.size);
          d.queue.writeTexture({ texture: tex, mipLevel: i, origin: [0, 0, z] }, bytes, { bytesPerRow: Math.ceil(l.w / 4) * blk }, [Math.ceil(l.w / 4) * 4, Math.ceil(l.h / 4) * 4]);
        } else {
          d.queue.writeTexture({ texture: tex, mipLevel: i, origin: [0, 0, z] }, decodeLevel(t, { ...l, off: l.off + z * l.size }), { bytesPerRow: l.w * 4 }, [l.w, l.h]);
        }
      }
    });
    tex.sheet = t.sheet;
    return tex;
  }

  // ---------------------------------------------------------------- world
  /**
   * @param {BSP} bsp The map.
   * @param {function} [onProgress] Told how loading is going.
   */
  async loadWorld(bsp, onProgress = () => {}) {
    const d = this.device;
    this.bsp = bsp;
    const pak = bsp;
    const skip = SURF_NODRAW | SURF_SKY | SURF_SKY2D | SURF_TRIGGER | SURF_SKIP | SURF_HINT;
    const useFace = new Uint8Array(bsp.faces.length);
    // Brush entity geometry is stored around (0,0,0) and placed by the entity's origin.
    const faceOffset = new Map();
    const modelFaces = (m, origin) => { for (let i = 0; i < m.numfaces; i++) { useFace[m.firstface + i] = 1; if (origin) faceOffset.set(m.firstface + i, origin); } };
    modelFaces(bsp.models[0]);
    for (const e of bsp.entities) {
      if (e.model?.[0] === '*' && /func_(brush|wall|detail|illusionary|breakable)/.test(e.classname)) { const m = bsp.models[+e.model.slice(1)]; if (m) modelFaces(m, e.origin?.split(' ').map(Number)); }
    }
    const drawn = (f, idx) => {
      if (!useFace[idx] || f.texinfo < 0) return false;
      const ti = bsp.texinfo[f.texinfo];
      return !(ti.flags & skip) && !/^tools\//i.test(bsp.texdata[ti.texdata].name);
    };
    // lightmap atlas (shelf packer). A bumped face stores flat, then the three basis directions, side by side.
    const strips = (f) => (bsp.texinfo[f.texinfo].flags & SURF_BUMPLIGHT ? 4 : 1);
    let need = 0;
    bsp.faces.forEach((f, idx) => { if (drawn(f, idx) && f.lightofs >= 0) need += (f.lmSize[0] + 2) * strips(f) * (f.lmSize[1] + 2); });
    let size = 1024;
    while (size < 8192 && size * size < need * 1.4) size *= 2;
    let cx = 0, cy = 0, rowH = 0;
    const place = (w, h) => {
      if (cx + w + 1 > size) { cy += rowH + 1; cx = 0; rowH = 0; }
      if (cy + h + 1 > size) return null;
      const r = [cx, cy]; cx += w + 1; rowH = Math.max(rowH, h); return r;
    };
    const atlas = new Uint32Array(size * size);
    const sunAtlas = new Uint8Array(size * size);
    const bdv = bsp.dv, lightOff = bsp.light.off, lightLen = bsp.light.len;
    const placeFace = (f) => {
      if (f.lightofs < 0 || !lightLen) return null;
      const w = f.lmSize[0] + 1, h = f.lmSize[1] + 1, n = strips(f);
      const at = place((w + 1) * n - 1, h);
      if (!at) return null;
      for (let s = 0; s < n; s++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = lightOff + f.lightofs + (s * w * h + y * w + x) * 4;
            const e = 2 ** bdv.getInt8(o + 3) / 255;
            const texel = (at[1] + y) * size + at[0] + s * (w + 1) + x;
            atlas[texel] = rgb9e5(bdv.getUint8(o) * e, bdv.getUint8(o + 1) * e, bdv.getUint8(o + 2) * e);
            // one more layer follows the pages: a byte per page, the sun's share of it in units of the sky light's color
            const sun = lightOff + f.lightofs + (n * w * h + y * w + x) * 4 + s;
            if (sun < lightOff + lightLen) sunAtlas[texel] = bdv.getUint8(sun);
          }
        }
      }
      return at;
    };
    // collect geometry per material
    const perTex = new Map();
    const push = (name) => { let g = perTex.get(name); if (!g) perTex.set(name, (g = [])); return g; };
    const transNames = new Set();
    bsp.faces.forEach((f, idx) => {
      if (!drawn(f, idx)) return;
      const ti = bsp.texinfo[f.texinfo];
      const td = bsp.texdata[ti.texdata];
      const at = placeFace(f);
      const lu = (p) => (at ? ((p[0] * ti.lv[0] + p[1] * ti.lv[1] + p[2] * ti.lv[2] + ti.lv[3] - f.lmMins[0] + 0.5) + at[0]) / size : 0.5 / size);
      const lv = (p) => (at ? ((p[0] * ti.lv[4] + p[1] * ti.lv[5] + p[2] * ti.lv[6] + ti.lv[7] - f.lmMins[1] + 0.5) + at[1]) / size : 0.5 / size);
      const lstep = at && strips(f) > 1 ? (f.lmSize[0] + 2) / size : 0;
      const su = (p) => (p[0] * ti.tv[0] + p[1] * ti.tv[1] + p[2] * ti.tv[2] + ti.tv[3]) / (td.w || 1);
      const sv = (p) => (p[0] * ti.tv[4] + p[1] * ti.tv[5] + p[2] * ti.tv[6] + ti.tv[7]) / (td.h || 1);
      if (ti.flags & SURF_TRANS) transNames.add(td.name);
      const out = push(td.name);
      const sign = f.side ? -1 : 1;
      const faceN = [bsp.planeN[f.plane * 3] * sign, bsp.planeN[f.plane * 3 + 1] * sign, bsp.planeN[f.plane * 3 + 2] * sign];
      if (f.disp >= 0) {
        const di = bsp.dispinfo[f.disp];
        const g = bsp.dispGrid(di);
        if (!g) return;
        const { size: n, pos, base, alpha } = g;
        const at3 = (x, y) => { const i = (Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))) * 3; return [pos[i], pos[i + 1], pos[i + 2]]; };
        const vert = (i) => {
          const b = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
          const x = i % n, y = (i - x) / n;
          const dx = sub3(at3(x + 1, y), at3(x - 1, y)), dy = sub3(at3(x, y + 1), at3(x, y - 1));
          let vn = norm3(cross3(dx, dy));
          if (dot3(vn, faceN) < 0) vn = vn.map((c) => -c);
          const [S, T] = tangents(ti, vn);
          out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], su(b), sv(b), lu(b), lv(b), alpha[i] / 255, lstep, ...vn, ...S, ...T);
        };
        for (let y = 0; y < n - 1; y++) {
          for (let x = 0; x < n - 1; x++) {
            const a = y * n + x, b = a + 1, c = a + n, e = c + 1;
            if ((x + y) % 2 === 0) { vert(a); vert(e); vert(c); vert(a); vert(b); vert(e); } else { vert(a); vert(b); vert(c); vert(b); vert(e); vert(c); }
          }
        }
      } else {
        const vs = bsp.faceVerts(f), off = faceOffset.get(idx) || [0, 0, 0];
        const [S, T] = tangents(ti, faceN);
        for (let i = 1; i < vs.length - 1; i++) {
          for (const p of [vs[0], vs[i], vs[i + 1]]) out.push(p[0] + off[0], p[1] + off[1], p[2] + off[2], su(p), sv(p), lu(p), lv(p), 0, lstep, ...faceN, ...S, ...T);
        }
      }
    });
    const lmTex = d.createTexture({ size: [size, size], format: 'rgb9e5ufloat', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: lmTex }, atlas, { bytesPerRow: size * 4 }, [size, size]);
    const lmSunTex = d.createTexture({ size: [size, size], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: lmSunTex }, sunAtlas, { bytesPerRow: size }, [size, size]);
    this.lmView = lmTex.createView();
    this.bg0World = d.createBindGroup({ layout: this.g0World, entries: [
      { binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.samp }, { binding: 2, resource: lmTex.createView() }, { binding: 3, resource: this.lmSamp }, { binding: 4, resource: this.csmTex.createView() }, { binding: 5, resource: this.csmSamp }, { binding: 6, resource: lmSunTex.createView() }] });
    // merged vertex buffer
    const names = [...perTex.keys()];
    let total = 0;
    for (const n of names) total += perTex.get(n).length;
    const all = new Float32Array(total);
    const draws = [];
    let at = 0;
    for (const n of names) {
      const arr = perTex.get(n);
      all.set(arr, at);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += WORLD_STRIDE) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); }
      const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
      draws.push({ name: n, first: at / WORLD_STRIDE, count: arr.length / WORLD_STRIDE, center, radius: Math.hypot(mx[0] - center[0], mx[1] - center[1], mx[2] - center[2]) });
      at += arr.length;
    }
    this.worldVB = d.createBuffer({ size: all.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.worldVB, 0, all);
    this.worldVerts = at / WORLD_STRIDE;
    const defaultCube = [...bsp.pakIndex().keys()].find((k) => /\/cubemapdefault\.vtf$/.test(k))?.replace(/^materials\//, '').replace(/\.vtf$/, '');
    let done = 0;
    await Promise.all(draws.map(async (dr) => {
      const m = await this._vmt(dr.name, pak);
      const p = m?.p ?? {};
      const b0 = p.$basetexture ? await this._tex(p.$basetexture, pak) : await this._tex(dr.name, pak);
      const b1 = p.$basetexture2 ? await this._tex(p.$basetexture2, pak) : null;
      const bumpName = p.$bumpmap ?? p.$normalmap;
      const n0 = bumpName ? await this._tex(bumpName, pak, true) : null;
      const n1 = p.$bumpmap2 ? await this._tex(p.$bumpmap2, pak, true) : null;
      const maskT = p.$envmapmask ? await this._tex(p.$envmapmask, pak, true) : null;
      const detailT = on(p.$detail) ? await this._tex(p.$detail, pak) : null;
      // An unpatched env_cubemap means the engine's choice at draw time; the map's default stands in. [I]
      const envName = on(p.$envmap) ? (/^env_cubemap$/i.test(p.$envmap) ? defaultCube : p.$envmap) : null;
      const envT = envName ? await this._cube(envName, pak) : null;
      if (/^water/.test(m?.shader ?? '')) {
        // The underside only draws from below the surface, where a duel never puts the camera
        dr.water = true;
        dr.ok = !!n0;
        dr.hidden = p.$abovewater === '0';
        const flowT = on(p.$flowmap) ? await this._tex(p.$flowmap, pak, true) : null, noiseT = on(p.$flow_noise_texture) ? await this._tex(p.$flow_noise_texture, pak, true) : null;
        const num = (k, def) => { const v = parseFloat(p[k]); return Number.isNaN(v) ? def : v; };
        const color = (k, def) => vmtColor(p[k], def).map(gammaToLinear);
        const u = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(u, 0, new Float32Array([
          1 / num('$flow_worlduvscale', 1), 1 / num('$flow_normaluvscale', 1), num('$flow_bumpstrength', 1), flowT ? 1 : 0,
          num('$flow_timeintervalinseconds', 0.4), num('$flow_uvscrolldistance', 0.2), num('$flow_noise_scale', 0.0002), num('$flow_timescale', 1),
          ...color('$reflecttint', [1, 1, 1]), num('$refractamount', 0),
          ...color('$fogcolor', [0, 0, 0]), on(p.$fogenable) ? 1 : 0,
          num('$fogstart', 0), num('$fogend', 1), on(p.$lightmapwaterfog) ? 1 : 0, 0]));
        dr.bg = d.createBindGroup({ layout: this.gWaterMat, entries: [n0 || this.flatNormal, flowT || this.flatNormal, noiseT || this.white].map((t, binding) => ({ binding, resource: t.createView() })).concat(
          { binding: 3, resource: (envT || (defaultCube && await this._cube(defaultCube, pak)) || this.blackCube).createView({ dimension: 'cube' }) }, { binding: 4, resource: { buffer: u } }) });
        onProgress(`textures ${++done}/${draws.length}`);
        return;
      }
      if (/^refract/.test(m?.shader ?? '') && n0) {
        dr.water = true;
        dr.ok = true;
        const tintT = on(p.$refracttinttexture) ? await this._tex(p.$refracttinttexture, pak) : null;
        const sc = p.textureScroll, rate = parseFloat(sc?.texturescrollrate ?? 0), ang = parseFloat(sc?.texturescrollangle ?? 0) * Math.PI / 180;
        const u = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const fv = (k, def) => { const v = parseFloat(p[k]); return Number.isNaN(v) ? def : v; };
        d.queue.writeBuffer(u, 0, new Float32Array([0, 0, 0, 0, Math.cos(ang) * rate, Math.sin(ang) * rate, 0, 0, ...vmtColor(p.$refracttint, [1, 1, 1]), fv('$refractamount', 0.5), 0, 0, 0, 0, 0, 0, 0, 1]));
        dr.bg = d.createBindGroup({ layout: this.gWaterMat, entries: [n0, this.flatNormal, tintT || this.white].map((t, binding) => ({ binding, resource: t.createView() })).concat(
          { binding: 3, resource: this.blackCube.createView({ dimension: 'cube' }) }, { binding: 4, resource: { buffer: u } }) });
        onProgress(`textures ${++done}/${draws.length}`);
        return;
      }
      dr.ok = !!b0;
      dr.cut = Renderer.cutout(m) || transNames.has(dr.name);
      dr.noShadow = /^(water|refract|lightmappedreflective|unlit)/.test(m?.shader ?? '') || on(p.$translucent) || on(p.$additive) || on(p.$nodraw);
      const t0 = b0 || this.fallback;
      const u = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const f = (k, def) => { const v = parseFloat(p[k]); return Number.isNaN(v) ? def : v; };
      const tint = vmtColor(p.$color, [1, 1, 1]).map(gammaToLinear), envTint = vmtColor(p.$envmaptint, [1, 1, 1]).map(gammaToLinear);
      const bumpMode = n0 ? (on(p.$ssbump) ? 2 : 1) : 0;
      const maskMode = on(p.$normalmapalphaenvmapmask) && n0 ? 1 : on(p.$basealphaenvmapmask) ? 2 : maskT ? 3 : 0;
      d.queue.writeBuffer(u, 0, new Float32Array([
        ...tint, 1, ...envTint, f('$envmapcontrast', 0),
        bumpMode, envT ? 1 : 0, maskMode, on(p.$selfillum) ? 1 : 0,
        f('$envmapsaturation', 1), /^unlit/.test(m?.shader ?? '') ? 1 : 0, detailT ? 1 : 0, f('$detailscale', 4),
        f('$seamless_scale', 0), f('$detailblendfactor', 1), 0, 0]));
      const flatN = n0 || this.flatNormal;
      dr.bg = d.createBindGroup({ layout: this.gWorldMat, entries: [t0, b1 || t0, flatN, n1 || flatN, maskT || this.white, detailT || this.white].map((t, binding) => ({ binding, resource: t.createView() })).concat(
        { binding: 6, resource: (envT || this.blackCube).createView({ dimension: 'cube' }) }, { binding: 7, resource: { buffer: u } }) });
      onProgress(`textures ${++done}/${draws.length}`);
    }));
    await this._loadSky(bsp, pak);
    await this._loadLighting(bsp, pak);
    const ents = new TextDecoder('latin1').decode(bsp.bytes.subarray(bsp.lump(0).off, bsp.lump(0).off + bsp.lump(0).len));
    this.exposure.configure(tonemapSettings(ents, bsp.entities.filter((e) => e.classname === 'env_tonemap_controller').map((e) => e.targetname)));
    this.worldDraws = draws.filter((x) => !x.water);
    this.waterDraws = draws.filter((x) => x.water && !x.hidden);
    this.stats = { textures: draws.length, missing: draws.filter((x) => !x.ok).map((x) => x.name), verts: this.worldVerts, lmSize: size, lmHeight: cy + rowH };
    // sun from light_environment
    const env = bsp.entities.find((e) => e.classname === 'light_environment');
    const pitch = parseFloat(env?.pitch ?? '-45') * Math.PI / 180, yaw = parseFloat((env?.angles || '0 0 0').split(' ')[1]) * Math.PI / 180;
    const cp = Math.cos(pitch);
    this.sun = [-Math.cos(yaw) * cp, -Math.sin(yaw) * cp, Math.sin(-pitch) * -1 * -1];
    const l = Math.hypot(...this.sun) || 1;
    this.sun = this.sun.map((x) => x / l);
    this.sun[2] = Math.abs(this.sun[2]);
    await this._loadProps(bsp, onProgress);
  }

  async _meshFor(path, pak, skin = 0, { body = null, material = null } = {}) {
    const key = `${path.toLowerCase()}#${skin}#${body ? [...body].sort() : ''}#${material ?? ''}`;
    if (this.meshes.has(key)) return this.meshes.get(key);
    const pr = (async () => {
      const base = path.replace(/\.mdl$/i, '');
      const [m, vvd, vtx] = await Promise.all([this.fetchGame(base + '.mdl', pak), this.fetchGame(base + '.vvd', pak), this.fetchGame(base + '.dx90.vtx', pak)]);
      if (!m || !vvd || !vtx) return null;
      const model = new Model(m, path);
      const mesh = buildMesh(model, vvd, vtx, skin, body);
      const replaced = material?.replace(/\\+/g, '/').replace(/^materials\//i, '').replace(/\.vmt$/i, '');
      const nv = mesh.positions.length / 3;
      if (!nv) return null;
      // static layout: pos,n,uv / skinned layout: pos,n,uv,w,idx
      const buf = new ArrayBuffer(nv * 64);
      const f = new Float32Array(buf), u8 = new Uint8Array(buf);
      for (let i = 0; i < nv; i++) {
        const o = i * 16;
        f[o] = mesh.positions[i * 3]; f[o + 1] = mesh.positions[i * 3 + 1]; f[o + 2] = mesh.positions[i * 3 + 2];
        f[o + 3] = mesh.normals[i * 3]; f[o + 4] = mesh.normals[i * 3 + 1]; f[o + 5] = mesh.normals[i * 3 + 2];
        f[o + 6] = mesh.uvs[i * 2]; f[o + 7] = mesh.uvs[i * 2 + 1];
        f[o + 8] = mesh.boneW[i * 3]; f[o + 9] = mesh.boneW[i * 3 + 1]; f[o + 10] = mesh.boneW[i * 3 + 2];
        u8[i * 64 + 44] = mesh.boneIdx[i * 3]; u8[i * 64 + 45] = mesh.boneIdx[i * 3 + 1]; u8[i * 64 + 46] = mesh.boneIdx[i * 3 + 2];
        f[o + 12] = mesh.tangents[i * 4]; f[o + 13] = mesh.tangents[i * 4 + 1]; f[o + 14] = mesh.tangents[i * 4 + 2]; f[o + 15] = mesh.tangents[i * 4 + 3];
      }
      const vb = this.device.createBuffer({ size: buf.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(vb, 0, buf);
      const ib = this.device.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(ib, 0, mesh.indices);
      const subs = [];
      let chargeParams = null;
      for (const s of mesh.meshes) {
        let tex = null, cut = false, chargeBg = null, vmat = null;
        for (const dir of replaced ? [''] : model.cdtextures) {
          const nm = replaced ?? (dir + s.material).replace(/\\/g, '/');
          const vm = await this._vmt(nm, pak);
          if (vm) {
            tex = vm.p.$basetexture ? await this._tex(vm.p.$basetexture, pak) : await this._tex(nm, pak);
            cut = Renderer.cutout(vm);
            vmat = vm;
            if (tex && vm.p.$chargetexture && vm.p.$chargepassenabled) {
              const [ct, nt, ns] = await Promise.all([this._tex(vm.p.$chargetexture, pak), this._tex(vm.p.$chargenormaltexture ?? vm.p.$bumpmap ?? vm.p.$normalmap, pak), this._tex(vm.p.$chargenoisetexture ?? 'engine/noise-blur-256x256', pak)]);
              if (ct) {
                chargeBg = this.device.createBindGroup({ layout: this.gCharge, entries: [ct, ns || this.white, nt || this.fallback].map((t, binding) => ({ binding, resource: t.createView() })) });
                chargeParams ??= vm.p;
              }
            }
            if (tex) break;
          }
        }
        const t = tex || this.fallback;
        subs.push({ start: s.start, count: s.count, bg: await this._modelMaterial(t, vmat, pak), ok: !!tex, material: s.material, cut, chargeBg, noShadow: /^(refract|unlit)/.test(vmat?.shader ?? '') || on(vmat?.p?.$additive), hidden: on(vmat?.p?.$additive) });
      }
      let radius = 0;
      for (let i = 0; i < nv * 3; i += 3) radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
      return { vb, ib, subs, model, chargeParams, nv, radius, vhvMesh: mesh.vhvMesh, vhvVert: mesh.vhvVert };
    })().catch((e) => { console.warn('mesh', path, e.message); return null; });
    this.meshes.set(key, pr);
    return pr;
  }

  async _loadProps(bsp, onProgress) {
    const { names, props } = bsp.staticProps();
    if (!props?.length) return;
    const by = new Map();
    props.forEach((p, index) => { const k = `${p.model}:${p.skin}`; let l = by.get(k); if (!l) by.set(k, (l = [])); l.push({ ...p, index }); });
    let done = 0;
    const entries = [...by.entries()];
    await Promise.all(entries.map(async ([, list]) => {
      const mi = list[0].model;
      const mesh = await this._meshFor(names[mi], bsp, list[0].skin);
      onProgress(`props ${++done}/${entries.length}`);
      if (!mesh) return;
      const inst = new Float32Array(list.length * 12);
      list.forEach((p, i) => inst.set(propMatrix(p.origin, p.angles), i * 12));
      const ib = this.device.createBuffer({ size: inst.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(ib, 0, inst);
      const draws = await Promise.all(list.map(async (p) => ({ colors: await this._propColors(mesh, p, bsp), env: this._envAt(p.origin), origin: p.origin })));
      this.propBatches.push({ mesh, inst: ib, count: list.length, name: names[mi], first: list[0], draws });
    }));
  }

  async _modelMaterial(base, vm, pak) {
    const d = this.device, p = vm?.p ?? {};
    const f = (k, def) => { const v = parseFloat(p[k]); return Number.isNaN(v) ? def : v; };
    const tex = async (name, linear) => (on(name) ? this._tex(name, pak, linear) : null);
    const envName = on(p.$envmap);
    const phong = on(p.$phong);
    const [specWarp, diffWarp, normal, exp] = await Promise.all([tex(p.$phongwarptexture), tex(p.$lightwarptexture), tex(p.$bumpmap ?? p.$normalmap, true), tex(p.$phongexponenttexture, true)]);
    const ranges = vmtColor(p.$phongfresnelranges, [0, 0.5, 1]), tint = vmtColor(p.$color2 ?? p.$color, [1, 1, 1]).map(gammaToLinear), envTint = vmtColor(p.$envmaptint, [1, 1, 1]).map(gammaToLinear);
    const phongTint = p.$phongtint !== undefined ? vmtColor(p.$phongtint, [1, 1, 1]) : [-1, -1, -1];
    const u = d.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // [R stdshader_dx9 180035f7b] the normal map takes the base's transform unless it has its own
    const uvBase = uvTransform(p.$basetexturetransform), uvBump = p.$bumptransform !== undefined ? uvTransform(p.$bumptransform) : uvBase;
    d.queue.writeBuffer(u, 0, new Float32Array([
      ...tint, 1,
      ...ranges, f('$phongboost', 1),
      ...envTint, on(p.$normalmapalphaenvmapmask) ? 1 : 0,
      ...phongTint, f('$rimlightexponent', 4),
      on(p.$basemapalphaphongmask) ? 1 : 0, on(p.$basemapluminancephongmask) ? 1 : 0, exp ? 0 : f('$phongexponent', 5), on(p.$invertphongmask) ? 1 : 0,
      phong ? 1 : 0, on(p.$rimlight) ? 1 : 0, f('$rimlightboost', 1), on(p.$rimmask) ? 1 : 0,
      diffWarp ? 1 : 0, specWarp ? 1 : 0, envName ? 1 : 0, on(p.$phongalbedotint) ? 1 : 0,
      on(p.$selfillum) ? 1 : 0, /^unlit/.test(vm?.shader ?? '') ? 1 : 0, on(p.$normalmapalphaenvmapmask) ? 1 : on(p.$basealphaenvmapmask) ? 2 : 0, f('$envmapcontrast', 0),
      f('$envmapsaturation', 1), on(p.$phongexponenttintmaskenable) && exp ? 1 : 0, 0, 0,
      ...uvBase, ...uvBump]));
    return d.createBindGroup({ layout: this.gModelMat, entries: [base, specWarp || this.white, diffWarp || this.white, normal || this.flatNormal, exp || this.noExp].map((t, binding) => ({ binding, resource: t.createView() })).concat({ binding: 5, resource: { buffer: u } }) });
  }

  // sp_hdr_<prop>.vhv: three colors a vertex, along the bump basis. A prop without one takes the ambient cube's average.
  async _propColors(mesh, prop, bsp) {
    const d = this.device;
    const out = new Uint8Array(mesh.nv * 12);
    const bytes = await this.fetchGame(`sp_hdr_${prop.index}.vhv`, bsp);
    let ok = false;
    if (bytes && bytes.length > 40) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (dv.getUint32(0, true) === 2 && dv.getUint32(12, true) === 12) {
        const numMeshes = dv.getUint32(20, true), lod0 = [];
        for (let i = 0; i < numMeshes; i++) { const o = 40 + i * 28; if (dv.getUint32(o, true) === 0) lod0.push({ n: dv.getUint32(o + 4, true), off: dv.getUint32(o + 8, true) }); }
        ok = true;
        for (let v = 0; v < mesh.nv; v++) {
          const me = lod0[mesh.vhvMesh[v]], i = mesh.vhvVert[v];
          if (!me || i >= me.n) { ok = false; break; }
          const s = me.off + i * 12;
          // stored as D3D colors: b g r a
          for (let k = 0; k < 3; k++) { const a = s + k * 4; out[v * 12 + k * 4] = bytes[a + 2]; out[v * 12 + k * 4 + 1] = bytes[a + 1]; out[v * 12 + k * 4 + 2] = bytes[a]; out[v * 12 + k * 4 + 3] = bytes[a + 3]; }
        }
      }
    }
    if (!ok) {
      this.vhvMissing = (this.vhvMissing || 0) + 1;
      const cube = this.lighting.ambientCube([prop.origin[0], prop.origin[1], prop.origin[2] + 8]);
      const avg = [0, 1, 2].map((k) => (cube[k] + cube[3 + k] + cube[6 + k] + cube[9 + k] + cube[12 + k] + cube[15 + k]) / 6);
      const enc = avg.map((x) => Math.min(255, Math.round(255 * Math.pow(x, 1 / 2.2) / 2)));
      for (let v = 0; v < mesh.nv * 3; v++) { out[v * 4] = enc[0]; out[v * 4 + 1] = enc[1]; out[v * 4 + 2] = enc[2]; out[v * 4 + 3] = 0; }
    }
    const vb = d.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(vb, 0, out);
    return vb;
  }

  async _loadLighting(bsp, pak) {
    const d = this.device;
    this.lighting = new WorldLighting(bsp);
    const map = [...bsp.pakIndex().keys()].map((k) => /^materials\/maps\/([^/]+)\/c-?\d+_/.exec(k)?.[1]).find(Boolean);
    this.envGroups = await Promise.all(this.lighting.cubemaps.map(async (c) => {
      const t = map ? await this._cube(`maps/${map}/c${c[0]}_${c[1]}_${c[2]}`, pak) : null;
      return t ? d.createBindGroup({ layout: this.gEnv, entries: [{ binding: 0, resource: t.createView({ dimension: 'cube' }) }] }) : this.bgBlackEnv;
    }));
  }

  _envAt(p) { return this.envGroups?.[this.lighting.nearestCubemap(p)] ?? this.bgBlackEnv; }

  /**
   * Refreshes what a character is lit by; a few frames between samples, since each traces to every light
   * @param {object} fc The fighter's frame data.
   * @param {number[]} o Their position.
   */
  lightCharacter(fc, o) {
    if (!this.lighting) return;
    const b = fc.bones;
    if (b.lightAge > 0) { b.lightAge--; return; }
    b.lightAge = 5;
    const p = [o[0], o[1], o[2] + 36];
    const { cube, lights } = this.lighting.sample(p);
    b.env = this._envAt(p);
    const base = LIGHT_DATA;
    for (let f = 0; f < 6; f++) b.data.set([cube[f * 3], cube[f * 3 + 1], cube[f * 3 + 2], 0], base + f * 4);
    lights.forEach((l, i) => b.data.set([...l.color, ...l.dir, ...l.pos, ...l.spot, ...l.atten], base + 24 + i * 20));
    b.data[base + 104] = lights.length;
  }

  // [customization.res] the render panel's view_ambient and two directional lights, and its cubemap
  async loadMenuEnv() {
    if (this.menuEnv) return;
    const t = await this._cube('engine/hdr_cubemap', null).catch(() => null);
    this.menuEnv = t ? this.device.createBindGroup({ layout: this.gEnv, entries: [{ binding: 0, resource: t.createView({ dimension: 'cube' }) }] }) : this.bgBlackEnv;
  }

  menuLights(b) {
    const base = LIGHT_DATA;
    for (let f = 0; f < 6; f++) b.data.set([0.1, 0.1, 0.1, 0], base + f * 4);
    [[[1, 1, 0.4], [0.7, 0.7, 1.3]], [[-1, -0.5, -1], [0.5, 0.25, 0]]].forEach(([dir, col], i) => {
      const n = norm3(dir);
      b.data.set([...col, 0, ...n, 0, -n[0] * 1e6, -n[1] * 1e6, -n[2] * 1e6, 0, 0, 0, 0, 1, 1, 0, 0, 0], base + 24 + i * 20);
    });
    b.data[base + 104] = 2;
    b.env = this.menuEnv ?? this.bgBlackEnv;
  }

  /**
   * A sword or scabbard: it follows the fighter's bones of the same names, and its others hold its idle's first frame
   * @param {string} path Model path.
   * @param {number} skin Skin family.
   * @param {string} [material] Material to use instead.
   * @returns {Promise<object|null>} The mesh.
   */
  loadAttachment(path, skin, material = null) { return this._meshFor(path, null, skin, { material }).catch(() => null); }
  /**
   * The fighter's own model with a skin family and body groups chosen
   * @param {string} path Model path.
   * @param {number} skin Skin family.
   * @param {Set<string>} body Body groups.
   * @returns {Promise<object|null>} The mesh.
   */
  loadBody(path, skin, body) { return this._meshFor(path, null, skin, { body }).catch(() => null); }

  /**
   * Poses a sword, scabbard, mask or cape on a fighter this frame. Bones sharing a fighter bone's name take its matrix; the others follow from those.
   * @param {object} fc The fighter's frame data, from frameCharacter.
   * @param {object} part The part. With `held`, its own bones use idlePose rather than the reference pose.
   * @param {Character} char The fighter's character.
   * @param {object} [sword] For a sword or scabbard, from swordState.
   */
  attachTo(fc, part, char, sword = null) {
    const { model } = part.mesh, out = new Array(model.bones.length), data = part.bones.data;
    const pose = part.held ? (sword && model.activityPose(sword.act, sword.cycle)) ?? model.idlePose() : model.refPose();
    let matched = false;
    // [R client 1802c6e68, 1802c7a00] All the way in, the sword's sword_grip sits on the mount
    const point = sword && char.root.attachments.find((a) => a.name === sword.mount);
    const mountWorld = point && matMul(fc.world[point.bone], point.local);
    const boneWorld = (name, hit) => (sword?.sheathed && point && name === 'sword_grip' ? mountWorld : fc.world[hit]);
    // [R client 180384583, 1802c6322] A scabbard's anim_sheathe sits on the same mount, whichever bone it's named for
    const socket = part.held && point && model.attachments.find((a) => a.name === 'anim_sheathe');
    const mountSpace = socket ? matMul(mountWorld, rigidInverse(matMul(pose.world[socket.bone], socket.local))) : null, mounted = socket ? matMul(mountSpace, pose.world[0]) : null;
    if (mounted) matched = true;
    // where the model's own space lands: a root the fighter doesn't have stays rigid with the bones it does
    let rigid = mountSpace;
    model.bones.forEach((b, i) => {
      const hit = char.root.boneByName.get(b.name.toLowerCase());
      if (hit !== undefined && !rigid) { rigid = matMul(boneWorld(b.name.toLowerCase(), hit), rigidInverse(pose.world[i])); matched = true; }
    });
    // A cape hangs from the fighter's attachment of the same name [client.dll 180383a49], which sits off the bone. Ten swords
    // also name those attachments, but nothing places a sword by them.
    const own = model.attachments.find((a) => /^anim_/.test(a.name)), theirs = own && char.root.attachments.find((a) => a.name === own.name);
    const anchor = theirs && own.bone === 0 && !part.held ? matMul(matMul(fc.world[theirs.bone], theirs.local), rigidInverse(own.local)) : null;
    part.jiggle ??= new JiggleBones(jiggleInfo(model));
    const now = performance.now() / 1000;
    model.bones.forEach((b, i) => {
      const hit = char.root.boneByName.get(b.name.toLowerCase());
      if (i === 0 && (mounted || anchor)) out[i] = mounted ?? anchor;
      else if (hit !== undefined && !mounted) out[i] = boneWorld(b.name.toLowerCase(), hit);
      else if (b.parent >= 0 && out[b.parent]) {
        const goal = matMul(out[b.parent], pose.local[i]);
        out[i] = part.jiggle.info.has(i) ? part.jiggle.update(i, now, goal) : goal;
      } else if (rigid) out[i] = matMul(rigid, pose.world[i]);
      if (i >= 128) return;
      if (out[i]) data.set(matMul(out[i], b.poseToBone), i * 12);
    });
    part.shown = matched;
    // lit where its fighter stands, in the fighter's color
    data.set(fc.bones.data.subarray(128 * 12, 128 * 12 + 4), 128 * 12);
    data.set(fc.bones.data.subarray(LIGHT_DATA), LIGHT_DATA);
    part.bones.env = fc.bones.env;
  }

  /**
   * Skinned character instance
   * @param {string} key Character key.
   * @param {string} mdlPath Model path.
   * @param {Character} char The character.
   * @returns {Promise<{key: string, mesh: object, char: Character}>} The instance.
   */
  async loadCharacter(key, mdlPath, char) {
    const mesh = await this._meshFor(mdlPath, null);
    if (!mesh) throw new Error('character mesh missing: ' + mdlPath);
    return { key, mesh, char };
  }

  newBoneBuffer() {
    const words = LIGHT_DATA + 24 + 80 + 4;
    const buf = this.device.createBuffer({ size: words * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { buf, bg: this.device.createBindGroup({ layout: this.gBones, entries: [{ binding: 0, resource: { buffer: buf } }] }), data: new Float32Array(words), lightAge: 0, env: null };
  }

  // ---------------------------------------------------------------- attack preview
  async loadTracerPreview() {
    const d = this.device, vm = await this._vmt('models/tracemodels/preview', null), p = vm?.p;
    if (!p) return;
    const [base, scroll] = await Promise.all([this._tex(p.$basetexture, null), this._tex(p.$scroll_texture, null)]);
    if (!base || !scroll) return;
    const list = (k) => String(p[k]).match(/-?[\d.]+/g).map(Number), num = (k) => parseFloat(p[k]);
    this.previewMat = { color: list('$color'), pulse: list('$pulse_color'), hl: list('$highlight_color'), hp: list('$highlight_pulse_color'), scroll: list('$scroll_speeds'), cfg: ['$pulse_highlight_frequency', '$pulse_highlight_speed', '$pulse_fade_frequency', '$pulse_fade_speed'].map(num) };
    const m = d.createShaderModule({ code: PREVIEW_WGSL });
    this.gPreview = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} }, { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } }] });
    this.previewTex = [base.createView(), scroll.createView()];
    this.previewUB = d.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.previewVB = d.createBuffer({ size: 1 << 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.pPreview = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.gPreview] }),
      vertex: { module: m, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }] },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    });
  }

  _drawTracerPreview(enc, view, colorTex, depth, tg) {
    const tp = view.tracerPreview, d = this.device, m = this.previewMat;
    if (!tp || !this.pPreview || tp.verts.byteLength > this.previewVB.size) return;
    d.queue.writeBuffer(this.previewVB, 0, tp.verts);
    d.queue.writeBuffer(this.previewUB, 0, new Float32Array([...view.vp, tp.opacity, performance.now() / 1000, view.near ?? 4, view.far ?? 16000, ...tp.ranges,
      ...m.color, 0, ...m.pulse, 0, ...m.scroll, 0, 0, ...m.cfg, ...m.hl, tp.amount, ...m.hp, tp.position]));
    const bg = (tg ?? this).bgPreview ??= d.createBindGroup({ layout: this.gPreview, entries: [{ binding: 0, resource: { buffer: this.previewUB } }, { binding: 1, resource: this.previewTex[0] }, { binding: 2, resource: this.previewTex[1] }, { binding: 3, resource: this.samp }, { binding: 4, resource: depth.createView({ aspect: 'depth-only' }) }] });
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: colorTex.createView(), loadOp: 'load', storeOp: 'store' }], depthStencilAttachment: { view: depth.createView(), depthReadOnly: true } });
    pass.setPipeline(this.pPreview);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.previewVB);
    pass.draw(tp.count);
    pass.end();
  }

  // ---------------------------------------------------------------- arena previews
  /**
   * [R client 18028ac20, 180268420] the scoreboard shows each arena through its spectator camera. The game keeps one
   * texture (_rt_duelPreview) split into four cells; a texture per arena gives the water its own depth and scene copy.
   * @param {number} i Arena index.
   * @returns {object} The texture and depth to draw that arena into.
   */
  previewTarget(i) {
    const d = this.device, w = Math.max(1, this.canvas.width >> 1), h = Math.max(1, this.canvas.height >> 1);
    this.previews ??= [];
    let t = this.previews[i];
    if (t?.color.width === w && t.color.height === h) return t;
    if (t) { t.color.destroy(); t.depth.destroy(); t.scene.destroy(); }
    const color = d.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    t = this.previews[i] = {
      color,
      depth: d.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }),
      scene: d.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }),
      bg0Water: null, bgPreview: null, drawn: false,
      blit: d.createBindGroup({ layout: this.pBlit.getBindGroupLayout(0), entries: [{ binding: 0, resource: color.createView() }, { binding: 1, resource: this.blitSamp }] }),
    };
    return t;
  }

  /**
   * rects: [{ i, x, y, w, h }] in canvas pixels, drawn over the frame already on the canvas
   */
  drawPreviews(rects) {
    const shown = rects.filter((r) => this.previews?.[r.i]?.drawn);
    if (!shown.length) return;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pBlit);
    for (const r of shown) {
      // a window too small to hold the view: the columns clip it, so don't draw past the canvas either
      if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > this.canvas.width || r.y + r.h > this.canvas.height) continue;
      pass.setViewport(r.x, r.y, r.w, r.h, 0, 1);
      pass.setBindGroup(0, this.previews[r.i].blit);
      pass.draw(3);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // ---------------------------------------------------------------- frame
  /**
   * Draws one frame.
   * @param {object} view vp, eye, fwd, fovY, characters, tris, tracerPreview, fx, and target to draw somewhere other than the canvas.
   */
  frame(view) {
    this.resize();
    const d = this.device;
    const now = performance.now() / 1000;
    // an arena preview is an extra view of the same frame, so it leaves the exposure alone
    const tg = view.target;
    if (!tg) {
      if (!view.preview) this.exposure.step(this.lastFrameT ? Math.min(0.1, now - this.lastFrameT) : 0);
      this.lastFrameT = now;
    }
    const cam = new Float32Array(84);
    cam.set(view.vp, 0); cam.set([...view.eye, 1], 16); cam.set([...(this.sun || [0.3, 0.3, 0.9]), 1], 20); cam.set([0, 0, 0, this.exposure.scale], 24);
    if (view.preview) cam[27] = 1; // no auto exposure on the menu
    const csmOn = !view.preview && !this.noCSM && this._updateCascades(view);
    if (csmOn) {
      this.csmSpheres.forEach((s, i) => cam.set(s.m, 28 + i * 16));
      cam.set([...this.lighting.sky.color, 1], 76);
      // fades out over the last tenth of the distance [I]
      const a = (CSM_DIST * 0.9) ** 2, b = CSM_DIST ** 2;
      cam.set([1 / (b - a), -a / (b - a), 0, 0], 80);
    }
    d.queue.writeBuffer(this.camBuf, 0, cam);
    const enc = d.createCommandEncoder();
    if (csmOn) this._drawCascades(enc, view);
    const colorTex = tg?.color ?? this.ctx.getCurrentTexture();
    const depth = tg?.depth ?? this.depth, sceneCopy = tg?.scene ?? this.sceneCopy, copySize = [colorTex.width, colorTex.height];
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: colorTex.createView(), clearValue: { r: 0.5, g: 0.6, b: 0.75, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    if (view.preview) { pass.setPipeline(this.pBackdrop); pass.draw(3); }
    if (this.bg0World && !this.hideWorld && !view.preview) {
      pass.setPipeline(this.pWorld);
      pass.setBindGroup(0, this.bg0World);
      pass.setVertexBuffer(0, this.worldVB);
      for (const dr of this.worldDraws) { pass.setPipeline(dr.cut ? this.pWorldCut : this.pWorld); pass.setBindGroup(1, dr.bg); pass.draw(dr.count, 1, dr.first, 0); }
    }
    pass.setPipeline(this.pProp);
    pass.setBindGroup(0, this.bg0Obj);
    for (const b of this.hideProps || view.preview ? [] : (this.onlyProp !== undefined ? this.propBatches.filter((x, i) => i === this.onlyProp) : this.propBatches)) {
      pass.setVertexBuffer(0, b.mesh.vb);
      pass.setVertexBuffer(1, b.inst);
      pass.setIndexBuffer(b.mesh.ib, 'uint32');
      for (const s of b.mesh.subs) {
        if (s.hidden) continue;
        pass.setPipeline(s.cut ? this.pPropCut : this.pProp);
        pass.setBindGroup(1, s.bg);
        for (let i = 0; i < b.draws.length; i++) {
          pass.setVertexBuffer(2, b.draws[i].colors);
          pass.setBindGroup(2, b.draws[i].env);
          pass.drawIndexed(s.count, 1, s.start, 0, i);
        }
      }
    }
    pass.setPipeline(this.pSkin);
    pass.setBindGroup(0, this.bg0Obj);
    for (const c of view.characters) {
      d.queue.writeBuffer(c.bones.buf, 0, c.bones.data);
      pass.setBindGroup(2, c.bones.bg);
      pass.setBindGroup(3, c.bones.env ?? this.bgBlackEnv);
      pass.setVertexBuffer(0, c.mesh.vb);
      pass.setIndexBuffer(c.mesh.ib, 'uint32');
      for (const s of c.mesh.subs) { if (s.hidden) continue; pass.setPipeline(s.cut ? this.pSkinCut : this.pSkin); pass.setBindGroup(1, s.bg); pass.drawIndexed(s.count, 1, s.start, 0, 0); }
      if (c.charge > 0.001 || c.rim > 0) {
        pass.setPipeline(this.pCharge);
        for (const s of c.mesh.subs) if (s.chargeBg) { pass.setBindGroup(1, s.chargeBg); pass.drawIndexed(s.count, 1, s.start, 0, 0); }
      }
    }
    if (this.bgSky && !view.preview) {
      d.queue.writeBuffer(this.skyInv, 0, invert4(view.vp));
      pass.setPipeline(this.pSky);
      pass.setBindGroup(0, this.bgSky);
      pass.draw(3);
    }
    if (view.tris?.length) {
      const arr = new Float32Array(view.tris);
      d.queue.writeBuffer(this.triBuf, 0, arr, 0, Math.min(arr.length, this.triBuf.size / 4));
      pass.setPipeline(this.pTri);
      pass.setBindGroup(0, this.triBG);
      pass.setVertexBuffer(0, this.triBuf);
      pass.draw(Math.min(arr.length / 7, this.triBuf.size / 28));
    }
    pass.end();
    if (this.waterDraws.length && !this.hideWorld && !view.preview) {
      enc.copyTextureToTexture({ texture: colorTex }, { texture: sceneCopy }, copySize);
      const right = norm3(cross3(view.fwd, [0, 0, 1])), up = cross3(right, view.fwd);
      d.queue.writeBuffer(this.waterBuf, 0, new Float32Array([...invert4(view.vp), ...right, 0, ...up, 0, performance.now() / 1000, 0, 0, 0]));
      const bgWater = (tg ?? this).bg0Water ??= d.createBindGroup({ layout: this.g0Water, entries: [
        { binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.samp }, { binding: 2, resource: this.lmView }, { binding: 3, resource: this.lmSamp },
        { binding: 4, resource: sceneCopy.createView() }, { binding: 5, resource: depth.createView() }, { binding: 6, resource: { buffer: this.waterBuf } }] });
      const wp = enc.beginRenderPass({
        colorAttachments: [{ view: colorTex.createView(), loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
      });
      wp.setPipeline(this.pWater);
      wp.setBindGroup(0, bgWater);
      wp.setVertexBuffer(0, this.worldVB);
      for (const dr of this.waterDraws) { wp.setBindGroup(1, dr.bg); wp.draw(dr.count, 1, dr.first, 0); }
      wp.end();
    }
    if (view.tracerPreview) this._drawTracerPreview(enc, view, colorTex, depth, tg);
    const fx = view.fx;
    if (fx?.count) {
      d.queue.writeBuffer(this.fxVB, 0, fx.verts, 0, fx.count);
      if (fx.draws.some((x) => x.mat.refract)) enc.copyTextureToTexture({ texture: colorTex }, { texture: this.sceneCopy }, [this.canvas.width, this.canvas.height]);
      this.bgFx0 ??= d.createBindGroup({ layout: this.gFx0, entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.fxSamp }, { binding: 2, resource: this.depth.createView() }, { binding: 3, resource: this.sceneCopy.createView() }] });
      const p2 = enc.beginRenderPass({
        colorAttachments: [{ view: colorTex.createView(), loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: this.depth.createView(), depthReadOnly: true },
      });
      p2.setBindGroup(0, this.bgFx0);
      p2.setVertexBuffer(0, this.fxVB);
      for (const x of fx.draws) { p2.setPipeline(x.mat.refract ? this.pFxRefract : this.pFx); p2.setBindGroup(1, x.mat.bg); p2.draw(x.count, 1, x.first, 0); }
      p2.end();
    }
    const readHist = !view.preview && !tg && !this.histBusy && ++this.histFrame % 6 === 0;
    if (readHist) {
      const hp = enc.beginRenderPass({ colorAttachments: [{ view: this.histTex.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      hp.setPipeline(this.pHist);
      hp.setBindGroup(0, d.createBindGroup({ layout: this.pHist.getBindGroupLayout(0), entries: [{ binding: 0, resource: colorTex.createView() }, { binding: 1, resource: this.histSamp }] }));
      hp.draw(3);
      hp.end();
      enc.copyTextureToBuffer({ texture: this.histTex }, { buffer: this.histBuf, bytesPerRow: 256 }, [64, 36]);
    }
    d.queue.submit([enc.finish()]);
    if (readHist) {
      this.histBusy = true;
      this.histBuf.mapAsync(GPUMapMode.READ).then(() => {
        const px = new Uint8Array(this.histBuf.getMappedRange());
        const lums = new Float32Array(64 * 36);
        for (let i = 0; i < lums.length; i++) lums[i] = 0.2125 * SRGB_LINEAR[px[i * 4]] + 0.7154 * SRGB_LINEAR[px[i * 4 + 1]] + 0.0721 * SRGB_LINEAR[px[i * 4 + 2]];
        this.histBuf.unmap();
        this.exposure.measure(lums);
        this.histBusy = false;
      }).catch(() => { this.histBusy = false; });
    }
  }
}
// [R bb_tracer_preview_ps20b] Faded along the swing, across it and from the top, pulsing, with the part up to a target in
// the highlight colours. Depth from _rt_FullFrameDepth's range of 192 feathers it into the world over 50 units.
const PREVIEW_WGSL = `
struct P { vp: mat4x4f, at: vec4f, r: vec4f, color: vec4f, pulse: vec4f, scroll: vec4f, cfg: vec4f, hl: vec4f, hp: vec4f };
@group(0) @binding(0) var<uniform> u: P;
@group(0) @binding(1) var base: texture_2d<f32>;
@group(0) @binding(2) var scrollTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var depth: texture_depth_2d;
struct O { @builtin(position) p: vec4f, @location(0) t: vec4f, @location(1) cw: f32 };
@vertex fn vs(@location(0) pos: vec3f, @location(1) t: vec4f) -> O { var o: O; o.p = u.vp * vec4f(pos, 1); o.t = t; o.cw = o.p.w; return o; }
fn ss(x: f32) -> f32 { return x * x * (3.0 - 2.0 * x); }
fn pow4(x: f32) -> f32 { let y = x * x; return y * y; }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let t = i.t; let time = u.at.y;
  let breathe = ss((sin(t.z * u.cfg.z + time * u.cfg.w) + 1.0) * 0.5);
  let bump = pow4(1.0 - ss(saturate(abs(t.z - u.r.w) * 12.0)));
  var a = u.at.x * (breathe * breathe * breathe * 0.6 + 0.4) + bump;
  a *= saturate((t.z - u.r.x) * 10.0) * saturate((u.r.y - t.z) * 5.0) * saturate((t.y - u.r.z) * 20.0);
  a = saturate(a * ss(saturate((abs(2.0 * t.w - 1.0) - 1.0) / (saturate(0.8 - t.z) - 1.0))));
  let n = u.at.z; let f = u.at.w;
  let sceneZ = n * f / (f - textureLoad(depth, vec2i(i.p.xy), 0) * (f - n));
  let scene = saturate(sceneZ / 192.0);
  let feather = saturate(max(ss(saturate((scene - 0.75) * 4.0)), abs(scene - i.cw / 192.0) * 192.0 / 50.0));
  let h = max(2.0 * (sin(t.z * u.cfg.x + time * u.cfg.y) - 0.5), 0.0);
  let bright = max(pow4(h * h * (3.0 - 2.0 * h)), bump);
  let k = saturate((t.z - u.hp.w) * 15.0) * u.hl.w;
  let b = textureSample(base, samp, t.xy + vec2f(time * u.scroll.x, 0)).rgb;
  let s = textureSample(scrollTex, samp, t.xy + vec2f(time * u.scroll.y, 0)).rgb;
  let c = mix(b * mix(u.color.rgb, u.hl.rgb, k), b * mix(u.pulse.rgb, u.hp.rgb, k), bright);
  return vec4f(s * c, 2.0 * a * feather);
}`;
const SRGB_LINEAR = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

function invert4(m) {
  const a = m, r = new Float32Array(16);
  const b = [a[0]*a[5]-a[1]*a[4], a[0]*a[6]-a[2]*a[4], a[0]*a[7]-a[3]*a[4], a[1]*a[6]-a[2]*a[5], a[1]*a[7]-a[3]*a[5], a[2]*a[7]-a[3]*a[6],
    a[8]*a[13]-a[9]*a[12], a[8]*a[14]-a[10]*a[12], a[8]*a[15]-a[11]*a[12], a[9]*a[14]-a[10]*a[13], a[9]*a[15]-a[11]*a[13], a[10]*a[15]-a[11]*a[14]];
  const k = 1 / (b[0]*b[11]-b[1]*b[10]+b[2]*b[9]+b[3]*b[8]-b[4]*b[7]+b[5]*b[6]);
  r[0]=(a[5]*b[11]-a[6]*b[10]+a[7]*b[9])*k; r[1]=(a[2]*b[10]-a[1]*b[11]-a[3]*b[9])*k; r[2]=(a[13]*b[5]-a[14]*b[4]+a[15]*b[3])*k; r[3]=(a[10]*b[4]-a[9]*b[5]-a[11]*b[3])*k;
  r[4]=(a[6]*b[8]-a[4]*b[11]-a[7]*b[7])*k; r[5]=(a[0]*b[11]-a[2]*b[8]+a[3]*b[7])*k; r[6]=(a[14]*b[2]-a[12]*b[5]-a[15]*b[1])*k; r[7]=(a[8]*b[5]-a[10]*b[2]+a[11]*b[1])*k;
  r[8]=(a[4]*b[10]-a[5]*b[8]+a[7]*b[6])*k; r[9]=(a[1]*b[8]-a[0]*b[10]-a[3]*b[6])*k; r[10]=(a[12]*b[4]-a[13]*b[2]+a[15]*b[0])*k; r[11]=(a[9]*b[2]-a[8]*b[4]-a[11]*b[0])*k;
  r[12]=(a[5]*b[7]-a[4]*b[9]-a[6]*b[6])*k; r[13]=(a[0]*b[9]-a[1]*b[7]+a[2]*b[6])*k; r[14]=(a[13]*b[1]-a[12]*b[3]-a[14]*b[0])*k; r[15]=(a[8]*b[3]-a[9]*b[1]+a[10]*b[0])*k;
  return r;
}

void matMul; void quatMatrix;
