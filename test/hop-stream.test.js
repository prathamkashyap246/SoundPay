// The hop path as SoundPay uses it: token -> 10 bytes -> POS frame on a cycle boundary -> room ->
// microphone chunks -> StreamDecoder (what the Web Worker runs) -> token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newToken } from '../server/tokens.js';
import { packToken, unpackToken, ALPHABET } from '../public/hop/token.js';
import { StreamDecoder } from '../public/hop/stream.js';
import { createEngine } from '../public/hop/engine.js';
import { deriveEpochKey, planFromEpochKey, epochOf, CYCLE_MS } from '../public/hop/timing.js';
import { buildFrame, frameInfo, RATE, SLOT, NCH } from '../public/hop/modem.js';
import { mulberry32, gauss, jammerPeriod } from '../tools/hopsim/channel.js';

const SECRET = new Uint8Array(32).map((_, i) => 200 - i);
const SLOTS = frameInfo(10).slots;

test('token packing: 16 characters <-> 10 bytes, lossless, and the alphabet matches the server', async () => {
  const server = await import('../server/tokens.js');
  for (let i = 0; i < 200; i++) {
    const t = newToken();
    const b = packToken(t);
    assert.equal(b.length, 10);
    assert.equal(unpackToken(b), t);
  }
  assert.equal(unpackToken(packToken('ABCD0000OOOO2222')), server.normalizeToken('ABCD0000OOOO2222'));
  assert.equal(new Set(ALPHABET).size, 32);
  assert.throws(() => packToken('short'));
  assert.throws(() => packToken('iiiiiiiiiiiiiiii'));
});

async function keysFor(terminalId, epochs, secret = SECRET) {
  return Promise.all(epochs.map(async epoch => ({ terminalId, epoch, key: await deriveEpochKey(secret, terminalId, epoch) })));
}

// Room recording starting at server time t0: the POS plays every cycle from g0 for `cycles` cycles,
// each frame arriving `delayMs` late. Optional random jammer.
async function room({ token, t0, seconds, g0, cycles, delayMs = 120, sigma = 0.03, jam = 0, seed = 1 }) {
  const rng = mulberry32(seed);
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) x[i] = sigma * gauss(rng);
  for (let g = g0; g < g0 + cycles; g++) {
    const key = await deriveEpochKey(SECRET, 'T1', epochOf(g));
    const f = buildFrame(packToken(token), await planFromEpochKey(key, g, SLOTS));
    const at = Math.round((g * CYCLE_MS + delayMs - t0) * RATE / 1000);
    for (let i = 0; i < f.length; i++) if (at + i >= 0 && at + i < x.length) x[at + i] += 0.5 * f[i];
  }
  if (jam) {
    const bins = Array.from({ length: NCH }, (_, i) => i).sort(() => rng() - 0.5).slice(0, Math.round(jam * NCH));
    const p = jammerPeriod(bins, 0.5, rng);
    for (let i = 0; i < x.length; i++) x[i] += p[i % SLOT];
  }
  return x;
}

async function listen(x, t0, keys, clockErrorMs = 0, chunk = 2048) {
  const got = [];
  const dec = new StreamDecoder({ onPayload: p => got.push(p) });
  dec.setKeys(keys);
  for (let i = 0; i < x.length; i += chunk) {
    dec.push(x.subarray(i, i + chunk), t0 + clockErrorMs + i * 1000 / RATE);
    await dec.process();
  }
  return got;
}

test('stream: every broadcast is heard, in order, from 2048-sample chunks', async () => {
  const token = newToken(), g0 = 600_007, t0 = g0 * CYCLE_MS - 1700;
  const x = await room({ token, t0, seconds: 12, g0, cycles: 3 });
  const got = await listen(x, t0, await keysFor('T1', [epochOf(g0) - 1, epochOf(g0), epochOf(g0) + 1]));
  assert.deepEqual(got.map(p => p.cycle), [g0, g0 + 1, g0 + 2]);
  for (const p of got) assert.equal(unpackToken(p.payload), token);
  assert.ok(Math.abs(got[0].delayMs - 120) < 10, `measured delay ${got[0].delayMs}`);
});

test('stream: survives phone clock errors of several seconds and odd chunk sizes', async () => {
  const token = newToken(), g0 = 700_003, t0 = g0 * CYCLE_MS - 500;
  const x = await room({ token, t0, seconds: 13, g0, cycles: 3, delayMs: 300 });
  const keys = await keysFor('T1', [epochOf(g0) - 1, epochOf(g0), epochOf(g0) + 1]);
  for (const [err, chunk] of [[2500, 128], [-4200, 4096], [5000, 1000]]) {
    const got = await listen(x, t0, keys, err, chunk);
    assert.ok(got.length >= 2, `clock error ${err}: heard ${got.length}`);
    assert.ok(got.every(p => unpackToken(p.payload) === token));
  }
});

