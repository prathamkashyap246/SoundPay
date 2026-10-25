// Jam Lab engine: one simulated payment broadcast through a simulated room, decoded like the phone would.
// Uses the real modem (../hop/) and the same interference models as tools/hopsim (./models.js).
// Pure functions + one optional ggwave instance, so it runs in the browser and in Node.
import { hopPlan, flatPlan } from '../hop/hop.js';
import { buildFrame, decodeFrame, frameInfo, highPass, RATE, NCH } from '../hop/modem.js';
import { packToken, unpackToken, ALPHABET } from '../hop/token.js';
import { PROFILES, codeOf } from '../hop/profiles.js';
import { ChannelMonitor, maskFrom, calibrationFrom } from '../hop/monitor.js';
import * as M from './models.js';

export const TONE = 0.25;                        // received tone amplitude at the reference distance
const TARGET_RMS = TONE / Math.SQRT2;
const JAM = 2 * TONE;                            // jam tones: 2x the signal's tone
const KEY = new Uint8Array(32).map((_, i) => i * 17 + 9);
const PRE_ROLL = 1.5 * RATE;                      // the room before the frame (what the phone's monitor hears)

export const SYSTEMS = {
  ggwave: { label: 'ggwave', note: 'what SoundPay used before: fixed tones, repeated broadcast' },
  fixed: { label: 'Fixed channels', note: 'this modem without hopping', bits: 6, rs: 32, hop: false },
  fast: { label: 'Hop · fast', note: '2.6 s frame, default profile', ...codeOf(PROFILES.fast), hop: true },
  robust: { label: 'Hop · robust', note: '4.6 s frame, 8-tone sub-bands', ...codeOf(PROFILES.robust), hop: true },
  range: { label: 'Hop · range', note: '3.6 s frame, extra error correction', ...codeOf(PROFILES.range), hop: true },
};

// Each scenario has one strength knob. `apply` adds interference to x (in place); clean = the signal alone.
export const SCENARIOS = {
  quiet: { label: 'Quiet room', knob: { label: 'Room noise', min: 0.01, max: 0.3, step: 0.01, value: 0.03, unit: 'σ' } },
  random: { label: 'Jammer: random channels', knob: { label: 'Channels jammed', min: 0, max: 60, step: 5, value: 25, unit: '%' },
    apply: (x, k, rng) => M.addRandomJam(x, k / 100, JAM, rng) },
  replay: { label: 'Jammer: replays the last broadcast', knob: { label: 'Channels it jams', min: 4, max: 48, step: 4, value: 24, unit: '' }, replay: true },
  sweep: { label: 'Jammer: sweeping tone', knob: { label: 'Sweep period', min: 30, max: 1000, step: 10, value: 100, unit: 'ms' },
    apply: (x, k, rng) => M.addSweep(x, 1, k, JAM, rng) },
  follower: { label: 'Jammer: follower (reacts to each tone)', knob: { label: 'Reaction time', min: 22, max: 100, step: 2, value: 32, unit: 'ms' },
    apply: (x, k, rng, clean) => M.addFollower(x, clean, k, rng, { amp: JAM, minRms: TARGET_RMS }) },
  construction: { label: 'Construction site', knob: { label: 'Impacts per second', min: 1, max: 12, step: 1, value: 6, unit: '/s' },
    apply: (x, k, rng) => M.addConstruction(x, rng, { rate: k, peak: 1.5, rumble: 0.6 }) },
  speech: { label: 'Loud speech / music', knob: { label: 'Loudness', min: 0.1, max: 1.2, step: 0.1, value: 0.6, unit: '' },
    apply: (x, k, rng) => M.addSpeechMusic(x, rng, { level: k }) },
  whine: { label: 'Machine whine in the band', knob: { label: 'Loudness (x signal)', min: 0.5, max: 6, step: 0.5, value: 4, unit: 'x' },
    apply: (x, k, rng) => M.addMachineWhine(x, rng, { hi: 17500, level: k * TONE }) },
  pest: { label: 'Ultrasonic pest repeller', knob: { label: 'Loudness (x signal)', min: 0.5, max: 4, step: 0.5, value: 2, unit: 'x' },
    apply: (x, k, rng) => M.addPestRepeller(x, rng, { amp: k * TONE }) },
  neighbour: { label: 'Second terminal nearby', knob: { label: 'Its loudness', min: -20, max: 0, step: 2, value: 0, unit: 'dB' }, neighbour: true },
  distance: { label: 'Distance (laptop speaker)', knob: { label: 'Signal level', min: -42, max: 0, step: 3, value: -30, unit: 'dB' }, distance: true },
};

