// JS port of rewrite/combat/combat_rules.cpp. All arithmetic is single precision (Math.fround),
// in the C++ operation order, so results match bit for bit (tests/combat_diff.mjs checks this
// against the native build, which is itself verified against server.dll).
import * as DM from './detmath.js';
const fr = Math.fround;
export const HIT_LANDED = 0, HIT_BLOCKED = 1, HIT_INTERCEPTED = 2, HIT_GUARD_BROKEN = 5;
export const TIER_1 = 0, TIER_2 = 1, TIER_3 = 2;
export const STANCE_BALANCED = 0, STANCE_FAST = 1, STANCE_HEAVY = 2, STANCE_AIR = 3;
export const ACTION_UNPARRYABLE = 0x21, REACTION_PARRIED = 0x14, COMBO_COUNT_MAX = 15;
export const BLOCK_NOTFACING = 0, BLOCK_BLOCKED = 1, BLOCK_BROKEN = 2;
export const PARRY_NOTFACING = 0, PARRY_BROKEN = 1, PARRY_MISSED = 2, PARRY_INTERCEPTED = 3;
export const DEF_NONE = 0, DEF_BLOCK = 1, DEF_PARRY = 2;
const EPS = fr(1.1920929e-07);
const minss = (a, b) => (a < b ? a : b);
const maxss = (a, b) => (a > b ? a : b);
/**
 * A sword script value as the game reads it: a key the sword doesn't set reads as -1, not 0.
 * @param {number|null|undefined} x The value.
 * @returns {number} The value, or -1 if missing.
 */
export const sv = (x) => (x === undefined || x === null ? -1 : x); // SwordValue.Get(): missing reads -1

/**
 * Normalizes a vector in place, with the small epsilon the original adds to avoid dividing by zero.
 * @param {number[]} v Vector [x, y, z], changed in place.
 * @returns {number[]} The same array.
 */
export function normalizeFast(v) {
  let l = fr(fr(v[0] * v[0]) + fr(v[1] * v[1]));
  l = fr(l + fr(v[2] * v[2]));
  const inv = fr(1 / fr(fr(Math.sqrt(l)) + EPS));
  v[0] = fr(v[0] * inv); v[1] = fr(v[1] * inv); v[2] = fr(v[2] * inv);
  return v;
}

/**
 * How directly a defender faces an attacker, on the flat plane only.
 * @param {number[]} def Defender origin.
 * @param {number[]} att Attacker origin.
 * @param {number[]} fwd Defender forward.
 * @returns {number} 1 facing dead on, 0 side on, -1 back turned.
 */
function facingDot(def, att, fwd) {
  const to = [fr(att[0] - def[0]), fr(att[1] - def[1]), 0];
  const f = [fwd[0], fwd[1], 0];
  normalizeFast(to); normalizeFast(f);
  const d = fr(fr(f[1] * to[1]) + fr(f[0] * to[0]));
  return fr(d + fr(f[2] * to[2]));
}

/**
 * Longsword and scimitar block. It has to face the attacker past `blockDotProduct`, or the block doesn't count at all.
 * A tier 3 from a sword with tier3shouldbreakblock breaks it. Anything else lands as chip damage and scaled knockback.
 * @param {object} i Hit: defenderOrigin, attackerOrigin, defenderForward, attackerInAttackAction, attackerTier, swordBreaksBlockAtTier3.
 * @param {object} t Tuning: blockDotProduct, blockChipDamage, knockbackBlock.
 * @param {{damage: number, force: number[]}} dmg Replaced with the chip damage and scaled force when blocked.
 * @returns {{outcome: number, facingDot: number}} outcome is BLOCK_NOTFACING, BLOCK_BLOCKED or BLOCK_BROKEN.
 */
