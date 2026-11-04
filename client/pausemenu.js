// The pause menu: resource/ui/basemodui/ingamemainmenu_mp.res and the options dialogs it opens, built from those .res files
// and labelled with the game's own strings. What each choice sets is read from client.dll. Options this renderer has nothing
// behind stay on the screen, turned off, so the dialogs keep their shape.
import { parseKV } from '/shared/kv.js';
import { cvar, setCvar, resetCvars, keysFor, keyName, bind, unbind, resetBinds } from './settings.js';

const CSS = `
#pm{position:fixed;inset:0;z-index:6;--u:calc(100vh / 480);display:none;background:#0009;color:#fff;font:400 calc(var(--u) * 9)/1.2 ropasans-regular,sans-serif;user-select:none}
#pm.on{display:block}
#pm button,#pm select,#pm input{width:auto;margin:0;padding:0;border-radius:0}
.pm-main{position:absolute;left:calc(var(--u) * 24);bottom:calc(var(--u) * 83);display:flex;flex-direction:column;gap:calc(var(--u) * 3);align-items:flex-start}
.pm-main button{background:none;border:0;color:#d8d8d8;font:400 calc(var(--u) * 15)/1.2 Harabara,sans-serif;cursor:pointer;text-shadow:0 1px 3px #000}
.pm-main button:hover:not(:disabled){color:#fff;filter:none}.pm-main button:disabled{color:#fff4;cursor:default}
.pm-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:calc(var(--u) * 400);max-height:calc(var(--u) * 420);display:flex;flex-direction:column;background:#101018f2;box-shadow:0 0 0 calc(var(--u) * 1) #2d2d36}
.pm-title{font:400 calc(var(--u) * 14)/1 Harabara,sans-serif;padding:calc(var(--u) * 9) calc(var(--u) * 12);border-bottom:calc(var(--u) * 1.5) solid #e8e8e8}
.pm-body{overflow-y:auto;padding:calc(var(--u) * 6) calc(var(--u) * 12);flex:1}
.pm-row{display:flex;align-items:center;min-height:calc(var(--u) * 21);gap:calc(var(--u) * 8)}
.pm-row>label{flex:1;margin:0;color:#e8e8e8;font:inherit}.pm-row.off>label{color:#fff5}
.pm-row select{width:calc(var(--u) * 150);background:#1c1c26;color:#fff;border:calc(var(--u) * 1) solid #3a3a46;font:inherit;padding:calc(var(--u) * 2)}
.pm-row select:disabled{color:#fff5;background:#14141c}
.pm-row input[type=range]{width:calc(var(--u) * 115);padding:0;accent-color:#e8e8e8;border:0;background:none}
.pm-val{width:calc(var(--u) * 30);text-align:right;font-variant-numeric:tabular-nums}
.pm-link{background:#1c1c26;border:calc(var(--u) * 1) solid #3a3a46;color:#fff;font:inherit;padding:calc(var(--u) * 3) calc(var(--u) * 8);cursor:pointer}
.pm-link:disabled{color:#fff5;cursor:default}.pm-link:hover:not(:disabled){background:#2a2a36;filter:none}
.pm-foot{display:flex;justify-content:flex-end;gap:calc(var(--u) * 6);padding:calc(var(--u) * 7) calc(var(--u) * 12);border-top:calc(var(--u) * 1) solid #2d2d36}
.pm-note{color:#fff9;font-size:calc(var(--u) * 8);padding:calc(var(--u) * 3) 0}
.pm-head{color:#e4b45a;padding:calc(var(--u) * 8) 0 calc(var(--u) * 2);font-size:calc(var(--u) * 9.5)}
.pm-bind{display:flex;align-items:center;min-height:calc(var(--u) * 17);cursor:pointer;padding:0 calc(var(--u) * 4)}
.pm-bind:hover{background:#ffffff14}.pm-bind.off{color:#fff5;cursor:default;background:none}.pm-bind.wait{background:#e4b45a33}
.pm-bind span:first-child{flex:1}
`;
// The options this build honors. Each list's entries line up with the .res file's. [R client 18036a558, 1803b9d9b, 1803ba085, 18036e6b5, 18032d835]
const LISTS = {
  DrpMouseYInvert: { get: () => (cvar('m_pitch') < 0 ? 1 : 0), set: (i) => setCvar('m_pitch', (i ? -1 : 1) * Math.abs(cvar('m_pitch'))) },
  DrpRawMouse: { cvar: 'm_rawinput' },
  DrpMouseAcceleration: { get: () => (cvar('m_customaccel') ? 1 : 0), set: (i) => setCvar('m_customaccel', i ? 3 : 0) },
  LstAttackBlockGrab: { cvar: 'bb_gae' },
  LstDoubleTapShuffle: { cvar: 'bb_sde' },
  DrpCSM: { cvar: 'cl_csm_enabled_user' },
  LstTracerPreview: { cvar: 'bb_tracerPreview_enabled' },
  DrpFiltering: { get: () => [0, 1, 2, 4, 8, 16].indexOf(cvar('mat_forceaniso')), set: (i) => setCvar('mat_forceaniso', [0, 1, 2, 4, 8, 16][i]), reload: true },
};
// Sliders whose cvars something reads here
const SLIDERS = new Set(['sensitivity', 'm_customaccel_exponent', 'mat_monitorgamma', 'bb_ibt', 'fov_desired', 'bb_cam_thirdperson_z_offset', 'bb_cam_thirdperson_distance_ideal', 'bb_cam_thirdperson_body_scale', 'bb_cam_thirdperson_ground_scale_xy', 'bb_cam_thirdperson_lag_speed']);
// The commands a key can do anything for here
const BINDABLE = new Set(['+forward', '+back', '+moveleft', '+moveright', '+walk', '+jump', '+duck', '+shuffle', '+attack', '+block', '+grab', '+attack2', '+reverse', '+balanced', '+heavy', '+nextstance', '+prevstance', '+sheathe', '+bow', '+flourish', '+sit', '+taunt', 'bb_show_customization', 'vs_ready', '+score']);
const RES = (name) => `resource/ui/basemodui/${name}.res`;
const STRINGS = ['basemodui', 'gameui', 'gameuiberimbau', 'berimbau', 'valve'];
const mk = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; parent?.appendChild(e); return e; };
const val = (nodes, key) => nodes.find((n) => n.key.toLowerCase() === key)?.value;
const num = (v) => parseFloat(v);