test('stream: frames straddling an epoch boundary use both keys', async () => {
  const token = newToken(), g0 = 10 * 80_000 + 8, t0 = g0 * CYCLE_MS - 1000;    // cycles 8, 9 | 10, 11
  const x = await room({ token, t0, seconds: 15, g0, cycles: 4 });
  const got = await listen(x, t0, await keysFor('T1', [epochOf(g0), epochOf(g0) + 1]));
  assert.deepEqual(got.map(p => p.cycle), [g0, g0 + 1, g0 + 2, g0 + 3]);
});

test('stream: 25% of channels jammed, still heard', async () => {
  const token = newToken(), g0 = 800_001, t0 = g0 * CYCLE_MS - 1200;
  const x = await room({ token, t0, seconds: 12, g0, cycles: 3, jam: 0.25, seed: 5 });
  const got = await listen(x, t0, await keysFor('T1', [epochOf(g0), epochOf(g0) + 1]));
  assert.ok(got.length >= 2, `heard ${got.length} of 3`);
  assert.ok(got.every(p => unpackToken(p.payload) === token));
});

test('stream: wrong keys or another terminal hear nothing, and missing keys are requested', async () => {
  const token = newToken(), g0 = 900_001, t0 = g0 * CYCLE_MS - 1200;
  const x = await room({ token, t0, seconds: 10, g0, cycles: 2 });
  const epochs = [epochOf(g0), epochOf(g0) + 1];
  assert.equal((await listen(x, t0, await keysFor('T1', epochs, new Uint8Array(32).fill(1)))).length, 0);
  assert.equal((await listen(x, t0, await keysFor('T2', epochs))).length, 0);
  const asked = [];
  const dec = new StreamDecoder({ onStatus: s => asked.push(s) });
  dec.setKeys(await keysFor('T1', [1]));                      // only a key for a long-gone epoch
  dec.push(x, t0); await dec.process();
  assert.ok(asked.some(s => s.type === 'needKeys' && epochs.includes(s.epoch)));
});

test('engine (the Web Worker body): base64url keys, AudioContext timestamps, payload messages', async () => {
  const token = newToken(), g0 = 950_001, t0 = g0 * CYCLE_MS - 900;
  const x = await room({ token, t0, seconds: 10, g0, cycles: 2 });
  const out = [];
  const engine = createEngine(m => out.push(m));
  const keys = (await keysFor('T1', [epochOf(g0), epochOf(g0) + 1])).map(k => ({ ...k, key: Buffer.from(k.key).toString('base64url') }));
  const ctxStart = 12.5;                                       // AudioContext had been running 12.5 s
  engine.handle({ type: 'init', offsetMs: t0 - ctxStart * 1000, keys });
  for (let i = 0; i < x.length; i += 2048) {
    engine.handle({ type: 'audio', samples: x.slice(i, i + 2048), ctxTime: ctxStart + i / RATE });
    await new Promise(r => setImmediate(r));                   // audio arrives over time, not all at once
  }
  for (let i = 0; i < 50 && out.filter(m => m.type === 'payload').length < 2; i++) await new Promise(r => setTimeout(r, 20));
  const payloads = out.filter(m => m.type === 'payload');
  assert.equal(payloads.length, 2);
  assert.equal(unpackToken(payloads[0].payload), token);
});

