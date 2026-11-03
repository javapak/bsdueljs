// Differential test: JS port of the combat rules vs the native C++ build, bit for bit.
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as C from '../shared/combat.js';
const here = dirname(fileURLToPath(import.meta.url));
const N = +(process.argv[2] || 20000);
const bin = join(mkdtempSync(join(tmpdir(), 'rules')), 'rules_driver');
execFileSync('clang++', ['-std=c++17', '-O1', '-ffp-contract=off', join(here, 'rules_driver.cpp'), join(here, '../../rewrite/combat/combat_rules.cpp'), '-o', bin]);
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[ri(0, a.length - 1)];
const fr = Math.fround;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const hex = (f) => { f32[0] = f; return u32[0].toString(16).padStart(8, '0'); };
const spec = [0, -0, 1, -1, 0.5, 0.49, 2, 100, -100, 1e-30, 1e30, NaN, Infinity];
const fl = () => (rnd() < 0.2 ? fr(pick(spec)) : fr((rnd() - 0.5) * pick([1, 10, 500, 5000])));
const pos = () => (rnd() < 0.1 ? fr(pick(spec)) : fr(rnd() * pick([1, 3, 60])));
const vec = () => (rnd() < 0.1 ? [0, 0, 0] : [fl(), fl(), fl()]);
const b = () => (rnd() < 0.5 ? 1 : 0);
class W { constructor() { this.t = []; } F(x) { this.t.push(hex(x)); return x; } I(x) { this.t.push(String(x)); return x; } V(v) { v.forEach((x) => this.F(x)); return v; }
  SV() { const p = b(), v = pos(); this.I(p); this.F(v); return p ? v : null; } SVi() { const p = b(), v = ri(-3, 40); this.I(p); this.I(v); return p ? v : null; } }
