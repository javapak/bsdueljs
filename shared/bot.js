// Simple practice opponent. It only presses the same buttons a player can.
import { IN } from './sim.js';
export function makeBotBrain() {
  let thinkAt = 0, plan = 'approach', holdUntil = 0, stanceAt = 0;
  return (p, w) => {
    const q = w.players.find((x) => x !== p && x.alive);
    if (!q || !p.alive || p.frozen) { p.buttons = 0; return; }
    const dx = q.origin[0] - p.origin[0], dy = q.origin[1] - p.origin[1];
    const d = Math.hypot(dx, dy);
    p.viewYaw = Math.atan2(dy, dx) * 180 / Math.PI;
    if (p.kneeling) {
      if (w.time >= thinkAt) { thinkAt = w.time + 0.3 + Math.random() * 0.3; const r = Math.random(); p.buttons = r < 0.6 ? IN.JUMP : r < 0.8 ? IN.ATTACK : IN.BACK; }
      return;
    }
    if (w.time >= stanceAt) { stanceAt = w.time + 6 + Math.random() * 8; p.buttons = 0; const s = [IN.STANCE_BAL, IN.STANCE_FAST, IN.STANCE_HEAVY][Math.floor(Math.random() * 3)]; p.prevButtons = 0; p.buttons = s; return; }
    if (w.time >= thinkAt) {
      thinkAt = w.time + 0.15 + Math.random() * 0.25;
      const r = Math.random();
      if (d > 75) plan = 'approach';
      else if (q.isSwinging() && r < 0.55) plan = 'block';
      else if (d < 45 && r < 0.1) plan = 'grab';
      else if (r < 0.45) { plan = 'attack'; holdUntil = w.time + (Math.random() < 0.25 ? 1.2 : 0.05); } else if (r < 0.65) plan = 'strafe';
      else if (r < 0.8) plan = 'back';
      else plan = 'attack';
    }
    let b = 0;
    switch (plan) {
      case 'approach': b |= IN.FORWARD; break;
      case 'block': b |= IN.BLOCK; break;
      case 'grab': b |= IN.GRAB; break;
      case 'back': b |= IN.BACK; break;
      case 'strafe': b |= (Math.floor(w.time) % 2 ? IN.LEFT : IN.RIGHT); break;
      case 'attack': if (!p.act || p.isAttacking()) b |= (w.time < holdUntil || !p.isAttacking()) ? IN.ATTACK : 0; if (d > 60) b |= IN.FORWARD; break;
      default:
    }
    p.buttons = b;
  };
}
