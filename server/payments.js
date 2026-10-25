// Payments. Two modes:
//   mock   - no keys set. Cards are fake, every charge succeeds. Good for building the audio + UX.
//   stripe - STRIPE_SECRET_KEY set (use a TEST key). Real PaymentIntents in test mode.
import Stripe from 'stripe';
import { config } from './config.js';
import * as users from './users.js';

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
export const mode = stripe ? 'stripe' : 'mock';

if (stripe && !config.stripeSecretKey.startsWith('sk_test_')) {
  console.warn('WARNING: STRIPE_SECRET_KEY is not a test key. Use sk_test_... for the hackathon.');
}

// ---- saving a card (done once, at signup) ----

export async function startCardSetup(user) {
  if (mode === 'mock') return { mode };

  let customerId = user.stripe_customer;
  if (!customerId) {
    const customer = await stripe.customers.create({ name: user.name, metadata: { user_id: user.id } });
    customerId = customer.id;
    users.setStripeCustomer(user.id, customerId);
  }
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'on_session',            // the customer is always present (passkey) when we charge
  });
  return { mode, clientSecret: setupIntent.client_secret, publishableKey: config.stripePublishableKey };
}

export async function finishCardSetup(user, setupIntentId) {
  if (mode === 'mock') {
    users.saveCard(user.id, { paymentMethod: 'pm_mock', last4: '4242' });
    return;
  }
  // Never trust the browser: re-read the SetupIntent from Stripe and check it's ours.
  const si = await stripe.setupIntents.retrieve(setupIntentId);
  if (si.customer !== user.stripe_customer || si.status !== 'succeeded') {
    throw new Error('Card setup not completed');
  }
  const pm = await stripe.paymentMethods.retrieve(si.payment_method);
  users.saveCard(user.id, { paymentMethod: pm.id, last4: pm.card?.last4 || '????' });
}

// ---- charging ----
// Returns { status: 'succeeded' | 'requires_action' | 'failed', ref, clientSecret?, reason? }

export async function charge(session, user) {
  if (mode === 'mock') return { status: 'succeeded', ref: `mock_${session.id}` };

  try {
    const pi = await stripe.paymentIntents.create({
      amount: session.amount,
      currency: session.currency,
      customer: user.stripe_customer,
      payment_method: user.payment_method,
      payment_method_types: ['card'],
      confirm: true,
      description: `${session.merchant_name} (SoundPay)`,
      metadata: { session_id: session.id },
    }, {
      idempotencyKey: `pay_${session.id}`,   // a retry can never create a second charge
    });
    return fromPaymentIntent(pi);
  } catch (err) {
    // Declines come back as errors, not as a status.
    return { status: 'failed', ref: err.payment_intent?.id || null, reason: err.message };
  }
}

// Used after the phone finishes a 3-D Secure step: ask Stripe, don't trust the phone.
export async function checkPayment(ref) {
  if (mode === 'mock') return { status: 'succeeded', ref };
  return fromPaymentIntent(await stripe.paymentIntents.retrieve(ref));
}

function fromPaymentIntent(pi) {
  if (pi.status === 'succeeded') return { status: 'succeeded', ref: pi.id };
  if (pi.status === 'requires_action') return { status: 'requires_action', ref: pi.id, clientSecret: pi.client_secret };
  if (pi.status === 'processing') return { status: 'processing', ref: pi.id };
  return { status: 'failed', ref: pi.id, reason: pi.last_payment_error?.message || pi.status };
}

// ---- webhooks (optional but recommended: Stripe's word is final) ----

export function parseWebhook(rawBody, signature) {
  if (!stripe || !config.stripeWebhookSecret) throw new Error('Webhooks not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}
