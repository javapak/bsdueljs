// WebGPU renderer: BSP world with HDR lightmaps, displacements with 2-way blending,
// static props, skinned characters and a sword blade. Source is z-up, right-handed.
import { parseKV, kvGet } from '/shared/kv.js';
import { parseVTF, decodeLevel, isBCFormat } from './vtf.js';
import { Model, buildMesh } from '/shared/mdl.js';
import { SURF_TRANS, SURF_NODRAW, SURF_SKY, SURF_SKY2D, SURF_TRIGGER, SURF_SKIP, SURF_HINT } from '/shared/bsp.js';
import { matMul, quatMatrix } from '/shared/mathx.js';

const WORLD_WGSL = /* wgsl */`
override CUT: f32 = -1.0;
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var lm: texture_2d<f32>;
@group(0) @binding(3) var lmSamp: sampler;
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
struct V { @location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) luv: vec2f, @location(3) blend: f32 };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) luv: vec2f, @location(2) blend: f32, @location(3) w: vec3f };
@vertex fn vs(v: V) -> O { var o: O; o.p = cam.vp * vec4f(v.pos, 1); o.uv = v.uv; o.luv = v.luv; o.blend = v.blend; o.w = v.pos; return o; }
fn finish(c: vec3f) -> vec4f { let x = c * cam.fog.w; let m = x / (x + vec3f(0.85)) * 1.35; return vec4f(pow(clamp(m, vec3f(0), vec3f(1)), vec3f(1.0 / 2.2)), 1); }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let a = textureSample(t0, samp, i.uv); let b = textureSample(t1, samp, i.uv);
  let c = mix(a, b, i.blend);
  if (c.a < CUT) { discard; }
  let l = textureSampleLevel(lm, lmSamp, i.luv, 0).rgb;
  return finish(c.rgb * l);
}`;
const PROP_WGSL = /* wgsl */`
override CUT: f32 = -1.0;
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var t0: texture_2d<f32>;
struct V { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) m0: vec4f, @location(4) m1: vec4f, @location(5) m2: vec4f };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) n: vec3f };
@vertex fn vs(v: V) -> O {
  var o: O;
  let w = vec3f(dot(v.m0, vec4f(v.pos, 1)), dot(v.m1, vec4f(v.pos, 1)), dot(v.m2, vec4f(v.pos, 1)));
  o.p = cam.vp * vec4f(w, 1); o.uv = v.uv;
  o.n = vec3f(dot(v.m0.xyz, v.n), dot(v.m1.xyz, v.n), dot(v.m2.xyz, v.n)); return o;
}
fn finish(c: vec3f) -> vec4f { let x = c * cam.fog.w; let m = x / (x + vec3f(0.85)) * 1.35; return vec4f(pow(clamp(m, vec3f(0), vec3f(1)), vec3f(1.0 / 2.2)), 1); }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let c = textureSample(t0, samp, i.uv); if (c.a < CUT) { discard; }
  let n = normalize(i.n);
  let d = max(dot(n, cam.sun.xyz), 0.0);
  let h = 0.5 + 0.5 * n.z;
  return finish(c.rgb * (mix(vec3f(0.22, 0.2, 0.2), vec3f(0.5, 0.55, 0.65), h) + vec3f(0.9, 0.82, 0.68) * d * cam.sun.w));
}`;
const SKIN_WGSL = /* wgsl */`
override CUT: f32 = -1.0;
struct Cam { vp: mat4x4f, eye: vec4f, sun: vec4f, fog: vec4f };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var t0: texture_2d<f32>;
struct B { m: array<mat3x4f, 128>, tint: vec4f, ch: array<vec4f, 6> };
@group(2) @binding(0) var<uniform> b: B;
struct V { @location(0) pos: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) w: vec3f, @location(4) idx: vec4u };
struct O { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) n: vec3f, @location(2) wp: vec3f };
fn xf(i: u32, p: vec4f) -> vec3f { return p * b.m[i]; }
@vertex fn vs(v: V) -> O {
  var o: O;
  let p4 = vec4f(v.pos, 1); let n4 = vec4f(v.n, 0);
  let wp = xf(v.idx.x, p4) * v.w.x + xf(v.idx.y, p4) * v.w.y + xf(v.idx.z, p4) * v.w.z;
  let wn = xf(v.idx.x, n4) * v.w.x + xf(v.idx.y, n4) * v.w.y + xf(v.idx.z, n4) * v.w.z;
  o.p = cam.vp * vec4f(wp, 1); o.uv = v.uv; o.n = wn; o.wp = wp; return o;
}
fn finish(c: vec3f) -> vec4f { let x = c * cam.fog.w; let m = x / (x + vec3f(0.85)) * 1.35; return vec4f(pow(clamp(m, vec3f(0), vec3f(1)), vec3f(1.0 / 2.2)), 1); }
@fragment fn fs(i: O) -> @location(0) vec4f {
  let c = textureSample(t0, samp, i.uv); if (c.a < CUT) { discard; }
  let n = normalize(i.n);
  let d = max(dot(n, cam.sun.xyz), 0.0);
  let h = 0.5 + 0.5 * n.z;
  let v = normalize(cam.eye.xyz - i.wp);
  let rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35;
  return finish(c.rgb * (mix(vec3f(0.3, 0.27, 0.27), vec3f(0.6, 0.65, 0.75), h) + vec3f(1.0, 0.92, 0.78) * d * cam.sun.w) + vec3f(rim) * b.tint.rgb + b.tint.rgb * b.tint.a);
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
  let view = normalize(cam.eye.xyz - i.wp) * select(-1.0, 1.0, ff);
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
  return vec4f(R * (b.ch[5].rgb - col) + col, R * (R - alpha) + alpha) * vec4f(amount, amount, amount, 1.0);
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
const SKY_WGSL = /* wgsl */`
struct O { @builtin(position) p: vec4f, @location(0) y: f32 };
@vertex fn vs(@builtin(vertex_index) i: u32) -> O { var o: O; let x = f32(i32(i & 1u) * 4 - 1); let y = f32(i32(i >> 1u) * 4 - 1); o.p = vec4f(x, y, 0.99999, 1); o.y = y; return o; }
@fragment fn fs(i: O) -> @location(0) vec4f { let t = clamp(i.y * 0.5 + 0.5, 0, 1); return vec4f(mix(vec3f(0.78, 0.8, 0.82), vec3f(0.42, 0.58, 0.8), t), 1); }`;

const toHalf = (() => {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return (v) => {
    f[0] = v; const x = u[0], s = (x >> 16) & 0x8000; let e = ((x >> 23) & 255) - 112; let m = x & 0x7fffff;
    if (e <= 0) return s; if (e >= 31) return s | 0x7c00; return s | (e << 10) | (m >> 13);
  };
})();

export class Renderer {
  constructor(canvas, device, format, fetchGame) {
    Object.assign(this, { canvas, device, format, fetchGame });
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.bc = device.features.has('texture-compression-bc');
    this.texCache = new Map();
    this.vmtCache = new Map();
    this.camBuf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
    this.lmSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.fxSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.fallback = this._solid([127, 127, 127, 255]);
    this.white = this._solid([255, 255, 255, 255]);
    this.meshes = new Map();
    this.propBatches = [];
    this.worldDraws = [];
    this.lines = [];
    this._pipelines();
    this.resize();
  }

  _solid(c) {
    const t = this.device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: t }, new Uint8Array(c), { bytesPerRow: 4 }, [1, 1]);
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
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.g0Obj = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.gMat2 = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.gMat1 = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }] });
    this.gBones = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const mod = (code) => d.createShaderModule({ code });
    const wm = mod(WORLD_WGSL);
    const both = (desc) => [d.createRenderPipeline(desc), d.createRenderPipeline({ ...desc, fragment: { ...desc.fragment, constants: { CUT: 0.5 } } })];
    [this.pWorld, this.pWorldCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0World, this.gMat2] }),
      vertex: { module: wm, entryPoint: 'vs', buffers: [{ arrayStride: 32, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }, { shaderLocation: 2, offset: 20, format: 'float32x2' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }] },
      fragment: { module: wm, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth,
    });
    const pm = mod(PROP_WGSL);
    [this.pProp, this.pPropCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gMat1] }),
      vertex: { module: pm, entryPoint: 'vs', buffers: [
        { arrayStride: 48, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }] },
        { arrayStride: 48, stepMode: 'instance', attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }, { shaderLocation: 4, offset: 16, format: 'float32x4' }, { shaderLocation: 5, offset: 32, format: 'float32x4' }] }] },
      fragment: { module: pm, entryPoint: 'fs', targets: target }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth,
    });
    const sm = mod(SKIN_WGSL);
    [this.pSkin, this.pSkinCut] = both({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gMat1, this.gBones] }),
      vertex: { module: sm, entryPoint: 'vs', buffers: [{ arrayStride: 48, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' }, { shaderLocation: 4, offset: 44, format: 'uint8x4' }] }] },
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
    this.bg0Obj = d.createBindGroup({ layout: this.g0Obj, entries: [{ binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.samp }] });
    // charge overlay: same vertices as the skinned pass, blended over it
    this.gCharge = d.createBindGroupLayout({ entries: [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })) });
    const cm = mod(CHARGE_WGSL);
    this.pCharge = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.g0Obj, this.gCharge, this.gBones] }),
      vertex: { module: cm, entryPoint: 'vs', buffers: [{ arrayStride: 48, attributes: [
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
      return { shader, p };
    })();
    this.vmtCache.set(key, pr);
    return pr;
  }

  static cutout(vm) {
    const on = (k) => vm?.p?.[k] !== undefined && vm.p[k] !== '0';
    return on('$alphatest') || on('$translucent') || on('$decal');
  }

  async _tex(name, pak) {
    const key = name.toLowerCase().replace(/\\/g, '/').replace(/\.vtf$/, '');
    if (this.texCache.has(key)) return this.texCache.get(key);
    const pr = (async () => {
      const buf = await this.fetchGame('materials/' + key + '.vtf', pak);
      if (!buf) return null;
      try { return this._upload(parseVTF(buf)); } catch (e) { console.warn('vtf', key, e.message); return null; }
    })();
    this.texCache.set(key, pr);
    return pr;
  }

  _upload(t) {
    if (window.duelDebug?.noTex) return this.white;
    const d = this.device;
    const bc = this.bc ? isBCFormat(t.fmt) : null;
    // BC textures need width/height multiples of 4 at the base
    const useBC = bc && t.w % 4 === 0 && t.h % 4 === 0;
    const levels = useBC ? t.levels.filter((l) => l.w >= 4 && l.h >= 4) : t.levels;
    const tex = d.createTexture({ size: [t.w, t.h], mipLevelCount: levels.length, format: useBC ? bc : 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    levels.forEach((l, i) => {
      if (useBC) {
        const blk = t.fmt === 15 || t.fmt === 14 ? 16 : 8;
        const bytes = t.buf.subarray(l.off, l.off + l.size);
        d.queue.writeTexture({ texture: tex, mipLevel: i }, bytes, { bytesPerRow: Math.ceil(l.w / 4) * blk }, [Math.ceil(l.w / 4) * 4, Math.ceil(l.h / 4) * 4]);
      } else {
        d.queue.writeTexture({ texture: tex, mipLevel: i }, decodeLevel(t, l), { bytesPerRow: l.w * 4 }, [l.w, l.h]);
      }
    });
    tex.sheet = t.sheet;
    return tex;
  }

  // ---------------------------------------------------------------- world
  async loadWorld(bsp, onProgress = () => {}) {
    const d = this.device;
    this.bsp = bsp;
    const pak = bsp;
    // lightmap atlas (shelf packer)
    const size = 4096;
    const rows = [];
    let cx = 0, cy = 0, rowH = 0;
    const place = (w, h) => {
      if (cx + w + 1 > size) { cy += rowH + 1; cx = 0; rowH = 0; }
      if (cy + h + 1 > size) return null;
      const r = [cx, cy]; cx += w + 1; rowH = Math.max(rowH, h); return r;
    };
    const atlas = new Uint16Array(size * size * 4);
    const bdv = bsp.dv, lightOff = bsp.light.off, lightLen = bsp.light.len;
    const placeFace = (f) => {
      if (f.lightofs < 0 || !lightLen) return null;
      const w = f.lmSize[0] + 1, h = f.lmSize[1] + 1;
      const at = place(w, h);
      if (!at) return null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = lightOff + f.lightofs + (y * w + x) * 4;
          const e = bdv.getInt8(o + 3), s = 2 ** e / 255;
          const di = ((at[1] + y) * size + at[0] + x) * 4;
          atlas[di] = toHalf(bdv.getUint8(o) * s); atlas[di + 1] = toHalf(bdv.getUint8(o + 1) * s); atlas[di + 2] = toHalf(bdv.getUint8(o + 2) * s); atlas[di + 3] = toHalf(1);
        }
      }
      return at;
    };
    // collect geometry per material
    const perTex = new Map();
    const push = (name) => { let g = perTex.get(name); if (!g) perTex.set(name, (g = [])); return g; };
    const transNames = new Set();
    const useFace = new Uint8Array(bsp.faces.length);
    // Brush entity geometry is stored around (0,0,0) and placed by the entity's origin.
    const faceOffset = new Map();
    const modelFaces = (m, origin) => { for (let i = 0; i < m.numfaces; i++) { useFace[m.firstface + i] = 1; if (origin) faceOffset.set(m.firstface + i, origin); } };
    modelFaces(bsp.models[0]);
    for (const e of bsp.entities) {
      if (e.model?.[0] === '*' && /func_(brush|wall|detail|illusionary|breakable)/.test(e.classname)) { const m = bsp.models[+e.model.slice(1)]; if (m) modelFaces(m, e.origin?.split(' ').map(Number)); }
    }
    const skip = SURF_NODRAW | SURF_SKY | SURF_SKY2D | SURF_TRIGGER | SURF_SKIP | SURF_HINT;
    bsp.faces.forEach((f, idx) => {
      if (!useFace[idx] || f.texinfo < 0) return;
      const ti = bsp.texinfo[f.texinfo];
      if (ti.flags & skip) return;
      const td = bsp.texdata[ti.texdata];
      if (/^tools\//i.test(td.name)) return;
      const at = placeFace(f);
      const lu = (p) => (at ? ((p[0] * ti.lv[0] + p[1] * ti.lv[1] + p[2] * ti.lv[2] + ti.lv[3] - f.lmMins[0] + 0.5) + at[0]) / size : 0.5 / size);
      const lv = (p) => (at ? ((p[0] * ti.lv[4] + p[1] * ti.lv[5] + p[2] * ti.lv[6] + ti.lv[7] - f.lmMins[1] + 0.5) + at[1]) / size : 0.5 / size);
      const su = (p) => (p[0] * ti.tv[0] + p[1] * ti.tv[1] + p[2] * ti.tv[2] + ti.tv[3]) / (td.w || 1);
      const sv = (p) => (p[0] * ti.tv[4] + p[1] * ti.tv[5] + p[2] * ti.tv[6] + ti.tv[7]) / (td.h || 1);
      if (ti.flags & SURF_TRANS) transNames.add(td.name);
      const out = push(td.name);
      if (f.disp >= 0) {
        const di = bsp.dispinfo[f.disp];
        const g = bsp.dispGrid(di);
        if (!g) return;
        const { size: n, pos, base, alpha } = g;
        const vert = (i) => {
          const b = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
          out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], su(b), sv(b), lu(b), lv(b), alpha[i] / 255);
        };
        for (let y = 0; y < n - 1; y++) {
          for (let x = 0; x < n - 1; x++) {
            const a = y * n + x, b = a + 1, c = a + n, e = c + 1;
            if ((x + y) % 2 === 0) { vert(a); vert(e); vert(c); vert(a); vert(b); vert(e); } else { vert(a); vert(b); vert(c); vert(b); vert(e); vert(c); }
          }
        }
      } else {
        const vs = bsp.faceVerts(f), off = faceOffset.get(idx) || [0, 0, 0];
        for (let i = 1; i < vs.length - 1; i++) {
          for (const p of [vs[0], vs[i], vs[i + 1]]) out.push(p[0] + off[0], p[1] + off[1], p[2] + off[2], su(p), sv(p), lu(p), lv(p), 0);
        }
      }
    });
    const lmTex = d.createTexture({ size: [size, size], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: lmTex }, atlas, { bytesPerRow: size * 8 }, [size, size]);
    this.bg0World = d.createBindGroup({ layout: this.g0World, entries: [
      { binding: 0, resource: { buffer: this.camBuf } }, { binding: 1, resource: this.samp }, { binding: 2, resource: lmTex.createView() }, { binding: 3, resource: this.lmSamp }] });
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
      draws.push({ name: n, first: at / 8, count: arr.length / 8 });
      at += arr.length;
    }
    this.worldVB = d.createBuffer({ size: all.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.worldVB, 0, all);
    this.worldVerts = at / 8;
    let done = 0;
    await Promise.all(draws.map(async (dr) => {
      const m = await this._vmt(dr.name, pak);
      const b0 = m?.p?.$basetexture ? await this._tex(m.p.$basetexture, pak) : await this._tex(dr.name, pak);
      const b1 = m?.p?.$basetexture2 ? await this._tex(m.p.$basetexture2, pak) : null;
      dr.ok = !!b0;
      dr.cut = Renderer.cutout(m) || transNames.has(dr.name);
      const t0 = b0 || this.fallback;
      dr.bg = d.createBindGroup({ layout: this.gMat2, entries: [{ binding: 0, resource: t0.createView() }, { binding: 1, resource: (b1 || t0).createView() }] });
      onProgress(`textures ${++done}/${draws.length}`);
    }));
    this.worldDraws = draws;
    this.stats = { textures: draws.length, missing: draws.filter((x) => !x.ok).map((x) => x.name), verts: this.worldVerts, lmHeight: cy + rowH };
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

  async _meshFor(path, pak) {
    const key = path.toLowerCase();
    if (this.meshes.has(key)) return this.meshes.get(key);
    const pr = (async () => {
      const base = path.replace(/\.mdl$/i, '');
      const [m, vvd, vtx] = await Promise.all([this.fetchGame(base + '.mdl', pak), this.fetchGame(base + '.vvd', pak), this.fetchGame(base + '.dx90.vtx', pak)]);
      if (!m || !vvd || !vtx) return null;
      const model = new Model(m, path);
      const mesh = buildMesh(model, vvd, vtx);
      const nv = mesh.positions.length / 3;
      if (!nv) return null;
      // static layout: pos,n,uv / skinned layout: pos,n,uv,w,idx
      const buf = new ArrayBuffer(nv * 48);
      const f = new Float32Array(buf), u8 = new Uint8Array(buf);
      for (let i = 0; i < nv; i++) {
        const o = i * 12;
        f[o] = mesh.positions[i * 3]; f[o + 1] = mesh.positions[i * 3 + 1]; f[o + 2] = mesh.positions[i * 3 + 2];
        f[o + 3] = mesh.normals[i * 3]; f[o + 4] = mesh.normals[i * 3 + 1]; f[o + 5] = mesh.normals[i * 3 + 2];
        f[o + 6] = mesh.uvs[i * 2]; f[o + 7] = mesh.uvs[i * 2 + 1];
        f[o + 8] = mesh.boneW[i * 3]; f[o + 9] = mesh.boneW[i * 3 + 1]; f[o + 10] = mesh.boneW[i * 3 + 2];
        u8[i * 48 + 44] = mesh.boneIdx[i * 3]; u8[i * 48 + 45] = mesh.boneIdx[i * 3 + 1]; u8[i * 48 + 46] = mesh.boneIdx[i * 3 + 2];
      }
      const vb = this.device.createBuffer({ size: buf.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(vb, 0, buf);
      const ib = this.device.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(ib, 0, mesh.indices);
      const subs = [];
      let chargeParams = null;
      for (const s of mesh.meshes) {
        let tex = null, cut = false, chargeBg = null;
        for (const dir of model.cdtextures) {
          const nm = (dir + s.material).replace(/\\/g, '/');
          const vm = await this._vmt(nm, pak);
          if (vm) {
            tex = vm.p.$basetexture ? await this._tex(vm.p.$basetexture, pak) : await this._tex(nm, pak);
            cut = Renderer.cutout(vm);
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
        subs.push({ start: s.start, count: s.count, bg: this.device.createBindGroup({ layout: this.gMat1, entries: [{ binding: 0, resource: t.createView() }] }), ok: !!tex, material: s.material, cut, chargeBg });
      }
      return { vb, ib, subs, model, chargeParams };
    })().catch((e) => { console.warn('mesh', path, e.message); return null; });
    this.meshes.set(key, pr);
    return pr;
  }

  async _loadProps(bsp, onProgress) {
    const { names, props } = bsp.staticProps();
    if (!props?.length) return;
    const by = new Map();
    for (const p of props) { let l = by.get(p.model); if (!l) by.set(p.model, (l = [])); l.push(p); }
    let done = 0;
    const entries = [...by.entries()];
    await Promise.all(entries.map(async ([mi, list]) => {
      const mesh = await this._meshFor(names[mi], bsp);
      onProgress(`props ${++done}/${entries.length}`);
      if (!mesh) return;
      const inst = new Float32Array(list.length * 12);
      list.forEach((p, i) => inst.set(propMatrix(p.origin, p.angles), i * 12));
      const ib = this.device.createBuffer({ size: inst.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(ib, 0, inst);
      this.propBatches.push({ mesh, inst: ib, count: list.length, name: names[mi], first: list[0] });
    }));
  }

  // Skinned character instance
  async loadCharacter(key, mdlPath, char) {
    const mesh = await this._meshFor(mdlPath, null);
    if (!mesh) throw new Error('character mesh missing: ' + mdlPath);
    return { key, mesh, char };
  }

  newBoneBuffer() {
    const buf = this.device.createBuffer({ size: 128 * 48 + 16 + 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { buf, bg: this.device.createBindGroup({ layout: this.gBones, entries: [{ binding: 0, resource: { buffer: buf } }] }), data: new Float32Array(128 * 12 + 4 + 24) };
  }

  // ---------------------------------------------------------------- frame
  frame(view) {
    this.resize();
    const d = this.device;
    const cam = new Float32Array(28);
    cam.set(view.vp, 0); cam.set([...view.eye, 1], 16); cam.set([...(this.sun || [0.3, 0.3, 0.9]), 1], 20); cam.set([0, 0, 0, view.exposure ?? 1.4], 24);
    d.queue.writeBuffer(this.camBuf, 0, cam);
    const enc = d.createCommandEncoder();
    const colorTex = this.ctx.getCurrentTexture();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: colorTex.createView(), clearValue: { r: 0.5, g: 0.6, b: 0.75, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    if (this.bg0World && !this.hideWorld) {
      pass.setPipeline(this.pWorld);
      pass.setBindGroup(0, this.bg0World);
      pass.setVertexBuffer(0, this.worldVB);
      for (const dr of this.worldDraws) { pass.setPipeline(dr.cut ? this.pWorldCut : this.pWorld); pass.setBindGroup(1, dr.bg); pass.draw(dr.count, 1, dr.first, 0); }
    }
    pass.setPipeline(this.pProp);
    pass.setBindGroup(0, this.bg0Obj);
    for (const b of this.hideProps ? [] : (this.onlyProp !== undefined ? this.propBatches.filter((x, i) => i === this.onlyProp) : this.propBatches)) {
      pass.setVertexBuffer(0, b.mesh.vb);
      pass.setVertexBuffer(1, b.inst);
      pass.setIndexBuffer(b.mesh.ib, 'uint32');
      for (const s of b.mesh.subs) { pass.setPipeline(s.cut ? this.pPropCut : this.pProp); pass.setBindGroup(1, s.bg); pass.drawIndexed(s.count, b.count, s.start, 0, 0); }
    }
    pass.setPipeline(this.pSkin);
    pass.setBindGroup(0, this.bg0Obj);
    for (const c of view.characters) {
      d.queue.writeBuffer(c.bones.buf, 0, c.bones.data);
      pass.setBindGroup(2, c.bones.bg);
      pass.setVertexBuffer(0, c.mesh.vb);
      pass.setIndexBuffer(c.mesh.ib, 'uint32');
      for (const s of c.mesh.subs) { pass.setPipeline(s.cut ? this.pSkinCut : this.pSkin); pass.setBindGroup(1, s.bg); pass.drawIndexed(s.count, 1, s.start, 0, 0); }
      if (c.charge > 0.001) {
        pass.setPipeline(this.pCharge);
        for (const s of c.mesh.subs) if (s.chargeBg) { pass.setBindGroup(1, s.chargeBg); pass.drawIndexed(s.count, 1, s.start, 0, 0); }
      }
    }
    pass.setPipeline(this.pSky);
    pass.draw(3);
    if (view.tris?.length) {
      const arr = new Float32Array(view.tris);
      d.queue.writeBuffer(this.triBuf, 0, arr, 0, Math.min(arr.length, this.triBuf.size / 4));
      pass.setPipeline(this.pTri);
      pass.setBindGroup(0, this.triBG);
      pass.setVertexBuffer(0, this.triBuf);
      pass.draw(Math.min(arr.length / 7, this.triBuf.size / 28));
    }
    pass.end();
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
    d.queue.submit([enc.finish()]);
  }
}

function propMatrix(o, a) {
  const D = Math.PI / 180;
  const sy = Math.sin(a[1] * D), cy = Math.cos(a[1] * D), sp = Math.sin(a[0] * D), cp = Math.cos(a[0] * D), sr = Math.sin(a[2] * D), cr = Math.cos(a[2] * D);
  return [cp * cy, sp * sr * cy - cr * sy, sp * cr * cy + sr * sy, o[0], cp * sy, sp * sr * sy + cr * cy, sp * cr * sy - sr * cy, o[1], -sp, sr * cp, cr * cp, o[2]];
}
void matMul; void quatMatrix;
