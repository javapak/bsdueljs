// Browser client: input -> server, snapshots -> interpolated rendering.
import { BSP } from '/shared/bsp.js';
import { Model, Character } from '/shared/mdl.js';
import { IN, animLayers } from '/shared/sim.js';
import { entityMatrix, matMul, rigidInverse, angleVectors, DEG, angleDiff, angleNorm } from '/shared/mathx.js';
import { Renderer } from './render.js';
import { FX } from './fx.js';
import { createHud } from './hud.js';
import { createCustomize } from './customize.js';
import { createSpectator } from './spectator.js';
import { createScoreboard } from './scoreboard.js';
import { Audio } from './audio.js';
import { parsePhy, Ragdoll } from '/shared/ragdoll.js';
import { TracerPreview, OPACITY, buildPath } from '/shared/tracerpreview.js';
import { ThirdPersonCamera } from './camera.js';
import { startP2PMatch } from './p2pgame.js';
import { createPauseMenu } from './pausemenu.js';
import { cvar, onCvar, boundTo, loadDefaultBinds } from './settings.js';

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
R.loadTracerPreview().catch(() => {});
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
// A person in the world plays; anyone else on the server watches an arena
let spectating = true;
const sendReady = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ready', arena: spectator.view.arena })); };
const mapName = String(info.map).replace(/^duel_/, '').replace(/_/g, ' ');
const spectator = createSpectator(document.body, { mapName, onReady: () => sendReady(), onCustomize: () => openCustomize() });
// +score: held on Tab
const scoreboard = createScoreboard(document.body, {
  title: `Blade Symphony Duel - ${mapName}`,
  onJoin: (i) => { spectator.view.arena = i; sendReady(); },
  onView: (i) => { spectator.view.arena = i; },
});
const snaps = [];
const clockOffset = { v: 0, set: false };
let camYaw = 0, camPitch = 0, camView = null;
const thirdPerson = new ThirdPersonCamera((a, b, mn, mx, mask) => bsp.traceBox(a, b, mn, mx, mask));
let myChest = null;
let pauseMenu = null;
/** [R 180333bcd] The options the server keeps per fighter, as it reads them off a client. */
function sendOptions() { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'options', gae: !!cvar('bb_gae'), sde: !!cvar('bb_sde'), ibt: cvar('bb_ibt') })); }
onCvar((name) => { if (name === 'bb_gae' || name === 'bb_sde' || name === 'bb_ibt') sendOptions(); if (name === 'mat_monitorgamma') applyGamma(); });
/** [I] mat_monitorgamma the way Source's ramp works, x^(2.2 / gamma), as a filter on the finished picture. */
function applyGamma() {
  const g = cvar('mat_monitorgamma');
  for (const id of ['gR', 'gG', 'gB']) $(id).setAttribute('exponent', 2.2 / g);
  canvas.style.filter = g === 2.2 ? '' : 'url(#gamma)';
}
applyGamma();
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: customize.name, character: customize.char, item: customize.sword, look: customize.look, color: customize.color }));
  ws.onclose = () => { myId = null; started = false; customize.show(false); status('Disconnected from server.', true); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') { myId = m.id; sendOptions(); if (params.has('ready')) sendReady(); }
    else if (m.t === 'full') status('Server already has two players.', true);
    else if (m.t === 'snap') onSnapshot(m);
    else if (m.t === 'ev') m.ev.forEach(onEvent);
  };
}
/**
 * A new state to draw, from the server or a peer to peer session here.
 * @param {object} m The snapshot.
 */
function onSnapshot(m) {
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
}
// ?p2p=room&relay=ws://host:27016 plays the person in that room directly, with no server in the fight. ?stun=stun:host:port helps across the internet.
const p2pRoom = params.get('p2p');
// ?delay= sets this player's input delay in ticks, and ?rollback= how far back their game rewinds
const whole = (name, dflt, lo, hi) => { const n = parseInt(params.get(name) ?? '', 10); return Number.isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n)); };
let p2pMatch = null;
/** Finds the other player and starts the match. The rest of the client just sees snapshots and events. */
async function connectP2P() {
  try {
    p2pMatch = await startP2PMatch({
      relay: params.get('relay') ?? `ws://${location.hostname}:27016`, room: p2pRoom, bsp, mapBytes: bspBytes, read: (p) => fetchGame(p),
      hello: { name: customize.name, character: customize.char, item: customize.sword, look: customize.look, color: customize.color, options: { gae: !!cvar('bb_gae'), sde: !!cvar('bb_sde'), ibt: cvar('bb_ibt') } },
      iceServers: params.has('stun') ? [{ urls: params.get('stun') }] : [], inputDelay: whole('delay', 2, 0, 8), maxRollback: whole('rollback', 8, 1, 16),
      input: readInput, onSnapshot, onEvent, onStatus: (s, bad) => { if (s) banner(s, bad ? 8 : 60); },
    });
    myId = p2pMatch.myId;
    window.duelDebug.p2p = p2pMatch;
  } catch (e) { console.error(e); banner(e.message, 60); }
}
let didInitCam = false, frozen = false;

