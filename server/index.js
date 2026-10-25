import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config, isHttps } from './config.js';
import * as sessions from './sessions.js';
import * as users from './users.js';
import * as passkeys from './passkeys.js';
import * as payments from './payments.js';
import * as events from './events.js';
import * as hop from './hop.js';
import * as link from './link.js';

const app = express();
const root = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- helpers

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function setCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: isHttps, maxAge: maxAgeMs });
}

const posCookieValue = crypto.createHmac('sha256', config.posKey).update('pos-login').digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Tiny in-memory rate limiter: `limit` requests per minute per key.
const hits = new Map();
function rateLimited(key, limit) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > limit;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- middleware

// Stripe webhooks need the raw body, so this route is registered before express.json().
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = payments.parseWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).send(err.message);
  }
  const pi = event.data.object;
  const sessionId = pi.metadata?.session_id;
  if (sessionId && event.type === 'payment_intent.succeeded') finishPaid(sessionId, pi.id);
  if (sessionId && event.type === 'payment_intent.payment_failed') {
    finishFailed(sessionId, pi.last_payment_error?.message || 'Payment failed');
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '50kb' }));

// Block cross-site POSTs (CSRF): the browser always sends Origin on POST.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers.origin && req.headers.origin !== config.origin) {
    return res.status(403).json({ error: `Origin ${req.headers.origin} not allowed. Set ORIGIN in .env to the URL you opened.` });
  }
  next();
});

app.use(express.static(path.join(root, 'public')));
app.get('/vendor/ggwave.js', (req, res) => res.sendFile(path.join(root, 'node_modules/ggwave/ggwave.js')));
app.get('/vendor/qrcode.js', (req, res) => res.sendFile(path.join(root, 'node_modules/qrcode-generator/qrcode.js')));
app.get('/vendor/webauthn.js', (req, res) =>
  res.sendFile(path.join(root, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));

function requireUser(req, res, next) {
  req.user = users.userFromLogin(cookies(req).login);
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}

function requirePos(req, res, next) {
  if (!safeEqual(cookies(req).pos || '', posCookieValue)) return res.status(401).json({ error: 'POS not signed in' });
  next();
}

// Hop keys and link settings: a customer with a card, or the POS operator (the range-test page runs on a
// phone signed in with the POS key).
function requireUserOrPos(req, res, next) {
  req.user = users.userFromLogin(cookies(req).login);
  if (req.user) {
    if (!req.user.payment_method) return res.status(400).json({ error: 'Add a card first' });
    return next();
  }
  if (safeEqual(cookies(req).pos || '', posCookieValue)) { req.isPos = true; return next(); }
  res.status(401).json({ error: 'Please sign in' });
}

// ---------------------------------------------------------------- shared payment helpers

function finishPaid(sessionId, ref) {
  if (!sessions.markPaid(sessionId, ref)) return;          // already paid: nothing to do
  const s = sessions.getSession(sessionId);
  const u = users.getUser(s.customer_id);
  events.publish(sessionId, { status: 'PAID', customer: users.shortName(u.name), last4: u.card_last4 });
}

function finishFailed(sessionId, reason) {
  if (!sessions.markFailed(sessionId, reason)) return;
  events.publish(sessionId, { status: 'FAILED', reason });
}

function applyChargeResult(sessionId, result) {
  if (result.status === 'succeeded') finishPaid(sessionId, result.ref);
  else if (result.status === 'failed') finishFailed(sessionId, result.reason || 'Declined');
  else sessions.setPaymentRef(sessionId, result.ref);       // requires_action / processing
  return { status: result.status, clientSecret: result.clientSecret, reason: result.reason };
}

// ---------------------------------------------------------------- general

app.get('/api/config', (req, res) => {
  res.json({ mode: payments.mode, publishableKey: config.stripePublishableKey, currency: config.currency, audioMode: config.audioMode });
});

// Clock for the hop modem: phones and the POS measure their offset from this (several round trips).
app.get('/api/time', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ now: Date.now() });
});

// ---------------------------------------------------------------- hop keys

