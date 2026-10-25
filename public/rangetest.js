// Range test + speaker calibration. One page, two roles:
//   terminal  plays a hop test frame every cycle, like a real sale (random token, nothing to pay)
//   phone     listens, records success rate / SNR / erasures at a distance you type, and calibrates the speaker
// Both are signed in with the POS key (the server accepts it for hop keys).
import { api, show, $, sleep } from '/common.js';
import { createTransmitter, startListening, drawBand } from '/audio.js';
import { ALPHABET } from '/hop/token.js';
import { frameInfo } from '/hop/modem.js';
import { profileByName, codeOf } from '/hop/profiles.js';

const VIEWS = ['v-login', 'v-role', 'v-terminal', 'v-phone'];
let profile = profileByName('fast');
let tdmaOf = 1;                                      // this terminal sends on every tdmaOf-th cycle

function showError(msg) { $('error').textContent = msg; $('error').hidden = !msg; }

async function init() {
  try {
    await api('/api/pos/me');
  } catch {
    return show('v-login', VIEWS);
  }
  try {
    const k = await api('/api/pos/hop/keys');
    profile = profileByName(k.profile?.name);
    tdmaOf = k.link?.tdma?.of || 1;
    $('profile-line').textContent = `Hop profile: ${profile.name} (${(frameInfo(10, codeOf(profile)).seconds).toFixed(2)} s frame every ${profile.cycleMs / 1000} s).`;
  } catch { /* shown as default */ }
  show('v-role', VIEWS);
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/pos/login', { key: $('pos-key').value }); showError(''); init(); }
  catch (err) { showError(err.message); }
});

// ---------------------------------------------------------------- terminal

let tx = null, running = false, sent = 0;
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => ALPHABET[b % 32]).join('');

$('as-terminal').addEventListener('click', () => { show('v-terminal', VIEWS); refreshLink(); setInterval(refreshLink, 3000); });

$('t-toggle').addEventListener('click', async () => {
  tx ??= createTransmitter();                        // inside the click: browsers need a gesture for audio
  running = !running;
  $('t-toggle').textContent = running ? 'Stop test broadcast' : 'Start test broadcast';
  if (!running) { tx.stop(); $('t-status').textContent = `Stopped after ${sent} frames.`; return; }
  const stopBand = drawBand($('t-band'), tx.analyser, tx.ctx.sampleRate);
  while (running) {
    const ok = await tx.send(randomToken()).then(() => true, err => { showError(err.message); return false; });
    if (ok) sent++;
    const l = tx.link;
    $('t-status').textContent = `${tx.mode === 'ggwave' ? 'ggwave (hop unavailable)' : 'Hopping'}: ${sent} frames sent` +
      (l ? ` · avoiding ${l.mask} channels · ${l.boosted ? 'calibrated' : 'not calibrated'} · slot ${l.tdma}` : '');
    await sleep(ok ? tx.gapMs : 1000);
  }
  stopBand();
});

async function refreshLink() {
  try {
    const l = await api('/api/pos/hop/link');
    const e = l.schedule.at(-1);
    const cal = l.calibration;
    $('t-link').textContent = [
      e?.mask ? `Avoiding ${96 - e.mask.length} of 96 channels` : 'Using all 96 channels',
      cal ? `speaker calibrated: ${cal.boostedChannels} channels boosted, ${cal.weak} weak, ${cal.dead} dead` : 'speaker not calibrated',
      `TDMA slot ${l.tdma.slot} of ${l.tdma.of}`,
    ].join(' · ');
  } catch { $('t-link').textContent = 'Could not load link settings.'; }
}

$('t-reset').addEventListener('click', async () => { await api('/api/pos/hop/calibration', { reset: true }); refreshLink(); });

// ---------------------------------------------------------------- phone

let listener = null;
const heard = [];                                     // { at, cycle, snrDb, erasures, cycleStartMs, toneLevel }
const rows = [];
let calibrating = null;

$('as-phone').addEventListener('click', () => show('v-phone', VIEWS));

async function ensureListening() {
  if (listener) return;
  listener = await startListening(() => {}, { onStatus });
  if (!listener.mode.startsWith('hop')) showError('Hop receiver unavailable on this browser: only ggwave would work here.');
}

function onStatus(s) {
  const box = $('l-meter-box'), text = $('l-meter');
  const bars = n => box.querySelectorAll('.bars i').forEach((b, i) => b.classList.toggle('on', i < n));
  if (s.type === 'heard') {
    heard.push({ at: Date.now(), ...s });
    const snr = s.snrDb ?? 0;
    bars(snr >= 25 ? 4 : snr >= 18 ? 3 : snr >= 12 ? 2 : 1);
    box.classList.toggle('warn', snr < 12);
    text.textContent = `Heard cycle ${s.cycle}: SNR ${snr.toFixed(0)} dB, ${s.erasures} erasures`;
    calibrating?.add(s);
  } else if (s.type === 'stats') {
    $('p-live').textContent = `Room ${s.roomDb.toFixed(0)} dBFS · in-band ${s.bandDb.toFixed(0)} dBFS · ` +
      `${s.noisy.length} noisy channels · clipping ${s.clippedPct.toFixed(2)}%`;
  }
}

