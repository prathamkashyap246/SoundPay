import { api, money, show, $, runTimer } from '/common.js';
import { startListening, drawBand } from '/audio.js';

const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser;
const VIEWS = ['v-signup', 'v-card', 'v-ready', 'v-listen', 'v-confirm', 'v-result'];

let config = null;      // { mode, publishableKey, currency }
let me = null;          // { name, hasCard, last4 }
let listener = null;    // active microphone listener
let payment = null;     // the payment being confirmed
let stripe = null;

// ---------------------------------------------------------------- helpers

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

// Run an async step with the button disabled and errors shown on screen.
async function busy(button, fn) {
  showError('');
  button.disabled = true;
  try { await fn(); }
  catch (err) {
    if (err.name === 'NotAllowedError') showError('Passkey prompt was closed. Try again.');
    else showError(err.message);
  }
  finally { button.disabled = false; }
}

// ---------------------------------------------------------------- start up

// Opened from the POS's QR code: /pay.html#t=<token>. Used as soon as the customer is signed in with a card.
let pendingToken = new URLSearchParams(location.hash.slice(1)).get('t');
if (pendingToken) history.replaceState(null, '', location.pathname);
// the pay page may already be open in that tab: then only the #hash changes
window.addEventListener('hashchange', () => {
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  if (!t) return;
  history.replaceState(null, '', location.pathname);
  pendingToken = t;
  if (config) route();
});

async function init() {
  if (!window.isSecureContext) {
    showError('This page must be opened over https (or on localhost) for the microphone and passkeys to work.');
  }
  config = await api('/api/config');
  try {
    me = await api('/api/me');
  } catch {
    me = null;
  }
  route();
}

function route() {
  $('who').textContent = me ? me.name : '';
  if (!me) return show('v-signup', VIEWS);
  if (!me.hasCard) return showCardSetup();
  $('ready-card').textContent = `Paying with card ending ${me.last4}`;
  show('v-ready', VIEWS);
  if (pendingToken) {
    const t = pendingToken;
    pendingToken = null;
    onToken(t);
  }
}

// ---------------------------------------------------------------- account

$('signup-form').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const { flowId, options } = await api('/api/register/options', { name: $('name').value });
    const response = await startRegistration({ optionsJSON: options });
    await api('/api/register/verify', { flowId, response });
    me = await api('/api/me');
    route();
  });
});

