// Keyed hop plan (the TRANSEC layer). Both ends run this with the same key + context
// and get the same channel list, so no channel list is ever transmitted.
// Uses WebCrypto HMAC-SHA256, available in browsers and Node 20+.

export const NCH = 96;                       // channels (tone slots) in the band
const enc = new TextEncoder();

// key: Uint8Array (e.g. HMAC(merchantSecret, timeSlot)); context: string, e.g. `${sessionId}|${cycle}`
export async function hopPlan(key, context, length, nch = NCH) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = new Uint8Array(length);
  const limit = 65536 - (65536 % nch);       // rejection sampling: no modulo bias
  let n = 0, counter = 0;
  while (n < length) {
    const block = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(`hopmodem/v1|${context}|${counter++}`)));
    for (let i = 0; i + 1 < block.length && n < length; i += 2) {
      const v = (block[i] << 8) | block[i + 1];
      if (v < limit) out[n++] = v % nch;
    }
  }
  return out;
}

// The "no hopping" baseline: every slot uses offset 0, so tones are fixed by the data.
export const flatPlan = length => new Uint8Array(length);
