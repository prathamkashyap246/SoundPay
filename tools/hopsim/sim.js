// Monte Carlo harness: hopping vs. a fixed-channel baseline under noise and jamming.
// Usage: node sim.js [trials=400]
import { hopPlan, flatPlan } from '../../public/hop/hop.js';
import { buildFrame, slotTones, decodeFrame, frameInfo, RATE, SLOT, NCH } from '../../public/hop/modem.js';
import { mulberry32, gauss, jammerPeriod } from './channel.js';

const TRIALS = Number(process.argv[2] || 400);
const KEY = new Uint8Array(32).map((_, i) => i * 7 + 3);
const PAYLOAD_LEN = 10;
const GAIN = 0.5;                  // channel loss: frame amp 0.5 -> received amp 0.25
const JAM_AMP = 2;                 // each jammed bin carries 2x the signal's tone amplitude

function distinct(arr, limit) { const s = []; for (const v of arr) if (!s.includes(v)) { s.push(v); if (s.length >= limit) break; } return s; }

async function trial(cfg, t) {
  const rng = mulberry32(1000003 * t + cfg.seed);
  const code = cfg.rs ? { rs: cfg.rs } : { rs: 0, R: cfg.R };
  const { slots } = frameInfo(PAYLOAD_LEN, code);
  const payload = Uint8Array.from({ length: PAYLOAD_LEN }, () => Math.floor(rng() * 256));
  const session = `s${cfg.seed}-${t}`;
  const mk = ctx => cfg.hop ? hopPlan(KEY, `${session}|${ctx}`, slots) : flatPlan(slots);
  const plan = await mk('cycle1');
  const frame = buildFrame(payload, plan, code);

  // what a jammer can choose to hit
  let jamBins = [];
  if (cfg.jam?.type === 'random') {
    const all = Array.from({ length: NCH }, (_, i) => i).sort(() => rng() - 0.5);
    jamBins = all.slice(0, Math.round(cfg.jam.fraction * NCH));
  } else if (cfg.jam?.type === 'targeted') {
    // attacker listened to the PREVIOUS broadcast of this same payment and jams the tones it used
    const prev = await mk('cycle0');
    jamBins = distinct(Array.from(slotTones(payload, prev, code)), cfg.jam.budget);
  }

  const lead = Math.floor(rng() * 0.25 * RATE), tail = Math.floor(0.1 * RATE);
  const x = new Float32Array(lead + frame.length + tail);
  for (let i = 0; i < x.length; i++) x[i] = cfg.sigma * gauss(rng);
  for (let i = 0; i < frame.length; i++) x[lead + i] += GAIN * frame[i];
  if (jamBins.length) {
    const p = jammerPeriod(jamBins, GAIN * 0.5 * JAM_AMP, rng);
    for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
  }
  const r = decodeFrame(x, plan, { ...code, payloadLen: PAYLOAD_LEN });
  return r.ok && r.payload.every((b, i) => b === payload[i]);
}

async function rate(cfg) {
  let ok = 0;
  for (let t = 0; t < TRIALS; t++) if (await trial(cfg, t)) ok++;
  return ok / TRIALS;
}
const pct = p => (p * 100).toFixed(1).padStart(5) + '%';
const ci = p => '±' + (196 * Math.sqrt(p * (1 - p) / TRIALS) / 1 ).toFixed(1);   // 95% half-width, in points

// air = frame length class: 2 -> 2.56 s (repetition R=2 or RS(32,16)); 3 -> 3.58 s (R=3 or RS(48,16))
const scenarios = [
  { name: 'quiet room (noise σ=0.03)',            air: 2, sigma: 0.03 },
  { name: 'very noisy room (σ=0.20)',             air: 2, sigma: 0.20 },
  { name: 'jam 10% of channels (random)',         air: 2, sigma: 0.03, jam: { type: 'random', fraction: 0.10 } },
  { name: 'jam 25% of channels (random)',         air: 2, sigma: 0.03, jam: { type: 'random', fraction: 0.25 } },
  { name: 'jam 50% of channels (random)',         air: 2, sigma: 0.03, jam: { type: 'random', fraction: 0.50 } },
  { name: 'TARGETED: jam 24 tones heard earlier', air: 2, sigma: 0.03, jam: { type: 'targeted', budget: 24 } },
  { name: 'jam 25% random, longer frame (3.6 s)', air: 3, sigma: 0.03, jam: { type: 'random', fraction: 0.25 } },
  { name: 'jam 50% random, longer frame (3.6 s)', air: 3, sigma: 0.03, jam: { type: 'random', fraction: 0.50 } },
];

console.log(`trials per cell: ${TRIALS}   frame: 2.56 s (air 2) / 3.58 s (air 3); same airtime for repetition and RS\n`);
console.log('| scenario | fixed + repetition | hopping + repetition | fixed + RS | hopping + RS |');
console.log('|---|---|---|---|---|');
// optional 3rd arg "from-to" runs only those scenario indexes (handy for splitting a long run)
const [from, to] = (process.argv[3] || `0-${scenarios.length - 1}`).split('-').map(Number);
let seed = 1;
for (const [idx, s] of scenarios.entries()) {
  seed = idx + 1;
  if (idx < from || idx > to) continue;
  const cells = [];
  for (const [hop, rs] of [[false, 0], [true, 0], [false, 16 * s.air], [true, 16 * s.air]]) {
    cells.push(pct(await rate({ ...s, hop, R: s.air, rs, seed })));
  }
  console.log(`| ${s.name} | ${cells.join(' | ')} |`);
}
