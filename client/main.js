// Browser client: input -> server, snapshots -> interpolated rendering.
import { BSP } from '/shared/bsp.js';
import { Model, Character } from '/shared/mdl.js';
import { IN, animLayers } from '/shared/sim.js';
import { entityMatrix, matMul, angleVectors, DEG, angleDiff, angleNorm } from '/shared/mathx.js';
import { Renderer } from './render.js';
import { FX } from './fx.js';
import { createHud } from './hud.js';
import { createCustomize } from './customize.js';
import { Audio } from './audio.js';
import { parsePhy, Ragdoll } from '/shared/ragdoll.js';

const $ = (id) => document.getElementById(id);
const status = (s, err) => { const e = $('status'); if (!e) return; e.textContent = s; e.className = err ? 'err' : ''; e.style.visibility = s === 'Ready.' ? 'hidden' : ''; };
const params = new URLSearchParams(location.search);
window.duelDebug = { errors: [], noTex: params.has("notex"), allowUnlocked: params.has("nolock") };
const gpuAdapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
if (!gpuAdapter) { status('WebGPU is not available in this browser. Use Safari 26+, or a current Chrome or Edge.', true); throw new Error('no webgpu'); }
const features = [];
if (gpuAdapter.features.has('texture-compression-bc')) features.push('texture-compression-bc');
const device = await gpuAdapter.requestDevice({ requiredFeatures: features, requiredLimits: { maxBufferSize: gpuAdapter.limits.maxBufferSize, maxTextureDimension2D: Math.min(8192, gpuAdapter.limits.maxTextureDimension2D) } });
device.addEventListener('uncapturederror', (e) => { console.error('GPU', e.error.message); window.duelDebug.errors.push(e.error.message); });
device.lost.then((i) => status('GPU device lost: ' + i.message, true));

const info = await (await fetch('/api/info')).json();
const customize = createCustomize(document.body, info, params);

// ------------------------------------------------------------ assets
const fileCache = new Map();
let bspRef = null;
async function fetchGame(path, pak) {
  const p = path.toLowerCase().replace(/\\/g, '/');
  const b = pak || bspRef;
  if (b) {
    const e = b.pakIndex().get(p);
    if (e && e.method === 0) return b.bytes.subarray(e.off, e.off + e.len);
  }
  if (fileCache.has(p)) return fileCache.get(p);
  const pr = fetch('/game/' + path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null)).catch(() => null);
  fileCache.set(p, pr);
  return pr;
}
const canvas = $('c');
const fmt = navigator.gpu.getPreferredCanvasFormat();
const R = new Renderer(canvas, device, fmt, fetchGame);
window.duelDebug.R = R;
R.noCSM = params.has('nocsm');
window.duelDebug.R = R;
R.noCSM = params.has('nocsm');
R.hideProps = params.has('noprops'); R.hideWorld = params.has('noworld');
window.addEventListener('resize', () => R.resize());
status(`Loading map ${info.map}…`);
const bspBytes = await fetchGame(`maps/${info.map}.bsp`);
if (!bspBytes) { status('Could not load the map from the server.', true); throw new Error('no map'); }
const bsp = new BSP(bspBytes);
await bsp.addPropCollision((p) => fetchGame(p));
bspRef = bsp;
await R.loadWorld(bsp, (s) => status(`Loading ${info.map}: ${s}`));
const fx = new FX(R, fetchGame, bsp);
window.duelDebug.fx = fx;
fx.throwables = info.throwables;
await fx.load();
const audio = new Audio(fetchGame, info, bsp);
window.duelDebug.audio = audio;
if (params.has('vol')) audio.master = parseFloat(params.get('vol'));
await audio.load();
const charCache = new Map();
async function loadChar(key) {
  if (charCache.has(key)) return charCache.get(key);
  const pr = (async () => {
    const mdl = info.characters[key].model;
    const root = new Model(await fetchGame(mdl), mdl);
    const inc = [];
    for (const i of root.includes) {
      const m = new Model(await fetchGame(i), i); inc.push(m);
      for (const j of m.includes) inc.push(new Model(await fetchGame(j), j));
    }
    const char = new Character(root, inc);
    const r = await R.loadCharacter(key, mdl, char);
    const phy = await fetchGame(mdl.replace(/\.mdl$/i, '.phy'));
    return { ...r, gripBone: root.boneByName.get('sword_grip'), phy: phy ? parsePhy(phy) : null };
  })();
  charCache.set(key, pr);
  return pr;
}
customize.ready(); status('Ready.');