$('p-record').addEventListener('click', async e => {
  const button = e.currentTarget;
  const metres = Number($('p-distance').value.replace(',', '.'));
  if (!(metres >= 0)) return showError('Type the distance in metres first.');
  showError('');
  button.disabled = true;
  try {
    await ensureListening();
    const seconds = 20, start = Date.now();
    for (let left = seconds; left > 0; left--) { button.textContent = `Recording… ${left}`; await sleep(1000); }
    const got = heard.filter(h => h.at >= start);
    const cycles = new Set(got.map(h => h.cycle));
    // frames that could have been fully heard and decoded inside the window
    const frameMs = frameInfo(10, codeOf(profile)).seconds * 1000;
    // (or, if more were heard, the span between the first and last cycle heard: misses inside it count)
    const span = cycles.size ? Math.floor((Math.max(...cycles) - Math.min(...cycles)) / tdmaOf) + 1 : 0;
    const expected = Math.max(1, span, Math.floor((seconds * 1000 - frameMs - 1700) / (profile.cycleMs * tdmaOf)) + 1);
    const snrs = got.map(h => h.snrDb).filter(v => v != null).sort((a, b) => a - b);
    const ers = got.map(h => h.erasures).sort((a, b) => a - b);
    rows.push({ metres, heard: cycles.size, expected, success: Math.min(1, cycles.size / expected),
      snr: snrs.length ? snrs[snrs.length >> 1] : null, erasures: ers.length ? ers[ers.length >> 1] : null });
    renderRows();
  } catch (err) { showError(err.message); }
  finally { button.disabled = false; button.textContent = 'Record 20 s'; }
});

function renderRows() {
  $('p-results').querySelector('tbody').innerHTML = rows.map(r => `<tr><td>${r.metres}</td><td>${r.heard}/${r.expected}</td>` +
    `<td>${Math.round(100 * r.success)}%</td><td>${r.snr == null ? '–' : `${r.snr.toFixed(0)} dB`}</td><td>${r.erasures ?? '–'}</td></tr>`).join('');
}

$('p-copy').addEventListener('click', async () => {
  const csv = ['metres,heard,expected,success,snr_db,median_erasures', ...rows.map(r => [r.metres, r.heard, r.expected, r.success.toFixed(2), r.snr?.toFixed(1) ?? '', r.erasures ?? ''].join(','))].join('\n');
  try { await navigator.clipboard.writeText(csv); $('p-copy').textContent = 'Copied'; } catch { showError(csv); }
});

// Calibration: reset the old calibration, then average the (normalised) tone levels of the next frames
// that were sent without pre-emphasis, and send them to the server.
$('p-calibrate').addEventListener('click', async e => {
  const button = e.currentTarget;
  button.disabled = true;
  showError('');
  try {
    await ensureListening();
    const reset = await api('/api/pos/hop/calibration', { reset: true });
    const from = reset.schedule.at(-1)?.fromMs ?? 0;
    const sum = new Float64Array(96), n = new Float64Array(96);
    let frames = 0, lastCycleStart = 0;
    const done = new Promise(resolve => {
      calibrating = {
        add(s) {
          if (!s.toneLevel || s.cycleStartMs < from) return;
          const seen = s.toneLevel.filter(v => v > 0).sort((a, b) => a - b);
          if (seen.length < 12) return;
          const ref = seen[Math.floor(seen.length * 0.9)];
          s.toneLevel.forEach((v, m) => { if (v > 0) { sum[m] += v / ref; n[m]++; } });
          frames++; lastCycleStart = s.cycleStartMs;
          $('p-cal-status').textContent = `Measured ${frames} frames, ${n.filter(c => c > 0).length} of 96 channels…`;
          if (frames >= 6 && n.filter(c => c > 0).length >= 80) resolve();
        },
      };
      setTimeout(resolve, 60_000);
    });
    $('p-cal-status').textContent = 'Waiting for frames… (is the terminal broadcasting?)';
    await done;
    calibrating = null;
    if (!frames) throw new Error('No frames heard: start the test broadcast on the terminal and hold the phone close.');
    const toneLevel = Array.from(sum, (v, m) => n[m] ? v / n[m] : null);
    const r = await api('/api/pos/hop/calibration', { toneLevel, cycleStartMs: lastCycleStart });
    const c = r.calibration;
    $('p-cal-status').textContent = `Done: ${c.boostedChannels} channels boosted, ${c.weak} weak, ${c.dead} dead. ` +
      `The terminal uses it from its next frames.`;
  } catch (err) { showError(err.message); }
  finally { calibrating = null; button.disabled = false; }
});

init();
