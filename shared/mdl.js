// Source MDL v48/49 + VVD + VTX readers, and bone setup from sequences.
// Follows public studio.h layouts; checked against the shipped files by tests/mdl_check.mjs.
import { cstr } from './bsp.js';
import { eulerToQuat, quatSlerp, quatMatrix, matMul, matPoint } from './mathx.js';

const BONE_SIZE = 216, SEQ_SIZE = 212, ANIM_SIZE = 100, ATT_SIZE = 92, BBOX_SIZE = 68;
const RAWPOS = 1, RAWROT = 2, ANIMPOS = 4, ANIMROT = 8, DELTA = 0x10, RAWROT2 = 0x20;
export const SEQ_LOOPING = 1, SEQ_DELTA = 4, SEQ_AUTOPLAY = 8, SEQ_POST = 0x10, SEQ_ALLZEROS = 0x20;

function float16(u) {
  // Valve's float16: 1 sign, 5 biased exponent, 10 mantissa (half), with denormals
  const s = u >> 15, e = (u >> 10) & 0x1f, m = u & 0x3ff;
  let v;
  if (e === 31) v = m ? NaN : Infinity;
  else if (e === 0) v = m * 2 ** -24;
  else v = (m + 1024) * 2 ** (e - 25);
  return s ? -v : v;
}

/**
 * One parsed .mdl: bones, sequences, attachments, hitboxes, pose parameters and textures.
 */
export class Model {
  /**
   * @param {Uint8Array|ArrayBuffer} buffer File contents.
   * @param {string} [name] For error messages.
   */
  constructor(buffer, name = '') {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { dv } = this;
    if (dv.getUint32(0, true) !== 0x54534449) throw new Error('not an MDL: ' + name);
    this.version = dv.getInt32(4, true);
    this.checksum = dv.getInt32(8, true);
    this.name = cstr(bytes, 12);
    const i32 = (o) => dv.getInt32(o, true);
    const vec = (o) => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    this.eye = vec(80);
    this.hullMin = vec(104);
    this.hullMax = vec(116);
    this.flags = i32(152);
    // bones
    const nb = i32(156), bi = i32(160);
    this.bones = [];
    this.boneByName = new Map();
    for (let i = 0; i < nb; i++) {
      const o = bi + i * BONE_SIZE;
      const b = {
        name: cstr(bytes, o + i32(o)), parent: i32(o + 4),
        pos: vec(o + 32),
        quat: [dv.getFloat32(o + 44, true), dv.getFloat32(o + 48, true), dv.getFloat32(o + 52, true), dv.getFloat32(o + 56, true)],
        rot: vec(o + 60), posscale: vec(o + 72), rotscale: vec(o + 84),
        poseToBone: [], flags: i32(o + 160),
      };
      for (let k = 0; k < 12; k++) b.poseToBone.push(dv.getFloat32(o + 96 + k * 4, true));
      this.bones.push(b);
      this.boneByName.set(b.name.toLowerCase(), i);
    }
    // hitboxes
    this.hitboxSets = [];
    const nhs = i32(172), hsi = i32(176);
    for (let i = 0; i < nhs; i++) {
      const o = hsi + i * 12;
      const n = i32(o + 4), idx = i32(o + 8);
      const boxes = [];
      for (let k = 0; k < n; k++) {
        const q = o + idx + k * BBOX_SIZE;
        boxes.push({ bone: i32(q), group: i32(q + 4), min: vec(q + 8), max: vec(q + 20) });
      }
      this.hitboxSets.push({ name: cstr(bytes, o + i32(o)), boxes });
    }
    // local anims / seqs
    this.numAnim = i32(180); this.animIndex = i32(184);
    this.numSeq = i32(188); this.seqIndex = i32(192);
    this.seqs = [];
    for (let i = 0; i < this.numSeq; i++) this.seqs.push(this._readSeq(this.seqIndex + i * SEQ_SIZE, i));
    // textures
    this.textures = [];
    const nt = i32(204), ti = i32(208);
    for (let i = 0; i < nt; i++) {
      const o = ti + i * 64;
      this.textures.push(cstr(bytes, o + i32(o)));
    }
    this.cdtextures = [];
    const ncd = i32(212), cdi = i32(216);
    for (let i = 0; i < ncd; i++) this.cdtextures.push(cstr(bytes, i32(cdi + i * 4)));
    // skins
    this.numSkinRef = i32(220); this.numSkinFam = i32(224); this.skinIndex = i32(228);
    // attachments
    this.attachments = [];
    const na = i32(240), ai = i32(244);
    for (let i = 0; i < na; i++) {
      const o = ai + i * ATT_SIZE;
      const local = [];
      for (let k = 0; k < 12; k++) local.push(dv.getFloat32(o + 12 + k * 4, true));
      this.attachments.push({ name: cstr(bytes, o + i32(o)), bone: i32(o + 8), local });
    }
    // pose parameters
    this.poseParams = [];
    const npp = i32(300), ppi = i32(304);
    for (let i = 0; i < npp; i++) {
      const o = ppi + i * 20;
      this.poseParams.push({
        name: cstr(bytes, o + i32(o)), flags: i32(o + 4),
        start: dv.getFloat32(o + 8, true), end: dv.getFloat32(o + 12, true), loop: dv.getFloat32(o + 16, true),
      });
    }
    // includes
    this.includes = [];
    const ninc = i32(336), inci = i32(340);
    for (let i = 0; i < ninc; i++) {
      const o = inci + i * 8;
      this.includes.push(cstr(bytes, o + i32(o + 4)));
    }
  }