// ------------------------------------------------------------ net
let ws, myId = null, started = false;
const snaps = [];
const clockOffset = { v: 0, set: false };
let camYaw = 0, camPitch = 8;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: customize.name, character: customize.char, item: customize.sword, look: customize.look, color: customize.color }));
  ws.onclose = () => { myId = null; started = false; customize.show(false); status('Disconnected from server.', true); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') myId = m.id;
    else if (m.t === 'full') status('Server already has two players.', true);
    else if (m.t === 'snap') {
      snaps.push(m);
      audio.onSnap(m, (key) => charCache.get(key)?._resolved?.char);
      for (const p of m.players) audio.onCombo(p.id, p.ci ?? 0);
      if (snaps.length > 40) snaps.shift();
      const off = m.time - performance.now() / 1000;
      if (!clockOffset.set) { clockOffset.v = off; clockOffset.set = true; } else clockOffset.v += (off - clockOffset.v) * 0.05;
      const me = myId != null && m.players.find((p) => p.id === myId);
      // before the round starts the camera stays on the spawn's facing
      if (me && (!didInitCam || me.fz)) { camYaw = me.y; didInitCam = true; }
      frozen = !!me?.fz;
    } else if (m.t === 'ev') m.ev.forEach(onEvent);
  };
}
let didInitCam = false, frozen = false;

// ------------------------------------------------------------ input
const keys = new Set();
let mouse = 0;
const KEYMAP = { KeyE: IN.THROW, KeyW: IN.FORWARD, KeyS: IN.BACK, KeyA: IN.LEFT, KeyD: IN.RIGHT, Space: IN.JUMP, ControlLeft: IN.ROLL, ControlRight: IN.ROLL, ShiftLeft: IN.SHUFFLE, ShiftRight: IN.SHUFFLE, KeyQ: IN.GRAB, AltLeft: IN.WALK, Digit1: IN.STANCE_FAST, Digit2: IN.STANCE_BAL, Digit3: IN.STANCE_HEAVY };
addEventListener('keydown', (e) => {
  // bb_show_customization: M opens it in a match, and it takes over the screen and the keys until it closes
  if (customize.open) { if (e.code === 'Escape' && started) closeCustomize(); return; }
  if (e.code === 'KeyM' && started) { openCustomize(); return; }
  if (KEYMAP[e.code] !== undefined) { keys.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse = 0; });
const sens = 0.22;
document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { if (!frozen) camYaw = angleNorm(camYaw - e.movementX * sens); camPitch = Math.max(-60, Math.min(70, camPitch + e.movementY * sens)); } });
canvas.addEventListener('mousedown', (e) => { if (customize.open) return; if (document.pointerLockElement !== canvas) { try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* retried on next click */ } if (!window.duelDebug.allowUnlocked) return; } mouse |= e.button === 0 ? IN.ATTACK : e.button === 2 ? IN.BLOCK : 0; });
addEventListener('mouseup', (e) => { mouse &= ~(e.button === 0 ? IN.ATTACK : e.button === 2 ? IN.BLOCK : 0); });
addEventListener('contextmenu', (e) => e.preventDefault());
let seq = 0;
setInterval(() => {
  if (ws?.readyState !== 1 || myId == null) return;
  let b = mouse;
  for (const k of keys) b |= KEYMAP[k];
  if (customize.open) b = 0;
  if (window.duelDebug.forceButtons !== undefined) b = window.duelDebug.forceButtons;
  if (window.duelDebug.forceYaw !== undefined) camYaw = window.duelDebug.forceYaw;
  ws.send(JSON.stringify({ t: 'cmd', s: ++seq, b, y: +camYaw.toFixed(2), p: +camPitch.toFixed(2) }));
}, 15);

