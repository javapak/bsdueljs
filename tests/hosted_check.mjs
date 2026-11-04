// What --hosted lets through: nothing without the token, only the folders the client reads with it, and no way around that.
// Usage: node tests/hosted_check.mjs "<install>"
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const install = process.argv[2], PORT = 27097, TOKEN = 'hosted-check-token';
const repo = fileURLToPath(new URL('..', import.meta.url));
const srv = spawn('node', ['server/main.mjs', '--hosted', '--token', TOKEN, '--map', 'duel_practice_box', '--port', String(PORT), '--host', '127.0.0.1', '--game', install], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
let banner = '';
await new Promise((ok) => { srv.stdout.on('data', (d) => { banner += d; if (banner.includes('share this')) ok(); }); });
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
// Raw requests, since fetch tidies up the very paths this is meant to try
const get = (path, cookie) => new Promise((ok, no) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: cookie ? { cookie } : {} }, (res) => { res.resume(); res.on('end', () => ok({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] ?? null, cache: res.headers['cache-control'] })); });
  req.on('error', no);
  req.end();
});
const C = `bsduel=${TOKEN}`;
try {
  check(banner.includes(`token=${TOKEN}`), 'it prints the link to share');
  for (const p of ['/', '/index.html', '/main.js', '/shared/sim.js', '/api/info', '/game/scripts/items.json', '/game/maps/duel_temple.bsp']) check((await get(p)).status === 401, `no token, no ${p}`);
  check((await get('/?token=wrong')).status === 401, 'a wrong token gets nothing');
  check((await get('/', 'bsduel=wrong')).status === 401, 'nor does a wrong cookie');
  const first = await get(`/?token=${TOKEN}`);
  check(first.status === 200 && /HttpOnly/.test(first.cookie ?? '') && first.cookie.includes(TOKEN), 'the link opens the page and leaves a cookie');
  for (const p of ['/', '/main.js', '/shared/sim.js', '/api/info', '/game/scripts/items.json', '/game/maps/duel_temple.bsp', '/game/cfg/config_default.cfg']) check((await get(p, C)).status === 200, `with it, ${p}`);
  check((await get('/game/scripts/items.json', C)).cache?.startsWith('private'), 'game files are only cached privately');
  for (const p of ['/game/gameinfo.txt', '/game/cfg/config.cfg', '/game/bin/server.dll', '/game/addons/x', '/game/../bin/win64/server.dll', '/game/maps/../../bin/win64/server.dll', '/game/maps/..%2f..%2fgameinfo.txt', '/game/maps/%2e%2e/gameinfo.txt', '/game/maps/..%2fgameinfo.txt', '/game/maps/..%5cgameinfo.txt', '/game/maps\\..\\gameinfo.txt', '/../server/main.mjs', '/%2e%2e/server/main.mjs', '/shared/../server/main.mjs']) {
    const r = await get(p, C);
    check(r.status !== 200, `refused: ${p} (${r.status})`);
  }
  const socket = (path, cookie) => new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...(cookie ? { cookie } : {}) } });
    req.on('upgrade', (_, s) => { s.destroy(); ok(true); });
    req.on('error', () => ok(false));
    req.on('response', () => ok(false));
    req.end();
  });
  check(await socket('/relay', C), 'the relay opens with the cookie');
  check(!(await socket('/relay')), 'and not without it');
  check(!(await socket('/ws', C)), 'there are no server fights to join');
} catch (e) { check(false, e.message); }
srv.kill();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