// Signed-in customers get the short-lived epoch keys, so their phone can follow the POS's hops.
app.get('/api/hop/keys', requireUserOrPos, (req, res) => {
  if (req.user && rateLimited(`hopkeys:${req.user.id}`, 30)) throw new HttpError(429, 'Too many attempts, wait a minute');
  res.set('Cache-Control', 'no-store');
  res.json(hop.keysAround());
});

// Current link settings (channel mask + pre-emphasis schedule). Polled every few seconds while listening.
app.get('/api/hop/link', requireUserOrPos, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(link.linkInfo());
});

// The phone reports what it hears: persistently noisy channels, and the received level of our own tones.
app.post('/api/hop/report', requireUser, (req, res) => {
  if (rateLimited(`hopreport:${req.user.id}`, 12)) throw new HttpError(429, 'Too many reports');
  if (!req.user.payment_method) throw new HttpError(400, 'Add a card first');
  const noisy = req.body.noisy === undefined ? undefined : link.validChannels(req.body.noisy);
  const toneLevel = req.body.toneLevel === undefined ? undefined : link.validLevels(req.body.toneLevel);
  if (noisy === null || toneLevel === null) throw new HttpError(400, 'Bad report');
  const cycleStartMs = Number.isFinite(req.body.cycleStartMs) ? req.body.cycleStartMs : undefined;
  res.json(link.customerReport({ noisy, toneLevel, cycleStartMs }));
});

// ---------------------------------------------------------------- customer account

app.post('/api/register/options', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Enter your name');
  res.json(await passkeys.registrationOptions(name));
});

app.post('/api/register/verify', async (req, res) => {
  const userId = await passkeys.verifyRegistration(req.body.flowId, req.body.response);
  const login = users.createLogin(userId);
  setCookie(res, 'login', login.token, login.maxAgeMs);
  res.json({ ok: true });
});

app.post('/api/login/options', async (req, res) => {
  res.json(await passkeys.loginOptions());
});

app.post('/api/login/verify', async (req, res) => {
  const userId = await passkeys.verifyLogin(req.body.flowId, req.body.response);
  const login = users.createLogin(userId);
  setCookie(res, 'login', login.token, login.maxAgeMs);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  users.deleteLogin(cookies(req).login);
  res.clearCookie('login');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ name: req.user.name, hasCard: Boolean(req.user.payment_method), last4: req.user.card_last4 });
});

app.post('/api/card/setup', requireUser, async (req, res) => {
  res.json(await payments.startCardSetup(req.user));
});

app.post('/api/card/finish', requireUser, async (req, res) => {
  await payments.finishCardSetup(req.user, req.body.setupIntentId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- customer paying

// Step 1: phone heard a token. Show what it's for. NOTHING is charged here.
app.post('/api/pay/lookup', requireUser, async (req, res) => {
  if (rateLimited(`lookup:${req.user.id}`, 20)) throw new HttpError(429, 'Too many attempts, wait a minute');
  if (!req.user.payment_method) throw new HttpError(400, 'Add a card first');

  const session = sessions.lookupOpenSession(sessions.normalizeToken(req.body.token));
  if (!session) throw new HttpError(404, 'Payment not found or expired. Ask the cashier to retry.');

  const approval = await passkeys.paymentOptions(req.user.id, session.id);
  res.json({
    sessionId: session.id,
    merchant: session.merchant_name,
    amount: session.amount,
    currency: session.currency,
    matchCode: session.match_code,
    expiresAt: session.expires_at,
    last4: req.user.card_last4,
    ...approval,
  });
});

// Step 2: user approved with their passkey. Claim atomically, then charge.
app.post('/api/pay/confirm', requireUser, async (req, res) => {
  const { sessionId, flowId, response } = req.body;
  await passkeys.verifyPayment(flowId, response, req.user.id, sessionId);

  const session = sessions.claimSession(sessionId, req.user.id);
  if (!session) throw new HttpError(409, 'This payment was already taken or has expired.');

  events.publish(sessionId, { status: 'CLAIMED', customer: users.shortName(req.user.name) });
  const result = await payments.charge(session, req.user);
  res.json(applyChargeResult(sessionId, result));
});

// Step 3 (only after a 3-D Secure popup): ask Stripe for the final status.
app.post('/api/pay/finalize', requireUser, async (req, res) => {
  const s = sessions.getSession(String(req.body.sessionId));
  if (!s || s.customer_id !== req.user.id || !s.payment_ref) throw new HttpError(404, 'Payment not found');
  if (s.status !== 'CLAIMED') return res.json({ status: s.status === 'PAID' ? 'succeeded' : 'failed' });
  res.json(applyChargeResult(s.id, await payments.checkPayment(s.payment_ref)));
});

// ---------------------------------------------------------------- POS

app.post('/api/pos/login', (req, res) => {
  if (rateLimited(`poslogin:${req.ip}`, 10)) throw new HttpError(429, 'Too many attempts');
  if (!safeEqual(req.body.key || '', config.posKey)) throw new HttpError(401, 'Wrong POS key');
  setCookie(res, 'pos', posCookieValue, 7 * 24 * 3600 * 1000);
  res.json({ ok: true, merchant: config.merchantName });
});

app.get('/api/pos/hop/keys', requirePos, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(hop.keysAround());
});

app.get('/api/pos/hop/link', requirePos, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...link.linkInfo(), calibration: link.calibrationSummary() });
});

