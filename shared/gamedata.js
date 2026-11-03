// Loads the game's own script files (never copied: read from the player's install).
import { parseKV, kvFind, kvGet, kvAll } from './kv.js';

function toObj(nodes) {
  // KV -> plain object with lowercase keys; repeated keys become arrays under key+'[]' as well.
  const o = {};
  for (const n of nodes) {
    const k = n.key.toLowerCase();
    const v = Array.isArray(n.value) ? toObj(n.value) : n.value;
    if (k in o) (o[k + '[]'] ||= [o[k]]).push(v); else o[k] = v;
  }
  return o;
}
function deepMerge(base, over) {
  const r = { ...base };
  for (const [k, v] of Object.entries(over)) {
    r[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return r;
}
const lookupCI = (o, name) => { const l = String(name).toLowerCase(); return o[l]; };

export const STANCE_KEYS = ['balanced', 'reverse', 'heavy', 'air']; // index = StanceType in the original
export const ACTION_IDS = ['Block', 'Parry', 'Guard', 'Feint', 'Kick', 'Bow', 'Flourish', 'Taunt', 'Sit', 'Kill', 'Roll', 'Shuffle', 'AirDash', 'Grab', 'GrabDeflect', 'Thrown', 'Interrupt', 'InterruptUpper', 'AirInterrupt', 'Fall', 'Parried', 'ParriedAir', 'HitReactionWeak', 'HitReactionStrong', 'WallRun', 'WallFlip', 'WallSlide', 'WallClimb', 'Vault', 'WallTransTo', 'KneelingFalling', 'KneelingRecover', 'KneelRoll', 'RecoveryAttack', 'KneelParry', 'ThrowWeapon', 'GrapplingHook', 'AutoBlockThrowable', 'SprayPaintImage'];
export const actionId = (name) => { const i = ACTION_IDS.indexOf(name); return i >= 0 ? i : 39; };

export class GameData {
  // read: async (relative path under the game dir) => string
  static async load(read, cvars) {
    const d = new GameData();
    d.cvars = cvars;
    const text = async (p) => read(p);
    // actions
    d.rawActions = {};
    const addActions = (src) => {
      const root = parseKV(src);
      const a = kvFind(root, 'Actions');
      if (a) for (const n of a.value) if (Array.isArray(n.value)) d.rawActions[n.key.toLowerCase()] = toObj(n.value);
    };
    const man = parseKV(await text('scripts/berimbau_action_manifest.txt'));
    const body = kvFind(man, 'actionmanifest')?.value || [];
    const walk = async (nodes, dir) => {
      for (const n of nodes) {
        const k = n.key.toLowerCase();
        if (k === 'file') addActions(await text(dir + n.value));
        else if (k === 'manifest') {
          const path = dir + n.value;
          const sub = parseKV(await text(path));
          const inner = sub.length && Array.isArray(sub[0].value) ? sub[0].value : sub;
          await walk(inner, path.slice(0, path.lastIndexOf('/') + 1));
        }
      }
    };
    await walk(body, 'scripts/');
    d.actions = {};
    const resolve = (name) => {
      const k = name.toLowerCase();
      if (d.actions[k]) return d.actions[k];
      const raw = d.rawActions[k];
      if (!raw) return null;
      const merged = raw.extends ? deepMerge(resolve(raw.extends) || {}, raw) : raw;
      merged.name = name;
      d.actions[k] = merged;
      return merged;
    };
    for (const k of Object.keys(d.rawActions)) resolve(k);
    // stances
    d.stances = {};
    const addStances = (src) => {
      const s = kvFind(parseKV(src), 'Stances');
      if (s) for (const n of s.value) if (Array.isArray(n.value)) d.stances[n.key.toLowerCase()] = toObj(n.value);
    };
    addStances(await text('scripts/berimbau_stances.txt'));
    // characters
    d.characters = {};
    const chars = kvFind(parseKV(await text('scripts/characters.txt')), 'Characters');
    for (const n of chars.value) {
      if (!Array.isArray(n.value)) continue;
      const c = toObj(n.value);
      c.key = n.key.toLowerCase();
      d.characters[c.key] = c;
      try { addStances(await text(`scripts/characters/${c.key}/stances.txt`)); } catch { /* character without its own stance file */ }
    }
    for (const k of Object.keys(d.stances)) {
      const s = d.stances[k];
      if (s.extends && d.stances[s.extends.toLowerCase()]) d.stances[k] = deepMerge(d.stances[s.extends.toLowerCase()], s);
    }
    // sword types
    d.swordTypes = {};
    const st = kvFind(parseKV(await text('scripts/swordtypes.txt')), 'swordtypes');
    for (const n of st.value) if (Array.isArray(n.value)) d.swordTypes[n.key.toLowerCase()] = toObj(n.value);
    for (const k of Object.keys(d.swordTypes)) {
      const s = d.swordTypes[k];
      if (s.extends && d.swordTypes[s.extends.toLowerCase()]) d.swordTypes[k] = { ...d.swordTypes[s.extends.toLowerCase()], ...s };
    }
    // the sword each character starts with (any character can use any type):
    // characters.txt "sword" id_N -> itemdefid in items.json -> sword_type
    d.charSword = {};
    const items = JSON.parse(await text('scripts/items.json')).items;
    for (const k of Object.keys(d.characters)) {
      const id = parseInt(String(d.characters[k].sword).replace('id_', ''), 10);
      d.charSword[k] = items.find((i) => i.itemdefid === id)?.sword_type;
    }
    // tracers: per character, activity -> sorted cycle list
    d.tracers = {};
    for (const c of Object.keys(d.characters)) {
      d.tracers[c] = {};
      let list;
      try { list = await text(`scripts/characters/${c}/tracers.txt`); } catch { continue; }
      for (const m of list.matchAll(/#base\s+"([^"]+)"/g)) {
        let src;
        try { src = await text(`scripts/characters/${c}/${m[1]}`); } catch { continue; }
        const root = kvFind(parseKV(src), 'tracers');
        if (!root) continue;
        for (const who of root.value) {
          if (who.key.toLowerCase() === 'metadata' || !Array.isArray(who.value)) continue;
          for (const act of who.value) {
            const cyc = kvAll(act.value, 'trace').map((t) => parseFloat(kvGet(t.value, 'cycle'))).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
            d.tracers[c][act.key.toUpperCase()] = cyc;
          }
        }
      }
    }
    return d;
  }

  action(name) { return lookupCI(this.actions, name); }
  stanceFor(charKey, stanceType) {
    const c = this.characters[charKey];
    const name = c.stances?.[STANCE_KEYS[stanceType]];
    return name ? this.stances[name.toLowerCase()] : null;
  }
  // Mirrors the stance's GetAction(direction, comboIndex): side attacks use left/right,
  // forward/back use the "forward" string.
  attackFor(charKey, stanceType, dir, comboIdx) {
    const s = this.stanceFor(charKey, stanceType);
    if (!s) return null;
    let name;
    if (dir === 1) name = s.right; else if (dir === 3) name = s.left;
    else {
      const f = s.forward;
      if (f) {
        const list = f['action[]'] || (f.action ? [f.action] : []);
        name = list[comboIdx % Math.max(1, list.length)];
      }
    }
    return name ? this.action(name) : null;
  }
  swordFor(charKey, type) { return this.swordTypes[type] || this.swordTypes[this.charSword[charKey]] || this.swordTypes.default; }
}
