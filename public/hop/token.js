// SoundPay tokens <-> 10-byte modem payloads.
// A token is 16 characters from a 32-letter alphabet (server/tokens.js), i.e. 5 bits each = 80 bits = 10 bytes.

export const ALPHABET = 'abcdefghjkmnpqrstuvwxyz234567890';     // must match server/tokens.js
export const TOKEN_LEN = 16;
export const PAYLOAD_LEN = 10;

export function packToken(token) {
  const t = String(token).toLowerCase().replace(/o/g, '0');
  if (t.length !== TOKEN_LEN) throw new Error('token must be 16 characters');
  const out = new Uint8Array(PAYLOAD_LEN);
  let acc = 0, bits = 0, n = 0;
  for (const ch of t) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`bad token character ${ch}`);
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out[n++] = (acc >> (bits - 8)) & 255; bits -= 8; acc &= (1 << bits) - 1; }
  }
  return out;
}

export function unpackToken(bytes) {
  let acc = 0, bits = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(acc >> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1; }
  }
  return out;
}
