// Keys for the frequency-hopping audio mode (public/hop/).
//
// The server keeps ONE master secret (HOP_SECRET, or a random one stored in the database on first start).
// Phones and the POS never see it. They get short-lived epoch keys instead:
//   epochKey = HKDF-SHA256(master, salt "hopmodem/v1", info "terminal=<id>|epoch=<n>")   one per 30 s
// This is byte-for-byte what public/hop/timing.js deriveEpochKey() computes, so a leaked epoch key
// lets someone follow the hops for 30 seconds of one terminal, nothing more.
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { PROFILES, EPOCH_MS } from '../public/hop/profiles.js';
import { linkInfo } from './link.js';

export { EPOCH_MS };
export const profile = PROFILES[config.hopProfile];

function loadSecret() {
  if (config.hopSecret) {
    const s = /^[0-9a-f]{64}$/i.test(config.hopSecret) ? Buffer.from(config.hopSecret, 'hex') : Buffer.from(config.hopSecret);
    if (s.length < 32) throw new Error('HOP_SECRET must be 64 hex characters (32 bytes) or at least 32 characters');
    return s;
  }
  const row = db.prepare(`SELECT value FROM settings WHERE name = 'hop_secret'`).get();
  if (row) return Buffer.from(row.value, 'hex');
  const fresh = crypto.randomBytes(32);
  db.prepare(`INSERT INTO settings (name, value) VALUES ('hop_secret', ?)`).run(fresh.toString('hex'));
  return fresh;
}

const master = loadSecret();

export const epochOf = ms => Math.floor(ms / EPOCH_MS);

export function epochKey(terminalId, epoch) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('hopmodem/v1'),
    Buffer.from(`terminal=${terminalId}|epoch=${epoch}`), 32));
}

// Keys from one epoch ago to `ahead` epochs ahead: enough for a 45 s listening window plus clock error.
export function keysAround(now = Date.now(), ahead = 2) {
  const e = epochOf(now);
  const keys = [];
  for (let n = e - 1; n <= e + ahead; n++) {
    keys.push({ terminalId: config.terminalId, epoch: n, key: epochKey(config.terminalId, n).toString('base64url') });
  }
  return { terminalId: config.terminalId, profile, cycleMs: profile.cycleMs, epochMs: EPOCH_MS, serverTime: now, keys, link: linkInfo(now) };
}
