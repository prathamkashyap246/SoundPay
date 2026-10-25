// Data-over-audio. Two ways to carry the 16-character token:
//
//   hop     The frequency-hopping modem in /hop/ (default). 96 tones in 15-19.5 kHz; every 64 ms slot
//           jumps to a channel picked by a key the server hands out per 30 s, and every broadcast cycle
//           (3 s; 4 s in the range profile, 5 s in robust: /hop/profiles.js) uses a fresh pattern. Reed-Solomon repairs
//           jammed slots. Frames start exactly on cycle boundaries of the server's clock, so the phone knows
//           which pattern to expect.
//   ggwave  The original: ggwave ULTRASOUND_FAST (loaded as a global script, /vendor/ggwave.js).
//
// The phone always listens for both. The POS uses hop unless AUDIO_MODE=ggwave, the browser can't run
// audio at 48 kHz, or it can't get keys; then it falls back to ggwave.
import { packToken, unpackToken } from '/hop/token.js';
import { ServerClock, planFromEpochKey } from '/hop/timing.js';
import { profileByName, epochOfCycle, linkAt } from '/hop/profiles.js';
import { buildFrame, frameInfo, RATE } from '/hop/modem.js';
import { b64urlToBytes } from '/hop/engine.js';

const PROTOCOL = 'GGWAVE_PROTOCOL_ULTRASOUND_FAST';
const VOLUME = 50;                       // ggwave volume, 1-100
const HOP_AMP = 0.5;                     // hop frame peak amplitude (one tone at a time)
const LEAD_MS = 150;                     // schedule a frame at least this far ahead

let ggwavePromise = null;
function loadGgwave() {
  ggwavePromise ??= window.ggwave_factory().then(g => { g.disableLog(); return g; });
  return ggwavePromise;
}

// ggwave passes audio around as raw bytes; these just re-label the same memory.
const bytesToFloats = int8 => new Float32Array(int8.slice().buffer);
const floatsToBytes = f32 => new Int8Array(f32.slice().buffer);

function newInstance(g, sampleRate) {
  const params = g.getDefaultParameters();
  params.sampleRateInp = sampleRate;
  params.sampleRateOut = sampleRate;
  return g.init(params);
}

// The hop modem is built for 48 kHz. Most browsers resample the mic / speakers for us if asked.
function newContext() {
  try { return new AudioContext({ sampleRate: RATE }); } catch { return new AudioContext(); }
}

let configPromise = null;
const getConfig = () => (configPromise ??= fetch('/api/config').then(r => r.json()).catch(() => ({})));

