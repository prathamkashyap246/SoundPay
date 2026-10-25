// Interference models: noise, jammers and room effects. Pure functions that ADD to a 48 kHz buffer in place.
// Shared by the Node simulations (tools/hopsim/) and the in-browser Jam Lab (public/lab/).
// Every random choice comes from the `rng` argument, so runs are repeatable.
import { SLOT, NCH, RATE, toneWave } from '../hop/modem.js';

const F0 = 15000, DF = 46.875;
const TAU = 2 * Math.PI;

export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const gauss = rng => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(TAU * rng());

export function addNoise(x, sigma, rng) { for (let i = 0; i < x.length; i++) x[i] += sigma * gauss(rng); }

// One period (SLOT samples) of steady tones on the given channels (they repeat every SLOT samples).
export function jammerPeriod(bins, amp, rng) {
  const out = new Float64Array(SLOT);
  for (const m of bins) {
    const w = toneWave(m), shift = Math.floor(rng() * SLOT);
    for (let n = 0; n < SLOT; n++) out[n] += amp * w[(n + shift) % SLOT];
  }
  return out;
}
export function addTones(x, bins, amp, rng) {
  const p = jammerPeriod(bins, amp, rng);
  for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
}
export function addRandomJam(x, fraction, amp, rng) {
  const bins = Array.from({ length: NCH }, (_, i) => i).sort(() => rng() - 0.5).slice(0, Math.round(fraction * NCH));
  addTones(x, bins, amp, rng);
  return bins;
}

// `tones` tones, evenly spread, each sweeping lo..hi Hz every periodMs (phase-continuous)
export function addSweep(x, tones, periodMs, amp, rng, lo = F0, hi = F0 + NCH * DF) {
  const period = periodMs * RATE / 1000;
  for (let t = 0; t < tones; t++) {
    let phase = rng() * TAU;
    for (let i = 0; i < x.length; i++) {
      phase += TAU * (lo + ((i / period + t / tones) % 1) * (hi - lo)) / RATE;
      x[i] += amp * Math.sin(phase);
    }
  }
}

// Reactive follower jammer. clean: the transmitted signal as the attacker hears it (right next to the POS).
// It needs a 1024-sample window (21.3 ms) to tell 46.875 Hz channels apart, reacts after `delayMs` in total,
// and puts a tone of amplitude `amp` on a random OTHER channel for as long as each detected tone lasts.
// minRms: the signal level it expects (detection threshold).
const W = 1024, BLOCK = 128;
const gcos = Float64Array.from({ length: NCH }, (_, m) => 2 * Math.cos(TAU * (F0 + DF * m) / RATE));
function channelEnergies(x, end) {
  const e = new Float64Array(NCH);
  if (end < W) return e;
  for (let m = 0; m < NCH; m++) {
    const c = gcos[m];
    let s1 = 0, s2 = 0;
    for (let n = end - W; n < end; n++) { const s0 = x[n] + c * s1 - s2; s2 = s1; s1 = s0; }
    e[m] = s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return e;
}
export function addFollower(x, clean, delayMs, rng, { amp = 0.5, minRms = 0.05 } = {}) {
  const extra = Math.max(0, Math.round(delayMs * RATE / 1000) - W);
  const spoof = new Map();
  const phase = new Float64Array(NCH);
  for (let b = 0; b < x.length; b += BLOCK) {
    const e = channelEnergies(clean, b - extra);
    let max = 0; for (const v of e) if (v > max) max = v;
    const detected = new Set();
    if (max > 1e-3 * W * W * minRms * minRms) for (let m = 0; m < NCH; m++) if (e[m] > 0.25 * max) detected.add(m);
    for (const m of [...spoof.keys()]) if (!detected.has(m)) spoof.delete(m);
    for (const m of detected) if (!spoof.has(m)) { let j; do { j = Math.floor(rng() * NCH); } while (j === m); spoof.set(m, j); }
    for (const j of spoof.values()) {
      const w = TAU * (F0 + DF * j) / RATE;
      for (let n = b; n < Math.min(b + BLOCK, x.length); n++) x[n] += amp * Math.sin(phase[j] + w * (n - b));
      phase[j] += w * BLOCK;
    }
  }
}

// ---- everyday (non-malicious) interference -------------------------------------------------------

// Construction: hammer / nail-gun impulses (decaying broadband bursts, ~4 per second) over a low rumble.
export function addConstruction(x, rng, { rate = 4, peak = 1.2, rumble = 0.4 } = {}) {
  for (let i = 0; i < x.length;) {
    i += Math.floor(-Math.log(1 - rng()) * RATE / rate);
    const tau = (2 + 4 * rng()) * RATE / 1000, len = Math.floor(6 * tau), a = peak * (0.5 + rng());
    for (let n = 0; n < len && i + n < x.length; n++) x[i + n] += a * Math.exp(-n / tau) * gauss(rng);
  }
  const f = [60 + rng() * 60, 180 + rng() * 120, 400 + rng() * 300];
  const ph = f.map(() => rng() * TAU);
  for (let i = 0; i < x.length; i++) for (let k = 0; k < 3; k++) x[i] += rumble / 3 * Math.sin(ph[k] + TAU * f[k] * i / RATE);
}

// Loud speech / music: 24 drifting tones in 100 Hz - 5 kHz with a syllable-rate (2-6 Hz) envelope.
export function addSpeechMusic(x, rng, { level = 0.6 } = {}) {
  const tones = Array.from({ length: 24 }, () => ({ f: 100 + rng() ** 2 * 4900, ph: rng() * TAU, am: 2 + 4 * rng(), aph: rng() * TAU }));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (const t of tones) v += Math.sin(t.ph + TAU * t.f * i / RATE) * (0.5 + 0.5 * Math.sin(t.aph + TAU * t.am * i / RATE));
    x[i] += level / Math.sqrt(tones.length) * v;
  }
}

// Machine whine: dense, wandering tones in one part of OUR band (e.g. 15-16.5 kHz), louder than the signal.
export function addMachineWhine(x, rng, { lo = 15000, hi = 16500, level = 0.5 } = {}) {
  const tones = Array.from({ length: 40 }, () => ({ f: lo + rng() * (hi - lo), ph: rng() * TAU, drift: (rng() - 0.5) * 40 }));
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    const t = i / RATE;
    for (const s of tones) v += Math.sin(s.ph + TAU * (s.f * t + 0.5 * s.drift * t * t));
    x[i] += level / Math.sqrt(tones.length) * v;
  }
}

// Ultrasonic pest repeller: sweeps far above 24 kHz, but a cheap phone mic aliases it into 17-19.5 kHz.
export const addPestRepeller = (x, rng, { amp = 0.5, periodMs = 250 } = {}) => addSweep(x, 1, periodMs, amp, rng, 17000, 19500);

// A loud low-frequency source that drives the microphone into clipping at +-1.
export function addClippingRumble(x, rng, { amp = 1.3 } = {}) {
  const f = 150 + rng() * 100, ph = rng() * TAU;
  for (let i = 0; i < x.length; i++) x[i] += amp * Math.sin(ph + TAU * f * i / RATE) * (0.6 + 0.4 * Math.sin(TAU * 0.7 * i / RATE));
}
export function clip(x, level = 1) { for (let i = 0; i < x.length; i++) x[i] = Math.max(-level, Math.min(level, x[i])); }

// Speaker roll-off: a laptop speaker that is `tiltDb` weaker at 19.5 kHz than at 15 kHz (per-channel gain).
export const speakerGains = tiltDb => Float32Array.from({ length: NCH }, (_, m) => 10 ** (-tiltDb * m / (NCH - 1) / 20));