  /**
   * @param {number} o File offset of the sequence.
   * @param {number} index Its index in this model.
   * @returns {object} The sequence: label, activity, weights, blend axes, fade times and so on.
   */
  _readSeq(o, index) {
    const { dv, bytes } = this;
    const i32 = (k) => dv.getInt32(o + k, true);
    const f32 = (k) => dv.getFloat32(o + k, true);
    return {
      index, model: this,
      label: cstr(bytes, o + i32(4)), activity: cstr(bytes, o + i32(8)).toUpperCase(),
      flags: i32(12), actweight: i32(20),
      numEvents: i32(24), eventIndex: o + i32(28),
      numBlends: i32(56), animIndexIndex: o + i32(60),
      groupSize: [i32(68), i32(72)], paramIndex: [i32(76), i32(80)],
      paramStart: [f32(84), f32(88)], paramEnd: [f32(92), f32(96)],
      fadeIn: f32(104), fadeOut: f32(108),
      numAutoLayers: i32(148), autoLayerIndex: o + i32(152),
      weightListIndex: o + i32(156),
      cyclePose: i32(180),
    };
  }

  /**
   * @param {object} seq The sequence.
   * @returns {Float32Array} How much it affects each bone.
   */
  seqBoneWeights(seq) {
    const out = new Float32Array(this.bones.length);
    for (let i = 0; i < out.length; i++) out[i] = this.dv.getFloat32(seq.weightListIndex + i * 4, true);
    return out;
  }

  /**
   * Animation events, such as AE_BB_DAMAGE_SLICE on a throw.
   * @param {object} seq The sequence.
   * @returns {Array<object>} Its events, including the name and cycle of each.
   */
  seqEvents(seq) {
    const out = [];
    const { dv, bytes } = this;
    for (let i = 0; i < seq.numEvents; i++) {
      const o = seq.eventIndex + i * 80;
      out.push({ cycle: dv.getFloat32(o, true), event: dv.getInt32(o + 4, true), type: dv.getInt32(o + 8, true), options: cstr(bytes, o + 12), name: cstr(bytes, o + dv.getInt32(o + 76, true)) });
    }
    return out;
  }

  /**
   * @param {number} idx Animation index in this model.
   * @returns {object} fps, flags, frame count, movement list and where its data is.
   */
  animDesc(idx) {
    const { dv } = this;
    const o = this.animIndex + idx * ANIM_SIZE;
    const i32 = (k) => dv.getInt32(o + k, true);
    return {
      off: o, fps: dv.getFloat32(o + 8, true), flags: i32(12), numFrames: i32(16),
      numMovements: i32(20), movementIndex: o + i32(24),
      animblock: i32(52), animindex: i32(56), sectionIndex: i32(80), sectionFrames: i32(84),
    };
  }

  /**
   * @param {object} seq The sequence.
   * @param {number} x Column in its blend grid.
   * @param {number} y Row in its blend grid.
   * @returns {number} The animation index.
   */
  seqAnimIndex(seq, x, y) {
    return this.dv.getInt16(seq.animIndexIndex + (y * seq.groupSize[0] + x) * 2, true);
  }

