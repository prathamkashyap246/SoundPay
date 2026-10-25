# The hop modem

A frequency-hopping acoustic modem that carries SoundPay's 16-character payment token from the POS speaker to
the customer's phone, built to keep working when someone tries to jam it. Code: `public/hop/` (runs in browsers
and Node), keys: `server/hop.js`, browser glue: `public/audio.js`, simulations: `tools/hopsim/`.

**What it protects:** availability, i.e. a payment that still goes through while someone jams the room.
**What it does not protect:** secrecy or the money. The token was always treated as public: the passkey approval
and the single-use atomic claim protect the money, and a false decode only yields a random token the server rejects.

## How a payment travels

```
server                              POS (laptop)                          phone
──────                              ────────────                          ─────
master secret (never leaves)
  │ HKDF(terminal, epoch)  ───────▶ epoch keys (≈2 min of them)
  │                        ───────────────────────────────────────────▶  epoch keys (signed in + card)
/api/time ◀──── 5 round trips ────  clock offset                          clock offset ──── 5 round trips
                                    every cycle g (3 s):                  mic ─▶ AudioWorklet ─▶ Web Worker
                                     plan = HMAC(key, "cycle<g>")           StreamDecoder: region around
                                     frame starts at exactly g*3 s ~~~~~~▶  g*3 s, try plan g (then g±1, g±2)
                                                                          token ─▶ /api/pay/lookup ─▶ passkey
```

1. **Keys.** `epochKey = HKDF-SHA256(master, salt "hopmodem/v1", info "terminal=<id>|epoch=<n>")`, one per 30 s.
   `/api/hop/keys` (signed-in customer with a card, rate limited) and `/api/pos/hop/keys` (POS login) return the
   keys for the previous epoch through two ahead. The server derivation is byte-identical to the browser's (tested).
2. **Clock.** Both sides estimate their offset from `/api/time` over 5 round trips and keep the lowest-RTT sample.
3. **Plan.** Cycle `g` starts at `g × cycleMs` on the server clock. Its hop plan is `HMAC-DRBG(epochKey, "cycle<g>")`,
   so every broadcast uses a fresh pattern, and one recorded broadcast says nothing about the next.
4. **Frame.** 8 preamble slots + Reed-Solomon RS(32,16) over GF(64); one 64 ms slot per tone; 96 tones from 15 to
   19.5 kHz, 46.875 Hz apart. The 10-byte payload (the token packed 5 bits per character) plus CRC-16 is 16 symbols.
5. **POS.** Schedules the frame on the AudioContext clock to start exactly on the cycle boundary (output latency
   subtracted), every cycle, until the payment is claimed.
6. **Phone.** An AudioWorklet posts 2048-sample chunks straight to a Web Worker. The worker's `StreamDecoder`
   keeps a ring buffer. Right after a frame should have ended it tries that cycle's plan (the early try). 1.5 s
   later it retries with the neighbouring cycles' plans too (the full try), which covers phone clocks off by up to
   about ±6 s. Every decode measures the real arrival delay, and later regions are re-centred on it.
7. **Receiver tricks.**
   - A 12 kHz high-pass removes speech, music and rumble before anything else.
   - Time-domain impulse blanking zeroes the few milliseconds of a hammer blow; slots that still carry a burst
     are erased.
   - Each channel is judged against its own noise floor, so uneven noise (a whine at 15–16 kHz) doesn't look like
     signal.
   - Preamble search finds the exact frame start.
   - Channels hot in ≥75% of slots are treated as persistent jammers and erased (excision).
   - Slots whose best tone doesn't clearly beat the runner-up become erasures.
   - RS repairs `2 × errors + erasures ≤ 16` (≤ 32 in the range profile), with retries that erase the
     least-confident slots.
8. **Link adaptation** (`server/link.js`).
   - **Adaptive hopping:** the phone's `ChannelMonitor` reports channels that stay noisy.
   - **Calibration:** the range-test page (and every later decode) measures how loud each of our tones arrived.
   - **Server output:** a mask and boost-only pre-emphasis gains, published as a schedule that takes effect on a
     cycle boundary two cycles ahead. The POS and all phones switch on the same frame.
   - **Limits:** at most 32 channels are ever left out; customer reports expire after 2 minutes; operator
     calibration outweighs customer reports.
   - **TDMA:** `TDMA_SLOT=k/N` makes terminal k send only on cycles where `g mod N = k`.

Fallbacks: no Web Worker → decoder on the page; no AudioWorklet → the ScriptProcessor feeds it; no 48 kHz audio,
no keys, or `AUDIO_MODE=ggwave` → ggwave. Phones always listen for ggwave as well.

