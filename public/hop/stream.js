// Streaming receiver: the microphone delivers audio a few milliseconds at a time, forever.
//
// The POS starts cycle g's frame at g * cycleMs on the server clock. So once the phone has recorded
// past  g * cycleMs + frame + slack  it cuts out the region around that cycle and decodes it, trying
// g's hop plan first and then its neighbours (in case the phone's clock is off by a whole cycle).
// An early try right after the expected frame end (this cycle's plan only) usually wins; the full try
// after the slack catches late frames. The preamble search inside a region finds the exact frame start.
//
// Every successful decode also tells us how late frames really arrive (audio latency + clock error),
// and later regions are re-centred on that.
import { decodeFrame, frameInfo, HighPass, RATE } from './modem.js';
import { planFromEpochKey } from './timing.js';
import { PROFILES, epochOfCycle, linkAt } from './profiles.js';

const EARLY_MS = 200;                                // early try: this long after the expected frame end

export class StreamDecoder {
  // keys: Map `${terminalId}|${epoch}` -> Uint8Array epoch key
  // code: modem options ({ bits }); cycleMs: how often the POS starts a frame. Defaults = the "fast" profile.
  constructor({ payloadLen = 10, slackMs = 1500, spread = 2, code = {}, cycleMs = PROFILES.fast.cycleMs, onPayload = () => {}, onStatus = () => {} } = {}) {
    Object.assign(this, { payloadLen, slackMs, spread, code, cycleMs, onPayload, onStatus });
    const info = frameInfo(payloadLen, code);
    this.slots = info.slots;
    this.frameMs = info.seconds * 1000;
    this.keys = new Map();
    this.schedule = [];                             // link schedule from the server: channel mask per cycle
    this.terminals = new Set();
    this.decoded = new Set();                       // `${terminal}|${cycle}` already reported
    this.correctionMs = 0;                          // measured (actual - nominal) frame start
    this.plans = new Map();                         // small cache: same plan is tried for several regions
    this.capacity = Math.ceil((this.frameMs + 2 * slackMs + 2000) / 1000 * RATE);
    this.buf = new Float32Array(this.capacity);
    this.hp = new HighPass();                       // 12 kHz: speech, music, construction rumble never reach the decoder
    this.reset();
  }

  reset() {
    this.anchorMs = null;                           // server-clock time of absolute sample 0
    this.bufStart = 0;                              // absolute index of buf[0]
    this.len = 0;
    this.nextCycle = null;
    this.earlyTried = null;
  }

  setLink(schedule) { this.schedule = Array.isArray(schedule) ? schedule : []; }

  setKeys(list) {                                   // [{ terminalId, epoch, key: Uint8Array }]
    for (const { terminalId, epoch, key } of list) {
      this.terminals.add(terminalId);
      this.keys.set(`${terminalId}|${epoch}`, key);
    }
    if (this.keys.size > 64) for (const k of [...this.keys.keys()].slice(0, this.keys.size - 64)) this.keys.delete(k);
  }

  // samples: Float32Array at 48 kHz. startMs: server-clock time of samples[0].
  // A jump of more than 100 ms from where the stream should be (dropped audio, tab in background)
  // restarts the buffer instead of decoding audio with a hole in it.
  push(samples, startMs) {
    if (this.anchorMs === null || Math.abs(this.msAt(this.bufStart + this.len) - startMs) > 100) {
      this.reset();
      this.anchorMs = startMs;
      this.nextCycle = Math.floor((startMs - this.correctionMs + this.slackMs) / this.cycleMs);
    }
    let s = this.hp.process(samples);
    if (s.length > this.capacity) s = s.subarray(s.length - this.capacity);
    const overflow = this.len + s.length - this.capacity;
    if (overflow > 0) {
      this.buf.copyWithin(0, overflow, this.len);
      this.bufStart += overflow;
      this.len -= overflow;
    }
    this.buf.set(s, this.len);
    this.len += s.length;
  }

  msAt(index) { return this.anchorMs + index * 1000 / RATE; }
  indexAt(ms) { return Math.round((ms - this.anchorMs) * RATE / 1000); }

