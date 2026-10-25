// What the phone's microphone is up against, measured continuously while it listens:
//   - which of the 96 channels are persistently noisy (machine whine, ultrasonic beacons, an aliased pest
//     repeller, a jammer). The POS can then hop around them: adaptive frequency hopping, like Bluetooth's AFH.
//   - in-band noise level, how often the mic clips, and how loud everything else (speech, construction) is,
//     for the signal meter on the pay page.
// Feed it the RAW microphone samples; it does its own high-pass for the band measurements.
import { slotSpectrum, HighPass, NCH, SLOT, RATE, MIN_CHANNELS } from './modem.js';

const WINDOWS = 48;                 // ~3 s of history (64 ms windows)
const HOT_DB = 10;                  // 10 dB over the window's own floor counts as hot
const BAD_FRACTION = 0.5;           // hot in half the windows: persistent, avoid it

export class ChannelMonitor {
  constructor() {
    this.hp = new HighPass();
    this.pending = new Float32Array(SLOT);
    this.n = 0;
    this.hot = Array.from({ length: NCH }, () => new Uint8Array(WINDOWS));
    this.level = new Float64Array(NCH);
    this.windows = 0;
    this.clipped = 0;
    this.samples = 0;
    this.lowEnergy = 0;
    this.bandEnergy = 0;
  }

  push(raw) {
    for (const v of raw) {
      if (Math.abs(v) >= 0.98) this.clipped++;
      this.lowEnergy += v * v;
    }
    this.samples += raw.length;
    const x = this.hp.process(raw);
    let i = 0;
    while (i < x.length) {
      const take = Math.min(SLOT - this.n, x.length - i);
      this.pending.set(x.subarray(i, i + take), this.n);
      this.n += take; i += take;
      if (this.n === SLOT) { this.window(this.pending); this.n = 0; }
    }
  }

  window(w) {
    const e = slotSpectrum(w, 0);
    const floor = Float64Array.from(e).sort()[24] + 1e-12;
    const k = this.windows % WINDOWS;
    for (let m = 0; m < NCH; m++) {
      this.hot[m][k] = 10 * Math.log10(e[m] / floor) > HOT_DB ? 1 : 0;
      this.level[m] = 0.9 * this.level[m] + 0.1 * e[m];
    }
    for (const v of w) this.bandEnergy += v * v;
    this.windows++;
  }

  // Channels to avoid, worst first, at most `maxMasked` so the hop set keeps enough channels.
  noisyChannels(maxMasked = NCH - MIN_CHANNELS[6]) {
    const n = Math.min(this.windows, WINDOWS);
    if (n < 16) return [];
    const frac = this.hot.map(h => h.reduce((a, b) => a + b, 0) / n);
    return frac.map((f, m) => [f, m]).filter(([f]) => f >= BAD_FRACTION).sort((a, b) => b[0] - a[0]).slice(0, maxMasked).map(([, m]) => m);
  }

  // A snapshot for the UI, then counters restart.
  stats() {
    const s = {
      clippedPct: this.samples ? 100 * this.clipped / this.samples : 0,
      roomDb: this.samples ? 10 * Math.log10(this.lowEnergy / this.samples + 1e-12) : -120,
      bandDb: this.samples ? 10 * Math.log10(this.bandEnergy / this.samples + 1e-12) : -120,
      noisy: this.noisyChannels(),
      seconds: this.samples / RATE,
    };
    this.clipped = 0; this.samples = 0; this.lowEnergy = 0; this.bandEnergy = 0;
    return s;
  }
}

// The hop set that results from avoiding `noisy` (sorted ascending), or null for "all channels".
export function maskFrom(noisy, bits = 6) {
  if (!noisy || !noisy.length) return null;
  const bad = new Set(noisy.slice(0, NCH - MIN_CHANNELS[bits]));
  return Array.from({ length: NCH }, (_, m) => m).filter(m => !bad.has(m));
}

// Speaker calibration from what the phone measured. toneLevel: received energy of our tones per channel
// (NaN = not seen); currentGains: the pre-emphasis the POS was already using, so it is divided out.
//   gains  BOOST ONLY: weak channels up to +5.6 dB (x1.9, the headroom left at the default 0.5 amplitude),
//          never trimming strong ones. Near the noise limit, flattening by turning strong tones down loses
//          more than it gains (measured: -30 dB with a 15 dB speaker roll-off went 1/20 -> 0/20 with +-6 dB
//          equalising, 1/20 -> 20/20 with boost-only).
//   weak   channels still more than 6 dB under the strong ones after boosting, worst first: candidates to
//          leave out of the hop set (the POS masks up to 32 of them).
//   dead   more than 20 dB down: the speaker can't play them at all.
export const MAX_BOOST = 1.9;
export function calibrationFrom(toneLevel, currentGains = null) {
  const resp = Float64Array.from(toneLevel, (v, m) => v > 0 ? v / (currentGains ? currentGains[m] ** 2 : 1) : NaN);
  const seen = [...resp].filter(v => v > 0).sort((a, b) => a - b);
  if (seen.length < 24) return null;
  const ref = seen[Math.floor(seen.length * 0.9)];                 // the strong channels (90th percentile)
  const gains = new Float32Array(NCH).fill(1), dead = [], weak = [];
  let lastDb = 0;
  for (let m = 0; m < NCH; m++) {
    if (resp[m] > 0) lastDb = 10 * Math.log10(resp[m] / ref);       // unseen channels borrow their neighbour's
    gains[m] = Math.min(MAX_BOOST, Math.max(1, 10 ** (-lastDb / 20)));
    const after = lastDb + 20 * Math.log10(gains[m]);
    if (lastDb < -20) dead.push(m);
    if (after < -6) weak.push([after, m]);
  }
  return { gains, dead, weak: weak.sort((a, b) => a[0] - b[0]).map(([, m]) => m) };
}
