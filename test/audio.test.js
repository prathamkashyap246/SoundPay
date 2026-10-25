// Checks the audio layer without speakers: encode a token exactly like the POS does,
// make it quieter and add noise like a room would, and decode it like the phone does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newToken } from '../server/tokens.js';

const ggwaveFactory = createRequire(import.meta.url)('ggwave');
const g = await ggwaveFactory();
g.disableLog();

const PROTOCOL = g.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;   // same as public/audio.js
const RATE = 48000;

const bytesToFloats = int8 => new Float32Array(int8.slice().buffer);
const floatsToBytes = f32 => new Int8Array(f32.slice().buffer);

function instance() {
  const p = g.getDefaultParameters();
  p.sampleRateInp = RATE;
  p.sampleRateOut = RATE;
  return g.init(p);
}

// ggwave allows only a few instances at once, so reuse one for sending (like the POS).
const tx = instance();
function encode(text) {
  return bytesToFloats(g.encode(tx, text, PROTOCOL, 50));
}

// Feed audio to the decoder in 1024-sample chunks, like the phone's ScriptProcessor.
function decode(samples) {
  const rx = instance();
  try {
    for (let i = 0; i + 1024 <= samples.length; i += 1024) {
      const out = g.decode(rx, floatsToBytes(samples.subarray(i, i + 1024)));
      if (out && out.length) return new TextDecoder().decode(out);
    }
    return null;
  } finally {
    g.free(rx);     // the phone does the same when it stops listening
  }
}

// Seeded noise, so a run is repeatable (ggwave misses roughly 1 in 40 rooms at this noise level).
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

// Simulate a room: half a second of silence each side, quieter signal, random noise.
function throughRoom(signal, { gain, noise, seed = 1 }) {
  const random = rng(seed);
  const pad = RATE / 2;
  const out = new Float32Array(signal.length + 2 * pad);
  for (let i = 0; i < out.length; i++) {
    const s = i >= pad && i < pad + signal.length ? signal[i - pad] : 0;
    out[i] = gain * s + (random() * 2 - 1) * noise;
  }
  return out;
}

test('a token survives the trip through a noisy room', () => {
  for (let i = 0; i < 5; i++) {
    const token = newToken();
    assert.equal(decode(throughRoom(encode(token), { gain: 0.25, noise: 0.03, seed: 1000 + i })), token);
  }
});

test('broadcast is short enough to repeat several times per 30 s window', () => {
  const seconds = encode(newToken()).length / RATE;
  assert.ok(seconds < 2.5, `took ${seconds.toFixed(2)} s`);
});

test('the signal sits in the near-ultrasonic band (above 14 kHz)', () => {
  const s = encode(newToken());
  const middle = s.subarray(Math.floor(s.length / 2), Math.floor(s.length / 2) + 8192);
  const power = hz => {
    let re = 0, im = 0;
    for (let i = 0; i < middle.length; i++) {
      const a = (2 * Math.PI * hz * i) / RATE;
      re += middle[i] * Math.cos(a);
      im -= middle[i] * Math.sin(a);
    }
    return re * re + im * im;
  };
  let audible = 0, high = 0;
  for (let hz = 200; hz < 14000; hz += 100) audible += power(hz);
  for (let hz = 14000; hz < 21000; hz += 100) high += power(hz);
  assert.ok(high > 20 * audible, `high/audible energy ratio ${(high / audible).toFixed(1)}`);
});

test('garbage audio decodes to nothing', () => {
  const noise = new Float32Array(RATE * 3).map(() => (Math.random() * 2 - 1) * 0.1);
  assert.equal(decode(noise), null);
});
