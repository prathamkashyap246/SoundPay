// npm run demo: start SoundPay with demo-friendly settings and print where to click.
// Mock payments (no Stripe), POS key "demo", its own database file. Any variable you set wins:
//   HOP_PROFILE=robust npm run demo        ORIGIN=https://xyz.trycloudflare.com npm run demo
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = {
  POS_KEY: 'demo',
  MERCHANT_NAME: 'Demo Café',
  DB_PATH: 'demo.db',
  PORT: '3000',
  ...process.env,
};
env.ORIGIN ||= `http://localhost:${env.PORT}`;
if (!process.env.STRIPE_SECRET_KEY) env.STRIPE_SECRET_KEY = '';

const server = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.on('data', d => {
  process.stdout.write(d);
  if (!String(d).includes('running')) return;
  const o = env.ORIGIN;
  console.log(`
  ┌─ SoundPay demo ─────────────────────────────────────────────────────────────
  │  1. Jam Lab (no phone needed)   ${o}/lab/
  │  2. Shop terminal (POS)         ${o}/pos.html        POS key: ${env.POS_KEY}
  │  3. Customer phone              ${o}/pay.html
  │  4. Range test + calibration    ${o}/rangetest.html
  │
  │  One laptop: open 2 and 3 in two windows. Approve with the laptop's fingerprint, or
  │  Chrome DevTools > More tools > WebAuthn > "Enable virtual authenticator".
  │  Real phone: needs https, e.g.  cloudflared tunnel --url ${o}
  │  then  ORIGIN=https://<printed-url> npm run demo   and open that URL on both.
  │  Script for presenting: docs/DEMO.md
  └─────────────────────────────────────────────────────────────────────────────
`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.kill(); process.exit(0); });
server.on('exit', code => process.exit(code ?? 0));