// ------------------------------------------------------------ hud/events
const duelHud = await createHud($('hud'), info);
if (params.has('debug')) $('hud').classList.add('debug');
let bannerUntil = 0;
function banner(s, secs = 2) { $('banner').textContent = s; bannerUntil = performance.now() + secs * 1000; }
function logLine(s) { const d = document.createElement('div'); d.textContent = s; $('log').append(d); while ($('log').children.length > 6) $('log').firstChild.remove(); setTimeout(() => d.remove(), 6000); }
const nameOf = (id) => snaps.at(-1)?.players.find((p) => p.id === id)?.n ?? '?';
function onEvent(e) {
  window.duelDebug.lastEvents = (window.duelDebug.lastEvents || []).concat(e.type).slice(-40);
  switch (e.type) {
    case 'round_start': banner(`Round ${e.round}`, 2); break;
    case 'fight': banner('Fight!', 1); break;
    case 'round_end': banner(e.winner == null ? 'Draw' : `${nameOf(e.winner)} wins the round`, 3); break;
    case 'duel_over': banner(e.winner == null ? 'Draw' : `${nameOf(e.winner)} wins the duel`, 8); break;
    case 'hit': logLine(`${nameOf(e.attacker)} hits for ${e.damage}`); break;
    case 'blocked': logLine(`${nameOf(e.victim)} blocks`); break;
    case 'break_block': logLine(`${nameOf(e.victim)}'s guard breaks!`); break;
    case 'parried': logLine('Blades clash'); break;
    case 'grab': logLine(`${nameOf(e.attacker)} grabs ${nameOf(e.victim)}`); break;
    case 'grab_break': logLine('Grab broken'); break;
    case 'intercepted': logLine(`${nameOf(e.defender)} intercepts`); break;
    default:
  }
  fx.onEvent(e, snaps.at(-1)?.players);
  audio.onEvent(e, snaps.at(-1)?.players, myId);
}

// ------------------------------------------------------------ pose + camera math
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, far * near / (near - far), 0];
}
function lookAt(eye, tgt, up) {
  const nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = nrm([eye[0] - tgt[0], eye[1] - tgt[1], eye[2] - tgt[2]]), x = nrm(crs(up, z)), y = crs(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, eye), -dt(y, eye), -dt(z, eye), 1];
}
function mul4(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3]; return o; }

