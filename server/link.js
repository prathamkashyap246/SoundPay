// Link adaptation for the hop modem: which channels the POS hops over, and how loud each tone is.
//
//   noisy channels   phones report channels their ChannelMonitor found persistently noisy (machine whine,
//                    beacons, an aliased pest repeller, a jammer). Kept for 2 minutes after the last report.
//   calibration      the speaker's response per channel. Set by the POS operator (range-test page, phone held
//                    near the speaker) and refined by phones after each decoded frame. Gives boost-only
//                    pre-emphasis, plus weak/dead channels to leave out.
//   TDMA             with several terminals in one shop, terminal k of N only sends on cycles g = k (mod N).
//
// Changes take effect on a cycle boundary at least two cycles ahead, published as a schedule
// [{ fromMs, mask, gains }], so the POS and every listening phone switch on the same frame.
//
// Abuse limits: any signed-in customer can report, so at most 32 channels are ever left out (64+ always
// remain), reports expire, and the operator's calibration outweighs customer reports.
import { db } from './db.js';
import { config } from './config.js';
import { PROFILES } from '../public/hop/profiles.js';
import { calibrationFrom } from '../public/hop/monitor.js';
import { NCH, MIN_CHANNELS } from '../public/hop/modem.js';

const profile = PROFILES[config.hopProfile];
const MAX_AVOID = 32;
const NOISY_TTL_MS = 120_000;
const CUSTOMER_WEIGHT = 0.2, OPERATOR_WEIGHT = 1;

const state = {
  noisy: { channels: [], until: 0 },
  response: loadResponse(),        // Float64Array(96) relative energy per channel, or null
  schedule: [],
};

function loadResponse() {
  const row = db.prepare(`SELECT value FROM settings WHERE name = 'hop_response'`).get();
  if (!row) return null;
  try { const a = JSON.parse(row.value); return a.length === NCH ? Float64Array.from(a, v => v > 0 ? v : NaN) : null; } catch { return null; }
}
function saveResponse() {
  db.prepare(`INSERT INTO settings (name, value) VALUES ('hop_response', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(state.response ? Array.from(state.response, v => v > 0 ? +v.toPrecision(4) : 0) : []));
}

export const tdma = (() => {
  const m = /^(\d+)\/(\d+)$/.exec(config.tdmaSlot || '');
  const slot = m ? Number(m[1]) : 0, of = m ? Math.max(1, Number(m[2])) : 1;
  return { slot: slot % of, of };
})();

// ---- validation -------------------------------------------------------------------------------------

export function validChannels(list) {
  if (!Array.isArray(list) || list.length > NCH) return null;
  const out = [...new Set(list)].filter(v => Number.isInteger(v) && v >= 0 && v < NCH);
  return out.length === list.length ? out.sort((a, b) => a - b) : null;       // any bad or repeated entry: reject
}
export function validLevels(list) {
  if (!Array.isArray(list) || list.length !== NCH) return null;
  if (!list.every(v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))) return null;
  return Float64Array.from(list, v => v > 0 ? v : NaN);
}

// ---- the schedule -------------------------------------------------------------------------------------

function current(now) {
  let cur = null;
  for (const e of state.schedule) if (e.fromMs <= now) cur = e;
  return cur;
}

function desired(now) {
  const cal = state.response ? calibrationFrom(state.response) : null;
  const noisy = state.noisy.until > now ? state.noisy.channels : [];
  // dead first (unusable), then noisy (interference), then weak (speaker roll-off)
  const cap = Math.min(MAX_AVOID, NCH - MIN_CHANNELS[profile.bits]);
  const avoid = [...new Set([...(cal?.dead || []), ...noisy, ...(cal?.weak || [])])].slice(0, cap);
  const mask = avoid.length ? Array.from({ length: NCH }, (_, m) => m).filter(m => !avoid.includes(m)) : null;
  const gains = cal ? Array.from(cal.gains, g => +g.toFixed(3)) : null;
  return { mask, gains };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function update(now = Date.now()) {
  const want = desired(now);
  const last = state.schedule[state.schedule.length - 1];
  if (last ? (same(last.mask, want.mask) && same(last.gains, want.gains)) : (!want.mask && !want.gains)) return;
  const fromMs = (Math.floor(now / profile.cycleMs) + 3) * profile.cycleMs;     // two full cycles' notice
  state.schedule.push({ fromMs, ...want });
  // keep the entry in force plus anything newer, and anything a phone may still be decoding (last 60 s)
  const cur = current(now - 60_000);
  state.schedule = state.schedule.filter(e => e === cur || e.fromMs > now - 60_000);
}

export function linkInfo(now = Date.now()) {
  update(now);                                     // noisy reports may have expired
  return { schedule: state.schedule, tdma, maxAvoid: MAX_AVOID };
}

// The gains the POS used for the cycle that started at cycleStartMs (to undo them from a measurement).
function gainsAt(cycleStartMs) {
  let cur = null;
  for (const e of state.schedule) if (e.fromMs <= cycleStartMs) cur = e;
  return cur?.gains || null;
}

// A measurement of our own tones. Each one is normalised to its own strong channels first, so a phone far
// away and a phone close by count the same.
function mergeLevels(levels, cycleStartMs, weight) {
  const g = gainsAt(cycleStartMs);
  const resp = Float64Array.from(levels, (v, m) => v > 0 ? v / (g ? g[m] ** 2 : 1) : NaN);
  const seen = [...resp].filter(v => v > 0).sort((a, b) => a - b);
  if (seen.length < 12) return false;
  const ref = seen[Math.floor(seen.length * 0.9)];
  if (!state.response || weight >= 1) state.response = new Float64Array(NCH).fill(NaN);
  for (let m = 0; m < NCH; m++) {
    if (!(resp[m] > 0)) continue;
    const v = resp[m] / ref, old = state.response[m];
    state.response[m] = old > 0 ? (1 - weight) * old + weight * v : v;
  }
  saveResponse();
  return true;
}

// ---- reports ------------------------------------------------------------------------------------------

export function customerReport({ noisy, toneLevel, cycleStartMs }, now = Date.now()) {
  if (noisy) {
    state.noisy = noisy.length ? { channels: noisy.slice(0, MAX_AVOID), until: now + NOISY_TTL_MS } : { channels: [], until: 0 };
  }
  if (toneLevel) mergeLevels(toneLevel, cycleStartMs ?? now, CUSTOMER_WEIGHT);
  update(now);
  return linkInfo(now);
}

// Operator calibration: several frames' worth of levels, measured close to the speaker. Replaces the old one.
export function operatorCalibration({ toneLevel, cycleStartMs }, now = Date.now()) {
  if (!mergeLevels(toneLevel, cycleStartMs ?? now, OPERATOR_WEIGHT)) return null;
  update(now);
  return linkInfo(now);
}

export function resetCalibration(now = Date.now()) {
  state.response = null;
  saveResponse();
  state.noisy = { channels: [], until: 0 };
  update(now);
  return linkInfo(now);
}

export function calibrationSummary() {
  const cal = state.response ? calibrationFrom(state.response) : null;
  if (!cal) return null;
  return { boostedChannels: cal.gains.filter(g => g > 1.05).length, weak: cal.weak.length, dead: cal.dead.length };
}
