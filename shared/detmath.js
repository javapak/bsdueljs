// Math that gives the same bits in every JS engine, for anything the simulation computes. Rollback needs both peers to agree
// exactly, and the spec leaves Math.sin and friends up to the engine: V8 and Firefox disagree on sin, cos, tan, pow and hypot.
// These use only + - * / and Math.sqrt, which IEEE 754 does define, plus reading a double's bits. They're ports of fdlibm's
// routines (Sun Microsystems, 1993: free to use, copy, modify and distribute, provided this notice is kept) to within 1-2 units
// in the last place of the engine's own. Math.abs, floor, trunc, min, max, sign, fround and sqrt are exact already, so stay as they are.
const buf = new Float64Array(1), words = new Int32Array(buf.buffer);
const LOW = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0 : 1, HIGH = 1 - LOW;
const high = (x) => { buf[0] = x; return words[HIGH]; };
const low = (x) => { buf[0] = x; return words[LOW]; };
const withLow0 = (x) => { buf[0] = x; words[LOW] = 0; return buf[0]; };
const withHigh = (x, h) => { buf[0] = x; words[HIGH] = h; return buf[0]; };
const make = (h, l) => { words[HIGH] = h; words[LOW] = l; return buf[0]; };

const TWO54 = 1.80143985094819840000e+16, HUGE = 1e300, TINY = 1e-300;

