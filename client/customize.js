// The customization screen: replaces the start menu and opens in a match with M, as bb_show_customization does.
// Positions come from resource/ui/basemodui/customization.res, in its 640x480 proportional units; "r" counts from the
// right or bottom edge. The labels are the game's own strings. Nothing here is locked.
import { vtfUrl } from './hud.js';

const CHARS = [['knight', 228], ['phalanx', 185], ['ryoku', 142], ['pure', 99], ['vanguard', 56]];
const TABS = ['cape', 'mask', 'skin', 'color', 'emblems', 'misc'];
const MISC = [['chest', 161], ['arms', 217], ['back', 273], ['legs', 329]];
const SINGLE = { cape: 'cape', mask: 'mask', skin: 'skin', color: 'colour', emblems: 'emblem' };
const STORE = 'bsduel.loadout';
const KEYS = `<kbd>WASD</kbd> move, aim sets attack direction &middot; <kbd>Mouse1</kbd> attack (hold to charge) &middot; <kbd>Mouse2</kbd> block &middot; <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> fast / balanced / heavy &middot; <kbd>Space</kbd> jump &middot; <kbd>E</kbd> throw &middot; <kbd>Ctrl</kbd> roll &middot; <kbd>Shift</kbd> shuffle &middot; <kbd>Q</kbd> grab (press while grabbed to break) &middot; <kbd>Alt</kbd> walk &middot; <kbd>4</kbd> sheathe &middot; <kbd>B</kbd> bow &middot; <kbd>C</kbd> flourish &middot; <kbd>V</kbd> taunt &middot; <kbd>T</kbd> sit &middot; <kbd>R</kbd> join or leave the queue &middot; hold <kbd>Tab</kbd> arenas &middot; <kbd>M</kbd> customize`;