export function resolveBlock(i, t, dmg) {
  const dot = facingDot(i.defenderOrigin, i.attackerOrigin, i.defenderForward);
  const r = { outcome: BLOCK_NOTFACING, facingDot: dot };
  if (!(dot > t.blockDotProduct)) return r;
  if (i.attackerInAttackAction && i.attackerTier === TIER_3 && i.swordBreaksBlockAtTier3) { r.outcome = BLOCK_BROKEN; return r; }
  r.outcome = BLOCK_BLOCKED;
  dmg.damage = t.blockChipDamage;
  dmg.force = dmg.force.map((x) => fr(x * t.knockbackBlock));
  return r;
}

/**
 * Jian intercept. The defender needs only to face the attacker's half (dot above 0). A tier 3 from a sword with
 * tier3shouldbreakparry, or an unparryable action, breaks it. Otherwise the timing decides: inside the parry window the hit
 * does no damage, and the attacker is stunned with their momentum scaled; outside it, it's a miss and the hit lands.
 * @param {object} i Hit: origins, defenderForward, attackerHasAction, attackerTier, attackerActionId, attackerStanceType, swordBreaksParryAtTier3, inParryWindow, attackerAbsVelocity.
 * @param {object} t Tuning: knockbackIntercept, interceptMomentumScale, interceptTime.
 * @param {{damage: number, force: number[]}} dmg Zeroed damage and scaled force when intercepted.
 * @returns {object} outcome (PARRY_*), recoil, stunAttacker, attackerReaction, attackerVelocity, defenderLockTimer.
 */
export function resolveParry(i, t, dmg) {
  const r = { outcome: PARRY_NOTFACING, recoil: [0, 0, 0], stunAttacker: false, attackerReaction: null, attackerVelocity: [0, 0, 0], defenderLockTimer: 0 };
  if (!(facingDot(i.defenderOrigin, i.attackerOrigin, i.defenderForward) > 0)) return r;
  const charged = i.attackerHasAction && i.swordBreaksParryAtTier3 && i.attackerTier === TIER_3;
  if (charged || i.attackerActionId === ACTION_UNPARRYABLE) { r.outcome = PARRY_BROKEN; return r; }
  if (!i.inParryWindow) { r.outcome = PARRY_MISSED; return r; }
  r.outcome = PARRY_INTERCEPTED;
  dmg.damage = -0;
  const kb = t.knockbackIntercept;
  r.recoil = dmg.force.map((x) => fr(-fr(x * kb)));
  dmg.force = dmg.force.map((x) => fr(x * kb));
  if (i.attackerHasAction) {
    r.stunAttacker = true;
    r.attackerReaction = { type: REACTION_PARRIED, stanceType: i.attackerStanceType, arg6: HIT_INTERCEPTED, arg7: 4 };
    const m = t.interceptMomentumScale;
    r.attackerVelocity = i.attackerAbsVelocity.map((x) => fr(m * x));
  }
  r.defenderLockTimer = t.interceptTime;
  return r;
}

/**
 * Who wins when two blades meet. Higher beats lower, and equal staggers both.
 * Unparryable or sheathed 6, heavy 4, balanced 3, fast 2. Air is 1, except 5 against heavy.
 * @param {object} self This fighter: stanceType, actionId, sheathedAttack.
 * @param {object} opp The other fighter: stanceType.
 * @returns {number} The priority.
 */
export function clashPriority(self, opp) {
  if (self.sheathedAttack || self.actionId === ACTION_UNPARRYABLE) return 6;
  switch (self.stanceType) {
    case STANCE_BALANCED: return 3;
    case STANCE_FAST: return 2;
    case STANCE_HEAVY: return 4;
    case STANCE_AIR: return opp.stanceType === STANCE_HEAVY ? 5 : 1;
    default: return 0;
  }
}

/**
 * One fighter's side of a clash. Hitstop grows with the higher priority present (0.1s + 0.05s per rank). Only a fighter who
 * didn't out-prioritise the other is staggered, with recovery by tier difference and sword multipliers, and knockback away from the opponent.
 * @param {object} self This fighter's state, from World.fighter.
 * @param {object} opp The other fighter's state.
 * @param {object} t Tuning: recovery*, turnParryAngle, kbParry, kbAirParry, kbAirParryUp, kbKeepMomentum.
 * @returns {object} hitstop, turnToward, turnAmount, staggered, setLockTimer, lockTimer, knockback, stanceType.
 */
