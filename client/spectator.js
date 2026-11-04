// What a fighter out of the match sees: who's playing and who's next in the arena being watched, the state line at the
// bottom, and the controls Space opens. Layout from resource/ui/spectator_controls.res, in its 640x480 proportional units.
// Text is the game's (basemodui_english). [I] the duel info panel's place on screen isn't in any .res file.

const CSS = `
#sp{position:fixed;inset:0;z-index:4;--u:calc(100vh / 480);pointer-events:none;color:#fff;font-family:ropasans-regular,sans-serif;display:none}
#sp .sp-state{position:absolute;left:0;right:0;bottom:calc(var(--u) * 12);text-align:center;font:400 calc(var(--u) * 9)/1.3 Harabara,sans-serif;text-shadow:0 0 3px #000,1px 1px 2px #000}
#sp.open .sp-state{bottom:calc(var(--u) * 78)}
#sp .sp-info{position:absolute;left:calc(var(--u) * 10);top:calc(var(--u) * 70);width:calc(var(--u) * 170);font-size:calc(var(--u) * 8);text-shadow:0 0 3px #000,1px 1px 2px #000}
#sp .sp-head{font:400 calc(var(--u) * 9)/1.2 Harabara,sans-serif;background:#000;padding:calc(var(--u) * 2) calc(var(--u) * 6);margin-top:calc(var(--u) * 6)}
#sp .sp-line{padding:calc(var(--u) * 1.5) calc(var(--u) * 6);background:#0008}
#sp .sp-line.you{color:#ffd24a}
#sp .sp-bar{position:absolute;left:calc(100vw - var(--u) * 380);top:calc(100vh - var(--u) * 70);width:calc(var(--u) * 380);height:calc(var(--u) * 60);background:#000;pointer-events:auto;display:none}
#sp .sp-bar>*{position:absolute}
#sp .sp-lbl{color:#606060;font:400 calc(var(--u) * 8)/calc(var(--u) * 13) ropasans-regular,sans-serif}
#sp .sp-wheel{display:flex;align-items:center;justify-content:space-between;font:400 calc(var(--u) * 8)/calc(var(--u) * 13) ropasans-regular,sans-serif;white-space:nowrap;overflow:hidden}
#sp .sp-wheel span{flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis}
#sp .sp-wheel button,#sp .sp-btn{width:auto;margin:0;padding:0;border:0;border-radius:0;cursor:pointer;font:400 calc(var(--u) * 8) Harabara,sans-serif}
#sp .sp-wheel button{background:none;color:#fff;padding:0 calc(var(--u) * 3)}
#sp .sp-btn{background:#e4e4e4;color:#111}#sp .sp-btn:hover{background:#fff}
`;

