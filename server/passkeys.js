// WebAuthn (passkeys) using SimpleWebAuthn.
// Three ceremonies: register a new account, sign in, and approve one payment.
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';
import * as users from './users.js';

// Errors here are the user's fault (expired, wrong key), not the server's: answer 400.
function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// ---- short-lived "flows": remember the challenge between the two requests ----
const flows = new Map();
const FLOW_MS = 2 * 60 * 1000;

function startFlow(data) {
  const flowId = crypto.randomBytes(16).toString('base64url');
  flows.set(flowId, { ...data, expires: Date.now() + FLOW_MS });
  return flowId;
}

// One-time use: a flow is deleted the moment it's read.
function takeFlow(flowId, kind) {
  const flow = flows.get(flowId);
  flows.delete(flowId);
  if (!flow || flow.kind !== kind || flow.expires < Date.now()) return null;
  return flow;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, f] of flows) if (f.expires < now) flows.delete(id);
}, 60_000).unref();

const expected = { expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true };

// ---- 1. Register (creates the account) ----

export async function registrationOptions(name) {
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: name,
    userDisplayName: name,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const flowId = startFlow({ kind: 'register', userId, name, challenge: options.challenge });
  return { flowId, options };
}

export async function verifyRegistration(flowId, response) {
  const flow = takeFlow(flowId, 'register');
  if (!flow) throw fail('Registration expired, try again');

  const result = await verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, ...expected });
  if (!result.verified) throw fail('Passkey not verified');

  users.createUser(flow.userId, flow.name);
  users.addPasskey(flow.userId, result.registrationInfo.credential);
  return flow.userId;
}

// ---- 2. Sign in (any passkey saved on this device) ----

export async function loginOptions() {
  const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
  const flowId = startFlow({ kind: 'login', challenge: options.challenge });
  return { flowId, options };
}

export async function verifyLogin(flowId, response) {
  const flow = takeFlow(flowId, 'login');
  if (!flow) throw fail('Sign-in expired, try again');
  const passkey = await checkAssertion(response, flow.challenge);
  return passkey.userId;
}

// ---- 3. Approve ONE specific payment ----
// The challenge is tied to (user, payment session), so an approval for one
// payment can never be replayed against a different one.

export async function paymentOptions(userId, sessionId) {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    allowCredentials: users.listPasskeys(userId),
  });
  const flowId = startFlow({ kind: 'pay', userId, sessionId, challenge: options.challenge });
  return { flowId, options };
}

export async function verifyPayment(flowId, response, userId, sessionId) {
  const flow = takeFlow(flowId, 'pay');
  if (!flow || flow.userId !== userId || flow.sessionId !== sessionId) {
    throw fail('Approval expired, try again');
  }
  const passkey = await checkAssertion(response, flow.challenge);
  if (passkey.userId !== userId) throw fail('Passkey belongs to a different account');
}

// ---- shared ----

async function checkAssertion(response, challenge) {
  const passkey = users.getPasskey(response?.id);
  if (!passkey) throw fail('Unknown passkey');

  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: challenge, credential: passkey, ...expected,
  });
  if (!result.verified) throw fail('Passkey not verified');

  users.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter);
  return passkey;
}
