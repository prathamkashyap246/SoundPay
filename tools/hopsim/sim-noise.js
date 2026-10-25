// Everyday interference and distance: does the hardened receiver help, and do adaptive channel avoidance
// (AFH) and speaker calibration help on top?
//
//   node tools/hopsim/sim-noise.js [trials=100] [from-to]
//
// Each trial is a room recording: 3 s of the room BEFORE the payment (the phone's ChannelMonitor listens to it
// and a previous broadcast plays in it, which the phone uses for speaker calibration), then the frame we score.
//
// Columns
//   fast, before      decoder as it was: no high-pass, no impulse/clip erasures, no per-channel floor
//   fast, hardened    + 12 kHz high-pass, impulse blanking, clip erasures, per-channel noise floor
//   fast, full        + AFH (POS avoids the channels the phone found noisy) + pre-emphasis from a one-time
//                     speaker calibration at setup (only matters in the scenarios with speaker roll-off)
//   robust, full      the robust profile (8-tone sub-bands) with everything on
//
// Levels: the signal arrives as a 0.25-amplitude tone (the same reference as sim-attacks.js) unless a scenario
// says it is weaker; room noise sigma 0.03. "-30 dB" means 30 dB weaker than that reference: in free field
// about 30x farther away (6 dB per doubling), before the speaker's high-frequency roll-off.
import { hopPlan } from '../../public/hop/hop.js';
import { buildFrame, decodeFrame, frameInfo, highPass, clipMask, RATE, SLOT } from '../../public/hop/modem.js';
import { ChannelMonitor, maskFrom, calibrationFrom } from '../../public/hop/monitor.js';
import { packToken, unpackToken, ALPHABET } from '../../public/hop/token.js';
import * as M from '../../public/lab/models.js';

const TRIALS = Number(process.argv[2] || 100);
const KEY = new Uint8Array(32).map((_, i) => i * 29 + 3);
const OTHER_KEY = new Uint8Array(32).map((_, i) => i * 31 + 7);
const PRE_ROLL = 3 * RATE;

// room(x, rng, ctx) adds the interference; ctx has the clean signal for the neighbour model.
const scenarios = [
  { name: 'quiet room' },
  { name: 'construction: hammering 4/s + rumble', room: (x, r) => M.addConstruction(x, r) },
  { name: 'heavy construction: 10 impacts/s, louder', room: (x, r) => M.addConstruction(x, r, { rate: 10, peak: 2, rumble: 0.8 }) },
  { name: 'loud speech / music next to the phone', room: (x, r) => M.addSpeechMusic(x, r, { level: 0.6 }) },
  { name: 'machine whine 15-16.5 kHz (2x the signal)', room: (x, r) => M.addMachineWhine(x, r, { level: 0.5 }) },
  { name: 'machine whine 15-17.5 kHz (4x the signal)', room: (x, r) => M.addMachineWhine(x, r, { hi: 17500, level: 1.0 }) },
  { name: 'pest repeller aliased into 17-19.5 kHz', room: (x, r) => M.addPestRepeller(x, r) },
  { name: 'loud rumble clips the mic', room: (x, r) => M.addClippingRumble(x, r), clip: true },
  { name: 'second terminal, same loudness, overlapping', neighbour: 1 },
  { name: 'second terminal, 10 dB quieter, overlapping', neighbour: 10 ** (-10 / 20) },
  { name: 'far: -30 dB, laptop speaker -15 dB at 19.5 kHz', gainDb: -30, tilt: 15 },
  { name: 'farther: -36 dB, same speaker', gainDb: -36, tilt: 15 },
  { name: 'farthest: -42 dB, same speaker', gainDb: -42, tilt: 15 },
  { name: 'everything: construction + speech + whine at -30 dB', gainDb: -30, tilt: 15,
    room: (x, r) => { M.addConstruction(x, r); M.addSpeechMusic(x, r, { level: 0.4 }); M.addMachineWhine(x, r, { level: 0.3 }); } },
];

const VARIANTS = {
  'fast, before': { bits: 6, harden: false },
  'fast, hardened': { bits: 6, harden: true },
  'fast, full': { bits: 6, harden: true, afh: true, cal: true },
  'robust, full': { bits: 3, harden: true, afh: true, cal: true },
  'range, full': { bits: 6, rs: 48, harden: true, afh: true, cal: true },
};

const rngToken = rng => Array.from({ length: 16 }, () => ALPHABET[Math.floor(rng() * 32)]).join('');