const instances = new Map();
// Crossfades: when the base sequence changes, the old pose stays underneath and the new one fades in
// over the sequence's own fade time (Source's sequence transitions).
function poseOf(ci, an, inst, now) {
  const { char } = ci;
  const layers = animLayers(char, an);
  const seq = layers[0].seq;
  if (inst.seq !== seq) {
    if (inst.seq) inst.fades = [...(inst.fades || []).slice(-1), { seq: inst.seq, cycle: inst.cycle, px: inst.px, py: inst.py, t: now, dur: Math.max(0.05, seq.fadeIn || 0.2) }];
    inst.seq = seq;
  }
  inst.cycle = layers[0].cycle; inst.px = layers[0].px; inst.py = layers[0].py;
  const stack = [];
  const fades = (inst.fades || []).filter((f) => now - f.t < f.dur);
  inst.fades = fades;
  // oldest first; each newer sequence is blended over it by its own elapsed fade
  if (fades.length) {
    stack.push({ seq: fades[0].seq, cycle: fades[0].cycle, weight: 1, px: fades[0].px, py: fades[0].py });
    for (let i = 1; i < fades.length; i++) stack.push({ seq: fades[i].seq, cycle: fades[i].cycle, weight: Math.min(1, (now - fades[i - 1].t) / fades[i - 1].dur), px: fades[i].px, py: fades[i].py });
    layers[0].weight = Math.min(1, (now - fades.at(-1).t) / fades.at(-1).dur);
  }
  // upper layer fades in and out over bb_charge_anim_fade rather than popping
  const up = layers.find((l, i) => i > 0 && l.seq === (an.u ? char.seqForActivity(an.u) : null));
  inst.upW = Math.max(0, Math.min(1, (inst.upW || 0) + (up ? 1 : -1) * (now - (inst.upT ?? now)) / 0.1));
  inst.upT = now;
  if (up) { up.weight = inst.upW; inst.upLast = up; } else if (inst.upW > 0 && inst.upLast) layers.push({ ...inst.upLast, weight: inst.upW });
  return char.evalLayers([...stack, ...layers]);
}
// The fighter's sword and scabbard meshes, once they've loaded. Each fighter gets their own bones.
const swordMeshes = new Map();
window.duelDebug.swordMeshes = swordMeshes;
window.duelDebug.instances = () => instances;
function swordParts(p) {
  const inst = instances.get(p.id);
  if (!inst) return null;
  if (inst.swordItem !== p.it) { inst.swordItem = p.it; inst.swordParts = null; loadSwordParts(p.it).then((list) => { if (inst.swordItem === p.it) inst.swordParts = list.map((mesh) => ({ mesh, bones: R.newBoneBuffer(), shown: true })); }); }
  return inst.swordParts;
}
function loadSwordParts(id) {
  if (!swordMeshes.has(id)) {
    const item = info.swordItems.find((i) => i.id === id);
    const paths = item ? [item.model, item.scabbard].filter(Boolean) : [];
    swordMeshes.set(id, Promise.all(paths.map((path) => R.loadAttachment(path, item.skin))).then((list) => list.filter(Boolean)));
  }
  return swordMeshes.get(id);
}
// What the fighter wears: the body with its skin and body groups, then a part for each item with a model
function lookParts(p, ci) {
  const inst = instances.get(p.id);
  const ids = p.lk ?? [], key = ids.join();
  if (inst.lookKey !== key) {
    inst.lookKey = key; inst.look = []; inst.body = null;
    const items = ids.map((id) => info.lookItems.find((i) => i.id === id)).filter(Boolean);
    const body = new Set(items.map((i) => i.body).filter(Boolean)), skin = items.find((i) => i.kind === 'skin')?.skin ?? 0;
    R.loadBody(info.characters[p.c].model, skin, body).then((mesh) => { if (inst.lookKey === key) inst.body = mesh; });
    Promise.all(items.filter((i) => i.model).map((i) => R.loadAttachment(i.model, i.skin, i.material))).then((list) => {
      if (inst.lookKey === key) inst.look = list.filter(Boolean).map((mesh) => ({ mesh, bones: R.newBoneBuffer(), shown: true }));
    });
  }
  return inst.look;
}
// Thrown weapons: the type's model at its own size (the scripts' "scale" key is never read by the game), playing the
// model's ACT_FLY tumble at the snapshot's position. [I] +X points along the flight; the game's code for that wasn't
// traced. One in hand shows at the fighter's hand until it leaves.
const starMeshes = new Map(), starParts = new Map();
const starMesh = (kind) => {
  if (!starMeshes.has(kind)) { starMeshes.set(kind, null); R.loadAttachment(info.throwables[kind].model, 0).then((m) => { if (m) { m.flight = new Character(m.model, []); starMeshes.set(kind, m); } }); }
  return starMeshes.get(kind);
};
function starPart(key, kind) {
  const mesh = starMesh(kind);
  if (!mesh) return null;
  let part = starParts.get(key);
  if (!part) { part = { mesh, bones: R.newBoneBuffer(), shown: true }; starParts.set(key, part); }
  return part;
}
// The mesh held rigidly by this matrix
const holdStar = (part, m, pos) => {
  for (let i = 0; i < part.mesh.model.bones.length && i < 128; i++) part.bones.data.set(m, i * 12);
  R.lightCharacter({ bones: part.bones }, pos);
};
function flyStar(part, pos, vel, time) {
  const c = part.mesh.flight, seq = c.seqForActivity('ACT_FLY');
  const yaw = Math.atan2(vel[1], vel[0]) / DEG, pitch = -Math.atan2(vel[2], Math.hypot(vel[0], vel[1])) / DEG;
  const dur = seq ? c.seqDuration(seq) : 0;
  const bones = c.boneMatrices(c.evalLayers(seq ? [{ seq, cycle: dur > 0 ? (time / dur) % 1 : 0, weight: 1 }] : []), entityMatrix(pos, [pitch, yaw, 0]));
  bones.forEach((b, i) => { if (i < 128) part.bones.data.set(matMul(b, c.bones[i].poseToBone), i * 12); });
  R.lightCharacter({ bones: part.bones }, pos);
}
const flyingStars = new Set();
function starsFrame(cur, time, attached) {
  const live = new Set();
  for (const s of cur.snap?.pj ?? []) {
    live.add(s.id);
    const part = starPart(s.id, s.k);
    const t = Math.max(0, Math.min(0.1, time - cur.snap.time)), pos = [s.o[0] + s.v[0] * t, s.o[1] + s.v[1] * t, s.o[2] + s.v[2] * t];
    fx.starTrail(s.id, pos, s.v, info.throwables[s.k]);
    audio.pos.set(`star${s.id}`, pos);
    flyingStars.add(s.id);
    if (!part) continue;
    flyStar(part, pos, s.v, time);
    attached.push(part);
  }
  fx.endStarTrails(live);
  // however it ended: a hit, running out of life, or the round restarting
  for (const id of flyingStars) if (!live.has(id)) { audio.endStar(id); flyingStars.delete(id); }
  for (const id of starParts.keys()) if (typeof id === 'number' && !live.has(id)) starParts.delete(id);
}
function frameCharacter(p, ci, world) {
  let inst = instances.get(p.id);
  if (!inst) { inst = { bones: R.newBoneBuffer() }; instances.set(p.id, inst); }
  const pose = inst.rag?.pose ?? poseOf(ci, p.an, inst, performance.now() / 1000);
  // [R client.dll] the same spine lean the server's tracer uses; bb_tracer_pitchaiming_min, max
  let bones = ci.char.boneMatrices(pose, world, { pitch: Math.max(-60, Math.min(40, p.p ?? 0)), yaw: p.y });
  const now = performance.now() / 1000, dt = inst.lastBoneT ? now - inst.lastBoneT : 1 / 60;
  inst.lastBoneT = now;
  // A dead fighter is a ragdoll until the round restarts them
  if (p.a?.n !== 'Kill') inst.rag = null;
  else if (!inst.rag && ci.phy) { inst.rag = new Ragdoll(ci.char, ci.phy, bsp, pose, bones, inst.prevBones, dt, p.v ?? [0, 0, 0]); (window.duelDebug.rags ??= {})[p.id] = inst.rag; }
  inst.prevBones = bones;
  if (inst.rag) { inst.rag.step(Math.min(dt, 0.1)); bones = inst.rag.bones(world); }
  const data = inst.bones.data;
  const src = ci.char.bones;
  for (let i = 0; i < bones.length && i < 128; i++) data.set(matMul(bones[i], src[i].poseToBone), i * 12);
  data.set(lookTint(p), 128 * 12);
  return { bones: inst.bones, mesh: inst.body ?? ci.mesh, world: bones };
}
// Values the charge proxies hand bb_charge, from the character's material
function setCharge(fc, amount, color) {
  const v = fc.mesh.chargeParams || {}, data = fc.bones.data, t = performance.now() / 1000;
  const n = (k, d) => { const x = parseFloat(v[k]); return Number.isNaN(x) ? d : x; };
  const a2 = amount * amount;
  data.set([
    amount, t * n('$chargepulsespeed', 8), t * n('$chargenoiseflowspeed', 25), n('$chargenoiseflowscale', 0.005),
    color[0], color[1], color[2], 1,
    n('$chargenoiseamount', 0.75), n('$chargenoisebasescale', 0.1), n('$chargespecularboost', 1.5), n('$chargeglowboost', 1),
    n('$chargefresnelpowermin', 0.8), n('$chargefresnelpowermax', 4), n('$chargefresnelamountmin', 0.4) + (n('$chargefresnelamountmax', 2) - n('$chargefresnelamountmin', 0.4)) * a2, 0,
    n('$chargedarkenmaxinner', 0.7), n('$chargedarkenmaxouter', 1), 0, 1,
    0, 0, 0, 0,
  ], 128 * 12 + 4);
  fc.charge = amount;
}
// The first entry of the character's colorlist; the game networks the player's choice as m_vecCharacterColor [I: which entry]
// An outfit color from the customization screen stands in for the character's own [I]
function lookColor(p) {
  const item = p.lk?.map((id) => info.lookItems.find((i) => i.id === id)).find((i) => i?.colour);
  if (!item) return null;
  const rgb = item.picker ? p.cc : item.colour.trim().split(/\s+/).map(Number);
  return rgb ? rgb.map((x) => x / 255) : null;
}
// [R client.dll 1802b1510] what materials with the PlayerTint proxy get: the color, and no tint at all for pure white
function lookTint(p) {
  const c = lookColor(p);
  return c && !(c[0] === 1 && c[1] === 1 && c[2] === 1) ? [c[0], c[1], c[2], 1] : [1, 1, 1, 0];
}
function charColor(key) {
  const v = String(info.characters[key]?.color?.color ?? '1 1 1').trim().split(/\s+/).map(Number);
  return [v[0] ?? 1, v[1] ?? 1, v[2] ?? 1];
}
const lerp = (a, b, t) => a + (b - a) * t;
function interpolated(time) {
  // renderTime is ~2 snapshots behind the newest so there's always a pair to blend
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) { if (snaps[i - 1].time <= time) { a = snaps[i - 1]; b = snaps[i]; break; } }
  const t = b.time > a.time ? Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))) : 1;
  return { snap: b, players: b.players.map((pb) => {
    const pa = a.players.find((x) => x.id === pb.id) || pb;
    const cyc = (x, y, same) => { if (!same) return y; let d = y - x; if (d < -0.5) d += 1; return (x + d * t + 1) % 1; };
    const an = { ...pb.an, mx: lerp(pa.an.mx, pb.an.mx, t), my: lerp(pa.an.my, pb.an.my, t), bc: cyc(pa.an.bc, pb.an.bc, pa.an.b === pb.an.b), uc: cyc(pa.an.uc, pb.an.uc, pa.an.u === pb.an.u) };
    return { ...pb, an, o: [lerp(pa.o[0], pb.o[0], t), lerp(pa.o[1], pb.o[1], t), lerp(pa.o[2], pb.o[2], t)], y: pa.y + angleDiff(pb.y, pa.y) * t };
  }) };
}
function bladeTris(out, world, gripBone, color) {
  if (gripBone === undefined) return;
  const m = world[gripBone];
  const pos = [m[3], m[7], m[11]], fwd = [m[0], m[4], m[8]], up = [m[1], m[5], m[9]], rt = [m[2], m[6], m[10]];
  const L = 40;
  const P = (a, u, r) => [pos[0] + fwd[0] * a + up[0] * u + rt[0] * r, pos[1] + fwd[1] * a + up[1] * u + rt[1] * r, pos[2] + fwd[2] * a + up[2] * u + rt[2] * r];
  const quad = (a, b, c, d) => { for (const v of [a, b, c, a, c, d]) out.push(v[0], v[1], v[2], ...color); };
  const a0 = P(0, 0.9, 0.15), a1 = P(0, -0.9, -0.15), b0 = P(L, 0.1, 0), b1 = P(L, -0.1, 0);
  quad(a0, b0, b1, a1);
  const c0 = P(0, 0, 0.8), c1 = P(0, 0, -0.8);
  quad(c0, b0, c1, b1);
}

