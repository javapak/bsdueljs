// A real match over real WebRTC, between two real browser engines: Chrome and Firefox each run the sim and a rollback session in a page,
// joined through the real relay, and play for real time. Their state hashes have to agree. There's no renderer in this; it's the netcode.
// Loopback is too quick for anything to roll back, so each page also holds its packets back and drops some, as a real connection would.
// Usage: node tests/p2p_check.mjs "<install>" [seconds] [ms each way] [loss, 0 to 1]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../p2p/relay.mjs';

const G = join(process.argv[2], 'berimbau') + sep, SECONDS = +(process.argv[3] ?? 40), LAG = +(process.argv[4] ?? 70), LOSS = +(process.argv[5] ?? 0.05);
const repo = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe', FIREFOX = 'C:/Program Files/Mozilla Firefox/firefox.exe';
const TYPES = { '.js': 'text/javascript', '.json': 'application/json' };
const inside = (root, rel) => { const p = join(root, normalize(rel)); return p.startsWith(root) && existsSync(p) && statSync(p).isFile() ? p : null; };
const page = (seat) => `<!doctype html><script type="module">
import { BSP } from '/shared/bsp.js';
import { GameData } from '/shared/gamedata.js';
import { CharacterStore } from '/shared/assets.js';
import { World, Player, Match, Cvars, IN, TICK } from '/shared/sim.js';
import { RollbackSession, packInput, encodePacket, decodePacket } from '/shared/rollback.js';
import { connectPeer } from '/client/peer.js';
const send = (o) => fetch('/result', { method: 'POST', body: JSON.stringify({ seat: ${seat}, ...o }) });
window.onerror = (m) => { send({ error: String(m) }); };
try {
  const bytes = async (p) => { const r = await fetch('/game/' + p); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; };
  const text = async (p) => { const b = await bytes(p); if (!b) throw new Error('missing ' + p); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const cvars = new Cvars(await (await fetch('/shared/cvars_all.json')).json());
  const data = await GameData.load(text, cvars);
  const assets = new CharacterStore(bytes, data);
  await assets.preload('knight'); await assets.preload('ryoku');
  const bsp = new BSP(await bytes('maps/duel_temple.bsp'));
  await bsp.addPropCollision(bytes);
  const peer = await connectPeer({ relay: 'ws://' + location.host + '/relay', room: 'test', build: 'same' });
  const w = new World({ bsp, data, cvars, assets, map: 'duel_temple', seed: peer.seed, arenas: Match.single });
  const P = [new Player(1, 'A', 'knight'), new Player(2, 'B', 'ryoku')];
  P[0].sword = 'longsword'; P[1].sword = 'katana';
  w.duels[0].seat(P);
  const me = peer.seat, s = new RollbackSession({ world: w, fighters: P, me, send: (p) => { const out = encodePacket(p); if (Math.random() >= ${LOSS}) setTimeout(() => peer.send(out), ${LAG}); }, onDesync: (f) => console.error('desync', f) });
  let gone = false, got = 0, bytesIn = 0, errors = 0;
  peer.onPacket = (b) => { got++; bytesIn += b.byteLength; s.receive(decodePacket(b)); };
  peer.onClose = () => { gone = true; };
  let r = peer.seed ^ (me * 7919 + 1), b = 0, pitch = -10;
  const rand = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
  const keys = [IN.ATTACK, IN.ATTACK, IN.ATTACK, IN.BLOCK, IN.FORWARD, IN.FORWARD, IN.LEFT, IN.RIGHT, IN.BACK, IN.JUMP, IN.ROLL, IN.SHUFFLE, IN.GRAB, IN.THROW, IN.STANCE_FAST, IN.STANCE_HEAVY, IN.SHEATHE];
  const input = () => {
    if (rand() < 0.07) b ^= keys[Math.trunc(rand() * keys.length)];
    if (rand() < 0.04) b &= IN.ATTACK | IN.FORWARD;
    const a = P[me], o = P[1 - me], yaw = Math.atan2(o.origin[1] - a.origin[1], o.origin[0] - a.origin[0]) * 180 / Math.PI;
    pitch = Math.max(-60, Math.min(40, pitch + (rand() - 0.5) * 3));
    return packInput([b, yaw + (rand() - 0.5) * 30, pitch]);
  };
  const t0 = performance.now(), happened = {}, ticks = ${SECONDS} * 64;
  let last = t0, acc = 0, worst = 0, done = 0, slowTicks = 0;
  const finish = () => { clearInterval(iv); send({ hashes: [...s.hashes], frame: s.frame, stats: s.stats, desynced: s.desynced, got, bytesIn, worst, slowTicks, gone, errors, happened, ms: performance.now() - t0, ua: navigator.userAgent }); };
  const iv = setInterval(() => {
    const now = performance.now();
    acc = Math.min(acc + (now - last) / 1000, 0.25);
    last = now;
    try {
      while (acc >= TICK) {
        acc -= TICK;
        const a = performance.now();
        s.tick(done < ticks - 192 ? input() : [0, 0, 0]);
        const dt = performance.now() - a;
        if (dt > worst) worst = dt;
        if (dt > 1000 / 64) slowTicks++;
        for (const e of s.takeEvents().fresh) happened[e.event.type] = (happened[e.event.type] ?? 0) + 1;
        if (++done >= ticks) { finish(); return; }
      }
    } catch (e) { clearInterval(iv); send({ error: String(e.stack || e) }); }
  }, 2);
} catch (e) { send({ error: String(e.stack || e) }); }
</script>`;