async function trial(sc, v, t, idx) {
  const rng = M.mulberry32(911 * (idx + 1) + 7919 * t);
  const token = rngToken(rng), payload = packToken(token);
  const code = { bits: v.bits, rs: v.rs || 32 };
  const slots = frameInfo(10, code).slots;
  const ref = 0.25 * 10 ** ((sc.gainDb || 0) / 20) / 0.5;          // frame amp 0.5 -> received tone amplitude
  const response = sc.tilt ? M.speakerGains(sc.tilt) : null;        // what the speaker does to each channel

  // the room, long enough for the pre-roll and the scored frame
  const lead = Math.floor((0.1 + 0.2 * rng()) * RATE);
  const frameLen = slots * SLOT;
  const x = new Float32Array(PRE_ROLL + lead + frameLen + Math.floor(0.4 * RATE));
  M.addNoise(x, 0.03, rng);
  sc.room?.(x, rng);

  // a previous broadcast in the pre-roll, through the same speaker (used for calibration)
  const prevPlan = await hopPlan(KEY, `n${idx}-${t}|cycle0`, slots);
  const air = (frame, at, gains) => { for (let i = 0; i < frame.length; i++) x[at + i] += ref * frame[i]; };
  const speaker = cal => Float32Array.from({ length: 96 }, (_, m) => (response ? response[m] : 1) * (cal ? cal[m] : 1));
  air(buildFrame(payload, prevPlan, { ...code, gains: speaker(null) }), Math.floor(0.5 * RATE));

  // what the phone learns before the scored frame
  const pre = x.slice(0, PRE_ROLL);
  let mask = null, gains = null, noisy = [], dead = [], weak = [];
  if (v.afh) {
    const mon = new ChannelMonitor();
    mon.push(pre.subarray(0, Math.floor(0.45 * RATE)));               // room only, before the previous broadcast
    mon.push(pre.subarray(Math.floor(0.45 * RATE)));
    noisy = mon.noisyChannels();
  }
  if (v.cal && response) {
    // calibration was done once at setup, phone held next to the speaker (reference level, quiet room): average
    // the tone levels of 4 decoded frames, like the range-test page does
    const sum = new Float64Array(96), cnt = new Float64Array(96);
    for (let k = 0; k < 4; k++) {
      const cp = await hopPlan(KEY, `cal${idx}-${t}|${k}`, slots);
      const cx = new Float32Array(frameLen + 20000);
      M.addNoise(cx, 0.03, rng);
      const f = buildFrame(payload, cp, { ...code, gains: response });
      for (let i = 0; i < f.length; i++) cx[5000 + i] += 0.5 * f[i];
      const r = decodeFrame(highPass(cx), cp, { ...code, levels: true });
      if (r.ok) r.toneLevel.forEach((lv, m) => { if (lv > 0) { sum[m] += lv; cnt[m]++; } });
    }
    const cal = calibrationFrom(Float64Array.from(sum, (v, m) => cnt[m] ? v / cnt[m] : NaN));
    if (cal) ({ gains, dead, weak } = cal);
  }
  // what the server does (server/link.js): dead, then noisy, then weak channels, at most 32 left out
  if (v.afh || weak.length) mask = maskFrom([...new Set([...dead, ...noisy, ...weak])].slice(0, 32), v.bits);

  // the scored frame
  const plan = await hopPlan(KEY, `n${idx}-${t}|cycle1`, slots);
  const at = PRE_ROLL + lead;
  air(buildFrame(payload, plan, { ...code, mask, gains: speaker(gains) }), at);
  if (sc.neighbour) {
    // another terminal's frames, back to back, on its own key
    for (let s = PRE_ROLL - frameLen, c = 0; s < x.length; s += frameLen + 0.44 * RATE, c++) {
      const f = buildFrame(packToken(rngToken(rng)), await hopPlan(OTHER_KEY, `nb${t}|${c}`, slots), code);
      const o = Math.floor(s + rng() * 0.3 * RATE);
      for (let i = 0; i < f.length; i++) if (o + i >= 0 && o + i < x.length) x[o + i] += ref * sc.neighbour * f[i];
    }
  }
  let rx = x.slice(PRE_ROLL);
  const clipped = sc.clip ? (M.clip(rx), clipMask(rx)) : null;
  if (v.harden) rx = highPass(rx);
  const r = decodeFrame(rx, plan, { ...code, mask, harden: v.harden, clipped: v.harden ? clipped : null, searchSeconds: 0.5 });
  return r.ok && unpackToken(r.payload) === token;
}

const [from, to] = (process.argv[3] || `0-${scenarios.length - 1}`).split('-').map(Number);
const names = process.env.VARIANTS ? process.env.VARIANTS.split(';') : Object.keys(VARIANTS);
console.log(`trials per cell: ${TRIALS} (95% CI about ±${(98 / Math.sqrt(TRIALS)).toFixed(0)} points near 50%)\n`);
console.log(`| scenario | ${names.join(' | ')} |`);
console.log(`|---|${names.map(() => '---').join('|')}|`);
for (const [idx, sc] of scenarios.entries()) {
  if (idx < from || idx > to) continue;
  const cells = [];
  for (const n of names) {
    let ok = 0;
    for (let t = 0; t < TRIALS; t++) ok += await trial(sc, VARIANTS[n], t, idx) ? 1 : 0;
    cells.push(`${(100 * ok / TRIALS).toFixed(0)}%`);
  }
  console.log(`| ${sc.name} | ${cells.join(' | ')} |`);
}