test('robust profile: 5 s cycles, 8-tone sub-bands, keys by 30 s epoch, beats a follower jammer', async () => {
  const { PROFILES, epochOfCycle } = await import('../public/hop/profiles.js');
  const { addFollower } = await import('../tools/hopsim/channel.js');
  const { bits, cycleMs } = PROFILES.robust;
  const code = { bits };
  const token = newToken(), g0 = 400_003, t0 = g0 * cycleMs - 1300;
  const x = new Float32Array(17 * RATE);
  const rng = mulberry32(9);
  for (let i = 0; i < x.length; i++) x[i] = 0.03 * gauss(rng);
  const clean = new Float32Array(x.length);
  for (let g = g0; g < g0 + 3; g++) {
    const key = await deriveEpochKey(SECRET, 'T1', epochOfCycle(g, cycleMs));
    const f = buildFrame(packToken(token), await planFromEpochKey(key, g, frameInfo(10, code).slots), code);
    const at = Math.round((g * cycleMs + 150 - t0) * RATE / 1000);
    for (let i = 0; i < f.length && at + i < x.length; i++) clean[at + i] = 0.5 * f[i];
  }
  addFollower(x, clean, 32, rng, { amp: 0.5, minRms: 0.25 / Math.SQRT2 });
  for (let i = 0; i < x.length; i++) x[i] += clean[i];

  const epochs = [...new Set([g0, g0 + 1, g0 + 2].map(g => epochOfCycle(g, cycleMs)))];
  const got = [];
  const dec = new StreamDecoder({ code, cycleMs, onPayload: p => got.push(p) });
  dec.setKeys(await keysFor('T1', epochs));
  for (let i = 0; i < x.length; i += 2048) { dec.push(x.subarray(i, i + 2048), t0 + i * 1000 / RATE); await dec.process(); }
  assert.ok(got.length >= 2, `heard ${got.length} of 3 under a 32 ms follower`);
  assert.ok(got.every(p => unpackToken(p.payload) === token));
  // the fast profile's 6-bit receiver can't read robust frames
  const fast = await listen(x, t0, await keysFor('T1', epochs));
  assert.equal(fast.length, 0);
});

test('stream: idle listening is cheap enough for a phone (decode work per second of audio)', async () => {
  const g0 = 990_001, t0 = g0 * CYCLE_MS;
  const x = new Float32Array(9 * RATE).map(() => 0.03 * (Math.random() * 2 - 1));
  const keys = await keysFor('T1', [epochOf(g0) - 1, epochOf(g0), epochOf(g0) + 1]);
  const start = performance.now();
  await listen(x, t0, keys);
  const msPerSecond = (performance.now() - start) / 9;
  assert.ok(msPerSecond < 150, `${msPerSecond.toFixed(0)} ms of CPU per second of audio`);
});

test('link schedule: frames sent with a channel mask from fromMs on are decoded with that mask', async () => {
  const { maskFrom } = await import('../public/hop/monitor.js');
  const token = newToken(), g0 = 610_001, t0 = g0 * CYCLE_MS - 1100;
  const mask = maskFrom(Array.from({ length: 30 }, (_, i) => 40 + i));          // avoid channels 40..69
  const schedule = [{ fromMs: (g0 + 1) * CYCLE_MS, mask, gains: null }];
  const x = new Float32Array(12 * RATE);
  const rng = mulberry32(3);
  for (let i = 0; i < x.length; i++) x[i] = 0.03 * gauss(rng);
  for (let g = g0; g < g0 + 3; g++) {
    const key = await deriveEpochKey(SECRET, 'T1', epochOf(g));
    const f = buildFrame(packToken(token), await planFromEpochKey(key, g, SLOTS), { mask: g >= g0 + 1 ? mask : null });
    const at = Math.round((g * CYCLE_MS + 100 - t0) * RATE / 1000);
    for (let i = 0; i < f.length; i++) if (at + i < x.length) x[at + i] += 0.5 * f[i];
  }
  const got = [];
  const dec = new StreamDecoder({ onPayload: p => got.push(p) });
  dec.setKeys(await keysFor('T1', [epochOf(g0), epochOf(g0) + 1]));
  dec.setLink(schedule);
  for (let i = 0; i < x.length; i += 2048) { dec.push(x.subarray(i, i + 2048), t0 + i * 1000 / RATE); await dec.process(); }
  assert.deepEqual(got.map(p => p.cycle), [g0, g0 + 1, g0 + 2]);
  // masked frames never use the avoided channels; the decoder also reports levels for calibration
  assert.ok(got[2].toneLevel.slice(40, 70).every(v => !(v > 0)));
  assert.ok(got[2].snrDb > 20, `snr ${got[2].snrDb}`);
});

test('ChannelMonitor finds a persistent in-band whine and ignores speech below the band', async () => {
  const { ChannelMonitor } = await import('../public/hop/monitor.js');
  const M = await import('../public/lab/models.js');
  const rng = M.mulberry32(4);
  const x = new Float32Array(4 * RATE);
  M.addNoise(x, 0.03, rng);
  M.addSpeechMusic(x, rng, { level: 0.6 });
  M.addTones(x, [10, 11, 50], 0.3, rng);
  const mon = new ChannelMonitor();
  for (let i = 0; i < x.length; i += 2048) mon.push(x.subarray(i, i + 2048));
  assert.deepEqual([...mon.noisyChannels()].sort((a, b) => a - b), [10, 11, 50]);
});