// Operator speaker calibration (range-test page, phone held near the speaker). { toneLevel, cycleStartMs }
// or { reset: true }.
app.post('/api/pos/hop/calibration', requirePos, (req, res) => {
  if (req.body.reset) return res.json(link.resetCalibration());
  const toneLevel = link.validLevels(req.body.toneLevel);
  if (!toneLevel) throw new HttpError(400, 'Bad levels');
  const r = link.operatorCalibration({ toneLevel, cycleStartMs: Number(req.body.cycleStartMs) || undefined });
  if (!r) throw new HttpError(400, 'Not enough channels measured yet: keep the phone near the speaker a little longer');
  res.json({ ...r, calibration: link.calibrationSummary() });
});

app.get('/api/pos/me', requirePos, (req, res) => res.json({ merchant: config.merchantName, currency: config.currency }));

app.post('/api/pos/sessions', requirePos, (req, res) => {
  const amount = Math.round(Number(req.body.amount) * 100);       // rupees -> paise
  if (!Number.isFinite(amount) || amount < 100 || amount > 10_000_000) {
    throw new HttpError(400, 'Amount must be between 1 and 1,00,000');
  }
  const s = sessions.createSession(amount);
  res.json({ id: s.id, amount: s.amount, currency: s.currency, matchCode: s.match_code, expiresAt: s.expires_at });
});

app.post('/api/pos/sessions/:id/cancel', requirePos, (req, res) => {
  const ok = sessions.cancelSession(req.params.id);
  if (ok) events.publish(req.params.id, { status: 'CANCELLED' });
  res.json({ ok });
});

// Used by the POS when its countdown runs out: the server, not the browser clock, decides.
app.get('/api/pos/sessions/:id', requirePos, (req, res) => {
  const s = sessions.getSession(req.params.id);
  if (!s) throw new HttpError(404, 'Not found');
  const status = s.status === 'OPEN' && s.expires_at <= Date.now() ? 'EXPIRED' : s.status;
  const u = s.customer_id ? users.getUser(s.customer_id) : null;
  res.json({ status, customer: u ? users.shortName(u.name) : null, last4: u?.card_last4, reason: s.fail_reason });
});

app.get('/api/pos/sessions/:id/events', requirePos, (req, res) => {
  const s = sessions.getSession(req.params.id);
  if (!s) return res.status(404).end();
  events.subscribe(s.id, res);
  if (s.status !== 'OPEN') events.publish(s.id, { status: s.status });   // late joiner catches up
});

// ---------------------------------------------------------------- errors

app.use((err, req, res, next) => {
  const status = err.status || 400;
  if (!err.status) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

export { app };

if (process.argv[1] === import.meta.filename) {
  app.listen(config.port, () => {
    console.log(`SoundPay running on port ${config.port}`);
    console.log(`  Open:      ${config.origin}`);
    console.log(`  Payments:  ${payments.mode} mode`);
    console.log(`  Audio:     ${config.audioMode} mode, ${config.hopProfile} hop profile (terminal ${config.terminalId})`);
    if (config.posKey === 'change-me') console.log('  POS key:   change-me  (set POS_KEY in .env)');
  });
}
