// Gameplay effects: runs the game's particle definitions and picks them the way client.dll does.
// Addresses below are in client.dll; [I] marks choices that are inferred, not read from the binary.
import { ParticleLibrary, ParticleInstance, makeCP } from '/shared/particles.js';

// Files in the game's manifest that hold the effects dispatched here
const PCF_FILES = ['blade_sparks', 'player_generic', 'player_charging', 'player_blocking', 'impact_fx'];
const STRIDE = 11; // pos3 uv2 uv2 rgba4
const MAX_VERTS = 240000;
const TRAIL_MATERIAL = 'models/tracemodels/trace_map';
const center = (o) => [o[0], o[1], o[2] + 36]; // hull center standing in for WorldSpaceCenter
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const flat = (a, b) => norm([a[0] - b[0], a[1] - b[1], 0.0001]);
const attPos = (m) => [m[3], m[7], m[11]];
const attFwd = (m) => [m[0], m[4], m[8]];

/**
 * Particles and swing trails. Gameplay events go in; a frame's vertices come out.
 */
export class FX {
  constructor(renderer, fetchGame, bsp) {
    Object.assign(this, { R: renderer, fetchGame, bsp });
    this.lib = new ParticleLibrary();
    this.active = [];
    this.players = new Map(); // id -> { bones, world, char, p, trail: [], fade: 1, ... }
    this.materials = new Map();
    this.verts = new Float32Array(MAX_VERTS * STRIDE);
    this.time = 0;
    this.host = {
      trace: (a, b) => { const t = bsp.traceBox(a, b, [0, 0, 0], [0, 0, 0], 1); return t.fraction < 1 ? t.endpos : null; },
      traceNormal: (a, b) => { const t = bsp.traceBox(a, b, [0, 0, 0], [0, 0, 0], 1); return t.fraction < 1 && !t.startsolid ? { pos: t.endpos, normal: t.normal } : null; },
      bonesOf: (id) => this.players.get(id)?.bonePoints,
      localPlayer: () => this.localPos,
      sheetOf: (material) => (material ? this._material(material)?.sheet : null),
    };
  }

  /**
   * Every file in the game's manifest, later files replacing earlier definitions of the same name
   */
  async load() {
    const list = await this.fetchGame('particles/particles_manifest.txt');
    const files = list ? [...new TextDecoder('latin1').decode(list).matchAll(/"file"\s+"!?([^"]+)"/g)].map((m) => m[1]) : PCF_FILES.map((f) => `particles/${f}.pcf`);
    const data = await Promise.all(files.map((f) => this.fetchGame(f)));
    for (const b of data) if (b) this.lib.add(new TextDecoder('latin1').decode(b));
    this.startMapEffects();
  }

  /**
   * info_particle_system: control point 0 is the entity, cpointN names the entity for point N. Starts active, or
   * when the map's logic_auto starts it on spawn; effects started later by other map logic aren't run.
   */
  startMapEffects() {
    const ents = this.bsp.entities, onSpawn = new Set();
    for (const e of ents) if (e.classname === 'logic_auto' && e.OnMapSpawn) { const [target, input] = String(e.OnMapSpawn).split(/[\x1b,]/); if (input === 'Start') onSpawn.add(target); }
    const pos = (e) => e.origin.split(' ').map(Number);
    for (const e of ents) {
      if (e.classname !== 'info_particle_system' || !this.lib.systems.has(e.effect_name)) continue;
      if (e.start_active !== '1' && !onSpawn.has(e.targetname)) continue;
      const [pitch, yaw] = (e.angles ?? '0 0 0').split(' ').map((x) => x * Math.PI / 180);
      const cs = Math.cos(pitch), sn = Math.sin(pitch);
      const fwd = [cs * Math.cos(yaw), cs * Math.sin(yaw), -sn];
      const up = [Math.cos(yaw) * sn, Math.sin(yaw) * sn, cs];
      const cps = [makeCP(pos(e), fwd, up)];
      for (let i = 1; i < 64; i++) {
        const name = e[`cpoint${i}`];
        const t = name && ents.find((x) => x.targetname === name && x.origin);
        if (t) cps[i] = makeCP(pos(t));
      }
      this.spawn(e.effect_name, cps);
    }
  }

