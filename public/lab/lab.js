// Jam Lab UI. All the signal work is in engine.js; this file wires controls, draws, and keeps score.
import { SYSTEMS, SCENARIOS, runTrial, spectrogram, enableGgwave, ggwaveAvailable } from './engine.js';

const $ = id => document.getElementById(id);
const state = { system: 'fast', scenario: 'random', knob: SCENARIOS.random.knob.value, adaptive: true, last: null, busy: false, seed: 1 };
const scores = new Map();          // `${scenario}|${knob}|${adaptive}` -> { system -> { ok, n } }

// ---------------------------------------------------------------- controls

function buildControls() {
  $('systems').innerHTML = Object.entries(SYSTEMS).map(([id, s]) => `
    <label class="sys"><input type="radio" name="system" value="${id}" ${id === state.system ? 'checked' : ''}>
      <b>${s.label}</b><small>${s.note}</small></label>`).join('');
  $('scenario').innerHTML = Object.entries(SCENARIOS).map(([id, s]) => `<option value="${id}">${s.label}</option>`).join('');
  $('scenario').value = state.scenario;
  document.querySelectorAll('input[name="system"]').forEach(r => r.addEventListener('change', () => { state.system = r.value; drawBars(); }));
  $('scenario').addEventListener('change', () => { state.scenario = $('scenario').value; state.knob = SCENARIOS[state.scenario].knob.value; syncKnob(); drawBars(); });
  $('knob').addEventListener('input', () => { state.knob = Number($('knob').value); showKnob(); drawBars(); });
  $('adaptive').addEventListener('change', () => { state.adaptive = $('adaptive').checked; drawBars(); });
  $('run1').addEventListener('click', () => run([state.system], 1));
  $('run10').addEventListener('click', () => run([state.system], 10));
  $('compare').addEventListener('click', () => run(Object.keys(SYSTEMS).filter(s => s !== 'ggwave' || ggwaveAvailable()), 10));
  $('play').addEventListener('click', play);
  syncKnob();
}

function syncKnob() {
  const k = SCENARIOS[state.scenario].knob;
  Object.assign($('knob'), { min: k.min, max: k.max, step: k.step, value: state.knob });
  $('knob-label').textContent = k.label;
  showKnob();
}
const knobText = () => { const k = SCENARIOS[state.scenario].knob; return `${state.knob}${k.unit === '%' ? '%' : k.unit ? ` ${k.unit}` : ''}`; };
function showKnob() { $('knob-out').textContent = knobText(); }

// ---------------------------------------------------------------- running

const pause = () => new Promise(r => setTimeout(r, 0));

async function run(systems, n) {
  if (state.busy) return;
  state.busy = true;
  document.querySelectorAll('.actions button').forEach(b => { b.disabled = b.id !== 'play'; });
  const key = `${state.scenario}|${state.knob}|${state.adaptive}`;
  if (!scores.has(key)) scores.set(key, {});
  const sc = scores.get(key);
  try {
    for (const system of systems) {
      sc[system] ??= { ok: 0, n: 0 };
      for (let i = 0; i < n; i++) {
        setPill('idle', `Running ${SYSTEMS[system].label} · ${i + 1} of ${n}`);
        await pause();
        const r = await runTrial({ system, scenario: state.scenario, knob: state.knob, adaptive: state.adaptive, seed: state.seed++ });
        sc[system].ok += r.ok ? 1 : 0;
        sc[system].n++;
        state.last = { ...r, system };
        if (system === state.system || systems.length === 1 || i === n - 1) showResult(state.last);
        drawBars();
      }
      logRow(system, sc[system]);
    }
  } catch (err) {
    setPill('bad', err.message);
  } finally {
    state.busy = false;
    document.querySelectorAll('.actions button').forEach(b => { b.disabled = false; });
    if (state.last) showResult(state.last);
  }
}

// ---------------------------------------------------------------- showing a run

function setPill(kind, text) { const p = $('pill'); p.className = `pill ${kind}`; p.textContent = text; }

function showResult(r) {
  setPill(r.ok ? 'ok' : 'bad', r.ok ? `Paid · ${SYSTEMS[r.system].label}` : `Not heard · ${SYSTEMS[r.system].label}`);
  $('sent').textContent = r.sent;
  const got = $('got');
  if (!r.got) got.textContent = 'nothing decoded';
  else got.innerHTML = [...r.got].map((c, i) => c === r.sent[i] ? c : `<span class="miss">${c}</span>`).join('');
  const d = r.details || {}, facts = [`<li>On air <b>${r.airtime.toFixed(2)} s</b></li>`];
  if (d.snrDb != null) facts.push(`<li>SNR <b>${d.snrDb.toFixed(0)} dB</b></li>`);
  if (d.erasures != null) facts.push(`<li>Slots repaired <b>${d.erasures}</b></li>`);
  if (d.avoided) facts.push(`<li>Channels avoided <b>${d.avoided}</b></li>`);
  if (d.hotChannels) facts.push(`<li>Jammed channels ignored <b>${d.hotChannels}</b></li>`);
  if (d.blanked) facts.push(`<li>Impulses blanked <b>${(d.blanked * 2).toFixed(0)} ms</b></li>`);
  if (d.boosted) facts.push('<li>Speaker <b>calibrated</b></li>');
  $('facts').innerHTML = facts.join('');
  drawSpectrogram(r.x);
}