function applyClash(self, opp, t) {
  const s = { hitstop: 0, turnToward: 0, turnAmount: 0, staggered: false, setLockTimer: false, lockTimer: 0, knockback: [0, 0, 0], stanceType: self.stanceType };
  const sr = clashPriority(self, opp), or = clashPriority(opp, self);
  const maxRank = sr > or ? sr : or;
  s.hitstop = fr(maxRank * 0.05 + 0.1);
  const away = [fr(self.origin[0] - opp.origin[0]), fr(self.origin[1] - opp.origin[1]), 0];
  normalizeFast(away);
  const turn = fr(t.turnParryAngle * sv(self.turnSelfX));
  s.turnToward = opp.direction;
  s.turnAmount = fr(sv(opp.turnOpponentX) * turn);
  if (sr - or > 0) return s;
  s.staggered = true;
  const td = self.tier - opp.tier;
  let rec = td > 0 ? t.recoveryBetter : td < 0 ? t.recoveryWorse : t.recoveryNormal;
  rec = fr(rec * sv(self.recoveryX));
  if ((self.direction & ~2) === 0) rec = fr(rec * sv(self.forwardRecoveryX));
  else if (((self.direction - 1) & ~2) === 0) rec = fr(rec * sv(self.sideRecoveryX));
  if (rec > 0 && self.lockTimer !== rec) { s.setLockTimer = true; s.lockTimer = rec; }
  let scale = t.kbParry;
  if (self.stanceType === STANCE_AIR && !self.attackLanded) {
    away[2] = fr(t.kbAirParryUp + away[2]);
    normalizeFast(away);
    scale = t.kbAirParry;
  }
  away[1] = fr(scale * away[1]); away[0] = fr(scale * away[0]); away[2] = fr(scale * away[2]);
  if (t.kbKeepMomentum) {
    away[0] = fr(away[0] + self.absVelocity[0]);
    away[1] = fr(self.absVelocity[1] + away[1]);
    away[2] = fr(self.absVelocity[2] + away[2]);
  }
  s.knockback = away;
  return s;
}

/**
 * Resolves two blades meeting, for both fighters.
 * @param {object} a One fighter's state.
 * @param {object} b The other's.
 * @param {object} t Tuning, as for applyClash.
 * @returns {object} delta (a's priority minus b's), swapped (b outranked a), low and high (each side's result), effectOrigin, effectKind.
 */
export function resolveClash(a, b, t) {
  const delta = clashPriority(a, b) - clashPriority(b, a);
  const swapped = delta < 0;
  const high = swapped ? b : a, low = swapped ? a : b;
  const r = { delta, swapped, low: applyClash(low, high, t), high: applyClash(high, low, t), effectOrigin: [0, 0, 0], effectKind: 0 };
  if (r.low.staggered || r.high.staggered) {
    r.effectOrigin = [0, 1, 2].map((k) => fr(fr(fr(low.origin[k] - high.origin[k]) * 0.5) + high.origin[k]));
    r.effectKind = delta !== 0 ? 4 : 3;
  }
  return r;
}

/**
 * Damage falloff over a run of landed swings. Each new swing inside `scalingTime` of the last adds to the count, up to 15.
 * Past `scalingAttacks`, each extra swing takes off damage down to `damageMinimum` of full (never under 1), adds knockback
 * up to 3x, and pushes the attacker back away from the victim.
 * @param {object} att Attacker's counters, changed in place: hitsThisSwing, comboCount, comboResetTime.
 * @param {number} curtime Current time in seconds.
 * @param {number[]} attOrigin Attacker origin.
 * @param {number[]} vicOrigin Victim origin.
 * @param {object} t Tuning: scalingTime, scalingAttacks, scalingKnockback, scalingDamage, damageMinimum, attackerPush, attackerPushMax.
 * @param {{damage: number, force: number[]}} dmg Scaled in place.
 * @returns {{scaled: boolean, attackerPush: number[]}} Whether scaling applied, and the attacker's push.
 */
