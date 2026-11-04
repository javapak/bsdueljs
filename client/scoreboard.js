// The Tab scoreboard: every arena in its own column, with a live view, who's playing, queued and watching.
// Header from resource/ui/scoreboard_header.res; rows and buttons from scoreboard_match.res; text from basemodui_english.
// Columns from client 18028abcb: (wide - 70) / 3 apart by 15 at x 20, y 55. Inside one from 1802dc8d0: the view is 65% of
// the width at the screen's shape, inset 12; the name chip sits 12 above its bottom with the pvp chip under it; two
// buttons 20 tall stack against its bottom, 8 from its right. [I] where the status line and text rows go.

const CSS = `
#sb{position:fixed;inset:0;z-index:4;--u:calc(100vh / 480);pointer-events:none;color:#fff;font-family:ropasans-regular,sans-serif;display:none}
#sb .sb-head{position:absolute;left:calc(var(--u) * 20);right:calc(var(--u) * 20);top:calc(var(--u) * 20);height:calc(var(--u) * 20);background:#000;text-align:center;font:400 calc(var(--u) * 11)/calc(var(--u) * 20) Harabara,sans-serif}
#sb .sb-cols{position:absolute;left:calc(var(--u) * 20);right:calc(var(--u) * 20);top:calc(var(--u) * 55);max-height:calc(100vh - var(--u) * 75);display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:calc(var(--u) * 15);align-items:start}
#sb .sb-col{position:relative;z-index:0;overflow:hidden;max-height:calc(100vh - var(--u) * 75);box-sizing:border-box}
#sb .sb-top{position:relative;padding:calc(var(--u) * 12) 0}
/* The view is drawn on the canvas under the page: this is a hole in the panel, its shadow painting the panel around it */
#sb .sb-shot{position:relative;z-index:-1;margin-left:calc(var(--u) * 12);width:65%;aspect-ratio:var(--ar,1.78);box-shadow:0 0 0 200vmax #000d}
#sb .sb-col.here .sb-shot{outline:calc(var(--u) * 1) solid #fff}
#sb .sb-name{position:absolute;left:0;bottom:calc(var(--u) * 12);padding:calc(var(--u) * 2) calc(var(--u) * 8);background:#000;font:400 calc(var(--u) * 12)/1.1 Harabara,sans-serif;white-space:nowrap}
#sb .sb-pvp{position:absolute;right:0;top:100%;padding:calc(var(--u) * 1) calc(var(--u) * 8);background:#000;font:400 calc(var(--u) * 8)/1.1 Harabara,sans-serif}
#sb .sb-side{position:absolute;left:calc(var(--u) * 20 + 65%);right:calc(var(--u) * 8);top:calc(var(--u) * 12);bottom:calc(var(--u) * 12);display:flex;flex-direction:column;color:#7f7f7f;font-size:calc(var(--u) * 7);line-height:1.4;white-space:nowrap;overflow:hidden}
#sb .sb-btns{margin-top:auto;display:flex;flex-direction:column;gap:calc(var(--u) * 4)}
#sb .sb-btns button{width:auto;margin:0;padding:0;height:calc(var(--u) * 20);border:0;border-radius:0;background:#e4e4e4;color:#111;cursor:pointer;font:400 calc(var(--u) * 8) Harabara,sans-serif}
#sb .sb-btns button:hover{background:#fff}
#sb.live .sb-btns{pointer-events:auto}
#sb .sb-body{padding:0 calc(var(--u) * 12) calc(var(--u) * 12)}
#sb .sb-status{font-size:calc(var(--u) * 7);line-height:1.3;color:#ccc}
#sb .sb-sec{display:grid;grid-template-columns:1fr calc(var(--u) * 42) calc(var(--u) * 24);color:#808080;font-size:calc(var(--u) * 6);border-bottom:calc(var(--u) * .5) solid #808080;margin-top:calc(var(--u) * 6);padding-bottom:calc(var(--u) * 1)}
#sb .sb-row{display:grid;grid-template-columns:1fr calc(var(--u) * 42) calc(var(--u) * 24);font-size:calc(var(--u) * 8);line-height:1.5}
#sb .sb-row span,#sb .sb-sec span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#sb .sb-row span+span,#sb .sb-sec span+span{text-align:center}
#sb .sb-row.you{color:#ffd24a}
`;

/**
 * @param {object} d An arena from the snapshot.
 * @returns {string} The status line under its name.
 */
const statusOf = (d) => {
  if (d.f.length >= 2) {
    const base = `playing round ${d.r} in best ${Math.floor(d.max / 2) + 1} out of ${d.max}`;
    if (d.s === 'warmup') return `${base}, round starting...`;
    if (d.s === 'fight') return `${base}, ${Math.ceil(d.tm)} seconds remaining`;
    if (d.s === 'intermission') return `${base}, round ending...`;
    return base;
  }
  return d.q.length ? 'waiting for players' : 'this arena is empty';
};