const out = (t) => t.join(' ');
const PV = (v) => v.map(hex);
function block(w) {
  const i = { defenderOrigin: w.V(vec()), attackerOrigin: w.V(vec()), defenderForward: w.V(vec()), attackerInAttackAction: !!w.I(b()), attackerTier: w.I(ri(0, 3)), swordBreaksBlockAtTier3: !!w.I(b()) };
  const t = { blockDotProduct: w.F(pick([fr(0.49), 0, fl()])), blockChipDamage: w.F(fl()), knockbackBlock: w.F(fl()) };
  const d = { force: w.V(vec()), damage: w.F(fl()) };
  const r = C.resolveBlock(i, t, d);
  return [r.outcome, hex(r.facingDot), ...PV(d.force), hex(d.damage)];
}
function parry(w) {
  const i = { defenderOrigin: w.V(vec()), attackerOrigin: w.V(vec()), defenderForward: w.V(vec()), attackerHasAction: !!w.I(b()), attackerTier: w.I(ri(0, 3)), attackerActionId: w.I(pick([0x21, 0x20, 39, 16])), attackerStanceType: w.I(ri(0, 4)), swordBreaksParryAtTier3: !!w.I(b()), inParryWindow: !!w.I(b()), attackerAbsVelocity: w.V(vec()) };
  const t = { knockbackIntercept: w.F(fl()), interceptMomentumScale: w.F(fl()), interceptTime: w.F(fl()) };
  const d = { force: w.V(vec()), damage: w.F(fl()) };
  const r = C.resolveParry(i, t, d);
  return [r.outcome, ...PV(r.recoil), r.stunAttacker ? 1 : 0, ...PV(r.attackerVelocity), hex(r.defenderLockTimer), ...PV(d.force), hex(d.damage)];
}
const fighter = (w) => ({ origin: w.V(vec()), stanceType: w.I(ri(0, 4)), sheathedAttack: !!w.I(b() && b()), attackLanded: !!w.I(b()), actionId: w.I(pick([0x21, 40, 41, 50])), tier: w.I(ri(0, 2)), direction: w.I(ri(0, 3)), characterIndex: w.I(ri(0, 5)), lockTimer: w.F(pos()), absVelocity: w.V(vec()), turnSelfX: w.SV(), turnOpponentX: w.SV(), recoveryX: w.SV(), forwardRecoveryX: w.SV(), sideRecoveryX: w.SV() });
const PS = (s) => [hex(s.hitstop), s.turnToward, hex(s.turnAmount), s.staggered ? 1 : 0, s.setLockTimer ? 1 : 0, hex(s.setLockTimer ? s.lockTimer : 0), ...PV(s.knockback)];
function clash(w) {
  const a = fighter(w), bb = fighter(w);
  const t = { recoveryNormal: w.F(pos()), recoveryBetter: w.F(pos()), recoveryWorse: w.F(pos()), turnParryAngle: w.F(pos()), kbParry: w.F(pos()), kbAirParry: w.F(pos()), kbAirParryUp: w.F(pos()), kbKeepMomentum: !!w.I(b()) };
  const r = C.resolveClash(a, bb, t);
  return [r.delta, r.swapped ? 1 : 0, ...PS(r.high), ...PS(r.low), ...PV(r.effectOrigin), r.effectKind];
}
function combo(w) {
  const c = { hitsThisSwing: w.I(ri(0, 3)), comboCount: w.I(ri(0, 16)), comboResetTime: w.F(pos()) };
  const cur = w.F(pos()), ao = w.V(vec()), vo = w.V(vec());
  const t = { scalingTime: w.F(pos()), scalingAttacks: w.I(ri(0, 4)), scalingKnockback: w.F(pos()), scalingDamage: w.F(pos()), damageMinimum: w.F(pos()), attackerPush: w.F(pos()), attackerPushMax: w.F(pos()) };
  const d = { force: w.V(vec()), damage: w.F(fl()) };
  const r = C.applyComboScaling(c, cur, ao, vo, t, d);
  return [r.scaled ? 1 : 0, ...PV(r.attackerPush), c.comboCount, hex(c.comboResetTime), ...PV(d.force), hex(d.damage)];
}
function damage(w) {
  const i = { attackerInAttackAction: !!w.I(b() || b()), tierDamage: w.I(ri(0, 80)), stanceType: w.I(ri(-1, 4)), direction: w.I(ri(0, 3)), tier: w.I(ri(0, 2)), actionId: w.I(pick([0x21, 40])), hitsThisSwing: w.I(ri(0, 4)), victimStunType: w.I(ri(0, 4)), swingProgress: w.F(fl()) };
  const present = b() || b(); w.I(present);
  const s = { damageDotProductX: w.SV(), damageX: w.SV(), stanceX: [w.SV(), w.SV(), w.SV(), w.SV()], forwardX: w.SV(), sideX: w.SV(), parryX: w.SV(), multiHitScale: w.SV(), multiHitMinDamage: w.SVi(), minDamageTier: [w.SVi(), w.SVi(), w.SVi()] };
  i.sword = present ? s : null;
  const g = w.F(pos()), pv = w.F(pos());
  return [hex(C.computeAttackDamage(i, g, () => pv))];
}
function hit(w) {
  const c = { defense: w.I(ri(0, 2)), resultAfterDefense: w.I(pick([0, 1, 2, 5])), blockReturnedTrue: !!w.I(b()), attackerDirection: w.I(ri(0, 3)), attackerTier: w.I(ri(0, 2)), attackerActionId: w.I(pick([0x21, 40])), hitsThisSwing: w.I(ri(0, 3)), attackerLockTimer: w.F(pos()), attackerForce: w.V(vec()), hitImpulse: w.V(vec()), turnSelfX: w.SV(), recoveryBonusOnHit: w.SV() };
  const t = { turnAttackAngle: w.F(pos()), turnRateSpeed: w.F(pos()), turnRateDuration: w.F(pos()), hitstopTime: w.F(pos()), hitstopTimeMax: w.F(pos()), hitstopMultihitTime: w.F(pos()) };
  const o = C.resolveHitOutcome(c, t);
  return [o.hitDirection, o.landed ? 1 : 0, o.incrementMultiBlock ? 1 : 0, o.slowVictimTurnRate ? 1 : 0, o.turnVictim ? 1 : 0, hex(o.turnAmount), o.setAttackerForce ? 1 : 0, ...PV(o.attackerForce), o.setLockTimer ? 1 : 0, hex(o.lockTimer), o.hitsThisSwing, hex(o.hitstop)];
}
const rules = [block, parry, clash, combo, damage, hit], names = ['block', 'parry', 'clash', 'combo', 'damage', 'hit'];
const lines = [], exp = [], which = [];
for (let n = 0; n < N * 6; n++) {
  const r = n % 6;
  const w = new W(); w.I(r);
  exp.push(rules[r](w).join(' ')); lines.push(w.t.join(' ')); which.push(r);
}
const res = spawnSync(bin, { input: lines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
if (res.status !== 0) { console.error('driver failed', res.status, res.stderr); process.exit(1); }
const got = res.stdout.trim().split('\n').map((s) => s.trim());
const fails = [0, 0, 0, 0, 0, 0]; let shown = 0;
exp.forEach((e, i) => {
  // NaN payloads aren't compared: JS does not preserve them across operations
  const norm = (s) => s.split(' ').map((x) => (/^[0-9a-f]{8}$/.test(x) && /^(7fc|ffc|7f[89a-f]|ff[89a-f])/.test(x) && (parseInt(x, 16) & 0x7fffffff) > 0x7f800000 ? 'nan' : x)).join(' ');
  if (norm(e) !== norm(got[i])) { fails[which[i]]++; if (shown++ < 6) console.log('MISMATCH', names[which[i]], '\n in ', lines[i], '\n js ', e, '\n c++', got[i]); }
});
names.forEach((n, i) => console.log(n.padEnd(7), `${N - fails[i]}/${N}`));
process.exit(fails.some((x) => x) ? 1 : 0);
