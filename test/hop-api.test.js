// HTTP tests for the hop-mode endpoints: /api/time, /api/hop/keys, /api/pos/hop/keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 3918;
const SECRET_HEX = 'ab'.repeat(32);
process.env.PORT = String(PORT);
process.env.ORIGIN = `http://localhost:${PORT}`;
process.env.POS_KEY = 'test-pos-key';
process.env.DB_PATH = ':memory:';
process.env.STRIPE_SECRET_KEY = '';
process.env.HOP_SECRET = SECRET_HEX;
process.env.TERMINAL_ID = 'till-7';

const { app } = await import('../server/index.js');
const { FakeAuthenticator } = await import('./fake-authenticator.js');
const { deriveEpochKey } = await import('../public/hop/timing.js');
const { b64urlToBytes } = await import('../public/hop/engine.js');

const BASE = process.env.ORIGIN;
let server;
before(() => new Promise(resolve => { server = app.listen(PORT, resolve); }));
after(() => new Promise(resolve => server.close(resolve)));

class Client {
  cookies = '';
  async call(path, body) {
    const res = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: this.cookies },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const name = pair.split('=')[0];
      this.cookies = [...this.cookies.split('; ').filter(x => x && !x.startsWith(name + '=')), pair].join('; ');
    }
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  }
}

async function newCustomer(name, { card = true } = {}) {
  const client = new Client();
  const passkey = new FakeAuthenticator(BASE);
  const opts = await client.call('/api/register/options', { name });
  const reg = await client.call('/api/register/verify', { flowId: opts.body.flowId, response: passkey.register(opts.body.options) });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  if (card) { await client.call('/api/card/setup', {}); await client.call('/api/card/finish', {}); }
  return client;
}

test('/api/time returns the server clock, uncached', async () => {
  const before = Date.now();
  const r = await new Client().call('/api/time');
  assert.equal(r.status, 200);
  assert.ok(r.body.now >= before && r.body.now <= Date.now());
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('/api/config reports the audio mode', async () => {
  const r = await new Client().call('/api/config');
  assert.equal(r.body.audioMode, 'hop');
});

test('hop keys need a signed-in customer with a card', async () => {
  assert.equal((await new Client().call('/api/hop/keys')).status, 401);
  const noCard = await newCustomer('No Card', { card: false });
  assert.equal((await noCard.call('/api/hop/keys')).status, 400);
});

test('customer keys: 4 epochs around now, and identical to what the browser derives', async () => {
  const c = await newCustomer('Asha R');
  const r = await c.call('/api/hop/keys');
  assert.equal(r.status, 200);
  assert.equal(r.body.terminalId, 'till-7');
  assert.equal(r.body.cycleMs, 3000);
  assert.deepEqual(r.body.profile, { name: 'fast', bits: 6, rs: 32, cycleMs: 3000 });
  assert.deepEqual(r.body.link.schedule, []);
  const nowEpoch = Math.floor(Date.now() / 30000);
  assert.deepEqual(r.body.keys.map(k => k.epoch), [nowEpoch - 1, nowEpoch, nowEpoch + 1, nowEpoch + 2]);
  const secret = Buffer.from(SECRET_HEX, 'hex');
  for (const k of r.body.keys) {
    assert.deepEqual(b64urlToBytes(k.key), await deriveEpochKey(new Uint8Array(secret), 'till-7', k.epoch));
  }
  assert.ok(!JSON.stringify(r.body).includes(SECRET_HEX), 'master secret must never leave the server');
});

test('POS keys need the POS login and match the customer keys', async () => {
  const pos = new Client();
  assert.equal((await pos.call('/api/pos/hop/keys')).status, 401);
  assert.equal((await pos.call('/api/pos/login', { key: 'test-pos-key' })).status, 200);
  const pk = await pos.call('/api/pos/hop/keys');
  assert.equal(pk.status, 200);
  const ck = await (await newCustomer('Ben T')).call('/api/hop/keys');
  assert.deepEqual(pk.body.keys.find(k => k.epoch === ck.body.keys[1].epoch), ck.body.keys[1]);
});

test('customer key requests are rate limited', async () => {
  const c = await newCustomer('Greedy G');
  let last;
  for (let i = 0; i < 31; i++) last = await c.call('/api/hop/keys');
  assert.equal(last.status, 429);
});

// ---------------------------------------------------------------- link adaptation

test('noisy-channel reports: validated, capped at 32, scheduled 2+ cycles ahead on a boundary, POS sees it', async () => {
  const c = await newCustomer('Reporter R');
  assert.equal((await new Client().call('/api/hop/report', { noisy: [1] })).status, 401);
  for (const bad of [[-1], [96], [1.5], ['a'], [3, 3], 'x']) {
    assert.equal((await c.call('/api/hop/report', { noisy: bad })).status, 400, JSON.stringify(bad));
  }
  const before = Date.now();
  const r = await c.call('/api/hop/report', { noisy: Array.from({ length: 40 }, (_, i) => i) });
  assert.equal(r.status, 200);
  const e = r.body.schedule.at(-1);
  assert.equal(96 - e.mask.length, 32, 'never more than 32 channels avoided');
  assert.ok(e.mask.every(m => m >= 32), 'the reported channels are the ones left out');
  assert.equal(e.fromMs % 3000, 0);
  assert.ok(e.fromMs >= before + 2 * 3000);
  const pos = new Client();
  await pos.call('/api/pos/login', { key: 'test-pos-key' });
  const pl = await pos.call('/api/pos/hop/link');
  assert.deepEqual(pl.body.schedule.at(-1), e);
  assert.deepEqual(pl.body.tdma, { slot: 0, of: 1 });
  // clearing the report schedules "all channels" again
  const cleared = await c.call('/api/hop/report', { noisy: [] });
  assert.equal(cleared.body.schedule.at(-1).mask, null);
});

test('operator calibration: boost-only gains from measured levels, reset, POS only', async () => {
  const pos = new Client();
  assert.equal((await pos.call('/api/pos/hop/calibration', { toneLevel: [] })).status, 401);
  await pos.call('/api/pos/login', { key: 'test-pos-key' });
  assert.equal((await pos.call('/api/pos/hop/calibration', { toneLevel: [1, 2] })).status, 400);
  // a speaker that is 15 dB weaker at the top of the band (energy)
  const levels = Array.from({ length: 96 }, (_, m) => 10 ** (-15 * m / 95 / 10));
  const r = await pos.call('/api/pos/hop/calibration', { toneLevel: levels, cycleStartMs: Date.now() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g = r.body.schedule.at(-1).gains;
  assert.equal(g[0], 1);
  assert.ok(g[95] > 1.8 && g[95] <= 1.9, `top channel boost ${g[95]}`);
  assert.ok(g.every(v => v >= 1), 'never turns a channel down');
  assert.ok(r.body.calibration.boostedChannels > 40);
  const reset = await pos.call('/api/pos/hop/calibration', { reset: true });
  assert.equal(reset.body.schedule.at(-1).gains, null);
});
