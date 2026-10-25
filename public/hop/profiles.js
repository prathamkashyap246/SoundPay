// Hop profiles: a trade between speed and what the link survives. Measured in tools/hopsim/ (sim-attacks.js,
// sim-noise.js); see docs/HOPMODEM.md.
//
//   fast    6 bits per 64 ms slot, RS(32,16), 2.56 s frame, 3 s cycle. Beats random and replayed (targeted)
//           jamming and sweeps. Loses to a jammer that keeps moving one strong decoy tone (e.g. a follower),
//           and to a second terminal of the same loudness unless terminals take turns (TDMA_SLOT).
//   robust  8-tone sub-bands, 3 bits per slot, 4.61 s frame, 5 s cycle. Beats the follower / moving decoy and
//           a neighbouring terminal, but is weaker than fast when many channels are jammed continuously.
//   range   like fast with RS(48,16): 3.58 s frame, 4 s cycle. About 3 dB more distance (with speaker
//           calibration about 6 dB, i.e. roughly double the distance in free field), more jam margin.
//
// Keys are per 30 s epoch for all of them (a cycle belongs to the epoch its start time falls in).
export const EPOCH_MS = 30_000;

export const PROFILES = {
  fast: { name: 'fast', bits: 6, rs: 32, cycleMs: 3000 },
  robust: { name: 'robust', bits: 3, rs: 32, cycleMs: 5000 },
  range: { name: 'range', bits: 6, rs: 48, cycleMs: 4000 },
};

export const profileByName = name => PROFILES[name] || PROFILES.fast;
export const codeOf = p => ({ bits: p.bits, rs: p.rs });

// which 30 s key epoch a cycle belongs to (by its start time)
export const epochOfCycle = (g, cycleMs) => Math.floor(g * cycleMs / EPOCH_MS);

// The link settings (channel mask, pre-emphasis) in force for the cycle starting at cycleStartMs:
// the last schedule entry that has started by then. schedule: [{ fromMs, mask, gains }], sorted by fromMs.
export function linkAt(schedule, cycleStartMs) {
  let cur = null;
  for (const e of schedule || []) if (e.fromMs <= cycleStartMs) cur = e;
  return cur || { fromMs: 0, mask: null, gains: null };
}