const CSS = `
#cz{position:fixed;inset:0;z-index:5;--u:calc(100vh / 480);font-family:Harabara,sans-serif;color:#fff;pointer-events:none;overflow:hidden;user-select:none}
#cz>*,#cz .cz-misc>*{position:absolute;pointer-events:auto}
.cz-bar{background:#000;display:flex;align-items:center;white-space:nowrap;overflow:hidden;box-sizing:border-box}
.cz-char{padding:0;margin:0;background:none;border:0;cursor:pointer;width:auto;border-radius:0;filter:brightness(.82)}
.cz-char img{width:100%;height:100%;display:block}
.cz-char:hover{filter:none}.cz-char.on{filter:none;outline:calc(var(--u) * 1) solid #fff;outline-offset:calc(var(--u) * -1)}
.cz-info{font:400 calc(var(--u) * 8.4)/1.28 ropasans-regular,sans-serif;text-shadow:0 0 2px #000,1px 1px 1px #000}
.cz-tabs{display:flex;justify-content:flex-end;align-items:flex-end;gap:calc(var(--u) * 1);border-bottom:calc(var(--u) * 1.5) solid #e8e8e8;box-sizing:border-box}
.cz-tab,.cz-sub{font:400 calc(var(--u) * 8.5)/1 Harabara,sans-serif;background:#55555a;color:#d8d8d8;border:0;padding:calc(var(--u) * 3) calc(var(--u) * 7);margin:0;width:auto;border-radius:0;clip-path:polygon(calc(var(--u) * 4) 0,100% 0,100% 100%,0 100%);cursor:pointer}
.cz-tab:hover{color:#fff}.cz-tab.on{background:#101018;color:#fff;outline:0;box-shadow:inset 0 calc(var(--u) * 1) 0 #fff}
.cz-sub{position:absolute;left:calc(var(--u) * 8);background:#14141c;color:#fff;cursor:default;pointer-events:none}
.cz-rule{position:absolute;left:calc(var(--u) * 8);right:0;border-bottom:calc(var(--u) * 1) solid #2d2d36;height:calc(var(--u) * 13)}
.cz-grid{display:flex;flex-wrap:wrap;align-content:flex-start;gap:calc(var(--u) * 4);padding:calc(var(--u) * 5) calc(var(--u) * 5) calc(var(--u) * 5) calc(var(--u) * 18);overflow-y:auto;box-sizing:border-box;scrollbar-width:thin}
.cz-row{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding-top:calc(var(--u) * 2);padding-bottom:0}
.cz-item{width:calc(var(--u) * 25);height:calc(var(--u) * 25);padding:0;margin:0;flex:none;border:0;border-radius:0;background:#2a2a30;cursor:pointer;position:relative;font:400 calc(var(--u) * 5)/1.05 ropasans-regular,sans-serif;color:#ddd;overflow:hidden;box-shadow:0 0 calc(var(--u) * 1.5) #000}
.cz-item img{width:100%;height:100%;display:block;object-fit:contain}.cz-item:hover{filter:brightness(1.2)}
.cz-item.on{outline:calc(var(--u) * 1) solid #fff;outline-offset:calc(var(--u) * -1)}
.cz-item.on::after{content:'';position:absolute;right:0;bottom:0;border:calc(var(--u) * 2.5) solid;border-color:transparent #fff #fff transparent}
.cz-arrow{background:#555;border:0;padding:0;margin:0;border-radius:0;cursor:pointer;width:auto}.cz-arrow:hover{background:#888}
.cz-big{font:400 calc(var(--u) * 13.5)/1 Harabara,sans-serif;background:#e4e4e4;color:#111;border:0;margin:0;padding:0;width:auto;border-radius:0;cursor:pointer;box-shadow:calc(var(--u) * 1.5) calc(var(--u) * 1.5) 0 #333;position:relative}
.cz-big:hover{filter:none;background:#fff}.cz-big::after{content:'';position:absolute;top:calc(var(--u) * 2);right:calc(var(--u) * 2);border:calc(var(--u) * 2.5) solid;border-color:var(--cue) var(--cue) transparent transparent}
.cz-big:disabled{background:#777;color:#222;cursor:default}
#cz input{font:400 calc(var(--u) * 11) Harabara,sans-serif;background:#000;border:0;border-radius:0;color:#fff;padding:0 calc(var(--u) * 6);margin:0;box-sizing:border-box}
#cz input.cz-pick{width:calc(var(--u) * 54);height:calc(var(--u) * 25);padding:calc(var(--u) * 1);cursor:pointer;flex:none}
.cz-keys{font:400 calc(var(--u) * 6.5)/1.5 ropasans-regular,sans-serif;background:#000a;padding:calc(var(--u) * 3) calc(var(--u) * 6);box-sizing:border-box}.cz-keys kbd{font:inherit;padding:0 calc(var(--u) * 1.5);border:1px solid #fff5}
#cz #status{font:400 calc(var(--u) * 7.5)/1.2 ropasans-regular,sans-serif;color:#fff;background:#000c;padding:calc(var(--u) * 1.5) calc(var(--u) * 6);margin:0;min-height:0;white-space:normal;box-sizing:border-box}
#cz #status:empty{display:none}#cz #status.err{color:#ff8d7a}
`;

// xpos and ypos as in the .res: a number from the left or top, or "r<n>" from the far edge
const at = (el, x, y, w, h) => {
  const side = (v, a) => (String(v)[0] === 'r' ? `calc(100v${a} - var(--u) * ${String(v).slice(1)})` : `calc(var(--u) * ${v})`);
  el.style.left = side(x, 'w'); el.style.top = side(y, 'h');
  if (w !== undefined) el.style.width = `calc(var(--u) * ${w})`;
  if (h !== undefined) el.style.height = `calc(var(--u) * ${h})`;
  return el;
};
const mk = (tag, cls = '', parent = null) => { const e = document.createElement(tag); if (cls) e.className = cls; parent?.append(e); return e; };
const arrow = (dir) => {
  const clip = { up: '50% 0,100% 100%,0 100%', down: '0 0,100% 0,50% 100%', left: '100% 0,100% 100%,0 50%', right: '0 0,100% 50%,0 100%' }[dir];
  const b = mk('button', 'cz-arrow');
  b.style.clipPath = `polygon(${clip})`;
  return b;
};

