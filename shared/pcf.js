// Particle files (.pcf): DMX in its keyvalues2 text encoding. An element is
//   "DmeType" { "id" "elementid" "uuid"  "name" "string" "x"  "attr" "type" "value"  "list" "element_array" [ ... ] }
// and may be nested inline or referenced by id ("element" "uuid").
const TOK = /"((?:[^"\\]|\\.)*)"|([{}\[\],])|\/\/[^\n]*/g;

function tokens(text) {
  const out = [];
  TOK.lastIndex = text.startsWith('<!--') ? text.indexOf('-->') + 3 : 0;
  for (let m; (m = TOK.exec(text));) { if (m[1] !== undefined) out.push({ s: m[1] }); else if (m[2]) out.push(m[2]); }
  return out;
}

function convert(type, v) {
  switch (type) {
    case 'float': case 'time': return parseFloat(v);
    case 'int': return parseInt(v, 10);
    case 'bool': return v === '1' || v === 'true';
    case 'vector2': case 'vector3': case 'vector4': case 'quaternion': case 'qangle': case 'color': return v.trim().split(/\s+/).map(Number);
    default: return v;
  }
}

/**
 * @param {string} text .pcf contents.
 * @returns {{roots: object[], systems: Map<string, object>}} Top level elements, and particle systems by name.
 */
export function parsePCF(text) {
  const t = tokens(text);
  let i = 0;
  const byId = new Map();
  const roots = [];
  const element = (type) => {
    const e = { _type: type };
    i++; // {
    while (t[i] !== '}') {
      const key = t[i++].s, tk = t[i++];
      if (tk === undefined) throw new Error('pcf: truncated');
      const ty = tk.s;
      if (t[i] === '{') { e[key] = element(ty); continue; } // inline element, no declared attr type
      if (ty.endsWith('_array')) {
        const arr = [];
        i++; // [
        while (t[i] !== ']') {
          if (t[i] === ',') { i++; continue; }
          if (ty === 'element_array') {
            const a = t[i++].s;
            if (a === 'element') arr.push({ _ref: t[i++].s });
            else if (t[i] === '{') arr.push(element(a));
          } else arr.push(convert(ty.slice(0, -6), t[i++].s));
        }
        i++; // ]
        e[key] = arr;
        continue;
      }
      const v = t[i++].s;
      if (key === 'id' && ty === 'elementid') { e._id = v; byId.set(v, e); continue; }
      e[key] = ty === 'element' ? (v ? { _ref: v } : null) : convert(ty, v);
    }
    i++; // }
    return e;
  };
  while (i < t.length) { const ty = t[i++].s; if (t[i] === '{') roots.push(element(ty)); }
  // resolve references
  const seen = new Set();
  const walk = (e) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return;
    seen.add(e);
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (Array.isArray(v)) { v.forEach((x, n) => { if (x?._ref) v[n] = byId.get(x._ref) ?? null; else walk(x); }); } else if (v?._ref) { e[k] = byId.get(v._ref) ?? null; walk(e[k]); } else walk(v);
    }
  };
  roots.forEach(walk);
  const systems = new Map();
  for (const e of byId.values()) if (e._type === 'DmeParticleSystemDefinition') systems.set(e.name, e);
  return { roots, systems };
}
