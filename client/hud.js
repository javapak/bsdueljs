// The in-game duel HUD. Colors, fonts, timing and art are read from the player's install at runtime:
// scripts/HudLayout.res, resource/ClientScheme.res, resource/fonts and materials/vgui.
import { parseKV, kvFind } from '/shared/kv.js';
import { parseVTF, decodeLevel } from './vtf.js';

// In 480-high HUD units, from the screen edge unless noted. Fighter panels are measured from retail screenshots at
// 1280x720; the stance panel is [R client.dll 1802a6377, 1802a786a]: key box, then plate, then nodes.
const G = {
  portrait: { x: 10, y: 4, w: 38.5, h: 49 },
  plate: { x: 48.5, y: 4, w: 53.5, h: 15.5 },
  emblem: { w: 16, y: 4, h: 15.5 },
  bar: { x: 51, y: 20.5, h: 17, centerGap: 38.7, frame: 2.5 },
  sword: { x: 54, y: 40 },
  timer: { time: 8, secs: 30, round: 37 },
  // [R client.dll 1802a33b9, 1802a34d0] from screen center: 36 + half a 13-unit tag, spaced 0.95 of a tag, every other
  // one shifted 0.2 of a tag so the middle sits lower. y is the center of the HudBerimbauRound panel.
  tag: { first: 42.5, step: 12.35, y: 36.5, stagger: 2.6, size: 13 },
  stance: { icon: { x: 2, y: 396 }, key: { x: 64, w: 16 }, row: { x: 81, w: 120, h: 12, pitch: 14, bottom: 10 }, node: { x: 219, step: 36, size: 5 }, trail: 1.6 },
};
// Rows top to bottom: stance index, key label, name.
const ROWS = [[3, '', 'Air'], [1, '1', 'Fast'], [0, '2', 'Balanced'], [2, '3', 'Heavy']];

const CSS = `
.dh-el{position:absolute;box-sizing:border-box}
.dh-shadow{box-shadow:0 0 calc(var(--s)*6px) rgba(0,0,0,.65)}
.dh-portrait{background:#000 center/cover no-repeat;outline:1px solid #fff}
.dh-plate{background:#000;color:#fff;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden}
.dh-emblem{background:#b9b9b9}
.dh-barframe{background:#000;outline:1px solid #000}
.dh-barline{position:absolute;inset:calc(var(--s)*1px);border:1px solid #8b8b8b}
.dh-bar{position:absolute;overflow:hidden;background:#000;background-size:auto 100%}
.dh-fill,.dh-buffer{position:absolute;top:0;bottom:0;background-size:auto 100%;background-blend-mode:multiply}
.dh-fill{filter:brightness(1.2)}
.dh-sword{color:#fff;white-space:nowrap;line-height:1;text-shadow:0 1px 2px #000,0 0 3px #000}
.dh-timer{left:0;right:0;top:0;height:0;color:#fff;text-align:center}
.dh-timer div{position:absolute;left:0;right:0;line-height:1;text-shadow:0 0 3px #000,0 0 6px #000;font-variant-numeric:tabular-nums}
.dh-tag{transform:rotate(45deg);outline:1px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff}
.dh-tag span{transform:rotate(-45deg);line-height:1}
.dh-row{background:#101010;color:#fff;transform:skewX(-8deg);display:flex;align-items:center;outline:1px solid #fff}
.dh-row span{transform:skewX(8deg);padding-left:calc(var(--s)*8px);line-height:1}
.dh-row.on{background:#fff;color:#000}
.dh-key{background:#101010;color:#fff;transform:skewX(-8deg);display:flex;align-items:center;justify-content:center;outline:1px solid #fff}
.dh-key span{transform:skewX(8deg);line-height:1}.dh-key.on{background:#fff;color:#000}
.dh-line{background:#fff;height:1px}
.dh-trail{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:1}
.dh-trail polyline{fill:none;stroke:#fff;stroke-linejoin:round}
.dh-node{background:#000;outline:1px solid #fff;box-shadow:0 0 calc(var(--s)*3px) rgba(0,0,0,.6);z-index:2}
.dh-node.hit{background:#fff}
.dh-node.on{outline-offset:calc(var(--s)*1.5px);background:#fff}
.dh-icon{color:#fff;-webkit-text-stroke:2px #000;paint-order:stroke fill;white-space:pre}
`;

