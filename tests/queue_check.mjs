// Arena queues on a real multi-arena map: who plays, who's next after a win, a loss, a draw, and people leaving.
// Usage: node tests/queue_check.mjs "<install>"
import { readFileSync } from 'node:fs';
import { BSP } from '../shared/bsp.js';
import { GameData } from '../shared/gamedata.js';
import { CharacterStore } from '../shared/assets.js';
import { World, Player, Cvars, TICK, IN } from '../shared/sim.js';
const G = process.argv[2] + '/berimbau/';
const cvars = new Cvars(JSON.parse(readFileSync(new URL('../shared/cvars_all.json', import.meta.url))));
const data = await GameData.load(async (p) => readFileSync(G + p, 'latin1'), cvars);
const assets = new CharacterStore(async (p) => readFileSync(G + p), data);
await assets.preload('knight');
const bsp = new BSP(readFileSync(G + 'maps/duel_temple.bsp'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };
const ids = (d) => d.queue.map((p) => p.name).join('');
const fresh = () => new World({ bsp, data, cvars, assets, map: 'duel_temple' });
const mk = (id, name) => new Player(id, name, 'knight');
const run = (w, s) => { for (let i = 0; i < s / TICK; i++) w.step(); };
const toState = (w, d, state, max = 40) => { for (let i = 0; i < max / TICK && d.state !== state; i++) w.step(); return d.state === state; };

{ // arenas come from the map, named
  const w = fresh();
  check('three arenas', w.duels.length === 3, w.duels.length);
  check('with the game\'s names', w.duels.map((d) => d.name).sort().join() === ['The Cliffs', 'The Courtyard', 'The Dojo'].sort().join(), w.duels.map((d) => d.name));
  const spots = w.duels.map((d) => d.pickSpawnPair()[0].o.join());
  check('each has its own spawns', new Set(spots).size === 3, spots);
}

{ // one alone roams; the front two play; a third waits outside the world
  const w = fresh(), d = w.duels[0], [a, b, c] = [mk(1, 'A'), mk(2, 'B'), mk(3, 'C')];
  w.addPlayer(a);
  check('one alone is in the world, not in a duel', w.players.includes(a) && d.state === 'waiting');
  w.addPlayer(b);
  check('two start a match', d.state === 'warmup' && d.fighters.join() === '1,2', d.state);
  w.addPlayer(c);
  check('the third waits out of the world', !w.players.includes(c) && ids(d) === 'ABC', ids(d));
  w.addPlayer(c);
  check('joining twice changes nothing', ids(d) === 'ABC', ids(d));

  // A beats B: winner keeps the front, loser behind the third, and next is A against C
  toState(w, d, 'fight');
  for (let r = 0; r < 2; r++) {
    check(`round ${r + 1} fighting`, toState(w, d, 'fight'), d.state);
    w.kill(b, a);
    toState(w, d, r === 0 ? 'warmup' : 'cooldown');
  }
  check('the winner stays in front, the loser goes behind the next', ids(d) === 'ACB', ids(d));
  check('both still in the world for the cooldown', w.players.includes(a) && w.players.includes(b));
  toState(w, d, 'warmup');
  check('next match is winner against next in line', d.fighters.join() === '1,3', d.fighters);
  check('the loser has left the world', !w.players.includes(b) && w.players.includes(c));
}

{ // one alone can walk around in every arena, and a second person brings them back for the duel
  for (let i = 0; i < 3; i++) {
    const w = fresh(), d = w.duels[i], [a, b] = [mk(1, 'A'), mk(2, 'B')];
    w.addPlayer(a, i);
    const spawn = [...a.origin];
    run(w, 0.5);
    const from = [...a.origin];
    a.buttons = IN.FORWARD; a.viewYaw = a.yaw;
    run(w, 1);
    const moved = Math.hypot(a.origin[0] - from[0], a.origin[1] - from[1]);
    check(`alone in ${d.name}, walks`, d.state === 'waiting' && moved > 100, moved);
    w.addPlayer(b, i);
    check(`and a second person starts the duel from the spawn in ${d.name}`, d.state === 'warmup' && a.frozen && Math.hypot(a.origin[0] - spawn[0], a.origin[1] - spawn[1]) < 1, [d.state, a.origin]);
  }
}

{ // the challenger winning takes the front
  const w = fresh(), d = w.duels[0], [a, b, c] = [mk(1, 'A'), mk(2, 'B'), mk(3, 'C')];
  for (const p of [a, b, c]) w.addPlayer(p);
  for (let r = 0; r < 2; r++) { toState(w, d, 'fight'); w.kill(a, b); toState(w, d, r === 0 ? 'warmup' : 'cooldown'); }
  check('a new winner goes to the front', ids(d) === 'BCA', ids(d));
}

{ // two alone rematch, and a draw sends both behind whoever waited
  const w = fresh(), d = w.duels[0], [a, b] = [mk(1, 'A'), mk(2, 'B')];
  w.addPlayer(a); w.addPlayer(b);
  for (let r = 0; r < 2; r++) { toState(w, d, 'fight'); w.kill(b, a); toState(w, d, r === 0 ? 'warmup' : 'cooldown'); }
  toState(w, d, 'warmup');
  check('two alone rematch', d.fighters.length === 2 && w.players.length === 2, d.fighters);

  const w2 = fresh(), d2 = w2.duels[0], [x, y, z] = [mk(1, 'X'), mk(2, 'Y'), mk(3, 'Z')];
  for (const p of [x, y, z]) w2.addPlayer(p);
  d2.round = 99; toState(w2, d2, 'fight');
  d2.endRound(null, 'timeup');
  toState(w2, d2, 'cooldown');
  check('a draw sends both behind the one waiting', ids(d2) === 'ZXY', ids(d2));
}

{ // leaving
  const w = fresh(), d = w.duels[0], [a, b, c] = [mk(1, 'A'), mk(2, 'B'), mk(3, 'C')];
  for (const p of [a, b, c]) w.addPlayer(p);
  w.removePlayer(3);
  check('leaving the queue leaves the match alone', d.state === 'warmup' && ids(d) === 'AB', ids(d));
  w.addPlayer(c);
  w.removePlayer(2);
  check('a fighter leaving brings in the next', d.fighters.join() === '1,3' && !w.players.includes(b) && d.state === 'warmup', [d.fighters, d.state]);
  w.removePlayer(3);
  check('one left has the arena alone', d.state === 'waiting' && w.players.length === 1, [d.state, w.players.length]);
  // asked to stop while playing: stays for the match, then is gone
  w.addPlayer(b); a.unready = true;
  for (let r = 0; r < 2; r++) { toState(w, d, 'fight'); w.kill(a, b); toState(w, d, r === 0 ? 'warmup' : 'cooldown'); }
  toState(w, d, 'waiting', 15);
  check('an unready fighter leaves after the match', !d.queue.includes(a) && ids(d) === 'B', ids(d));
}

{ // a person doesn't wait behind a bot
  const w = fresh(), d = w.duels[0], [a, bot, c] = [mk(1, 'A'), mk(2, 'Bot'), mk(3, 'C')];
  bot.isBot = true;
  w.addPlayer(a); w.addPlayer(bot);
  check('person against bot', d.fighters.join() === '1,2', d.fighters);
  run(w, 1);
  w.addPlayer(c);
  check('a second person replaces the bot', d.fighters.join() === '1,3' && !w.players.includes(bot), [d.fighters]);
}

{ // arenas run side by side and don't touch
  const w = fresh(), [a, b, c, e] = [mk(1, 'A'), mk(2, 'B'), mk(3, 'C'), mk(4, 'E')];
  w.addPlayer(a, 0); w.addPlayer(b, 0); w.addPlayer(c, 1); w.addPlayer(e, 1);
  check('both start', w.duels[0].state === 'warmup' && w.duels[1].state === 'warmup');
  toState(w, w.duels[0], 'fight');
  w.kill(a, b);
  check('a death ends only its own round', w.duels[0].state === 'intermission' && w.duels[1].state === 'fight', [w.duels[0].state, w.duels[1].state]);
  // one on top of another arena's fighter: no shove
  c.origin = [...a.origin]; c.vel = [0, 0, 0];
  const before = [...c.origin];
  w.softCollide();
  check('other arenas don\'t collide', c.origin.join() === before.join(), c.origin);
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