  /**
   * Root-motion style movement data of an animation at a cycle: returns local delta from cycle 0.
   * @param {object} desc From animDesc.
   * @param {number} cycle Point in the animation, 0 to 1.
   * @returns {number[]} The delta [x, y, z].
   */
  animMovement(desc, cycle) {
    const { dv } = this;
    if (!desc.numMovements) return [0, 0, 0];
    const target = cycle * (desc.numFrames - 1);
    let frame0 = 0;
    for (let i = 0; i < desc.numMovements; i++) {
      const o = desc.movementIndex + i * 44;
      const endframe = dv.getInt32(o, true);
      const v0 = dv.getFloat32(o + 8, true), v1 = dv.getFloat32(o + 12, true);
      const m = [dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true)];
      const pos = [dv.getFloat32(o + 32, true), dv.getFloat32(o + 36, true), dv.getFloat32(o + 40, true)];
      void v0; void v1; void m;
      if (target <= endframe || i === desc.numMovements - 1) {
        // movement chains are cumulative; linear interpolation inside each piece
        const prev = i ? (() => {
          const q = desc.movementIndex + (i - 1) * 44;
          return [dv.getFloat32(q + 32, true), dv.getFloat32(q + 36, true), dv.getFloat32(q + 40, true)];
        })() : [0, 0, 0];
        const t = endframe > frame0 ? Math.min(1, Math.max(0, (target - frame0) / (endframe - frame0))) : 1;
        return [prev[0] + (pos[0] - prev[0]) * t, prev[1] + (pos[1] - prev[1]) * t, prev[2] + (pos[2] - prev[2]) * t];
      }
      frame0 = endframe;
    }
    return [0, 0, 0];
  }

  /**
   * Locates the mstudio_rle_anim_t list for a frame (handles sections).
   * @param {object} desc From animDesc.
   * @param {number} frame Frame number.
   * @returns {number} File offset, or -1 if not in this file.
   */
  _animPtr(desc, frame) {
    if (desc.animblock !== 0) return -1; // external .ani blocks are not used by the shipped models
    if (desc.sectionFrames > 0) {
      const sec = Math.floor(frame / desc.sectionFrames);
      const so = desc.off + desc.sectionIndex + sec * 8;
      const block = this.dv.getInt32(so, true);
      if (block !== 0) return -1;
      return desc.off + this.dv.getInt32(so + 4, true);
    }
    return desc.off + desc.animindex;
  }

  /**
   * Decodes one channel of Valve's run-length animation data.
   */
  _extract(p, k, scale) {
    const { dv } = this;
    if (scale === 0) return 0;
    for (;;) {
      const valid = dv.getUint8(p), total = dv.getUint8(p + 1);
      if (total === 0) return 0; // malformed guard
      if (total > k) {
        const v = valid > k ? dv.getInt16(p + 2 + k * 2, true) : dv.getInt16(p + 2 + (valid - 1) * 2, true);
        return v * scale;
      }
      k -= total;
      p += 2 + valid * 2;
    }
  }

  /**
   * Samples one anim into pos/quat arrays, keyed by this model's bones. Bones absent keep base pose
   * (or identity for delta anims).
   * @param {object} desc From animDesc.
   * @param {number} cycle Point in the animation, 0 to 1.
   * @param {Array} outPos Filled with positions, for bones the animation has.
   * @param {Array} outQuat Filled with rotations, likewise.
   * @param {number[]} [remap] This model's bone index to the destination's, or -1 to skip.
   * @param {number} [numDest] Number of destination bones.
   * @returns {Uint8Array} 1 for each destination bone written.
   */
  sampleAnim(desc, cycle, outPos, outQuat, remap = null, numDest = this.bones.length) {
    const { dv, bones } = this;
    const ff = desc.numFrames > 1 ? cycle * (desc.numFrames - 1) : 0;
    const frame0 = Math.min(Math.floor(ff), Math.max(0, desc.numFrames - 1));
    const frac = ff - frame0;
    const frame1 = Math.min(frame0 + 1, Math.max(0, desc.numFrames - 1));
    const isDelta = (desc.flags & SEQ_DELTA) !== 0;
    const touched = new Uint8Array(numDest);
    let p = this._animPtr(desc, frame0);
    // within a section frames are section-relative
    const rel = desc.sectionFrames > 0 ? desc.sectionFrames * Math.floor(frame0 / desc.sectionFrames) : 0;
    const f0 = frame0 - rel, f1 = desc.sectionFrames > 0 ? Math.min(frame1 - rel, desc.sectionFrames) : frame1;
    if (p >= 0) {
      for (let guard = 0; guard < 512; guard++) {
        const boneIdx = dv.getUint8(p), flags = dv.getUint8(p + 1), next = dv.getInt16(p + 2, true);
        if (boneIdx < bones.length) {
          const b = bones[boneIdx];
          const dest = remap ? remap[boneIdx] : boneIdx;
          if (dest >= 0 && dest < numDest) {
            touched[dest] = 1;
            const data = p + 4;
            // ---- rotation
            let q;
            if (flags & RAWROT) {
              const x = dv.getUint16(data, true), y = dv.getUint16(data + 2, true), zw = dv.getUint16(data + 4, true);
              const qx = (x - 32768) / 32768, qy = (y - 32768) / 32768, qz = ((zw & 0x7fff) - 16384) / 16384;
              const w = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
              q = [qx, qy, qz, zw >> 15 ? -w : w];
            } else if (flags & RAWROT2) {
              const lo = dv.getUint32(data, true), hi = dv.getUint32(data + 4, true);
              const xi = lo & 0x1fffff, yi = ((lo >>> 21) | (hi & 0x3ff) << 11) >>> 0, zi = (hi >>> 10) & 0x1fffff;
              const qx = (xi - 1048576) / 1048576.5, qy = (yi - 1048576) / 1048576.5, qz = (zi - 1048576) / 1048576.5;
              const w = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
              q = [qx, qy, qz, hi >>> 31 ? -w : w];
            } else if (flags & ANIMROT) {
              const a0 = [0, 0, 0], a1 = [0, 0, 0];
              for (let i = 0; i < 3; i++) {
                const off = dv.getInt16(data + i * 2, true);
                if (off > 0) {
                  a0[i] = this._extract(data + off, f0, b.rotscale[i]);
                  a1[i] = frac > 0 ? this._extract(data + off, f1, b.rotscale[i]) : a0[i];
                }
                if (!(flags & DELTA)) { a0[i] += b.rot[i]; a1[i] += b.rot[i]; }
              }
              const q0 = eulerToQuat(a0[0], a0[1], a0[2]);
              q = frac > 0 ? quatSlerp(q0, eulerToQuat(a1[0], a1[1], a1[2]), frac) : q0;
            } else if (flags & DELTA) q = [0, 0, 0, 1];
            else q = b.quat;
            // ---- position
            let pos;
            if (flags & RAWPOS) {
              const po = data + (flags & RAWROT ? 6 : 0) + (flags & RAWROT2 ? 8 : 0);
              pos = [float16(dv.getUint16(po, true)), float16(dv.getUint16(po + 2, true)), float16(dv.getUint16(po + 4, true))];
            } else if (flags & ANIMPOS) {
              const po = data + (flags & ANIMROT ? 6 : 0);
              const v0 = [0, 0, 0], v1 = [0, 0, 0];
              for (let i = 0; i < 3; i++) {
                const off = dv.getInt16(po + i * 2, true);
                if (off > 0) {
                  v0[i] = this._extract(po + off, f0, b.posscale[i]);
                  v1[i] = frac > 0 ? this._extract(po + off, f1, b.posscale[i]) : v0[i];
                }
              }
              pos = [v0[0] + (v1[0] - v0[0]) * frac, v0[1] + (v1[1] - v0[1]) * frac, v0[2] + (v1[2] - v0[2]) * frac];
              if (!(flags & DELTA)) { pos[0] += b.pos[0]; pos[1] += b.pos[1]; pos[2] += b.pos[2]; }
            } else if (flags & DELTA) pos = [0, 0, 0];
            else pos = b.pos;
            outPos[dest] = pos;
            outQuat[dest] = q;
          }
        }
        if (next === 0) break;
        p += next;
      }
    }
    return touched;
  }

  /**
   * @param {number[][]} pos Each bone's position against its parent.
   * @param {number[][]} quat Each bone's rotation against its parent.
   * @returns {{local: number[][], world: number[][]}} The matrices against the parent and in model space.
   */
  _poseFrom(pos, quat) {
    const local = this.bones.map((_, i) => quatMatrix(quat[i], pos[i])), world = [];
    this.bones.forEach((b, i) => { world[i] = b.parent >= 0 ? matMul(world[b.parent], local[i]) : local[i]; });
    return { local, world };
  }

  /**
   * The reference pose: each bone's matrix against its parent and in model space
   * @returns {{local: number[][], world: number[][]}} The pose.
   */
  refPose() { return (this._refPose ??= this._poseFrom(this.bones.map((b) => b.pos), this.bones.map((b) => b.quat))); }

  /**
   * The same for the start of the model's first sequence. A sword's reference pose can be nothing like how it's held:
   * cts.mdl lies 90 degrees off its grip until its idle plays.
   * @returns {{local: number[][], world: number[][]}} The pose; the reference pose if the model has no sequences.
   */
  idlePose() {
    if (this._idlePose) return this._idlePose;
    if (!this.seqs.length) return this.refPose();
    const pos = this.bones.map((b) => b.pos), quat = this.bones.map((b) => b.quat);
    this.sampleAnim(this.animDesc(this.seqAnimIndex(this.seqs[0], 0, 0)), 0, pos, quat);
    return (this._idlePose = this._poseFrom(pos, quat));
  }
}

