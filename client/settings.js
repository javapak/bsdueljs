// The player's options, by the names the game gives them, kept in the browser. Defaults are read from client.dll's cvar
// registrations, which shared/cvars_all.json doesn't have since that's server.dll's. Key binds default to the game's
// cfg/config_default.cfg.
const CVARS = {
  sensitivity: 3, m_yaw: 0.022, m_pitch: 0.022, m_rawinput: 1, m_customaccel: 0, m_customaccel_exponent: 1.3,
  bb_gae: 0, bb_sde: 1, bb_ibt: 0.33, bb_tracerPreview_enabled: 1,
  fov_desired: 75, mat_monitorgamma: 2.2, cl_csm_enabled_user: 1, mat_forceaniso: 1,
  bb_cam_thirdperson_bank_scale: 1, bb_cam_thirdperson_bank_speed: 3,
  bb_cam_thirdperson_body_center_z: 55, bb_cam_thirdperson_body_scale: 1.2, bb_cam_thirdperson_body_speed: 10,
  bb_cam_thirdperson_distance_ideal: 150,
  bb_cam_thirdperson_ground_fov_add: 2, bb_cam_thirdperson_ground_fov_maxspeed: 350, bb_cam_thirdperson_ground_offset_weight_speed: 1.5,
  bb_cam_thirdperson_ground_scale_xy: 0.09, bb_cam_thirdperson_ground_speed: 7,
  bb_cam_thirdperson_hitstop_push_fwd: 10,
  bb_cam_thirdperson_jump_angle_scale: -0.03, bb_cam_thirdperson_jump_pitch_max: 80, bb_cam_thirdperson_jump_pitch_min: -80,
  bb_cam_thirdperson_jump_scale_xy: 0.04, bb_cam_thirdperson_jump_scale_z: 0.1, bb_cam_thirdperson_jump_speed: 5,
  bb_cam_thirdperson_lag_max: 500, bb_cam_thirdperson_lag_speed: 0,
  bb_cam_thirdperson_pitch_max: 60, bb_cam_thirdperson_pitch_min: -60, bb_cam_thirdperson_pitch_viewoffset: -20,
  bb_cam_thirdperson_roll_fwd_time: 0.25, bb_cam_thirdperson_roll_time: 1, bb_cam_thirdperson_shuffle_time: 0.3,
  bb_cam_thirdperson_x_offset: 0, bb_cam_thirdperson_y_offset: 0, bb_cam_thirdperson_yaw_offset: 0, bb_cam_thirdperson_z_offset: 20,
};
const KEY = 'bsduel.options';
const stored = (() => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } })();
const values = { ...CVARS, ...stored.cvars };
const listeners = new Set();
let binds = stored.binds ?? null;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ cvars: values, binds })); } catch { /* kept for this page only */ } };

/**
 * @param {string} name Cvar name.
 * @returns {number} Its value.
 */
export const cvar = (name) => values[name];
/**
 * @param {string} name Cvar name.
 * @param {number} value New value.
 */
export function setCvar(name, value) {
  if (values[name] === value) return;
  values[name] = value;
  save();
  for (const f of listeners) f(name);
}
/**
 * @param {string[]} names Cvars to put back to their defaults.
 */
export function resetCvars(names) { for (const n of names) setCvar(n, CVARS[n]); }
/**
 * @param {function(string): void} f Called with a cvar's name when it changes.
 */
export const onCvar = (f) => listeners.add(f);

// The game's key names against the browser's. A modifier is one key to the game, so it binds both sides here.
const NAMED = { SPACE: ['Space'], TAB: ['Tab'], ESCAPE: ['Escape'], ENTER: ['Enter'], BACKSPACE: ['Backspace'], CTRL: ['ControlLeft', 'ControlRight'], SHIFT: ['ShiftLeft', 'ShiftRight'], ALT: ['AltLeft', 'AltRight'], PAUSE: ['Pause'], HOME: ['Home'], END: ['End'], PGUP: ['PageUp'], PGDN: ['PageDown'], INS: ['Insert'], DEL: ['Delete'], UPARROW: ['ArrowUp'], DOWNARROW: ['ArrowDown'], LEFTARROW: ['ArrowLeft'], RIGHTARROW: ['ArrowRight'], MOUSE1: ['Mouse1'], MOUSE2: ['Mouse2'], MOUSE3: ['Mouse3'], MOUSE4: ['Mouse4'], MOUSE5: ['Mouse5'], MWHEELUP: ['WheelUp'], MWHEELDOWN: ['WheelDown'], SEMICOLON: ['Semicolon'], '\'': ['Quote'], ',': ['Comma'], '.': ['Period'], '/': ['Slash'], '-': ['Minus'], '=': ['Equal'], '[': ['BracketLeft'], ']': ['BracketRight'], '\\': ['Backslash'], '`': ['Backquote'] };
function codesOf(key) {
  const k = key.length === 1 ? key.toLowerCase() : key.toUpperCase();
  if (NAMED[k]) return NAMED[k];
  if (/^[a-z]$/.test(k)) return ['Key' + k.toUpperCase()];
  if (/^[0-9]$/.test(k)) return ['Digit' + k];
  return /^F[0-9]+$/.test(k) ? [k] : [];
}
/**
 * @param {string} code A key's browser code, or Mouse1 and so on.
 * @returns {string} What the game's menu would call it.
 */
export function keyName(code) {
  const hit = Object.entries(NAMED).find(([, c]) => c.includes(code));
  if (hit) return hit[0];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.toUpperCase();
}

let defaults = {};
/**
 * @param {string} text The game's cfg/config_default.cfg.
 */
export function loadDefaultBinds(text) {
  defaults = {};
  for (const m of text.matchAll(/^\s*bind\s+"([^"]+)"\s+"([^"]+)"/gmi)) for (const c of codesOf(m[1])) defaults[c] = m[2];
  binds ??= { ...defaults };
}
/**
 * @param {string} code A key's browser code.
 * @returns {string|undefined} The command bound to it.
 */
export const boundTo = (code) => binds?.[code];
/**
 * @param {string} command A command, such as +attack.
 * @returns {string[]} The keys bound to it.
 */
export const keysFor = (command) => Object.keys(binds ?? {}).filter((c) => binds[c] === command);
/**
 * A key only does one thing, so this takes it from whatever had it. Pressing a side of a modifier binds just that side.
 * @param {string} command The command.
 * @param {string} code The key's browser code.
 */
export function bind(command, code) {
  for (const c of keysFor(command)) delete binds[c];
  binds[code] = command;
  save();
}
/**
 * @param {string} command The command to leave without a key.
 */
export function unbind(command) { for (const c of keysFor(command)) delete binds[c]; save(); }
/** Back to the game's defaults. */
export function resetBinds() { binds = { ...defaults }; save(); }
