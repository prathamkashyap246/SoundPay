import { api, money, show, $, sleep, runTimer } from '/common.js';
import { createTransmitter, drawBand } from '/audio.js';

const VIEWS = ['v-login', 'v-amount', 'v-charging', 'v-done'];

let tx = null;      // audio transmitter, created on the first "Charge" click
let sale = null;    // the sale currently on screen

// ---------------------------------------------------------------- start up

async function init() {
  try {
    const me = await api('/api/pos/me');
    $('merchant').textContent = me.merchant;
    showAmount();
  } catch {
    show('v-login', VIEWS);
    $('pos-key').focus();
  }
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    const r = await api('/api/pos/login', { key: $('pos-key').value });
    $('merchant').textContent = r.merchant;
    showAmount();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

function showAmount() {
  show('v-amount', VIEWS);
  $('amount').value = '';
  $('amount').focus();
}

// ---------------------------------------------------------------- a sale

$('amount-form').addEventListener('submit', e => {
  e.preventDefault();
  tx ??= createTransmitter();          // must happen inside the click, before any await
  startSale($('amount').value);
});

async function startSale(amountText) {
  $('amount-error').hidden = true;
  let s;
  try {
    s = await api('/api/pos/sessions', { amount: Number(String(amountText).replace(/,/g, '')) });
  } catch (err) {
    show('v-amount', VIEWS);
    $('amount-error').textContent = err.message;
    $('amount-error').hidden = false;
    return;
  }

  sale = { ...s, state: 'OPEN', amountText };

  $('c-amount').textContent = money(s.amount, s.currency);
  $('c-code').textContent = s.matchCode;
  $('c-token').textContent = s.id.match(/.{4}/g).join(' ');
  showQr(s.id);
  $('c-status').textContent = 'Customer: tap Pay and hold your phone near this screen.';
  show('v-charging', VIEWS);

  sale.stopTimer = runTimer($('c-timer'), s.expiresAt);
  sale.stopBand = drawBand($('c-band'), tx.analyser, tx.ctx.sampleRate);

  sale.events = new EventSource(`/api/pos/sessions/${s.id}/events`);
  sale.events.onmessage = e => onServerEvent(sale, JSON.parse(e.data));

  sale.expiryTimer = setTimeout(() => checkExpired(sale), s.expiresAt - Date.now() + 1500);

  broadcast(sale);
}

const MODE_LABEL = {
  hop: 'Sending with frequency hopping',
  both: 'Sending with frequency hopping + ggwave',
  ggwave: 'Sending with ggwave',
};

// Fallback for phones that can't hear 15+ kHz: a QR code that opens the pay page with this token.
// It carries nothing the typed code doesn't (the token is public; the passkey protects the money), and unlike a
// printed QR sticker it changes every sale, so it can't be swapped for a fraudster's.
function showQr(token) {
  const box = $('c-qr');
  box.textContent = '';
  if (!window.qrcode) return;
  const q = window.qrcode(0, 'M');
  q.addData(`${location.origin}/pay.html#t=${token}`);
  q.make();
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// Repeat the token until someone claims it or it expires.
async function broadcast(current) {
  while (current.state === 'OPEN' && Date.now() < current.expiresAt) {
    const sent = await tx.send(current.id).then(() => true, err => { console.warn('send failed', err); return false; });
    $('c-mode').textContent = MODE_LABEL[tx.mode] || '';
    await sleep(sent ? tx.gapMs : 1000);
  }
}

function onServerEvent(current, data) {
  if (current !== sale) return;                       // an old sale's event
  if (data.status === 'CLAIMED') {
    current.state = 'CLAIMED';
    tx.stop();
    $('c-status').textContent = `${data.customer} is approving on their phone…`;
  }
  if (data.status === 'PAID') finish(current, 'paid', data);
  if (data.status === 'FAILED') finish(current, 'failed', data);
  if (data.status === 'CANCELLED') finish(current, 'cancelled', data);
}

// The countdown ran out locally. Ask the server what actually happened,
// so a payment approved in the last second is never shown as "not paid".
async function checkExpired(current) {
  if (current !== sale || current.state === 'done') return;
  const s = await api(`/api/pos/sessions/${current.id}`).catch(() => null);
  if (!s || s.status === 'EXPIRED') return finish(current, 'expired', {});
  if (s.status === 'CLAIMED') {
    current.expiryTimer = setTimeout(() => checkExpired(current), 3000);   // still approving
    return;
  }
  onServerEvent(current, s);
}

$('c-cancel').addEventListener('click', async () => {
  const current = sale;
  const r = await api(`/api/pos/sessions/${current.id}/cancel`, {}).catch(() => ({ ok: false }));
  if (r.ok) finish(current, 'cancelled', {});
  else $('c-status').textContent = 'Too late to cancel: the customer is already approving.';
});

// ---------------------------------------------------------------- outcome

const OUTCOMES = {
  paid:      { title: 'Paid',      box: 'paid',   retry: false },
  failed:    { title: 'Declined',  box: 'failed', retry: true },
  expired:   { title: 'Not paid',  box: 'failed', retry: true },
  cancelled: { title: 'Cancelled', box: '',       retry: true },
};

function finish(current, outcome, data) {
  if (current.state === 'done') return;
  current.state = 'done';
  tx.stop();
  current.stopTimer?.();
  current.stopBand?.();
  current.events?.close();
  clearTimeout(current.expiryTimer);

  const o = OUTCOMES[outcome];
  $('d-box').className = `result ${o.box}`;
  $('d-title').textContent = o.title;
  $('d-amount').textContent = money(current.amount, current.currency);
  $('d-detail').textContent = {
    paid: `${data.customer}, card ending ${data.last4}`,
    failed: data.reason || 'The card was declined.',
    expired: 'No one approved it in time.',
    cancelled: 'Nothing was charged.',
  }[outcome];
  $('d-retry').hidden = !o.retry;
  show('v-done', VIEWS);
  (o.retry ? $('d-retry') : $('d-new')).focus();
}

$('d-retry').addEventListener('click', () => startSale(sale.amountText));
$('d-new').addEventListener('click', showAmount);

init();