// ------------------------------------------------------------------ sin, cos, tan
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
function kSin(x, y, iy) {
  const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
function kCos(x, y) {
  const ix = high(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return 1;
  const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3FD33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : make(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx, a = 1 - qx;
  return a - (hz - (z * r - x * y));
}
const T = [3.33333333333334091986e-01, 1.33333333333201242699e-01, 5.39682539762260521377e-02, 2.18694882948595424599e-02,
  8.86323982359930005737e-03, 3.59207910759131235356e-03, 1.45620945432529025516e-03, 5.88041240820264096874e-04,
  2.46463134818469906812e-04, 7.81794442939557092300e-05, 7.14072491382608190305e-05, -1.85586374855275456654e-05, 2.59073051863633712884e-05];
const PIO4 = 7.85398163397448278999e-01, PIO4LO = 3.06161699786838301793e-17;
function kTan(x, y, iy) {
  const hx = high(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3FE59428) {
    if (hx < 0) { x = -x; y = -y; }
    const z = PIO4 - x, w = PIO4LO - y;
    x = z + w; y = 0;
  }
  const z = x * x, w = z * z;
  let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  const v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  const s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  const sum = x + r;
  if (ix >= 0x3FE59428) {
    const sign = iy;
    return (1 - ((hx >> 30) & 2)) * (sign - 2 * (x - (sum * sum / (sum + sign) - r)));
  }
  if (iy === 1) return sum;
  // -1 / (x + r), kept accurate
  const z2 = withLow0(sum), v2 = r - (z2 - x), a = -1 / sum, t = withLow0(a), s2 = 1 + t * z2;
  return t + a * (s2 + t * v2);
}
const INVPIO2 = 6.36619772367581382433e-01, PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11,
  PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21,
  PIO2_3T = 8.47842766036889956997e-32;
const rem = [0, 0];
// x reduced to [-pi/4, pi/4], as rem[0] + rem[1]; returns the quadrant. fdlibm's medium path, which holds to about 2^20 * pi/2.
// Anything past that isn't an angle the sim makes; it stays the same on every engine and only loses accuracy.
function remPio2(x) {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) { rem[0] = x; rem[1] = 0; return 0; }
  if (ix < 0x4002d97c) {
    const sign = x > 0 ? 1 : -1;
    let z = x - sign * PIO2_1;
    if (ix !== 0x3ff921fb) { rem[0] = z - sign * PIO2_1T; rem[1] = (z - rem[0]) - sign * PIO2_1T; }
    else { z -= sign * PIO2_2; rem[0] = z - sign * PIO2_2T; rem[1] = (z - rem[0]) - sign * PIO2_2T; }
    return sign;
  }
  const t = Math.abs(x), n = Math.trunc(t * INVPIO2 + 0.5), fn = n;
  let r = t - fn * PIO2_1, w = fn * PIO2_1T, y0 = r - w;
  const iHigh = ix >> 20, e = iHigh - ((high(y0) >> 20) & 0x7ff);
  if (e > 16) {
    let tt = r;
    w = fn * PIO2_2; r = tt - w; w = fn * PIO2_2T - ((tt - r) - w); y0 = r - w;
    if (iHigh - ((high(y0) >> 20) & 0x7ff) > 49) {
      tt = r;
      w = fn * PIO2_3; r = tt - w; w = fn * PIO2_3T - ((tt - r) - w); y0 = r - w;
    }
  }
  const y1 = (r - y0) - w;
  if (x < 0) { rem[0] = -y0; rem[1] = -y1; return -n; }
  rem[0] = y0; rem[1] = y1;
  return n;
}
/** @param {number} x Radians. @returns {number} The sine. */
export function sin(x) {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e400000 ? x : kSin(x, 0, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x) & 3;
  if (n === 0) return kSin(rem[0], rem[1], 1);
  if (n === 1) return kCos(rem[0], rem[1]);
  if (n === 2) return -kSin(rem[0], rem[1], 1);
  return -kCos(rem[0], rem[1]);
}
/** @param {number} x Radians. @returns {number} The cosine. */
export function cos(x) {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kCos(x, 0);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x) & 3;
  if (n === 0) return kCos(rem[0], rem[1]);
  if (n === 1) return -kSin(rem[0], rem[1], 1);
  if (n === 2) return -kCos(rem[0], rem[1]);
  return kSin(rem[0], rem[1], 1);
}
/** @param {number} x Radians. @returns {number} The tangent. */
export function tan(x) {
  const ix = high(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return ix < 0x3e300000 ? x : kTan(x, 0, 1);
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x);
  return kTan(rem[0], rem[1], 1 - ((n & 1) << 1));
}

// ------------------------------------------------------------------ atan, atan2, asin, acos
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
/** @param {number} x The value. @returns {number} The arctangent in radians. */
export function atan(x) {
  const hx = high(x), ix = hx & 0x7fffffff;
  if (ix >= 0x44100000) {
    if (x !== x) return NaN;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  let id;
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) { id = 0; x = (2 * x - 1) / (2 + x); } else { id = 1; x = (x - 1) / (x + 1); }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); } else { id = 3; x = -1 / x; }
  }
  const z = x * x, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return hx < 0 ? -r : r;
}
const PI = 3.1415926535897931160E+00, PI_LO = 1.2246467991473531772E-16;
/** @param {number} y Vertical. @param {number} x Horizontal. @returns {number} The angle in radians, as Math.atan2 means it. */
export function atan2(y, x) {
  if (x !== x || y !== y) return NaN;
  const hx = high(x), lx = low(x), ix = hx & 0x7fffffff, hy = high(y), ly = low(y), iy = hy & 0x7fffffff;
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y);
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
  if ((iy | ly) === 0) return m < 2 ? y : m === 2 ? PI + TINY : -PI - TINY;
  if ((ix | lx) === 0) return hy < 0 ? -ATANHI[3] - TINY : ATANHI[3] + TINY;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) return [PIO4 + TINY, -PIO4 - TINY, 3 * PIO4 + TINY, -3 * PIO4 - TINY][m];
    return [0, -0, PI + TINY, -PI - TINY][m];
  }
  if (iy === 0x7ff00000) return hy < 0 ? -ATANHI[3] - TINY : ATANHI[3] + TINY;
  const k = (iy - ix) >> 20;
  let z;
  if (k > 60) z = ATANHI[3] + 0.5 * PI_LO;
  else if (hx < 0 && k < -60) z = 0;
  else z = atan(Math.abs(y / x));
  if (m === 0) return z;
  if (m === 1) return withHigh(z, high(z) ^ 0x80000000);
  if (m === 2) return PI - (z - PI_LO);
  return (z - PI_LO) - PI;
}
const PS = [1.66666666666666657415e-01, -3.25565818622400915405e-01, 2.01212532134862925881e-01, -4.00555345006794114027e-02,
  7.91534994289814532176e-04, 3.47933107596021167570e-05];
