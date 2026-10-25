// Message-driven wrapper around StreamDecoder. Runs inside the Web Worker (worker.js), or on the main
// thread when workers aren't available. Messages in:
//   { type: 'init', offsetMs, keys, profile?, port? }   offsetMs: server-clock ms = audioContext time * 1000 + offsetMs
//                                             profile: { bits, cycleMs } from profiles.js (default: fast)
//   { type: 'keys', keys }                    keys: [{ terminalId, epoch, key: base64url }]
//   { type: 'offset', offsetMs }
//   { type: 'link', schedule }                link schedule (channel masks) from the server
//   { type: 'audio', samples: Float32Array, ctxTime }   ctxTime: AudioContext time of samples[0]
// Messages out: { type: 'payload', payload, cycle, terminalId, delayMs, snrDb, toneLevel, cycleStartMs },
//               { type: 'needKeys', epoch },
//               { type: 'stats', clippedPct, roomDb, bandDb, noisy } about once a second (ChannelMonitor)
import { StreamDecoder } from './stream.js';
import { ChannelMonitor } from './monitor.js';

export function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function createEngine(post) {
  const make = (p = {}) => new StreamDecoder({ code: { bits: p.bits ?? 6, rs: p.rs ?? 32 }, cycleMs: p.cycleMs, onStatus: s => post(s) });
  let dec = make();
  const monitor = new ChannelMonitor();
  let monitored = 0;
  let offsetMs = 0, busy = false, again = false;
  const setKeys = keys => dec.setKeys(keys.map(k => ({ ...k, key: typeof k.key === 'string' ? b64urlToBytes(k.key) : k.key })));

  async function run() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for (const f of await dec.process()) {
          post({ type: 'payload', payload: f.payload, cycle: f.cycle, terminalId: f.terminalId, delayMs: f.delayMs,
            snrDb: f.snrDb, erasures: f.erasures, toneLevel: f.toneLevel ? Array.from(f.toneLevel, v => v > 0 ? v : null) : null, cycleStartMs: f.cycleStartMs });
        }
      } while (again);
    } catch (err) {
      post({ type: 'error', message: String(err?.message || err) });
    } finally { busy = false; }
  }

  function handle(m) {
    if (m.type === 'init') {
      if (m.profile) dec = make(m.profile);
      if (m.schedule) dec.setLink(m.schedule);
      offsetMs = m.offsetMs;
      if (m.keys) setKeys(m.keys);
      if (m.port) m.port.onmessage = e => handle(e.data);       // audio straight from the AudioWorklet
    } else if (m.type === 'keys') setKeys(m.keys);
    else if (m.type === 'offset') offsetMs = m.offsetMs;
    else if (m.type === 'link') dec.setLink(m.schedule);
    else if (m.type === 'audio') {
      monitor.push(m.samples);                                // raw: it needs to see clipping
      monitored += m.samples.length;
      if (monitored >= 48000) { monitored = 0; post({ type: 'stats', ...monitor.stats() }); }
      dec.push(m.samples, m.ctxTime * 1000 + offsetMs);
      run();
    }
  }
  return { handle, get decoder() { return dec; } };
}
