// SQLite via Node's built-in node:sqlite module (no native build step needed).
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    stripe_customer   TEXT,
    payment_method    TEXT,
    card_last4        TEXT,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS passkeys (
    id          TEXT PRIMARY KEY,          -- credential ID (base64url)
    user_id     TEXT NOT NULL,
    public_key  BLOB NOT NULL,
    counter     INTEGER NOT NULL,
    transports  TEXT
  );

  CREATE TABLE IF NOT EXISTS logins (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  -- One row per "Charge" press on the POS.
  -- status: OPEN -> CLAIMED -> PAID | FAILED   (or OPEN -> CANCELLED)
  CREATE TABLE IF NOT EXISTS payment_sessions (
    id            TEXT PRIMARY KEY,        -- the token broadcast over audio
    merchant_name TEXT NOT NULL,
    amount        INTEGER NOT NULL,        -- smallest currency unit (paise)
    currency      TEXT NOT NULL,
    match_code    TEXT NOT NULL,           -- 2 digits shown on POS and phone
    status        TEXT NOT NULL,
    customer_id   TEXT,
    payment_ref   TEXT,
    fail_reason   TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
  );

  -- Small key/value store: the hop master secret, the speaker calibration.
  CREATE TABLE IF NOT EXISTS settings (
    name   TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);
