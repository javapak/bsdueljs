// Replays the same seeded fights in Node, Chrome and Firefox, and compares the whole game state, bit for bit, as often as every eighth tick.
// Rollback depends on this: two peers only ever send inputs, so their sims must agree exactly.
// Usage: node tests/determinism_check.mjs "<install>"
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, MATCHUPS } from './determinism_scenario.js';

const G = join(process.argv[2], 'berimbau') + sep;
const repo = fileURLToPath(new URL('..', import.meta.url));
const cvarTable = JSON.parse(readFileSync(join(repo, 'shared/cvars_all.json')));
const BROWSERS = [
  ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', (dir, url) => ['--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${dir}`, url]],
  ['Firefox', 'C:/Program Files/Mozilla Firefox/firefox.exe', (dir, url) => ['--headless', '--no-remote', '--profile', dir, url]],
];
const inside = (root, rel) => { const p = join(root, normalize(rel)); return p.startsWith(root) && existsSync(p) && statSync(p).isFile() ? p : null; };
const PAGE = `<!doctype html><script type="module">
import { runScenario } from '/tests/determinism_scenario.js';
const bytes = async (p) => { const r = await fetch('/game/' + p); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; };
const text = async (p) => { const b = await bytes(p); if (!b) throw new Error('missing ' + p); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
const send = (o) => fetch('/result', { method: 'POST', body: JSON.stringify(o) });
try { const cvarTable = await (await fetch('/shared/cvars_all.json')).json(); const t0 = performance.now(); const dumpTick = +(new URLSearchParams(location.search).get('dump') ?? -1); const o = await runScenario({ text, bytes, cvarTable, dumpTick }); send({ ...o, ms: performance.now() - t0, ua: navigator.userAgent }); }
catch (e) { send({ error: String(e.stack || e) }); }
</script>`;
const TYPES = { '.js': 'text/javascript', '.json': 'application/json' };

function serve(onResult) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { res.end('ok'); onResult(JSON.parse(b)); }); return; }
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
    const file = path.startsWith('/game/') ? inside(G, path.slice(6)) : /^\/(shared|tests)\//.test(path) ? inside(repo, path.slice(1)) : null;
    if (!file) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function inBrowser([name, exe, args], dump = -1) {
  if (!existsSync(exe)) return { name, skipped: true };
  const dir = mkdtempSync(join(tmpdir(), 'bsdet-'));
  let done, proc;
  const got = new Promise((ok) => { done = ok; });
  const server = await serve((r) => done(r));
  const timer = setTimeout(() => done({ error: 'timed out' }), 280000);
  proc = spawn(exe, args(dir, `http://127.0.0.1:${server.address().port}/?dump=${dump}`), { stdio: 'ignore' });
  const r = await got;
  clearTimeout(timer);
  proc.kill();
  server.close(); server.closeAllConnections?.();
  await new Promise((ok) => setTimeout(ok, 1500));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the browser may hold it a moment; it's the temp folder */ }
  return { name, ...r };
}

const readText = async (p) => readFileSync(G + p, 'latin1');
const readBytes = async (p) => { const f = inside(G, p); return f ? new Uint8Array(readFileSync(f)) : null; };
const t0 = performance.now();
const node = await runScenario({ text: readText, bytes: readBytes, cvarTable });
console.log(`Node: ${((performance.now() - t0) / 1000).toFixed(1)}s, Math.random calls during play: ${node.randomCalls}`);
for (const r of node.results) console.log(`  ${r.match}: ${r.hashes.length} checkpoints; ${Object.entries(r.happened).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`);

let fails = 0;
// A replay that did nothing would agree trivially
for (const r of node.results) {
  const h = r.happened, enough = (h.hit ?? 0) > 5 && (h.swing ?? 0) > 20 && (h.action ?? 0) > 20;
  if (!enough) { fails++; console.log(`FAIL ${r.match}: too little happened to prove anything`); }
}
// In the same engine first: a difference here isn't the math
const again = await runScenario({ text: readText, bytes: readBytes, cvarTable });
const firstDiff = (x, y, path = '') => {
  if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) return x === y ? null : `${path}: ${x} vs ${y}`;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDiff(x[k], y[k], `${path}.${k}`); if (d) return d; }
  return null;
};
// On a difference, runs both again and names the first field that differs at the first checkpoint it shows
async function explain(b, m, tick) {
  const local = await runScenario({ text: readText, bytes: readBytes, cvarTable, dumpTick: tick });
  const other = await inBrowser(b, tick);
  if (other.error) console.log(`     couldn't explain: ${other.error}`);
  else console.log(`     tick ${tick}, ${firstDiff(local.results[m].dump, other.results[m].dump) ?? 'no field differs: the hash covers something the dump does not'}`);
}
const compare = (name, other) => {
  let first = null;
  MATCHUPS.forEach((_, m) => {
    const A = node.results[m], B = other.results[m], at = A.hashes.findIndex((h, i) => h !== B.hashes[i]);
    if (at < 0 && A.hashes.length === B.hashes.length) console.log(`ok   ${name} ${A.match}: identical across ${A.hashes.length} checkpoints`);
    else { fails++; first ??= [m, at * 8]; console.log(`FAIL ${name} ${A.match}: differs from ${(at * 8 / 64).toFixed(2)}s on, tick ${at * 8}`); }
  });
  return first;
};
compare('Node again', again);
for (const b of BROWSERS) {
  const r = await inBrowser(b);
  if (r.skipped) { console.log(`skip ${r.name}: not installed`); continue; }
  if (r.error) { fails++; console.log(`FAIL ${r.name}: ${r.error}`); continue; }
  console.log(`${r.name}: ${(r.ms / 1000).toFixed(1)}s, ${r.ua}`);
  const first = compare(r.name, r);
  if (first) await explain(b, first[0], first[1]);
}
console.log(fails ? `${fails} FAILED` : 'all engines agree');
process.exit(fails ? 1 : 0);