/**
 * An assembled "virtual model": a root model + its include models.
 */
export class Character {
  /**
   * @param {Model} root The model the character is drawn with.
   * @param {Model[]} [includes] Models whose sequences it can play, by bone name.
   */
  constructor(root, includes = []) {
    this.root = root;
    this.includes = includes;
    this.bones = root.bones;
    this.seqs = [];
    this.remaps = new Map();
    this.remaps.set(root, null);
    const add = (m) => {
      for (const s of m.seqs) this.seqs.push(s);
    };
    add(root);
    for (const m of includes) {
      this.remaps.set(m, m.bones.map((b) => {
        const i = root.boneByName.get(b.name.toLowerCase());
        return i === undefined ? -1 : i;
      }));
      add(m);
    }
    // Later models don't replace sequences; engine merges by label with first win.
    this.byLabel = new Map();
    this.byActivity = new Map();
    for (const s of this.seqs) {
      const lab = s.label.toLowerCase();
      if (!this.byLabel.has(lab)) this.byLabel.set(lab, s);
      if (s.activity) {
        let l = this.byActivity.get(s.activity);
        if (!l) this.byActivity.set(s.activity, (l = []));
        l.push(s);
      }
    }
    this._dur = new Map();
  }

  /**
   * Deterministic selection (highest weight, first on ties) so server and client agree.
   * @param {string} act Activity, such as 'ACT_BB_B_IDLE'.
   * @returns {object|null} The sequence.
   */
  seqForActivity(act) {
    const l = this.byActivity.get(String(act).toUpperCase());
    if (!l || !l.length) return null;
    let best = l[0];
    for (const s of l) if (s.actweight > best.actweight) best = s;
    return best;
  }

