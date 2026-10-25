import crypto from 'node:crypto';

// 32 characters, no i/l/o/1 so the code is easy to type if audio fails.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz234567890';

// 16 characters x 5 bits = 80 random bits. Short enough to send over sound in ~1.8 s.
export function newToken() {
  return Array.from(crypto.randomBytes(16), b => ALPHABET[b % 32]).join('');
}

export function normalizeToken(text) {
  return String(text || '').trim().toLowerCase().replace(/o/g, '0');
}