// ------------------------------------------------------------ customization preview
// [customization.res] the render panel's camera, and the sword wheel [R client.dll 18037b759]: eleven slots turned
// sword_rotation_delta degrees apart about the right axis of sword_angles, on a sword_radius circle around sword_center.
// The middle slot is the chosen sword, by the fighter's hand. [I] the fighter's facing is matched to the reference.
const MENU_EYE = [-76, 35, 26], MENU_LOOK = [10, 0, 36], MENU_FOV = 70, MENU_YAW = 125;
const WHEEL = { center: [50, -70, 48], angles: [10, 115, 25], radius: 100, delta: 10, slots: 11, middle: 5 };
function wheelSlot(i) {
  const a = entityMatrix([0, 0, 0], WHEEL.angles);
  const axis = [a[1], a[5], a[9]].map((x) => -x); // the right vector: matrices hold left in the second column
  const t = (i - WHEEL.middle) * WHEEL.delta * DEG, c = Math.cos(t), sn = Math.sin(t), k = 1 - c, [x, y, z] = axis;
  const turn = [c + x * x * k, x * y * k - z * sn, x * z * k + y * sn, 0, y * x * k + z * sn, c + y * y * k, y * z * k - x * sn, 0, z * x * k - y * sn, z * y * k + x * sn, c + z * z * k, 0];
  const m = matMul(turn, a);
  const f = [m[0], m[4], m[8]], p = WHEEL.center.map((v, n) => v + f[n] * WHEEL.radius);
  const roll = matMul(m, [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0]); // the slot's roll, less 90
  roll[3] = p[0]; roll[7] = p[1]; roll[11] = p[2];
  return roll;
}
const wheelParts = new Map();
function wheelPart(slot, id) {
  let e = wheelParts.get(slot);
  if (!e) { e = { part: null, id: null, bones: R.newBoneBuffer() }; wheelParts.set(slot, e); }
  if (e.id !== id) {
    e.id = id; e.part = null;
    loadSwordParts(id).then((list) => { if (e.id === id && list[0]) e.part = { mesh: list[0], bones: e.bones, shown: true }; });
  }
  return e.part;
}
customize.hooks.onCharacter = () => { menuAnim.t0 = -1; };
const menuAnim = { t0: -1, char: null };
function previewFrame(time) {
  R.loadMenuEnv();
  const parts = [], key = customize.char, p = { id: 'menu', c: key, lk: customize.look, it: customize.sword, cc: customize.color };
  loadChar(key);
  const entry = charCache.get(key);
  if (!entry._resolved) entry.then((v) => { entry._resolved = v; });
  const ci = entry._resolved;
  if (ci) {
    let inst = instances.get('menu');
    if (!inst) { inst = { bones: R.newBoneBuffer() }; instances.set('menu', inst); }
    if (menuAnim.char !== key) { menuAnim.char = key; menuAnim.t0 = -1; inst.lookKey = null; }
    if (menuAnim.t0 < 0) menuAnim.t0 = time;
    // characters.txt names these. A name that's missing, or the model's bare reference pose, falls to the balanced idle [I]
    const c = ci.char, label = (n) => { const s = c.byLabel.get(String(n).toLowerCase()); return s && s.model !== c.root ? s : null; };
    const sel = label(info.characters[key].menuSelect), idle = label(info.characters[key].menuIdle) ?? c.seqForActivity('ACT_BB_B_IDLE') ?? c.seqs[0];
    const dt = time - menuAnim.t0, selDur = sel ? c.seqDuration(sel) : 0;
    const seq = sel && dt < selDur ? sel : idle, dur = c.seqDuration(seq), cycle = seq === sel ? dt / selDur : ((dt - selDur) / (dur || 1)) % 1;
    const world = entityMatrix([0, 0, 0], [0, MENU_YAW, 0]);
    const bones = c.boneMatrices(c.evalLayers([{ seq, cycle: Math.max(0, cycle), weight: 1 }]), world, { pitch: 0, yaw: MENU_YAW });
    bones.forEach((b, i) => { if (i < 128) inst.bones.data.set(matMul(b, c.bones[i].poseToBone), i * 12); });
    inst.bones.data.set(lookTint(p), 128 * 12);
    R.menuLights(inst.bones);
    const fc = { bones: inst.bones, mesh: null, world: bones };
    const look = lookParts(p, ci);
    fc.mesh = inst.body ?? ci.mesh;
    parts.push(fc);
    for (const part of look) { R.attachTo(fc, part, c); if (part.shown) parts.push(part); }
    // the sword itself is on the wheel; the fighter only shows its scabbard
    const held = swordParts(p);
    if (held) for (const part of held.slice(1)) { R.attachTo(fc, part, c); if (part.shown) parts.push(part); }
    const list = customize.list, at = Math.max(0, list.indexOf(customize.sword));
    for (let i = 0; i < WHEEL.slots; i++) {
      const part = wheelPart(i, list[(at + (i - WHEEL.middle) + list.length * 12) % list.length]);
      if (!part) continue;
      // the slot places the sword's grip bone, as a fighter's hand does
      const m = matMul(wheelSlot(i), part.mesh.model.bones[0].poseToBone);
      for (let b = 0; b < part.mesh.model.bones.length && b < 128; b++) part.bones.data.set(m, b * 12);
      part.bones.data.set(lookTint(p), 128 * 12);
      R.menuLights(part.bones);
      parts.push(part);
    }
  }
  const aspect = canvas.width / canvas.height, fovY = 2 * Math.atan(Math.tan(MENU_FOV * DEG / 2) / aspect);
  const vp = mul4(perspective(fovY, aspect, 4, 4000), lookAt(MENU_EYE, MENU_LOOK, [0, 0, 1]));
  R.frame({ vp, eye: MENU_EYE, fwd: norm3(MENU_LOOK.map((v, i) => v - MENU_EYE[i])), fovY, characters: parts, tris: [], preview: true });
}