  /**
   * @param {object} seq The sequence.
   * @returns {object} Its first animation's description.
   */
  seqDesc(seq) {
    const m = seq.model;
    return m.animDesc(m.seqAnimIndex(seq, 0, 0) + 0);
  }

  /**
   * Sequence duration in seconds at the base blend.
   * @param {object} seq The sequence.
   * @returns {number} Seconds; 0 for a single frame.
   */
  seqDuration(seq) {
    let d = this._dur.get(seq);
    if (d !== undefined) return d;
    const a = this._seqDescResolved(seq);
    d = a.numFrames > 1 && a.fps > 0 ? (a.numFrames - 1) / a.fps : 0;
    this._dur.set(seq, d);
    return d;
  }

  /**
   * An animindex is relative to the current model's anim table. (mstudioanimdesc is at animIndex + 200*... )
   * @param {object} seq The sequence.
   * @returns {object} Its first animation's description.
   */
  _seqDescResolved(seq) {
    const m = seq.model;
    return m.animDesc(m.seqAnimIndex(seq, 0, 0));
  }

  /**
   * Root motion delta (local space, units) of a sequence from cycle 0 to cycle.
   * px picks the point along a sequence's first blend axis; without it the first animation is used.
   * @param {object} seq The sequence.
   * @param {number} cycle Point in it, 0 to 1.
   * @param {number} [px] Blend position, 0 to 1.
   * @returns {number[]} The delta [x, y, z].
   */
  seqMovement(seq, cycle, px = null) {
    const m = seq.model;
    if (px === null || seq.groupSize[0] < 2) return m.animMovement(this._seqDescResolved(seq), cycle);
    const x = px * (seq.groupSize[0] - 1), i = Math.min(Math.floor(x), seq.groupSize[0] - 2), f = x - i;
    const a = m.animMovement(m.animDesc(m.seqAnimIndex(seq, i, 0)), cycle), b = m.animMovement(m.animDesc(m.seqAnimIndex(seq, i + 1, 0)), cycle);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /**
   * Normalized blend position of a sequence for move_x/move_y, honouring each axis' pose parameter
   * and range. Sequences without those parameters stay at their center.
   * @param {object} seq The sequence.
   * @param {number} moveX The move_x pose parameter.
   * @param {number} moveY The move_y pose parameter.
   * @param {number} [wallrun] The wallrun pose parameter.
   * @returns {number[]} [px, py], each 0 to 1.
   */
  blendFor(seq, moveX, moveY, wallrun = 0) {
    const axis = (i) => {
      const idx = seq.paramIndex[i];
      const name = idx >= 0 ? seq.model.poseParams[idx]?.name : null;
      const v = name === 'move_x' ? moveX : name === 'move_y' ? moveY : name === 'wallrun' ? wallrun : null;
      const a = seq.paramStart[i], b = seq.paramEnd[i];
      if (v === null || a === b) return 0.5;
      return Math.max(0, Math.min(1, (v - a) / (b - a)));
    };
    return [axis(0), axis(1)];
  }

  /**
   * Blends a sequence's anims given a pose-parameter getter value in [0,1] per axis.
   * @param {object} seq The sequence.
   * @param {number} cycle Point in it, 0 to 1.
   * @param {number} px Blend position on the first axis.
   * @param {number} py Blend position on the second.
   * @param {Array} outPos Filled with each bone's position.
   * @param {Array} outQuat Filled with each bone's rotation.
   */
  _sampleSeq(seq, cycle, px, py, outPos, outQuat) {
    const m = seq.model;
    const remap = this.remaps.get(m);
    const nx = seq.groupSize[0], ny = seq.groupSize[1];
    const fx = nx > 1 ? Math.min(nx - 1 - 1e-6, Math.max(0, px * (nx - 1))) : 0;
    const fy = ny > 1 ? Math.min(ny - 1 - 1e-6, Math.max(0, py * (ny - 1))) : 0;
    const ix = Math.floor(fx), iy = Math.floor(fy), sx = fx - ix, sy = fy - iy;
    const corners = [[ix, iy, (1 - sx) * (1 - sy)], [ix + 1, iy, sx * (1 - sy)], [ix, iy + 1, (1 - sx) * sy], [ix + 1, iy + 1, sx * sy]];
    let total = 0;
    const n = this.bones.length;
    for (const [x, y, w] of corners) {
      if (w < 0.001 || x >= nx || y >= ny) continue;
      const desc = m.animDesc(m.seqAnimIndex(seq, x, y));
      const p = new Array(n), q = new Array(n);
      const touched = m.sampleAnim(desc, cycle, p, q, remap, n);
      const nt = total + w;
      const t = w / nt;
      for (let i = 0; i < n; i++) {
        if (!touched[i]) {
          if (seq.flags & SEQ_DELTA) { p[i] = [0, 0, 0]; q[i] = [0, 0, 0, 1]; } else { p[i] = this.bones[i].pos; q[i] = this.bones[i].quat; }
        }
        if (total === 0) { outPos[i] = p[i]; outQuat[i] = q[i]; } else {
          const a = outPos[i], b = p[i];
          outPos[i] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
          outQuat[i] = quatSlerp(outQuat[i], q[i], t);
        }
      }
      total = nt;
    }
  }

  /**
   * Sequences a sequence always plays on top of itself (mstudioautolayer_t). The shipped run cycles
   * use these for their upper body; each has no start/end range, so it applies at full weight.
   * @param {object} seq The sequence.
   * @returns {object[]} The layered sequences.
   */
  autoLayers(seq) {
    if (seq._auto) return seq._auto;
    const m = seq.model, out = [];
    for (let i = 0; i < seq.numAutoLayers; i++) {
      const s = m.seqs[m.dv.getInt16(seq.autoLayerIndex + i * 24, true)];
      if (s) out.push(s);
    }
    seq._auto = out;
    return out;
  }

  /**
   * layers: [{seq, cycle, weight, px, py}] applied in order. First is the base with weight 1.
   * Returns per-bone local {pos, quat}.
   * @param {Array<{seq: object, cycle: number, weight: number, px: number, py: number}>} input The layers.
   * @returns {{P: number[][], Q: number[][]}} Each bone's position and rotation against its parent.
   */
  evalLayers(input) {
    const n = this.bones.length;
    const P = new Array(n), Q = new Array(n);
    for (let i = 0; i < n; i++) { P[i] = this.bones[i].pos; Q[i] = this.bones[i].quat; }
    const layers = [];
    for (const L of input) {
      if (!L.seq) continue;
      layers.push(L);
      for (const a of this.autoLayers(L.seq)) layers.push({ seq: a, cycle: L.cycle, weight: L.weight, px: L.px, py: L.py });
    }
    for (const L of layers) {
      if (!L.seq || L.weight <= 0) continue;
      const p = new Array(n), q = new Array(n);
      this._sampleSeq(L.seq, L.cycle, L.px ?? 0.5, L.py ?? 0.5, p, q);
      const weights = L.seq.model === this.root ? L.seq.model.seqBoneWeights(L.seq) : this._weights(L.seq);
      const delta = (L.seq.flags & SEQ_DELTA) !== 0;
      for (let i = 0; i < n; i++) {
        const w = weights[i] * L.weight;
        if (w <= 0) continue;
        if (delta) {
          // additive: q = base * slerp(identity, delta, w)
          const dq = quatSlerp([0, 0, 0, 1], q[i], Math.min(1, w));
          Q[i] = quatMul(Q[i], dq);
          P[i] = [P[i][0] + p[i][0] * w, P[i][1] + p[i][1] * w, P[i][2] + p[i][2] * w];
        } else if (w >= 1) { P[i] = p[i]; Q[i] = q[i]; } else {
          P[i] = [P[i][0] + (p[i][0] - P[i][0]) * w, P[i][1] + (p[i][1] - P[i][1]) * w, P[i][2] + (p[i][2] - P[i][2]) * w];
          Q[i] = quatSlerp(Q[i], q[i], w);
        }
      }
    }
    return { P, Q };
  }

  /**
   * @param {object} seq The sequence.
   * @returns {Float32Array} Its bone weights, on the root model's bones.
   */
  _weights(seq) {
    if (!seq._w) {
      const m = seq.model;
      const remap = this.remaps.get(m);
      const src = m.seqBoneWeights(seq);
      const w = new Float32Array(this.bones.length);
      if (remap) { remap.forEach((d, i) => { if (d >= 0) w[d] = src[i]; }); } else w.set(src);
      seq._w = w;
    }
    return seq._w;
  }

  /**
   * Local pose -> model-to-world bone matrices (12-float rows). aim leans the spine toward a pitch, in degrees.
   * @param {{P: number[][], Q: number[][]}} pose From evalLayers.
   * @param {number[]} world The entity's matrix.
   * @param {{pitch: number, yaw: number}} [aim] View to lean toward.
   * @returns {number[][]} Each bone's world matrix.
   */
  boneMatrices(pose, world, aim = null) {
    const out = new Array(this.bones.length);
    this._spine ??= ['valvebiped.bip01_spine', 'valvebiped.bip01_spine1', 'valvebiped.bip01_spine2'].map((n) => this.root.boneByName.get(n));
    const spineOk = aim && aim.pitch !== 0 && this._spine.every((i) => i !== undefined);
    const y = aim ? aim.yaw * Math.PI / 180 : 0, right = [Math.sin(y), -Math.cos(y), 0];
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      const local = quatMatrix(pose.Q[i], pose.P[i]);
      out[i] = b.parent < 0 ? matMul(world, local) : matMul(out[b.parent], local);
      if (spineOk) {
        // [R server 18038a004] 50%, 30% and 20% of the pitch, about the view's right axis in the bone's own frame
        const k = this._spine.indexOf(i);
        if (k >= 0) {
          const m = out[i];
          const axis = [-(m[0] * right[0] + m[4] * right[1] + m[8] * right[2]), m[1] * right[0] + m[5] * right[1] + m[9] * right[2], m[2] * right[0] + m[6] * right[1] + m[10] * right[2]];
          out[i] = matMul(m, axisAngleMatrix(axis, -aim.pitch * SPINE_AIM[k]));
        }
      }
    }
    return out;
  }

