// Auto exposure: mat_tonemap_algorithm 1, from client.dll. A histogram of the tonemapped frame's linear luminance sets a target
// scale, and the current scale eases toward it. Bloom isn't part of this.
const BUCKETS = 16;
const edge = (i) => Math.pow(i / BUCKETS, 2.5); // [R 18025f301]
const PERCENT_TARGET = 60, PERCENT_BRIGHT = 2, MIN_AVG_LUM = 3; // [R 180257b0a] with no controller overriding them
const ACCEL_DOWN = 40; // mat_accelerate_adjust_exposure_down

/**
 * Map entities address the controller by name: "OnMapSpawn" "tmc<ESC>SetAutoExposureMax<ESC>1.25<ESC>0<ESC>-1"
 * @param {string} entityText The map's entity lump.
 * @param {string[]} controllers Names of its env_tonemap_controller entities.
 * @returns {object} min, max, rate, bloomScale, percentTarget, percentBright, minAvgLum.
 */
export function tonemapSettings(entityText, controllers) {
  const out = { min: 0.5, max: 2, rate: 1, bloomScale: 1, percentTarget: PERCENT_TARGET, percentBright: PERCENT_BRIGHT, minAvgLum: MIN_AVG_LUM };
  const names = new Set(controllers);
  const keys = { setautoexposuremin: 'min', setautoexposuremax: 'max', settonemaprate: 'rate', setbloomscale: 'bloomScale', settonemappercenttarget: 'percentTarget', settonemappercentbrightpixels: 'percentBright', settonemapminavglum: 'minAvgLum' };
  for (const m of entityText.matchAll(/"OnMapSpawn"\s+"([^"]*)"/g)) {
    const [target, input, value] = m[1].split(/[\x1b,]/);
    const key = keys[input?.toLowerCase()];
    if (key && names.has(target)) out[key] = parseFloat(value);
  }
  return out;
}

/**
 * [R 18025d750] Walking down from the brightest bucket, where the brightest `percent` of pixels begins
 * @param {Int32Array} counts Pixels per bucket.
 * @param {number} total All pixels.
 * @param {number} percent The percent wanted.
 * @param {number} target Target percent, or -1 for none.
 * @returns {number} Luminance, or -1.
 */
export function findPercentBright(counts, total, percent, target) {
  if (!total) return -1;
  let seen = 0, span = 0;
  for (let i = BUCKETS - 1; i >= 0; i--) {
    const share = counts[i] / total, need = percent * 0.01 - seen, lo = edge(i), hi = edge(i + 1), width = hi - lo;
    if (share >= need) {
      if (target >= 0) { const t = target * 0.01; if (t >= lo && t <= hi) return t; }
      return Math.max(lo, Math.min(hi, 1 - (need / share * width + span)));
    }
    seen += share;
    span += width;
  }
  return -1;
}

/**
 * The exposure the frame is drawn with, eased toward what the histogram asks for.
 */
export class Exposure {
  constructor() { this.configure({ min: 0.5, max: 2, rate: 1, percentTarget: PERCENT_TARGET, percentBright: PERCENT_BRIGHT, minAvgLum: MIN_AVG_LUM }); }

  /**
   * [R 18025ec70] starts midway between the limits, between 1 and 10
   * @param {object} settings From tonemapSettings.
   */
  configure(settings) {
    Object.assign(this, settings);
    this.scale = Math.max(1, Math.min(10, (Math.max(this.min, this.max) + this.min) / 2));
    this.target = this.scale;
    this.history = [];
  }

  /**
   * [R 180257af0] pixels: Float32Array of linear luminance from the current frame, already scaled by this.scale
   * @param {Float32Array} lums Luminance samples.
   * @returns {number} The new target scale.
   */
  measure(lums) {
    const counts = new Int32Array(BUCKETS);
    for (const l of lums) {
      let i = 0;
      while (i < BUCKETS - 1 && l >= edge(i + 1)) i++;
      counts[i]++;
    }
    const n = lums.length;
    let loc = findPercentBright(counts, n, this.percentBright, this.percentTarget);
    const goal = this.percentTarget * 0.01;
    if (loc < 0) loc = goal;
    let scale = goal / Math.max(loc, 0.0001);
    const avg = findPercentBright(counts, n, 50, -1);
    if (avg > 0) scale = Math.max(this.minAvgLum * 0.01 / avg, scale);
    return this.push(Math.max(0.001, scale * this.scale));
  }

  /**
   * [R 18025edd0] the last ten targets, weighted away from the middle, within the map's limits
   * @param {number} target This frame's target.
   * @returns {number} The smoothed target.
   */
  push(target) {
    if (this.history.length === 10) this.history.shift();
    this.history.push(target);
    if (this.history.length === 10) {
      let sum = 0, weight = 0;
      this.history.forEach((v, i) => { const w = Math.abs(i - 5) * 0.2; sum += w * v; weight += w; });
      this.target = Math.max(this.min, Math.min(this.max, sum / weight));
    } else this.target = target;
    return this.target;
  }

  /**
   * [R 18025ef1f] algorithm 1 doubles the rate; going down speeds up with how far there is to go
   * @param {number} dt Seconds.
   * @returns {number} The scale to draw with.
   */
  step(dt) {
    let rate = this.rate * 2;
    if (this.target < this.scale) {
      const fast = rate * ACCEL_DOWN;
      rate = Math.min(fast, (fast - rate) * (this.scale - this.target) * 0.66667 + rate);
    }
    const t = Math.min(1, Math.max(0, rate * dt));
    this.scale = this.scale * (1 - t) + this.target * t;
    return this.scale;
  }
}
