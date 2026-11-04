// VTF 7.x reader. Returns the top usable mip chain as RGBA8 (CPU decode) or raw BC blocks.
const FMT = { RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, A8: 8, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, BGR565: 17, BGRA4444: 19, DXT1A: 20, UV88: 22, RGBA16F: 24 };
const bpp = { 0: 4, 1: 4, 2: 3, 3: 3, 4: 2, 5: 1, 6: 2, 8: 1, 11: 4, 12: 4, 16: 4, 17: 2, 19: 2, 22: 2, 24: 8 };
const isDXT = (f) => f === 13 || f === 14 || f === 15 || f === 20;
const mipBytes = (f, w, h) => (isDXT(f) ? Math.ceil(w / 4) * Math.ceil(h / 4) * (f === 13 || f === 20 ? 8 : 16) : w * h * (bpp[f] ?? 4));
/**
 * Reads a Valve texture's header and finds its mip levels.
 * @param {Uint8Array} buf .vtf contents.
 * @param {number} [maxSize] Largest mip size wanted.
 * @returns {object} The texture, with its format, data and levels.
 */
export function parseVTF(buf, maxSize = 1024) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x00465456) throw new Error('not a VTF');
  const minor = dv.getInt32(8, true), hdr = dv.getInt32(12, true);
  const w = dv.getUint16(16, true), h = dv.getUint16(18, true), flags = dv.getUint32(20, true);
  const frames = dv.getUint16(24, true);
  const fmt = dv.getInt32(52, true), mips = dv.getUint8(56), lowFmt = dv.getInt32(57, true), lowW = dv.getUint8(61), lowH = dv.getUint8(62);
  const depth = minor >= 2 ? dv.getUint16(63, true) : 1;
  let data = -1, sheetOff = -1;
  if (minor >= 3) {
    const nres = dv.getUint32(68, true);
    for (let i = 0; i < nres; i++) {
      const o = 80 + i * 8;
      const tag = dv.getUint32(o, true) & 0xffffff;
      if (tag === 0x000030) data = dv.getUint32(o + 4, true);
      else if (tag === 0x000010) sheetOff = dv.getUint32(o + 4, true);
    }
  }
  if (data < 0) data = hdr + (lowFmt >= 0 && lowFmt !== 0xffffffff && lowW ? mipBytes(lowFmt, lowW, lowH) : 0);
  const faces = flags & 0x4000 ? (minor >= 5 ? 6 : 7) : 1;
  const slices = Math.max(1, depth);
  // offsets: smallest mip first in the file
  const levels = [];
  let off = data;
  for (let m = mips - 1; m >= 0; m--) {
    const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m);
    const sz = mipBytes(fmt, mw, mh);
    levels[m] = { w: mw, h: mh, off, size: sz };
    off += sz * frames * faces * slices;
  }
  let start = 0;
  while (start < mips - 1 && (levels[start].w > maxSize || levels[start].h > maxSize)) start++;
  return { w: levels[start].w, h: levels[start].h, fmt, levels: levels.slice(start).filter((l) => l), buf, translucent: (flags & 0x3000) !== 0, flags, faces, sheet: sheetOff >= 0 ? parseSheet(dv, sheetOff) : null };
}
// Sprite sheet resource: sequences of timed frames, each a UV rectangle (version 1 stores 4 per frame)
function parseSheet(dv, off) {
  try {
    let o = off + 4; // resource size prefix
    const version = dv.getInt32(o, true); const count = dv.getInt32(o + 4, true); o += 8;
    const perFrame = version ? 4 : 1, seqs = [];
    for (let i = 0; i < count; i++) {
      const id = dv.getInt32(o, true), clamp = dv.getInt32(o + 4, true) !== 0, n = dv.getInt32(o + 8, true), total = dv.getFloat32(o + 12, true);
      o += 16;
      const frames = [];
      for (let f = 0; f < n; f++) {
        const d = dv.getFloat32(o, true);
        const uv = [dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true)];
        o += 4 + perFrame * 16;
        frames.push({ d, uv });
      }
      seqs[id] = { clamp, total: total || frames.reduce((a, x) => a + x.d, 0) || 1, frames };
    }
    return seqs;
  } catch { return null; }
}
const rgb565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
/**
 * Software DXT decoding, to plain RGBA.
 * @param {Uint8Array} src Texture bytes.
 * @param {number} off Where the level starts.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} kind 1, 3 or 5.
 * @returns {Uint8Array} RGBA.
 */