// ------------------------------------------------------------ input
const keys = new Set();
/** Reads one of the game's text files, which may be UTF-16. */
const gameText = async (path) => { const b = new Uint8Array(await fetchGame(path)); return new TextDecoder(b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : 'latin1').decode(b); };
loadDefaultBinds(await gameText('cfg/config_default.cfg'));
// What each of the game's commands holds down, by the names in scripts/kb_act.lst
const COMMAND_BITS = { '+attack': IN.ATTACK, '+block': IN.BLOCK, '+attack2': IN.THROW, '+forward': IN.FORWARD, '+back': IN.BACK, '+moveleft': IN.LEFT, '+moveright': IN.RIGHT, '+jump': IN.JUMP, '+duck': IN.ROLL, '+shuffle': IN.SHUFFLE, '+grab': IN.GRAB, '+walk': IN.WALK, '+reverse': IN.STANCE_FAST, '+balanced': IN.STANCE_BAL, '+heavy': IN.STANCE_HEAVY, '+sheathe': IN.SHEATHE, '+bow': IN.BOW, '+flourish': IN.FLOURISH, '+taunt': IN.TAUNT, '+sit': IN.SIT };
// [I] the order the stance keys and the HUD give them. Slots: 1 fast, 0 balanced, 2 heavy.
const STANCE_ORDER = [1, 0, 2], STANCE_BITS = [IN.STANCE_BAL, IN.STANCE_FAST, IN.STANCE_HEAVY];
// A wheel notch has no key-up, and neither does a next or previous stance, so they hold their button a couple of ticks
const pulses = [];
const pulse = (bit) => pulses.push({ bit, until: performance.now() + 40 });
/**
 * @param {number} step 1 for +nextstance, -1 for +prevstance.
 */
function cycleStance(step) {
  const now = snaps.at(-1)?.players.find((p) => p.id === myId)?.gs ?? 0;
  pulse(STANCE_BITS[STANCE_ORDER[(STANCE_ORDER.indexOf(now) + step + 3) % 3]]);
}
/**
 * Runs a key's one-shot command, if it has one.
 * @param {string} code The key.
 * @param {boolean} repeat An auto-repeat rather than a real press.
 * @returns {boolean} Whether it was one.
 */
function runCommand(code, repeat) {
  const cmd = boundTo(code);
  if (cmd === 'bb_show_customization') { if (started) openCustomize(); return true; }
  if (cmd === 'vs_ready') { if (started && !repeat) sendReady(); return true; }
  if (cmd === '+score') { if (started) scoreboard.show(true, spectating); return true; }
  if (cmd === '+nextstance' || cmd === '+prevstance') { if (!repeat) cycleStance(cmd === '+nextstance' ? 1 : -1); return true; }
  return false;
}
addEventListener('keydown', (e) => {
  // bb_show_customization: M opens it in a match, and it takes over the screen and the keys until it closes
  if (customize.open) { if (e.code === 'Escape' && started) closeCustomize(); return; }
  if (pauseMenu?.open) { if (pauseMenu.handleKey(e.code)) e.preventDefault(); return; }
  if (e.code === 'Escape' && started) { openPause(); return; }
  // text fields keep their keys, whatever state the game is in
  if (e.target instanceof HTMLInputElement) return;
  if (spectating && started) {
    // a button clicked earlier keeps focus, and Space would press it too
    if (e.code === 'Space') { e.preventDefault(); document.activeElement?.blur?.(); if (!e.repeat) spectator.toggle(); return; }
    if (e.code === 'ArrowLeft') { spectator.cycle(-1); return; }
    if (e.code === 'ArrowRight') { spectator.cycle(1); return; }
  }
  if (runCommand(e.code, e.repeat)) { e.preventDefault(); return; }
  if (COMMAND_BITS[boundTo(e.code)] !== undefined) { keys.add(e.code); e.preventDefault(); }
});
addEventListener('keyup', (e) => { keys.delete(e.code); if (boundTo(e.code) === '+score') scoreboard.show(false); });
addEventListener('blur', () => { keys.clear(); scoreboard.show(false); });
/**
 * [R client 1801d0f05] Counts to degrees: m_customaccel 3 raises the speed to m_customaccel_exponent, 0 doesn't, and the yaw and pitch
 * factors take it from there.
 * @param {number} x Mouse counts across.
 * @param {number} y Mouse counts down.
 * @returns {number[]} Degrees of yaw and pitch to add.
 */
