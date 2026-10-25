// Real-browser end-to-end test (headless Chromium via Playwright). Not part of `npm test`.
//
//   node test/browser/e2e.mjs [mode=hop|ggwave|both|qr] [jam=0]
//   qr: no sound at all. The phone opens the link in the POS's QR code (decoded from the SVG it drew).
//   jam: a fraction of channels jammed with steady tones (e.g. 0.25), or follower<ms> (e.g. follower32) for a
//        reactive jammer that hears each POS tone and answers with a stronger decoy (tools/hopsim/channel.js).
//   Environment: HOP_PROFILE=robust selects the robust hop profile; E2E_NO_WORKER=1 / E2E_NO_WORKLET=1 remove
//   Web Workers / AudioWorklet from the phone page to exercise the fallbacks.
//
// Two pages, like demo day: the POS terminal and the customer's phone. The POS page's real audio code
// runs (server clock, keys, frame synthesis, scheduling on cycle boundaries). Every buffer it schedules is
// captured and played into the phone page's microphone at the same wall-clock time, mixed with room
// noise (and optionally a jammer). The phone page's real receiver runs (AudioWorklet -> Web Worker
// decoder, plus ggwave), then the customer approves with a virtual passkey and both screens must say Paid.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { addFollower, mulberry32 } from '../../tools/hopsim/channel.js';

// `npm i -D playwright && npx playwright install chromium` locally; a global install also works.
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const MODE = process.argv[2] || 'hop';
const JAM_ARG = process.argv[3] || '0';
const FOLLOWER_MS = /^follower(\d+)$/.exec(JAM_ARG)?.[1];
const JAM = FOLLOWER_MS ? 0 : Number(JAM_ARG);
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;
const root = path.resolve(import.meta.dirname, '../..');

function startServer() {
  const proc = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), ORIGIN: BASE, POS_KEY: 'e2e-key', DB_PATH: ':memory:', STRIPE_SECRET_KEY: '', AUDIO_MODE: MODE === 'qr' ? 'hop' : MODE },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('running')) resolve(proc); });
    proc.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
}

// POS page: record every AudioBuffer it starts, with the wall-clock time it will actually play.
const posHook = () => {
  window.__sent = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const ctx = this.context;
    const data = this.buffer.getChannelData(0);
    const wall = performance.timeOrigin + performance.now() + Math.max(0, when - ctx.currentTime) * 1000;
    const bytes = new Uint8Array(data.buffer.slice(0));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    window.__sent.push({ wall, rate: this.buffer.sampleRate, b64: btoa(bin) });
    return start.call(this, when, ...rest);
  };
};

