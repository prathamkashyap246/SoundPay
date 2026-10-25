import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hopPlan, flatPlan, NCH } from '../public/hop/hop.js';
import { buildFrame, decodeFrame, frameInfo, RATE } from '../public/hop/modem.js';

const key = new Uint8Array(32).fill(7);
const payload = Uint8Array.from([1, 2, 3, 250, 99, 17, 42, 255, 0, 128]);

function withLead(frame, lead = 5000, tail = 4000) {
  const x = new Float32Array(lead + frame.length + tail);
  x.set(frame, lead);
  return { x, lead };
}

test('hop plans: deterministic, key/context dependent, in range, roughly uniform', async () => {
  const a = await hopPlan(key, 'sess-1|0', 2000);
  const b = await hopPlan(key, 'sess-1|0', 2000);
  const c = await hopPlan(key, 'sess-1|1', 2000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every(v => v < NCH));
  const counts = new Array(NCH).fill(0); a.forEach(v => counts[v]++);
  assert.ok(Math.min(...counts) > 5 && Math.max(...counts) < 50);
});

test('clean round trip, hopping and flat', async () => {
  const { slots } = frameInfo(10);
  for (const plan of [await hopPlan(key, 's|0', slots), flatPlan(slots)]) {
    const { x, lead } = withLead(buildFrame(payload, plan));
    const r = decodeFrame(x, plan);
    assert.ok(r.ok, r.reason);
    assert.deepEqual(r.payload, payload);
    assert.ok(Math.abs(r.offset - lead) <= 64, `offset ${r.offset} vs ${lead}`);
  }
});

test('wrong key cannot decode', async () => {
  const { slots } = frameInfo(10);
  const right = await hopPlan(key, 's|0', slots);
  const wrong = await hopPlan(new Uint8Array(32).fill(9), 's|0', slots);
  const { x } = withLead(buildFrame(payload, right));
  assert.equal(decodeFrame(x, wrong).ok, false);
});

test('frame length is in the same range as ggwave (about 2-3 s)', () => {
  const s = frameInfo(10).seconds;
  assert.ok(s > 2 && s < 3.2, `${s}`);
});

// ---------------------------------------------------------------- timing
import { ServerClock, deriveEpochKey, candidateCycles, cycleOf, epochOf, buildFrameForCycle, decodeWithClock, CYCLE_MS, EPOCH_CYCLES } from '../public/hop/timing.js';

const secret = new Uint8Array(32).map((_, i) => i + 1);

test('epoch keys: deterministic, differ by epoch and by terminal', async () => {
  const a = await deriveEpochKey(secret, 'T1', 5), b = await deriveEpochKey(secret, 'T1', 5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, await deriveEpochKey(secret, 'T1', 6));
  assert.notDeepEqual(a, await deriveEpochKey(secret, 'T2', 5));
});

test('cycle math: 10 cycles per epoch, candidates most-likely first', () => {
  assert.equal(epochOf(cycleOf(0)), 0);
  assert.equal(epochOf(cycleOf(EPOCH_CYCLES * CYCLE_MS)), 1);
  assert.deepEqual(candidateCycles(CYCLE_MS * 100 + 5, 2), [100, 99, 101, 98, 102]);
});

test('ServerClock picks the lowest-RTT sample and corrects the offset', async () => {
  // local clock is 7000 ms behind the server; one sample has a slow round trip
  let local = 1_000_000, call = 0;
  const delays = [400, 40, 300];                       // total RTT per sample
  const now = () => local;
  const fetchServer = async () => { const d = delays[call++ % 3]; local += d / 2; const ts = local + 7000; local += d / 2; return ts; };
  const clock = new ServerClock();
  const r = await clock.sync(fetchServer, 3, now);
  assert.equal(r.rtt, 40);
  assert.ok(Math.abs(clock.offset - 7000) < 1, `offset ${clock.offset}`);
});