  // Decode every region that is now complete. Returns the payloads found.
  async process() {
    const found = [];
    if (this.anchorMs === null) return found;
    for (;;) {
      const g = this.nextCycle;
      const nominal = g * this.cycleMs + this.correctionMs;
      const have = this.bufStart + this.len;
      const start = Math.max(this.bufStart, this.indexAt(nominal - this.slackMs));

      // Early try: as soon as the frame should be over, with this cycle's plan only. When the timing is
      // already known (after the first decode) this is the one that succeeds, 1.3 s sooner.
      const early = this.indexAt(nominal + this.frameMs + EARLY_MS);
      if (this.earlyTried !== g && early <= have) {
        this.earlyTried = g;
        if (early - start >= this.slots * 3072) {
          const r = await this.attempt(start, early, [g]);
          if (r) { found.push(r); continue; }
        }
      }

      // Full try: the whole slack window, neighbouring cycles too.
      const end = this.indexAt(nominal + this.frameMs + this.slackMs);
      if (end > have) break;                                     // region not fully recorded yet
      this.nextCycle++;
      if (end - start < this.slots * 3072) continue;             // most of it is before we started listening
      const r = await this.attempt(start, end, this.order(g));
      if (r) found.push(r);
    }
    return found;
  }

  order(g) {
    const out = [g];
    for (let d = 1; d <= this.spread; d++) out.push(g - d, g + d);
    return out;
  }

  async attempt(start, end, cycles) {
    // a copy: more audio may arrive (and shift the buffer) while we await the hop plans
    const region = this.buf.slice(start - this.bufStart, end - this.bufStart);
    const regionStartMs = this.msAt(start);
    const r = await this.decodeRegion(region, cycles);
    if (!r) return null;
    const frameStartMs = regionStartMs + r.offset * 1000 / RATE;
    const err = frameStartMs - r.cycle * this.cycleMs;
    // From now on centre regions on where frames really land, numbered by the cycle that really decoded.
    // Going back to r.cycle + 1 re-reads a region that the old alignment may have cut in half.
    const limit = this.spread * this.cycleMs + this.slackMs;
    this.correctionMs = Math.max(-limit, Math.min(limit, err));
    this.nextCycle = r.cycle + 1;
    const out = {
      payload: r.payload, cycle: r.cycle, terminalId: r.terminalId, frameStartMs, delayMs: err, erasures: r.erasures,
      snrDb: r.snrDb, toneLevel: r.toneLevel, cycleStartMs: r.cycle * this.cycleMs, impulseSlots: r.impulseSlots,
    };
    this.onPayload(out);
    return out;
  }

  async plan(terminalId, g) {
    const id = `${terminalId}|${g}`;
    if (!this.plans.has(id)) {
      const key = this.keys.get(`${terminalId}|${epochOfCycle(g, this.cycleMs)}`);
      if (!key) return null;
      this.plans.set(id, await planFromEpochKey(key, g, this.slots));
      if (this.plans.size > 40) this.plans.delete(this.plans.keys().next().value);
    }
    return this.plans.get(id);
  }

  async decodeRegion(region, order) {
    const searchSeconds = (region.length / RATE) - this.frameMs / 1000 + 0.01;
    let missingKey = false;
    for (const terminalId of this.terminals) {
      for (const c of order) {
        if (this.decoded.has(`${terminalId}|${c}`)) continue;
        const plan = await this.plan(terminalId, c);
        if (!plan) { missingKey = true; continue; }
        const { mask } = linkAt(this.schedule, c * this.cycleMs);
        let r;
        try {
          r = decodeFrame(region, plan, { ...this.code, mask, payloadLen: this.payloadLen, searchSeconds, levels: true });
        } catch { continue; }                        // a mask that doesn't fit this profile: ignore that cycle
        if (r.ok) {
          this.decoded.add(`${terminalId}|${c}`);
          if (this.decoded.size > 200) this.decoded.delete(this.decoded.values().next().value);
          return { ...r, cycle: c, terminalId };
        }
      }
    }
    if (missingKey) this.onStatus({ type: 'needKeys', epoch: epochOfCycle(order[0], this.cycleMs) });
    return null;
  }
}
