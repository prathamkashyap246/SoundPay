// Frequency-hopping acoustic modem.
//
// Band: 15.0 - 19.5 kHz split into 96 tone slots (46.875 Hz apart).
// One slot = 3072 samples (64 ms at 48 kHz). Every tone fits a whole number of cycles in a
// slot, so tones are orthogonal and a 1024-point FFT (after folding) gives all 96 energies.
//
// Each slot carries ONE 6-bit symbol (0..63) as the tone  (symbol + hop[slot]) mod 96.
// Frame = PRE preamble slots (known symbols) + data slots. Each data symbol is sent R times
// on different hops; the receiver adds up evidence from all copies (soft combining).

import { rsEncode, rsDecode, RS_MAX_N } from './rs.js';

export const RATE = 48000;
export const SLOT = 3072;
export const NCH = 96;
export const NSYM = 64;
export const PRE = 8;
const F0_BIN = 960;                          // 15000 Hz / (48000/3072)
const BIN_STEP = 3;                          // 46.875 Hz / 15.625 Hz
const PRE_SYMS = Array.from({ length: PRE }, (_, i) => (i * 37) % NSYM);

// ---- tables ---------------------------------------------------------------
const cosF = new Float64Array(SLOT), sinF = new Float64Array(SLOT);
for (let i = 0; i < SLOT; i++) { cosF[i] = Math.cos(2 * Math.PI * i / SLOT); sinF[i] = Math.sin(2 * Math.PI * i / SLOT); }

const toneCache = new Array(NCH);
export function toneWave(m) {
  return toneCache[m] ??= Float32Array.from({ length: SLOT }, (_, n) => sinF[((F0_BIN + BIN_STEP * m) * n) % SLOT]);
}