test('decodeWithClock: right cycle found despite clock error, including across an epoch boundary', async () => {
  const G = EPOCH_CYCLES * 7 + (EPOCH_CYCLES - 1);                     // last cycle of an epoch
  const frame = await buildFrameForCycle(payload, secret, 'T1', G);
  const x = new Float32Array(30000 + frame.length + 5000); x.set(frame, 30000);
  const trueEnd = G * CYCLE_MS + 2700;
  for (const err of [0, 400, -1200, 3500]) {
    const r = await decodeWithClock(x, { secret, terminalId: 'T1', estTimeMs: trueEnd + err });
    assert.ok(r.ok, `clock error ${err} ms: ${r.reason}`);
    assert.equal(r.cycle, G);
    assert.deepEqual(r.payload, payload);
  }
  // a different terminal's secret can't decode
  const wrong = await decodeWithClock(x, { secret, terminalId: 'T2', estTimeMs: trueEnd });
  assert.equal(wrong.ok, false);
});

// ---------------------------------------------------------------- Reed-Solomon
import { rsEncode, rsDecode } from '../public/hop/rs.js';
import { slotTones, PRE, SLOT, NCH as NCHANNELS } from '../public/hop/modem.js';

test('RS(32,16): corrects any mix with 2*errors + erasures <= 16, refuses beyond', () => {
  let seed = 99; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 400; t++) {
    const msg = Uint8Array.from({ length: 16 }, () => rnd(64));
    const rx = Array.from(rsEncode(msg, 32));
    const f = rnd(17), e = rnd(Math.floor((16 - f) / 2) + 1);
    const pos = [...Array(32).keys()].sort(() => rnd(3) - 1).slice(0, f + e);
    pos.slice(0, f).forEach(p => { rx[p] = -1; });
    pos.slice(f).forEach(p => { rx[p] = (rx[p] + 1 + rnd(63)) % 64; });
    assert.deepEqual(Array.from(rsDecode(rx, 16)), Array.from(msg));
  }
  const msg = Uint8Array.from({ length: 16 }, (_, i) => i * 3 % 64);
  const rx = Array.from(rsEncode(msg, 32));
  for (let p = 0; p < 10; p++) rx[p * 3] = (rx[p * 3] + 5) % 64;      // 10 errors > 8 allowed
  assert.equal(rsDecode(rx, 16), null);
});

test('modem with RS survives 5 silent slots plus 5 wrong-tone slots', async () => {
  const plan = await hopPlan(key, 'rs|0', frameInfo(10).slots);
  const frame = buildFrame(payload, plan);
  const x = new Float32Array(frame.length + 8000); x.set(frame, 3000);
  const slots = frameInfo(10).slots;
  // wipe 5 data slots (erasures) and replace 5 with a different tone (errors): 2*5 + 5 = 15 <= 16
  const other = (await import('../public/hop/modem.js')).toneWave(40);
  for (let n = 0; n < 5; n++) { const s = 3000 + (PRE + 3 * n) * SLOT; x.fill(0, s, s + SLOT); }
  for (let n = 0; n < 5; n++) { const s = 3000 + (PRE + 3 * n + 1) * SLOT; for (let i = 0; i < SLOT; i++) x[s + i] = 0.5 * other[i]; }
  const r = decodeFrame(x, plan);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.payload, payload);
});

test('sub-band mode (bits 3 and 2): round trip, sub-band layout, frame lengths', async () => {
  for (const [bits, slotsPerSym, tonesPerBand] of [[3, 2, 8], [2, 3, 4]]) {
    const code = { bits };
    const info = frameInfo(10, code);
    assert.equal(info.slots, PRE + 32 * slotsPerSym);
    const plan = await hopPlan(key, `sb${bits}|0`, info.slots);
    // every tone sits in the sub-band its hop chose
    slotTones(payload, plan, code).forEach((m, i) => assert.equal(Math.floor(m / tonesPerBand), plan[i] % (NCHANNELS / tonesPerBand)));
    const x = new Float32Array(info.slots * SLOT + 9000); x.set(buildFrame(payload, plan, code), 4000);
    const r = decodeFrame(x, plan, code);
    assert.ok(r.ok, r.reason);
    assert.deepEqual(r.payload, payload);
    assert.equal(decodeFrame(x, plan).ok, false, 'a 6-bit receiver must not accept a sub-band frame');
  }
  assert.throws(() => frameInfo(10, { bits: 4 }));
});

test('legacy repetition mode still works', async () => {
  const opts = { rs: 0, R: 2 };
  const plan = await hopPlan(key, 'rep|0', frameInfo(10, opts).slots);
  const x = new Float32Array(frameInfo(10, opts).slots * SLOT + 8000); x.set(buildFrame(payload, plan, opts), 2000);
  assert.deepEqual(decodeFrame(x, plan, opts).payload, payload);
});
