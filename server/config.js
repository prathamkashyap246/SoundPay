// All settings come from environment variables (see .env.example).

const origin = process.env.ORIGIN || 'http://localhost:3000';

export const config = {
  port: Number(process.env.PORT || 3000),

  // The exact URL people open in the browser. Passkeys are tied to this hostname.
  origin,
  rpID: new URL(origin).hostname,
  rpName: 'SoundPay',

  // POS login key and the merchant name shown on the customer's confirm screen.
  posKey: process.env.POS_KEY || 'change-me',
  merchantName: process.env.MERCHANT_NAME || 'Demo Café',
  currency: (process.env.CURRENCY || 'inr').toLowerCase(),

  // How long a broadcast token stays claimable.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 30),

  // Leave blank to run in mock-payment mode (no real Stripe calls).
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  dbPath: process.env.DB_PATH || 'soundpay.db',

  // How the token travels over sound:
  //   hop    = frequency-hopping modem (public/hop/), phones still also listen for ggwave (default)
  //   ggwave = the original ggwave-only behaviour
  //   both   = POS alternates: hop frame on even cycles, ggwave on odd cycles (for older phones)
  audioMode: ['hop', 'ggwave', 'both'].includes(process.env.AUDIO_MODE) ? process.env.AUDIO_MODE : 'hop',
  // Master secret for hop keys. Blank = random one, stored in the database.
  hopSecret: process.env.HOP_SECRET || '',
  // fast (default, ~3 s per broadcast), robust (~5 s, survives a moving/follower jammer and a neighbouring
  // terminal), or range. See public/hop/profiles.js.
  // range: ~4 s per broadcast, more error correction for longer distances.
  hopProfile: ['robust', 'range'].includes(process.env.HOP_PROFILE) ? process.env.HOP_PROFILE : 'fast',
  // Several terminals in one shop: "k/N" = this terminal only sends on cycles where cycle % N == k.
  tdmaSlot: process.env.TDMA_SLOT || '0/1',
  // Names this POS in the hop key derivation. Give every terminal its own id.
  terminalId: process.env.TERMINAL_ID || 'pos-1',
};

export const isHttps = origin.startsWith('https://');