export function applyComboScaling(att, curtime, attOrigin, vicOrigin, t, dmg) {
  const r = { scaled: false, attackerPush: [0, 0, 0] };
  if (att.hitsThisSwing === 0) {
    if (!(att.comboResetTime >= curtime)) att.comboCount = 0;
    att.comboCount += 1;
    att.comboResetTime = fr(t.scalingTime + curtime);
    if (att.comboCount > COMBO_COUNT_MAX) att.comboCount = COMBO_COUNT_MAX;
  }
  if (!(att.comboCount > t.scalingAttacks)) return r;
  r.scaled = true;
  const extra = fr(att.comboCount - t.scalingAttacks);
  const kbBonus = minss(fr(extra * t.scalingKnockback), 2);
  const red = minss(fr(1 - t.damageMinimum), fr(extra * t.scalingDamage));
  const sd = fr(fr(1 - red) * dmg.damage);
  dmg.damage = sd >= 1 ? sd : 1;
  const ks = fr(kbBonus + 1);
  dmg.force = dmg.force.map((x) => fr(ks * x));
  const away = [fr(attOrigin[0] - vicOrigin[0]), fr(attOrigin[1] - vicOrigin[1]), 0];
  normalizeFast(away);
  const push = minss(fr(extra * t.attackerPush), t.attackerPushMax);
  r.attackerPush = [fr(away[0] * push), fr(away[1] * push), fr(push * away[2])];
  return r;
}

/**
 * Floors the way the original's float-to-int conversion does, including its handling of values out of int range.
 * @param {number} x The value.
 * @returns {number} The floored value.
 */
function floorLikeOriginal(x) {
  if (!(x >= -2147483648 && x < 2147483648)) return x;
  const i = Math.trunc(x);
  if (i === -2147483648 || fr(i) === x) return x;
  return fr(i - (x < 0 || Object.is(x, -0) ? 1 : 0));
}

/**
 * A sword hit's damage before block, parry and combo scaling. In order: tier damage, times the swing-progress bonus,
 * sword damageX, stance multiplier, forward or side multiplier, the parry multiplier on a victim stunned that way, and
 * multiHitScale for each earlier hit in the swing. The result is floored and can't go under the sword's minimum for that tier.
 * @param {object} i Hit: attackerInAttackAction, sword, tierDamage, swingProgress, stanceType, direction, victimStunType, hitsThisSwing, actionId, tier.
 * @param {number} globalScale bb_global_damagescale.
 * @param {function(number, number): number} [pow] Single precision power function.
 * @returns {number} The damage, 0 if not attacking.
 */
export function computeAttackDamage(i, globalScale, pow = (b, e) => fr(DM.pow(b, e))) {
  if (!i.attackerInAttackAction) return 0;
  const sw = i.sword;
  const tierDamage = fr(i.tierDamage);
  let scale = 1, damageX = -1;
  if (sw) {
    if (sw.damageDotProductX !== undefined && sw.damageDotProductX !== null) {
      const dotX = sw.damageDotProductX;
      if (dotX > 0) {
        let bonus = fr(i.swingProgress * dotX);
        if (!(bonus > 0)) bonus = 0;
        scale = fr(bonus + 1);
      }
    }
    damageX = sv(sw.damageX);
  }
  scale = fr(scale * damageX);
  if (i.stanceType >= STANCE_BALANCED && i.stanceType <= STANCE_AIR) scale = fr(scale * (sw ? sv(sw.stanceX[i.stanceType]) : -1));
  const forward = (i.direction & ~2) === 0;
  scale = fr(scale * (sw ? sv(forward ? sw.forwardX : sw.sideX) : -1));
  if (i.victimStunType === 3) scale = fr(scale * (sw ? sv(sw.parryX) : -1));
  const hits = fr(i.hitsThisSwing);
  let minDamage = -1;
  if (sw) {
    scale = fr(scale * pow(sv(sw.multiHitScale), hits));
    minDamage = sv(sw.multiHitMinDamage);
    const t1 = sv(sw.minDamageTier[0]), t2 = sv(sw.minDamageTier[1]), t3 = sv(sw.minDamageTier[2]);
    if (t1 > 0 || t2 > 0 || t3 > 0) {
      if (i.actionId === ACTION_UNPARRYABLE) minDamage = t3;
      else if (i.tier === TIER_1) minDamage = t1;
      else if (i.tier === TIER_2) minDamage = t2;
      else if (i.tier === TIER_3) minDamage = t3;
    }
  } else scale = fr(pow(-1, hits) * scale);
  let damage = fr(scale * tierDamage);
  damage = fr(damage * globalScale);
  damage = floorLikeOriginal(damage);
  const fd = fr(minDamage);
  return damage > fd ? damage : fd;
}

