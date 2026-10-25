// Time-of-day (TOD) synchronisation for the hop plan.
//
//   key   = HKDF(merchantSecret, terminalId, epoch)      one key per 30 s window
//   plan  = HMAC-DRBG(key, "cycle<g>")                   one fresh pattern per 3 s broadcast cycle
//
// The clock only has to identify WHICH cycle a frame belongs to (about +-1.5 s accuracy). Finding the
// exact frame start is the preamble search's job, so no GPS-grade sync is needed.
import { hopPlan } from './hop.js';
import { decodeFrame, frameInfo } from './modem.js';

export const CYCLE_MS = 3000;                 // POS repeats its frame once per cycle (frame itself is ~2.6 s)
export const EPOCH_CYCLES = 10;               // 10 cycles = 30 s per key
const enc = new TextEncoder();

export const cycleOf = ms => Math.floor(ms / CYCLE_MS);
export const epochOf = g => Math.floor(g / EPOCH_CYCLES);
export const cycleStartMs = g => g * CYCLE_MS;
export const nextCycleStart = ms => (cycleOf(ms) + 1) * CYCLE_MS;

// ---- clock ----------------------------------------------------------------
// Estimates (server time - local time) from a few round trips and trusts the one with the lowest RTT.
// fetchServerMs: async () => server's current time in ms (e.g. GET /api/time).
export class ServerClock {
  offset = 0;
  async sync(fetchServerMs, samples = 5, now = () => Date.now()) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const t0 = now(), ts = await fetchServerMs(), t1 = now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: ts + rtt / 2 - t1 };
    }
    this.offset = best.offset;
    return best;                              // { rtt, offset }: expose rtt so the UI can warn on bad networks
  }
  now(local = Date.now()) { return local + this.offset; }
}

// ---- keys and plans --------------------------------------------------------
const keyCache = new Map();
export async function deriveEpochKey(secret, terminalId, epoch) {
  const id = `${Array.from(secret, b => b.toString(16).padStart(2, '0')).join('')}|${terminalId}|${epoch}`;
  if (!keyCache.has(id)) {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('hopmodem/v1'), info: enc.encode(`terminal=${terminalId}|epoch=${epoch}`) },
      base, 256);
    keyCache.set(id, new Uint8Array(bits));
    if (keyCache.size > 64) keyCache.delete(keyCache.keys().next().value);
  }
  return keyCache.get(id);
}

export async function planForCycle(secret, terminalId, g, slots) {
  return planFromEpochKey(await deriveEpochKey(secret, terminalId, epochOf(g)), g, slots);
}

// Same plan, starting from an already-derived epoch key (what phones and the POS get from the server).
export const planFromEpochKey = (epochKey, g, slots) => hopPlan(epochKey, `cycle${g}`, slots);

// Cycles the receiver should try, most likely first. Frames are sent in the PAST relative to when the
// receiver stops recording, so the estimate itself and the cycle before it come first.
export function candidateCycles(estTimeMs, spread = 2) {
  const g = cycleOf(estTimeMs), out = [g];
  for (let d = 1; d <= spread; d++) out.push(g - d, g + d);
  return out;
}

// ---- POS side -----------------------------------------------------------------
import { buildFrame } from './modem.js';
export async function buildFrameForCycle(payload, secret, terminalId, g, opts = {}) {
  const plan = await planForCycle(secret, terminalId, g, frameInfo(payload.length, opts).slots);
  return buildFrame(payload, plan, opts);    // POS plays this starting at cycleStartMs(g) on the server clock
}

// ---- phone side -----------------------------------------------------------------
// samples: the microphone buffer. estTimeMs: server-clock time at which the buffer ended.
export async function decodeWithClock(samples, { secret, terminalId, estTimeMs, payloadLen = 10, spread = 2, ...opts }) {
  const { slots } = frameInfo(payloadLen, opts);
  const searchSeconds = samples.length / 48000;
  let tries = 0;
  for (const g of candidateCycles(estTimeMs, spread)) {
    tries++;
    const plan = await planForCycle(secret, terminalId, g, slots);
    const r = decodeFrame(samples, plan, { ...opts, payloadLen, searchSeconds });
    if (r.ok) return { ...r, cycle: g, tries };
  }
  return { ok: false, tries, reason: 'no candidate cycle decoded' };
}
