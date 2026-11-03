// Character model assembly over an abstract file reader (Node or browser).
import { Model, Character } from './mdl.js';
export class CharacterStore {
  constructor(readBin, data) { this.readBin = readBin; this.data = data; this.cache = new Map(); this.models = new Map(); }
  async _model(path) {
    let m = this.models.get(path);
    if (!m) { m = new Model(await this.readBin(path), path); this.models.set(path, m); }
    return m;
  }
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
  character(key) { return this.cache.get(key); }
}
