// What a client draws from: each fighter in short field names, and each arena's state, queue and watchers. Rounded to stay small,
// so it's for drawing only and never fed back into a sim. The server sends it; a peer to peer client builds its own.
const rnd = (x) => Math.round(x * 100) / 100;
const rnd3 = (x) => Math.round(x * 1000) / 1000;

/**
 * @param {World} world The world.
 * @param {function(Match): Array} [watchers] Who's watching an arena, as rows for its list.
 * @returns {object} The snapshot.
 */
export function buildSnapshot(world, watchers = () => []) {
  const data = world.data, cvars = world.cv;
  return {
    t: 'snap', time: rnd(world.time), pj: world.stars.map((s) => ({ id: s.id, k: s.type, o: s.pos.map(rnd), v: s.vel.map(rnd) })), players: world.players.map((p) => {
      const an = world.animOf(p);
      return {
        id: p.id, ar: p.arena, dc: p.dashCooldown > 0 ? rnd(p.dashCooldown) : undefined, n: p.name, c: p.character, o: p.origin.map(rnd), v: p.vel.map(rnd), y: rnd(p.yaw), p: rnd(p.pitch), hp: p.health, al: p.alive, g: p.onGround, st: world.stanceNow(p), gs: p.stance, ci: world.stringIndex(p), sw: p.sword || data.charSword[p.character], it: p.swordItem ?? data.charSwordItem[p.character], lk: p.look ?? data.defaultLook[p.character], cc: p.pickColor ?? undefined, score: p.score, kn: p.kneeling, fz: p.frozen, shd: p.sheathed && p.sheatheT <= 0 ? 1 : undefined,
        hs: p.hitstop > 0 ? 1 : 0, an: { wr: an.wr ? rnd3(an.wr) : undefined, b: an.base, bc: rnd3(an.baseCycle), u: an.upper, uc: rnd3(an.upperCycle), mx: rnd3(an.mx), my: rnd3(an.my), sp: rnd(an.speed), af: an.armsFrom, ch: an.charge && [an.charge[0], an.charge[1], rnd3(an.charge[2]), rnd3(an.charge[3]), rnd3(an.charge[4])], ld: an.land && [rnd3(an.land[0]), rnd3(an.land[1])], lg: rnd3(an.legs), tl: an.touch && [an.touch[0], rnd3(an.touch[1]), rnd3(an.touch[2])], sh: an.sheathe && [an.sheathe[0], rnd3(an.sheathe[1]), rnd3(an.sheathe[2])] },
        a: p.act ? { th: p.act.kind === 'throwweapon' && !p.act.thrown ? 1 : 0, n: p.act.name, d: p.act.dir, ph: p.act.phase, ti: p.act.tier, ct: p.act.chargeTier, l: rnd(Math.max(0, p.act.lock)), cf: p.act.phase === 'charge' && p.act.chargeTotal > 0 ? rnd3(Math.min(1, p.act.t / p.act.chargeTotal)) : 0, ce: p.act.phase === 'charge' ? rnd3(p.act.t) : 0, tr: p.act.trCount > 0 && p.act.bladeRing?.length && !p.act.trDone ? 1 : 0, pw: (p.act.kind === 'parry' || p.act.kind === 'kneelparry') && p.act.t <= p.act.parryWindow ? 1 : 0 } : null,
      };
    }),
    arenas: world.duels.map((d) => ({ s: d.state, tm: rnd(Math.max(0, d.timer)), r: d.round, w: d.wins, res: d.results, f: d.fighters, win: d.winner, max: cvars.f('vs_duel_rounds'), n: d.name, tn: d.ent?.targetname, q: (d.queue ?? []).map((p) => [p.id, p.name, p.unready ? 1 : 0, p.score, p.losses ?? 0, p.ping ?? 0]), sp: watchers(d) })),
  };
}