export function createSpectator(root, { mapName, onReady, onCustomize }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.id = 'sp';
  el.innerHTML = '<div class="sp-info"></div><div class="sp-state"></div><div class="sp-bar"></div>';
  root.append(el);
  const info = el.querySelector('.sp-info'), stateEl = el.querySelector('.sp-state'), bar = el.querySelector('.sp-bar');
  const at = (e, x, y, w, h) => { e.style.cssText += `;left:calc(var(--u) * ${x});top:calc(var(--u) * ${y});width:calc(var(--u) * ${w});height:calc(var(--u) * ${h})`; return e; };
  const mk = (tag, cls, x, y, w, h, text = '') => { const e = document.createElement(tag); e.className = cls; e.textContent = text; bar.append(at(e, x, y, w, h)); return e; };
  mk('div', 'sp-lbl', 15, 9, 45, 13, 'VIEW');
  mk('div', 'sp-lbl', 15, 24, 45, 13, 'PLAYER');
  mk('div', 'sp-lbl', 15, 39, 45, 13, 'DUEL');
  const wheel = (y, step) => {
    const w = mk('div', 'sp-wheel', 60, y, 120, 13);
    const l = document.createElement('button'), s = document.createElement('span'), r = document.createElement('button');
    l.textContent = '<'; r.textContent = '>'; l.setAttribute('aria-label', 'Previous'); r.setAttribute('aria-label', 'Next');
    l.onclick = () => step(-1); r.onclick = () => step(1);
    w.append(l, s, r);
    return s;
  };
  const view = { arena: 0, mode: 'duel', follow: null, open: false };
  let last = { arenas: [], players: [] };
  const cycle = (d) => {
    const n = last.arenas.length || 1;
    view.arena = (view.arena + d + n) % n;
    view.follow = null;
  };
  const stepFollow = (d) => {
    const list = last.arenas[view.arena]?.f ?? [];
    if (!list.length) return;
    view.follow = list[(Math.max(0, list.indexOf(view.follow)) + d + list.length) % list.length];
    view.mode = 'player';
  };
  const wView = wheel(9, () => { view.mode = view.mode === 'duel' ? 'player' : 'duel'; });
  const wPlayer = wheel(24, stepFollow);
  const wDuel = wheel(39, cycle);
  const ready = mk('button', 'sp-btn', 190, 7, 60, 20);
  ready.onclick = () => onReady();
  mk('button', 'sp-btn', 255, 7, 60, 20, 'Customize').onclick = () => onCustomize();
  const close = mk('button', 'sp-btn', 295, 33, 20, 20, 'X');
  close.setAttribute('aria-label', 'Close');
  close.onclick = () => api.toggle(false);

  const nameIn = (d, id) => d.q?.find(([q]) => q === id)?.[1] ?? '?';
  const api = {
    view,
    toggle(on = !view.open) { view.open = on; bar.style.display = on ? 'block' : 'none'; el.classList.toggle('open', on); },
    cycle,
    show(on) { el.style.display = on ? 'block' : 'none'; },
    // arenas from the snapshot; me: the local player's id
    update(arenas, myId, spectating) {
      last = { arenas };
      if (!arenas.length) return;
      if (view.arena >= arenas.length) view.arena = 0;
      const d = arenas[view.arena], name = d.n;
      const followed = view.follow !== null && d.f.includes(view.follow) ? view.follow : d.f[0] ?? null;
      view.follow = followed;
      const pos = d.q.findIndex(([id]) => id === myId), queuedElsewhere = arenas.some((a, i) => i !== view.arena && a.q.some(([id]) => id === myId));
      // [bb_hud_spectator_state_*, bb_hud_spectator_queue_*]
      const lines = [];
      if (spectating && view.mode === 'player' && followed !== null) lines.push(`YOU ARE SPECTATING ${nameIn(d, followed).toUpperCase()} IN ${name.toUpperCase()}`);
      if (pos >= 0) {
        const unready = d.q[pos][2];
        if (unready) lines.push('YOU LEAVE THE QUEUE AFTER THIS MATCH');
        else if (spectating) lines.push(pos - d.f.filter((id) => d.q.some(([q]) => q === id)).length === 0 ? `YOU ARE NEXT ON ${name.toUpperCase()} IN ${mapName.toUpperCase()}` : `YOU ARE QUEUED TO DUEL ON ${name.toUpperCase()} IN ${mapName.toUpperCase()}`);
      } else if (spectating) lines.push(`PRESS R TO PLAY ON ${name.toUpperCase()} IN ${mapName.toUpperCase()}`);
      if (spectating && !view.open) lines.push('PRESS SPACE TO OPEN SPECTATOR CONTROLS');
      if (queuedElsewhere) lines.push('YOU ARE QUEUED IN ANOTHER ARENA');
      stateEl.innerHTML = '';
      for (const l of lines) { const e = document.createElement('div'); e.textContent = l; stateEl.append(e); }
      // [CVGUISpectatorPanel, CVGUISpectatorQueue]
      info.innerHTML = '';
      if (!spectating) return;
      const line = (cls, text) => { const e = document.createElement('div'); e.className = cls; e.textContent = text; info.append(e); };
      line('sp-head', name);
      if (d.f.length >= 2) {
        line('sp-head', 'Current Match');
        line('sp-line', `${nameIn(d, d.f[0])} vs ${nameIn(d, d.f[1])}`);
      }
      const next = d.q.filter(([id]) => !d.f.includes(id));
      if (next.length) {
        line('sp-head', `Up next in ${name}`);
        for (const [id, n] of next.slice(0, 4)) line(id === myId ? 'sp-line you' : 'sp-line', id === myId ? 'YOU' : n);
        if (next.length > 4) line('sp-line', `(${next.length - 4} more)`);
      }
      wView.textContent = view.mode === 'duel' ? 'Duel view' : 'Player view';
      wPlayer.textContent = followed !== null ? nameIn(d, followed) : '-';
      wDuel.textContent = name;
      ready.textContent = pos >= 0 ? 'Spectate only' : 'Join this arena';
    },
  };
  return api;
}