// ---- 1024-point FFT -------------------------------------------------------
const FN = 1024;
const rev = new Uint16Array(FN);
for (let i = 0; i < FN; i++) { let r = 0; for (let b = 0; b < 10; b++) if (i & (1 << b)) r |= 1 << (9 - b); rev[i] = r; }
const twC = Float64Array.from({ length: FN / 2 }, (_, k) => Math.cos(2 * Math.PI * k / FN));
const twS = Float64Array.from({ length: FN / 2 }, (_, k) => -Math.sin(2 * Math.PI * k / FN));
function fft(re, im) {
  for (let i = 0; i < FN; i++) { const j = rev[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= FN; len <<= 1) {
    const half = len >> 1, step = FN / len;
    for (let i = 0; i < FN; i += len) for (let k = 0; k < half; k++) {
      const wr = twC[k * step], wi = twS[k * step], a = i + k, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
const mixC = Float64Array.from({ length: 16 }, (_, n) => Math.cos(2 * Math.PI * 5 * n / 16));
const mixS = Float64Array.from({ length: 16 }, (_, n) => -Math.sin(2 * Math.PI * 5 * n / 16));
const fre = new Float64Array(FN), fim = new Float64Array(FN);

// Energy in each of the 96 tone slots for the slot-long window starting at `start`.
export function slotSpectrum(x, start) {
  for (let n = 0; n < FN; n++) {
    const a = start + n, b = a + FN, c = b + FN;
    const v = (x[a] || 0) + (x[b] || 0) + (x[c] || 0);          // fold 3072 -> 1024
    fre[n] = v * mixC[n & 15]; fim[n] = v * mixS[n & 15];
  }
  fft(fre, fim);
  const e = new Float64Array(NCH);
  for (let m = 0; m < NCH; m++) e[m] = fre[m] * fre[m] + fim[m] * fim[m];
  return e;
}

// Fraction of the window's energy sitting in tone m (about 1 for a clean tone, ~0 for noise).
function toneFraction(x, start, m, windowEnergy) {
  if (windowEnergy <= 0) return 0;
  const k = F0_BIN + BIN_STEP * m;
  let re = 0, im = 0, idx = 0;
  for (let n = 0; n < SLOT; n++) {
    const v = x[start + n] || 0;
    re += v * cosF[idx]; im -= v * sinF[idx];
    idx += k; if (idx >= SLOT) idx -= SLOT; if (idx >= SLOT) idx %= SLOT;
  }
  return 2 * (re * re + im * im) / (SLOT * windowEnergy);
}

// ---- CRC + bit packing ----------------------------------------------------
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function toSymbols(bytes) {
  const syms = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 6) { syms.push((acc >> (bits - 6)) & 63); bits -= 6; acc &= (1 << bits) - 1; } }
  if (bits) syms.push((acc << (6 - bits)) & 63);
  return syms;
}
function fromSymbols(syms, nBytes) {
  const out = []; let acc = 0, bits = 0;
  for (const s of syms) { acc = (acc << 6) | s; bits += 6; while (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; } }
  return Uint8Array.from(out.slice(0, nBytes));
}

// Error correction: by default a Reed-Solomon code (rs.js). The 16 data symbols (payload + CRC-16) become
// an RS codeword of `rs` symbols (default 32), one per slot, each on its own hop. The receiver marks slots it
// can't read (jammed, ambiguous, hit by an impulse or clipped) as ERASURES and lets RS repair the rest:
// 2*errors + erasures <= rs - 16. Old mode (rs: 0): each symbol is repeated R times and the copies combined.
//
// Tone mapping, `bits` per slot, over the channel list G (all 96 channels, or the `mask` of good ones):
//   bits 6 (default)  tone = G[(symbol + hop) mod |G|]. Fast (one RS symbol per slot), but each slot's 64
//                     candidate tones cover 2/3 of the band, so ONE strong decoy tone anywhere usually wins.
//   bits 3 or 2       FH/MFSK sub-bands: the hop picks one of |G|/8 (or |G|/4) sub-bands of 8 (or 4) tones and
//                     the symbol picks a tone inside it. A decoy must guess the sub-band too. Each RS symbol
//                     takes 2 (or 3) slots, so frames are 2x (or 3x) longer.
// mask: adaptive frequency hopping. Both ends must use the same sorted channel list; channels the phone found
// noisy are left out. bits 6 needs at least 64 channels, sub-band modes at least 4 sub-bands.
const ALL = Array.from({ length: NCH }, (_, i) => i);
export const MIN_CHANNELS = { 6: 64, 3: 32, 2: 16 };

function layout(bits, mask) {
  const G = mask && mask.length ? mask : ALL;
  if (G.length < MIN_CHANNELS[bits]) throw new Error(`mask leaves ${G.length} channels, need ${MIN_CHANNELS[bits]}`);
  const M = 1 << bits;
  return { G, M, S: Math.floor(G.length / M), per: 6 / bits, bits };
}

export function frameInfo(payloadLen, { rs = 32, R = 2, bits = 6 } = {}) {
  const nSym = Math.ceil((payloadLen + 2) * 8 / 6);
  if (rs && (rs < nSym || rs > RS_MAX_N)) throw new Error(`rs must be between ${nSym} and ${RS_MAX_N}`);
  if (![6, 3, 2].includes(bits) || (bits !== 6 && !rs)) throw new Error('bits must be 6, or 3/2 with Reed-Solomon');
  const dataSlots = rs ? rs * (6 / bits) : nSym * R;
  return { nSym, slots: PRE + dataSlots, seconds: (PRE + dataSlots) * SLOT / RATE };
}

// the tone that carries value v (0..2^bits-1) in slot i
function toneFor(plan, i, v, L) {
  if (L.bits === 6) return L.G[(v + plan[i]) % L.G.length];
  return L.G[(plan[i] % L.S) * L.M + (v % L.M)];
}

// ---- transmit -------------------------------------------------------------
export function slotTones(payload, plan, { rs = 32, R = 2, bits = 6, mask = null } = {}) {
  const crc = crc16(payload);
  const syms = toSymbols(Uint8Array.from([...payload, crc >> 8, crc & 255]));
  const { slots } = frameInfo(payload.length, { rs, R, bits });
  const body = rs ? rsEncode(syms, rs) : null;
  const L = layout(bits, mask);
  const tones = new Uint8Array(slots);
  for (let i = 0; i < slots; i++) {
    let v;
    if (i < PRE) v = PRE_SYMS[i];
    else if (!body) v = syms[(i - PRE) % syms.length];
    else {
      const j = Math.floor((i - PRE) / L.per), c = (i - PRE) % L.per;       // chunk c of RS symbol j, high bits first
      v = bits === 6 ? body[j] : (body[j] >> (bits * (L.per - 1 - c))) & (L.M - 1);
    }
    tones[i] = toneFor(plan, i, v, L);
  }
  return tones;
}

// Slot edges get a 2 ms raised-cosine fade: without it every 64 ms tone change is a click that people
// (and dogs) hear, and that splatters energy across the band.
const RAMP = 96;
const ramp = Float32Array.from({ length: RAMP }, (_, n) => 0.5 - 0.5 * Math.cos(Math.PI * (n + 0.5) / RAMP));

// gains: optional per-channel amplitude factors (speaker pre-emphasis), peak amplitude is capped at maxAmp.
export function buildFrame(payload, plan, { rs = 32, R = 2, bits = 6, amp = 0.5, mask = null, gains = null, maxAmp = 0.95 } = {}) {
  const tones = slotTones(payload, plan, { rs, R, bits, mask });
  const out = new Float32Array(tones.length * SLOT);
  tones.forEach((m, i) => {
    const w = toneWave(m), a = Math.min(maxAmp, amp * (gains ? gains[m] : 1));
    for (let n = 0; n < SLOT; n++) {
      const env = n < RAMP ? ramp[n] : n >= SLOT - RAMP ? ramp[SLOT - 1 - n] : 1;
      out[i * SLOT + n] = a * env * w[n];
    }
  });
  return out;
}

// ---- receive --------------------------------------------------------------
const CAP = 5;                                // max log-evidence one slot can give a candidate
const SYNC_MIN = 0.003;
const HOT_RATIO = 30;                         // 15 dB above the noise floor counts as 'hot'
const HOT_FRACTION = 0.75;                    // hot in >=75% of slots => persistent interferer. Lower values let a
                                              // fast sweep (every channel briefly hot) trick the decoder into erasing everything
const MARGIN_MIN = 1.0;                       // best tone must beat the runner-up by this much, else erase
const EXTRA_ERASURES = [0, 2, 4, 6, 8];      // retry attempts: also erase the N least-confident slots
const IMPULSE_RATIO = 4;                      // slot whose broadband energy is 4x the frame's median: impulse
const CLIP_LEVEL = 0.98, CLIP_SAMPLES = 3;    // a slot with 3+ samples at full scale was clipped by the mic

// x: received audio (ideally already high-passed, see HighPass). clipped: optional Uint8Array aligned with x,
// 1 where the RAW microphone sample hit full scale (filtering hides clipping, so it is marked before).
// harden: false switches off impulse/clip erasures and per-channel noise floors (for comparisons).
export function decodeFrame(x, plan, {
  rs = 32, R = 2, bits = 6, mask = null, payloadLen = 10, searchSeconds = 0.4,
  hotFraction = HOT_FRACTION, harden = true, clipped = null, levels = false,
} = {}) {
  const { nSym, slots } = frameInfo(payloadLen, { rs, R, bits });
  const L = layout(bits, mask);
  let blanked = 0;
  if (harden) ({ x, blanked } = blankImpulses(x));
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i] * x[i];
  const win = s => prefix[Math.min(s + SLOT, x.length)] - prefix[Math.min(s, x.length)];
  const preTone = i => toneFor(plan, i, PRE_SYMS[i], L);
  const score = o => { let t = 0; for (let i = 0; i < PRE; i++) { const s = o + i * SLOT; t += toneFraction(x, s, preTone(i), win(s)); } return t / PRE; };

  // 1) find the frame start: coarse scan, then refine
  const maxOff = Math.min(Math.floor(searchSeconds * RATE), x.length - slots * SLOT);
  if (maxOff < 0) return { ok: false, reason: 'short' };
  let best = -1, bestO = 0;
  for (let o = 0; o <= maxOff; o += 384) { const s = score(o); if (s > best) { best = s; bestO = o; } }
  const lo = Math.max(0, bestO - 384), hi = Math.min(maxOff, bestO + 384);
  for (let o = lo; o <= hi; o += 48) { const s = score(o); if (s > best) { best = s; bestO = o; } }
  if (best < SYNC_MIN) return { ok: false, reason: 'nosync', sync: best };

  // 2) spectra for every slot, then NARROWBAND EXCISION: a signal tone appears in a given channel
  //    only now and then, but a jammer sits in the same channel in (nearly) every slot. Channels
  //    that are hot in many slots are treated as erased instead of as evidence.
  const spectra = [], slotFloor = [], broad = [];
  const hotCount = new Int32Array(NCH);
  for (let i = 0; i < slots; i++) {
    const e = slotSpectrum(x, bestO + i * SLOT);
    const sorted = Float64Array.from(e).sort();
    // 25th percentile = noise floor, but never more than 30 dB under the strongest tone: the fades at slot edges
    // leak a little energy into neighbours, which must not count as signal in a near-silent room
    const floor = Math.max(sorted[24], 1e-3 * sorted[NCH - 1]) + 1e-12;
    for (let m = 0; m < NCH; m++) if (e[m] / floor > HOT_RATIO) hotCount[m]++;
    let total = 0; for (let m = 0; m < NCH - 1; m++) total += sorted[m];   // everything but the strongest tone
    spectra.push(e); slotFloor.push(floor); broad.push(total);
  }
  const hotMin = Math.max(4, Math.ceil(hotFraction * slots));
  const erased = Array.from(hotCount, c => c >= hotMin);

  // HARDENING (a): each channel also gets its OWN floor, the median of that channel over the frame. Noise that
  // is louder in part of the band (a machine whining at 15-16 kHz) then stops looking like signal there.
  const chanFloor = new Float64Array(NCH);
  if (harden) for (let m = 0; m < NCH; m++) chanFloor[m] = Float64Array.from(spectra, e => e[m]).sort()[slots >> 1];
  const ratios = spectra.map((e, i) => Float64Array.from(e, (v, m) => (v + 1e-12) / Math.max(slotFloor[i], chanFloor[m])));

  // HARDENING (b): slots still carrying a broadband burst after blanking are erased outright: RS repairs an
  // erasure at half the cost of a wrong guess. Clipping is only counted (for the "too loud" hint): erasing
  // clipped slots cost more than it saved, because clipped low-frequency rumble barely touches our band.
  const badSlot = new Uint8Array(slots);
  let impulseSlots = 0, clippedSlots = 0;
  if (harden) {
    const med = Float64Array.from(broad.slice(PRE)).sort()[(slots - PRE) >> 1] + 1e-12;
    for (let i = PRE; i < slots; i++) if (broad[i] > IMPULSE_RATIO * med) { badSlot[i] = 1; impulseSlots++; }
  }
  if (clipped) {
    for (let i = PRE; i < slots; i++) {
      let c = 0;
      for (let n = bestO + i * SLOT, e = Math.min(n + SLOT, clipped.length); n < e && c < CLIP_SAMPLES; n++) c += clipped[n];
      if (c >= CLIP_SAMPLES) clippedSlots++;
    }
  }
  const evidence = rs ? null : ratios.slice(PRE).map(rt => Float64Array.from(rt, (v, m) => erased[m] ? 0 : Math.min(CAP, Math.max(0, Math.log(v)))));
  const meta = { offset: bestO, sync: best, hotChannels: erased.filter(Boolean).length, impulseSlots, clippedSlots, blanked };

  const finish = syms => {
    const bytes = fromSymbols(syms, payloadLen + 2);
    const payload = bytes.slice(0, payloadLen);
    return crc16(payload) === ((bytes[payloadLen] << 8) | bytes[payloadLen + 1]) ? payload : null;
  };

  // What arrived where: per channel, the received energy of our own tones and the noise floor. The phone sends
  // this to the server so the POS can boost weak tones (speaker roll-off) and skip noisy channels.
  const report = payload => {
    if (!levels) return {};
    const sent = slotTones(payload, plan, { rs, R, bits, mask });
    const sum = new Float64Array(NCH), n = new Int32Array(NCH);
    sent.forEach((m, i) => { if (!badSlot[i]) { sum[m] += spectra[i][m]; n[m]++; } });
    const toneLevel = Float64Array.from(sum, (s, m) => n[m] ? s / n[m] : NaN);
    const noise = Float64Array.from({ length: NCH }, (_, m) => Float64Array.from(spectra, e => e[m]).sort()[slots >> 2]);
    const snr = [];
    toneLevel.forEach((v, m) => { if (v > 0) snr.push(10 * Math.log10(v / (noise[m] + 1e-12))); });
    snr.sort((a, b) => a - b);
    return { toneLevel, noise, snrDb: snr.length ? snr[snr.length >> 1] : null };
  };

  if (rs) {
    // 3a) hard decision per slot + confidence margin; weak slots become erasures; Reed-Solomon repairs the rest.
    //     The margin uses UNCAPPED log ratios: a strong signal and a strong interferer would both hit CAP.
    const slotCand = ratios.slice(PRE).map((rt, i) => {
      if (badSlot[PRE + i]) return { v: 0, margin: 0 };
      let b = 0, bv = -1, sv = -1;
      for (let v = 0; v < L.M; v++) {
        const m = toneFor(plan, PRE + i, v, L);
        const e = erased[m] ? 0 : Math.max(0, Math.log(rt[m]));
        if (e > bv) { sv = bv; bv = e; b = v; } else if (e > sv) sv = e;
      }
      return { v: b, margin: bv - sv };
    });
    // one RS symbol = `per` consecutive slots; it is only as trustworthy as its weakest slot
    const cand = Array.from({ length: rs }, (_, j) => {
      let sym = 0, margin = Infinity;
      for (let c = 0; c < L.per; c++) { const sc = slotCand[j * L.per + c]; sym = (sym << bits) | sc.v; margin = Math.min(margin, sc.margin); }
      return { sym, margin };
    });
    const weakFirst = cand.map((c, i) => i).filter(i => cand[i].margin >= MARGIN_MIN).sort((a, b) => cand[a].margin - cand[b].margin);
    const natural = cand.filter(c => c.margin < MARGIN_MIN).length;
    for (const extra of EXTRA_ERASURES) {
      const rx = cand.map(c => c.margin < MARGIN_MIN ? -1 : c.sym);
      weakFirst.slice(0, extra).forEach(i => { rx[i] = -1; });
      if (rx.filter(v => v >= 0).length < nSym) break;
      const msg = rsDecode(rx, nSym);
      const payload = msg && finish(Array.from(msg));
      if (payload) return { ok: true, payload, erasures: natural + extra, reason: 'ok', ...meta, ...report(payload) };
    }
    return { ok: false, payload: null, erasures: natural, reason: 'rs', ...meta };
  }

  // 3b) repetition: soft-combine the R copies of each symbol
  const syms = [];
  for (let j = 0; j < nSym; j++) {
    let bestS = 0, bestV = -1;
    for (let s = 0; s < NSYM; s++) {
      let v = 0;
      for (let r = 0; r < R; r++) { const slot = PRE + r * nSym + j; v += evidence[slot - PRE][toneFor(plan, slot, s, L)]; }
      if (v > bestV) { bestV = v; bestS = s; }
    }
    syms.push(bestS);
  }
  const payload = finish(syms);
  return { ok: !!payload, payload, reason: payload ? 'ok' : 'crc', ...meta };
}

// ---- impulse blanking -----------------------------------------------------------
// Hammer blows, clangs and claps last a few ms but are far louder than our tone. Zeroing just those 2 ms blocks
// (instead of losing the whole 64 ms slot) keeps most of the tone. A block is an impulse when its energy is 6x
// the median of the blocks around it (+-32 ms): our own signal has a steady envelope (pre-emphasis is capped
// at +-6 dB, i.e. 4x energy), so it never trips this. Returns a copy.
const BLK = 96, NEIGH = 16, IMPULSE_BLOCK = 6;
export function blankImpulses(input) {
  const nb = Math.floor(input.length / BLK);
  const en = new Float64Array(nb);
  for (let b = 0; b < nb; b++) { let e = 0; for (let n = b * BLK; n < (b + 1) * BLK; n++) e += input[n] * input[n]; en[b] = e; }
  const x = Float32Array.from(input);
  let blanked = 0;
  const win = new Float64Array(2 * NEIGH + 1);
  for (let b = 0; b < nb; b++) {
    const lo = Math.max(0, b - NEIGH), hi = Math.min(nb - 1, b + NEIGH), w = win.subarray(0, hi - lo + 1);
    for (let k = lo; k <= hi; k++) w[k - lo] = en[k];
    w.sort();
    if (en[b] > IMPULSE_BLOCK * w[w.length >> 1] + 1e-9) { x.fill(0, b * BLK, (b + 1) * BLK); blanked++; }
  }
  return { x, blanked };
}

// ---- input filter -----------------------------------------------------------
// 4th-order Butterworth high-pass at 12 kHz (two biquads), streaming: keeps state between chunks.
// Removes speech, music, traffic and construction rumble BEFORE the decoder sees it, so they can't swamp the
// preamble search or leak into our band.
export class HighPass {
  constructor(fc = 12000, rate = RATE) {
    this.st = [];
    this.co = [0.5412, 1.3066].map(k => {          // 1 / Q of the two Butterworth sections (Q = 0.5412^-1, 1.3066^-1)
      const w = 2 * Math.PI * fc / rate, cw = Math.cos(w), al = Math.sin(w) * k / 2;
      const a0 = 1 + al;
      this.st.push([0, 0, 0, 0]);
      return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
    });
  }
  process(input, out = new Float32Array(input.length)) {
    out.set(input);
    this.co.forEach(([b0, b1, b2, a1, a2], k) => {
      const s = this.st[k];
      let [x1, x2, y1, y2] = s;
      for (let i = 0; i < out.length; i++) {
        const x0 = out[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0; out[i] = y0;
      }
      s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
    });
    return out;
  }
}
export const highPass = x => new HighPass().process(x);
export const clipMask = (x, level = CLIP_LEVEL) => Uint8Array.from(x, v => Math.abs(v) >= level ? 1 : 0);