const QS = [-2.40339491173441421878e+00, 2.02094576023350569471e+00, -6.88283971605453293030e-01, 7.70381505559019352791e-02];
const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17, PIO4_HI = 7.85398163397448278999e-01;
const rPQ = (t) => (t * (PS[0] + t * (PS[1] + t * (PS[2] + t * (PS[3] + t * (PS[4] + t * PS[5])))))) / (1 + t * (QS[0] + t * (QS[1] + t * (QS[2] + t * QS[3]))));
/** @param {number} x From -1 to 1. @returns {number} The arcsine in radians. */
export function asin(x) {
  const hx = high(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | low(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix < 0x3e400000) return x;
    return x + x * rPQ(x * x);
  }
  const t = (1 - Math.abs(x)) * 0.5, w = rPQ(t), s = Math.sqrt(t);
  let r;
  if (ix >= 0x3FEF3333) r = PIO2_HI - (2 * (s + s * w) - PIO2_LO);
  else {
    const f = withLow0(s), c = (t - f * f) / (s + f), p = 2 * s * w - (PIO2_LO - 2 * c), q = PIO4_HI - 2 * f;
    r = PIO4_HI - (p - q);
  }
  return hx > 0 ? r : -r;
}
/** @param {number} x From -1 to 1. @returns {number} The arccosine in radians. */
export function acos(x) {
  const hx = high(x), ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | low(x)) === 0) return hx > 0 ? 0 : PI + 2 * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
    return PIO2_HI - (x - (PIO2_LO - x * rPQ(x * x)));
  }
  if (hx < 0) {
    const z = (1 + x) * 0.5, s = Math.sqrt(z), w = rPQ(z) * s - PIO2_LO;
    return PI - 2 * (s + w);
  }
  const z = (1 - x) * 0.5, s = Math.sqrt(z), df = withLow0(s), c = (z - df * df) / (s + df), w = rPQ(z) * s + c;
  return 2 * (df + w);
}

// ------------------------------------------------------------------ exp, log, pow
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
  P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
/** Multiplies by a power of two, correct down into the subnormals. */
function scalb(x, n) {
  while (n > 1000) { x *= 2 ** 1000; n -= 1000; }
  while (n < -1000) { x *= 2 ** -1000; n += 1000; }
  return x * pow2(n);
}
// 2^n as bits, where the exponent fits; the small end goes in two steps
function pow2(n) {
  if (n >= -1022 && n <= 1023) return make((n + 1023) << 20, 0);
  return n < -1022 ? make(1, 0) * pow2(n + 1022) : Infinity;
}
/** @param {number} x The power. @returns {number} e^x. */
export function exp(x) {
  if (x !== x) return NaN;
  if (x > 7.09782712893383973096e+02) return Infinity;
  if (x < -7.45133219101941108420e+02) return 0;
  const hx = high(x), ix = hx & 0x7fffffff, xsb = (hx >> 31) & 1;
  let hi = 0, lo = 0, k = 0;
  if (ix > 0x3fd62e42) {
    if (ix < 0x3FF0A2B2) { hi = x - (xsb ? -LN2_HI : LN2_HI); lo = xsb ? -LN2_LO : LN2_LO; k = 1 - xsb - xsb; }
    else { k = Math.trunc(INVLN2 * x + (xsb ? -0.5 : 0.5)); hi = x - k * LN2_HI; lo = k * LN2_LO; }
    x = hi - lo;
  } else if (ix < 0x3e300000) return 1 + x;
  const t = x * x, c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  return scalb(1 - ((lo - (x * c) / (2 - c)) - hi), k);
}
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01, LG4 = 2.222219843214978396e-01,
  LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;
/** @param {number} x The value. @returns {number} The natural logarithm. */
export function log(x) {
  let hx = high(x), lx = low(x), k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54; x *= TWO54; hx = high(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = withHigh(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2 + f), z = s * s, ii = hx - 0x6147a, w = z * z, jj = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6)), t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  if ((ii | jj) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : k * LN2_HI - ((s * (f - R) - k * LN2_LO) - f);
}
const BP = [1, 1.5], DP_H = [0, 5.84962487220764160156e-01], DP_L = [0, 1.35003920212974897128e-08];
const L1 = 5.99999999999994648725e-01, L2 = 4.28571428578550184252e-01, L3 = 3.33333329818377432918e-01, L4 = 2.72728123808534006489e-01,
  L5 = 2.30660745775561754067e-01, L6 = 2.06975017800338417784e-01, LG2_ = 6.93147180559945286227e-01,
  LG2_H = 6.93147182464599609375e-01, LG2_L = -1.90465429995776804525e-09, OVT = 8.0085662595372944372e-0017,
  CP = 9.61796693925975554329e-01, CP_H = 9.61796700954437255859e-01, CP_L = -7.02846165095275826516e-09,
  IVLN2 = 1.44269504088896338700e+00, IVLN2_H = 1.44269502162933349609e+00, IVLN2_L = 1.92596299112661746887e-08;
