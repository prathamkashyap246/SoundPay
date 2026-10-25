// Reed-Solomon over GF(64) (6-bit symbols, primitive polynomial x^6 + x + 1).
//
// Codeword = the message polynomial m(x) = m0 + m1 x + ... + m(k-1) x^(k-1) evaluated at the n points
// alpha^0 .. alpha^(n-1) (n <= 63). Any k correct symbols determine the message.
//
// Decoder: Berlekamp-Welch. Erased symbols are simply left out of the system. With f erasures and e
// wrong symbols it succeeds whenever 2e + f <= n - k. If it can't, it returns null (the caller's CRC
// is the final judge, so a rare miscorrection is still caught).

const EXP = new Uint8Array(126), LOG = new Uint8Array(64);
{
  let x = 1;
  for (let i = 0; i < 63; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 64) x ^= 0x43; }
  for (let i = 63; i < 126; i++) EXP[i] = EXP[i - 63];
}
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
const inv = a => EXP[63 - LOG[a]];

export const RS_MAX_N = 63;

export function rsEncode(msg, n) {
  const k = msg.length;
  if (n > RS_MAX_N || n < k) throw new Error('bad RS size');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = EXP[i];
    let v = 0;
    for (let j = k - 1; j >= 0; j--) v = mul(v, x) ^ msg[j];
    out[i] = v;
  }
  return out;
}

// received: array/typed array of length n; -1 marks an erasure. Returns the k message symbols or null.
export function rsDecode(received, k) {
  const n = received.length;
  const S = [];
  for (let i = 0; i < n; i++) if (received[i] >= 0) S.push(i);
  if (S.length < k) return null;
  const e = Math.floor((S.length - k) / 2);
  const U = k + 2 * e;

  // Unknowns: Q (k+e coefficients) and E (e coefficients, E is monic of degree e).
  // For every kept point:  Q(x) + r*E_low(x) = r * x^e   (characteristic 2: minus is plus)
  const M = S.map(i => {
    const x = EXP[i], r = received[i], row = new Uint8Array(U + 1);
    let p = 1;
    const pows = [];
    for (let j = 0; j <= k + e; j++) { pows.push(p); p = mul(p, x); }
    for (let j = 0; j < k + e; j++) row[j] = pows[j];
    for (let j = 0; j < e; j++) row[k + e + j] = mul(r, pows[j]);
    row[U] = mul(r, pows[e]);
    return row;
  });

  // Gauss-Jordan elimination over GF(64); free variables are set to 0.
  const pivots = [];
  let row = 0;
  for (let col = 0; col < U && row < M.length; col++) {
    let sel = -1;
    for (let r = row; r < M.length; r++) if (M[r][col]) { sel = r; break; }
    if (sel < 0) continue;
    [M[row], M[sel]] = [M[sel], M[row]];
    const iv = inv(M[row][col]);
    for (let j = col; j <= U; j++) M[row][j] = mul(M[row][j], iv);
    for (let r = 0; r < M.length; r++) {
      if (r === row || !M[r][col]) continue;
      const f = M[r][col];
      for (let j = col; j <= U; j++) M[r][j] ^= mul(f, M[row][j]);
    }
    pivots.push(col);
    row++;
  }
  for (let r = row; r < M.length; r++) if (M[r][U]) return null;      // inconsistent: too many errors
  const u = new Uint8Array(U);
  pivots.forEach((c, i) => { u[c] = M[i][U]; });

  // m = Q / E (must divide exactly)
  const Q = u.slice(0, k + e), Ec = u.slice(k + e);
  const rem = Q.slice(), m = new Uint8Array(k);
  for (let d = k + e - 1; d >= e; d--) {
    const c = rem[d];
    if (!c) continue;
    m[d - e] = c;
    for (let j = 0; j < e; j++) rem[d - e + j] ^= mul(c, Ec[j]);
    rem[d] = 0;
  }
  for (let j = 0; j < e; j++) if (rem[j]) return null;

  // sanity: the recovered codeword may disagree with at most e of the kept symbols
  const cw = rsEncode(m, n);
  let bad = 0;
  for (const i of S) if (cw[i] !== received[i]) bad++;
  return bad <= e ? m : null;
}
