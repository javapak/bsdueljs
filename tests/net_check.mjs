// End-to-end: launches the real server and connects two real WebSocket clients (Node's built-in
// WebSocket) that fight using only network input. Exits 0 once a full match completes with a winner.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const game = process.argv[2], map = process.argv[3] || 'duel_practice_box', port = process.argv[4] || '27117';
const srv = spawn('node', [fileURLToPath(new URL('../server/main.mjs', import.meta.url)), '--game', game, '--map', map, '--port', port]);
srv.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((ok) => srv.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const r = await (await fetch(`http://localhost:${port}/api/info`)).json();
console.log('info', r.map, Object.keys(r.characters).join(','));
for (const [p, want] of [['/game/maps/' + map + '.bsp', 200], ['/shared/sim.js', 200], ['/game/../../etc/passwd', 404], ['/game/%2e%2e/%2e%2e/%2e%2e/etc/passwd', 404], ['/%2e%2e/server/main.mjs', 404]]) {
  const x = await fetch(`http://localhost:${port}${p}`); await x.arrayBuffer?.();
  console.log(p, x.status, x.status === want ? 'ok' : `WANT ${want}`);
}
const IN = { ATTACK: 1, FORWARD: 8, BLOCK: 0x800000 };
const mk = (name, character) => new Promise((ok) => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const c = { ws, name, id: null, snap: null, evs: [] };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, character, queue: true }));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') { c.id = m.id; ok(c); } if (m.t === 'snap') c.snap = m; if (m.t === 'ev') c.evs.push(...m.ev); };
});
const a = await mk('A', 'knight'), b = await mk('B', 'phalanx');
let done = false, seq = 0, bytes = 0, lastLog = 0;
const t0 = Date.now();
const iv = setInterval(() => {
  for (const c of [a, b]) {
    const s = c.snap; if (!s) continue;
    const me = s.players.find((x) => x.id === c.id), o = s.players.find((x) => x.id !== c.id);
    if (!me || !o) continue;
    const dx = o.o[0] - me.o[0], dy = o.o[1] - me.o[1], d = Math.hypot(dx, dy);
    const yaw = Math.atan2(dy, dx) * 180 / Math.PI;
    let bt = 0;
    if (d > 55) bt |= IN.FORWARD; else if (!me.a) bt |= IN.ATTACK;
    const m = JSON.stringify({ t: 'cmd', s: ++seq, b: bt, y: yaw, p: 0 }); bytes += m.length;
    c.ws.send(m);
  }
  const s = a.snap;
  if (s && Date.now() - lastLog > 5000) { lastLog = Date.now(); console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', s.duel.s, 'round', s.duel.r, 'wins', JSON.stringify(s.duel.w), 'hp', s.players.map((p) => p.hp).join('/')); }
  const over = a.evs.find((e) => e.type === 'duel_over');
  if (over && !done) {
    done = true;
    const cnt = {}; for (const e of a.evs) cnt[e.type] = (cnt[e.type] || 0) + 1;
    console.log('MATCH OVER winner', over.winner, 'wins', JSON.stringify(over.wins), 'in', ((Date.now() - t0) / 1000).toFixed(1), 's', JSON.stringify(cnt));
    a.ws.close(); b.ws.close(); clearInterval(iv); srv.kill(); process.exit(over.winner ? 0 : 1);
  }
}, 15);
setTimeout(() => { console.log('TIMEOUT'); srv.kill(); process.exit(2); }, 180000);
