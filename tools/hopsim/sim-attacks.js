// Head-to-head under attack: real ggwave (ULTRASOUND_FAST, what SoundPay used before) vs this modem
// without hopping vs this modem with key-synchronised hopping. Same loudness, same noise, same jammers.
//
//   node tools/hopsim/sim-attacks.js [trials=100] [scenarioFrom-scenarioTo]
//
// Fairness rules:
//   - Every signal is scaled to the same RMS level at the receiver (0.177, i.e. a 0.25-amplitude tone).
//   - Every jammer is the same absolute signal for all three systems; jam tones are 0.5 amplitude each
//     (2x the hop modem's tone) and sit on the 46.875 Hz grid from 15 kHz that ggwave also uses.
//   - "Targeted" attackers recorded the previous broadcast of the same payment and jam the 24 channels
//     that carried the most energy in it. ggwave repeats an identical waveform; the hop modem doesn't.
//   - The follower listens to the transmitter directly (best case for the attacker), needs a 1024-sample
//     window (21.3 ms) to tell 46.875 Hz channels apart, and then reacts after the stated total delay by
//     putting a 2x-strength tone on a random OTHER channel for as long as the detected tone lasts.
import { createRequire } from 'node:module';
import { hopPlan, flatPlan } from '../../public/hop/hop.js';
import { buildFrame, decodeFrame, frameInfo, slotSpectrum, highPass, RATE, SLOT, NCH } from '../../public/hop/modem.js';
import { packToken, unpackToken, ALPHABET } from '../../public/hop/token.js';
import { mulberry32, gauss, jammerPeriod, addFollower } from './channel.js';

const TRIALS = Number(process.argv[2] || 100);
const DECODE = process.env.HOT_FRACTION ? { hotFraction: Number(process.env.HOT_FRACTION) } : {};   // for tuning
const KEY = new Uint8Array(32).map((_, i) => i * 13 + 1);
const TARGET_RMS = 0.25 / Math.SQRT2;
const JAM_TONE = 0.5;
const F0 = 15000, DF = 46.875;

// ggwave's WebAssembly prints a line per decode; keep stdout for the table
const print = console.log.bind(console);
console.log = () => {};
const ggwave = await createRequire(import.meta.url)('ggwave')();
ggwave.disableLog();
const GG_PROTOCOL = ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;
function ggInstance() {
  const p = ggwave.getDefaultParameters();
  p.sampleRateInp = RATE; p.sampleRateOut = RATE;
  return ggwave.init(p);
}
const ggTx = ggInstance();
const ggEncode = text => new Float32Array(ggwave.encode(ggTx, text, GG_PROTOCOL, 50).slice().buffer);
function ggDecode(x) {
  const rx = ggInstance();
  try {
    for (let i = 0; i + 1024 <= x.length; i += 1024) {
      const out = ggwave.decode(rx, new Int8Array(x.slice(i, i + 1024).buffer));
      if (out && out.length) return new TextDecoder().decode(out);
    }
    return null;
  } finally { ggwave.free(rx); }
}

function scaleToRms(sig) {
  let e = 0, n = 0;
  for (const v of sig) if (v !== 0) { e += v * v; n++; }
  const k = TARGET_RMS / Math.sqrt(e / Math.max(1, n));
  return Float32Array.from(sig, v => v * k);
}

const rngToken = rng => Array.from({ length: 16 }, () => ALPHABET[Math.floor(rng() * 32)]).join('');

// ---------------------------------------------------------------- the three systems

const SYSTEMS = {
  ggwave: {
    build: async token => ({ sig: scaleToRms(ggEncode(token)) }),
    previous: async token => scaleToRms(ggEncode(token)),                 // the repeat is identical
    decode: (x, token) => ggDecode(x) === token,
  },
  fixed: modemSystem(false, 6),
  hopping: modemSystem(true, 6),
  'hop 8-tone sub-bands': modemSystem(true, 3),
  'hop 4-tone sub-bands': modemSystem(true, 2),
  'hop range RS48': modemSystem(true, 6, 48),
};

function modemSystem(hop, bits, rs = 32) {
  const code = { bits, rs };
  const slots = frameInfo(10, code).slots;
  const plan = (id, cycle) => hop ? hopPlan(KEY, `${id}|${cycle}`, slots) : flatPlan(slots);
  return {
    airtime: frameInfo(10, code).seconds,
    build: async (token, id) => { const p = await plan(id, 'cycle1'); return { sig: scaleToRms(buildFrame(packToken(token), p, code)), plan: p }; },
    previous: async (token, id) => scaleToRms(buildFrame(packToken(token), await plan(id, 'cycle0'), code)),
    decode: (x, token, b) => { const r = decodeFrame(highPass(x), b.plan, { ...code, searchSeconds: 0.5, ...DECODE }); return r.ok && unpackToken(r.payload) === token; },
  };
}

// ---------------------------------------------------------------- jammers

function addRandom(x, fraction, rng) {
  const bins = Array.from({ length: NCH }, (_, i) => i).sort(() => rng() - 0.5).slice(0, Math.round(fraction * NCH));
  const p = jammerPeriod(bins, JAM_TONE, rng);
  for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
}

