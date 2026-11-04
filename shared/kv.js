/**
 * Valve KeyValues text parser. Duplicate keys are preserved: every node is
 * { key, value } where value is a string or an array of child nodes.
 * Handles quoted and bare tokens, // comments, a BOM, stray blocks, and [$WIN32]-style tags after a value (dropped, not evaluated).
 * @param {string} text File contents.
 * @returns {Array<{key: string, value: string|Array}>} The top level nodes.
 */
export function parseKV(text) {
  let i = 0;
  const n = text.length;
  function skip() {
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (text.charCodeAt(i) === 0xfeff) {
        i++;
      } else return;
    }
  }
  function token() {
    skip();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return { p: c }; }
    if (c === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) i++;
        s += text[i++];
      }
      i++;
      return { s };
    }
    const b = i;
    while (i < n && text.charCodeAt(i) > 32 && text[i] !== '{' && text[i] !== '}' && text[i] !== '"') i++;
    return { s: text.slice(b, i) };
  }
  function block(top) {
    const out = [];
    for (;;) {
      const k = token();
      if (!k) { return out; }
      if (k.p === '}') { if (top) continue; return out; }
      if (k.p === '{') { out.push(...block(false)); continue; } // stray block
      const save = i;
      let v = token();
      if (!v) return out;
      if (v.p === '{') { out.push({ key: k.s, value: block(false) }); continue; }
      if (v.p === '}') { i = save; out.push({ key: k.s, value: '' }); continue; }
      // conditional tag such as [$WIN32] after a value
      const s2 = i; const t = token();
      if (!(t && t.s && t.s[0] === '[')) i = s2;
      out.push({ key: k.s, value: v.s });
    }
  }
  return block(true);
}

/**
 * Case-insensitive helpers (KeyValues lookups are case-insensitive in the engine).
 * @param {Array} nodes Nodes to search.
 * @param {string} key Key, any case.
 * @returns {{key: string, value: *}|undefined} The first match.
 */
export const kvFind = (nodes, key) => {
  if (!Array.isArray(nodes)) return undefined;
  const k = key.toLowerCase();
  return nodes.find((x) => x.key.toLowerCase() === k);
};
/**
 * @param {Array} nodes Nodes to search.
 * @param {string} key Key, any case.
 * @param {*} [def] Returned if the key is missing.
 * @returns {string|Array|*} The value.
 */
export const kvGet = (nodes, key, def) => {
  const f = kvFind(nodes, key);
  return f === undefined ? def : f.value;
};
/**
 * @param {Array} nodes Nodes to search.
 * @param {string} key Key, any case.
 * @param {number} [def] Returned if missing, a block, empty or not a number.
 * @returns {number} The value.
 */
export const kvNum = (nodes, key, def) => {
  const v = kvGet(nodes, key);
  if (v === undefined || Array.isArray(v) || v === '') return def;
  const f = parseFloat(v);
  return Number.isNaN(f) ? def : f;
};
/**
 * Every node with this key, since KeyValues allows repeats.
 * @param {Array} nodes Nodes to search.
 * @param {string} key Key, any case.
 * @returns {Array} The matches.
 */
export const kvAll = (nodes, key) => {
  const k = key.toLowerCase();
  return Array.isArray(nodes) ? nodes.filter((x) => x.key.toLowerCase() === k) : [];
};
/**
 * @param {Array} nodes Nodes to search.
 * @param {string} key Key, any case.
 * @param {boolean} [def] Returned if missing.
 * @returns {boolean} true or false as words, otherwise whether the number is non-zero.
 */
export const kvBool = (nodes, key, def) => {
  const v = kvGet(nodes, key);
  if (v === undefined) return def;
  const s = String(v).toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return parseFloat(s) !== 0;
};