const ucomissNE = (a, b) => !(a === b || Number.isNaN(a) || Number.isNaN(b));
/**
 * The direction a hit counts as: a back attack is treated as forward.
 * @param {number} d Attack direction: 0 forward, 1 right, 2 back, 3 left.
 * @returns {number} The hit direction.
 */
export const hitDirection = (d) => (d === 2 ? 0 : d);

/**
 * What a resolved hit does to both fighters. An undefended hit slows the victim's turning and, on the swing's first hit,
 * turns them. A tier 3 or unparryable hit adds 0.15s of hitstop, up to the cap, and later hits in a multi-hit use
 * hitstopMultihitTime if set. The attacker's lock shrinks by the sword's recoveryBonusOnHit.
 * @param {object} c Hit: defense, resultAfterDefense, blockReturnedTrue, attackerDirection, attackerTier, attackerActionId, hitsThisSwing, attackerLockTimer, attackerForce, hitImpulse, turnSelfX, recoveryBonusOnHit.
 * @param {object} t Tuning: turnAttackAngle, hitstopTime, hitstopTimeMax, hitstopMultihitTime.
 * @returns {object} hitDirection, incrementMultiBlock, slowVictimTurnRate, turnVictim, turnAmount, landed, setAttackerForce, attackerForce, setLockTimer, lockTimer, hitsThisSwing, hitstop.
 */
export function resolveHitOutcome(c, t) {
  const o = { hitDirection: hitDirection(c.attackerDirection), incrementMultiBlock: c.defense === DEF_BLOCK && c.blockReturnedTrue,
    slowVictimTurnRate: false, turnVictim: false, turnAmount: 0 };
  if (c.defense === DEF_NONE) {
    o.slowVictimTurnRate = true;
    if (c.hitsThisSwing === 0) { o.turnVictim = true; o.turnAmount = fr(sv(c.turnSelfX) * t.turnAttackAngle); }
  }
  o.landed = c.resultAfterDefense === HIT_LANDED || c.resultAfterDefense === HIT_GUARD_BROKEN;
  o.setAttackerForce = ucomissNE(c.hitImpulse[0], c.attackerForce[0]) || ucomissNE(c.hitImpulse[1], c.attackerForce[1]) || ucomissNE(c.hitImpulse[2], c.attackerForce[2]);
  o.attackerForce = o.setAttackerForce ? c.hitImpulse : c.attackerForce;
  const lock = maxss(fr(c.attackerLockTimer - sv(c.recoveryBonusOnHit)), 0);
  o.setLockTimer = !Object.is(lock, c.attackerLockTimer) || Number.isNaN(lock);
  o.lockTimer = o.setLockTimer ? lock : c.attackerLockTimer;
  o.hitsThisSwing = c.hitsThisSwing + (o.landed ? 1 : 0);
  let hs = t.hitstopTime;
  if (c.attackerTier === TIER_3 || c.attackerActionId === ACTION_UNPARRYABLE) hs = fr(hs + fr(0.15));
  hs = minss(hs, t.hitstopTimeMax);
  if (t.hitstopMultihitTime > 0 && o.hitsThisSwing > 1) hs = t.hitstopMultihitTime;
  o.hitstop = hs;
  return o;
}
