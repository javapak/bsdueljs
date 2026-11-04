// shared/detmath.js stays close to the engine's own functions, and uses only what IEEE 754 pins down.
// Usage: node tests/detmath_check.mjs
import { readFileSync } from 'node:fs';
import * as D from '../shared/detmath.js';

let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
const a = new Float64Array(2), big = new BigInt64Array(a.buffer);
// Doubles apart, counting along the number line
const ordered = (b) => (b < 0n ? -(b & 0x7fffffffffffffffn) : b);
function ulps(x, y) {
  if (x === y) return 0;
  if (x !== x && y !== y) return 0;
  if (x !== x || y !== y) return Infinity;
  a[0] = x; a[1] = y;
  const d = ordered(big[0]) - ordered(big[1]);
  return Number(d < 0n ? -d : d);
}
let s = 7;
const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const between = (lo, hi) => lo + (hi - lo) * (r() + r() / 2 ** 32);
const N = 400000;
function compare(name, ours, theirs, draw, allowed) {
  let worst = 0, at = null, off = 0;
  for (let i = 0; i < N; i++) {
    const args = draw(), u = ulps(ours(...args), theirs(...args));
    if (u) off++;
    if (u > worst) { worst = u; at = args; }
  }
  check(worst <= allowed, `${name}: worst ${worst} ulp${at ? ` at ${at.join(', ')}` : ''}, ${(off / N * 100).toFixed(2)}% not identical`);
}
const angle = () => [between(-360, 360) * Math.PI / 180];
const wide = () => [between(-1e5, 1e5)];
compare('sin', D.sin, Math.sin, angle, 2);
compare('cos', D.cos, Math.cos, angle, 2);
compare('tan', D.tan, Math.tan, angle, 3);
compare('sin, wide', D.sin, Math.sin, wide, 2);
compare('cos, wide', D.cos, Math.cos, wide, 2);
compare('atan', D.atan, Math.atan, () => [between(-20, 20)], 2);
compare('atan2', D.atan2, Math.atan2, () => [between(-1000, 1000), between(-1000, 1000)], 3);
compare('asin', D.asin, Math.asin, () => [between(-1, 1)], 2);
compare('acos', D.acos, Math.acos, () => [between(-1, 1)], 2);
compare('exp', D.exp, Math.exp, () => [between(-50, 50)], 2);
compare('log', D.log, Math.log, () => [between(1e-6, 1000)], 2);
compare('pow', D.pow, Math.pow, () => [between(1e-3, 50), between(-8, 8)], 3);
compare('pow, game-sized', D.pow, Math.pow, () => [between(0, 1), between(0, 4)], 3);
compare('hypot', D.hypot, Math.hypot, () => [between(-5000, 5000), between(-5000, 5000), between(-5000, 5000)], 2);

// the corners, against what the spec says
const corners = [0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 1e-300, -1e-300, 1e300, -1e300, Infinity, -Infinity, NaN];
for (const [name, f, g] of [['sin', D.sin, Math.sin], ['cos', D.cos, Math.cos], ['atan', D.atan, Math.atan], ['exp', D.exp, Math.exp], ['log', D.log, Math.log], ['asin', D.asin, Math.asin], ['acos', D.acos, Math.acos]]) {
  const bad = corners.filter((x) => ulps(f(x), g(x)) > 2 && !(Math.abs(x) >= 1e300 && (name === 'sin' || name === 'cos')));
  check(!bad.length, `${name} special values${bad.length ? `: wrong at ${bad.join(', ')}` : ''}`);
}
const bad2 = (f, g) => { const out = []; for (const x of corners) for (const y of corners) if (ulps(f(x, y), g(x, y)) > 3) out.push(`${x},${y}: ${f(x, y)} vs ${g(x, y)}`); return out; };
for (const [name, f, g] of [['pow', D.pow, Math.pow], ['atan2', D.atan2, Math.atan2]]) {
  const bad = bad2(f, g);
  check(!bad.length, `${name} special values${bad.length ? `: ${bad.slice(0, 6).join(' | ')}` : ''}`);
}

// nothing but arithmetic and sqrt inside
const src = readFileSync(new URL('../shared/detmath.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
const used = new Set([...src.matchAll(/Math\.([a-zA-Z0-9]+)/g)].map((m) => m[1]));
const exact = new Set(['sqrt', 'abs', 'trunc']);
check([...used].every((u) => exact.has(u)), `only exact Math functions inside: ${[...used].join(', ')}`);

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
