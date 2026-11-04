// Character model assembly over an abstract file reader (Node or browser).
import { Model, Character } from './mdl.js';
/**
 * Loads and caches character models with the animation models they include.
 */
export class CharacterStore {
  /**
   * @param {function(string): Promise<Uint8Array>} readBin Reads a game file by path.
   * @param {GameData} data Loaded game data.
   */
  constructor(readBin, data) { this.readBin = readBin; this.data = data; this.cache = new Map(); this.models = new Map(); }
  /**
   * @param {string} path Model path.
   * @returns {Promise<Model>} The cached or newly parsed model.
   */
  async _model(path) {
    let m = this.models.get(path);
    if (!m) { m = new Model(await this.readBin(path), path); this.models.set(path, m); }
    return m;
  }
  /**
   * Builds a character from characters.txt: its model, and the include models holding its animations, two levels deep.
   * @param {string} key Character key, such as 'knight'.
   * @returns {Promise<Character>} The assembled character.
   */
  async preload(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const path = this.data.characters[key].model.replace(/\\/g, '/');
    const root = await this._model(path);
    const inc = [];
    for (const i of root.includes) {
      const m = await this._model(i.replace(/\\/g, '/'));
      inc.push(m);
      for (const j of m.includes) inc.push(await this._model(j.replace(/\\/g, '/')));
    }
    const c = new Character(root, inc);
    this.cache.set(key, c);
    return c;
  }
  /**
   * @param {string} key Character key.
   * @returns {Character|undefined} The character, if preloaded.
   */
  character(key) { return this.cache.get(key); }
}