  /**
   * A flying throwable's trail follows it; it stops emitting when the throwable is gone
   * @param {number} id The throwable's id.
   * @param {number[]} pos Position.
   * @param {number[]} vel Velocity.
   * @param {string} type Throwable type.
   */
  starTrail(id, pos, vel, type) {
    this.stars ??= new Map();
    let h = this.stars.get(id);
    if (!h) { h = this.spawn(type.particletrail, makeCP(pos, vel)); if (!h) return; this.stars.set(id, h); }
    h.inst.setCP(0, makeCP(pos, vel));
  }

  endStarTrails(live) {
    if (!this.stars) return;
    for (const [id, h] of this.stars) if (!live.has(id)) { h.inst.stop(); this.stars.delete(id); }
  }

  spawn(name, cps, follow = null) {
    const def = this.lib.systems.get(name);
    if (!def) return null;
    const list = Array.isArray(cps) ? cps : [cps];
    const inst = new ParticleInstance(this.lib, def, this.host, list);
    const h = { inst, follow };
    this.active.push(h);
    return h;
  }

  // ------------------------------------------------------------ dispatch
  /**
   * [1803f6c90] combat effects. The switch value is the hit result; the origin and angles come from the
   * trace, and the sim passes the swing direction as the angle [1803d7370].
   * The effects for a game event.
   * @param {object} e The event.
   * @param {object[]} players Fighters in the latest snapshot.
   */
  onEvent(e, players) {
    const pl = (id) => players?.find((p) => p.id === id);
    const at = (pos, dir) => makeCP(pos, dir ?? [1, 0, 0]);
    const star = this.throwables?.[e.kind];
    switch (e.type) {
      case 'star_throw': if (star) this.spawn(star.particledispatch, at(e.pos)); return;
      case 'star_hit': if (star) this.spawn(e.what === 'world' ? star.particlehitworld : e.what === 'player' ? star.particlehitplayer : star.particleblocked, at(e.pos, e.normal)); return;
      case 'hit': { // case 0, by the attacker's stance
        const name = ['balanced_hit', 'light_hit', 'heavy_hit'][e.stance] ?? 'balanced_hit';
        this.spawn(name, at(e.pos, e.dir));
        break;
      }
      case 'blocked': this.spawn('wallhit_spark', at(e.pos, e.dir)); break; // case 1
      case 'guarded': this.spawn('guard_fx', at(e.pos, e.dir)); break;
      case 'feint': { // [R server 18034925a] at the eyes
        const st = this.players.get(e.id);
        if (!st) break;
        const m = st.char.attachmentWorld('eyes', st.world);
        this.spawn('feint_fx', [m ? makeCP(attPos(m), flat(attFwd(m), [0, 0, 0])) : makeCP(center(st.p.o))]);
        break;
      }
      case 'world_hit': this.spawn('wallhit_spark', at(e.pos, e.normal ?? e.dir)); break; // case 1 from the world trace [1803dd200]
      case 'intercepted': { // case 2: both at the defender's center
        const d = pl(e.defender), c = d ? center(d.o) : e.pos;
        this.spawn('smoke_ring', at(c, e.dir));
        this.spawn('riposte_forward_fx', at(c, e.dir));
        break;
      }
      case 'parried': { // case 3 on both players: blade against blade [I: which of cases 3 and 4 a clash is]
        for (const id of [e.attacker, e.defender]) { const p = pl(id); if (p) this.spawn('smoke_ring', at(center(p.o), e.dir)); }
        this.spawn('penetrate_fx', at(e.pos, e.dir));
        break;
      }
      case 'break_block': { // case 5
        const v = pl(e.victim);
        this.spawn('penetrate_fx', at(e.pos, e.dir));
        this.spawn('smoke_ring', at(v ? center(v.o) : e.pos, e.dir));
        break;
      }
      case 'guard': { // case 8
        const v = pl(e.id), c = v ? center(v.o) : e.pos;
        this.spawn('smoke_ring', at(c, e.dir));
        this.spawn('guard_fx', at(e.pos ?? c, e.dir));
        break;
      }
      case 'action': { // ACT_BB_DASH_N's AE_CL_CREATE_PARTICLE_EFFECT, "player_dash follow_origin", right at its start
        const st = e.name === 'AirDash' && this.players.get(e.id);
        if (!st) break;
        const point = () => makeCP(st.p.o);
        this.spawn('player_dash', point(), (h) => { h.inst.setCP(0, Object.assign(point(), { entity: e.id })); });
        break;
      }
      case 'charge_tier': { // server 18022e3d0 at "chest", with CP1 carrying the character color as 0..1
        const name = e.tier === 2 ? 'charge_tier3_forward' : e.tier === 1 ? 'berimbau_player_charge' : null;
        const st = this.players.get(e.id);
        if (!name || !st) break;
        const point = () => {
          const m = st.char.attachmentWorld('chest', st.world);
          return m ? makeCP(attPos(m), flat(attFwd(m), [0, 0, 0])) : makeCP(center(st.p.o));
        };
        this.spawn(name, [point(), makeCP(st.color)], (h) => { h.inst.setCP(0, Object.assign(point(), { entity: e.id })); });
        break;
      }
      default:
    }
  }