// channels that carried the most energy in a recording of the previous broadcast
function loudestChannels(prev, budget) {
  const total = new Float64Array(NCH);
  for (let s = 0; s + SLOT <= prev.length; s += SLOT) slotSpectrum(prev, s).forEach((v, m) => { total[m] += v; });
  return Array.from(total.keys()).sort((a, b) => total[b] - total[a]).slice(0, budget);
}

function addTones(x, bins, rng) {
  const p = jammerPeriod(bins, JAM_TONE, rng);
  for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
}

// `tones` jammer tones, evenly spread, each sweeping 15 -> 19.5 kHz every periodMs (phase-continuous)
function addSweep(x, tones, periodMs, rng) {
  const bw = NCH * DF, period = periodMs * RATE / 1000;
  for (let t = 0; t < tones; t++) {
    let phase = rng() * 2 * Math.PI;
    for (let i = 0; i < x.length; i++) {
      const f = F0 + ((i / period + t / tones) % 1) * bw;
      phase += 2 * Math.PI * f / RATE;
      x[i] += JAM_TONE * Math.sin(phase);
    }
  }
}

// ---------------------------------------------------------------- scenarios

const scenarios = [
  { name: 'quiet room (noise σ=0.03)', sigma: 0.03 },
  { name: 'very noisy room (σ=0.20)', sigma: 0.20 },
  { name: 'random: jam 10% of channels', jam: (x, c, r) => addRandom(x, 0.10, r) },
  { name: 'random: jam 25% of channels', jam: (x, c, r) => addRandom(x, 0.25, r) },
  { name: 'random: jam 50% of channels', jam: (x, c, r) => addRandom(x, 0.50, r) },
  { name: 'targeted: 24 loudest channels of the previous broadcast', targeted: 24 },
  { name: 'targeted: 48 loudest channels of the previous broadcast', targeted: 48 },
  { name: 'sweep: 1 tone across the band every 100 ms', jam: (x, c, r) => addSweep(x, 1, 100, r) },
  { name: 'sweep: 1 tone across the band every 1 s', jam: (x, c, r) => addSweep(x, 1, 1000, r) },
  { name: 'sweep: 8 tones across the band every 500 ms', jam: (x, c, r) => addSweep(x, 8, 500, r) },
  { name: 'follower, reacts in 22 ms (fastest possible)', jam: (x, c, r) => addFollower(x, c, 22, r, { amp: JAM_TONE, minRms: TARGET_RMS }) },
  { name: 'follower, reacts in 32 ms', jam: (x, c, r) => addFollower(x, c, 32, r, { amp: JAM_TONE, minRms: TARGET_RMS }) },
  { name: 'follower, reacts in 48 ms', jam: (x, c, r) => addFollower(x, c, 48, r, { amp: JAM_TONE, minRms: TARGET_RMS }) },
  { name: 'follower, reacts in 80 ms', jam: (x, c, r) => addFollower(x, c, 80, r, { amp: JAM_TONE, minRms: TARGET_RMS }) },
];

async function trial(sysName, sc, t, idx) {
  const rng = mulberry32(7_000_003 * (idx + 1) + 104_729 * t);
  const token = rngToken(rng);
  const sys = SYSTEMS[sysName];
  const built = await sys.build(token, `t${idx}-${t}`);
  const lead = Math.floor((0.05 + rng() * 0.2) * RATE), tail = Math.floor(0.5 * RATE);
  const clean = new Float32Array(lead + built.sig.length + tail);
  clean.set(built.sig, lead);
  const x = new Float32Array(clean.length);
  const sigma = sc.sigma ?? 0.03;
  for (let i = 0; i < x.length; i++) x[i] = clean[i] + sigma * gauss(rng);
  if (sc.jam) sc.jam(x, clean, rng);
  if (sc.targeted) addTones(x, loudestChannels(await sys.previous(token, `t${idx}-${t}`), sc.targeted), rng);
  return sys.decode(x, token, built);
}

const [from, to] = (process.argv[3] || `0-${scenarios.length - 1}`).split('-').map(Number);
// optional: SYSTEMS='ggwave;hopping' to run only some columns
const names = process.env.SYSTEMS ? process.env.SYSTEMS.split(';') : Object.keys(SYSTEMS);
SYSTEMS.ggwave.airtime = ggEncode('a'.repeat(16)).length / RATE;
print(`trials per cell: ${TRIALS} (95% CI about ±${(98 / Math.sqrt(TRIALS)).toFixed(0)} points near 50%)\n`);
print(`| scenario | ${names.map(n => `${n} (${SYSTEMS[n].airtime.toFixed(2)} s)`).join(' | ')} |`);
print(`|---|${names.map(() => '---').join('|')}|`);
for (const [idx, sc] of scenarios.entries()) {
  if (idx < from || idx > to) continue;
  const cells = [];
  for (const sys of names) {
    let ok = 0;
    for (let t = 0; t < TRIALS; t++) ok += await trial(sys, sc, t, idx) ? 1 : 0;
    cells.push(`${(100 * ok / TRIALS).toFixed(0)}%`);
  }
  print(`| ${sc.name} | ${cells.join(' | ')} |`);
}
ggwave.free(ggTx);
