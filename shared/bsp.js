// VBSP v21 parser and CM-style box tracing (world brushes + displacements).
import { parseKV } from './kv.js';

export const CONTENTS_SOLID = 1, CONTENTS_WINDOW = 2, CONTENTS_GRATE = 8, CONTENTS_MOVEABLE = 0x4000,
  CONTENTS_PLAYERCLIP = 0x10000, CONTENTS_MONSTER = 0x2000000;
export const MASK_PLAYERSOLID = CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_GRATE | CONTENTS_MOVEABLE | CONTENTS_PLAYERCLIP | CONTENTS_MONSTER;
export const SURF_TRANS = 0x10, SURF_NODRAW = 0x80, SURF_SKY = 0x4, SURF_SKY2D = 0x2, SURF_TRIGGER = 0x40, SURF_SKIP = 0x200, SURF_HINT = 0x100, SURF_WARP = 0x8;
const DIST_EPSILON = 0.03125;

const dec = new TextDecoder('latin1');
export function cstr(u8, off) {
  let e = off;
  while (e < u8.length && u8[e]) e++;
  return dec.decode(u8.subarray(off, e));
}

export class BSP {
  constructor(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.dv.getUint32(0, true) !== 0x50534256) throw new Error('not a VBSP');
    this.version = this.dv.getInt32(4, true);
    this._load();
  }

  lump(i) {
    return { off: this.dv.getInt32(8 + i * 16, true), len: this.dv.getInt32(12 + i * 16, true) };
  }

  _load() {
    const { dv } = this;
    const L = (i) => this.lump(i);
    // entities
    const e = L(0);
    const entText = dec.decode(this.bytes.subarray(e.off, e.off + e.len));
    this.entities = [];
    for (const m of entText.matchAll(/\{([^{}]*)\}/g)) {
      const ent = {};
      for (const kv of parseKV(m[1])) if (!(kv.key in ent)) ent[kv.key] = kv.value;
      this.entities.push(ent);
    }
    // planes
    let l = L(1);
    const np = l.len / 20;
    this.planeN = new Float32Array(np * 3);
    this.planeD = new Float32Array(np);
    this.planeT = new Int32Array(np);
    for (let i = 0; i < np; i++) {
      const o = l.off + i * 20;
      this.planeN[i * 3] = dv.getFloat32(o, true);
      this.planeN[i * 3 + 1] = dv.getFloat32(o + 4, true);
      this.planeN[i * 3 + 2] = dv.getFloat32(o + 8, true);
      this.planeD[i] = dv.getFloat32(o + 12, true);
      this.planeT[i] = dv.getInt32(o + 16, true);
    }
    // nodes
    l = L(5);
    const nn = l.len / 32;
    this.nodePlane = new Int32Array(nn);
    this.nodeC0 = new Int32Array(nn);
    this.nodeC1 = new Int32Array(nn);
    for (let i = 0; i < nn; i++) {
      const o = l.off + i * 32;
      this.nodePlane[i] = dv.getInt32(o, true);
      this.nodeC0[i] = dv.getInt32(o + 4, true);
      this.nodeC1[i] = dv.getInt32(o + 8, true);
    }
    // leafs (lump version 1 = 32 bytes, version 0 = 56)
    l = L(10);
    const leafVer = dv.getInt32(8 + 10 * 16 + 8, true);
    const leafSz = leafVer === 0 ? 56 : 32;
    const nl = l.len / leafSz;
    this.leafFirstBrush = new Int32Array(nl);
    this.leafNumBrush = new Int32Array(nl);
    this.leafCluster = new Int32Array(nl);
    for (let i = 0; i < nl; i++) {
      const o = l.off + i * leafSz;
      this.leafCluster[i] = dv.getInt16(o + 4, true);
      this.leafFirstBrush[i] = dv.getUint16(o + 24, true);
      this.leafNumBrush[i] = dv.getUint16(o + 26, true);
    }
    l = L(17);
    this.leafBrushes = new Uint16Array(l.len / 2);
    for (let i = 0; i < this.leafBrushes.length; i++) this.leafBrushes[i] = dv.getUint16(l.off + i * 2, true);
    // brushes
    l = L(18);
    const nb = l.len / 12;
    this.brushFirst = new Int32Array(nb);
    this.brushNum = new Int32Array(nb);
    this.brushContents = new Int32Array(nb);
    for (let i = 0; i < nb; i++) {
      const o = l.off + i * 12;
      this.brushFirst[i] = dv.getInt32(o, true);
      this.brushNum[i] = dv.getInt32(o + 4, true);
      this.brushContents[i] = dv.getInt32(o + 8, true);
    }
    l = L(19);
    const ns = l.len / 8;
    this.sidePlane = new Uint16Array(ns);
    this.sideBevel = new Uint8Array(ns);
    this.sideTexinfo = new Int16Array(ns);
    for (let i = 0; i < ns; i++) {
      const o = l.off + i * 8;
      this.sidePlane[i] = dv.getUint16(o, true);
      this.sideTexinfo[i] = dv.getInt16(o + 2, true);
      this.sideBevel[i] = dv.getUint8(o + 6);
    }
    this.brushStamp = new Uint32Array(nb);
    this.stamp = 0;
    // models
    l = L(14);
    this.models = [];
    for (let i = 0; i < l.len / 48; i++) {
      const o = l.off + i * 48;
      const f = (k) => dv.getFloat32(o + k, true);
      this.models.push({
        mins: [f(0), f(4), f(8)], maxs: [f(12), f(16), f(20)], origin: [f(24), f(28), f(32)],
        headnode: dv.getInt32(o + 36, true), firstface: dv.getInt32(o + 40, true), numfaces: dv.getInt32(o + 44, true),
      });
    }
    this._loadGeometry();
    this._buildDispCollision();
  }

  _loadGeometry() {
    const { dv } = this;
    let l = this.lump(3);
    this.verts = new Float32Array(l.len / 4);
    for (let i = 0; i < this.verts.length; i++) this.verts[i] = dv.getFloat32(l.off + i * 4, true);
    l = this.lump(12);
    this.edges = new Uint16Array(l.len / 2);
    for (let i = 0; i < this.edges.length; i++) this.edges[i] = dv.getUint16(l.off + i * 2, true);
    l = this.lump(13);
    this.surfedges = new Int32Array(l.len / 4);
    for (let i = 0; i < this.surfedges.length; i++) this.surfedges[i] = dv.getInt32(l.off + i * 4, true);
    // texinfo
    l = this.lump(6);
    this.texinfo = [];
    for (let i = 0; i < l.len / 72; i++) {
      const o = l.off + i * 72;
      const fs = (b, n) => { const a = []; for (let k = 0; k < n; k++) a.push(dv.getFloat32(o + b + k * 4, true)); return a; };
      this.texinfo.push({ tv: fs(0, 8), lv: fs(32, 8), flags: dv.getInt32(o + 64, true), texdata: dv.getInt32(o + 68, true) });
    }
    // texdata + names
    const ss = this.lump(43), st = this.lump(44);
    l = this.lump(2);
    this.texdata = [];
    for (let i = 0; i < l.len / 32; i++) {
      const o = l.off + i * 32;
      const sid = dv.getInt32(o + 12, true);
      this.texdata.push({
        reflectivity: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
        name: cstr(this.bytes, ss.off + dv.getInt32(st.off + sid * 4, true)),
        w: dv.getInt32(o + 16, true), h: dv.getInt32(o + 20, true),
      });
    }
    // faces: prefer HDR faces when the map has HDR lighting
    const hdr = this.lump(53).len > 0 && this.lump(58).len > 0;
    this.lightingHDR = hdr;
    this.light = hdr ? this.lump(53) : this.lump(8);
    l = hdr ? this.lump(58) : this.lump(7);
    this.faces = [];
    for (let i = 0; i < l.len / 56; i++) {
      const o = l.off + i * 56;
      this.faces.push({
        plane: dv.getUint16(o, true), side: dv.getUint8(o + 2),
        firstedge: dv.getInt32(o + 4, true), numedges: dv.getInt16(o + 8, true),
        texinfo: dv.getInt16(o + 10, true), disp: dv.getInt16(o + 12, true),
        styles: [dv.getUint8(o + 16), dv.getUint8(o + 17), dv.getUint8(o + 18), dv.getUint8(o + 19)],
        lightofs: dv.getInt32(o + 20, true),
        lmMins: [dv.getInt32(o + 28, true), dv.getInt32(o + 32, true)],
        lmSize: [dv.getInt32(o + 36, true), dv.getInt32(o + 40, true)],
      });
    }
    // displacements
    l = this.lump(26);
    this.dispinfo = [];
    for (let i = 0; i < l.len / 176; i++) {
      const o = l.off + i * 176;
      this.dispinfo.push({
        start: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
        vertStart: dv.getInt32(o + 12, true), power: dv.getInt32(o + 20, true),
        contents: dv.getInt32(o + 32, true), mapFace: dv.getUint16(o + 36, true),
      });
    }
    l = this.lump(33);
    this.dispVertsOff = l.off;
  }

  faceVerts(face) {
    const out = [];
    for (let i = 0; i < face.numedges; i++) {
      const se = this.surfedges[face.firstedge + i];
      const v = se >= 0 ? this.edges[se * 2] : this.edges[-se * 2 + 1];
      out.push([this.verts[v * 3], this.verts[v * 3 + 1], this.verts[v * 3 + 2]]);
    }
    return out;
  }

  // Builds the (2^p+1)^2 grid of a displacement. Returns {size, pos[], uvCorner info}.
  dispGrid(di) {
    const face = this.faces[di.mapFace];
    const corners = this.faceVerts(face);
    if (corners.length !== 4) return null;
    // rotate corners so corners[0] is closest to the start position
    let best = 0, bd = Infinity;
    for (let i = 0; i < 4; i++) {
      const d = (corners[i][0] - di.start[0]) ** 2 + (corners[i][1] - di.start[1]) ** 2 + (corners[i][2] - di.start[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const c = [0, 1, 2, 3].map((i) => corners[(best + i) % 4]);
    const size = (1 << di.power) + 1;
    const pos = new Float32Array(size * size * 3);
    const alpha = new Float32Array(size * size);
    const base = new Float32Array(size * size * 3);
    const { dv } = this;
    for (let y = 0; y < size; y++) {
      const ty = y / (size - 1);
      const lx = [c[0][0] + (c[1][0] - c[0][0]) * ty, c[0][1] + (c[1][1] - c[0][1]) * ty, c[0][2] + (c[1][2] - c[0][2]) * ty];
      const rx = [c[3][0] + (c[2][0] - c[3][0]) * ty, c[3][1] + (c[2][1] - c[3][1]) * ty, c[3][2] + (c[2][2] - c[3][2]) * ty];
      for (let x = 0; x < size; x++) {
        const tx = x / (size - 1);
        const idx = y * size + x;
        const bx = lx[0] + (rx[0] - lx[0]) * tx, by = lx[1] + (rx[1] - lx[1]) * tx, bz = lx[2] + (rx[2] - lx[2]) * tx;
        const o = this.dispVertsOff + (di.vertStart + idx) * 20;
        const dist = dv.getFloat32(o + 12, true);
        pos[idx * 3] = bx + dv.getFloat32(o, true) * dist;
        pos[idx * 3 + 1] = by + dv.getFloat32(o + 4, true) * dist;
        pos[idx * 3 + 2] = bz + dv.getFloat32(o + 8, true) * dist;
        base[idx * 3] = bx; base[idx * 3 + 1] = by; base[idx * 3 + 2] = bz;
        alpha[idx] = dv.getFloat32(o + 16, true);
      }
    }
    return { size, pos, base, alpha };
  }

  _buildDispCollision() {
    // Each displacement triangle becomes a small convex prism; a coarse grid accelerates lookups.
    this.dispTris = [];
    for (const di of this.dispinfo) {
      if (this.faces[di.mapFace].numedges !== 4) continue;
      const g = this.dispGrid(di);
      if (!g) continue;
      const { size, pos } = g;
      const fp = this.faces[di.mapFace].plane;
      const fsign = this.faces[di.mapFace].side ? -1 : 1;
      const fn = [this.planeN[fp * 3] * fsign, this.planeN[fp * 3 + 1] * fsign, this.planeN[fp * 3 + 2] * fsign];
      this._dispTexinfo = this.faces[di.mapFace].texinfo;
      const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const a = y * size + x, b = a + 1, c = a + size, d = c + 1;
          // Source alternates the triangle diagonal per quad.
          const tris = (x + y) % 2 === 0 ? [[a, d, c], [a, b, d]] : [[a, b, c], [b, d, c]];
          for (const t of tris) this._addTri(P(t[0]), P(t[1]), P(t[2]), fn);
        }
      }
    }
    this.dispCell = 128;
    this.dispHash = new Map();
    this.dispTris.forEach((t, idx) => {
      const c = this.dispCell;
      for (let x = Math.floor(t.mins[0] / c); x <= Math.floor(t.maxs[0] / c); x++) {
        for (let y = Math.floor(t.mins[1] / c); y <= Math.floor(t.maxs[1] / c); y++) {
          const k = x * 73856093 ^ y * 19349663;
          let l = this.dispHash.get(k);
          if (!l) this.dispHash.set(k, (l = []));
          l.push(idx);
        }
      }
    });
    this.dispStamp = new Uint32Array(this.dispTris.length);
  }

  _addTri(a, b, c, fn) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-5) return;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (n[0] * fn[0] + n[1] * fn[1] + n[2] * fn[2] < 0) { n = [-n[0], -n[1], -n[2]]; const t = b; b = c; c = t; }
    const planes = [{ n, d: n[0] * a[0] + n[1] * a[1] + n[2] * a[2] }];
    planes.push({ n: [-n[0], -n[1], -n[2]], d: -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) + 2 });
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = pts[i], q = pts[(i + 1) % 3];
      const e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      let s = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
      const sl = Math.hypot(s[0], s[1], s[2]);
      if (sl < 1e-5) continue;
      s = [s[0] / sl, s[1] / sl, s[2] / sl];
      planes.push({ n: s, d: s[0] * p[0] + s[1] * p[1] + s[2] * p[2] });
    }
    const mins = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
    const maxs = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
    // Axial bevels: without them, expanding the slanted planes by a box's extents reaches far past
    // the prism at its sharp edges and produces invisible walls. The prism's far side adds 2 units.
    for (let k = 0; k < 3; k++) {
      const pos = [0, 0, 0], neg = [0, 0, 0];
      pos[k] = 1; neg[k] = -1;
      const back = n[k] * 2;
      planes.push({ n: pos, d: maxs[k] + Math.max(0, -back) });
      planes.push({ n: neg, d: -mins[k] + Math.max(0, back) });
    }
    this.dispTris.push({ planes, mins, maxs, texinfo: this._dispTexinfo });
  }

  // ---------------------------------------------------------------- tracing
  // Sweep an AABB (mins/maxs relative to the swept point). Returns Source-like trace_t.
  traceBox(start, end, mins, maxs, mask = MASK_PLAYERSOLID) {
    const ext = [(maxs[0] - mins[0]) * 0.5, (maxs[1] - mins[1]) * 0.5, (maxs[2] - mins[2]) * 0.5];
    const off = [(maxs[0] + mins[0]) * 0.5, (maxs[1] + mins[1]) * 0.5, (maxs[2] + mins[2]) * 0.5];
    const t = {
      s: [start[0] + off[0], start[1] + off[1], start[2] + off[2]],
      e: [end[0] + off[0], end[1] + off[1], end[2] + off[2]],
      ext, mask, fraction: 1, normal: [0, 0, 0], startsolid: false, allsolid: false, contents: 0, texinfo: -1,
      isPoint: ext[0] === 0 && ext[1] === 0 && ext[2] === 0,
    };
    this.stamp = (this.stamp + 1) >>> 0;
    this._rec(0, 0, 1, t.s, t.e, t);
    this._traceDisp(t);
    const fr = t.fraction;
    return {
      fraction: fr, startsolid: t.startsolid, allsolid: t.allsolid, normal: t.normal, contents: t.contents, texinfo: t.texinfo,
      endpos: [start[0] + (end[0] - start[0]) * fr, start[1] + (end[1] - start[1]) * fr, start[2] + (end[2] - start[2]) * fr],
      hit: fr < 1 || t.startsolid,
    };
  }

  _rec(num, f1, f2, p1, p2, t) {
    if (t.fraction <= f1) return;
    if (num < 0) { this._leaf(-1 - num, t); return; }
    const pl = this.nodePlane[num];
    const ty = this.planeT[pl];
    let d1, d2, offset;
    const nx = this.planeN[pl * 3], ny = this.planeN[pl * 3 + 1], nz = this.planeN[pl * 3 + 2], d = this.planeD[pl];
    if (ty < 3) {
      d1 = p1[ty] - d; d2 = p2[ty] - d; offset = t.ext[ty];
    } else {
      d1 = nx * p1[0] + ny * p1[1] + nz * p1[2] - d;
      d2 = nx * p2[0] + ny * p2[1] + nz * p2[2] - d;
      offset = t.isPoint ? 0 : Math.abs(t.ext[0] * nx) + Math.abs(t.ext[1] * ny) + Math.abs(t.ext[2] * nz);
    }
    const c0 = this.nodeC0[num], c1 = this.nodeC1[num];
    if (d1 >= offset && d2 >= offset) return this._rec(c0, f1, f2, p1, p2, t);
    if (d1 < -offset && d2 < -offset) return this._rec(c1, f1, f2, p1, p2, t);
    let side, f1s, f2s;
    if (d1 < d2) {
      const id = 1 / (d1 - d2);
      side = 1; f2s = (d1 + offset + DIST_EPSILON) * id; f1s = (d1 - offset - DIST_EPSILON) * id;
      // near side is child[1]
      [f1s, f2s] = [(d1 - offset - DIST_EPSILON) * id, (d1 + offset + DIST_EPSILON) * id];
    } else if (d1 > d2) {
      const id = 1 / (d1 - d2);
      side = 0; f1s = (d1 + offset + DIST_EPSILON) * id; f2s = (d1 - offset - DIST_EPSILON) * id;
      [f1s, f2s] = [(d1 + offset + DIST_EPSILON) * id, (d1 - offset - DIST_EPSILON) * id];
    } else { side = 0; f1s = 1; f2s = 0; }
    f1s = Math.min(1, Math.max(0, f1s));
    f2s = Math.min(1, Math.max(0, f2s));
    let mid = f1 + (f2 - f1) * f1s;
    let pm = [p1[0] + f1s * (p2[0] - p1[0]), p1[1] + f1s * (p2[1] - p1[1]), p1[2] + f1s * (p2[2] - p1[2])];
    this._rec(side ? c1 : c0, f1, mid, p1, pm, t);
    mid = f1 + (f2 - f1) * f2s;
    pm = [p1[0] + f2s * (p2[0] - p1[0]), p1[1] + f2s * (p2[1] - p1[1]), p1[2] + f2s * (p2[2] - p1[2])];
    this._rec(side ? c0 : c1, mid, f2, pm, p2, t);
  }

  _leaf(leaf, t) {
    const first = this.leafFirstBrush[leaf], n = this.leafNumBrush[leaf];
    for (let i = 0; i < n; i++) {
      const b = this.leafBrushes[first + i];
      if (this.brushStamp[b] === this.stamp) continue;
      this.brushStamp[b] = this.stamp;
      if (!(this.brushContents[b] & t.mask)) continue;
      if (this.brushNum[b] === 0) continue;
      this._clipBrush(b, t);
      if (t.fraction === 0) return;
    }
  }

  _clipBrush(b, t) {
    let enter = -1, leave = 1, hn = -1, hs = -1, getout = false, startout = false;
    const first = this.brushFirst[b], num = this.brushNum[b];
    const { s, e, ext } = t;
    for (let i = 0; i < num; i++) {
      const si = first + i;
      if (t.isPoint && this.sideBevel[si]) continue;
      const pl = this.sidePlane[si];
      const nx = this.planeN[pl * 3], ny = this.planeN[pl * 3 + 1], nz = this.planeN[pl * 3 + 2];
      const dist = this.planeD[pl] + Math.abs(ext[0] * nx) + Math.abs(ext[1] * ny) + Math.abs(ext[2] * nz);
      const d1 = s[0] * nx + s[1] * ny + s[2] * nz - dist;
      const d2 = e[0] * nx + e[1] * ny + e[2] * nz - dist;
      if (d2 > 0) getout = true;
      if (d1 > 0) startout = true;
      if (d1 > 0 && d2 >= d1) return;
      if (d1 <= 0 && d2 <= 0) continue;
      if (d1 > d2) {
        const f = (d1 - DIST_EPSILON) / (d1 - d2);
        if (f > enter) { enter = f; hn = pl; hs = si; }
      } else {
        const f = (d1 + DIST_EPSILON) / (d1 - d2);
        if (f < leave) leave = f;
      }
    }
    if (!startout) {
      t.startsolid = true;
      if (!getout) { t.allsolid = true; t.fraction = 0; t.contents = this.brushContents[b]; }
      return;
    }
    if (enter < leave && enter > -1 && enter < t.fraction) {
      t.fraction = Math.max(0, enter);
      t.normal = [this.planeN[hn * 3], this.planeN[hn * 3 + 1], this.planeN[hn * 3 + 2]];
      t.contents = this.brushContents[b];
      t.texinfo = this.sideTexinfo[hs];
    }
  }

  _traceDisp(t) {
    if (!this.dispTris.length) return;
    const { s, e, ext } = t;
    const c = this.dispCell;
    const x0 = Math.floor((Math.min(s[0], e[0]) - ext[0] - 1) / c), x1 = Math.floor((Math.max(s[0], e[0]) + ext[0] + 1) / c);
    const y0 = Math.floor((Math.min(s[1], e[1]) - ext[1] - 1) / c), y1 = Math.floor((Math.max(s[1], e[1]) + ext[1] + 1) / c);
    const st = (this.dstamp = (this.dstamp || 0) + 1);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const l = this.dispHash.get(x * 73856093 ^ y * 19349663);
        if (!l) continue;
        for (const idx of l) {
          if (this.dispStamp[idx] === st) continue;
          this.dispStamp[idx] = st;
          this._clipTri(this.dispTris[idx], t);
        }
      }
    }
  }

  _clipTri(tri, t) {
    const { s, e, ext } = t;
    let enter = -1, leave = 1, hn = null, startout = false;
    for (const p of tri.planes) {
      const n = p.n;
      const dist = p.d + Math.abs(ext[0] * n[0]) + Math.abs(ext[1] * n[1]) + Math.abs(ext[2] * n[2]);
      const d1 = s[0] * n[0] + s[1] * n[1] + s[2] * n[2] - dist;
      const d2 = e[0] * n[0] + e[1] * n[1] + e[2] * n[2] - dist;
      if (d1 > 0) startout = true;
      if (d1 > 0 && d2 >= d1) return;
      if (d1 <= 0 && d2 <= 0) continue;
      if (d1 > d2) {
        const f = (d1 - DIST_EPSILON) / (d1 - d2);
        if (f > enter) { enter = f; hn = n; }
      } else {
        const f = (d1 + DIST_EPSILON) / (d1 - d2);
        if (f < leave) leave = f;
      }
    }
    if (!startout) return; // displacement prisms never report startsolid; we only collide on entry
    if (enter < leave && enter > -1 && enter < t.fraction) {
      t.fraction = Math.max(0, enter);
      t.normal = hn;
      t.contents = CONTENTS_SOLID;
      t.texinfo = tri.texinfo;
    }
  }

  pointLeaf(p) {
    let num = 0;
    while (num >= 0) {
      const pl = this.nodePlane[num];
      const d = this.planeN[pl * 3] * p[0] + this.planeN[pl * 3 + 1] * p[1] + this.planeN[pl * 3 + 2] * p[2] - this.planeD[pl];
      num = d >= 0 ? this.nodeC0[num] : this.nodeC1[num];
    }
    return -1 - num;
  }

  spawnPoints() {
    return this.entities.filter((e) => /info_player|berimbau_spawn|spawn/i.test(e.classname || ''));
  }

  // Static props from the sprp game lump: returns {names, props:[{model,origin,angles,solid,skin}]}
  staticProps() {
    const { dv } = this;
    const gl = this.lump(35);
    if (gl.len < 4) return { names: [], props: [] };
    const count = dv.getInt32(gl.off, true);
    for (let i = 0; i < count; i++) {
      const o = gl.off + 4 + i * 16;
      if (dv.getInt32(o, true) !== 0x73707270) continue; // 'sprp'
      const ver = dv.getUint16(o + 6, true);
      const fileofs = dv.getInt32(o + 8, true), filelen = dv.getInt32(o + 12, true);
      let p = fileofs;
      const nameN = dv.getInt32(p, true); p += 4;
      const names = [];
      for (let k = 0; k < nameN; k++) { names.push(cstr(this.bytes, p)); p += 128; }
      const leafN = dv.getInt32(p, true); p += 4 + leafN * 2;
      const n = dv.getInt32(p, true); p += 4;
      if (!n) return { names, props: [], ver };
      const sz = Math.floor((fileofs + filelen - p) / n);
      const props = [];
      for (let k = 0; k < n; k++) {
        const q = p + k * sz;
        props.push({
          origin: [dv.getFloat32(q, true), dv.getFloat32(q + 4, true), dv.getFloat32(q + 8, true)],
          angles: [dv.getFloat32(q + 12, true), dv.getFloat32(q + 16, true), dv.getFloat32(q + 20, true)],
          model: dv.getUint16(q + 24, true), solid: dv.getUint8(q + 30), skin: dv.getInt32(q + 32, true),
        });
      }
      return { names, props, ver, sz };
    }
    return { names: [], props: [] };
  }

  // Embedded pak (zip, stored). Returns Map lowercase path -> {off,len,method}
  pakIndex() {
    if (this._pak) return this._pak;
    const { dv } = this;
    const l = this.lump(40);
    const map = new Map();
    if (l.len > 22) {
      let eo = l.off + l.len - 22;
      while (eo >= l.off && dv.getUint32(eo, true) !== 0x06054b50) eo--;
      if (eo >= l.off) {
        const count = dv.getUint16(eo + 10, true);
        let p = l.off + dv.getUint32(eo + 16, true);
        for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
          const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
          const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
          const lho = dv.getUint32(p + 42, true);
          const name = dec.decode(this.bytes.subarray(p + 46, p + 46 + nl)).toLowerCase();
          const q = l.off + lho;
          const data = q + 30 + dv.getUint16(q + 26, true) + dv.getUint16(q + 28, true);
          map.set(name, { off: data, len: csize, method });
          p += 46 + nl + xl + cl;
        }
      }
    }
    return (this._pak = map);
  }
}
