// Payment sessions: the one-time tokens the POS broadcasts.
// The token is treated as PUBLIC. It is only a lookup key; security comes from
// the customer's passkey confirmation and the atomic claim below.
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { newToken, normalizeToken } from './tokens.js';

export { normalizeToken };

export function createSession(amount) {
  const now = Date.now();
  const session = {
    id: newToken(),
    merchant_name: config.merchantName,
    amount,
    currency: config.currency,
    match_code: String(crypto.randomInt(10, 100)),
    status: 'OPEN',
    created_at: now,
    expires_at: now + config.sessionTtlSeconds * 1000,
  };
  db.prepare(`
    INSERT INTO payment_sessions (id, merchant_name, amount, currency, match_code, status, created_at, expires_at)
    VALUES (:id, :merchant_name, :amount, :currency, :match_code, :status, :created_at, :expires_at)
  `).run(session);
  return session;
}

export function getSession(id) {
  return db.prepare('SELECT * FROM payment_sessions WHERE id = ?').get(id) || null;
}

// What the customer's phone sees after hearing a token. No charge happens here.
export function lookupOpenSession(id) {
  const s = getSession(id);
  if (!s || s.status !== 'OPEN' || s.expires_at <= Date.now()) return null;
  return s;
}

// THE important bit: check-and-claim in ONE statement.
// If two phones submit the same token at the same moment, only one UPDATE
// can match "status = 'OPEN'", so only one of them gets a row back.
export function claimSession(id, userId) {
  const row = db.prepare(`
    UPDATE payment_sessions
       SET status = 'CLAIMED', customer_id = ?
     WHERE id = ? AND status = 'OPEN' AND expires_at > ?
    RETURNING *
  `).get(userId, id, Date.now());
  return row || null;
}

// Remember the Stripe PaymentIntent while a 3-D Secure step is in progress.
export function setPaymentRef(id, paymentRef) {
  db.prepare(`UPDATE payment_sessions SET payment_ref = ? WHERE id = ? AND status = 'CLAIMED'`).run(paymentRef, id);
}

// Both of these only move a CLAIMED session forward, so calling them twice
// (e.g. from the API response AND a Stripe webhook) is harmless.
export function markPaid(id, paymentRef) {
  const r = db.prepare(`
    UPDATE payment_sessions SET status = 'PAID', payment_ref = ?
     WHERE id = ? AND status = 'CLAIMED'
  `).run(paymentRef, id);
  return r.changes === 1;
}

export function markFailed(id, reason) {
  const r = db.prepare(`
    UPDATE payment_sessions SET status = 'FAILED', fail_reason = ?
     WHERE id = ? AND status = 'CLAIMED'
  `).run(reason, id);
  return r.changes === 1;
}

export function cancelSession(id) {
  const r = db.prepare(`
    UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ? AND status = 'OPEN'
  `).run(id);
  return r.changes === 1;
}