  /**
   * Per-player state a frame needs, from the same pose used to draw the character
   * @param {object} p A fighter from the snapshot.
   * @param {Character} char The character.
   * @param {number[][]} world Each bone's world matrix.
   * @param {number} gripBone sword_grip's index.
   * @param {number[]} color Trail color.
   */
  /**
   * A flourish's own AE_CL_CREATE_PARTICLE_EFFECT events, as "name follow_attachment attachment", when its cycle passes them. The heavy flourish's
   * rope of hearts is one, on every character, and the balanced flourish's kiss on the female models.
   * @param {object} s This fighter's effect state.
   * @param {object} p The fighter from the snapshot.
   * @param {object} char Their character.
   */
  flourishEffects(s, p, char) {
    const anim = p.an?.b, was = s.flourish, cycle = p.an?.bc ?? 0;
    s.flourish = /_FLOURISH$/.test(anim ?? '') ? { anim, cycle } : null;
    if (!s.flourish) return;
    const seq = char.seqForActivity(anim);
    if (!seq) return;
    const from = was?.anim === anim && cycle >= was.cycle ? was.cycle : -1;
    for (const e of seq.model.seqEvents(seq)) {
      if (e.name !== 'AE_CL_CREATE_PARTICLE_EFFECT' || e.cycle <= from || e.cycle > cycle) continue;
      const [name, , attachment] = String(e.options).trim().split(/\s+/);
      const point = () => { const m = char.attachmentWorld(attachment, s.world); return makeCP(m ? attPos(m) : center(s.p.o)); };
      this.spawn(name, point(), (h) => { h.inst.setCP(0, Object.assign(point(), { entity: p.id })); });
    }
  }