const results = [];
let allIn;
const finished = new Promise((ok) => { allIn = ok; });
const relay = createRelay();
const server = http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.end('ok'); results.push(JSON.parse(b)); if (results.length === 2 || results.at(-1).error) allIn(); }); return; }
  if (path === '/a' || path === '/b') { res.setHeader('content-type', 'text/html'); res.end(page(path === '/a' ? 0 : 1)); return; }
  const file = path.startsWith('/game/') ? inside(G, path.slice(6)) : /^\/(shared|client|tests)\//.test(path) ? inside(repo, path.slice(1)) : null;
  if (!file) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
server.on('upgrade', relay);
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const dirs = [mkdtempSync(join(tmpdir(), 'bsp2p-')), mkdtempSync(join(tmpdir(), 'bsp2p-'))];
// Show local addresses as they are rather than hiding them behind mDNS names, which two engines can't resolve for each other in a test
writeFileSync(join(dirs[1], 'user.js'), 'user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);\nuser_pref("media.peerconnection.ice.loopback", true);\nuser_pref("dom.min_background_timeout_value", 4);\n');
const a = spawn(CHROME, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=WebRtcHideLocalIpsWithMdns', `--user-data-dir=${dirs[0]}`, `${base}/a`], { stdio: 'ignore' });
const b = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', dirs[1], `${base}/b`], { stdio: 'ignore' });
const timeout = setTimeout(() => { results.push({ error: 'timed out' }); allIn(); }, (SECONDS + 150) * 1000);
await finished;
clearTimeout(timeout);
a.kill(); b.kill();
server.closeAllConnections?.(); server.close();
await new Promise((ok) => setTimeout(ok, 1500));
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* the browser may hold it a moment; it's the temp folder */ } }

let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
for (const r of results) if (r.error) check(false, `seat ${r.seat ?? '?'}: ${r.error}`);
const [ra, rb] = [results.find((r) => r.seat === 0), results.find((r) => r.seat === 1)];
if (ra?.hashes && rb?.hashes) {
  for (const r of [ra, rb]) console.log(`${r.ua.includes('Firefox') ? 'Firefox' : 'Chrome'}: frame ${r.frame} in ${(r.ms / 1000).toFixed(1)}s, ${r.got} packets, ${(r.bytesIn / 1024).toFixed(0)} KB in, rollbacks ${r.stats.rollbacks}, deepest ${r.stats.deepest}, stalled ${r.stats.stalls}, evened out ${r.stats.slowdowns}, worst tick ${r.worst.toFixed(1)} ms, ${r.slowTicks} over budget`);
  const mb = new Map(rb.hashes);
  let compared = 0, differ = 0;
  for (const [f, h] of ra.hashes) if (mb.has(f)) { compared++; if (mb.get(f) !== h) differ++; }
  check(ra.ua.includes('Chrome') && rb.ua.includes('Firefox'), 'really Chrome against Firefox');
  check(ra.desynced === null && rb.desynced === null, `neither saw a desync${ra.desynced ?? rb.desynced ?? ''}`);
  check(compared >= (SECONDS - 6) && differ === 0, `${compared} state hashes compared across engines, ${differ} differ`);
  check(ra.got > SECONDS * 30 && rb.got > SECONDS * 30, 'packets flowed both ways, directly');
  if (LAG > 30) check(ra.stats.rollbacks > 100 && rb.stats.rollbacks > 100 && ra.stats.deepest > 1, 'and it really rolled back on both sides');
  check((ra.happened.swing ?? 0) > 3 && (rb.happened.swing ?? 0) > 3, `a real fight: ${Object.entries(ra.happened).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`);
  check(ra.frame > SECONDS * 64 * 0.9 && rb.frame > SECONDS * 64 * 0.9, `it ran at full speed: ${ra.frame} and ${rb.frame} frames of ${SECONDS * 64}`);
} else if (!results.some((r) => r.error)) check(false, 'no results');
console.log(fails ? `${fails} FAILED` : 'Chrome and Firefox played a match over WebRTC and agree');
process.exit(fails ? 1 : 0);
