// End-to-end tests of the payment flow over HTTP, with real passkey verification.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 3917;
process.env.PORT = String(PORT);
process.env.ORIGIN = `http://localhost:${PORT}`;
process.env.POS_KEY = 'test-pos-key';
process.env.DB_PATH = ':memory:';
process.env.STRIPE_SECRET_KEY = '';                 // mock payments

const { app } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { FakeAuthenticator } = await import('./fake-authenticator.js');

const BASE = process.env.ORIGIN;
let server;

before(() => new Promise(resolve => { server = app.listen(PORT, resolve); }));
after(() => new Promise(resolve => server.close(resolve)));

// A tiny browser: keeps cookies and sends the Origin header like a real one.
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
    return { status: res.status, body: await res.json().catch(() => null) };
  }
}

async function newCustomer(name) {
  const client = new Client();
  const passkey = new FakeAuthenticator(BASE);
  const opts = await client.call('/api/register/options', { name });
  const reg = await client.call('/api/register/verify', { flowId: opts.body.flowId, response: passkey.register(opts.body.options) });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  await client.call('/api/card/setup', {});
  await client.call('/api/card/finish', {});
  return { client, passkey };
}

async function newPos() {
  const pos = new Client();
  assert.equal((await pos.call('/api/pos/login', { key: 'test-pos-key' })).status, 200);
  return pos;
}