function mouseDegrees(x, y) {
  let s = cvar('sensitivity');
  if (cvar('m_customaccel') === 3) s *= Math.pow(x * x + y * y, Math.max(0, (cvar('m_customaccel_exponent') - 1) * 0.5));
  return [x * s * cvar('m_yaw'), y * s * cvar('m_pitch')];
}
/** Takes the mouse. m_rawinput asks the browser for unaccelerated counts where it can, and it's fine if it can't. */
function lockMouse() {
  const plain = () => { try { canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* retried on next click */ } };
  try {
    const asked = cvar('m_rawinput') ? canvas.requestPointerLock({ unadjustedMovement: true }) : canvas.requestPointerLock();
    if (asked?.catch) asked.catch(() => { if (cvar('m_rawinput')) plain(); });
  } catch { plain(); }
}
document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { const [dy, dp] = mouseDegrees(e.movementX, e.movementY); if (!frozen) camYaw = angleNorm(camYaw - dy); camPitch = thirdPerson.clampPitch(camPitch + dp); } });
// The browser's button numbers against the game's MOUSE1 to MOUSE5
const MOUSE_CODE = ['Mouse1', 'Mouse3', 'Mouse2', 'Mouse4', 'Mouse5'];
canvas.addEventListener('mousedown', (e) => {
  if (customize.open || spectating || pauseMenu?.open) return;
  if (document.pointerLockElement !== canvas) { lockMouse(); if (!window.duelDebug.allowUnlocked) return; }
  const code = MOUSE_CODE[e.button];
  if (!runCommand(code, false) && COMMAND_BITS[boundTo(code)] !== undefined) keys.add(code);
});
addEventListener('mousedown', (e) => { if (pauseMenu?.open && pauseMenu.handleKey(MOUSE_CODE[e.button])) e.preventDefault(); }, true);
addEventListener('mouseup', (e) => { const code = MOUSE_CODE[e.button]; keys.delete(code); if (boundTo(code) === '+score') scoreboard.show(false); });
addEventListener('wheel', (e) => {
  const code = e.deltaY < 0 ? 'WheelUp' : 'WheelDown';
  if (pauseMenu?.open) { if (e.deltaY && pauseMenu.handleKey(code)) e.preventDefault(); return; }
  if (customize.open || !e.deltaY || document.pointerLockElement !== canvas) return;
  if (!runCommand(code, false) && COMMAND_BITS[boundTo(code)] !== undefined) pulse(COMMAND_BITS[boundTo(code)]);
}, { passive: false });
// The browser's own Escape lets go of the mouse without a key event, and that's the pause key
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== canvas && started && !customize.open && !spectating && !pauseMenu?.open) openPause(); });
function openPause() { keys.clear(); pulses.length = 0; pauseMenu?.show(true); scoreboard.show(false); document.exitPointerLock?.(); }
function closePause() { pauseMenu?.show(false); if (!spectating && document.pointerLockElement !== canvas) lockMouse(); }
addEventListener('contextmenu', (e) => e.preventDefault());
let seq = 0;
/**
 * @returns {number[]} This player's buttons, yaw and pitch right now.
 */
function readInput() {
  let b = 0;
  for (const k of keys) b |= COMMAND_BITS[boundTo(k)] ?? 0;
  const nowMs = performance.now();
  while (pulses.length && pulses[0].until < nowMs) pulses.shift();
  for (const p of pulses) b |= p.bit;
  if (customize.open || spectating || pauseMenu?.open) b = 0;
  if (window.duelDebug.forceButtons !== undefined) b = window.duelDebug.forceButtons;
  if (window.duelDebug.forceYaw !== undefined) camYaw = window.duelDebug.forceYaw;
  const [aimPitch, aimYaw] = thirdPerson.aim(camView ?? [camPitch, camYaw, 0]);
  return [b, +angleNorm(aimYaw).toFixed(2), +aimPitch.toFixed(2)];
}
setInterval(() => {
  if (ws?.readyState !== 1 || myId == null) return;
  const [b, y, p] = readInput();
  ws.send(JSON.stringify({ t: 'cmd', s: ++seq, b, y, p, e: snaps.at(-1)?.time }));
}, 15);

pauseMenu = await createPauseMenu({
  read: gameText, onResume: closePause, onPlay: () => sendReady(),
  onCustomize: () => { pauseMenu.show(false); openCustomize(); },
  onDisconnect: () => { ws?.close(); location.reload(); },
});
R.renderSize = pauseMenu.resolution();
pauseMenu.onResolution = (r) => { R.renderSize = r; };

