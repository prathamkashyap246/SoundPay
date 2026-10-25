// Users, their passkeys, and login cookies.
import crypto from 'node:crypto';
import { db } from './db.js';

const LOGIN_DAYS = 30;

export function createUser(id, name) {
  db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
}

export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function saveCard(userId, { stripeCustomer = null, paymentMethod, last4 }) {
  db.prepare(`
    UPDATE users SET stripe_customer = COALESCE(?, stripe_customer), payment_method = ?, card_last4 = ?
     WHERE id = ?
  `).run(stripeCustomer, paymentMethod, last4, userId);
}

export function setStripeCustomer(userId, customerId) {
  db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').run(customerId, userId);
}

// "Som Kumar" -> "Som K." (what the cashier sees on the POS)
export function shortName(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
}

// ---- passkeys ----

export function addPasskey(userId, credential) {
  db.prepare(`
    INSERT INTO passkeys (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)
  `).run(credential.id, userId, credential.publicKey, credential.counter,
         JSON.stringify(credential.transports || []));
}

export function getPasskey(credentialId) {
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credentialId);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports || '[]'),
  };
}

export function listPasskeys(userId) {
  return db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(userId)
    .map(r => ({ id: r.id, transports: JSON.parse(r.transports || '[]') }));
}

export function updatePasskeyCounter(credentialId, counter) {
  db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(counter, credentialId);
}

// ---- login cookies ----

export function createLogin(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + LOGIN_DAYS * 24 * 3600 * 1000;
  db.prepare('INSERT INTO logins (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, maxAgeMs: LOGIN_DAYS * 24 * 3600 * 1000 };
}

export function userFromLogin(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id FROM logins WHERE token = ? AND expires_at > ?').get(token, Date.now());
  return row ? getUser(row.user_id) : null;
}

export function deleteLogin(token) {
  db.prepare('DELETE FROM logins WHERE token = ?').run(token);
}