$('signin').addEventListener('click', e => busy(e.currentTarget, async () => {
  const { flowId, options } = await api('/api/login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  await api('/api/login/verify', { flowId, response });
  me = await api('/api/me');
  route();
}));

$('signout').addEventListener('click', async () => {
  await api('/api/logout', {});
  me = null;
  route();
});

// ---------------------------------------------------------------- card

let elements = null;

async function showCardSetup() {
  show('v-card', VIEWS);
  const setup = await api('/api/card/setup', {});

  if (setup.mode === 'mock') {
    $('card-intro').textContent = 'Demo mode: no real card needed. A test card ending 4242 will be saved.';
    $('card-element').hidden = true;
    return;
  }

  $('card-intro').textContent = 'Stripe test mode: use 4242 4242 4242 4242, any future date, any CVC.';
  await loadStripeJs();
  stripe ??= window.Stripe(setup.publishableKey);
  elements = stripe.elements({ clientSecret: setup.clientSecret });
  elements.create('payment').mount('#card-element');
}

$('card-save').addEventListener('click', e => busy(e.currentTarget, async () => {
  let setupIntentId = null;
  if (config.mode === 'stripe') {
    const { setupIntent, error } = await stripe.confirmSetup({ elements, redirect: 'if_required' });
    if (error) throw new Error(error.message);
    setupIntentId = setupIntent.id;
  }
  await api('/api/card/finish', { setupIntentId });
  me = await api('/api/me');
  route();
}));

function loadStripeJs() {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Stripe'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- listening

let stopBand = null;
let listenTimeout = null;
let hintTimer = null;

// ---------------------------------------------------------------- signal meter

// What the phone hears, in words: a hint the customer can act on (move closer, it's too loud here).
function showSignal(s) {
  const box = $('l-meter-box'), text = $('l-meter');
  const bars = n => box.querySelectorAll('.bars i').forEach((b, i) => b.classList.toggle('on', i < n));
  if (s.type === 'heard') {
    const snr = s.snrDb ?? 0;
    bars(snr >= 25 ? 4 : snr >= 18 ? 3 : snr >= 12 ? 2 : 1);
    box.classList.toggle('warn', snr < 12);
    text.textContent = snr < 12 ? 'Heard the terminal, but faintly: move closer' : 'Heard the terminal';
    return;
  }
  if (s.clippedPct > 0.2) {
    bars(1); box.classList.add('warn');
    text.textContent = 'Very loud here: hold the phone right next to the terminal';
  } else if (s.noisy?.length) {
    bars(2); box.classList.remove('warn');
    text.textContent = `Noisy room: avoiding ${s.noisy.length} busy channel${s.noisy.length > 1 ? 's' : ''}`;
  } else {
    bars(0); box.classList.remove('warn');
    text.textContent = 'Listening… hold the phone near the terminal';
  }
}

// ---------------------------------------------------------------- accessibility

function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = document.documentElement.lang === 'hi' ? 'hi-IN' : 'en-IN';
  speechSynthesis.speak(u);
}

$('pay').addEventListener('click', e => busy(e.currentTarget, async () => {
  show('v-listen', VIEWS);
  $('manual').value = '';
  try {
    listener = await startListening(text => onToken(text), { onStatus: showSignal });
  } catch {
    throw new Error('Microphone is blocked. Allow it in your browser settings, or type the code below.');
  }
  $('l-mode').textContent = `Listening via ${listener.mode}`;
  stopBand = drawBand($('l-band'), listener.analyser, listener.ctx.sampleRate);
  hintTimer = setTimeout(() => { $('l-hint').hidden = false; }, 12_000);
  listenTimeout = setTimeout(() => {
    stopListening();
    showError("Didn't hear the terminal. Move closer to its speaker, or type the code.");
    route();
  }, 45_000);
}));

function stopListening() {
  clearTimeout(listenTimeout);
  clearTimeout(hintTimer);
  $('l-hint').hidden = true;
  stopBand?.();
  listener?.stop();
  listener = null;
}

$('l-cancel').addEventListener('click', () => { stopListening(); route(); });

$('manual-form').addEventListener('submit', e => {
  e.preventDefault();
  onToken($('manual').value.replace(/\s+/g, ''));
});

let lookingUp = false;
let lastBadToken = null;

async function onToken(token) {
  // The terminal repeats itself every couple of seconds: handle one at a time,
  // and don't keep re-checking a token the server already rejected.
  if (lookingUp || token === lastBadToken) return;
  lookingUp = true;
  try {
    const p = await api('/api/pay/lookup', { token });
    stopListening();
    showConfirm(p);
  } catch (err) {
    lastBadToken = token;
    showError(err.message);       // keep listening: the next broadcast may be a fresh token
  } finally {
    lookingUp = false;
  }
}

// ---------------------------------------------------------------- confirm

function showConfirm(p) {
  payment = p;
  navigator.vibrate?.(80);                                  // a tap you can feel: the terminal was heard
  showError('');
  $('k-merchant').textContent = p.merchant;
  $('k-amount').textContent = money(p.amount, p.currency);
  $('k-code').textContent = p.matchCode;
  $('k-approve').textContent = `Approve ${money(p.amount, p.currency)}`;
  $('k-card').textContent = `Card ending ${p.last4}`;
  payment.stopTimer = runTimer($('k-timer'), p.expiresAt);
  show('v-confirm', VIEWS);
}

$('k-speak').addEventListener('click', () => {
  const p = payment;
  if (p) speak(`Pay ${p.merchant}, ${money(p.amount, p.currency)}. Check the terminal shows code ${String(p.matchCode).split('').join(' ')}.`);
});

$('k-cancel').addEventListener('click', () => {
  payment?.stopTimer();
  payment = null;
  route();
});

$('k-approve').addEventListener('click', e => busy(e.currentTarget, async () => {
  const p = payment;
  // 1. Fingerprint / face: signs a challenge that's tied to THIS payment only.
  const response = await startAuthentication({ optionsJSON: p.options });

  // 2. Server checks the passkey, claims the payment (only once), and charges.
  let result = await api('/api/pay/confirm', { sessionId: p.sessionId, flowId: p.flowId, response });

  // 3. Some cards need a bank check (3-D Secure). Stripe shows it, then we ask the server again.
  if (result.status === 'requires_action') {
    await loadStripeJs();
    stripe ??= window.Stripe(config.publishableKey);
    const { error } = await stripe.handleNextAction({ clientSecret: result.clientSecret });
    if (error) showError(error.message);
    result = await api('/api/pay/finalize', { sessionId: p.sessionId });
  }

  p.stopTimer();
  showResult(p, result);
}));

// ---------------------------------------------------------------- result

function showResult(p, result) {
  const paid = result.status === 'succeeded';
  $('r-box').className = `result ${paid ? 'paid' : 'failed'}`;
  $('r-title').textContent = paid ? 'Paid' : result.status === 'processing' ? 'Processing' : 'Not paid';
  $('r-amount').textContent = money(p.amount, p.currency);
  $('r-detail').textContent = paid ? `to ${p.merchant}` : (result.reason || 'Check with the cashier.');
  show('v-result', VIEWS);
  $('r-done').focus();
}

$('r-done').addEventListener('click', () => { payment = null; route(); });

init().catch(err => showError(err.message));
