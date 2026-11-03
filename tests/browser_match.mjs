// Plays a full match in a real browser using only keyboard and mouse events against the server bot.
// Needs Playwright: PWDIR=<dir with playwright installed> node tests/browser_match.mjs <url> <screenshot prefix>
import { createRequire } from 'node:module';
const require = createRequire(process.env.PWDIR + '/');
const { chromium } = require('playwright');
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto(url);
await pg.waitForFunction(() => document.getElementById('status')?.textContent === 'Ready.', { timeout: 120000 });
await pg.fill('#name', 'Tester');
await pg.click('#go');
await pg.waitForFunction(() => window.duelDebug?.state?.chars >= 2, { timeout: 30000 });
const st = () => pg.evaluate(() => { const s = window.duelDebug.state; return { d: s.duel, me: s.me, ev: window.duelDebug.lastEvents, fps: window.duelDebug.fps, gpu: window.duelDebug.errors }; });
await pg.mouse.move(640, 360);
await pg.mouse.click(640, 360);
console.log('pointer locked:', await pg.evaluate(() => document.pointerLockElement?.id ?? null));
// wait out the warmup, then check each control
await pg.waitForFunction(() => window.duelDebug.state.duel?.s === 'fight', { timeout: 30000 });
const a = (await st()).me.o;
await pg.keyboard.down('KeyW'); await pg.waitForTimeout(800); await pg.keyboard.up('KeyW');
const c = (await st()).me.o;
console.log('W moved', Math.hypot(c[0] - a[0], c[1] - a[1]).toFixed(0), 'units');
const seen = {};
const t0 = Date.now(); let shots = 0, last = '';
for (;;) {
  const s = await st();
  (s.ev || []).forEach((e) => { seen[e] = 1; });
  if (s.d?.s !== last) { last = s.d?.s; console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', last, 'round', s.d?.r, JSON.stringify(s.d?.w), 'fps', s.fps); }
  if (s.d?.s === 'cooldown') { await pg.screenshot({ path: `${out}_end.png` }); console.log('winner id', s.d.win, 'me', await pg.evaluate(() => window.duelDebug.state.myId)); break; }
  if (Date.now() - t0 > 280000) { console.log('TIMEOUT'); break; }
  if (s.d?.s === 'fight') {
    await pg.keyboard.down('KeyW'); await pg.mouse.down(); await pg.waitForTimeout(90); await pg.mouse.up(); await pg.waitForTimeout(250); await pg.keyboard.up('KeyW');
    if (Math.random() < 0.12) { await pg.mouse.down({ button: 'right' }); await pg.waitForTimeout(300); await pg.mouse.up({ button: 'right' }); }
    if (Math.random() < 0.08) { await pg.keyboard.press('Digit' + (1 + Math.floor(Math.random() * 3))); }
    if (Math.random() < 0.06) { await pg.keyboard.press('ControlLeft'); }
    if (Math.random() < 0.06) { await pg.keyboard.press('Space'); }
    if (shots < 3 && Math.random() < 0.08) { await pg.screenshot({ path: `${out}_fight${shots++}.png` }); }
  } else await pg.waitForTimeout(150);
}
const fin = await st();
console.log('events seen', Object.keys(seen).join(','));
console.log('gpu errors', fin.gpu.length, 'page errors', errs.length, errs.slice(0, 3));
await b.close();
