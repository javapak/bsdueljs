// Static prop collision: the convex pieces in a model's .phy (Havok/IVP compact surfaces), turned into plane lists.
const IVP_TO_SOURCE = 1 / 0.0254;

/**
 * .phy -> convex pieces, each a list of model-space points and its triangles (indices into them)
 * @param {Uint8Array} bytes .phy contents.
 * @returns {Array<{points: number[][], triangles: number[][]}>} The pieces.
 */
export function parseConvexPieces(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = dv.getInt32(0, true);
  const count = dv.getInt32(8, true), pieces = [];
  const tag = (at) => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
  for (let s = 0; s < count && o + 4 <= bytes.length; s++) {
    const size = dv.getInt32(o, true), start = o + 4;
    o = start + size;
    const surface = tag(start) === 'VPHY' ? start + 28 : start;
    if (surface + 48 > bytes.length || tag(surface + 44) !== 'IVPS') continue;
    const walk = (node) => {
      const right = dv.getInt32(node, true);
      if (right === 0) { readLedge(node + dv.getInt32(node + 4, true)); return; }
      walk(node + 28);
      walk(node + right);
    };
    const readLedge = (ledge) => {
      const pointsAt = ledge + dv.getInt32(ledge, true), tris = dv.getInt16(ledge + 12, true);
      const remap = new Map(), points = [], triangles = [];
      const index = (i) => {
        if (!remap.has(i)) {
          const q = pointsAt + i * 16;
          // [IVP x, y, z] is [x, z, -y] in Source, in metres
          points.push([dv.getFloat32(q, true) * IVP_TO_SOURCE, dv.getFloat32(q + 8, true) * IVP_TO_SOURCE, -dv.getFloat32(q + 4, true) * IVP_TO_SOURCE]);
          remap.set(i, points.length - 1);
        }
        return remap.get(i);
      };
      for (let t = 0; t < tris; t++) {
        const at = ledge + 16 + t * 16;
        triangles.push([index(dv.getUint16(at + 4, true)), index(dv.getUint16(at + 8, true)), index(dv.getUint16(at + 12, true))]);
      }
      if (triangles.length) pieces.push({ points, triangles });
    };
    walk(surface + dv.getInt32(surface + 32, true));
  }
  return pieces;
}

/**
 * 3x4 rows from a prop's origin and angles
 * @param {number[]} o Origin.
 * @param {number[]} a [pitch, yaw, roll].
 * @returns {number[]} 3x4 matrix.
 */
export function propMatrix(o, a) {
  const D = Math.PI / 180;
  const sy = Math.sin(a[1] * D), cy = Math.cos(a[1] * D), sp = Math.sin(a[0] * D), cp = Math.cos(a[0] * D), sr = Math.sin(a[2] * D), cr = Math.cos(a[2] * D);
  return [cp * cy, sp * sr * cy - cr * sy, sp * cr * cy + sr * sy, o[0], cp * sy, sp * sr * sy + cr * cy, sp * cr * sy - sr * cy, o[1], -sp, sr * cp, cr * cp, o[2]];
}

/**
 * A piece placed in the world: its faces as outward planes, plus axial planes so a box can't slip past a sharp corner
 * @param {{points: number[][], triangles: number[][]}} piece From parseConvexPieces.
 * @param {number[]} m From propMatrix.
 * @returns {{planes: Array, mn: number[], mx: number[]}} Its planes and bounds.
 */
export function placePiece(piece, m) {
  const pts = piece.points.map((p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]]);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], mid = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); mid[k] += p[k] / pts.length; }
  const planes = [], seen = new Set();
  const add = (n, d, bevel) => {
    const key = `${Math.round(n[0] * 1000)},${Math.round(n[1] * 1000)},${Math.round(n[2] * 1000)},${Math.round(d * 10)}`;
    if (!seen.has(key)) { seen.add(key); planes.push({ n, d, bevel }); }
  };
  for (const [ia, ib, ic] of piece.triangles) {
    const a = pts[ia], b = pts[ib], c = pts[ic];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-6) continue;
    n = [n[0] / l, n[1] / l, n[2] / l];
    let d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    // the winding isn't trusted: outward is away from the piece's middle
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] > d) { n = [-n[0], -n[1], -n[2]]; d = -d; }
    add(n, d, false);
  }
  for (let k = 0; k < 3; k++) {
    const pos = [0, 0, 0], neg = [0, 0, 0];
    pos[k] = 1; neg[k] = -1;
    add(pos, mx[k], true);
    add(neg, -mn[k], true);
  }
  return { planes, mn, mx };
}