// Phone page: the microphone is a MediaStream we control: room noise + optional jammer + whatever
// the test plays into it with __play().
const phoneHook = ({ jam, noWorker, noWorklet }) => {
  window.__played = 0;
  if (noWorker) window.Worker = undefined;                     // old browser: decoder must run on the page
  if (noWorklet) window.AudioWorkletNode = undefined;          // old browser: ScriptProcessor feeds the decoder
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext({ sampleRate: 48000 });
    const dest = ac.createMediaStreamDestination();
    const noise = ac.createBuffer(1, 48000 * 2, 48000);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = 0.02 * (Math.random() * 2 - 1);
    const ns = ac.createBufferSource();
    ns.buffer = noise; ns.loop = true; ns.connect(dest); ns.start();
    if (jam > 0) {
      const chans = Array.from({ length: 96 }, (_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.round(jam * 96));
      for (const m of chans) {
        const o = ac.createOscillator(), gn = ac.createGain();
        o.frequency.value = 15000 + 46.875 * m; gn.gain.value = 0.2;    // 2x the signal's tone amplitude
        o.connect(gn).connect(dest); o.start();
      }
    }
    window.__mic = { ac, dest };
    return dest.stream;
  };
  window.__play = (b64, wall, rate) => {
    const { ac, dest } = window.__mic;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new Float32Array(bytes.buffer);
    const buf = ac.createBuffer(1, f.length, rate);
    buf.getChannelData(0).set(f);
    const src = ac.createBufferSource(), gain = ac.createGain();
    gain.gain.value = 0.2;                                     // the trip through the air: -14 dB
    src.buffer = buf; src.connect(gain).connect(dest);
    const now = performance.timeOrigin + performance.now();
    src.start(ac.currentTime + Math.max(0, (wall - now) / 1000));
    window.__played++;
  };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitVisible(page, sel, ms = 20000) { await page.locator(sel).waitFor({ state: 'visible', timeout: ms }); }

const server = await startServer();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
const logs = [];
let ok = false;
try {
  const posCtx = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  const phoneCtx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // E2E_SHOTS=<dir>: save screenshots of each step (used for docs/screenshots)
  const shot = async (page, name) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`) }); };
  const pos = await posCtx.newPage();
  const phone = await phoneCtx.newPage();
  for (const [name, p] of [['pos', pos], ['phone', phone]]) {
    p.on('console', m => logs.push(`[${name}] ${m.type()}: ${m.text()}`));
    p.on('pageerror', e => logs.push(`[${name}] PAGE ERROR: ${e.message}`));
  }
  await pos.addInitScript(posHook);
  await phone.addInitScript(phoneHook, { jam: JAM, noWorker: !!process.env.E2E_NO_WORKER, noWorklet: !!process.env.E2E_NO_WORKLET });

  // virtual passkey for the phone
  const cdp = await phoneCtx.newCDPSession(phone);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });

  // customer signs up and saves the demo card
  await phone.goto(`${BASE}/pay.html`);
  await waitVisible(phone, '#v-signup');
  await phone.fill('#name', 'Test Customer');
  await phone.click('#signup-form button[type=submit]');
  await waitVisible(phone, '#v-card');
  await phone.click('#card-save');
  await waitVisible(phone, '#v-ready');

  // cashier rings up ₹450
  await pos.goto(`${BASE}/pos.html`);
  await waitVisible(pos, '#v-login');
  await pos.fill('#pos-key', 'e2e-key');
  await pos.click('#login-form button[type=submit]');
  await waitVisible(pos, '#v-amount');
  await pos.fill('#amount', '450');
  await pos.click('#amount-form button[type=submit]');
  await waitVisible(pos, '#v-charging');
  const posCode = await pos.textContent('#c-code');

  const t0 = Date.now();

  if (MODE === 'qr') {
    // the QR on the POS must encode the pay link for this sale; read it back from the drawn modules
    const svg = await pos.innerHTML('#c-qr');
    if (!svg.includes('<svg')) throw new Error('POS shows no QR code');
    const url = await pos.evaluate(() => `${location.origin}/pay.html#t=${document.querySelector('#c-token').textContent.replace(/\s+/g, '')}`);
    const check = await pos.evaluate(u => {
      const q = qrcode(0, 'M'); q.addData(u); q.make();
      const d = document.createElement('div'); d.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      return d.innerHTML;                                       // same serialisation as the POS's own box
    }, url);
    if (check !== svg) throw new Error('QR content does not match the pay link');
    await phone.goto(url);
  } else {
    await phone.click('#pay');
    await waitVisible(phone, '#v-listen');
    await sleep(1500);
    await shot(phone, 'phone-listening');
  }

  // carry sound from the POS to the phone until the phone shows the confirm screen
  let forwarded = 0;
  while (Date.now() - t0 < 40_000) {
    const sent = await pos.evaluate(() => window.__sent.splice(0));
    if (MODE === 'qr') sent.length = 0;                          // no microphone in this mode
    for (const s of sent) {
      await phone.evaluate(([b, w, r]) => window.__play(b, w, r), [s.b64, s.wall, s.rate]);
      forwarded++;
      if (forwarded === 1) setTimeout(() => shot(pos, 'pos-charging').catch(() => {}), Math.max(0, s.wall - Date.now()) + 1200);
      if (FOLLOWER_MS) {
        // the follower hears this buffer at full strength and answers with decoys twice as strong
        const clean = new Float32Array(Buffer.from(s.b64, 'base64').buffer.slice(0));
        const peak = clean.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        const jam = new Float32Array(clean.length);
        addFollower(jam, clean, Number(FOLLOWER_MS), mulberry32(forwarded), { amp: 2 * peak, minRms: peak / Math.SQRT2 });
        await phone.evaluate(([b, w, r]) => window.__play(b, w, r), [Buffer.from(jam.buffer).toString('base64'), s.wall, s.rate]);
      }
    }
    if (await phone.locator('#v-confirm').isVisible()) break;
    await sleep(40);
  }
  const heardAfter = (Date.now() - t0) / 1000;
  const listenMode = await phone.textContent('#l-mode');
  const posMode = await pos.textContent('#c-mode');
  if (!await phone.locator('#v-confirm').isVisible()) throw new Error(`phone did not hear the POS within 40 s (${forwarded} buffers sent)`);
  await shot(phone, 'phone-confirm');
  const phoneCode = await phone.textContent('#k-code');
  if (phoneCode !== posCode) throw new Error(`match code ${phoneCode} != ${posCode}`);

  await phone.click('#k-approve');
  await waitVisible(phone, '#v-result');
  await waitVisible(pos, '#v-done');
  await sleep(300);
  await shot(phone, 'phone-paid');
  await shot(pos, 'pos-paid');
  const phoneTitle = await phone.textContent('#r-title');
  const posTitle = await pos.textContent('#d-title');
  ok = phoneTitle === 'Paid' && posTitle === 'Paid';
  // what the link adaptation learned from the phone's reports (noisy channels -> mask)
  const linkState = await pos.evaluate(() => fetch('/api/pos/hop/link').then(r => r.json()).catch(() => null));
  const lastEntry = linkState?.schedule?.at(-1);
  const avoided = lastEntry?.mask ? 96 - lastEntry.mask.length : 0;
  const meter = await phone.textContent('#l-meter').catch(() => '');
  console.log(JSON.stringify({ mode: MODE, profile: process.env.HOP_PROFILE || 'fast', jam: JAM_ARG, posMode, listenMode, buffersForwarded: forwarded,
    secondsFromChargeToConfirm: Number(heardAfter.toFixed(1)), phone: phoneTitle, pos: posTitle, channelsAvoided: avoided, meter, ok }));
} catch (err) {
  console.log(`FAILED (${MODE}, ${process.env.HOP_PROFILE || 'fast'} profile, jam ${JAM_ARG}): ${err.message}`);
} finally {
  const bad = logs.filter(l => /error|warn/i.test(l));
  if (!ok || process.env.E2E_LOGS) console.log(bad.concat(process.env.E2E_LOGS ? logs : []).slice(0, 40).join('\n'));
  await browser.close();
  server.kill();
  process.exitCode = ok ? 0 : 1;
}