/** @param {number} x The base. @param {number} y The power. @returns {number} x^y, with Math.pow's rules for the special cases. */
export function pow(x, y) {
  if (y === 0) return 1;
  if (x !== x || y !== y) return NaN;
  const ax0 = Math.abs(x);
  if (y === Infinity || y === -Infinity) { if (ax0 === 1) return NaN; return (ax0 > 1) === (y > 0) ? Infinity : 0; }
  if (y === 1) return x;
  if (y === 2) return x * x;
  if (y === -1) return 1 / x;
  const hx = high(x), lx = low(x), hy = high(y), ly = low(y), ix = hx & 0x7fffffff, iy = hy & 0x7fffffff;
  if (ly === 0 && hy === 0x3fe00000 && hx >= 0 && ix < 0x7ff00000) return Math.sqrt(x);
  // yisint: 0 not an integer, 1 odd, 2 even
  let yisint = 0;
  if (Number.isInteger(y)) yisint = Math.abs(y) >= 2 ** 53 || y % 2 === 0 ? 2 : 1;
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    let z = ax0;
    if (hy < 0) z = 1 / z;
    if (hx < 0) { if (((ix - 0x3ff00000) | yisint) === 0) z = NaN; else if (yisint === 1) z = -z; }
    return z;
  }
  if (hx < 0 && yisint === 0) return NaN;
  const s = hx < 0 && yisint === 1 ? -1 : 1;
  let t1, t2;
  if (iy > 0x41e00000) {
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? Infinity : 0;
      if (ix >= 0x3ff00000) return hy > 0 ? Infinity : 0;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    const t = ax0 - 1, w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = IVLN2_H * t, v = t * IVLN2_L - w * IVLN2;
    t1 = withLow0(u + v);
    t2 = v - (t1 - u);
  } else {
    let n = 0, jx = ix, ax = ax0;
    if (jx < 0x00100000) { ax *= TWO54; n -= 53; jx = high(ax); }
    n += (jx >> 20) - 0x3ff;
    const j = jx & 0x000fffff;
    jx = j | 0x3ff00000;
    let k;
    if (j <= 0x3988E) k = 0;
    else if (j < 0xBB67A) k = 1;
    else { k = 0; n += 1; jx -= 0x00100000; }
    ax = withHigh(ax, jx);
    const u = ax - BP[k], v = 1 / (ax + BP[k]), ss = u * v, sh = withLow0(ss);
    const th = make(((jx >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    const tl = ax - (th - BP[k]), sl = v * ((u - sh * th) - sh * tl);
    let s2 = ss * ss, r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sl * (sh + ss);
    s2 = sh * sh;
    const th2 = withLow0(3 + s2 + r), tl2 = r - ((th2 - 3) - s2);
    const u2 = sh * th2, v2 = sl * th2 + tl2 * ss;
    const ph = withLow0(u2 + v2), pl = v2 - (ph - u2);
    const zh = CP_H * ph, zl = CP_L * ph + pl * CP + DP_L[k], tn = n;
    t1 = withLow0(((zh + zl) + DP_H[k]) + tn);
    t2 = zl - (((t1 - tn) - DP_H[k]) - zh);
  }
  const y1 = withLow0(y), pl0 = (y - y1) * t1 + y * t2, ph0 = y1 * t1;
  let pl = pl0;
  const z0 = pl + ph0, j = high(z0), i0 = low(z0);
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i0) !== 0) return s * HUGE * HUGE;
    if (pl + OVT > z0 - ph0) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    if (((j - 0xc090cc00) | i0) !== 0) return s * TINY * TINY;
    if (pl <= z0 - ph0) return s * TINY * TINY;
  }
  let ph = ph0, n = 0;
  const i = j & 0x7fffffff;
  let e = (i >> 20) - 0x3ff;
  if (i > 0x3fe00000) {
    n = j + (0x00100000 >> (e + 1));
    e = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = make(n & ~(0x000fffff >> e), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - e);
    if (j < 0) n = -n;
    ph -= t;
  }
  const t = withLow0(pl + ph), u = t * LG2_H, v = (pl - (t - ph)) * LG2_ + t * LG2_L;
  let z = u + v;
  const w = v - (z - u), tt = z * z;
  t1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * t1) / (t1 - 2) - (w + z * w);
  z = 1 - (r - z);
  const jz = high(z) + (n << 20);
  z = (jz >> 20) <= 0 ? scalb(z, n) : withHigh(z, jz);
  return s * z;
}
/**
 * Plain square root of the sum of squares: the sim's lengths never come near overflowing, which is all Math.hypot adds.
 * @param {number} a A component.
 * @param {number} b Another.
 * @param {number} [c] A third, as in a vector.
 * @param {number} [d] A fourth, as in a quaternion.
 * @returns {number} The length.
 */
export function hypot(a, b, c = 0, d = 0) { return Math.sqrt(a * a + b * b + c * c + d * d); }