const rngToken = rng => Array.from({ length: 16 }, () => ALPHABET[Math.floor(rng() * 32)]).join('');

function scaleToRms(sig, rms = TARGET_RMS) {
  let e = 0, n = 0;
  for (const v of sig) if (v !== 0) { e += v * v; n++; }
  const k = rms / Math.sqrt(e / Math.max(1, n));
  return Float32Array.from(sig, v => v * k);
}

// ggwave is optional (WebAssembly): pass the factory's result to enableGgwave().
let gg = null;
export function enableGgwave(g) {
  g.disableLog?.();
  const inst = () => { const p = g.getDefaultParameters(); p.sampleRateInp = RATE; p.sampleRateOut = RATE; return g.init(p); };
  const tx = inst();
  gg = {
    encode: text => new Float32Array(g.encode(tx, text, g.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST, 50).slice().buffer),
    decode: x => {
      const rx = inst();
      try {
        for (let i = 0; i + 1024 <= x.length; i += 1024) {
          const out = g.decode(rx, new Int8Array(x.slice(i, i + 1024).buffer));
          if (out && out.length) return new TextDecoder().decode(out);
        }
        return null;
      } finally { g.free(rx); }
    },
  };
}
export const ggwaveAvailable = () => !!gg;

// One trial. opts: { system, scenario, knob, adaptive (AFH + speaker calibration for hop systems), seed }
// Returns { ok, sent, got, x (what the phone heard, 48 kHz), airtime, details }
export async function runTrial({ system, scenario, knob, adaptive = true, seed = 1 }) {
  const sys = SYSTEMS[system], sc = SCENARIOS[scenario];
  if (system === 'ggwave' && !gg) throw new Error('ggwave is not available here');
  const rng = M.mulberry32(seed);
  const token = rngToken(rng), payload = packToken(token);
  const id = `lab${seed}`;
  const code = sys.bits ? { bits: sys.bits, rs: sys.rs } : null;
  const slots = code ? frameInfo(10, code).slots : 0;
  const plan = c => sys.hop ? hopPlan(KEY, `${id}|${c}`, slots) : flatPlan(slots);
  const levelDb = sc.distance ? knob : 0;
  const response = sc.distance ? M.speakerGains(15) : null;          // laptop speaker: -15 dB at 19.5 kHz

  // The room: PRE_ROLL of it before the frame (the phone's ChannelMonitor listens to that part), then the frame.
  // Interference is generated ONCE over the whole stretch, so a jammer sits on the same channels throughout.
  const thePlan = code ? await plan('cycle1') : null;
  const ggSig = system === 'ggwave' ? scaleToRms(gg.encode(token)) : null;
  const sigLen = ggSig ? ggSig.length : slots * 3072;
  const lead = Math.floor((0.15 + 0.15 * rng()) * RATE), tail = Math.floor(0.4 * RATE);
  const total = PRE_ROLL + lead + sigLen + tail;
  const x = new Float32Array(total);
  M.addNoise(x, scenario === 'quiet' ? knob : 0.03, rng);
  if (sc.apply && scenario !== 'follower') sc.apply(x, knob, rng);

  let mask = null, gains = null;
  if (code && sys.hop && adaptive) {
    const mon = new ChannelMonitor();
    mon.push(x.subarray(0, PRE_ROLL));
    mask = maskFrom(mon.noisyChannels(), sys.bits);
    // speaker calibration was done once at setup (range-test page): boost-only pre-emphasis
    if (response) gains = calibrationFrom(Float64Array.from(response, r => r * r))?.gains || null;
  }
  let sig;
  if (ggSig) sig = ggSig;
  else {
    const speaker = Float32Array.from({ length: NCH }, (_, m) => (response ? response[m] : 1) * (gains ? gains[m] : 1));
    sig = buildFrame(payload, thePlan, { ...code, mask, gains: speaker, maxAmp: 10 });
    sig = Float32Array.from(sig, v => v * TONE / 0.5);              // reference: a 0.25 tone at 0 dB
  }
  const level = 10 ** (levelDb / 20);
  const clean = new Float32Array(total);
  for (let i = 0; i < sig.length; i++) clean[PRE_ROLL + lead + i] = level * sig[i];
  for (let i = 0; i < total; i++) x[i] += clean[i];
  if (scenario === 'follower') sc.apply(x, knob, rng, clean);
  if (sc.replay) {
    // the attacker recorded the previous broadcast of this payment and jams its loudest channels
    const prev = ggSig || buildFrame(payload, await plan('cycle0'), { ...code, mask });
    M.addTones(x, loudest(prev, knob), JAM, rng);
  }
  if (sc.neighbour) {
    const other = new Uint8Array(32).fill(99);
    const a = TONE * 10 ** (knob / 20);
    for (let st = -Math.floor(rng() * RATE), c = 0; st < total; st += 3 * RATE, c++) {
      const f = code ? buildFrame(packToken(rngToken(rng)), await hopPlan(other, `nb${seed}|${c}`, slots), code) : scaleToRms(gg.encode(rngToken(rng)));
      const k = code ? a / 0.5 : a / TARGET_RMS * (TARGET_RMS / TONE);
      for (let i = 0; i < f.length; i++) if (st + i >= 0 && st + i < total) x[st + i] += k * f[i];
    }
  }
  M.clip(x, 1);                                                      // the microphone's full scale
  const heard = x.slice(PRE_ROLL);

  let got = null, details = {};
  if (system === 'ggwave') got = gg.decode(heard);
  else {
    const r = decodeFrame(highPass(heard), thePlan, { ...code, mask, searchSeconds: 0.5, levels: true });
    if (r.ok) got = unpackToken(r.payload);
    details = { reason: r.reason, erasures: r.erasures, snrDb: r.snrDb, hotChannels: r.hotChannels, impulseSlots: r.impulseSlots, blanked: r.blanked, avoided: mask ? NCH - mask.length : 0, boosted: !!gains };
  }
  return { ok: got === token, sent: token, got, x: heard, airtime: sigLen / RATE, details };
}