// ------------------------------------------------------------ hud/events
const duelHud = await createHud($('hud'), info);
if (params.has('debug')) $('hud').classList.add('debug');
let bannerUntil = 0;
function banner(s, secs = 2) { $('banner').textContent = s; bannerUntil = performance.now() + secs * 1000; }
function logLine(s) { const d = document.createElement('div'); d.textContent = s; $('log').append(d); while ($('log').children.length > 6) $('log').firstChild.remove(); setTimeout(() => d.remove(), 6000); }
const nameOf = (id) => snaps.at(-1)?.players.find((p) => p.id === id)?.n ?? '?';
function onEvent(e) {
  window.duelDebug.lastEvents = (window.duelDebug.lastEvents || []).concat(e.type).slice(-40);
  // what an arena announces is for those watching it
  if (e.arena !== undefined && e.arena !== spectator.view.arena) return;
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
/**
 * Crossfades: when the base sequence changes, the old pose stays underneath and the new one fades in
 * over the sequence's own fade time (Source's sequence transitions).
 * @param {object} ci The loaded character.
 * @param {object} an The snapshot's animation state.
 * @param {object} inst This fighter's client state.
 * @param {number} now Time in seconds.
 * @returns {{P: number[][], Q: number[][]}} The pose.
 */
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
/**
 * @param {object} p A fighter from the snapshot.
 * @returns {Array<object>|null} Sword and scabbard parts, once loaded.
 */
function swordParts(p) {
  const inst = instances.get(p.id);
  if (!inst) return null;
  if (inst.swordItem !== p.it) { inst.swordItem = p.it; inst.swordParts = null; loadSwordParts(p.it).then((list) => { if (inst.swordItem === p.it) inst.swordParts = list.map((mesh) => ({ mesh, bones: R.newBoneBuffer(), shown: true, held: true })); }); }
  return inst.swordParts;
}
/**
 * [R client 1802c79ec, 1802c7685] Where the sword's mount is, whether it's on it or in the hand until all the way in, and
 * the sequence for the few swords that animate. [I] the sheathe and draw follow the fighter's layer rather than their own clock.
 * @param {object} p A fighter from the snapshot.
 * @returns {{mount: string, sheathed: boolean, act: string, cycle: number}} Its state.
 */
function swordState(p) {
  const mount = info.swordItems.find((i) => i.id === p.it)?.hip ? 'anim_sheathe_hip' : 'anim_sheathe_back';
  const sh = p.an?.sh, moving = sh && sh[1] < 1 && !sh[0].endsWith('_GRIP');
  const act = p.shd ? 'ACT_BB_SWORD_IDLE_SHEATHED' : moving ? (sh[0].includes('_UNSHEATHE_') ? 'ACT_BB_SWORD_UNSHEATHE' : 'ACT_BB_SWORD_SHEATHE') : 'ACT_BB_SWORD_IDLE';
  return { mount, sheathed: !!p.shd, act, cycle: moving ? sh[1] : 0 };
}
function loadSwordParts(id) {
  if (!swordMeshes.has(id)) {
    const item = info.swordItems.find((i) => i.id === id);
    const paths = item ? [item.model, item.scabbard].filter(Boolean) : [];
    swordMeshes.set(id, Promise.all(paths.map((path) => R.loadAttachment(path, item.skin))).then((list) => list.filter(Boolean)));
  }
  return swordMeshes.get(id);
}
/**
 * What the fighter wears: the body with its skin and body groups, then a part for each item with a model
 * @param {object} p A fighter from the snapshot.
 * @param {object} ci The loaded character.
 * @returns {object[]} The parts with a model, once loaded.
 */
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
/**
 * One fighter's bones this frame, including starting and running their ragdoll on death.
 * @param {object} p A fighter from the snapshot.
 * @param {object} ci The loaded character.
 * @param {number[]} world The entity's matrix.
 * @returns {{bones: object, mesh: object, world: number[][]}} What to draw.
 */
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
/**
 * Values the charge proxies hand bb_charge, from the character's material
 * [R client 1802b0e4b] during the dash's cooldown, after the dash itself, a rim beats on the fighter: $CHARGEEXTRARIMLIGHT*, its color 255 79 79
 * [I] the amplitude: 1.5 instead when a check on the game mode passes, which wasn't identified
 * @param {object} p A fighter from the snapshot.
 * @returns {number} Rim strength.
 */
function dashRim(p) { return p.dc > 0 && p.a?.n !== 'AirDash' ? Math.abs(Math.sin(p.dc * 5)) * 0.75 : 0; }
function setCharge(fc, amount, color, rim = 0) {
  const v = fc.mesh.chargeParams || {}, data = fc.bones.data, t = performance.now() / 1000;
  const n = (k, d) => { const x = parseFloat(v[k]); return Number.isNaN(x) ? d : x; };
  const a2 = amount * amount;
  data.set([
    amount, t * n('$chargepulsespeed', 8), t * n('$chargenoiseflowspeed', 25), n('$chargenoiseflowscale', 0.005),
    color[0], color[1], color[2], 1,
    n('$chargenoiseamount', 0.75), n('$chargenoisebasescale', 0.1), n('$chargespecularboost', 1.5), n('$chargeglowboost', 1),
    n('$chargefresnelpowermin', 0.8), n('$chargefresnelpowermax', 4), n('$chargefresnelamountmin', 0.4) + (n('$chargefresnelamountmax', 2) - n('$chargefresnelamountmin', 0.4)) * a2, 0,
    n('$chargedarkenmaxinner', 0.7), n('$chargedarkenmaxouter', 1), rim, 2,
    255, 79, 79, 0,
  ], 128 * 12 + 4);
  fc.charge = amount;
  fc.rim = rim;
}
/**
 * The first entry of the character's colorlist; the game networks the player's choice as m_vecCharacterColor [I: which entry]
 * An outfit color from the customization screen stands in for the character's own [I]
 * @param {object} p A fighter from the snapshot.
 * @returns {number[]} The color.
 */
function lookColor(p) {
  const item = p.lk?.map((id) => info.lookItems.find((i) => i.id === id)).find((i) => i?.colour);
  if (!item) return null;
  const rgb = item.picker ? p.cc : item.colour.trim().split(/\s+/).map(Number);
  return rgb ? rgb.map((x) => x / 255) : null;
}
/**
 * [R client.dll 1802b1510] what materials with the PlayerTint proxy get: the color, and no tint at all for pure white
 * @param {object} p A fighter from the snapshot.
 * @returns {number[]} The tint.
 */
function lookTint(p) {
  const c = lookColor(p);
  return c && !(c[0] === 1 && c[1] === 1 && c[2] === 1) ? [c[0], c[1], c[2], 1] : [1, 1, 1, 0];
}
function charColor(key) {
  const v = String(info.characters[key]?.color?.color ?? '1 1 1').trim().split(/\s+/).map(Number);
  return [v[0] ?? 1, v[1] ?? 1, v[2] ?? 1];
}
const lerp = (a, b, t) => a + (b - a) * t;
/**
 * Fighters between the two snapshots around a time, which hides that snapshots come 32 times a second.
 * @param {number} time Server time to show.
 * @returns {{snap: object, players: object[]}} The newer snapshot, with blended fighters.
 */
function interpolated(time) {
  // renderTime is ~2 snapshots behind the newest so there's always a pair to blend
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i > 0; i--) { if (snaps[i - 1].time <= time) { a = snaps[i - 1]; b = snaps[i]; break; } }
  const t = b.time > a.time ? Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time))) : 1;
  return { snap: b, players: b.players.map((pb) => {
    const pa = a.players.find((x) => x.id === pb.id) || pb;
    const cyc = (x, y, same) => { if (!same) return y; let d = y - x; if (d < -0.5) d += 1; const v = x + d * t; return v > 1 ? v - 1 : v; }; // a cycle held at 1 stays there
    const an = { ...pb.an, mx: lerp(pa.an.mx, pb.an.mx, t), my: lerp(pa.an.my, pb.an.my, t), bc: cyc(pa.an.bc, pb.an.bc, pa.an.b === pb.an.b), uc: cyc(pa.an.uc, pb.an.uc, pa.an.u === pb.an.u), sh: pb.an.sh && pa.an.sh?.[0] === pb.an.sh[0] ? [pb.an.sh[0], lerp(pa.an.sh[1], pb.an.sh[1], t), lerp(pa.an.sh[2], pb.an.sh[2], t)] : pb.an.sh };
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
    const held = swordParts(p);
    if (held) for (const part of held) { R.attachTo(fc, part, c, swordState(p)); if (part.shown) parts.push(part); }
    const list = customize.list, at = Math.max(0, list.indexOf(customize.sword));
    for (let i = 0; i < WHEEL.slots; i++) {
      const part = wheelPart(i, list[(at + (i - WHEEL.middle) + list.length * 12) % list.length]);
      if (!part) continue;
      // the slot places the sword's grip bone, as a fighter's hand does
      const { model } = part.mesh, pose = model.idlePose(), root = matMul(wheelSlot(i), rigidInverse(pose.world[model.boneByName.get('sword_grip') ?? 0]));
      for (let b = 0; b < model.bones.length && b < 128; b++) part.bones.data.set(matMul(matMul(root, pose.world[b]), model.bones[b].poseToBone), b * 12);
      part.bones.data.set(lookTint(p), 128 * 12);
      R.menuLights(part.bones);
      parts.push(part);
    }
  }
  const aspect = canvas.width / canvas.height, fovY = 2 * Math.atan(Math.tan(MENU_FOV * DEG / 2) / aspect);
  const vp = mul4(perspective(fovY, aspect, 4, 4000), lookAt(MENU_EYE, MENU_LOOK, [0, 0, 1]));
  R.frame({ vp, eye: MENU_EYE, fwd: norm3(MENU_LOOK.map((v, i) => v - MENU_EYE[i])), fovY, characters: parts, tris: [], preview: true });
}

// ------------------------------------------------------------ spectator camera
// berimbau_spectator_camera, by the arena it names. [R client.dll 18027b900] 85 degrees (bb_cam_dueloverview_fov), its angles
// easing at 14 per second (bb_cam_dueloverview_angleslerp_speed), and it cuts between arenas: animating that is off by default.
// [I] a map with two cameras on one arena uses the first, and the camera holds the entity's own angles.
const arenaCams = bsp.entities.filter((e) => e.classname === 'berimbau_spectator_camera');
const specLook = { dir: null };
/**
 * @param {object} cur The interpolated frame.
 * @param {number} now Time in milliseconds.
 * @returns {Array} [eye, target, vertical fov in radians].
 */
function spectatorCamera(cur, now) {
  const view = spectator.view, d = cur.snap.arenas?.[view.arena];
  const follow = view.mode === 'player' ? cur.players.find((p) => p.id === view.follow) : null;
  if (follow) {
    const { forward: f } = angleVectors([follow.p ?? 0, follow.y, 0]), head = [follow.o[0], follow.o[1], follow.o[2] + 62];
    const wanted = [head[0] - f[0] * 110, head[1] - f[1] * 110, head[2] - f[2] * 110];
    return [bsp.traceBox(head, wanted, camHull.mn, camHull.mx, 1).endpos, [head[0] + f[0] * 100, head[1] + f[1] * 100, head[2] + f[2] * 100], 75 * DEG];
  }
  const cam = arenaCams.find((c) => c.duel === d?.tn) ?? arenaCams[0];
  if (!cam) return [[0, 0, 100], [100, 0, 100], 75 * DEG];
  const eye = cam.origin.split(' ').map(Number), [p, y] = (cam.angles ?? '0 0 0').split(' ').map(Number);
  const want = angleVectors([p, y, 0]).forward;
  const dt = Math.min(0.1, (now - (specLook.t ?? now)) / 1000); specLook.t = now;
  const k = Math.min(1, 14 * dt), was = specLook.dir && specLook.eye === cam ? specLook.dir : want;
  specLook.eye = cam;
  specLook.dir = norm3(was.map((v, i) => v + (want[i] - v) * k));
  const hFov = 85 * DEG, vFov = 2 * Math.atan(Math.tan(hFov / 2) * 0.75); // Source's fov is the width of a 4:3 view
  return [eye, eye.map((v, i) => v + specLook.dir[i] * 100), vFov];
}

/**
 * [R client 18028ac20] an arena's preview: its camera (server 180327d4d copies m_vecPreviewOrigin and m_angPreviewAngles
 * from the first one), fov 90 straight across the view since this path skips the 4:3 scaling, near 10, far 10000
 * @param {object} d An arena from the snapshot.
 * @param {number} aspect The cell's width over height.
 * @returns {object|null} The view, or null without a camera.
 */
function previewView(d, aspect) {
  const cam = arenaCams.find((c) => c.duel === d.tn) ?? arenaCams[0];
  if (!cam) return null;
  const eye = cam.origin.split(' ').map(Number), [p, y] = (cam.angles ?? '0 0 0').split(' ').map(Number);
  const fwd = angleVectors([p, y, 0]).forward, fovY = 2 * Math.atan(1 / aspect);
  return { eye, fwd, fovY, near: 10, far: 10000, vp: mul4(perspective(fovY, aspect, 10, 10000), lookAt(eye, eye.map((v, i) => v + fwd[i] * 100), [0, 0, 1])) };
}

// [R client 1802c3920] the attack preview is for the local fighter, while alive
const attackPreview = new TracerPreview();
/**
 * @param {object} [me] The local fighter.
 * @param {object} cur The interpolated frame.
 * @param {number} dt Seconds.
 * @returns {object|null} The attack preview to draw.
 */
function previewFrameData(me, cur, dt) {
  const ci = me && charCache.get(me.c)?._resolved, want = me?.al && cvar('bb_tracerPreview_enabled') ? snaps.at(-1)?.pv ?? null : null;
  attackPreview.update(dt, ci ? want : null, me?.a?.ph === 'swing', (w) => buildPath(ci.char, ci.gripBone, w.a, w.l, info.tracers[me.c]?.[String(w.a).toUpperCase()]));
  if (!me) return null;
  const aim = Math.max(-60, Math.min(40, me.p ?? 0));
  attackPreview.highlight(dt, me.o, aim, me.y, cur.players.filter((p) => p.id !== me.id && p.al && (p.ar ?? 0) === (me.ar ?? 0)).map((p) => p.o));
  const d = attackPreview.draw(me.o, aim, me.y);
  return d && { ...d, opacity: OPACITY };
}

// ------------------------------------------------------------ frame loop
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
let lastFrame = performance.now();
let frames = 0, fpsT = performance.now(), fps = 0;
const camHull = { mn: [-4, -4, -4], mx: [4, 4, 4] };
/**
 * One rendered frame: choose the camera, pose every fighter in view, then draw and update the HUD.
 */
async function tick() {
  requestAnimationFrame(tick);
  frames++;
  const now = performance.now();
  if (now - fpsT > 1000) { fps = frames; frames = 0; fpsT = now; window.duelDebug.fps = fps; }
  if (customize.open) { previewFrame(now / 1000); return; }
  let eye = [0, 0, 100], tgt = [100, 0, 100], fovNow = 75 * DEG;
  const characters = [], tris = [], attached = [];
  let me = null, cur = null;
  if (snaps.length) {
    // A local sim has nothing to wait for, so it draws the newest tick. A server's snapshots need a pair to blend between.
    const renderTime = p2pRoom ? snaps.at(-1)?.time ?? 0 : now / 1000 + clockOffset.v - 0.05;
    cur = interpolated(renderTime);
    for (const p of cur.players) {
      if (p.id === myId) me = p;
      const ciP = loadChar(p.c);
      ciP.then((v) => { p._ci = v; });
      const ci = charCache.get(p.c)?._resolved;
      if (!ci) { charCache.get(p.c)?.then((v) => { charCache.get(p.c)._resolved = v; }); continue; }
      const world = entityMatrix(p.o, [0, p.y, 0]);
      const fc = frameCharacter(p, ci, world);
      if (p.id === myId) {
        const at = ci.char.root.attachments.find((x) => x.name === 'chest'), m = at && matMul(fc.world[at.bone], at.local);
        myChest = m ? [m[3] - p.o[0], m[7] - p.o[1], m[11] - p.o[2]] : null;
      }
      R.lightCharacter(fc, p.o);
      const color = lookColor(p) ?? charColor(p.c);
      const st = fx.updatePlayer(p, ci.char, fc.world, ci.gripBone, color);
      setCharge(fc, st.charge, color, dashRim(p));
      characters.push(fc);
      for (const part of lookParts(p, ci)) { R.attachTo(fc, part, ci.char); if (part.shown) attached.push(part); }
      if (p.a?.th) {
        const kind = info.charThrowable[p.c], part = kind && starPart(`hand${p.id}`, kind), att = ci.char.root.attachments.find((x) => x.name === 'anim_attachment_LH');
        if (part && att) { holdStar(part, matMul(fc.world[att.bone], att.local), p.o); attached.push(part); }
      }
      const held = swordParts(p);
      if (held) for (const part of held) { R.attachTo(fc, part, ci.char, swordState(p)); if (part.shown) attached.push(part); }
      else bladeTris(tris, fc.world, ci.gripBone, p.a?.ph === 'swing' ? [1, 0.95, 0.7, 1] : [0.85, 0.87, 0.92, 1]);
    }
    starsFrame(cur, renderTime, attached);
  }
  // In the world: play and watch your own arena. Out of it: the cursor is back for the spectator controls.
  spectating = !me;
  if (me) spectator.view.arena = me.ar ?? 0;
  if (spectating && document.pointerLockElement === canvas) document.exitPointerLock?.();
  if (spectating) keys.clear();
  let camUp = [0, 0, 1];
  if (me) {
    const frameDt = Math.min(0.1, Math.max(1e-3, (now - lastFrame) / 1000));
    const view = thirdPerson.update({ dt: frameDt, o: me.o, vel: me.v ?? [0, 0, 0], yaw: me.y, onGround: me.g, action: me.a?.n ?? null, dir: me.a?.d ?? 0, hitstop: !!me.hs, alive: me.al, chest: myChest }, [camPitch, camYaw]);
    camView = view.angles;
    window.duelDebug.camView = view;
    eye = view.eye;
    const { forward: f, up } = angleVectors(view.angles);
    camUp = up;
    tgt = [eye[0] + f[0] * 100, eye[1] + f[1] * 100, eye[2] + f[2] * 100];
    // [R engine] Source's fov is the width of a 4:3 view
    fovNow = 2 * Math.atan(Math.tan(view.fov * DEG / 2) * 0.75);
  } else if (started && cur) {
    [eye, tgt, fovNow] = spectatorCamera(cur, now);
  } else {
    const s = bsp.entities.find((e) => e.classname === 'berimbau_spawn');
    if (s) { const o = s.origin.split(' ').map(Number); eye = [o[0], o[1], o[2] + 140]; const a = now / 4000; tgt = [o[0] + Math.cos(a) * 300, o[1] + Math.sin(a) * 300, o[2] + 60]; }
  }
  if (window.duelDebug.cam) { eye = window.duelDebug.cam.eye; tgt = window.duelDebug.cam.tgt; }
  const aspect = canvas.width / canvas.height;
  const vp = mul4(perspective(fovNow, aspect, 4, 16000), lookAt(eye, tgt, camUp));
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  fx.localPos = me?.o;
  fx.step(dt);
  const F = norm3([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]), RT = norm3([F[1], -F[0], 0]), UP = [RT[1] * F[2] - RT[2] * F[1], RT[2] * F[0] - RT[0] * F[2], RT[0] * F[1] - RT[1] * F[0]];
  audio.frame(eye, RT);
  const built = fx.build(eye, RT, UP, Math.tan(37.5 * DEG));
  const tracerPreview = cur ? previewFrameData(me, cur, dt) : null;
  R.frame({ vp, eye, fwd: F, fovY: fovNow, characters: characters.concat(attached), tris, tracerPreview, fx: { verts: fx.verts, count: built.count, draws: built.draws } });
  // [R client 180268650] one arena per frame in turn while the board is up, with r_drawparticles off
  if (scoreboard.open && cur?.snap.arenas?.length) {
    const arenas = cur.snap.arenas, i = frames % arenas.length, pv = previewView(arenas[i], aspect);
    if (pv) { const target = R.previewTarget(i); R.frame({ ...pv, target, characters: characters.concat(attached), tris, tracerPreview }); target.drawn = true; }
    R.drawPreviews(scoreboard.shots(canvas));
  }
  if (cur) hud(cur, me);
  window.duelDebug.state = { snaps: snaps.length, myId, chars: characters.length, duel: cur?.snap?.duel, stats: R.stats, eye, me: me && { dc: me.dc, o: me.o, a: me.a, hp: me.hp, an: me.an } };
}
let lastHudAt = performance.now(), lastViewSent = 0;
/**
 * @param {object} cur The interpolated frame.
 * @param {object} [me] The local fighter.
 */
function hud(cur, me) {
  const now = performance.now(), dt = (now - lastHudAt) / 1000;
  lastHudAt = now;
  // The HUD shows the arena being watched
  const arena = spectator.view.arena, arenas = cur.snap.arenas ?? [];
  if (arenas[arena]) cur.snap.duel = arenas[arena];
  $('hud').classList.toggle('spec', !me);
  duelHud?.update({ ...cur, players: cur.players.filter((p) => (p.ar ?? 0) === arena) }, me, myId, dt);
  spectator.show(started && !customize.open && !scoreboard.open);
  // the previews are drawn on the canvas, under the page: nothing else may sit over them
  $('hud').style.visibility = scoreboard.open ? 'hidden' : '';
  spectator.update(arenas, myId, !me);
  scoreboard.update(arenas, myId, arena);
  // the server lists who's watching which arena
  if (arena !== lastViewSent && ws?.readyState === 1) { lastViewSent = arena; ws.send(JSON.stringify({ t: 'view', arena })); }
  if (now > bannerUntil) $('banner').textContent = '';
  $('hint').textContent = me?.kn && !me.a ? 'Downed: Space get up, Mouse1 recovery attack, Mouse2 intercept, WASD roll' : '';
  $('net').textContent = `${window.duelDebug.fps ?? 0} fps`;
}
requestAnimationFrame(tick);

function openCustomize() {
  keys.clear();
  document.exitPointerLock?.();
  $('hud').style.display = 'none';
  customize.show(true);
}
function closeCustomize() {
  customize.hide();
  $('hud').style.display = 'block';
  if (!spectating) try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* needs a user gesture; the next click locks */ }
}
customize.onCancel(closeCustomize);
customize.onConfirm(() => {
  // [I] a fighter's loadout is game state, and changing it mid-match isn't in the peer to peer protocol yet
  if (started && p2pRoom) { banner('Your loadout can\'t change during a direct match'); closeCustomize(); return; }
  if (started) {
    ws?.send(JSON.stringify({ t: 'loadout', character: customize.char, item: customize.sword, look: customize.look, color: customize.color }));
    if (!spectating) banner('Loadout changes next round');
    closeCustomize();
    return;
  }
  started = true;
  audio.start();
  customize.hide();
  $('hud').style.display = 'block';
  loadChar(customize.char);
  for (const k of Object.keys(info.characters)) loadChar(k);
  if (p2pRoom) connectP2P(); else connect();
});
if (params.has('auto')) $('go').click();