  updatePlayer(p, char, world, gripBone, color) {
    let s = this.players.get(p.id);
    if (!s) { s = { trail: [], fade: 1, charge: 0, parry: null }; this.players.set(p.id, s); }
    Object.assign(s, { p, char, world, color });
    s.bonePoints = world.map((m) => [m[3], m[7], m[11]]);
    const g = gripBone !== undefined ? world[gripBone] : null;
    s.grip = g;
    this.flourishEffects(s, p, char);
    const a = p.a;
    // [1803f1710] the trail runs from 5 units behind the grip to the blade length, while the swing's
    // tracer script is running; ring length is per frame here rather than per .bst sample
    if (g && a?.tr === 1) {
      const fwd = attFwd(g), o = attPos(g), base = [o[0] - fwd[0] * 5, o[1] - fwd[1] * 5, o[2] - fwd[2] * 5];
      const tip = [base[0] + fwd[0] * 40, base[1] + fwd[1] * 40, base[2] + fwd[2] * 40];
      if (s.fade > 0) { s.trail.length = 0; s.fade = 0; }
      const last = s.trail.at(-1);
      if (!last || Math.hypot(tip[0] - last.tip[0], tip[1] - last.tip[1], tip[2] - last.tip[2]) > 0.5) s.trail.push({ base, tip });
      if (s.trail.length > 96) s.trail.shift();
      s.tracing = true;
    } else s.tracing = false;
    // [18003a2c0 family] m_flChargeAmountLocal; how fast it falls after release is [I]
    const want = a?.ph === 'charge' ? a.cf ?? 0 : 0;
    s.charge = want > s.charge ? want : Math.max(want, s.charge - (s.dtHint ?? 0.016) * 4);
    // [1802bf620] blocking_forward runs along the sword's attachments during an active parry
    const parrying = !!a?.pw;
    if (parrying && !s.parry) {
      const pt = (n) => { const m = s.char.attachmentWorld(n, s.world); return m ? makeCP(attPos(m), attFwd(m)) : makeCP(center(s.p.o)); };
      s.parry = this.spawn('blocking_forward', [pt('anim_attachment_S'), pt('anim_attachment_E'), pt('anim_attachment_T')], (h) => {
        h.inst.setCP(0, pt('anim_attachment_S')); h.inst.setCP(1, pt('anim_attachment_E')); h.inst.setCP(2, pt('anim_attachment_T'));
      });
    } else if (!parrying && s.parry) { s.parry.inst.stop(); s.parry = null; }
    return s;
  }

  // ------------------------------------------------------------ simulation
  /**
   * @param {number} dt Seconds.
   */
  step(dt) {
    this.time += dt;
    for (const s of this.players.values()) {
      s.dtHint = dt;
      if (!s.tracing && s.fade < 1) { s.fade = Math.min(1, s.fade + dt * 10); if (s.fade >= 1) s.trail.length = 0; } // bb_tracer_fade_speed
    }
    for (const h of this.active) { h.follow?.(h); h.inst.step(dt); }
    this.active = this.active.filter((h) => !h.inst.done);
  }