/**
 * The board held on Tab: every arena with its live view, players, queue and watchers.
 * @param {HTMLElement} root Where it goes.
 * @param {object} o Options.
 * @param {string} o.title Title.
 * @param {function(number): void} o.onJoin Join pressed, with the arena.
 * @param {function(number): void} o.onView View pressed, with the arena.
 * @returns {object} The board's controls.
 */
export function createScoreboard(root, { title, onJoin, onView }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.id = 'sb';
  el.innerHTML = '<div class="sb-head"></div><div class="sb-cols"></div>';
  el.querySelector('.sb-head').textContent = title;
  root.append(el);
  const cols = el.querySelector('.sb-cols');
  const add = (parent, tag, cls, text = '') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; parent.append(e); return e; };
  const section = (col, label, stats) => {
    const s = add(col, 'div', 'sb-sec');
    add(s, 'span', '', label); add(s, 'span', '', stats ? 'wins-losses' : ''); add(s, 'span', '', 'ping');
  };
  const row = (col, r, myId, stats) => {
    const e = add(col, 'div', r[0] === myId ? 'sb-row you' : 'sb-row');
    add(e, 'span', '', r[1]); add(e, 'span', '', stats ? `${r[3] ?? 0}-${r[4] ?? 0}` : ''); add(e, 'span', '', String(r[5] ?? 0));
  };
  const built = [];
  let open = false;
  const api = {
    get open() { return open; },
    show(on, cursorFree) { open = on; el.style.display = on ? 'block' : 'none'; el.classList.toggle('live', !!cursorFree); el.style.setProperty('--ar', innerWidth / innerHeight); },
    // Where each arena's view goes, in the canvas's pixels
    shots(canvas) {
      const box = canvas.getBoundingClientRect(), sx = canvas.width / box.width, sy = canvas.height / box.height;
      return built.map((c, i) => {
        const r = c.shot.getBoundingClientRect();
        // out to whole pixels: the hole's edges round outward too, and would show the main view through them
        const x = Math.floor((r.left - box.left) * sx), y = Math.floor((r.top - box.top) * sy);
        return { i, x, y, w: Math.ceil((r.right - box.left) * sx) - x, h: Math.ceil((r.bottom - box.top) * sy) - y };
      });
    },
    update(arenas, myId, viewing) {
      if (!open) return;
      // rebuild the rows each update; the column and its buttons stay put so they can be clicked
      arenas.forEach((d, i) => {
        let c = built[i];
        if (!c) {
          const col = add(cols, 'div', 'sb-col'), top = add(col, 'div', 'sb-top'), shot = add(top, 'div', 'sb-shot');
          const name = add(shot, 'div', 'sb-name');
          const nameText = add(name, 'span', '');
          add(name, 'div', 'sb-pvp', '1 vs 1');
          const side = add(top, 'div', 'sb-side'), body = add(col, 'div', 'sb-body');
          c = built[i] = { col, shot, name: nameText, playing: add(side, 'div', ''), queued: add(side, 'div', ''), watching: add(side, 'div', ''), btns: add(side, 'div', 'sb-btns'), status: add(body, 'div', 'sb-status'), body: add(body, 'div', '') };
          c.join = add(c.btns, 'button', ''); c.join.onclick = () => onJoin(i);
          const view = add(c.btns, 'button', '', 'View'); view.onclick = () => onView(i);
        }
        const byId = new Map(d.q.map((r) => [r[0], r]));
        const playing = d.f.map((id) => byId.get(id)).filter(Boolean), queued = d.q.filter((r) => !d.f.includes(r[0]));
        c.col.classList.toggle('here', i === viewing);
        c.name.textContent = d.n;
        c.playing.textContent = `Playing: ${playing.length}`;
        c.queued.textContent = `Queued: ${queued.length}`;
        c.watching.textContent = `Spectating: ${d.sp?.length ?? 0}`;
        c.status.textContent = statusOf(d);
        c.join.textContent = d.q.some(([id]) => id === myId) ? 'Leave Match' : 'Join Match';
        c.body.replaceChildren();
        section(c.body, 'players', true);
        for (const r of playing) row(c.body, r, myId, true);
        if (queued.length) { section(c.body, 'queued', true); for (const r of queued) row(c.body, r, myId, true); }
        if (d.sp?.length) { section(c.body, 'would just like to watch', false); for (const r of d.sp) row(c.body, r, myId, false); }
      });
    },
  };
  return api;
}