// A material path from items.json, with or without "materials/" and ".vmt", to a texture for the menu
const icons = new Map();
function iconUrl(path) {
  if (!path) return Promise.resolve(null);
  const key = path.replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.(vmt|vtf)$/i, '');
  if (!icons.has(key)) {
    icons.set(key, (async () => {
      try {
        const direct = await vtfUrl(key);
        if (direct) return direct;
        const r = await fetch(`/game/materials/${key}.vmt`);
        const base = r.ok && /\$basetexture"?\s+"?([^"\s]+)/i.exec(await r.text())?.[1];
        return base ? await vtfUrl(base.replace(/\\/g, '/')) : null;
      } catch { return null; }
    })());
  }
  return icons.get(key);
}

/**
 * The start menu and M menu: character, sword, outfit and color, saved in the browser.
 * @param {HTMLElement} root Where it goes.
 * @param {object} info Server info: characters, swords and items.
 * @param {URLSearchParams} params URL options that preselect items, such as ?sword= or ?skin=.
 * @returns {object} The screen's state and controls.
 */
export function createCustomize(root, info, params) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  // What's chosen, kept per character the way the game's vs_selectioncache cvars do, and in this browser between visits
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { /* private window or blocked storage */ }
  const state = { char: info.characters[params.get('char')] ? params.get('char') : info.characters[saved.char] ? saved.char : 'knight', byChar: saved.byChar ?? {}, name: saved.name ?? 'Player', tab: 'skin', group: 0 };
  const swordOf = (id) => info.swordItems.find((s) => s.id === id);
  const forChar = () => {
    const c = (state.byChar[state.char] ??= {});
    c.sword = swordOf(c.sword) ? c.sword : info.charSwordItem[state.char];
    c.picks ??= {};
    const items = info.lookItems;
    for (const [slot, id] of Object.entries(c.picks)) { const i = items.find((x) => x.id === id); if (!i || (i.character && i.character !== state.char)) delete c.picks[slot]; }
    const mask = c.picks.mask ?? info.defaultLook[state.char]?.[0];
    if (mask !== undefined) c.picks.mask = mask;
    return c;
  };
  // ?skin= ?mask= ?cape= ?arms= ?back= ?chest= ?legs= ?sword=type ?item=id preselect, for links and tests
  const applyParams = () => {
    const c = forChar();
    for (const slot of ['skin', 'mask', 'cape', 'arms', 'back', 'chest', 'legs']) {
      const id = parseInt(params.get(slot), 10), i = info.lookItems.find((x) => x.id === id);
      if (i && (!i.character || i.character === state.char)) c.picks[slot] = id;
    }
    const w = info.swordItems.find((s) => s.type === params.get('sword') || String(s.id) === params.get('item'));
    if (w) c.sword = w.id;
  };
  applyParams();

  const cz = mk('div', '', root);
  cz.id = 'cz';
  const chars = CHARS.map(([key, r]) => {
    const b = at(mk('button', 'cz-char', cz), `r${r}`, 5, 41, 64);
    b.title = info.characters[key]?.name ?? key;
    iconUrl(`vgui/charicons/${key}`).then((u) => { if (u) { const im = mk('img', '', b); im.src = u; im.alt = b.title; } });
    b.onclick = () => { state.char = key; hooks.onCharacter?.(); render(); };
    return { key, b };
  });
  const lblChar = at(mk('div', 'cz-bar', cz), 'r228', 71, 228, 26);
  lblChar.style.cssText += 'font-size:calc(var(--u) * 19);padding-left:calc(var(--u) * 12)';
  const lblInfo = at(mk('div', 'cz-info', cz), 'r226', 99, 224, 40);
  const tabBar = at(mk('div', 'cz-tabs', cz), 'r256', 140, 256, 22);
  const tabs = TABS.map((t) => { const b = mk('button', 'cz-tab', tabBar); b.textContent = t; b.onclick = () => { state.tab = t; render(); }; return { t, b }; });
  const panel = at(mk('div', 'cz-grid', cz), 'r255', 160, 255, 250);
  const misc = at(mk('div', 'cz-misc', cz), 'r255', 160, 255, 250);
  const count = at(mk('div', 'cz-info', misc), 'r0', 2);
  count.style.cssText = 'position:absolute;right:calc(var(--u) * 5);top:calc(var(--u) * 3)';
  const miscRows = MISC.map(([slot, y]) => {
    const top = y - 160;
    const rule = mk('div', 'cz-rule', misc); rule.style.top = `calc(var(--u) * ${top + 5})`;
    const sub = mk('div', 'cz-sub', misc); sub.textContent = slot; sub.style.top = `calc(var(--u) * ${top + 1})`;
    const row = mk('div', 'cz-grid cz-row', misc);
    row.style.cssText = `position:absolute;left:0;right:0;top:calc(var(--u) * ${top + 19});height:calc(var(--u) * 37)`;
    return { slot, row };
  });

  // Sword: group, name, arrows and type, in the .res's places
  const lblGroup = at(mk('div', 'cz-bar', cz), 0, 188, 190, 17);
  lblGroup.style.cssText += 'font-size:calc(var(--u) * 10);padding-left:calc(var(--u) * 6)';
  const groupL = at(arrow('left'), 196, 188, 9, 17), groupR = at(arrow('right'), 206, 188, 9, 17);
  cz.append(groupL, groupR);
  const lblSword = at(mk('div', 'cz-bar', cz), 0, 208, 223, 26);
  lblSword.style.cssText += 'font-size:calc(var(--u) * 17);justify-content:flex-end;padding-right:calc(var(--u) * 14)';
  const up = at(arrow('up'), 225, 212, 20, 10), down = at(arrow('down'), 225, 223, 20, 10);
  cz.append(up, down);
  const typeIcon = at(mk('img', '', cz), 0, 238, 66, 17);
  typeIcon.style.cssText += 'background:#fff;object-fit:contain';
  const lblType = at(mk('div', 'cz-bar', cz), 67, 238, 92, 17);
  lblType.style.cssText += 'font-size:calc(var(--u) * 10);padding-left:calc(var(--u) * 8)';

  // Bottom: the name takes the experience bar's place; cancel and select are the .res's buttons
  const name = at(mk('input', '', cz), 8, 'r40', 170, 22);
  name.id = 'name'; name.maxLength = 24; name.value = state.name; name.placeholder = 'Name'; name.setAttribute('aria-label', 'Name');
  name.oninput = () => { state.name = name.value; persist(); };
  const keys = at(mk('div', 'cz-keys', cz), 8, 'r124', 300);
  keys.innerHTML = KEYS;
  const statusEl = at(mk('div', '', cz), 8, 'r60', 230);
  statusEl.id = 'status';
  const back = at(mk('div', '', cz), 'r192', 'r60', 192, 60);
  back.style.cssText += 'background:#2b2b30;pointer-events:none';
  const cancel = at(mk('button', 'cz-big', cz), 'r187', 'r54', 83, 40);
  cancel.textContent = 'Cancel'; cancel.style.setProperty('--cue', '#c81e1e');
  const confirm = at(mk('button', 'cz-big', cz), 'r92', 'r54', 83, 40);
  confirm.id = 'go'; confirm.disabled = true; confirm.textContent = 'Loading…'; confirm.style.setProperty('--cue', '#22c828');

  const hooks = {};
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify({ char: state.char, byChar: state.byChar, name: state.name })); } catch { /* blocked storage */ } };

  const groups = () => ['Default', ...Object.keys(info.swords)];
  const swordList = () => { const g = groups()[state.group]; return g === 'Default' ? info.swordItems : info.swordItems.filter((s) => s.type === g); };
  const stepSword = (d) => {
    const c = forChar(), list = swordList(), i = list.findIndex((s) => s.id === c.sword);
    c.sword = list[((i < 0 ? 0 : i) + d + list.length) % list.length].id;
    render();
  };
  const stepGroup = (d) => {
    state.group = (state.group + d + groups().length) % groups().length;
    const c = forChar(), list = swordList();
    if (!list.some((s) => s.id === c.sword)) c.sword = list[0].id;
    render();
  };
  up.onclick = () => stepSword(-1);
  down.onclick = () => stepSword(1);
  groupL.onclick = () => stepGroup(-1);
  groupR.onclick = () => stepGroup(1);
  // the wheel over the swords turns them
  cz.addEventListener('wheel', (e) => { if (e.clientX < innerWidth * 0.5 && api.open) stepSword(e.deltaY > 0 ? 1 : -1); }, { passive: true });

  const itemButton = (item, parent, slot, required) => {
    const c = forChar();
    const b = mk('button', 'cz-item', parent);
    b.title = item.name;
    if (c.picks[slot] === item.id) b.classList.add('on');
    if (item.picker) b.style.background = 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)';
    else if (item.colour) b.style.background = `rgb(${item.colour.trim().split(/\s+/).join(',')})`;
    else {
      b.textContent = item.name;
      iconUrl(item.icon ?? item.emblem).then((u) => { if (u) { b.textContent = ''; const im = mk('img', '', b); im.src = u; im.alt = item.name; } });
    }
    b.onclick = () => {
      if (c.picks[slot] === item.id) { if (!required) delete c.picks[slot]; } else c.picks[slot] = item.id;
      render();
    };
  };
  const skinDefault = () => {
    const b = mk('button', 'cz-item', panel);
    b.textContent = 'none'; b.title = 'None';
    if (forChar().picks[SLOT()] === undefined) b.classList.add('on');
    b.onclick = () => { delete forChar().picks[SLOT()]; render(); };
  };
  const SLOT = () => state.tab;

  function render() {
    const c = forChar(), ch = info.characters[state.char];
    for (const { key, b } of chars) b.classList.toggle('on', key === state.char);
    lblChar.textContent = ch.name;
    lblInfo.textContent = ch.desc ?? '';
    for (const { t, b } of tabs) b.classList.toggle('on', t === state.tab);
    const isMisc = state.tab === 'misc';
    panel.style.display = isMisc ? 'none' : ''; misc.style.display = isMisc ? '' : 'none';
    const mine = (kind) => info.lookItems.filter((i) => i.kind === kind && (!i.character || i.character === state.char));
    if (isMisc) {
      for (const { slot, row } of miscRows) {
        row.replaceChildren();
        for (const i of mine('attachment').filter((x) => x.slot === slot)) itemButton(i, row, slot, false);
      }
      count.textContent = `${MISC.filter(([s]) => c.picks[s] !== undefined).length} / 4 selected`;
    } else {
      panel.replaceChildren();
      const required = state.tab === 'mask';
      if (!required) skinDefault();
      for (const i of mine(SINGLE[state.tab])) itemButton(i, panel, state.tab, required);
      // the picker item's own color
      if (state.tab === 'color' && info.lookItems.find((i) => i.id === c.picks.color)?.picker) {
        const box = mk('input', 'cz-pick', panel);
        box.type = 'color'; box.title = 'Color'; box.setAttribute('aria-label', 'Color');
        box.value = c.custom ?? '#ffffff';
        box.oninput = () => { c.custom = box.value; persist(); hooks.onChange?.(); };
      }
    }
    const sword = swordOf(c.sword);
    lblGroup.textContent = `Group: ${groups()[state.group] === 'Default' ? 'Default' : (info.swordNames?.[groups()[state.group]] ?? groups()[state.group])}`;
    lblSword.textContent = sword?.name ?? '';
    lblType.textContent = info.swordNames?.[sword?.type] ?? sword?.type ?? '';
    iconUrl(`vgui/swordtypes/swordtype_${sword?.type}`).then((u) => { if (u) typeIcon.src = u; });
    persist();
    hooks.onChange?.();
  }

  const api = {
    open: true,
    hooks,
    el: cz,
    get char() { return state.char; },
    get name() { return name.value; },
    get sword() { return forChar().sword; },
    get list() { return swordList().map((s) => s.id); },
    // item ids to wear; the server keeps what's valid
    get look() { return Object.values(forChar().picks); },
    // the picker's color when that's what's chosen
    get color() {
      const c = forChar();
      if (!info.lookItems.find((i) => i.id === c.picks.color)?.picker) return null;
      const h = c.custom ?? '#ffffff';
      return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    },
    show(inMatch) { api.open = true; cz.style.display = ''; keys.style.display = inMatch ? 'none' : ''; cancel.style.display = inMatch ? '' : 'none'; confirm.textContent = 'Select'; render(); },
    hide() { api.open = false; cz.style.display = 'none'; },
    ready() { confirm.disabled = false; confirm.textContent = 'Select'; },
    onConfirm(fn) { confirm.onclick = fn; },
    onCancel(fn) { cancel.onclick = fn; },
  };
  cancel.style.display = 'none';
  render();
  return api;
}
