// Small helpers shared by the POS and customer pages.

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function money(amountInPaise, currency = 'inr') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency.toUpperCase() })
    .format(amountInPaise / 100);
}

// Show exactly one of the given sections.
export function show(id, allIds) {
  for (const other of allIds) document.getElementById(other).hidden = other !== id;
}

export const $ = id => document.getElementById(id);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Shrinks a bar from full to empty over the time left.
export function runTimer(barEl, expiresAt) {
  const total = expiresAt - Date.now();
  let frame = 0;
  function tick() {
    const left = Math.max(0, expiresAt - Date.now());
    barEl.style.transform = `scaleX(${total > 0 ? left / total : 0})`;
    if (left > 0) frame = requestAnimationFrame(tick);
  }
  tick();
  return () => cancelAnimationFrame(frame);
}