/**
 * Builds the menu. It starts closed.
 * @param {object} o Parts of the page it needs.
 * @param {function(string): Promise<string>} o.read Reads a file under the game folder.
 * @param {function(): void} o.onResume Return to the game.
 * @param {function(): void} o.onCustomize Open the customization screen.
 * @param {function(): void} o.onPlay Join or leave the queue.
 * @param {function(): void} o.onDisconnect Leave the server.
 * @returns {Promise<object>} open, show and handleKey, as used in main.js.
 */
export async function createPauseMenu({ read, onResume, onCustomize, onPlay, onDisconnect }) {
  mk('style', '', document.head, CSS);
  const say = new Map();
  await Promise.all(STRINGS.map(async (n) => {
    try { for (const m of (await read(`resource/${n}_english.txt`)).matchAll(/^\s*"([^"\r\n]+)"\s+"(.*)"\s*$/gm)) if (!say.has(m[1].toLowerCase())) say.set(m[1].toLowerCase(), m[2]); } catch { /* a missing table only leaves names showing */ }
  }));
  // [I] a token no table has, such as GameUI_KeyboardMouse, reads as its own words
  const words = (k) => k.replace(/^(GameUI|bb|Versus|Valve)_/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const text = (k) => (k?.[0] === '#' ? say.get(k.slice(1).toLowerCase()) ?? words(k.slice(1)) : k ?? '');

  const root = mk('div', '', document.body); root.id = 'pm';
  let stack = [], capture = null, needReload = false;
  const main = mk('div', 'pm-main', root);
  const box = mk('div', 'pm-box', root);
  const title = mk('div', 'pm-title', box), body = mk('div', 'pm-body', box), foot = mk('div', 'pm-foot', box);

  const button = (label, parent, cls, fn, off) => { const b = mk('button', cls, parent, label); b.disabled = !!off; if (fn) b.onclick = fn; return b; };
  const back = () => { stack.pop(); render(); };
  const open = (page) => { stack.push(page); render(); };

  // A .res file's controls, top to bottom
  async function controls(name) {
    const nodes = parseKV(await read(RES(name)))[0].value;
    return nodes.filter((n) => Array.isArray(n.value) && val(n.value, 'controlname') !== 'Frame' && !/^(iconbutton|pnl|lbl)/i.test(n.key))
      .map((n) => ({ key: n.key, nodes: n.value, y: num(val(n.value, 'ypos')) })).sort((a, b) => a.y - b.y);
  }
  const labelOf = (c) => {
    const inner = c.nodes.find((n) => Array.isArray(n.value));
    return text(val(c.nodes, 'labeltext') ?? (inner && val(inner.value, 'labeltext')) ?? (c.key === 'SldBrightness' ? '#GameUI_Brightness' : ''));
  };

  function sliderRow(c, parent) {
    const name = val(c.nodes, 'concommand'), on = SLIDERS.has(name);
    const row = mk('div', 'pm-row' + (on ? '' : ' off'), parent);
    mk('label', '', row, labelOf(c));
    const r = mk('input', '', row); r.type = 'range'; r.min = num(val(c.nodes, 'minvalue')); r.max = num(val(c.nodes, 'maxvalue')); r.step = num(val(c.nodes, 'stepsize')); r.disabled = !on;
    const shown = mk('span', 'pm-val', row);
    const sync = () => { const v = on ? cvar(name) : num(r.min); r.value = v; shown.textContent = on ? +(+v).toFixed(2) : ''; };
    r.oninput = () => { setCvar(name, +r.value); shown.textContent = +(+r.value).toFixed(2); };
    sync();
    return sync;
  }

  function listRow(c, parent, special) {
    const list = c.nodes.find((n) => n.key.toLowerCase() === 'list')?.value ?? [];
    const def = special?.[c.key] ?? LISTS[c.key], on = !!def;
    const row = mk('div', 'pm-row' + (on ? '' : ' off'), parent);
    mk('label', '', row, labelOf(c));
    const sel = mk('select', '', row); sel.disabled = !on;
    const entries = def?.entries?.() ?? list.map((n) => text(n.key));
    entries.forEach((t, i) => { const o = mk('option', '', sel, t); o.value = i; if (def?.offEntry?.(i)) o.disabled = true; });
    const get = () => (def.cvar ? (cvar(def.cvar) ? 1 : 0) : def.get());
    if (on) sel.value = get();
    else { const o = mk('option', '', sel, '-'); o.value = 'x'; sel.value = 'x'; }
    sel.onchange = () => {
      const i = +sel.value;
      if (def.cvar) setCvar(def.cvar, i); else def.set(i);
      if (def.reload) { needReload = true; render(); }
    };
  }

  // Video: what a page can do with the window. [I] the aspect only filters the list of sizes
  const ASPECTS = [[4, 3], [16, 9], [16, 10]];
  const MODES = [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 960], [1600, 1200], [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160], [1280, 800], [1440, 900], [1680, 1050], [1920, 1200], [2560, 1600]];
  let aspect = 1;
  const screenPx = () => [Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)];
  const sizes = () => MODES.filter(([w, h]) => Math.abs(w / h - ASPECTS[aspect][0] / ASPECTS[aspect][1]) < 0.02 && w <= screenPx()[0] && h <= screenPx()[1]);
  const resolution = () => { try { return JSON.parse(localStorage.getItem('bsduel.res')); } catch { return null; } };
  const videoLists = {
    DrpAspectRatio: { get: () => aspect, set: (i) => { aspect = i; render(); } },
    DrpResolution: {
      entries: () => ['Window size', ...sizes().map(([w, h]) => `${w} x ${h}`)],
      get: () => { const r = resolution(); return r ? sizes().findIndex(([w, h]) => w === r[0] && h === r[1]) + 1 : 0; },
      set: (i) => { const r = i ? sizes()[i - 1] : null; try { localStorage.setItem('bsduel.res', JSON.stringify(r)); } catch { /* this page only */ } menu.onResolution?.(r); },
    },
    DrpDisplayMode: {
      offEntry: (i) => i === 2, // [I] a page can't take its own border off
      get: () => (document.fullscreenElement ? 0 : 1),
      set: (i) => { if (i === 0) document.documentElement.requestFullscreen?.().catch?.(() => render()); else if (document.fullscreenElement) document.exitFullscreen?.(); },
    },
  };

  async function dialog(heading, resName, special, reset) {
    return { heading, build: async (parent) => {
      const syncs = [];
      for (const c of await controls(resName)) {
        const kind = val(c.nodes, 'controlname');
        if (kind === 'SliderControl') syncs.push(sliderRow(c, parent));
        else if (c.nodes.some((n) => n.key.toLowerCase() === 'list')) listRow(c, parent, special);
        else if (val(c.nodes, 'labeltext')) {
          const cmd = String(val(c.nodes, 'command') ?? '').toLowerCase(), go = cmd === 'reset' && reset ? () => { reset(); for (const f of syncs) f(); } : LINKS[cmd];
          const row = mk('div', 'pm-row', parent);
          button(labelOf(c), row, 'pm-link', go ?? null, !go);
        }
      }
      return syncs;
    } };
  }
  const CAMERA = ['z_offset', 'distance_ideal', 'body_scale', 'ground_scale_xy', 'lag_speed'].map((n) => 'bb_cam_thirdperson_' + n).concat('fov_desired');
  const pages = {
    keyboard: () => dialog(text('#GameUI_KeyboardMouse'), 'keyboardmouse'),
    video: () => dialog(text('#GameUI_Video'), 'video', videoLists),
    advanced: () => dialog(text('#GameUI_Video_AdvancedVideo'), 'advancedvideo'),
    game: () => dialog(text('#GameUI_Multiplayer'), 'berimbaugameoptions'),
    camera: () => dialog(text('#GameUI_CameraOptions'), 'cameraoptions', null, () => resetCvars(CAMERA)),
    bindings: () => bindingsPage(),
  };
  const LINKS = {
    '#gameui_controller_edit_keys_buttons': () => show('bindings'),
    showadvanced: () => show('advanced'),
    cameraoptions: () => show('camera'),
  };
  const show = async (name) => open(await pages[name]());

  async function bindingsPage() {
    const list = (await read('scripts/kb_act.lst')).matchAll(/"([^"]+)"\s+"([^"]+)"/g);
    const rows = [...list].map((m) => [m[1], m[2]]).filter(([, l]) => !/^=+$/.test(l));
    return { heading: text('#GameUI_Controller_Edit_Keys_Buttons'), resetBinds: true, build: async (parent) => {
      for (const [cmd, label] of rows) {
        if (cmd === 'blank') { mk('div', 'pm-head', parent, text(label)); continue; }
        if (/^TUT_/.test(cmd)) continue;
        const on = BINDABLE.has(cmd), row = mk('div', 'pm-bind' + (on ? '' : ' off'), parent);
        mk('span', '', row, text(label));
        const key = mk('span', '', row);
        const sync = () => { key.textContent = keysFor(cmd).map(keyName).filter((n, i, a) => a.indexOf(n) === i).join(', '); };
        sync();
        if (on) row.onclick = () => {
          if (capture) capture.row.classList.remove('wait');
          row.classList.add('wait');
          capture = { row, cmd, sync: () => { row.classList.remove('wait'); for (const f of menu.bindSyncs) f(); } };
        };
        (menu.bindSyncs ??= []).push(sync);
      }
      return [];
    } };
  }

  const items = [
    ['#bb_returntomainmenu', () => onResume()],
    ['#bb_play', () => { onPlay(); onResume(); }],
    ['#bb_customize', () => onCustomize()],
    ['#bb_options', () => open({ heading: text('#bb_options'), root: true })],
    ['#bb_disconnect', () => onDisconnect()],
  ];
  // BtnReturnToGame and the rest, in the file's own order and with its labels
  try {
    const file = parseKV(await read(RES('ingamemainmenu_mp')))[0].value;
    const byCmd = { returntogame: 0, play: 1, customize: 2, options: 3, exittomainmenu: 4 };
    for (const n of file) if (Array.isArray(n.value)) { const c = byCmd[String(val(n.value, 'command')).toLowerCase()]; if (c !== undefined) items[c][0] = val(n.value, 'labeltext') ?? items[c][0]; }
  } catch { /* falls back to the same strings */ }
  items.forEach(([label, fn]) => button(text(label), main, '', fn));

  async function render() {
    capture = null; menu.bindSyncs = [];
    const page = stack.at(-1);
    box.style.display = page ? '' : 'none';
    main.style.display = page ? 'none' : '';
    if (!page) return;
    title.textContent = page.heading;
    body.textContent = ''; foot.textContent = '';
    if (page.root) {
      const entries = [['#GameUI_KeyboardMouse', 'keyboard'], ['#GameUI_Video', 'video'], ['#GameUI_Audio', null], ['#GameUI_Multiplayer', 'game']];
      for (const [label, name] of entries) button(text(label), mk('div', 'pm-row', body), 'pm-link', name ? () => show(name) : null, !name);
    } else await page.build(body);
    if (needReload) mk('div', 'pm-note', body, 'Texture filtering takes effect when the page reloads.');
    if (page.resetBinds) button(text('#GameUI_UseDefaults'), foot, 'pm-link', () => { resetBinds(); render(); });
    button(text('#GameUI_Back'), foot, 'pm-link', back);
  }

  const menu = {
    /** @returns {boolean} Whether it's on screen. */
    get open() { return root.classList.contains('on'); },
    /**
     * @param {boolean} on Show it, from the top, or hide it.
     */
    show(on) { root.classList.toggle('on', on); stack = []; capture = null; render(); },
    /**
     * Keys and buttons while it's open: a bind waiting for one takes it, and Escape goes back a level.
     * @param {string} code The key's browser code, or Mouse1 and so on.
     * @returns {boolean} Whether it used the key.
     */
    handleKey(code) {
      if (capture) {
        const c = capture; capture = null;
        if (code === 'Escape') unbind(c.cmd); else bind(c.cmd, code);
        c.sync();
        return true;
      }
      if (code !== 'Escape') return false;
      if (stack.length) back(); else onResume();
      return true;
    },
    /** @returns {number[]|null} The chosen size, if any. */
    resolution,
  };
  await render();
  return menu;
}
