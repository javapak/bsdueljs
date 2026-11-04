// Vectors are plain arrays [x,y,z]; quaternions [x,y,z,w];
// matrices are Source matrix3x4 stored as 12 floats by rows (m[3],m[7],m[11] = translation).
export const DEG = Math.PI / 180;
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const len2d = (a) => Math.hypot(a[0], a[1]);
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const norm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
/**
 * Turns an angle toward a target by at most `speed` degrees, the short way round.
 * @param {number} target Target angle.
 * @param {number} value Current angle.
 * @param {number} speed Largest step.
 * @returns {number} The new angle.
 */
export const approachAngle = (target, value, speed) => {
  let d = angleDiff(target, value);
  if (speed < 0) speed = -speed;
  if (d > speed) d = speed; else if (d < -speed) d = -speed;
  return angleNorm(value + d);
};
/**
 * @param {number} a Angle in degrees.
 * @returns {number} The same angle in -180 to 180.
 */
export const angleNorm = (a) => { a = a % 360; if (a > 180) a -= 360; if (a < -180) a += 360; return a; };
/**
 * @param {number} a Angle in degrees.
 * @param {number} b Angle in degrees.
 * @returns {number} a - b, the short way round.
 */
export const angleDiff = (a, b) => angleNorm(a - b);

/**
 * Source AngleVectors: pitch, yaw, roll in degrees.
 * @param {number[]} ang [pitch, yaw, roll].
 * @returns {{forward: number[], right: number[], up: number[]}} Unit vectors.
 */
export function angleVectors(ang) {
  const sy = Math.sin(ang[1] * DEG), cy = Math.cos(ang[1] * DEG);
  const sp = Math.sin(ang[0] * DEG), cp = Math.cos(ang[0] * DEG);
  const sr = Math.sin((ang[2] || 0) * DEG), cr = Math.cos((ang[2] || 0) * DEG);
  return {
    forward: [cp * cy, cp * sy, -sp],
    right: [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp],
    up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  };
}

/**
 * RadianEuler -> Quaternion, per mathlib AngleQuaternion(RadianEuler).
 * @param {number} x Rotation about X, radians.
 * @param {number} y Rotation about Y, radians.
 * @param {number} z Rotation about Z, radians.
 * @returns {number[]} Quaternion [x, y, z, w].
 */
export function eulerToQuat(x, y, z) {
  const sr = Math.sin(x * 0.5), cr = Math.cos(x * 0.5);
  const sp = Math.sin(y * 0.5), cp = Math.cos(y * 0.5);
  const sy = Math.sin(z * 0.5), cy = Math.cos(z * 0.5);
  const srXcp = sr * cp, crXsp = cr * sp, crXcp = cr * cp, srXsp = sr * sp;
  return [srXcp * cy - crXsp * sy, crXsp * cy + srXcp * sy, crXcp * sy - srXsp * cy, crXcp * cy + srXsp * sy];
}

/**
 * Spherical blend between two rotations, taking the short way.
 * @param {number[]} p From.
 * @param {number[]} q To.
 * @param {number} t Blend, 0 to 1.
 * @returns {number[]} The normalized result.
 */
export function quatSlerp(p, q, t) {
  // QuaternionAlign then slerp without invert, per mathlib
  let d = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  let a, b;
  if (d > 0.9995) { a = 1 - t; b = t; } else {
    const o = Math.acos(d), so = Math.sin(o);
    a = Math.sin((1 - t) * o) / so; b = Math.sin(t * o) / so;
  }
  const r = [a * p[0] + b * s * q[0], a * p[1] + b * s * q[1], a * p[2] + b * s * q[2], a * p[3] + b * s * q[3]];
  const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
}

/**
 * @param {number[]} q Rotation.
 * @param {number[]} pos Translation.
 * @returns {number[]} 3x4 matrix.
 */
export function quatMatrix(q, pos) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y, pos[0],
    2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x, pos[1],
    2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y, pos[2],
  ];
}

/**
 * @param {number[]} a 3x4 matrix.
 * @param {number[]} b 3x4 matrix.
 * @returns {number[]} a * b: b's transform first, then a's.
 */
export function matMul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[4] + a[2] * b[8], a[0] * b[1] + a[1] * b[5] + a[2] * b[9], a[0] * b[2] + a[1] * b[6] + a[2] * b[10], a[0] * b[3] + a[1] * b[7] + a[2] * b[11] + a[3],
    a[4] * b[0] + a[5] * b[4] + a[6] * b[8], a[4] * b[1] + a[5] * b[5] + a[6] * b[9], a[4] * b[2] + a[5] * b[6] + a[6] * b[10], a[4] * b[3] + a[5] * b[7] + a[6] * b[11] + a[7],
    a[8] * b[0] + a[9] * b[4] + a[10] * b[8], a[8] * b[1] + a[9] * b[5] + a[10] * b[9], a[8] * b[2] + a[9] * b[6] + a[10] * b[10], a[8] * b[3] + a[9] * b[7] + a[10] * b[11] + a[11],
  ];
}

/**
 * Inverse of a matrix with no scale: faster than a general inverse.
 * @param {number[]} m 3x4 rotation and translation.
 * @returns {number[]} The inverse.
 */
export function rigidInverse(m) {
  return [m[0], m[4], m[8], -(m[0] * m[3] + m[4] * m[7] + m[8] * m[11]), m[1], m[5], m[9], -(m[1] * m[3] + m[5] * m[7] + m[9] * m[11]), m[2], m[6], m[10], -(m[2] * m[3] + m[6] * m[7] + m[10] * m[11])];
}

/**
 * @param {number[]} m 3x4 matrix.
 * @param {number[]} p Point.
 * @returns {number[]} The transformed point.
 */
export const matPoint = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/**
 * A Source entity's transform. Note the negated right vector: model +Y is the entity's left.
 * @param {number[]} origin Position.
 * @param {number[]} angles [pitch, yaw, roll].
 * @returns {number[]} 3x4 matrix.
 */
export function entityMatrix(origin, angles) {
  const { forward: f, right: r, up: u } = angleVectors(angles);
  return [f[0], -r[0], u[0], origin[0], f[1], -r[1], u[1], origin[1], f[2], -r[2], u[2], origin[2]];
}

/**
 * @param {number[]} m 3x4 rigid matrix.
 * @param {number[]} p World point.
 * @returns {number[]} The point in m's space.
 */
export function worldToLocal(m, p) {
  const dx = p[0] - m[3], dy = p[1] - m[7], dz = p[2] - m[11];
  return [m[0] * dx + m[4] * dy + m[8] * dz, m[1] * dx + m[5] * dy + m[9] * dz, m[2] * dx + m[6] * dy + m[10] * dz];
}
