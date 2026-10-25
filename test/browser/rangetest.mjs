// Real-browser test of the range-test page: terminal + phone, a speaker that is weak at high frequencies
// (emulated in the phone's fake microphone), calibration, then a 20 s recording.
//   node test/browser/rangetest.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const PORT = 3980 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;
const root = path.resolve(import.meta.dirname, '../..');

const server = await new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), ORIGIN: BASE, POS_KEY: 'rt-key', DB_PATH: ':memory:', STRIPE_SECRET_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  proc.stdout.on('data', d => { if (String(d).includes('running')) resolve(proc); });
  proc.on('exit', code => reject(new Error(`server exited ${code}`)));
});

const terminalHook = () => {
  window.__sent = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const data = this.buffer.getChannelData(0);
    const wall = performance.timeOrigin + performance.now() + Math.max(0, when - this.context.currentTime) * 1000;
    const bytes = new Uint8Array(data.buffer.slice(0));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__sent.push({ wall, b64: btoa(bin) });
    return start.call(this, when, ...rest);
  };
};
// the phone's microphone: room noise, and everything played goes through a "laptop speaker" that is
// 15 dB weaker above 17 kHz, at an adjustable distance (gain)
const phoneHook = () => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext({ sampleRate: 48000 });
    const dest = ac.createMediaStreamDestination();
    const nb = ac.createBuffer(1, 96000, 48000), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = 0.02 * (Math.random() * 2 - 1);
    const ns = ac.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(dest); ns.start();
    const shelf = ac.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 17000; shelf.gain.value = -15;
    const distance = ac.createGain(); distance.gain.value = 0.3;
    shelf.connect(distance).connect(dest);
    window.__mic = { ac, shelf, distance };
    return dest.stream;
  };
  window.__play = (b64, wall) => {
    const { ac, shelf } = window.__mic;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new Float32Array(bytes.buffer), buf = ac.createBuffer(1, f.length, 48000);
    buf.getChannelData(0).set(f);
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(shelf);
    src.start(ac.currentTime + Math.max(0, (wall - performance.timeOrigin - performance.now()) / 1000));
  };
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
let ok = false;
let pump = null;
try {
  const tCtx = await browser.newContext(), pCtx = await browser.newContext({ permissions: ['microphone'] });
  const term = await tCtx.newPage(), phone = await pCtx.newPage();
  await term.addInitScript(terminalHook);
  await phone.addInitScript(phoneHook);
  for (const p of [term, phone]) {
    await p.goto(`${BASE}/rangetest.html`);
    await p.fill('#pos-key', 'rt-key');
    await p.click('#login-form button[type=submit]');
    await p.locator('#v-role').waitFor({ state: 'visible' });
  }
  await term.click('#as-terminal');
  await phone.click('#as-phone');
  await term.click('#t-toggle');
  pump = setInterval(async () => {
    try {
      for (const s of await term.evaluate(() => window.__sent.splice(0))) await phone.evaluate(([b, w]) => window.__play(b, w), [s.b64, s.wall]);
    } catch { /* page closing */ }
  }, 50);

  // calibrate close to the speaker
  await phone.click('#p-calibrate');
  await phone.waitForFunction(() => /Done:/.test(document.querySelector('#p-cal-status').textContent) || !document.querySelector('#error').hidden, null, { timeout: 70_000 });
  const cal = await phone.textContent('#p-cal-status');
  await new Promise(r => setTimeout(r, 13_000));             // the schedule switches 3 cycles ahead (9 s) + one send
  const terminalStatus = await term.textContent('#t-status');
  const terminalLink = await term.textContent('#t-link');

  // step back: record at "1 m" (6 dB quieter)
  await phone.evaluate(() => { window.__mic.distance.gain.value = 0.15; });
  await phone.fill('#p-distance', '1');
  await phone.click('#p-record');
  await phone.waitForFunction(() => document.querySelectorAll('#p-results tbody tr').length === 1, null, { timeout: 40_000 });
  const row = await phone.$$eval('#p-results tbody td', tds => tds.map(td => td.textContent).join(' | '));
  ok = /Done:/.test(cal) && /calibrated/.test(terminalStatus) && !/not calibrated/.test(terminalStatus) && /\d+\/\d+/.test(row);
  console.log(JSON.stringify({ calibration: cal, terminalStatus, terminalLink, resultRow: row, ok }));
} catch (err) {
  console.log(`FAILED: ${err.message}`);
} finally {
  clearInterval(pump);
  await browser.close();
  server.kill();
  process.exitCode = ok ? 0 : 1;
}
