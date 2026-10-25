# Demo script (about 7 minutes)

Setup once: `npm install`, then `npm run demo`. It prints four links. Have them open in this order, with the
sound on (the payment itself is near-silent; the jammers in the lab are not).

| Window | Link |
|---|---|
| A. Jam Lab | `/lab/` (also works offline: `npm run build:lab` writes `dist/jam-lab.html`) |
| B. Shop terminal | `/pos.html`, POS key `demo` |
| C. Customer phone | `/pay.html` on a phone (https tunnel, see below) or a second laptop window |

One laptop is enough: B and C in two windows side by side. For the passkey, use the laptop's fingerprint /
Windows Hello, or Chrome DevTools → More tools → WebAuthn → "Enable virtual authenticator" in window C.
With a real phone: `cloudflared tunnel --url http://localhost:3000`, then
`ORIGIN=https://<printed-url> npm run demo`, and open that URL on the laptop **and** the phone.

## 1. The problem (1 min), Jam Lab

1. Room **Quiet room**, method **ggwave**, *Run 1 payment*: "Paid". This is how SoundPay worked before.
2. Room **Jammer: random channels**, 25%. *Compare all methods*.
   **Say:** "A cheap speaker playing a few tones kills ggwave: 0%. Our modem gets through."
   The spectrogram shows the jammer's steady lines and the payment's short hops between them.
3. Room **Jammer: replays the last broadcast**. *Compare all methods*.
   **Say:** "This attacker recorded the previous broadcast and jams exactly those tones. Fixed channels: 0%.
   Hopping: about 97%, because every broadcast uses a new pattern derived from a key."

## 2. The honest part (1 min)

4. Room **Jammer: follower**, 32 ms. *Compare all methods*.
   **Say:** "A follower listens and answers each tone with a decoy. Only the robust profile survives, which costs
   about 2 seconds more per broadcast. It's a setting: `HOP_PROFILE=robust`."
5. Room **Distance**, -33 dB. Untick and tick *Adaptive hopping and speaker calibration* and compare.
   **Say:** "The phone tells the terminal which channels are noisy and which its speaker plays weakly. The terminal
   boosts and avoids them."

## 3. A real payment (3 min), windows B and C

6. B: type `450`, **Charge**. Point at the match code and the QR code.
7. C: **Pay**. The meter says "Listening…", then the confirm screen shows Demo Café, ₹450 and the same match code.
   **Say:** "Nothing has been charged yet. The phone only heard a one-time code."
8. C: tap **Read this aloud** (accessibility), then **Approve** → passkey → "Paid". B shows "Paid" with the
   customer's name.
9. Optional: **Charge** again and scan the QR code with the phone's camera instead of listening. Same flow, no
   sound needed, for phones whose microphone can't hear the band.

## 4. Why it's safe (1 min)

**Say:**
- The money is protected by the passkey and the one-time claim. Hearing the code is not enough to pay.
- The 2-digit match code stops a relay from another shop.
- Hopping protects *availability*: a jammer can't stop people from paying.
- **What it doesn't protect against:** anyone with an account can get the keys. And a loud enough noise source
  beats any sound link. Both are in docs/REPORT.md.

## 5. If asked: range and real devices

- `/rangetest.html` on the terminal and a phone (both sign in with the POS key). Record success and SNR at each
  distance, and calibrate the speaker with the phone held close. Numbers so far are from simulation and headless
  Chrome. Real-device runs are the next step.

## Backup plan

- No sound getting through: `AUDIO_MODE=both npm run demo` (old phones), or use the QR code / typed code.
- No passkey: DevTools virtual authenticator (above).
- No network: the Jam Lab file (`dist/jam-lab.html`) runs from disk, with no server.