function hexToRgb(h) { const v = h.trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)); }
function cssColor(name) { return hexToRgb(getComputedStyle(document.documentElement).getPropertyValue(name) || '#000000'); }

function drawSpectrogram(x) {
  const s = spectrogram(x);
  const c = $('spectro');
  c.width = s.cols; c.height = s.rows;
  const g = c.getContext('2d'), img = g.createImageData(s.cols, s.rows);
  const sorted = Float32Array.from(s.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.3)], hi = sorted[sorted.length - 1];
  const [bg, mid, top] = [cssColor('--scope'), cssColor('--signal'), cssColor('--hot')];
  for (let r = 0; r < s.rows; r++) {
    for (let col = 0; col < s.cols; col++) {
      const t = Math.max(0, Math.min(1, (s.data[r * s.cols + col] - lo) / (hi - lo + 1e-9)));
      const [a, b, u] = t < 0.6 ? [bg, mid, t / 0.6] : [mid, top, (t - 0.6) / 0.4];
      const o = ((s.rows - 1 - r) * s.cols + col) * 4;                 // high frequencies at the top
      for (let k = 0; k < 3; k++) img.data[o + k] = a[k] + (b[k] - a[k]) * u;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const secs = s.seconds, step = secs > 4 ? 1 : 0.5, ticks = [];
  for (let t = 0; t <= secs + 1e-6; t += step) ticks.push(`<span>${t.toFixed(step < 1 ? 1 : 0)}${t + step > secs ? ' s' : ''}</span>`);
  $('xax').innerHTML = ticks.join('');
}

let audio = null;
async function play() {
  if (!state.last) return;
  try {
    audio ??= new AudioContext({ sampleRate: 48000 });
    await audio.resume();
    const b = audio.createBuffer(1, state.last.x.length, 48000);
    b.getChannelData(0).set(state.last.x.map(v => v * 0.7));
    const src = audio.createBufferSource();
    src.buffer = b; src.connect(audio.destination); src.start();
  } catch (err) { setPill('bad', `Can't play audio here: ${err.message}`); }
}

// ---------------------------------------------------------------- scores

function drawBars() {
  const sc = scores.get(`${state.scenario}|${state.knob}|${state.adaptive}`) || {};
  const entries = Object.keys(SYSTEMS).filter(id => sc[id]?.n);
  $('bars-title').textContent = `Success rate · ${SCENARIOS[state.scenario].label} · ${SCENARIOS[state.scenario].knob.label.toLowerCase()} ${knobText()}${state.adaptive ? '' : ' · no adaptive hopping'}`;
  $('bars-empty').hidden = entries.length > 0;
  const best = Math.max(0, ...entries.map(id => sc[id].ok / sc[id].n));
  $('bars').innerHTML = entries.map(id => {
    const p = sc[id].ok / sc[id].n;
    const cls = p === 0 ? 'zero' : p === best ? 'best' : '';
    return `<div class="bar ${cls}"><span>${SYSTEMS[id].label}</span><div class="track"><div class="fill" style="width:${Math.max(2, 100 * p)}%"></div></div><output>${Math.round(100 * p)}%</output></div>`;
  }).join('');
}

function logRow(system, s) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${SCENARIOS[state.scenario].label}</td><td>${knobText()}</td><td>${SYSTEMS[system].label}</td>` +
    `<td>${state.adaptive && SYSTEMS[system].hop ? 'on' : '–'}</td><td class="num">${s.ok}</td><td class="num">${s.n}</td>`;
  $('log').prepend(tr);
}

// ---------------------------------------------------------------- start

async function start() {
  buildControls();
  if (typeof window.ggwave_factory === 'function') {
    try { enableGgwave(await window.ggwave_factory()); } catch { /* stays unavailable */ }
  }
  if (!ggwaveAvailable()) {
    const r = document.querySelector('input[name="system"][value="ggwave"]');
    if (r) { r.disabled = true; r.closest('.sys').querySelector('small').textContent = 'not available in this browser (needs WebAssembly)'; }
  }
  // open with one real run, so the page shows what it does
  await run(['fast'], 1);
}
start();
