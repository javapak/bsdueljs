// One native driver for every combat rule, used by combat_diff.mjs. Each line: rule id + fields,
// floats as hex bit patterns; prints all outputs the same way.
#include "../../rewrite/combat/combat_rules.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <cmath>
using namespace berimbau;
static std::istringstream s;
static float F() { std::string x; s >> x; uint32_t u = (uint32_t)std::stoul(x, nullptr, 16); float f; std::memcpy(&f, &u, 4); return f; }
static int I() { int x; s >> x; return x; }
static bool B() { return I() != 0; }
static Vec3 V() { float a = F(), b = F(), c = F(); return {a, b, c}; }
static SwordValue SV() { bool p = B(); float v = F(); return {p, v}; }
static SwordInt SI() { bool p = B(); int v = I(); return {p, v}; }
static uint32_t H(float f) { uint32_t u; std::memcpy(&u, &f, 4); return u; }
static void PF(float f) { printf("%08x ", H(f)); }
static void PV(Vec3 v) { PF(v.x); PF(v.y); PF(v.z); }
static void PI(int i) { printf("%d ", i); }
static ClashFighter CF() { ClashFighter c{}; c.origin = V(); c.stanceType = I(); c.sheathedAttack = B(); c.attackLanded = B(); c.actionId = I(); c.tier = I(); c.direction = I(); c.characterIndex = I(); c.lockTimer = F(); c.absVelocity = V(); c.turnSelfX = SV(); c.turnOpponentX = SV(); c.recoveryX = SV(); c.forwardRecoveryX = SV(); c.sideRecoveryX = SV(); return c; }
static void PS(const ClashSide &c) { PF(c.hitstop); PI(c.turnToward); PF(c.turnAmount); PI(c.staggered); PI(c.setLockTimer); if (c.setLockTimer) PF(c.lockTimer); else PF(0); PV(c.knockback); }
int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    s = std::istringstream(line); s.clear();
    int r = I();
    if (r == 0) {
      BlockInput in{}; in.defenderOrigin = V(); in.attackerOrigin = V(); in.defenderForward = V(); in.attackerInAttackAction = B(); in.attackerTier = I(); in.swordBreaksBlockAtTier3 = B();
      BlockTuning t{}; t.blockDotProduct = F(); t.blockChipDamage = F(); t.knockbackBlock = F();
      HitDamage d{}; d.force = V(); d.damage = F();
      auto o = ResolveBlock(in, t, d); PI((int)o.outcome); PF(o.facingDot); PV(d.force); PF(d.damage);
    } else if (r == 1) {
      ParryInput in{}; in.defenderOrigin = V(); in.attackerOrigin = V(); in.defenderForward = V(); in.attackerHasAction = B(); in.attackerTier = I(); in.attackerActionId = I(); in.attackerStanceType = I(); in.swordBreaksParryAtTier3 = B(); in.inParryWindow = B(); in.attackerAbsVelocity = V();
      ParryTuning t{}; t.knockbackIntercept = F(); t.interceptMomentumScale = F(); t.interceptTime = F();
      HitDamage d{}; d.force = V(); d.damage = F();
      auto o = ResolveParry(in, t, d); int oc = (int)o.outcome; PI(oc); PV(o.recoil); PI(o.stunAttacker); PV(o.attackerVelocity); PF(o.defenderLockTimer); PV(d.force); PF(d.damage);
    } else if (r == 2) {
      ClashFighter a = CF(), b = CF();
      ClashTuning t{}; t.recoveryNormal = F(); t.recoveryBetter = F(); t.recoveryWorse = F(); t.turnParryAngle = F(); t.kbParry = F(); t.kbAirParry = F(); t.kbAirParryUp = F(); t.kbKeepMomentum = B();
      auto o = ResolveClash(a, b, t); PI(o.delta); PI(o.swapped); PS(o.high); PS(o.low); PV(o.effectOrigin); PI(o.effectKind);
    } else if (r == 3) {
      ComboState c{}; c.hitsThisSwing = I(); c.comboCount = I(); c.comboResetTime = F(); float cur = F(); Vec3 ao = V(), vo = V();
      ComboTuning t{}; t.scalingTime = F(); t.scalingAttacks = I(); t.scalingKnockback = F(); t.scalingDamage = F(); t.damageMinimum = F(); t.attackerPush = F(); t.attackerPushMax = F();
      HitDamage d{}; d.force = V(); d.damage = F();
      auto o = ApplyComboScaling(c, cur, ao, vo, t, d); PI(o.scaled); PV(o.attackerPush); PI(c.comboCount); PF(c.comboResetTime); PV(d.force); PF(d.damage);
    } else if (r == 4) {
      DamageInput in{}; in.attackerInAttackAction = B(); in.tierDamage = I(); in.stanceType = I(); in.direction = I(); in.tier = I(); in.actionId = I(); in.hitsThisSwing = I(); in.victimStunType = I(); in.swingProgress = F();
      SwordDamageValues &w = in.sword; w.present = B(); w.damageDotProductX = SV(); w.damageX = SV(); for (auto &x : w.stanceX) x = SV(); w.forwardX = SV(); w.sideX = SV(); w.parryX = SV(); w.multiHitScale = SV(); w.multiHitMinDamage = SI(); for (auto &x : w.minDamageTier) x = SI();
      float g = F(); static float powv; powv = F();
      PF(ComputeAttackDamage(in, g, [](float, float) { return powv; }));
    } else if (r == 5) {
      HitContext c{}; c.defense = (DefenseKind)I(); c.resultAfterDefense = I(); c.blockReturnedTrue = B(); c.attackerDirection = I(); c.attackerTier = I(); c.attackerActionId = I(); c.hitsThisSwing = I(); c.attackerLockTimer = F(); c.attackerForce = V(); c.hitImpulse = V(); c.turnSelfX = SV(); c.recoveryBonusOnHit = SV();
      HitTuning t{}; t.turnAttackAngle = F(); t.turnRateSpeed = F(); t.turnRateDuration = F(); t.hitstopTime = F(); t.hitstopTimeMax = F(); t.hitstopMultihitTime = F();
      auto o = ResolveHitOutcome(c, t); PI(o.hitDirection); PI(o.landed); PI(o.incrementMultiBlock); PI(o.slowVictimTurnRate); PI(o.turnVictim); PF(o.turnAmount); PI(o.setAttackerForce); PV(o.attackerForce); PI(o.setLockTimer); PF(o.lockTimer); PI(o.hitsThisSwing); PF(o.hitstop);
    }
    printf("\n");
  }
}