// the `n` channels carrying the most energy in a recording
function loudest(sig, n) {
  const W = 3072, e = new Float64Array(NCH);
  const cw = Float64Array.from({ length: NCH }, (_, m) => 2 * Math.cos(2 * Math.PI * (15000 + 46.875 * m) / RATE));
  for (let s = 0; s + W <= sig.length; s += W) {
    for (let m = 0; m < NCH; m++) {
      let s1 = 0, s2 = 0;
      for (let i = s; i < s + W; i++) { const s0 = sig[i] + cw[m] * s1 - s2; s2 = s1; s1 = s0; }
      e[m] += s1 * s1 + s2 * s2 - cw[m] * s1 * s2;
    }
  }
  return [...e.keys()].sort((a, b) => e[b] - e[a]).slice(0, n);
}

// Spectrogram of 14-20 kHz for drawing: { cols, rows, data: Float32Array (dB), hzLo, hzHi, seconds }
export function spectrogram(x, { fft = 1024, hop = 256, lo = 14000, hi = 20000 } = {}) {
  const bin = RATE / fft, b0 = Math.floor(lo / bin), b1 = Math.ceil(hi / bin);
  const rows = b1 - b0, cols = Math.max(1, Math.floor((x.length - fft) / hop));
  const data = new Float32Array(rows * cols);
  const win = Float32Array.from({ length: fft }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / fft));
  const cw = Float64Array.from({ length: rows }, (_, r) => 2 * Math.cos(2 * Math.PI * (b0 + r) / fft));
  const buf = new Float32Array(fft);
  for (let c = 0; c < cols; c++) {
    for (let n = 0; n < fft; n++) buf[n] = x[c * hop + n] * win[n];
    for (let r = 0; r < rows; r++) {
      let s1 = 0, s2 = 0;
      const k = cw[r];
      for (let n = 0; n < fft; n++) { const s0 = buf[n] + k * s1 - s2; s2 = s1; s1 = s0; }
      data[r * cols + c] = 10 * Math.log10(s1 * s1 + s2 * s2 - k * s1 * s2 + 1e-9);
    }
  }
  return { cols, rows, data, hzLo: b0 * bin, hzHi: b1 * bin, seconds: x.length / RATE };
}
