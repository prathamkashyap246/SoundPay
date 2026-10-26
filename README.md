# SoundPay

Contactless payments with no card reader. The shop's web terminal plays a short, near-silent audio code
(about 15–19.5 kHz). The customer's phone hears it, shows the shop and amount, and the customer approves
with a passkey (fingerprint / face).

```
POS (laptop)                       Server                         Phone
────────────                       ──────                         ─────
Charge ₹450 ───────────────▶ create session {token, ₹450, code 46}
play token over sound ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~▶ hears token
                                    ◀─────────────────────────── lookup(token)
                                    ──── Demo Café, ₹450, code 46 ▶ shows confirm screen
                                                                   user checks code matches POS
                                    ◀──────────── passkey approval for THIS payment
                             verify passkey
                             claim token (once, atomically)
                             charge card (Stripe / mock)
"Paid by Pratham." ◀── live event ─────
```

**Contents:** [Quick start](#quick-start) · [Real phone](#use-a-real-phone) · [Stripe](#stripe-test-mode) ·
[Sound modes](#sound-modes) · [Testing](#testing) · [Security](#security-design) ·
[Project structure](#project-structure) · [Known limitations](#known-limitations)

## Quick start

Requires Node 22.13 or newer (uses the built-in `node:sqlite`). No Stripe account needed.

```bash
npm install
npm run demo          # mock payments, POS key "demo"; prints the links below
```

- **Terminal** `/pos.html` and **phone** `/pay.html`: a real payment. One laptop works (two windows).
- **Jam Lab** `/lab/`: try to jam a payment in a simulated room, ggwave vs the hop modem, no phone needed.
  `npm run build:lab` makes a single offline file, `dist/jam-lab.html`.
- **Range test** `/rangetest.html`: measure distance on real devices and calibrate the speaker.

To run with your own settings instead:

```bash
npm install
cp .env.example .env      # set POS_KEY
npm start
```

Open `http://localhost:3000`. On one laptop, open the POS in one tab and the pay page in another; the laptop's
speakers and mic carry the signal. Approve with your laptop's fingerprint / Windows Hello, or use Chrome
DevTools > More tools > WebAuthn > "Enable virtual authenticator".

Status and planned improvements: [docs/REPORT.md](docs/REPORT.md).

## Use a real phone

Phones need **https** for the microphone and passkeys.

```bash
cloudflared tunnel --url http://localhost:3000      # or: ngrok http 3000
```

1. Put the printed `https://….trycloudflare.com` URL in `.env` as `ORIGIN`, then restart.
2. Open that URL on the laptop (POS) **and** the phone (pay page).

Passkeys are tied to the hostname. A quick tunnel gets a new URL on every run, so accounts made on the old
URL stop working. For a fixed URL, use a named tunnel or deploy (Render / Railway).

## Stripe test mode

1. Get test keys from the Stripe dashboard (`sk_test_…`, `pk_test_…`) and add them to `.env`.
2. Run `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and put the printed `whsec_…` in
   `STRIPE_WEBHOOK_SECRET`.
3. Restart. Save card `4242 4242 4242 4242`. Card `4000 0025 0000 3155` triggers a 3-D Secure popup, which
   the phone handles.

Stripe India is invite-only for new accounts, but test mode works on any existing account.
`server/payments.js` is the only file to change for Razorpay.

## Sound modes

By default the token travels over a **frequency-hopping modem** (`public/hop/`, details in
[docs/HOPMODEM.md](docs/HOPMODEM.md)) instead of ggwave.

**How hopping works**
- 96 tones between 15 and 19.5 kHz. Every 64 ms the signal jumps to a channel chosen by a key, and every
  3-second broadcast uses a new pattern, so an attacker who recorded one broadcast can't predict the next.
- The server keeps one master secret and hands out a separate key for each 30 seconds, only to signed-in
  customers with a card and to the signed-in POS (`/api/hop/keys`, `/api/pos/hop/keys`).
- The POS starts each frame exactly on a 3-second boundary of the server clock (`/api/time`). The phone
  decodes in a Web Worker fed by an AudioWorklet, and uses the clock to pick the right pattern.
- Reed-Solomon error correction repairs jammed or unreadable slots. The receiver filters out everything below
  12 kHz (speech, music, construction rumble), blanks hammer-blow impulses, and ignores channels a jammer
  sits on.

**Adaptation and fallbacks**
- **Adaptive hopping:** the phone reports channels that stay noisy (machine whine, ultrasonic beacons, pest
  repellers, jammers) to `/api/hop/report`. The server schedules a new channel set two cycles ahead, and the
  POS and every phone switch on the same frame. At most 32 channels are ever left out.
- **Speaker calibration:** the range-test page measures how loud each tone arrives, and phones refine it
  after each payment. The POS boosts the tones its speaker plays weakly (boost only, up to +5.6 dB) and skips
  the ones it can't play.
- **Several terminals in one shop:** set `TDMA_SLOT=k/N` so terminal k only sends on every N-th cycle.
- **Phones that can't hear the band:** a QR code on the POS (`/pay.html#t=<token>`, new every sale, so it
  can't be swapped like a printed sticker) and a typed code.
- **On the phone:** a signal meter ("move closer", "very loud here"), vibration when the terminal is heard,
  and "Read this aloud" on the confirm screen.

What hopping buys you is **jamming resistance, not secrecy**. The token was always public (the passkey and
the one-time claim protect the money), and every signed-in customer can get the keys.

### `AUDIO_MODE`

| `AUDIO_MODE` | POS sends | Phone listens for |
|---|---|---|
| `hop` (default) | hop frames | hop + ggwave |
| `both` | hop and ggwave on alternating cycles | hop + ggwave |
| `ggwave` | ggwave, as before | ggwave |

The POS also falls back to ggwave if the browser can't run audio at 48 kHz or it can't get keys.

### `HOP_PROFILE`

Picks the hop layout. None is best everywhere (see the tables in [docs/HOPMODEM.md](docs/HOPMODEM.md)).

| `HOP_PROFILE` | Frame / cycle | Charge → confirm (headless Chromium) | Survives | Loses to |
|---|---|---|---|---|
| `fast` (default) | 2.56 s / 3 s | about 3.5 s | random and replayed jamming, sweeps | a follower or any fast-moving decoy tone |
| `robust` | 4.61 s / 5 s | about 7 s | follower / moving decoys, a second terminal, sweeps, light jamming | many channels jammed continuously |
| `range` | 3.58 s / 4 s | about 5 s | like fast, with more distance and jam margin (RS(48,16)) | a follower |

ggwave takes about 2 s and survives none of the jammers.

## Testing

```bash
npm test
```

| Test | What it proves |
|---|---|
| happy path | hear → lookup (no charge) → passkey → charged → POS sees "Paid" |
| two phones, same token | exactly one is charged, the other gets 409 |
| approval reuse | a passkey approval for payment A can't pay payment B |
| someone else's passkey | can't approve my payment |
| expired / cancelled | refused, including an approval that lands after expiry |
| access rules | sign-in, card, POS key, cross-site POSTs blocked |
| live events | POS receives CLAIMED then PAID |
| audio round-trip | token survives 25% volume plus noise, takes < 2.5 s, energy sits above 14 kHz |
| hop API | `/api/time`; hop keys need sign-in + card (customer) or the POS login; server keys are byte-identical to the browser's derivation; the master secret never leaves; rate limit |
| link adaptation | noisy-channel reports are validated, capped at 32 channels and scheduled two cycles ahead on a boundary; operator calibration gives boost-only gains; reset |
| hop modem | hop plans, round trips, wrong key fails, Reed-Solomon limits, clock sync, sub-band mode, repetition mode |
| hop stream | token packing; the streaming decoder hears every broadcast from mic-sized chunks, with clock errors of several seconds, across key epochs, with 25% of channels jammed; wrong keys / other terminals hear nothing; the worker engine; idle CPU cost; robust profile under a follower; a mask switching mid-stream; the channel monitor finding a whine under loud speech |

The API tests use a software passkey, so the real WebAuthn signature checks run.

### Real-browser tests

```bash
npm i -D playwright && npx playwright install chromium
npm run test:browser                   # all of the runs below
node test/browser/e2e.mjs hop          # or: ggwave, both, qr;  2nd argument: fraction jammed (0.25) or follower32
HOP_PROFILE=robust node test/browser/e2e.mjs hop follower32
E2E_NO_WORKER=1 node test/browser/e2e.mjs hop        # also E2E_NO_WORKLET=1: the fallback paths
node test/browser/rangetest.mjs        # range-test page: calibration through a weak speaker, then a recording
```

Headless Chromium opens the POS and the phone page. The POS page's real audio code runs, and every buffer it
schedules is played into the phone page's microphone (a controlled MediaStream with room noise) at the same
moment. The phone's real AudioWorklet → Web Worker receiver decodes it, a virtual passkey approves, and both
screens must show Paid. With channels jammed it also checks that the phone's reports made the POS hop around
them. `qr` pays through the POS's QR code instead of sound. This checks the browser code paths, not speakers,
microphones or rooms.

### Simulations

```bash
node tools/hopsim/sim-attacks.js 100   # ggwave vs fixed vs the hop profiles under 14 attacks
node tools/hopsim/sim-noise.js 100     # construction, speech, whine, pest repeller, clipping, 2nd terminal, distance
node tools/hopsim/sim.js 300           # repetition vs Reed-Solomon, hopping vs fixed
node tools/hopsim/sim-clock.js 100     # clock-error tolerance
```

## Security design

| Hole | Fix | Where |
|---|---|---|
| Rogue speaker charges nearby phones | Nothing is charged until the user sees shop + amount and approves with a passkey | `pay.js`, `/api/pay/confirm` |
| Wrong customer in the queue | Same approval step, plus the POS shows who is paying | `pos.js` |
| Relay to another location | 2-digit match code: phone and POS must show the same number | `match_code` |
| Double charge race | One SQL `UPDATE … WHERE status='OPEN' … RETURNING` claims the token | `sessions.js` `claimSession` |
| Approval replay | Passkey challenge is tied to one user and one payment, single use | `passkeys.js` |
| Amount tampering | Amount lives only on the server; the audio carries just the token | `/api/pos/sessions` |
| Retry double charge | Stripe idempotency key = token | `payments.js` |
| Passive listening | Mic only opens after the user taps Pay, closes after | `audio.js` |
| CSRF | Origin check on every POST, SameSite cookies | `index.js` |
| Jamming the payment (DoS) | Keyed frequency hopping with a new pattern per broadcast, Reed-Solomon, jammer excision; `HOP_PROFILE=robust` against follower jammers | `public/hop/`, `server/hop.js` |

## Project structure

```
server/
  index.js      routes
  sessions.js   payment tokens + the atomic claim
  passkeys.js   WebAuthn register / sign-in / approve-a-payment
  payments.js   Stripe or mock (UPI design: docs/UPI.md)
  events.js     live updates to the POS (Server-Sent Events)
  hop.js        hop master secret + per-30-second keys
  link.js       adaptive hopping, speaker calibration, TDMA: the schedule POS and phones follow
  users.js, db.js, tokens.js, config.js
public/
  pos.html/js   shop terminal (with the QR fallback)
  pay.html/js   customer phone (signal meter, read-aloud, QR landing)
  rangetest.*   range test + speaker calibration
  audio.js      send / receive (hop + ggwave) + the live spectrum strip
  hop/          the frequency-hopping modem (runs in the browser and in Node)
    modem.js      tones, frames, sync, excision, high-pass, impulse blanking, decoding
    rs.js         Reed-Solomon over GF(64)        hop.js      keyed hop plans
    timing.js     server clock, epoch keys       profiles.js fast / robust / range, link schedule lookup
    stream.js     streaming decoder for live microphone audio
    monitor.js    noisy channels, signal stats, speaker calibration maths
    token.js      16-char token <-> 10 bytes
    engine.js, worker.js   decoder in a Web Worker    mic-worklet.js  AudioWorklet mic tap
  lab/          Jam Lab: engine.js (one simulated payment), models.js (noise + jammers), lab.js/css, index.html
test/           npm test;  test/browser/  real-browser runs (e2e.mjs, rangetest.mjs)
tools/
  hopsim/       simulations: sim-attacks.js, sim-noise.js, sim.js, sim-clock.js
  demo.mjs      npm run demo          build-lab.mjs   npm run build:lab
docs/
  HOPMODEM.md   how the modem works, measured results, limits
  REPORT.md     status and what to improve next
  UPI.md        design for UPI payments             screenshots/
```

## Known limitations

This is a working prototype. Fix these before handling real money.

**Scaling and payments**
- Pending passkey challenges and rate limits live in memory, so run one server process. Move them to Redis or
  the database to scale out.
- Link adaptation state (noisy channels, calibration) is per server and for one terminal id. Several
  terminals need their own `TERMINAL_ID` and `TDMA_SLOT`, and today one server process each.
- Payments are card-only (Stripe or mock). UPI is designed ([docs/UPI.md](docs/UPI.md)), not built.

**Audio**
- Some people (mostly under 25) can faintly hear 15 kHz. ggwave's ultrasonic mode starts there.
- Cheap laptop speakers vary a lot above 16 kHz. Calibrate on the actual laptop (`/rangetest.html`) and keep
  the QR / typed-code fallback.
- The hop modem has only been tested in simulation and in headless Chromium. Real speakers, microphones and
  rooms are untested: try it on your own laptop and phones, and keep `AUDIO_MODE=both` or `ggwave` handy.
- A fast-moving jammer (one strong decoy tone that changes every few tens of ms, or a follower) defeats
  ggwave and the `fast` and `range` profiles. Use `HOP_PROFILE=robust` where that's a threat. See "What it
  does not stop" in [docs/HOPMODEM.md](docs/HOPMODEM.md).
- ggwave still uses `ScriptProcessorNode` for the mic because it works on every phone browser. The hop
  receiver uses an `AudioWorklet` and a Web Worker, and falls back to the ScriptProcessor on old browsers.

**Security**
- Hop keys go to every signed-in customer with a card, and registration is open. Anyone who signs up can
  follow the hops, so hopping stops outsiders who jam, not insiders.
