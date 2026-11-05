// The handshake when the network isn't kind, in real browsers through the real relay: connectPeer always has to finish, by connecting or by
// saying why not. Loopback connects too cleanly to show any of this, so each case bends one peer's WebRTC the way a real network would.
// Needs Playwright: PWDIR=<dir with playwright installed> node tests/peer_check.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createRelay } from '../p2p/relay.mjs';
const require = createRequire(process.env.PWDIR + '/');
const { chromium } = require('playwright');

const server = http.createServer((req, res) => {
  if (req.url === '/peer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(new URL('../client/peer.js', import.meta.url))); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>');
});
server.on('upgrade', createRelay());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });

// Ways to bend a page's WebRTC, run before the page's own code
const BENDS = {
  // its channel opens late, as when the relay's path between the peers is quicker than the direct one
  lateOpen: () => {
    Object.defineProperty(RTCDataChannel.prototype, 'onopen', { set(fn) { this.addEventListener('open', () => setTimeout(fn, 500)); } });
  },
  // addresses nobody answers on: a peer behind NAT with no STUN server
  noAnswer: () => {
    const add = RTCPeerConnection.prototype.addIceCandidate;
    RTCPeerConnection.prototype.addIceCandidate = function (c) { const p = c.candidate.split(' '); p[4] = '10.254.254.9'; return add.call(this, { ...c, candidate: p.join(' ') }); };
  },
  // Chrome's hidden local addresses, which only resolve on the same network: there's nothing to try, so ICE never even fails
  hiddenAddress: () => {
    const add = RTCPeerConnection.prototype.addIceCandidate;
    RTCPeerConnection.prototype.addIceCandidate = function (c) { const p = c.candidate.split(' '); p[4] = '0f3a1c5e-7b2d-4e9a-8c6f-d1e2f3a4b5c6.local'; return add.call(this, { ...c, candidate: p.join(' ') }); };
  },
  // the setup messages never arrive, as when something between here and the relay drops them
  noSignal: () => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (s) { if (!s.includes('"signal"')) send.call(this, s); };
  },
};
/**
 * Two peers join a room, each with its own bends.
 * @param {string} room The room.
 * @param {string[]} [a] Bends for the first.
 * @param {string[]} [b] Bends for the second.
 * @returns {Promise<object[]>} The two pages.
 */
async function pair(room, a = [], b = []) {
  const pages = [];
  for (const bends of [a, b]) {
    const pg = await browser.newPage();
    for (const k of bends) await pg.addInitScript(BENDS[k]);
    await pg.goto(`http://127.0.0.1:${port}/`);
    await pg.evaluate(async ([p, r]) => {
      const { connectPeer } = await import('/peer.js');
      window.t0 = performance.now();
      window.end = null;
      connectPeer({ relay: `ws://127.0.0.1:${p}/`, room: r, build: 'same', hello: {} }).then(
        (peer) => { window.peer = peer; window.closed = false; peer.onClose = () => { window.closed = true; }; window.end = { ok: true, s: (performance.now() - window.t0) / 1000 }; },
        (e) => { window.end = { ok: false, s: (performance.now() - window.t0) / 1000, why: e.message }; },
      );
    }, [port, room]);
    pages.push(pg);
  }
  return pages;
}
const ended = (pg, ms) => pg.waitForFunction(() => window.end, null, { timeout: ms }).then(() => pg.evaluate(() => window.end)).catch(() => null);
const done = async (pages) => { for (const pg of pages) await pg.close(); };
// Past the longest the client gives a handshake, so that a pass means it finished and not that this gave up
const PATIENCE = 45000;

{
  const pages = await pair('clean');
  const [x, y] = await Promise.all(pages.map((pg) => ended(pg, 10000)));
  check(x?.ok && y?.ok, `a clean network connects: ${JSON.stringify([x, y])}`);
  await pages[0].evaluate(() => window.peer.send(new Uint8Array([7]).buffer));
  await pages[1].evaluate(() => { window.got = 0; window.peer.onPacket = () => { window.got++; }; });
  await pages[0].waitForTimeout(100);
  await pages[0].evaluate(() => window.peer.send(new Uint8Array([7]).buffer));
  await pages[1].waitForFunction(() => window.got > 0, null, { timeout: 3000 }).then(() => check(true, 'and a packet crosses it')).catch(() => check(false, 'and a packet crosses it'));
  await done(pages);
}
{
  // Whoever connects first leaves the relay, and that mustn't read as leaving the fight to the one still a moment away from connecting
  const pages = await pair('late', [], ['lateOpen']);
  const [x, y] = await Promise.all(pages.map((pg) => ended(pg, 10000)));
  await pages[0].waitForTimeout(1000);
  const closed = await pages[0].evaluate(() => window.closed);
  check(x?.ok && y?.ok && !closed, `one peer connecting a moment after the other: ${JSON.stringify([x, y])}, first peer lost it: ${closed}`);
  await done(pages);
}
for (const [name, bends] of [['addresses nobody answers on', ['noAnswer']], ['hidden addresses that never resolve', ['hiddenAddress']], ['setup messages that never arrive', ['noSignal']]]) {
  const pages = await pair(name.slice(0, 20), bends, bends);
  const [x, y] = await Promise.all(pages.map((pg) => ended(pg, PATIENCE)));
  check(x && !x.ok && y && !y.ok, `${name}: ${x ? `${x.s.toFixed(1)}s "${x.why}"` : 'STILL CONNECTING'}; ${y ? `${y.s.toFixed(1)}s "${y.why}"` : 'STILL CONNECTING'}`);
  await done(pages);
}
{
  // Someone really leaving partway through still says so, straight away
  const pages = await pair('leaves', ['noAnswer'], ['noAnswer']);
  await pages[0].waitForTimeout(500);
  await pages[0].close();
  const y = await ended(pages[1], 5000);
  check(y && !y.ok && /left/.test(y.why), `the other player leaving before connecting: ${JSON.stringify(y)}`);
  await pages[1].close();
}
await browser.close();
server.close();
console.log(fails ? `${fails} FAILED` : 'every handshake finished, one way or the other');
process.exit(fails ? 1 : 0);
