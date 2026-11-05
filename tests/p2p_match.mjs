// The whole thing: two browsers each load the real client, with the renderer, find each other through the relay, and fight using real
// key and mouse events. Both see the same fight, no desync, and no page errors. Screenshots go next to the given prefix.
// With HOSTED=1 both load everything from one --hosted server with a token, and it reports how much a player downloads.
// Needs Playwright: PWDIR=<dir with playwright installed> node tests/p2p_match.mjs "<install>" <screenshot prefix>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(process.env.PWDIR + '/');
const { chromium } = require('playwright');
const [install, out] = process.argv.slice(2);
const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORTS = [27093, 27094], RELAY = 27095;
const HOSTED = !!process.env.HOSTED, TOKEN = 'check-token';
const procs = HOSTED ? [spawn('node', ['server/main.mjs', '--hosted', '--token', TOKEN, '--map', 'duel_temple', '--port', String(PORTS[0]), '--host', '127.0.0.1', '--game', install], { cwd: repo, stdio: 'ignore' })] : [spawn('node', ['p2p/relay.mjs', '--port', String(RELAY), '--host', '127.0.0.1'], { cwd: repo, stdio: 'ignore' })];
// Each player runs their own server from their own install; here both are on this machine
if (!HOSTED) for (const port of PORTS) procs.push(spawn('node', ['server/main.mjs', '--map', 'duel_temple', '--port', String(port), '--host', '127.0.0.1', '--game', install], { cwd: repo, stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 8000));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const browsers = [], pages = [], errs = [[], []];
const close = async () => { for (const b of browsers) await b.close().catch(() => {}); for (const p of procs) p.kill(); };
try {
  for (let i = 0; i < 2; i++) {
    const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    browsers.push(b);
    const pg = await b.newPage({ viewport: { width: 960, height: 540 } });
    pg.on('pageerror', (e) => errs[i].push(e.message));
    pg.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errs[i].push(m.text().slice(0, 200)); });
    const place = HOSTED ? `http://127.0.0.1:${PORTS[0]}/?token=${TOKEN}&` : `http://127.0.0.1:${PORTS[i]}/?relay=ws://127.0.0.1:${RELAY}&`;
    await pg.goto(`${place}nolock=1&vol=0&char=${i ? 'ryoku' : 'knight'}&p2p=check&delay=${i ? 3 : 2}&rollback=8`);
    await pg.waitForFunction(() => document.getElementById('status')?.textContent === 'Ready.', { timeout: 240000 });
    pages.push(pg);
  }
  for (const pg of pages) await pg.click('#go');
  for (const pg of pages) await pg.waitForFunction(() => window.duelDebug?.p2p && window.duelDebug.state?.me, { timeout: 120000 });
  check(true, 'both found each other through the relay and started');
  if (HOSTED) { const load = await pages[0].evaluate(() => { const e = performance.getEntriesByType('resource'); return { n: e.length, mb: e.reduce((s, x) => s + (x.decodedBodySize || 0), 0) / 1e6, game: e.filter((x) => x.name.includes('/game/')).length }; }); console.log(`     a player loaded ${load.n} files (${load.game} from the game), ${load.mb.toFixed(0)} MB before the fight, uncompressed`); }
  const state = (pg) => pg.evaluate(() => { const m = window.duelDebug.p2p, w = m.world, s = m.session; return { frame: s.frame, hp: w.players.map((p) => p.health), duel: w.duels[0].state, round: w.duels[0].round, wins: w.duels[0].wins, stats: s.stats, desynced: s.desynced, hashes: [...s.hashes], ch: w.players.map((p) => p.character), id: m.myId, fps: window.duelDebug.fps, act: w.players.map((p) => p.act?.name ?? null), o: w.players.map((p) => p.origin.map((x) => +x.toFixed(1))) }; });
  for (const pg of pages) await pg.waitForFunction(() => window.duelDebug.state?.duel?.s === 'fight', { timeout: 60000 });
  const s0 = await Promise.all(pages.map(state));
  // seat 0 is whoever reached the relay first, so either order is right as long as both agree
  check(s0[0].ch.join() === s0[1].ch.join() && [...s0[0].ch].sort().join() === 'knight,ryoku', `each sees the same two fighters in the same seats: ${s0[0].ch}, ${s0[1].ch}`);
  check(s0[0].id !== s0[1].id, 'each plays a different one');
  await pages[0].screenshot({ path: `${out}_a_fight.png` });
  await pages[1].screenshot({ path: `${out}_b_fight.png` });
  // face each other, walk in with the real key until in sword range, and swing with the real button
  await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const m = window.duelDebug.p2p, P = m.world.players, me = P.find((p) => p.id === m.myId), them = P.find((p) => p.id !== m.myId);
    setInterval(() => { window.duelDebug.forceYaw = Math.atan2(them.origin[1] - me.origin[1], them.origin[0] - me.origin[0]) * 180 / Math.PI; window.duelDebug.gap = Math.hypot(them.origin[0] - me.origin[0], them.origin[1] - me.origin[1]); }, 16);
  })));
  await Promise.all(pages.map(async (pg) => { await pg.mouse.move(480, 270); await pg.keyboard.down('KeyW'); }));
  await pages[0].waitForFunction(() => window.duelDebug.gap < 70, { timeout: 15000 });
  await Promise.all(pages.map((pg) => pg.keyboard.up('KeyW')));
  const swings = async (pg, n) => { for (let i = 0; i < n; i++) { await pg.mouse.down(); await pg.waitForTimeout(90); await pg.mouse.up(); await pg.waitForTimeout(450); } };
  await Promise.all(pages.map((pg, i) => swings(pg, i ? 12 : 16)));
  await pages[0].screenshot({ path: `${out}_a_swing.png` });
  await pages[1].screenshot({ path: `${out}_b_swing.png` });
  await pages[0].waitForTimeout(3000);
  const s1 = await Promise.all(pages.map(state));
  for (const [i, s] of s1.entries()) console.log(`peer ${i}: frame ${s.frame}, ${s.fps} fps, hp ${s.hp}, ${s.duel} round ${s.round}, rollbacks ${s.stats.rollbacks}, deepest ${s.stats.deepest}, stalled ${s.stats.stalls}`);
  const other = new Map(s1[1].hashes);
  let compared = 0, differ = 0;
  for (const [f, h] of s1[0].hashes) if (other.has(f)) { compared++; if (other.get(f) !== h) differ++; }
  check(compared > 8 && differ === 0, `${compared} state hashes compared, ${differ} differ`);
  check(s1[0].desynced === null && s1[1].desynced === null, 'neither saw a desync');
  check(s1[0].hp.some((h) => h < 100) || s1[0].round > 1, `the swings connected: hp ${s1[0].hp}, round ${s1[0].round}`);
  check(s1[0].frame > 64 * 3, 'the game kept moving');
  check(errs.every((e) => !e.length), `no page errors${errs.flat().length ? ': ' + errs.flat().slice(0, 4).join(' | ') : ''}`);
} catch (e) { check(false, e.message.slice(0, 400)); for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${out}_fail${i}.png` }).catch(() => {}); console.log('errors', JSON.stringify(errs).slice(0, 600)); }
await close();
console.log(fails ? `${fails} FAILED` : 'two real clients played each other, peer to peer');
process.exit(fails ? 1 : 0);