  // ------------------------------------------------------------ geometry
  /**
   * Returns the vertex array and draw ranges; materials still loading are skipped for the frame.
   * @param {number[]} eye Camera position.
   * @param {number[]} right Camera right.
   * @param {number[]} up Camera up.
   * @param {number} fovTan Tangent of half the vertical field of view.
   * @returns {{count: number, draws: Array}} Vertices written, and what to draw.
   */
  build(eye, right, up, fovTan) {
    const v = this.verts;
    let n = 0;
    const draws = [];
    let cur = null;
    const begin = (mat) => { if (!cur || cur.mat !== mat) { cur = { mat, first: n / STRIDE, count: 0 }; draws.push(cur); } };
    const vtx = (x, y, z, u, w, u2, w2, r, g, b, a) => { v[n++] = x; v[n++] = y; v[n++] = z; v[n++] = u; v[n++] = w; v[n++] = u2; v[n++] = w2; v[n++] = r; v[n++] = g; v[n++] = b; v[n++] = a; cur.count++; };
    const quad = (a, b, c, d, uv, col) => {
      vtx(a[0], a[1], a[2], uv[0], uv[1], 0, 0, col[0], col[1], col[2], col[3]);
      vtx(b[0], b[1], b[2], uv[2], uv[1], 0, 0, col[0], col[1], col[2], col[3]);
      vtx(c[0], c[1], c[2], uv[2], uv[3], 0, 0, col[0], col[1], col[2], col[3]);
      vtx(a[0], a[1], a[2], uv[0], uv[1], 0, 0, col[0], col[1], col[2], col[3]);
      vtx(c[0], c[1], c[2], uv[2], uv[3], 0, 0, col[0], col[1], col[2], col[3]);
      vtx(d[0], d[1], d[2], uv[0], uv[3], 0, 0, col[0], col[1], col[2], col[3]);
    };
    const room = (k) => n + k * STRIDE <= v.length;
    const minR = (mat, p) => (mat.minSize ? mat.minSize * Math.hypot(p.x - eye[0], p.y - eye[1], p.z - eye[2]) * fovTan * 2 : 0);

    const emit = (inst) => {
      const def = inst.def;
      if (!inst.particles.length || !def.material) return;
      const mat = this._material(def.material);
      if (!mat) return;
      if (mat.needsSort) inst.particles.sort((a, b) => ((b.x - eye[0]) ** 2 + (b.y - eye[1]) ** 2 + (b.z - eye[2]) ** 2) - ((a.x - eye[0]) ** 2 + (a.y - eye[1]) ** 2 + (a.z - eye[2]) ** 2));
      for (const ro of def.renderers || []) {
        begin(mat);
        if (ro.functionName === 'render_animated_sprites') {
          const rate = ro['animation rate'] ?? 0.1, fit = ro.animation_fit_lifetime;
          const ot = ro.orientation_type ?? 0;
          for (const p of inst.particles) {
            if (!room(6) || p.a <= 0.002) continue;
            const r = Math.max(p.radius, minR(mat, p));
            const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
            let rx = right, uy = up;
            if (ot === 1) { uy = [0, 0, 1]; rx = norm(cross(sub([p.x, p.y, p.z], eye), uy)); } else if (ot === 2 || ot === 3) { rx = [1, 0, 0]; uy = [0, 1, 0]; }
            const ax = (rx[0] * cs + uy[0] * sn) * r, ay = (rx[1] * cs + uy[1] * sn) * r, az = (rx[2] * cs + uy[2] * sn) * r;
            const bx = (uy[0] * cs - rx[0] * sn) * r, by = (uy[1] * cs - rx[1] * sn) * r, bz = (uy[2] * cs - rx[2] * sn) * r;
            quad([p.x - ax + bx, p.y - ay + by, p.z - az + bz], [p.x + ax + bx, p.y + ay + by, p.z + az + bz], [p.x + ax - bx, p.y + ay - by, p.z + az - bz], [p.x - ax - bx, p.y - ay - by, p.z - az - bz],
              frameUV(mat, p, rate, fit), [p.r, p.g, p.b, p.a]);
          }
        } else if (ro.functionName === 'render_sprite_trail') {
          const lo = ro['min length'] ?? 0, hi = ro['max length'] ?? 2000, fi = ro['length fade in time'] ?? 0, odt = inst.lastDt > 0 ? 1 / inst.lastDt : 0;
          for (const p of inst.particles) {
            if (!room(6) || p.a <= 0.002) continue;
            const vx = (p.x - p.px) * odt, vy = (p.y - p.py) * odt, vz = (p.z - p.pz) * odt, sp = Math.hypot(vx, vy, vz);
            const dirv = sp > 1e-3 ? [vx / sp, vy / sp, vz / sp] : right;
            const k = fi > 0 ? Math.min(1, p.age / fi) : 1;
            const len = Math.min(hi, Math.max(lo, p.trail * sp * k));
            const side = norm(cross(dirv, sub([p.x, p.y, p.z], eye)));
            const r = Math.max(p.radius, minR(mat, p));
            const sx = side[0] * r, sy = side[1] * r, sz = side[2] * r;
            const tx = p.x - dirv[0] * len, ty = p.y - dirv[1] * len, tz = p.z - dirv[2] * len;
            quad([p.x - sx, p.y - sy, p.z - sz], [p.x + sx, p.y + sy, p.z + sz], [tx + sx, ty + sy, tz + sz], [tx - sx, ty - sy, tz - sz], frameUV(mat, p, ro['animation rate'] ?? 0.1, false), [p.r, p.g, p.b, p.a]);
          }
        } else if (ro.functionName === 'render_rope') {
          const list = inst.particles, ts = ro.texel_size || 2.5, scroll = (ro.texture_scroll_rate ?? 0) * inst.t;
          let dist = 0;
          for (let i = 0; i + 1 < list.length && room(6); i++) {
            const a = list[i], b = list[i + 1], seg = [b.x - a.x, b.y - a.y, b.z - a.z], l = Math.hypot(seg[0], seg[1], seg[2]);
            if (l < 1e-3) continue;
            const s = norm(cross(seg, sub([a.x, a.y, a.z], eye)));
            const v0 = (dist + scroll) / (ts * 32), v1 = (dist + l + scroll) / (ts * 32);
            dist += l;
            const ra = a.radius, rb = b.radius, col = [a.r, a.g, a.b, a.a];
            quad([a.x - s[0] * ra, a.y - s[1] * ra, a.z - s[2] * ra], [a.x + s[0] * ra, a.y + s[1] * ra, a.z + s[2] * ra], [b.x + s[0] * rb, b.y + s[1] * rb, b.z + s[2] * rb], [b.x - s[0] * rb, b.y - s[1] * rb, b.z - s[2] * rb], [0, v0, 1, v1], col);
          }
        }
      }
    };
    for (const h of this.active) for (const inst of h.inst.visit()) emit(inst);
    // Refraction reads the scene, so it goes first and everything else blends over it
    draws.sort((a, b) => (b.mat.refract ? 1 : 0) - (a.mat.refract ? 1 : 0));

    // [1803f1710] swing trails
    const tm = this._material(TRAIL_MATERIAL);
    if (tm) {
      for (const s of this.players.values()) {
        const t = s.trail;
        if (t.length < 2 || !room(t.length * 6)) continue;
        cur = null;
        begin(tm);
        const m = t.length - 1;
        const tx2 = s.fade * 0.45 + 0.6, ty2 = 0.5 - s.fade * 0.5; // $texture2transform: slides off the dissolve mask as the trail fades
        const c = s.color, cm = tm.color;
        const col = [c[0] * cm[0], c[1] * cm[1], c[2] * cm[2], 1];
        const inner = (i) => { const q = t[i], k = (1 - i / m), fd = s.fade; const bx = q.base[0] + (q.tip[0] - q.base[0]) * fd, by = q.base[1] + (q.tip[1] - q.base[1]) * fd, bz = q.base[2] + (q.tip[2] - q.base[2]) * fd; return [bx + (q.tip[0] - bx) * k, by + (q.tip[1] - by) * k, bz + (q.tip[2] - bz) * k]; };
        const pv = (p, u, w) => vtx(p[0], p[1], p[2], u, w, 0.6 * u + tx2, 0.3 * w + ty2, col[0], col[1], col[2], col[3]);
        for (let i = 0; i < m; i++) {
          const u0 = -i / m, u1 = -(i + 1) / m, a = inner(i), b = t[i].tip, c1 = t[i + 1].tip, d = inner(i + 1);
          pv(a, u0, 0); pv(b, u0, 1); pv(c1, u1, 1); pv(a, u0, 0); pv(c1, u1, 1); pv(d, u1, 0);
        }
      }
    }
    return { count: n, draws: draws.filter((d) => d.count > 0) };
  }

  _material(name) {
    const key = name.toLowerCase().replace(/\\+/g, '/').replace(/\.vmt$/, '');
    let m = this.materials.get(key);
    if (m === undefined) { this.materials.set(key, null); this.R.fxMaterial(key).then((x) => this.materials.set(key, x)).catch(() => {}); return null; }
    return m;
  }
}

// Sheet lookup: sequence and cycle to a frame's rectangle. Without a sheet the whole texture is the frame.
function frameUV(mat, p, rate, fit) {
  const seqs = mat.sheet;
  if (!seqs) return [0, 0, 1, 1];
  const s = seqs[p.seq] ?? seqs[0];
  if (!s?.frames.length) return [0, 0, 1, 1];
  let c = fit ? p.age / (p.life || 1) : p.age * rate;
  c = s.clamp ? Math.min(c, 0.999) : c - Math.floor(c);
  let t = c * s.total, i = 0;
  while (i < s.frames.length - 1 && t >= s.frames[i].d) { t -= s.frames[i].d; i++; }
  return s.frames[i].uv;
}