// ------------------------------------------------------------ frame loop
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
let lastFrame = performance.now();
let frames = 0, fpsT = performance.now(), fps = 0;
const camHull = { mn: [-4, -4, -4], mx: [4, 4, 4] };
async function tick() {
  requestAnimationFrame(tick);
  frames++;
  const now = performance.now();
  if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; window.duelDebug.fps = fps; }
  if (customize.open) { previewFrame(now / 1000); return; }
  let eye = [0, 0, 100], tgt = [100, 0, 100];
  const characters = [], tris = [], attached = [];
  let me = null, cur = null;
  if (snaps.length) {
    const renderTime = now / 1000 + clockOffset.v - 0.05;
    cur = interpolated(renderTime);
    for (const p of cur.players) {
      if (p.id === myId) me = p;
      const ciP = loadChar(p.c);
      ciP.then((v) => { p._ci = v; });
      const ci = charCache.get(p.c)?._resolved;
      if (!ci) { charCache.get(p.c)?.then((v) => { charCache.get(p.c)._resolved = v; }); continue; }
      const world = entityMatrix(p.o, [0, p.y, 0]);
      const fc = frameCharacter(p, ci, world);
      R.lightCharacter(fc, p.o);
      const color = lookColor(p) ?? charColor(p.c);
      const st = fx.updatePlayer(p, ci.char, fc.world, ci.gripBone, color);
      setCharge(fc, st.charge, color);
      characters.push(fc);
      for (const part of lookParts(p, ci)) { R.attachTo(fc, part, ci.char); if (part.shown) attached.push(part); }
      if (p.a?.th) {
        const kind = info.charThrowable[p.c], part = kind && starPart(`hand${p.id}`, kind), att = ci.char.root.attachments.find((x) => x.name === 'anim_attachment_LH');
        if (part && att) { holdStar(part, matMul(fc.world[att.bone], att.local), p.o); attached.push(part); }
      }
      const held = swordParts(p);
      if (held) for (const part of held) { R.attachTo(fc, part, ci.char); if (part.shown) attached.push(part); }
      else bladeTris(tris, fc.world, ci.gripBone, p.a?.ph === 'swing' ? [1, 0.95, 0.7, 1] : [0.85, 0.87, 0.92, 1]);
    }
    starsFrame(cur, renderTime, attached);
  }
  if (me) {
    const { forward: f } = angleVectors([camPitch, camYaw, 0]);
    const head = [me.o[0], me.o[1], me.o[2] + 62];
    const { right: r } = angleVectors([0, camYaw, 0]);
    const orbit = [head[0] + r[0] * 18, head[1] + r[1] * 18, head[2]];
    const wanted = [orbit[0] - f[0] * 110, orbit[1] - f[1] * 110, orbit[2] - f[2] * 110];
    const tr = bsp.traceBox(orbit, wanted, camHull.mn, camHull.mx, 1);
    eye = tr.endpos;
    tgt = [orbit[0] + f[0] * 100, orbit[1] + f[1] * 100, orbit[2] + f[2] * 100];
  } else {
    const s = bsp.entities.find((e) => e.classname === 'berimbau_spawn');
    if (s) { const o = s.origin.split(' ').map(Number); eye = [o[0], o[1], o[2] + 140]; const a = now / 4000; tgt = [o[0] + Math.cos(a) * 300, o[1] + Math.sin(a) * 300, o[2] + 60]; }
  }
  if (window.duelDebug.cam) { eye = window.duelDebug.cam.eye; tgt = window.duelDebug.cam.tgt; }
  const aspect = canvas.width / canvas.height;
  const vp = mul4(perspective(75 * DEG, aspect, 4, 16000), lookAt(eye, tgt, [0, 0, 1]));
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  fx.localPos = me?.o;
  fx.step(dt);
  const F = norm3([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]), RT = norm3([F[1], -F[0], 0]), UP = [RT[1] * F[2] - RT[2] * F[1], RT[2] * F[0] - RT[0] * F[2], RT[0] * F[1] - RT[1] * F[0]];
  audio.frame(eye, RT);
  const built = fx.build(eye, RT, UP, Math.tan(37.5 * DEG));
  R.frame({ vp, eye, fwd: F, fovY: 75 * DEG, characters: characters.concat(attached), tris, fx: { verts: fx.verts, count: built.count, draws: built.draws } });
  if (cur) hud(cur, me);
  window.duelDebug.state = { snaps: snaps.length, myId, chars: characters.length, duel: cur?.snap?.duel, stats: R.stats, eye, me: me && { o: me.o, a: me.a, hp: me.hp, an: me.an } };
}
let lastHudAt = performance.now();
function hud(cur, me) {
  const now = performance.now(), dt = (now - lastHudAt) / 1000;
  lastHudAt = now;
  duelHud?.update(cur, me, myId, dt);
  if (now > bannerUntil) $('banner').textContent = '';
  $('hint').textContent = me?.kn && !me.a ? 'Downed: Space get up, Mouse1 recovery attack, Mouse2 intercept, WASD roll' : '';
  $('net').textContent = `${window.duelDebug.fps ?? 0} fps`;
}
requestAnimationFrame(tick);

function openCustomize() {
  keys.clear(); mouse = 0;
  document.exitPointerLock?.();
  $('hud').style.display = 'none';
  customize.show(true);
}
function closeCustomize() {
  customize.hide();
  $('hud').style.display = 'block';
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* needs a user gesture; the next click locks */ }
}
customize.onCancel(closeCustomize);
customize.onConfirm(() => {
  if (started) {
    ws?.send(JSON.stringify({ t: 'loadout', character: customize.char, item: customize.sword, look: customize.look, color: customize.color }));
    banner('Loadout changes next round');
    closeCustomize();
    return;
  }
  started = true;
  audio.start();
  customize.hide();
  $('hud').style.display = 'block';
  loadChar(customize.char);
  for (const k of Object.keys(info.characters)) loadChar(k);
  connect();
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* needs a user gesture; the next click locks */ }
});
if (params.has('auto')) $('go').click();