  /**
   * @param {string} name Attachment name, any case.
   * @param {number[][]} bones From boneMatrices.
   * @returns {number[]|null} Its world matrix.
   */
  attachmentWorld(name, bones) {
    const a = this.root.attachments.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!a) return null;
    return matMul(bones[a.bone], a.local);
  }
}

const SPINE_AIM = [0.5, 0.3, 0.2];
/**
 * @param {number[]} v Axis.
 * @param {number} degrees Angle.
 * @returns {number[]} 3x4 rotation.
 */
function axisAngleMatrix(v, degrees) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1, x = v[0] / l, y = v[1] / l, z = v[2] / l;
  const r = degrees * Math.PI / 180, s = Math.sin(r), c = Math.cos(r), t = 1 - c;
  return [x * x * t + c, x * y * t - z * s, x * z * t + y * s, 0, y * x * t + z * s, y * y * t + c, y * z * t - x * s, 0, z * x * t - y * s, z * y * t + x * s, z * z * t + c, 0];
}

function quatMul(p, q) {
  return [
    p[0] * q[3] + p[1] * q[2] - p[2] * q[1] + p[3] * q[0],
    -p[0] * q[2] + p[1] * q[3] + p[2] * q[0] + p[3] * q[1],
    p[0] * q[1] - p[1] * q[0] + p[2] * q[3] + p[3] * q[2],
    -p[0] * q[0] - p[1] * q[1] - p[2] * q[2] + p[3] * q[3],
  ];
}