async function getJson(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// Server clock + epoch keys, shared by both sides. Returns null if hop mode isn't possible.
// keysUrl / linkUrl: the POS and the phone use different (differently authorised) endpoints.
async function setupHop(ctx, keysUrl, linkUrl) {
  const cfg = await getConfig();
  if (cfg.audioMode === 'ggwave') return null;
  if (ctx.sampleRate !== RATE) { console.warn(`hop audio needs ${RATE} Hz, got ${ctx.sampleRate}: using ggwave`); return null; }

  const clock = new ServerClock();
  const keys = new Map();
  const state = { clock, keys, audioMode: cfg.audioMode || 'hop', terminalId: null, rtt: null, lastFetch: [], link: null, linkFetched: 0 };

  state.refresh = async () => {
    const k = await getJson(keysUrl);
    state.terminalId = k.terminalId;
    state.profile = profileByName(k.profile?.name);
    state.lastFetch = k.keys;
    if (k.link) { state.link = k.link; state.linkFetched = Date.now(); }
    for (const { terminalId, epoch, key } of k.keys) keys.set(`${terminalId}|${epoch}`, b64urlToBytes(key));
    return k.keys;
  };
  state.key = async epoch => {
    if (!keys.has(`${state.terminalId}|${epoch}`)) { await state.refresh(); await state.sync(); }
    return keys.get(`${state.terminalId}|${epoch}`) || null;
  };
  // channel mask + pre-emphasis schedule (adaptive hopping, speaker calibration) and the TDMA slot
  state.refreshLink = async () => {
    state.link = await getJson(linkUrl);
    state.linkFetched = Date.now();
    return state.link;
  };
  state.sync = async () => {
    const r = await clock.sync(async () => (await getJson('/api/time')).now, 5);
    state.rtt = r.rtt;
    state.syncedAt = Date.now();
    return r;
  };

  await state.refresh();
  await state.sync();
  return state;
}

// ---------------------------------------------------------------- POS side

// Call this directly inside a click handler: browsers only allow audio after a user gesture.
export function createTransmitter({ keysUrl = '/api/pos/hop/keys', linkUrl = '/api/pos/hop/link' } = {}) {
  const ctx = newContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(ctx.destination);
  let playing = null;
  let instance = null;
  let hopPromise = null;
  let lastCycle = -Infinity;
  let generation = 0;                  // bumped by stop(): a send that was still preparing must not play

  async function play(samples, whenCtxTime = 0) {
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    const done = new Promise(resolve => { src.onended = resolve; });
    playing = src;
    src.start(whenCtxTime);
    await done;
  }

  async function ggwaveSamples(text) {
    const g = await loadGgwave();
    instance ??= newInstance(g, ctx.sampleRate);
    return bytesToFloats(g.encode(instance, text, g.ProtocolId[PROTOCOL], VOLUME));
  }

  return {
    ctx, analyser,
    mode: 'starting',
    gapMs: 500,                        // pause pos.js leaves between sends (hop frames are already paced)

    async send(text) {
      const mine = generation;
      await ctx.resume();
      hopPromise ??= setupHop(ctx, keysUrl, linkUrl).catch(err => { console.warn('hop setup failed, using ggwave', err); return null; });
      const hop = await hopPromise;

      if (!hop) {
        this.mode = 'ggwave';
        this.gapMs = 500;
        const samples = await ggwaveSamples(text);
        if (mine !== generation) return;
        return play(samples);
      }
      this.mode = hop.audioMode;
      this.gapMs = 0;

      if (Date.now() - hop.linkFetched > 2000) await hop.refreshLink().catch(() => {});
      if (Date.now() - hop.syncedAt > 10 * 60_000) await hop.sync().catch(() => {});   // a terminal left on for days
      const { bits, rs, cycleMs } = hop.profile;
      const { slot, of } = hop.link?.tdma || { slot: 0, of: 1 };

      // next cycle boundary (server clock) at least LEAD_MS away that belongs to this terminal's TDMA slot
      let g = Math.ceil((hop.clock.now() + LEAD_MS) / cycleMs);
      if (g <= lastCycle) g = lastCycle + 1;
      while (g % of !== slot) g++;
      lastCycle = g;

      let samples;
      if (hop.audioMode === 'both' && Math.floor(g / of) % 2 === 1) {
        samples = await ggwaveSamples(text);
      } else {
        const key = await hop.key(epochOfCycle(g, cycleMs));
        if (!key) throw new Error('no hop key for this epoch');
        const payload = packToken(text);
        const plan = await planFromEpochKey(key, g, frameInfo(payload.length, { bits, rs }).slots);
        // adaptive hopping + pre-emphasis in force for this cycle (the phones switch on the same cycle)
        const { mask, gains } = linkAt(hop.link?.schedule, g * cycleMs);
        try {
          samples = buildFrame(payload, plan, { bits, rs, mask, gains, amp: HOP_AMP });
        } catch (err) {
          console.warn('link settings unusable, sending on all channels', err);
          samples = buildFrame(payload, plan, { bits, rs, amp: HOP_AMP });
        }
        this.link = { mask: mask ? 96 - mask.length : 0, boosted: !!gains, tdma: `${slot}/${of}` };
      }
      if (mine !== generation) return;
      // map the server-clock start time onto the AudioContext clock (output latency included)
      const delay = (g * cycleMs - hop.clock.now()) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
      return play(samples, ctx.currentTime + Math.max(0, delay));
    },

    stop() {
      generation++;
      try { playing?.stop(); } catch { /* already stopped */ }
    },

    close() {
      this.stop();
      ctx.close();
    },
  };
}

// ---------------------------------------------------------------- phone side

// The hop decoder runs in a Web Worker (or on this thread if workers are unavailable).
async function startDecoderEngine(onMessage) {
  try {
    const worker = new Worker('/hop/worker.js', { type: 'module' });
    // the worker says 'ready' once its modules loaded; a load failure (or no module-worker support) never does
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker did not start')); }, 4000);
      worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message || 'worker failed')); };
      worker.onmessage = e => { if (e.data?.type === 'ready') { clearTimeout(timer); resolve(); } };
    });
    worker.onmessage = e => onMessage(e.data);
    worker.onerror = e => console.warn('hop worker error', e.message);
    return { post: (m, t) => worker.postMessage(m, t || []), stop: () => worker.terminate(), where: 'worker' };
  } catch (err) {
    console.warn('hop worker unavailable, decoding on the main thread', err);
    const { createEngine } = await import('/hop/engine.js');
    const engine = createEngine(m => onMessage(m));
    return { post: m => engine.handle(m), stop() {}, where: 'main' };
  }
}