test('happy path: hear token, approve with passkey, POS sees PAID', async () => {
  const pos = await newPos();
  const { client, passkey } = await newCustomer('Som Kumar');

  const sale = (await pos.call('/api/pos/sessions', { amount: 450 })).body;
  assert.equal(sale.amount, 45000);
  assert.match(sale.id, /^[a-z0-9]{16}$/);

  const look = await client.call('/api/pay/lookup', { token: sale.id });
  assert.equal(look.status, 200);
  assert.equal(look.body.amount, 45000);
  assert.equal(look.body.matchCode, sale.matchCode);

  // Looking up must NOT charge anything.
  assert.equal((await pos.call(`/api/pos/sessions/${sale.id}`)).body.status, 'OPEN');

  const confirm = await client.call('/api/pay/confirm', {
    sessionId: look.body.sessionId, flowId: look.body.flowId, response: passkey.sign(look.body.options),
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.status, 'succeeded');

  const final = (await pos.call(`/api/pos/sessions/${sale.id}`)).body;
  assert.deepEqual([final.status, final.customer, final.last4], ['PAID', 'Som K.', '4242']);
});

test('two phones hear the same token at once: exactly one pays', async () => {
  const pos = await newPos();
  const a = await newCustomer('Asha Rao');
  const b = await newCustomer('Bala Iyer');
  const sale = (await pos.call('/api/pos/sessions', { amount: 120 })).body;

  const lookA = (await a.client.call('/api/pay/lookup', { token: sale.id })).body;
  const lookB = (await b.client.call('/api/pay/lookup', { token: sale.id })).body;

  const [ra, rb] = await Promise.all([
    a.client.call('/api/pay/confirm', { sessionId: sale.id, flowId: lookA.flowId, response: a.passkey.sign(lookA.options) }),
    b.client.call('/api/pay/confirm', { sessionId: sale.id, flowId: lookB.flowId, response: b.passkey.sign(lookB.options) }),
  ]);

  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const charged = db.prepare("SELECT COUNT(*) AS n FROM payment_sessions WHERE id = ? AND status = 'PAID'").get(sale.id);
  assert.equal(charged.n, 1);
});

test('an approval for one payment cannot be used for another', async () => {
  const pos = await newPos();
  const { client, passkey } = await newCustomer('Chitra N');
  const sale1 = (await pos.call('/api/pos/sessions', { amount: 10 })).body;
  const sale2 = (await pos.call('/api/pos/sessions', { amount: 9999 })).body;

  const look1 = (await client.call('/api/pay/lookup', { token: sale1.id })).body;
  const signedFor1 = passkey.sign(look1.options);

  const misuse = await client.call('/api/pay/confirm', { sessionId: sale2.id, flowId: look1.flowId, response: signedFor1 });
  assert.equal(misuse.status, 400);
  assert.equal((await pos.call(`/api/pos/sessions/${sale2.id}`)).body.status, 'OPEN');
});

test("someone else's passkey cannot approve my payment", async () => {
  const pos = await newPos();
  const victim = await newCustomer('Divya S');
  const attacker = await newCustomer('Eve X');
  const sale = (await pos.call('/api/pos/sessions', { amount: 50 })).body;

  const look = (await victim.client.call('/api/pay/lookup', { token: sale.id })).body;
  const res = await victim.client.call('/api/pay/confirm', {
    sessionId: sale.id, flowId: look.flowId, response: attacker.passkey.sign(look.options),
  });
  assert.equal(res.status, 400);
});

test('expired and cancelled tokens are refused', async () => {
  const pos = await newPos();
  const { client } = await newCustomer('Farah K');

  const old = (await pos.call('/api/pos/sessions', { amount: 30 })).body;
  db.prepare('UPDATE payment_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, old.id);
  assert.equal((await client.call('/api/pay/lookup', { token: old.id })).status, 404);
  assert.equal((await pos.call(`/api/pos/sessions/${old.id}`)).body.status, 'EXPIRED');

  const cancelled = (await pos.call('/api/pos/sessions', { amount: 30 })).body;
  assert.equal((await pos.call(`/api/pos/sessions/${cancelled.id}/cancel`, {})).body.ok, true);
  assert.equal((await client.call('/api/pay/lookup', { token: cancelled.id })).status, 404);
});

test('a token approved after expiry is not charged', async () => {
  const pos = await newPos();
  const { client, passkey } = await newCustomer('Gita M');
  const sale = (await pos.call('/api/pos/sessions', { amount: 30 })).body;
  const look = (await client.call('/api/pay/lookup', { token: sale.id })).body;

  db.prepare('UPDATE payment_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, sale.id);
  const res = await client.call('/api/pay/confirm', { sessionId: sale.id, flowId: look.flowId, response: passkey.sign(look.options) });
  assert.equal(res.status, 409);
});

test('access rules: sign-in, card, POS key, cross-site requests', async () => {
  const stranger = new Client();
  assert.equal((await stranger.call('/api/pay/lookup', { token: 'x' })).status, 401);
  assert.equal((await stranger.call('/api/pos/sessions', { amount: 10 })).status, 401);
  assert.equal((await stranger.call('/api/pos/login', { key: 'nope' })).status, 401);

  const noCard = new Client();
  const pk = new FakeAuthenticator(BASE);
  const opts = (await noCard.call('/api/register/options', { name: 'No Card' })).body;
  await noCard.call('/api/register/verify', { flowId: opts.flowId, response: pk.register(opts.options) });
  assert.equal((await noCard.call('/api/pay/lookup', { token: 'x' })).status, 400);

  const evil = await fetch(BASE + '/api/pos/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ key: 'test-pos-key' }),
  });
  assert.equal(evil.status, 403);
});

test('passkey sign-in on a new browser', async () => {
  const { passkey } = await newCustomer('Hari P');
  const fresh = new Client();
  const opts = (await fresh.call('/api/login/options', {})).body;
  assert.equal((await fresh.call('/api/login/verify', { flowId: opts.flowId, response: passkey.sign(opts.options) })).status, 200);
  assert.equal((await fresh.call('/api/me')).body.name, 'Hari P');
});

test('POS gets live CLAIMED and PAID events', async () => {
  const pos = await newPos();
  const { client, passkey } = await newCustomer('Indu R');
  const sale = (await pos.call('/api/pos/sessions', { amount: 75 })).body;

  const controller = new AbortController();
  const stream = await fetch(`${BASE}/api/pos/sessions/${sale.id}/events`, {
    headers: { Cookie: pos.cookies }, signal: controller.signal,
  });
  const reader = stream.body.getReader();

  const look = (await client.call('/api/pay/lookup', { token: sale.id })).body;
  await client.call('/api/pay/confirm', { sessionId: sale.id, flowId: look.flowId, response: passkey.sign(look.options) });

  let text = '';
  while (!text.includes('"PAID"')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();

  const statuses = [...text.matchAll(/"status":"(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(statuses, ['CLAIMED', 'PAID']);
  assert.match(text, /"customer":"Indu R."/);
});
