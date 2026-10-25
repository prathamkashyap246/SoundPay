# Paying with UPI (design, not yet built)

**Why:** most people in India pay with UPI, not cards, and Stripe India is invite-only. UPI support is the single
biggest change for who can use SoundPay. The sound layer doesn't change at all. Only how the money moves changes.

**Status:** design only. It needs a payment-aggregator account (Razorpay is used below; Cashfree and PayU have
equivalents), and a real money integration shouldn't ship untested. API details are from Razorpay's public docs
as I know them. Check them against the current docs before building.

## Which UPI flow

| Flow | Fits SoundPay? | Why |
|---|---|---|
| **UPI intent / collect via the aggregator's checkout** | **Yes** | The customer's UPI app shows payee + amount and asks for the UPI PIN. Works on any phone with a UPI app. |
| UPI AutoPay (mandate) | No | Built for recurring debits, with pre-debit notices. Not for an instant counter payment. |
| UPI Lite / Lite X | No (for now) | Lives inside the UPI apps (on-device balance). A third-party web app can't trigger it. |
| Own PSP / UPI licence | No | A bank/NPCI relationship. Way out of scope. |

## The flow

```
POS ~~~ sound / QR ~~~▶ phone hears token
phone ── /api/pay/lookup ──▶ server        merchant, amount, match code (unchanged)
phone shows confirm screen; customer taps "Pay ₹450 with UPI"
phone ── /api/pay/confirm ─▶ server        claim the session atomically (unchanged), then
                                            Razorpay: POST /v1/orders {amount, currency:"INR", receipt:<session id>,
                                                                     notes:{session_id}}
       ◀── { status:'requires_action', provider:'razorpay', orderId, keyId }
phone opens Razorpay Checkout (checkout.js) with order_id, method UPI → the customer picks a UPI app → PIN
phone ── /api/pay/finalize {razorpay_payment_id, razorpay_order_id, razorpay_signature} ─▶ server
server verifies  HMAC_SHA256(order_id + "|" + payment_id, key_secret) == signature
       and/or fetches GET /v1/orders/<id>/payments; status "captured" → finishPaid (POS sees "Paid")
Razorpay webhook payment.captured / payment.failed (X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret))
       → finishPaid / finishFailed, same as the Stripe webhook today
```

**Passkey:** with UPI, the UPI PIN is the strong authentication. The SoundPay passkey can become optional:
- **Keep it** for speed (one fingerprint for SoundPay plus the PIN in the UPI app).
- **Drop it**, which removes the requirement for Android 9+ / iOS 16+.

The match code still prevents relay attacks either way. Recommendation: keep passkeys optional, required only
when a card is on file.

## Changes, file by file

| File | Change |
|---|---|
| `server/config.js` | `PAYMENTS_PROVIDER=mock|stripe|razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| `server/payments.js` | A `razorpay` mode with the same interface: `startCardSetup` → `{ mode }` (nothing to save), `charge` → create order, return `requires_action` with `orderId`/`keyId`, `checkPayment(ref, proof)` → verify signature + fetch payments, `parseWebhook` → verify `X-Razorpay-Signature` |
| `server/index.js` | `/api/pay/lookup` must not require a saved card when the provider is UPI. `/api/pay/finalize` accepts the Razorpay proof. Add a `/api/webhooks/razorpay` raw-body route next to Stripe's. |
| `server/users.js` | Treat "UPI" as a payment method (`payment_method = 'upi'`, no last4) |
| `public/pay.js` | On `requires_action` with `provider: 'razorpay'`, load `https://checkout.razorpay.com/v1/checkout.js` and open it with `order_id`, `prefill.method = 'upi'`. Its handler posts the three ids to `/api/pay/finalize`. Card setup screen is skipped for UPI. |
| `test/` | A fake Razorpay HTTP server (orders, payments, signed webhooks) so the API tests run without a real account |

## Business and regulation

- The aggregator holds the payment-aggregator licence. SoundPay never holds funds.
- Each shop is a merchant on the aggregator (KYC). For a multi-shop product, use the aggregator's marketplace /
  split-settlement product (Razorpay Route) so money goes to the right shop.
- Idempotency: the session id is the order `receipt`. `/api/pay/confirm` already claims the session once, so a
  retry can't create a second order for the same sale.
- Refunds/disputes go through the aggregator's dashboard to start with.