## Profiles (`HOP_PROFILE`)

| profile | tone layout | frame | cycle | Charge → confirm (headless Chromium) |
|---|---|---|---|---|
| `fast` (default) | symbol + hop mod 96: 6 bits/slot, 64 candidate tones per slot | 2.56 s | 3 s | ≈3.5 s |
| `robust` | hop picks 1 of 12 sub-bands of 8 tones: 3 bits/slot, 8 candidates per slot | 4.61 s | 5 s | ≈7 s |
| `range` | like fast, RS(48,16) | 3.58 s | 4 s | ≈5 s |

`range` trades 1 s of airtime for 32 parity symbols instead of 16. That buys about 3 dB of distance on its
own, and about 6 dB (roughly twice the distance in free field) together with speaker calibration.

Why fast and robust? In `fast`, each slot's 64 candidate tones cover two thirds of the band. So **one** strong decoy tone that
keeps moving (it never looks persistent, so excision can't remove it) wins most slots, wherever the hop went.
Hopping barely helps against that. `robust` is classic FH/MFSK: a decoy must also land in the right sub-band
(1 in 12). The price is twice the slots per symbol, so a longer frame, and each RS symbol depends on two slots,
so it is weaker when many channels are jammed continuously. The table below shows exactly where each one wins.

## Results under attack (`tools/hopsim/sim-attacks.js`)

All signals at the same loudness; jam tones are 2x the modem's tone amplitude. Measured before the
interference-hardening round below (the hardening doesn't change how jammers are handled).

| attack (100 trials per cell, ±10 points near 50%) | ggwave (1.83 s) | modem, fixed channels (2.56 s) | **fast** hopping (2.56 s) | **robust** 8-tone sub-bands (4.61 s) | 4-tone sub-bands (6.66 s) |
|---|---|---|---|---|---|
| quiet room (noise σ=0.03) | 100% | 100% | 100% | 100% | 100% |
| very noisy room (σ=0.20) | 100% | 100% | 100% | 100% | 100% |
| random: jam 10% of channels | 0% | 99% | 99% | 99% | 100% |
| random: jam 25% of channels | 0% | 96% | 92% | 75% | 22% |
| random: jam 50% of channels | 0% | 47% | 48% | 1% | 0% |
| targeted: 24 loudest channels of the previous broadcast | 0% | 0% | 97% | 58% | 18% |
| targeted: 48 loudest channels of the previous broadcast | 0% | 0% | 46% | 0% | 0% |
| sweep: 1 tone across the band every 100 ms | 2% | 100% | 100% | 100% | 100% |
| sweep: 1 tone across the band every 1 s | 94% | 100% | 100% | 100% | 100% |
| sweep: 8 tones across the band every 500 ms | 0% | 100% | 100% | 99% | 100% |
| follower, reacts in 22 ms (fastest possible) | 0% | 0% | 1% | 97% | 99% |
| follower, reacts in 32 ms | 0% | 0% | 0% | 99% | 100% |
| follower, reacts in 48 ms | 0% | 0% | 0% | 98% | 100% |
| follower, reacts in 80 ms | 0% | 0% | 0% | 100% | 100% |

- ggwave fails as soon as 10% of channels are jammed, and under most sweeps.
- **fast** is the best general choice: it survives random jamming, replayed (targeted) jamming and sweeps, but
  never a follower.
- **robust** is the only layout that survives the follower, but persistent jamming of 25% or more hurts it.
- 4-tone sub-bands buy nothing over 8-tone and cost 2 s more airtime, so they stay out of the app.

## Results with everyday interference (`tools/hopsim/sim-noise.js`, 10 trials per cell: a first look)

"before" = the decoder before hardening. "hardened" = 12 kHz high-pass, time-domain impulse blanking,
burst-slot erasures, per-channel noise floor. "full" adds adaptive channel avoidance (AFH) from the phone's
ChannelMonitor, and speaker pre-emphasis from a one-time setup calibration.

| scenario | fast, before | fast, hardened | fast, full | robust, full |
|---|---|---|---|---|
| quiet room | 100% | 100% | 100% | 100% |
| construction: hammering 4/s + rumble | 100% | 100% | 100% | 100% |
| heavy construction: 10 impacts/s, louder | 100% | 100% | 100% | 100% |
| loud speech / music next to the phone | 100% | 100% | 100% | 100% |
| machine whine 15-16.5 kHz (2x the signal) | 100% | 100% | 100% | 100% |
| machine whine 15-17.5 kHz (4x the signal) | 10% | 100% | 100% | 100% |
| pest repeller aliased into 17-19.5 kHz | 100% | 100% | 100% | 100% |
| loud rumble clips the mic | 90% | 100% | 100% | 100% |
| second terminal, same loudness, overlapping | 20% | 20% | 20% | 100% |
| second terminal, 10 dB quieter, overlapping | 100% | 100% | 100% | 100% |
| far: -30 dB, laptop speaker -15 dB at 19.5 kHz | 20% | 20% | 10% | 30% |
| farther: -36 dB, same speaker | 0% | 0% | 0% | 0% |
| farthest: -42 dB, same speaker | 0% | 0% | 0% | 0% |
| everything: construction + speech + whine at -30 dB | 0% | 0% | 0% | 0% |

- Hardening fixed the wide machine whine (10% → 100%) and clipping (90% → 100%). Time-domain impulse blanking
  fixed robust's construction and clipping cases (from 50% and 0% to 100% in the first version).
- A second terminal at the same loudness defeats **fast** (20%): it behaves like a moving decoy. Terminals must
  take turns (time-division), or use robust.
- **Range is the weak point.** With a laptop-style 15 dB high-frequency roll-off, nothing decodes reliably at
  -30 dB. The ±6 dB pre-emphasis isn't enough to compensate. See the improvement report.


## Changes made to the modem during integration

- **Bug:** `deriveEpochKey` cached by terminal + epoch but not by secret, so a second secret silently got the
  first one's keys. The cache key now includes the secret. A wrong-key test caught it.
- **Sweep attack on excision:** a single tone sweeping the band every 100 ms made every channel look "hot" in more
  than 25% of slots, so the receiver erased 93 of 96 channels and failed 100% of the time. The persistence threshold
  is now 75% (a real continuous jammer is hot in ~100% of slots). Sweep: 0% → 100%, nothing else lost.
- **Capped margins:** the RS hard decision compared log-evidence capped at 5, so a strong signal and a strong
  interferer both read 5 and the slot was erased. Margins are now uncapped. One-tone 1 s sweep: 0% → 100%.
- **Sub-band mode** (`bits: 3` or `2`) and the `robust` profile, after the follower results.
- **Streaming decoder** (`stream.js`), worker engine, AudioWorklet tap, token packing, server keys, profiles.
- **Interference hardening:** 2 ms fades at slot edges (no clicks), a 12 kHz high-pass (`HighPass`),
  time-domain impulse blanking (`blankImpulses`), erasure of slots that still carry a burst, a per-channel
  noise floor, and channel masks (`mask`) plus per-channel gains (`gains`) in the frame builder.
  `monitor.js` finds persistently noisy channels and computes speaker calibration. **These are in the modem
  library and the simulations, but not yet wired into the app** (no endpoint, and the POS doesn't use masks or
  gains yet). The app's stream decoder does run the high-pass and the hardened decoder.

The original repetition-vs-Reed-Solomon table was re-run after these changes (100 trials, `tools/hopsim/sim.js`)
and matches the earlier 300-trial run within noise: for example jam 25%: hopping + RS 97%, targeted jam: hopping
+ RS 96%, fixed + RS 0%.

## What it does not stop

- **Insiders.** Any signed-in customer with a card gets the keys and can follow the hops. Registration is open, so
  this is a real hole for a determined attacker. Hopping stops outsiders, not insiders.
- **Loud wideband noise.** Any acoustic link loses to someone simply louder across the whole band. Hopping makes
  the attacker spend more power, it can't make that impossible.
- **Fast decoys against `fast`, heavy continuous jamming against `robust`.** See the table. Choosing per venue is
  a judgment call, not a free win.
- **Jammers that pulse** just under the 75% persistence threshold aren't excised and turn into errors instead.
  They weren't modelled.

## How it was tested, and what wasn't

- `npm test`: unit tests for plans, frames, RS limits, clock sync, sub-bands, token packing, the streaming decoder
  (chunked audio, clock errors, epoch boundaries, jamming, wrong keys, key requests, CPU cost), the worker engine,
  and the HTTP endpoints.
- `test/browser/e2e.mjs`: headless Chromium runs the real POS and phone pages. The POS audio buffers are played
  into the phone's (synthetic) microphone with noise. It passed in `hop`, `both` and `ggwave` modes, with 25% of
  channels jammed (hop), with a 32 ms follower (robust passes; fast never decodes), and with the no-worker and
  no-worklet fallbacks.
- **Not tested:** real speakers, microphones, rooms, phones (iOS Safari's 48 kHz resampling in particular), real
  attackers. The simulated channel is white noise plus ideal tones; no speaker/mic frequency response, clipping,
  echo or multipath. Treat every number here as an upper bound until real devices agree.