// server-clock ms = AudioContext time * 1000 + offset
function contextOffsetMs(ctx, clock) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0) return clock.now(performance.timeOrigin + ts.performanceTime) - ts.contextTime * 1000;
  return clock.now() - ctx.currentTime * 1000;
}

async function startHopReceiver(ctx, source, onText, onStatus) {
  const hop = await setupHop(ctx, '/api/hop/keys', '/api/hop/link');
  if (!hop) return null;

  // Reports to the server: persistently noisy channels (adaptive hopping) and how loud our own tones arrived
  // (speaker calibration). Fire and forget: a failed report never disturbs listening.
  let lastNoisy = '[]', lastNoisyAt = 0, lastLevelsAt = 0;
  const report = body => postJson('/api/hop/report', body)
    .then(link => { hop.link = link; engine.post({ type: 'link', schedule: link.schedule }); })
    .catch(() => {});

  const engine = await startDecoderEngine(async m => {
    if (m.type === 'payload') {
      onStatus?.({ type: 'heard', snrDb: m.snrDb, delayMs: m.delayMs, erasures: m.erasures, cycle: m.cycle, cycleStartMs: m.cycleStartMs, toneLevel: m.toneLevel });
      if (m.toneLevel && Date.now() - lastLevelsAt > 5000) { lastLevelsAt = Date.now(); report({ toneLevel: m.toneLevel, cycleStartMs: m.cycleStartMs }); }
      onText(unpackToken(m.payload));
    } else if (m.type === 'stats') {
      onStatus?.({ type: 'stats', ...m });
      const noisy = JSON.stringify(m.noisy || []);
      if (noisy !== lastNoisy && Date.now() - lastNoisyAt > 5000) { lastNoisy = noisy; lastNoisyAt = Date.now(); report({ noisy: m.noisy || [] }); }
    } else if (m.type === 'needKeys') {
      try { engine.post({ type: 'keys', keys: await hop.refresh() }); } catch { /* keep trying with what we have */ }
    } else if (m.type === 'error') console.warn('hop decoder:', m.message);
  });

  let tap = null, scriptTap = null;
  const channel = new MessageChannel();
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    await ctx.audioWorklet.addModule('/hop/mic-worklet.js');
    tap = new AudioWorkletNode(ctx, 'hop-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(tap);
    tap.connect(mute).connect(ctx.destination);
    engine.post({ type: 'init', offsetMs: contextOffsetMs(ctx, hop.clock), keys: hop.lastFetch, profile: hop.profile, schedule: hop.link?.schedule, port: channel.port2 }, [channel.port2]);
    tap.port.postMessage({ port: channel.port1 }, [channel.port1]);
  } else {
    // old browsers: the ggwave ScriptProcessor below forwards its blocks
    engine.post({ type: 'init', offsetMs: contextOffsetMs(ctx, hop.clock), keys: hop.lastFetch, profile: hop.profile, schedule: hop.link?.schedule });
    scriptTap = event => engine.post({ type: 'audio', samples: event.inputBuffer.getChannelData(0).slice(), ctxTime: event.playbackTime });
  }

  // keep the clock honest during a long listen (ctx and wall clocks can drift apart)
  const resync = setInterval(() => engine.post({ type: 'offset', offsetMs: contextOffsetMs(ctx, hop.clock) }), 5000);
  // follow link changes (another phone's report, a recalibration) while listening
  const linkPoll = setInterval(() => hop.refreshLink().then(l => engine.post({ type: 'link', schedule: l.schedule })).catch(() => {}), 3000);

  return {
    scriptTap,
    where: engine.where,
    stop() {
      clearInterval(resync);
      clearInterval(linkPoll);
      try { tap?.disconnect(); } catch { /* ignore */ }
      channel.port1.close();
      engine.stop();
    },
  };
}