// ------------------------------------------------------------------ render mesh
/**
 * Builds a flat skinned mesh for LOD0. Returns {positions, normals, uvs, boneIdx, boneW, meshes:[{material, start, count}]}.
 * body: names of the body parts set to their second sub-model; everything else draws sub-model 0, which is often empty
 * Combines a model's .vvd and .vtx into draw-ready arrays, at the top level of detail.
 * @param {Model} model The model.
 * @param {Uint8Array} vvdBuf .vvd contents.
 * @param {Uint8Array} vtxBuf .dx90.vtx contents.
 * @param {number} [skinFamily] Which skin's textures to use.
 * @param {Set<string>} [body] Body groups to turn on.
 * @returns {object} positions, normals, uvs, boneIdx (3 a vertex), boneW, tangents, indices, and meshes by material.
 */
export function buildMesh(model, vvdBuf, vtxBuf, skinFamily = 0, body = null) {
  const vvd = new DataView(vvdBuf.buffer, vvdBuf.byteOffset, vvdBuf.byteLength);
  const vtx = new DataView(vtxBuf.buffer, vtxBuf.byteOffset, vtxBuf.byteLength);
  if (vvd.getUint32(0, true) !== 0x56534449) throw new Error('bad vvd');
  if (vtx.getInt32(0, true) !== 7) throw new Error('bad vtx');
  const numFix = vvd.getInt32(48, true), fixStart = vvd.getInt32(52, true), vertStart = vvd.getInt32(56, true);
  const lod0 = vvd.getInt32(16, true);
  const remap = [];
  if (numFix) {
    for (let i = 0; i < numFix; i++) {
      const o = fixStart + i * 12;
      if (vvd.getInt32(o, true) >= 0) {
        const src = vvd.getInt32(o + 4, true), n = vvd.getInt32(o + 8, true);
        for (let k = 0; k < n; k++) remap.push(src + k);
      }
    }
  }
  const V = (i) => (numFix ? remap[i] : i);
  const mdv = model.dv;
  const bpN = mdv.getInt32(232, true), bpI = mdv.getInt32(236, true);
  const tangentStart = vvd.getInt32(60, true);
  const positions = [], normals = [], uvs = [], boneIdx = [], boneW = [], tangents = [], vhvMesh = [], vhvVert = [], indices = [], meshes = [];
  let meshSerial = 0; // a baked .vhv lists every mesh of every sub-model, in order
  const vbp = vtx.getInt32(32, true);
  const nVtxBp = vtx.getInt32(28, true);
  if (nVtxBp !== bpN) throw new Error('vtx/mdl body part mismatch');
  // The strip group header grew by two ints (topology) for MDL v49.
  const groupHdrSize = model.version >= 49 ? 33 : 25;
  for (let bp = 0; bp < bpN; bp++) {
    const mbp = bpI + bp * 16;
    const nModels = mdv.getInt32(mbp + 4, true), modelIdx = mdv.getInt32(mbp + 12, true);
    const vb = vbp + bp * 8;
    const vmOff = vb + vtx.getInt32(vb + 4, true);
    const chosen = nModels > 1 && body?.has(cstr(model.bytes, mbp + mdv.getInt32(mbp, true)).toLowerCase()) ? 1 : 0;
    const mo = mbp + modelIdx + chosen * 148;
    const serialBase = meshSerial;
    for (let m = 0; m < chosen; m++) meshSerial += 0;
    let before = 0;
    for (let m = 0; m < chosen; m++) before += mdv.getInt32(mbp + modelIdx + m * 148 + 72, true);
    for (let m = 0; m < nModels; m++) meshSerial += mdv.getInt32(mbp + modelIdx + m * 148 + 72, true);
    const nMeshes = mdv.getInt32(mo + 72, true), meshIdx = mdv.getInt32(mo + 76, true);
    const modelVertStart = mdv.getInt32(mo + 84, true) / 48;
    const vm = vmOff + chosen * 8;
    const lodOff = vm + vtx.getInt32(vm + 4, true);
    const vMeshN = vtx.getInt32(lodOff, true), vMeshOff = lodOff + vtx.getInt32(lodOff + 4, true);
    for (let me = 0; me < Math.min(nMeshes, vMeshN); me++) {
      const mho = mo + meshIdx + me * 116;
      const material = mdv.getInt32(mho, true), meshVertOff = mdv.getInt32(mho + 12, true);
      const vmo = vMeshOff + me * 9;
      const nGroups = vtx.getInt32(vmo, true), gOff = vmo + vtx.getInt32(vmo + 4, true);
      const start = indices.length;
      for (let g = 0; g < nGroups; g++) {
        const go = gOff + g * groupHdrSize;
        const nv = vtx.getInt32(go, true), vo = go + vtx.getInt32(go + 4, true);
        const ni = vtx.getInt32(go + 8, true), io = go + vtx.getInt32(go + 12, true);
        const base = positions.length / 3;
        for (let i = 0; i < nv; i++) {
          const v9 = vo + i * 9;
          const orig = vtx.getUint16(v9 + 4, true);
          const vi = V(orig + meshVertOff + modelVertStart);
          const o = vertStart + vi * 48;
          positions.push(vvd.getFloat32(o + 16, true), vvd.getFloat32(o + 20, true), vvd.getFloat32(o + 24, true));
          normals.push(vvd.getFloat32(o + 28, true), vvd.getFloat32(o + 32, true), vvd.getFloat32(o + 36, true));
          uvs.push(vvd.getFloat32(o + 40, true), vvd.getFloat32(o + 44, true));
          boneW.push(vvd.getFloat32(o, true), vvd.getFloat32(o + 4, true), vvd.getFloat32(o + 8, true));
          boneIdx.push(vvd.getUint8(o + 12), vvd.getUint8(o + 13), vvd.getUint8(o + 14));
          const to = tangentStart + vi * 16;
          tangents.push(vvd.getFloat32(to, true), vvd.getFloat32(to + 4, true), vvd.getFloat32(to + 8, true), vvd.getFloat32(to + 12, true));
          vhvMesh.push(serialBase + before + me); vhvVert.push(orig);
        }
        for (let i = 0; i < ni; i++) indices.push(base + vtx.getUint16(io + i * 2, true));
      }
      const count = indices.length - start;
      let tex = material;
      if (model.numSkinFam > skinFamily && material < model.numSkinRef) {
        tex = mdv.getInt16(model.skinIndex + skinFamily * model.numSkinRef * 2 + material * 2, true);
      }
      if (count) meshes.push({ material: model.textures[tex], start, count });
    }
  }
  void lod0;
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs),
    boneIdx: new Uint8Array(boneIdx), boneW: new Float32Array(boneW), tangents: new Float32Array(tangents), vhvMesh: new Int32Array(vhvMesh), vhvVert: new Int32Array(vhvVert), indices: new Uint32Array(indices), meshes,
  };
}
