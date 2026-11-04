// Loads the game's own script files (never copied: read from the player's install).
import { parseKV, kvFind, kvGet, kvAll } from './kv.js';

/**
 * KeyValues nodes as a plain object with lower case keys. A repeated key also appears as an array under key + '[]'.
 * @param {Array} nodes KeyValues nodes.
 * @returns {object} The object.
 */
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
/**
 * How a script's "extends" works: nested blocks merge, anything else is replaced.
 * @param {object} base Parent values.
 * @param {object} over This script's values.
 * @returns {object} A new merged object.
 */
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
/**
 * @param {string} name Action name from the scripts.
 * @returns {number} The game's action id; 39 is any other, which is what attacks use.
 */
export const actionId = (name) => { const i = ACTION_IDS.indexOf(name); return i >= 0 ? i : 39; };

/**
 * Every script the duel reads, loaded from your install: actions, stances, characters, sword types, throwables, tracers and the item catalog.
 */
export class GameData {
  /**
   * read: async (relative path under the game dir) => string
   * Loads everything and resolves each script's "extends".
   * @param {function(string): Promise<string>} read Reads a file by path under the game dir.
   * @param {Cvars} cvars The cvar table.
   * @returns {Promise<GameData>} The loaded data.
   */
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
    d.charSwordItem = {};
    const items = JSON.parse(await text('scripts/items.json')).items;
    for (const k of Object.keys(d.characters)) {
      const id = parseInt(String(d.characters[k].sword).replace('id_', ''), 10);
      d.charSword[k] = items.find((i) => i.itemdefid === id)?.sword_type;
      d.charSwordItem[k] = id;
    }
    // every sword in the item catalog, by its type's script name
    d.swordItems = items.filter((i) => i.item_type === 'sword' && d.swordTypes[String(i.sword_type).toLowerCase()]).map((i) => ({
      id: i.itemdefid, name: i.name, type: String(i.sword_type).toLowerCase(), model: i.model, scabbard: i.scabbard_model ?? null, hip: i.scabbard_attach_hip === 'true', skin: parseInt(i.skin ?? '0', 10) || 0,
      swing: i.custom_swing_sound ?? null, swingVol: parseFloat(i.swing_blend_vol ?? '1'), hit: i.custom_hit_sound ?? null, hitVol: parseFloat(i.hit_blend_vol ?? '1'),
    }));
    // what a fighter can wear: the skin family, a mask, a cape, one attachment per slot. Attachments are either a
    // body group on the fighter or a model of their own. The fighters have no heads, so a mask always shows;
    // [I] the default is the mask named after the character, models/masks/default_<character>.
    const lookKinds = new Set(['skin', 'mask', 'cape', 'attachment', 'colour', 'emblem']);
    d.lookItems = items.filter((i) => lookKinds.has(i.item_type)).map((i) => ({
      id: i.itemdefid, kind: i.item_type, name: i.name, character: i.character?.toLowerCase() ?? null, slot: i.slotid?.toLowerCase() ?? null,
      model: i.item_type === 'skin' ? null : i.model ?? null, skin: parseInt(i.skin ?? '0', 10) || 0, body: i.bodygroup?.toLowerCase() ?? null, material: i.custom_material ?? null,
      icon: i.icon ?? null, colour: i.item_type === 'colour' ? i.colour ?? null : null, picker: !!i.is_picker, emblem: i.item_type === 'emblem' ? i.material ?? null : null,
    })).filter((i) => i.kind === 'skin' || i.model || i.body || i.colour || i.emblem);
    d.defaultLook = {};
    for (const k of Object.keys(d.characters)) {
      const mask = d.lookItems.find((i) => i.kind === 'mask' && i.model?.toLowerCase().includes(`/default_${k}/`));
      d.defaultLook[k] = mask ? [mask.id] : [];
    }
    // the customization screen's text, from the game's own strings
    d.charText = {};
    const english = await text('resource/basemodui_english.txt').then((t) => t.replace(/\0/g, ''), () => '');
    const say = (key) => new RegExp(`"${String(key).replace('#', '')}"\\s+"([^"]*)"`, 'i').exec(english)?.[1] ?? null;
    for (const [k, v] of Object.entries(d.characters)) d.charText[k] = say(v.description);
    // arena names, by their token in lower case
    d.arenaNames = {};
    const arenaText = await text('resource/maparena_english.txt').then((t) => t.replace(/\0/g, ''), () => '');
    for (const m of arenaText.matchAll(/"(bb_arena_\w+)"\s+"([^"]*)"/gi)) d.arenaNames[m[1].toLowerCase()] = m[2];
    // throwables, with "extends" resolved
    d.throwables = {};
    const tt = kvFind(parseKV(await text('scripts/throwabletypes.txt')), 'throwabletypes');
    for (const n of tt.value) if (Array.isArray(n.value)) d.throwables[n.key.toLowerCase()] = toObj(n.value);
    for (const k of Object.keys(d.throwables)) {
      const s = d.throwables[k];
      if (s.extends && d.throwables[s.extends.toLowerCase()]) d.throwables[k] = { ...d.throwables[s.extends.toLowerCase()], ...s };
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

  /**
   * @param {string} name Action name, any case.
   * @returns {object|undefined} The merged action script.
   */
  action(name) { return lookupCI(this.actions, name); }
  /**
   * @param {string} charKey Character key.
   * @param {number} stanceType 0 balanced, 1 fast, 2 heavy, 3 air.
   * @returns {object|null} The character's stance script.
   */
  stanceFor(charKey, stanceType) {
    const c = this.characters[charKey];
    const name = c.stances?.[STANCE_KEYS[stanceType]];
    return name ? this.stances[name.toLowerCase()] : null;
  }
  /**
   * Mirrors the stance's GetAction(direction, comboIndex): side attacks use left/right,
   * forward/back use the "forward" string.
   * So forward and back attacks walk the string; a side attack is the same one wherever you are in it.
   * @param {string} charKey Character key.
   * @param {number} stanceType 0 balanced, 1 fast, 2 heavy, 3 air.
   * @param {number} dir 0 forward, 1 right, 2 back, 3 left.
   * @param {number} comboIdx Position in the string. [R 180380d00] One at or past the end is the first action.
   * @returns {object|null} The attack's action script.
   */
  attackFor(charKey, stanceType, dir, comboIdx) {
    const s = this.stanceFor(charKey, stanceType);
    if (!s) return null;
    let name;
    if (dir === 1) name = s.right; else if (dir === 3) name = s.left;
    else {
      const f = s.forward;
      if (f) {
        const list = f['action[]'] || (f.action ? [f.action] : []);
        name = list[comboIdx < list.length ? comboIdx : 0];
      }
    }
    return name ? this.action(name) : null;
  }
  /**
   * [R 180380de0] How many actions the stance's forward string has.
   * @param {string} charKey Character key.
   * @param {number} stanceType 0 balanced, 1 fast, 2 heavy, 3 air.
   * @returns {number} The count, 0 if the stance has none.
   */
  stringLength(charKey, stanceType) {
    const f = this.stanceFor(charKey, stanceType)?.forward;
    return f ? (f['action[]'] || (f.action ? [f.action] : [])).length : 0;
  }
  /**
   * @param {string} charKey Character key, for its default sword.
   * @param {string} [type] Sword type name, lower case.
   * @returns {object} That type's script, else the character's default, else the default type.
   */
  swordFor(charKey, type) { return this.swordTypes[type] || this.swordTypes[this.charSword[charKey]] || this.swordTypes.default; }
}