// onStatus (optional): { type: 'stats', clippedPct, roomDb, bandDb, noisy } about once a second, and
// { type: 'heard', snrDb, erasures, cycle, cycleStartMs, toneLevel, delayMs } when a hop frame decoded.
// For the signal meter and the range-test page.
export async function startListening(onText, { onStatus } = {}) {
  const ctx = newContext();                  // created before any await (user gesture)

  // Phone browsers "clean up" the mic by default, which wipes out high frequencies.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  await ctx.resume();

  const g = await loadGgwave();
  const instance = newInstance(g, ctx.sampleRate);

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  let stopped = false;
  const heard = text => { if (!stopped) onText(text); };

  let hopRx = null;
  try {
    hopRx = await startHopReceiver(ctx, source, heard, onStatus);
  } catch (err) {
    console.warn('hop receiver failed, listening for ggwave only', err);
  }

  // ScriptProcessor is old but works on every phone browser. Feeds ggwave 1024 samples at a time.
  const processor = ctx.createScriptProcessor(1024, 1, 1);
  processor.onaudioprocess = event => {
    if (stopped) return;
    hopRx?.scriptTap?.(event);
    const result = g.decode(instance, floatsToBytes(event.inputBuffer.getChannelData(0)));
    if (result && result.length > 0) heard(new TextDecoder().decode(result));
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(ctx.destination);          // required for the processor to run; it outputs silence

  return {
    analyser, ctx,
    mode: hopRx ? `hop+ggwave (${hopRx.where})` : 'ggwave',
    stop() {
      if (stopped) return;
      stopped = true;
      hopRx?.stop();
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach(t => t.stop());
      g.free(instance);
      ctx.close();
    },
  };
}

// ---------------------------------------------------------------- spectrum strip

// Draws the 14-21 kHz slice of the spectrum: the band people can't (or barely) hear,
// which is exactly where the token travels.
export const BAND = { low: 14000, high: 21000 };

export function drawBand(canvas, analyser, sampleRate) {
  const g2d = canvas.getContext('2d');
  const data = new Uint8Array(analyser.frequencyBinCount);
  const binHz = sampleRate / analyser.fftSize;
  const first = Math.floor(BAND.low / binHz);
  const last = Math.min(Math.ceil(BAND.high / binHz), data.length - 1);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--signal').trim();
  const faint = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
  let frame = 0;

  function draw() {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    analyser.getByteFrequencyData(data);

    const bins = last - first + 1;
    const barW = w / bins;
    g2d.clearRect(0, 0, w, h);
    for (let i = 0; i < bins; i++) {
      const v = data[first + i] / 255;
      const barH = Math.max(2 * devicePixelRatio, v * (h - 8 * devicePixelRatio));
      g2d.fillStyle = v > 0.35 ? color : faint;
      g2d.fillRect(i * barW + 1, h - barH - 4 * devicePixelRatio, Math.max(1, barW - 2), barH);
    }
    frame = requestAnimationFrame(draw);
  }
  draw();
  return () => cancelAnimationFrame(frame);
}
