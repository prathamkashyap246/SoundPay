# SoundPay hop modem: status and improvement report

Date: 25 Oct 2026. Covers the frequency-hopping audio layer added to SoundPay, and the three questions raised:
range, feasibility for real users, and interference (audible and inaudible).

## Summary

| Area | State | Evidence | Priority to improve |
|---|---|---|---|
| Anti-jamming (attackers) | **Strong in simulation** | ggwave fails at 10% jammed; hop survives random, replayed and sweep jamming; robust profile survives followers | Medium |
| Everyday interference | **Good in simulation** | Construction, speech/music, machine whine, pest-repeller alias, mic clipping: 100% after hardening | Low–medium |
| Range / distance | **Improved, still the weakest area** | Boost-only speaker calibration + `range` profile: -30 dB with laptop roll-off fast 2/10 → 10/10, -33 dB range 0/10 → 9/10 (Jam Lab engine, 10 trials); nothing works at -36 dB | **High** |
| Multiple terminals in one shop | **Solved by config** | `TDMA_SLOT=k/N` (tested in the browser), or `robust` (100% next to an equal-loudness terminal) | Low |
| Feasibility / adoption | **Partly done** | QR fallback, read-aloud, vibration, signal meter built and browser-tested; UPI designed (docs/UPI.md), not built | **High** (UPI) |
| Real-device validation | **None** | Only Node sims and headless Chromium with synthetic audio | **Highest** |
| Code quality / tests | Good | 40 Node tests, 6 browser end-to-end runs passing | Low |

**Update (later the same day):** everything in "Status of the plan" below is now built except the UPI
integration. See the updated status table at the end. The single most important next step is still
**testing on real hardware**. Every number in this report comes from
simulated rooms. Real speakers, microphones and phones (iOS Safari especially) can change them a lot.

## What was built

- **Hop modem in the app:** POS and phone use 96 tones in 15–19.5 kHz with keyed hopping. Each 3-second
  broadcast uses a new pattern, and keys come from the server and change every 30 seconds.
- **Streaming receiver:** AudioWorklet → Web Worker, with a main-thread fallback and a ScriptProcessor fallback.
- **Two profiles:** `HOP_PROFILE=fast` (about 3.5 s to confirm) and `robust` (about 7 s, resists follower jammers).
- **Interference hardening:** a 12 kHz high-pass, time-domain impulse blanking, burst-slot erasures, a
  per-channel noise floor, and click-free slot edges.
- **Library pieces for adaptive hopping and calibration:** `monitor.js` finds noisy channels and computes
  speaker gains; frames accept a channel mask and per-channel gains. **These aren't connected to the app yet.**
- **Simulators:** `sim-attacks.js` (14 attacks, ggwave baseline), `sim-noise.js` (14 everyday conditions),
  `sim.js`, `sim-clock.js`.
- **Bugs found and fixed:** a key-cache bug (wrong secret got right keys), an excision weakness that let a
  sweep erase the whole band, and capped margins that erased strong slots.

## Measured results (simulation)

### Attacks: 100 trials per cell

| attack | ggwave | fast | robust |
|---|---|---|---|
| random jam 10% / 25% / 50% of channels | 0 / 0 / 0% | 99 / 92 / 48% | 99 / 75 / 1% |
| replayed jam, 24 channels | 0% | 97% | 58% |
| sweeps (3 kinds) | 0–94% | 100% | 99–100% |
| follower jammer, 22–80 ms reaction | 0% | 0–1% | 97–100% |

### Everyday interference: 10 trials per cell, a first look (±30 points)

| condition | before hardening | fast, hardened | robust |
|---|---|---|---|
| construction (4 and 10 impacts/s) | 100% | 100% | 100% |
| loud speech / music | 100% | 100% | 100% |
| machine whine 15–17.5 kHz, 4x the signal | 10% | 100% | 100% |
| ultrasonic pest repeller (aliased) | 100% | 100% | 100% |
| mic clipping from loud rumble | 90% | 100% | 100% |
| second terminal, same loudness | 20% | 20% | 100% |
| -30 dB with laptop roll-off | 20% | 10–20% | 30% |
| -36 dB, -42 dB | 0% | 0% | 0% |

### Browser end-to-end (headless Chromium, synthetic mic)

All passed: hop, hop with 25% jammed, robust under a 32 ms follower, ggwave, both, no-worker fallback,
no-worklet fallback. Fast under a follower fails, as predicted. Charge → confirm: fast 3.5–4.5 s, robust 7–10 s,
ggwave 1.8 s.

## Areas to improve, ranked

### 1. Validate on real devices (highest)
- **Why:** nothing has run through a real speaker or mic. Laptop speakers above 16 kHz and iOS Safari's
  audio pipeline are the big unknowns.
- **Do:** build the range-test page (`/rangetest.html`). The POS loops test frames; the phone logs success,
  SNR and erasures at each distance. Test 3 laptops × 5 phones × 0.25/0.5/1/2 m.
- **Effort:** 1 day to build, 1 day to test. **Impact:** turns every other estimate into a fact.

