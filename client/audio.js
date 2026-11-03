// Game audio. Sound definitions, files and soundscapes are read from the player's install at runtime; what plays
// comes from each animation's own events, the same way the original client does, plus the sim's game events.
import { parseKV } from '/shared/kv.js';

const latin1 = new TextDecoder('latin1');
const num = (v, d) => { const n = parseFloat(v); return Number.isNaN(n) ? d : n; };
const NAMED = { VOL_NORM: 1, PITCH_NORM: 100, PITCH_LOW: 95, PITCH_HIGH: 120 };
// "0.9, 1.0" and "VOL_NORM" both appear in the scripts
const parseRange = (v, d) => {
  if (v === undefined) return [d, d];
  const p = String(v).split(',').map((s) => { const t = s.trim(); return t in NAMED ? NAMED[t] : num(t, d); });
  return [p[0], p[1] ?? p[0]];
};
const pick = ([a, b]) => a + Math.random() * (b - a);
const SNDLVL = { SNDLVL_NONE: 0, SNDLVL_IDLE: 60, SNDLVL_TALKING: 60, SNDLVL_STATIC: 66, SNDLVL_NORM: 75, SNDLVL_GUNFIRE: 140 };
function parseLevel(v) {
  if (v === undefined) return 75;
  const s = String(v).trim().toUpperCase();
  if (s in SNDLVL) return SNDLVL[s];
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : 75;
}
const cleanWave = (w) => String(w).replace(/^[)^*#@<>!?(}$&~`+%]+/, '').replace(/\\/g, '/');
const children = (nodes, key) => nodes.filter((n) => n.key.toLowerCase() === key);

function parseSound(nodes) {
  const get = (k) => children(nodes, k)[0]?.value;
  const waves = [];
  for (const n of nodes) {
    const k = n.key.toLowerCase();
    if (k === 'wave') waves.push(cleanWave(n.value));
    else if (k === 'rndwave' && Array.isArray(n.value)) for (const w of children(n.value, 'wave')) waves.push(cleanWave(w.value));
  }
  return { channel: String(get('channel') ?? 'CHAN_AUTO').toUpperCase(), volume: parseRange(get('volume'), 1), pitch: parseRange(get('pitch'), 100), level: parseLevel(get('soundlevel')), waves, last: -1 };
}

// [R client.dll 1802c0fe7] the animations name the generic swing; the sword type says which one it really is
const SWOOSH = { 'weapon_blade.balanced': 'soundswooshbalanced', 'weapon_blade.reverse': 'soundswooshfast', 'weapon_blade.heavy': 'soundswooshheavy' };
const HIT_KEY = ['soundhitbalanced', 'soundhitfast', 'soundhitheavy', 'soundhitbalanced'];
const SILENT = new Set(['chan_static']);

export class Audio {
  constructor(fetchGame, info, bsp) {
    Object.assign(this, { fetchGame, info, bsp, ctx: null, sounds: new Map(), scapes: new Map(), buffers: new Map(), voices: [], pos: new Map(), tracks: new Map(), scape: null, scapeName: null, lastCi: new Map(), played: [], failed: new Set(), surfaces: new Map(), materials: new Map() });
    this.master = 1;
  }

  async load() {
    const text = async (p) => { const b = await this.fetchGame(p); return b ? latin1.decode(b) : null; };
    const manifest = await text('scripts/game_sounds_manifest.txt');
    const files = manifest ? [...new Set(children(parseKV(manifest)[0].value, 'precache_file').map((n) => n.value))] : [];
    for (const src of await Promise.all(files.map(text))) {
      if (!src) continue;
      for (const n of parseKV(src)) if (Array.isArray(n.value) && !this.sounds.has(n.key.toLowerCase())) this.sounds.set(n.key.toLowerCase(), parseSound(n.value));
    }
    const scapeManifest = await text('scripts/soundscapes_manifest.txt');
    const scapeFiles = scapeManifest ? parseKV(scapeManifest)[0].value.filter((n) => typeof n.value === 'string').map((n) => n.value) : [];
    for (const src of await Promise.all(scapeFiles.map(text))) {
      if (!src) continue;
      for (const n of parseKV(src)) if (Array.isArray(n.value)) this.scapes.set(n.key.toLowerCase(), n.value);
    }
    const surfaceManifest = await text('scripts/surfaceproperties_manifest.txt');
    const surfaceFiles = surfaceManifest ? children(parseKV(surfaceManifest)[0].value, 'file').map((n) => n.value) : [];
    for (const src of await Promise.all(surfaceFiles.map(text))) {
      if (!src) continue;
      for (const n of parseKV(src)) {
        if (!Array.isArray(n.value)) continue;
        this.surfaces.set(n.key.toLowerCase(), { base: children(n.value, 'base')[0]?.value?.toLowerCase(), step: children(n.value, 'stepleft')[0]?.value });
      }
    }
    this.scapeEnts = this.bsp.entities.filter((e) => e.classname === 'env_soundscape' && e.soundscape && e.origin).map((e) => ({ name: e.soundscape.toLowerCase(), radius: num(e.radius, -1), o: e.origin.split(' ').map(Number) }));
  }

  // Browsers only allow audio once the player has clicked something
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.out = this.ctx.createGain();
    this.out.gain.value = this.master;
    this.out.connect(this.ctx.destination);
    for (const name of ['announcer.round1', 'announcer.fight', 'player_shared.jump', 'player_shared.chargespinning', 'player_shared.chargetier2', 'player_shared.chargetier3', 'player_shared.chargetier3soft']) this.sounds.get(name)?.waves.forEach((w) => this.buffer(w));
  }

  buffer(wave) {
    const key = wave.toLowerCase();
    if (!this.buffers.has(key)) {
      this.buffers.set(key, this.fetchGame('sound/' + wave).then(async (bytes) => {
        if (!bytes) throw new Error('missing');
        return this.ctx.decodeAudioData(bytes.slice().buffer);
      }).catch((e) => { if (!this.failed.has(key)) { this.failed.add(key); console.warn('audio: could not load', wave, e.message); } return null; }));
    }
    return this.buffers.get(key);
  }

  // pos or ent places the sound in the world; neither plays it flat, like the announcer
  async play(name, { ent = null, pos = null, volume = 1, still = null } = {}) {
    if (!this.ctx) return;
    const def = this.sounds.get(String(name).toLowerCase());
    if (!def?.waves.length) { this.note(name, 'unknown'); return; }
    // rndwave never repeats itself twice in a row
    let i = Math.floor(Math.random() * def.waves.length);
    if (def.waves.length > 1 && i === def.last) i = (i + 1) % def.waves.length;
    def.last = i;
    const wave = def.waves[i];
    const buf = await this.buffer(wave);
    if (!buf || !this.ctx) { this.note(name, 'failed'); return; }
    if (still && !still()) return;
    // a channel on an entity holds one sound at a time, except CHAN_AUTO
    if (ent != null && def.channel !== 'CHAN_AUTO' && !SILENT.has(def.channel.toLowerCase())) {
      for (const v of this.voices) if (v.ent === ent && v.channel === def.channel) this.stop(v);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pick(def.pitch) / 100;
    const gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
    src.connect(gain); gain.connect(pan); pan.connect(this.out);
    const voice = { name: def, src, gain, pan, ent, pos, channel: def.channel, level: def.level, volume: pick(def.volume) * volume };
    src.onended = () => { const k = this.voices.indexOf(voice); if (k >= 0) this.voices.splice(k, 1); };
    this.place(voice);
    this.voices.push(voice);
    src.start();
    this.note(name, wave);
  }

  note(name, what) { this.played.push(`${name}=${what}`); if (this.played.length > 400) this.played.shift(); }

  stop(v) { try { v.src.stop(); } catch { /* already finished */ } }

  // Source's falloff: attenuation from the sound level, against a 1000 unit clip distance. 0 and very loud are flat.
  place(v) {
    const p = v.ent != null ? this.pos.get(v.ent) : v.pos;
    let g = v.volume, pan = 0;
    if (p && this.eye && v.level > 0 && v.level < 130) {
      const d = [p[0] - this.eye[0], p[1] - this.eye[1], p[2] - this.eye[2]], dist = Math.hypot(d[0], d[1], d[2]);
      const attn = v.level > 50 ? 20 / (v.level - 50) : 4;
      g *= Math.max(0, 1 - dist * attn / 1000);
      if (dist > 1) pan = Math.max(-1, Math.min(1, (d[0] * this.right[0] + d[1] * this.right[1] + d[2] * this.right[2]) / dist));
    }
    v.gain.gain.value = g;
    v.pan.pan.value = pan;
  }

  frame(eye, right) {
    this.eye = eye; this.right = right;
    for (const v of this.voices) this.place(v);
    const now = performance.now();
    if (this.ctx && this.scapeEnts?.length && !(now < this.nextScape)) { this.nextScape = now + 1000; this.updateScape(eye); }
  }

  // ---------------------------------------------------------------- animation events
  // Called for every snapshot: fires the events each playing sequence crossed since the last one
  onSnap(snap, charOf) {
    for (const p of snap.players) {
      this.pos.set(p.id, p.o);
      const char = charOf(p.c);
      if (!char || !p.an) continue;
      const t = this.tracks.get(p.id) ?? {};
      this.tracks.set(p.id, t);
      this.chargeSpin(t, p);
      this.layer(t, 'b', p, char, p.an.b, p.an.bc);
      this.layer(t, 'u', p, char, p.an.u, p.an.uc);
      this.layer(t, 't', p, char, p.an.tl?.[0], p.an.tl?.[1]);
    }
  }

  // [R client.dll 1802c0106] the spin starts 0.1s into a charge and is cut off when it ends. The file has no cue chunk, so it plays once.
  chargeSpin(t, p) {
    const charging = p.a?.ph === 'charge' && p.a.ce > 0.1;
    if (charging === !!t.charging) return;
    t.charging = charging;
    const def = this.sounds.get('player_shared.chargespinning');
    if (charging) this.play('Player_Shared.ChargeSpinning', { ent: p.id, still: () => t.charging });
    else for (const v of [...this.voices]) if (v.ent === p.id && v.name === def) this.stop(v);
  }

  layer(t, slot, p, char, anim, cycle) {
    const was = t[slot];
    if (!anim) { t[slot] = null; return; }
    t[slot] = { anim, cycle };
    const seq = char.seqForActivity(anim);
    if (!seq) return;
    const events = seq.model.seqEvents(seq);
    if (!events.length) return;
    if (was?.anim !== anim) { this.fire(events, -1, cycle, p, anim); return; }
    if (cycle >= was.cycle) { if (cycle > was.cycle) this.fire(events, was.cycle, cycle, p, anim); return; }
    // the cycle went backward: a loop wrapped, or the same animation started over
    if (seq.flags & 1) this.fire(events, was.cycle, 1, p, anim);
    this.fire(events, -1, cycle, p, anim);
  }

  fire(events, from, to, p, anim) {
    for (const e of events) if (e.cycle > from && e.cycle <= to) this.animEvent(e, p, anim);
  }

  animEvent(e, p, anim) {
    const opt = String(e.options ?? '').trim();
    const ent = p.id;
    switch (e.name) {
      case 'AE_CL_PLAYSOUND': case 'AE_CL_PLAYMOVESOUND': this.play(opt, { ent }); break;
      case 'AE_CL_PLAYCHARACTERSOUND': this.play(`Player_${p.c}${opt}`, { ent }); break;
      case 'AE_CL_PLAYWEAPONSOUND': {
        const key = SWOOSH[opt.toLowerCase()];
        this.play((key && this.info.swordSounds?.[p.sw]?.[key]) || opt, { ent });
        break;
      }
      case 'AE_BB_FOOTSTEP_SPLASH': {
        if (!p.g) break;
        this.footstep(p, opt === '1' ? 'Right' : 'Left', /WALK/i.test(anim) ? '' : 'Run');
        break;
      }
      default:
    }
  }

  // [R client.dll 1803e47dd, 1803e4808] <Character>.<Surface>.Step<Side>, then the plain <Surface>.Step<Side>. The surface
  // comes from what's underfoot: its material's $surfaceprop, then surfaceproperties.txt.
  async footstep(p, side, run) {
    const tr = this.bsp.traceBox([p.o[0], p.o[1], p.o[2] + 4], [p.o[0], p.o[1], p.o[2] - 36], [0, 0, 0], [0, 0, 0], 1);
    const surface = await this.surfaceAt(tr.texinfo);
    const names = surface ? [`${p.c}.${surface}.Step${side}`, `${surface}.Step${side}`] : [];
    names.push(`Player_${p.c}.${run}Footstep${side}`);
    this.play(names.find((n) => this.sounds.get(n.toLowerCase())?.waves.length) ?? names.at(-1), { ent: p.id });
  }

  surfaceAt(texinfo) {
    const name = this.bsp.texdata[this.bsp.texinfo[texinfo]?.texdata]?.name?.toLowerCase();
    if (!name) return null;
    if (!this.materials.has(name)) this.materials.set(name, this.materialSurface(name, 0));
    return this.materials.get(name);
  }

  async materialSurface(name, depth) {
    const path = name.replace(/\\/g, '/').replace(/\.vmt$/, '').replace(/^materials\//, '');
    const bytes = await this.fetchGame(`materials/${path}.vmt`);
    if (!bytes || depth > 4) return 'Default';
    const root = parseKV(latin1.decode(bytes))[0];
    if (!root || !Array.isArray(root.value)) return 'Default';
    const prop = root.value.find((n) => n.key.toLowerCase() === '$surfaceprop')?.value;
    if (prop) return this.stepSurface(String(prop).toLowerCase());
    // a map's patched materials point at the real one
    const include = root.value.find((n) => n.key.toLowerCase() === 'include')?.value;
    return include ? this.materialSurface(String(include).toLowerCase(), depth + 1) : 'Default';
  }

  // "Tile.StepLeft" gives Tile; a surface without its own step sound uses its base's
  stepSurface(prop) {
    for (let s = prop, i = 0; s && i < 8; i++) {
      const def = this.surfaces.get(s);
      if (!def) break;
      if (def.step) return String(def.step).split('.')[0];
      s = def.base;
    }
    return 'Default';
  }

  // ---------------------------------------------------------------- game events
  onEvent(e, players, myId) {
    const sw = (id) => this.info.swordSounds?.[players?.find((p) => p.id === id)?.sw] ?? {};
    switch (e.type) {
      case 'hit': this.play(sw(e.attacker)[HIT_KEY[e.stance] ?? 'soundhitbalanced'] ?? 'Weapon_Blade.Balanced_Hit', { pos: e.pos, ent: e.pos ? null : e.victim }); break;
      case 'blocked': this.play(sw(e.attacker).soundblocked ?? 'Weapon_Blade.Blocked', { pos: e.pos }); break;
      case 'break_block': this.play(sw(e.attacker).soundunblockable ?? 'Weapon_Blade.Penetrated', { pos: e.pos }); break;
      // [R client.dll 1803f73cd, 1803f746b] these sit beside the same effects fx.js plays for them
      case 'parried': this.play('Weapon_Blade.Offensive_Parry', { pos: e.pos }); break;
      case 'intercepted': this.play('Weapon_Blade.Counter', { pos: e.pos }); break;
      case 'world_hit': this.play('Berimbau.SwordSlashWorld', { pos: e.pos }); break;
      // [R client.dll 1803bcaf7, 1803bda75]
      case 'charge_tier': this.play(e.tier === 1 ? 'Player_Shared.ChargeTier2' : e.soft ? 'Player_Shared.ChargeTier3Soft' : 'Player_Shared.ChargeTier3', { ent: e.id }); break;
      case 'jump': this.play('Player_Shared.Jump', { ent: e.id }); break;
      case 'grab': this.play('Player_Shared.GrabSuccess', { ent: e.attacker }); break;
      case 'death': { const c = players?.find((p) => p.id === e.victim)?.c; if (c) this.play(`Player_${c}.Die`, { ent: e.victim }); break; }
      case 'round_start': this.play(e.round >= e.maxRounds ? 'Announcer.RoundLast' : `Announcer.Round${e.round}`); break;
      case 'fight': this.play('Announcer.Fight'); break;
      case 'round_end': {
        // [I] which line plays when: the binary has these names, but this choice isn't traced
        if (e.why === 'timeup') this.play('Announcer.TimeUp');
        else if (e.winner == null) this.play('Announcer.Draw');
        else if (e.winner === myId) this.play(players?.find((p) => p.id === myId)?.hp >= 100 ? 'Announcer.WinPerfect' : 'Announcer.Win');
        else this.play('Announcer.Lose');
        break;
      }
      default:
    }
  }

  // [R client.dll 1803de6b3] the string reset cue, when a combo in progress times out
  onCombo(id, ci) {
    const was = this.lastCi.get(id) ?? 0;
    this.lastCi.set(id, ci);
    if (was > 0 && ci === 0) this.play('Player_Shared.StringReset', { ent: id });
  }

  // ---------------------------------------------------------------- soundscapes
  updateScape(eye) {
    let best = null, bestD = Infinity;
    for (const s of this.scapeEnts) {
      const d = Math.hypot(s.o[0] - eye[0], s.o[1] - eye[1], s.o[2] - eye[2]);
      if ((s.radius < 0 || d <= s.radius) && d < bestD) { best = s; bestD = d; }
    }
    if (!best || best.name === this.scapeName) return;
    this.scapeName = best.name;
    this.stopScape();
    const scape = { gain: this.ctx.createGain(), timers: [], loops: [] };
    scape.gain.gain.value = 0;
    scape.gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 1.5);
    scape.gain.connect(this.out);
    this.scape = scape;
    this.startScape(best.name, scape, 1, 0);
  }

  stopScape() {
    const s = this.scape;
    if (!s) return;
    s.dead = true;
    s.timers.forEach(clearTimeout);
    s.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.5);
    setTimeout(() => { s.loops.forEach((l) => { try { l.stop(); } catch { /* finished */ } }); s.gain.disconnect(); }, 1600);
  }

  startScape(name, scape, volume, depth) {
    const nodes = this.scapes.get(name);
    if (!nodes || depth > 4) return;
    for (const n of nodes) {
      if (!Array.isArray(n.value)) continue;
      const k = n.key.toLowerCase();
      if (k === 'playlooping') this.scapeLoop(n.value, scape, volume);
      else if (k === 'playrandom') this.scapeRandom(n.value, scape, volume);
      else if (k === 'playsoundscape') {
        const sub = children(n.value, 'name')[0]?.value;
        if (sub) this.startScape(sub.toLowerCase(), scape, volume * num(children(n.value, 'volume')[0]?.value, 1), depth + 1);
      }
    }
  }

  async scapeLoop(nodes, scape, volume) {
    const wave = children(nodes, 'wave')[0]?.value;
    if (!wave) return;
    const buf = await this.buffer(cleanWave(wave));
    if (!buf || scape.dead) return;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = pick(parseRange(children(nodes, 'pitch')[0]?.value, 100)) / 100;
    g.gain.value = pick(parseRange(children(nodes, 'volume')[0]?.value, 1)) * volume;
    src.connect(g); g.connect(scape.gain);
    src.start();
    scape.loops.push(src);
    this.note('scape', wave);
  }

  scapeRandom(nodes, scape, volume) {
    const waves = [];
    for (const n of nodes) { const k = n.key.toLowerCase(); if (k === 'wave') waves.push(n.value); else if (k === 'rndwave' && Array.isArray(n.value)) for (const w of children(n.value, 'wave')) waves.push(w.value); }
    if (!waves.length) return;
    const time = parseRange(children(nodes, 'time')[0]?.value, 10), vol = parseRange(children(nodes, 'volume')[0]?.value, 1), pitch = parseRange(children(nodes, 'pitch')[0]?.value, 100);
    const next = () => {
      if (scape.dead) return;
      scape.timers.push(setTimeout(async () => {
        const buf = await this.buffer(cleanWave(waves[Math.floor(Math.random() * waves.length)]));
        if (buf && !scape.dead) {
          const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
          src.buffer = buf; src.playbackRate.value = pick(pitch) / 100; g.gain.value = pick(vol) * volume;
          src.connect(g); g.connect(scape.gain); src.start();
        }
        next();
      }, pick(time) * 1000));
    };
    next();
  }
}
