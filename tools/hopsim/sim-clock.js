// How much clock error can the receiver tolerate? Usage: node sim-clock.js [trials=100]
// Model: the POS plays cycle G's frame starting at G*3 s. The phone stops recording ~2.7 s later and
// believes the time is (true time + error). It tries cycles around its own estimate.
import { decodeWithClock, buildFrameForCycle, CYCLE_MS, EPOCH_CYCLES } from '../../public/hop/timing.js';
import { RATE, SLOT, NCH, frameInfo } from '../../public/hop/modem.js';
import { mulberry32, gauss, jammerPeriod } from './channel.js';

const TRIALS = Number(process.argv[2] || 100);
const SECRET = new Uint8Array(32).map((_, i) => i * 11 + 5);
const PAYLOAD_LEN = 10, GAIN = 0.5;

async function trial(errMs, spread, jam, t) {
  const rng = mulberry32(777 + 7919 * t);
  const G = 1000 + Math.floor(rng() * 5000);                          // random cycle => random spot in the epoch
  const payload = Uint8Array.from({ length: PAYLOAD_LEN }, () => Math.floor(rng() * 256));
  const frame = await buildFrameForCycle(payload, SECRET, 'T1', G);
  const lead = Math.floor(rng() * 3 * RATE);                           // phone started recording up to 3 s before the frame
  const x = new Float32Array(lead + frame.length + Math.floor(0.1 * RATE));
  for (let i = 0; i < x.length; i++) x[i] = 0.03 * gauss(rng);
  for (let i = 0; i < frame.length; i++) x[lead + i] += GAIN * frame[i];
  if (jam) {
    const bins = Array.from({ length: NCH }, (_, i) => i).sort(() => rng() - 0.5).slice(0, Math.round(jam * NCH));
    const p = jammerPeriod(bins, GAIN * 0.5 * 2, rng);
    for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
  }
  const est = G * CYCLE_MS + 2700 + errMs;
  const r = await decodeWithClock(x, { secret: SECRET, terminalId: 'T1', estTimeMs: est, spread });
  return { ok: r.ok && r.payload.every((b, i) => b === payload[i]) && r.cycle === G, tries: r.tries };
}

const errors = [0, 400, 1500, 3000, -3000, 6000, -6000, 9000, -9000];
console.log(`trials per cell: ${TRIALS}; cycle ${CYCLE_MS} ms; epoch ${EPOCH_CYCLES * CYCLE_MS / 1000} s\n`);
console.log('| clock error | no search (1 candidate) | search +-2 cycles | avg decodes tried |');
console.log('|---|---|---|---|');
for (const err of errors) {
  let ok0 = 0, ok2 = 0, tries = 0;
  for (let t = 0; t < TRIALS; t++) {
    ok0 += (await trial(err, 0, 0, t)).ok;
    const r = await trial(err, 2, 0, t); ok2 += r.ok; tries += r.tries;
  }
  console.log(`| ${(err / 1000).toFixed(1).padStart(5)} s | ${(100 * ok0 / TRIALS).toFixed(0).padStart(4)}% | ${(100 * ok2 / TRIALS).toFixed(0).padStart(4)}% | ${(tries / TRIALS).toFixed(1)} |`);
}