### 2. Range (high)
- **Problem:** at -30 dB with a 15 dB speaker roll-off, the upper channels are buried, and ±6 dB
  pre-emphasis can't compensate.
- **Fixes, in order of value:**
  1. **Use the part of the band the speaker can actually play.** Calibrate once at setup, then mask out channels
     more than 10–15 dB down (the mask support already exists). With the 15 dB tilt that keeps about 64 good channels.
  2. **More parity for range:** RS(48,16) (+1 s airtime) gave +40 points at heavy jamming in earlier sims; expect
     similar gains at low SNR. It could become a third `HOP_PROFILE=range`.
  3. **Wider pre-emphasis** (±10 dB) once real speakers show their headroom.
  4. **Hardware:** recommend a ₹300–500 external speaker at the till. Likely the cheapest real gain.
  5. **Signal meter on the pay page** ("move closer"), from the decoder's SNR, which `levels: true` already returns.
- **Keep range short on purpose:** 0.2–1.5 m is the right target for a counter payment. Long range invites
  relay and rogue-speaker attacks.

### 3. Feasibility and adoption (high)
- **UPI, not cards:** most Indian payments are UPI. Settle through a licensed aggregator (Razorpay or Cashfree
  UPI collect/intent). Only `server/payments.js` needs to change. Needs your aggregator account.
- **QR fallback on the POS screen** (dynamic, per-session) plus the typed code. This covers phones whose mic
  can't hear 15+ kHz. It's also an anti-fraud story: no printed QR to swap.
- **Passkey fallback** (OTP or UPI PIN) for phones older than Android 9 or iOS 16.
- **Accessibility:** read the amount aloud, vibrate when the terminal is heard, large touch targets.
- **Audibility:** slot-edge fades are done. Also cap the volume, and test with children and pets present.
- **Offline:** out of scope for now; a UPI Lite-style wallet is a regulatory project.

### 4. Multiple terminals (high if a shop has more than one till)
- **Problem:** two fast-profile terminals at similar loudness break each other (20%).
- **Fix:** time-division. The server assigns each terminal a slot (cycle g ≡ k mod N), and the phone already tries
  every cycle. Or use the robust profile, which tolerates it (100%).

### 5. Wire adaptive hopping and calibration into the app (medium)
- **Library is done:** `monitor.js`, `mask`, `gains`.
- **Missing:**
  - `POST /api/hop/channels` (phone reports noisy channels and tone levels), rate-limited, with the mask capped at
    32 channels and expiring after about 2 minutes.
  - Server mask/gain schedule per terminal, with an effective-from time.
  - POS and phone use the same mask per cycle.
- **Security note:** a malicious signed-in user could report bad masks. The cap and expiry limit the damage, and
  an admin calibration should override user reports.

### 6. Security limits to state honestly (medium)
- Every signed-in customer gets hop keys, so insiders can follow the hops. Hopping stops outsiders only.
- Any acoustic link loses to a loud enough wideband noise source.
- Pulsed jammers just under the excision threshold weren't modelled.
- The money stays protected regardless: passkey approval plus the single-use atomic claim.

### 7. Smaller items (low)
- The attack table was measured before the hardening round; re-run `sim-attacks.js` once.
- Re-run `sim-noise.js` at 100 trials (the table above is a 10-trial first look).
- The original ggwave unit test is flaky (unseeded noise, about 1 failure in 8 runs). Seed it.
- Long-running POS: the clock re-syncs only on key refresh. Fine for hours; add a periodic re-sync for days.

## Status of the plan from the last discussion

| Step | Status |
|---|---|
| 1. Decoder hardening (high-pass, impulse blanking, per-channel floor, click-free edges) | **Done**, in app and sims |
| 2. Adaptive channel avoidance (phone → `/api/hop/report` → schedule → POS + phones) | **Done**, browser-tested: with 25% jammed the POS dropped the jammed channels mid-sale |
| 2b. Several terminals (`TDMA_SLOT`) | **Done**, browser-tested in slot 1/2 |
| 3. Range: signal meter, range-test page, speaker calibration, `range` profile | **Done**, range-test page browser-tested through an emulated weak speaker |
| 4. Adoption: QR fallback, read-aloud, vibration | **Done**, QR browser-tested end to end |
| 4b. UPI | **Designed** (docs/UPI.md). Needs an aggregator account to build and test |
| 5. Demo: `npm run demo`, Jam Lab, presenter script, screenshots | **Done** |
| Validation on real phones and speakers | **Not done**. Use `/rangetest.html` |
| 100-trial re-run of the sims after this round | **Partial.** Earlier tables stand; re-run `npm run sim` |

## How to reproduce

```
npm install && npm test                      # 44 tests
npm run demo                                 # demo server + links
npm run test:browser                         # all real-browser runs
npm i -D playwright && npx playwright install chromium
node test/browser/e2e.mjs hop 0.25           # real browser, 25% of channels jammed
HOP_PROFILE=robust node test/browser/e2e.mjs hop follower32
node tools/hopsim/sim-attacks.js 100         # ~40 min
node tools/hopsim/sim-noise.js 100           # ~15 min
```