const text = async (path) => {
  const u8 = new Uint8Array(await (await fetch('/game/' + path)).arrayBuffer());
  return new TextDecoder(u8[0] === 0xff && u8[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(u8);
};

/**
 * @param {string} path Material path under materials/.
 * @returns {Promise<string|null>} A URL an element can use.
 */
export async function vtfUrl(path) {
  const r = await fetch('/game/materials/' + path + '.vtf');
  if (!r.ok) return null;
  const t = parseVTF(new Uint8Array(await r.arrayBuffer()), 512);
  const l = t.levels[0], px = decodeLevel(t, l);
  const c = document.createElement('canvas');
  c.width = l.w; c.height = l.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, l.w * l.h * 4), l.w, l.h), 0, 0);
  return c.toDataURL();
}

const css = ([r, g, b, a = 255]) => `rgba(${r},${g},${b},${a / 255})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// [R client.dll 0x180298603] named scheme values, looked up across the scheme's sections
const schemeValue = (scheme, key) => { for (const sec of scheme) { if (!Array.isArray(sec.value)) continue; const n = kvFind(sec.value, key); if (n) return n.value; } return undefined; };

function fontOf(fonts, name, screenH) {
  for (const t of kvFind(fonts, name)?.value ?? []) {
    if (!Array.isArray(t.value)) continue;
    const yres = kvFind(t.value, 'yres')?.value?.split(/\s+/).map(Number);
    if (yres && (screenH < yres[0] || screenH > yres[1])) continue;
    return { family: kvFind(t.value, 'name')?.value, tall: Number(kvFind(t.value, 'tall')?.value ?? 12) };
  }
  return { family: 'Harabara', tall: 12 };
}

/**
 * [R client.dll 18029b550] The bar glides to the real health; on a loss the old value stays behind as the buffer,
 * which holds for healthbar.healthbuffer.delay and then drains. All values are 0..1 of the bar.
 * @param {object} d The bar: shown, buffer, last, holdUntil.
 * @param {number} target Real health, 0 to 1.
 * @param {number} now Time in seconds.
 * @param {number} dt Seconds.
 * @param {number} delay How long the buffer holds.
 */
export function stepHealthBar(d, target, now, dt, delay) {
  if (d.last !== target) {
    if (d.last > target && target > d.buffer) d.buffer = d.last;
    d.last = target;
    d.holdUntil = now + delay;
  }
  const toward = (from, step) => { const gap = target - from; return gap > step ? from + step : gap < -step ? from - step : target; };
  if (d.shown !== target) d.shown = toward(d.shown, (Math.min(Math.abs(target - d.shown), 1) * 4 + 1) * dt);
  if (d.buffer < d.shown) d.buffer = d.shown;
  if (now > d.holdUntil && d.buffer !== target) d.buffer = toward(d.buffer, Math.min(Math.abs(target - d.buffer), 1) * dt * 3.75 + dt * 0.25);
}

/**
 * Builds the duel HUD: health bars, portraits, the timer, round results, stance plates and the string display.
 * @param {HTMLElement} root Where it goes.
 * @param {object} [info] Server info, with strings per character.
 * @returns {Promise<{update: function}>} Call update(cur, me, myId, dt) each frame.
 */
export async function createHud(root, info = {}) {
  const [schemeSrc] = await Promise.all([text('resource/ClientScheme.res')]);
  const scheme = kvFind(parseKV(schemeSrc), 'Scheme').value;
  const fonts = kvFind(scheme, 'Fonts').value;
  const col = (k) => (schemeValue(scheme, k) ?? '255 255 255 255').trim().split(/\s+/).map(Number);
  const C = {
    low: col('healthbar.health.low'), med: col('healthbar.health.medium'), high: col('healthbar.health.high'),
    pulse: col('healthbar.pulse.colorbuffer'), tagEmpty: col('roundcounter.tagcolor.empty'), tagWin: col('roundcounter.tagcolor.win'), tagLose: col('roundcounter.tagcolor.lose'),
  };
  const bufferDelay = Number(schemeValue(scheme, 'healthbar.healthbuffer.delay') ?? 1.5);
  const pulseSpeed = Number(schemeValue(scheme, 'healthbar.healthbuffer.pulsespeed') ?? 8);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  for (const [family, file] of [['Harabara', 'fonts/Harabara.ttf'], ['ropasans-regular', 'fonts/RopaSans-Regular.otf'], ['Stances Font', 'stances.ttf']]) {
    const f = new FontFace(family, `url(/game/resource/${file})`);
    document.fonts.add(f);
    f.load().catch(() => {});
  }
  const [bgUrl, fillUrl] = await Promise.all([vtfUrl('vgui/hud/healthbar_bg'), vtfUrl('vgui/hud/filled_health_32')]);

  const mk = (cls, parent = root) => { const d = document.createElement('div'); d.className = `dh-el ${cls}`; parent.append(d); return d; };
  const timer = mk('dh-timer');
  const time = document.createElement('div'), secs = document.createElement('div'), round = document.createElement('div');
  timer.append(time, secs, round);
  secs.textContent = 'SECONDS LEFT'; // #bb_seconds_left
  const stanceIcon = mk('dh-icon');
  const trailSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  trailSvg.setAttribute('class', 'dh-trail');
  const trailLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  trailSvg.append(trailLine);
  root.append(trailSvg);
  const rows = ROWS.map(([st, key, name]) => {
    const keyBox = key ? mk('dh-key') : null;
    if (keyBox) keyBox.innerHTML = `<span>${key}</span>`;
    const plate = mk('dh-row');
    plate.innerHTML = `<span>${name}</span>`;
    return { st, keyBox, plate, parts: [], count: -1 };
  });
  const side = [0, 1].map(() => {
    const d = { shown: 1, buffer: 1, last: 1, holdUntil: 0, id: null };
    d.frame = mk('dh-barframe dh-shadow');
    mk('dh-barline', d.frame);
    d.bar = mk('dh-bar');
    d.bar.style.backgroundImage = bgUrl ? `url(${bgUrl})` : '';
    d.buf = mk('dh-buffer', d.bar);
    d.fill = mk('dh-fill', d.bar);
    for (const n of [d.buf, d.fill]) n.style.backgroundImage = fillUrl ? `url(${fillUrl})` : '';
    d.portrait = mk('dh-portrait dh-shadow');
    d.plate = mk('dh-plate dh-shadow');
    d.emblem = mk('dh-emblem');
    d.sword = mk('dh-sword');
    d.tags = [];
    return d;
  });

  let W = 0, H = 0, s = 1, trailKey = '';
  const box = (n, x, y, w, h) => Object.assign(n.style, { left: `${x * s}px`, top: `${y * s}px`, width: `${w * s}px`, height: `${h * s}px` });
  const font = (n, name) => { const f = fontOf(fonts, name, H); n.style.fontFamily = `"${f.family}",sans-serif`; n.style.fontSize = `${f.tall * s}px`; };
  // mirrors a left-side box for the right fighter
  const mirrored = (i, x, w) => (i ? W / s - x - w : x);
  function place() {
    W = window.innerWidth; H = window.innerHeight; s = H / 480;
    root.style.setProperty('--s', s);
    font(time, 'BBHudRoundTimerTime'); font(secs, 'BBHudRoundTimerInfo'); font(round, 'BBHudRoundTimerInfo');
    time.style.top = `${G.timer.time * s}px`; secs.style.top = `${G.timer.secs * s}px`; round.style.top = `${G.timer.round * s}px`;
    side.forEach((d, i) => {
      const b = G.bar, wide = W / s / 2 - b.centerGap - b.x;
      box(d.frame, mirrored(i, b.x, wide), b.y, wide, b.h);
      box(d.bar, mirrored(i, b.x + b.frame, wide - b.frame * 2), b.y + b.frame, wide - b.frame * 2, b.h - b.frame * 2);
      for (const n of [d.fill, d.buf]) { n.style[i ? 'left' : 'right'] = '0'; n.style[i ? 'right' : 'left'] = 'auto'; }
      box(d.portrait, mirrored(i, G.portrait.x, G.portrait.w), G.portrait.y, G.portrait.w, G.portrait.h);
      font(d.plate, 'BBHudHealthPlayerName');
      d.plateName = null;
      font(d.sword, 'BBHudHealthLoadout');
      Object.assign(d.sword.style, { top: `${G.sword.y * s}px`, left: i ? 'auto' : `${G.sword.x * s}px`, right: i ? `${G.sword.x * s}px` : 'auto' });
      d.tagKey = null;
    });
    const t = G.stance;
    const bottomY = (i) => 480 - t.row.bottom - t.row.h - (ROWS.length - 1 - i) * t.row.pitch;
    rows.forEach((r, i) => {
      box(r.plate, t.row.x, bottomY(i), t.row.w, t.row.h);
      font(r.plate, 'BBHudStance');
      if (r.keyBox) { box(r.keyBox, t.key.x, bottomY(i), t.key.w, t.row.h); font(r.keyBox, 'BBHudStance'); }
      r.count = -1;
    });
    // BBStanceIcon's cell is its tall value, so the em is that scaled by the font's own ascent + descent
    const icon = fontOf(fonts, 'BBStanceIcon', H), em = icon.tall * s * 1024 / 1136;
    Object.assign(stanceIcon.style, { left: `${t.icon.x * s}px`, top: `${t.icon.y * s}px`, fontFamily: `"${icon.family}"`, fontSize: `${em}px`, lineHeight: `${icon.tall * s}px` });
    trailKey = '';
  }
  place();
  window.addEventListener('resize', place);

  function setNodes(r, i, count) {
    if (r.count === count) return;
    r.count = count;
    r.parts.forEach((n) => n.remove());
    r.parts = [];
    const t = G.stance, y = 480 - t.row.bottom - t.row.h - (ROWS.length - 1 - i) * t.row.pitch + t.row.h / 2;
    if (count > 0) {
      const line = mk('dh-line');
      Object.assign(line.style, { left: `${(t.row.x + t.row.w) * s}px`, top: `${y * s}px`, width: `${(t.node.x + (count - 1) * t.node.step - t.row.x - t.row.w) * s}px` });
      r.parts.push(line);
    }
    r.nodes = [];
    for (let k = 0; k < count; k++) {
      const n = mk('dh-node');
      box(n, t.node.x + k * t.node.step - t.node.size / 2, y - t.node.size / 2, t.node.size, t.node.size);
      r.parts.push(n);
      r.nodes.push(n);
    }
  }

  // [R client.dll 1802a34d0] Results fill from the timer outward on both sides: W green, L red, D black. Unplayed rounds stay black and blank.
  // The string so far: from the first attack's stance plate through each node hit, to the one you're on. A stance
  // change mid-string makes it cut across rows.
  let trail = [], lastCi = 0, lastSt = 0;
  function setTrail(me) {
    const t = G.stance, ci = me.ci ?? 0, count = (st) => info.strings?.[me.c]?.[st] || 1;
    if (ci <= 0 || ci < lastCi) trail = [];
    else if (ci > lastCi) {
      const hit = [lastSt, lastCi % count(lastSt)], prev = trail.at(-1);
      if (!prev || prev[0] !== hit[0] || prev[1] !== hit[1]) trail.push(hit);
      // finishing a stance's whole string starts over; a one-node stance like air just stays put
      if (count(me.st) > 1 && me.st === lastSt && ci % count(me.st) === 0) trail = [];
    }
    lastCi = ci; lastSt = me.st;
    const cur = [me.st, ci % count(me.st)], path = [...trail, cur];
    const key = `${me.c}|${path.join(';')}`;
    if (key === trailKey) return;
    trailKey = key;
    const rowY = (st) => { const i = ROWS.findIndex((r) => r[0] === st); return 480 - t.row.bottom - t.row.h - (ROWS.length - 1 - i) * t.row.pitch + t.row.h / 2; };
    const pts = [[t.row.x + t.row.w, rowY(path[0][0])], ...path.map(([st, k]) => [t.node.x + k * t.node.step, rowY(st)])];
    trailLine.setAttribute('points', pts.map(([x, y]) => `${x * s},${y * s}`).join(' '));
    trailLine.setAttribute('stroke-width', t.trail * s);
  }

  function setTags(d, i, total, results, id) {
    const key = `${total}/${results.join()}/${id}`;
    if (d.tagKey === key) return;
    d.tagKey = key;
    d.tags.forEach((t) => t.remove());
    d.tags = [];
    const side = G.tag.size / Math.SQRT2;
    for (let k = 0; k < total; k++) {
      const off = G.tag.first + k * G.tag.step, cx = W / s / 2 + (i ? off : -off);
      const cy = G.tag.y + (k % 2 ? G.tag.stagger : -G.tag.stagger);
      const t = mk('dh-tag');
      box(t, cx - side / 2, cy - side / 2, side, side);
      const r = k < results.length ? (results[k] === null ? 'D' : results[k] === id ? 'W' : 'L') : '';
      t.style.background = css(r === 'W' ? C.tagWin : r === 'L' ? C.tagLose : C.tagEmpty);
      const letter = document.createElement('span');
      letter.textContent = r;
      font(letter, 'BBHudRoundCounterTag');
      t.append(letter);
      d.tags.push(t);
    }
  }

  // [R client.dll 1802a76a4, 1802a77a2] the icon is a character from BBStanceIcon: 'A' + 4 * block + stance, where air,
  // balanced, fast and heavy are 0 to 3. [I] the block's id is taken as the character's place in characters.txt.
  function setIcon(character, st) {
    const id = Object.keys(info.characters ?? {}).indexOf(character), block = id === 2 ? 1 : id === 4 ? 2 : 0;
    stanceIcon.textContent = String.fromCharCode(0x41 + block * 4 + (st + 1) % 4);
  }

  const images = new Map();
  const cached = (key, load, apply) => {
    if (!images.has(key)) images.set(key, load());
    images.get(key).then(apply);
  };
  const swordName = (k) => String(k ?? '').toUpperCase();

  return {
    update(cur, me, myId, dt) {
      const snap = cur.snap.duel;
      const ordered = [...cur.players].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : a.id - b.id));
      const now = performance.now() / 1000;
      side.forEach((d, i) => {
        const p = ordered[i];
        for (const n of [d.frame, d.bar, d.portrait, d.plate, d.emblem, d.sword, ...d.tags]) n.style.visibility = p ? 'visible' : 'hidden';
        if (!p) return;
        const target = Math.max(0, p.hp) / 100;
        if (d.id !== p.id) {
          d.id = p.id; d.shown = d.buffer = d.last = target; d.tagKey = null;
          cached(`portrait:${p.c}`, () => vtfUrl(`vgui/charicons/${p.c}`), (url) => { if (d.id === p.id) d.portrait.style.backgroundImage = url ? `url(${url})` : ''; });
        }
        stepHealthBar(d, target, now, dt, bufferDelay);
        const color = d.shown < 0.5 ? mix(C.low, C.med, d.shown * 2) : mix(C.med, C.high, (d.shown - 0.5) * 2);
        if (d.plateName !== p.n) {
          // the plate grows with a long name and pushes the emblem along
          d.plateName = p.n;
          d.plate.textContent = p.n;
          d.plate.style.width = 'auto';
          const wide = Math.max(G.plate.w, d.plate.offsetWidth / s + 8);
          box(d.plate, mirrored(i, G.plate.x, wide), G.plate.y, wide, G.plate.h);
          box(d.emblem, mirrored(i, G.plate.x + wide, G.emblem.w), G.emblem.y, G.emblem.w, G.emblem.h);
        }
        d.sword.textContent = `sword type: ${swordName(p.sw)}`; // #HealthHudSwordTag
        d.fill.style.width = `${d.shown * 100}%`;
        d.fill.style.backgroundColor = css(color);
        // [I] the shader's pulse, read off retail screenshots as a pale tint leaning toward healthbar.pulse.colorbuffer
        const pulse = 0.5 + 0.5 * Math.sin(now * pulseSpeed);
        d.buf.style.width = `${d.buffer * 100}%`;
        d.buf.style.backgroundColor = css(mix([165, 145, 145], C.pulse, pulse * 0.25));
        setTags(d, i, snap.s === 'waiting' ? 0 : snap.max ?? 3, snap.res ?? [], p.id);
      });
      // [I] nothing to count down until a duel is starting
      timer.style.visibility = snap.s === 'waiting' ? 'hidden' : '';
      time.textContent = String(Math.ceil(snap.tm));
      round.textContent = `ROUND ${snap.r}`; // #bb_round_label
      if (!me) return;
      setIcon(me.c, me.st);
      setTrail(me);
      rows.forEach((r, i) => {
        const active = r.st !== 3 && r.st === (me.gs ?? me.st); // the air row never lights: the ground stance stays selected
        r.plate.classList.toggle('on', active);
        r.keyBox?.classList.toggle('on', active);
        setNodes(r, i, info.strings?.[me.c]?.[r.st] ?? 0);
        (r.nodes ?? []).forEach((n, k) => {
          n.classList.toggle('on', me.st === r.st && k === (me.ci ?? 0) % r.nodes.length);
          n.classList.toggle('hit', trail.some(([st, at]) => st === r.st && at === k));
        });
      });
    },
  };
}