function decodeDXT(src, off, w, h, kind) {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), step = kind === 1 ? 8 : 16;
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const b = off + (by * bw + bx) * step;
      const cb = kind === 1 ? b : b + 8;
      const c0 = dv.getUint16(cb, true), c1 = dv.getUint16(cb + 2, true);
      const p0 = rgb565(c0), p1 = rgb565(c1);
      const pal = [p0, p1];
      if (c0 > c1 || kind !== 1) { pal[2] = p0.map((v, i) => (2 * v + p1[i]) / 3); pal[3] = p0.map((v, i) => (v + 2 * p1[i]) / 3); } else { pal[2] = p0.map((v, i) => (v + p1[i]) / 2); pal[3] = [0, 0, 0, 0]; }
      const bits = dv.getUint32(cb + 4, true);
      let al = null;
      if (kind === 5) {
        const a0 = src[b], a1 = src[b + 1];
        al = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) al[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        else { for (let i = 1; i < 5; i++) al[i + 1] = ((5 - i) * a0 + i * a1) / 5; al[6] = 0; al[7] = 255; }
      }
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x, py = by * 4 + y;
          if (px >= w || py >= h) continue;
          const i = (py * w + px) * 4, ci = (bits >>> (2 * (y * 4 + x))) & 3;
          const col = pal[ci];
          out[i] = col[0]; out[i + 1] = col[1]; out[i + 2] = col[2];
          let a = 255;
          if (kind === 1 && c0 <= c1 && ci === 3) a = 0;
          if (kind === 3) a = ((src[b + (y * 4 + x >> 1)] >> ((y * 4 + x & 1) * 4)) & 15) * 17;
          if (kind === 5) {
            const n = y * 4 + x, bit = n * 3, byte = b + 2 + (bit >> 3), sh = bit & 7;
            const idx = ((src[byte] | ((src[byte + 1] || 0) << 8)) >> sh) & 7;
            a = al[idx];
          }
          out[i + 3] = a;
        }
      }
    }
  }
  return out;
}
/**
 * @param {object} t From parseVTF.
 * @param {object} l One of its levels.
 * @returns {Uint8Array} The level as RGBA.
 */
export function decodeLevel(t, l) {
  const { fmt, buf } = t, { w, h, off } = l;
  if (fmt === 13 || fmt === 20) return decodeDXT(buf, off, w, h, 1);
  if (fmt === 14) return decodeDXT(buf, off, w, h, 3);
  if (fmt === 15) return decodeDXT(buf, off, w, h, 5);
  const out = new Uint8Array(w * h * 4);
  const n = w * h, s = buf, o = off;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    switch (fmt) {
      case 0: out[d] = s[o + i * 4]; out[d + 1] = s[o + i * 4 + 1]; out[d + 2] = s[o + i * 4 + 2]; out[d + 3] = s[o + i * 4 + 3]; break;
      case 1: out[d] = s[o + i * 4 + 3]; out[d + 1] = s[o + i * 4 + 2]; out[d + 2] = s[o + i * 4 + 1]; out[d + 3] = s[o + i * 4]; break;
      case 2: out[d] = s[o + i * 3]; out[d + 1] = s[o + i * 3 + 1]; out[d + 2] = s[o + i * 3 + 2]; out[d + 3] = 255; break;
      case 3: out[d] = s[o + i * 3 + 2]; out[d + 1] = s[o + i * 3 + 1]; out[d + 2] = s[o + i * 3]; out[d + 3] = 255; break;
      case 11: out[d] = s[o + i * 4 + 1]; out[d + 1] = s[o + i * 4 + 2]; out[d + 2] = s[o + i * 4 + 3]; out[d + 3] = s[o + i * 4]; break;
      case 12: case 16: out[d] = s[o + i * 4 + 2]; out[d + 1] = s[o + i * 4 + 1]; out[d + 2] = s[o + i * 4]; out[d + 3] = fmt === 16 ? 255 : s[o + i * 4 + 3]; break;
      case 4: { const c = rgb565(dv.getUint16(o + i * 2, true)); out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = 255; break; }
      case 17: { const c = rgb565(dv.getUint16(o + i * 2, true)); out[d] = c[2]; out[d + 1] = c[1]; out[d + 2] = c[0]; out[d + 3] = 255; break; }
      case 19: { const c = dv.getUint16(o + i * 2, true); out[d] = ((c >> 8) & 15) * 17; out[d + 1] = ((c >> 4) & 15) * 17; out[d + 2] = (c & 15) * 17; out[d + 3] = ((c >> 12) & 15) * 17; break; }
      case 5: out[d] = out[d + 1] = out[d + 2] = s[o + i]; out[d + 3] = 255; break;
      case 8: out[d] = out[d + 1] = out[d + 2] = 0; out[d + 3] = s[o + i]; break;
      case 6: out[d] = out[d + 1] = out[d + 2] = s[o + i * 2]; out[d + 3] = s[o + i * 2 + 1]; break;
      case 22: out[d] = s[o + i * 2]; out[d + 1] = s[o + i * 2 + 1]; out[d + 2] = 255; out[d + 3] = 255; break;
      case 24: { const fl = (k) => { const u = dv.getUint16(o + i * 8 + k * 2, true), e = (u >> 10) & 31, m = u & 1023; const v = e === 0 ? m * 2 ** -24 : (m + 1024) * 2 ** (e - 25); return Math.min(255, Math.sqrt(v) * 255); }; out[d] = fl(0); out[d + 1] = fl(1); out[d + 2] = fl(2); out[d + 3] = 255; break; }
      default: out[d] = 200; out[d + 1] = 0; out[d + 2] = 200; out[d + 3] = 255;
    }
  }
  return out;
}
export const isBCFormat = (fmt) => (fmt === 13 || fmt === 20 ? 'bc1-rgba-unorm-srgb' : fmt === 14 ? 'bc2-rgba-unorm-srgb' : fmt === 15 ? 'bc3-rgba-unorm-srgb' : null);
