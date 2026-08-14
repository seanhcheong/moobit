# Testing the camera control

**Camera control is in the game now.** Turn it on in Settings and it walks you through
calibration before the run — framing check, a still A-pose, then one rep of each exercise. Those
become *your* thresholds. The keyboard keeps working the whole time; the toggle is live.

The fastest useful test does **not** need Xcode, Android Studio, or a phone. Start on your
laptop, because the question that matters first — *does the detection register a real body?* —
is answerable in about two minutes there, and a laptop's `localhost` is a secure context so the
camera just works with no certificates.

---

## 1. One-time setup

```bash
./scripts/fetch-pose-assets.sh
```

Pulls the MediaPipe runtime and the pose model into `pose/vendor/` — about 18 MB. They are
fetched at build time and served from your own origin at run time, never from a CDN while the
app is running. They are not committed to the repo.

## 2. Serve it and open the game

```bash
python3 -m http.server 8000
```

Open **http://localhost:8000/index.html**, hit the gear, and turn on **Camera control**.

First launch moves ~18MB off disk, so the card sits on `WARMING UP` for a few seconds. Then it
runs calibration. Press `F3` (or triple-tap the top-left) for the debug overlay — it now carries
the pose pipeline too: which inference mode came up, inference time, machine state, every angle,
and your fitted thresholds.

There is also **http://localhost:8000/posecheck.html** — the same detection layer with no game
attached. It is a dev tool for tuning thresholds, not something you need. Use it if a specific
exercise misbehaves and you want it isolated from everything else.

`http://localhost` counts as a secure context, which is what `getUserMedia` requires. `file://`
does not, and neither does reaching your laptop from your phone by IP over plain http — see
step 4 for that.

## 3. What to look at

**First, which inference mode came up** — the debug overlay's `pose` line, or the tag under the
camera preview in the corner:

| | |
|---|---|
| `worker / GPU` | best case — inference off the render thread, on the GPU |
| `worker / CPU` | the GPU delegate could not be created in a worker; still never blocks rendering |
| `main (fell back) / …` | no worker at all; same pipeline on the main thread |

Which of these you get is the single biggest unknown in the whole project, and it is why the
card says it out loud rather than degrading quietly. **Please tell me what it says on your
phone** — the fallback ladder exists precisely because I could not find out from here.

**Then do the calibration it asks for.** Framing with your arms overhead, hold still, then one
rep of each exercise. Any single exercise can be skipped without trapping you. Watch the `cal`
line in the debug overlay fill in — those numbers replacing my defaults is calibration working.

**Then play.** A wall arrives asking for an exercise; do it and the wall crumbles *as you move*,
because the penguin is posed from your measured phase rather than playing an animation. Lunge
sideways to change lane. When a rep is refused the screen says why — `GO LOWER`,
`HOLD IT AT THE BOTTOM`, `KEEP YOUR CHEST UP`, `TOO FAST`.

The corner preview shows the skeleton: green is confident, amber is shaky, red is a guess. If
tracking is lost the whole world freezes rather than failing you.

## 4. Then on the phone, on the floor

The laptop test validates detection. It cannot validate the setup you actually intend: phone on
the floor angled up, you 2.5 m away. For that the page has to reach your phone over a secure
context. Easiest options, in order of hassle:

1. **Android: USB port forwarding.** The least hassle by a wide margin, and no third party sees
   your traffic. Enable USB debugging on the phone, plug it in, open `chrome://inspect` on the
   laptop, and under **Port forwarding** map device port `8000` to `localhost:8000`. Then open
   **http://localhost:8000/index.html** *on the phone* — Chrome treats a forwarded localhost as a
   genuine secure context, so the camera works with no tunnel and no certificate.
2. **A tunnel** — `cloudflared tunnel --url http://localhost:8000` or ngrok. Gives you an https
   URL you can open on the phone. Nothing to install on the phone, and the only easy option on
   iOS, which has no equivalent of the flag or the port forward.
3. **https with a self-signed certificate** on your laptop, then accept the warning on the phone.
   Be aware that a cert the phone does not trust can still leave the origin non-secure, so this
   one fails in a way that looks like the app is broken rather than the certificate.
4. **The Capacitor app** — the real target, and the only one that gets you the native camera
   permission flow. See the device-build section in `README.md`.

**Which browser.** On Android, Chrome: it is real Chromium with WASM SIMD, and MediaPipe is a
Google library tested against it first. On iOS, Safari — every iOS browser is WebKit underneath, so
Chrome there is Safari with an extra permission layer and no upside.

Things I expect to bite on the phone, so worth watching for:

- **At 5 feet you may be too close.** From a floor camera a 1.8 m person needs roughly 2.5 m for
  their arms overhead to stay in frame. The framing check will say `STEP BACK`; believe it.
- **Push-ups are the least certain of the five.** From in front and low, elbow flexion runs along
  the depth axis, so the detector reads shoulder height above your planted hands instead. It
  passes on synthetic bodies. Real ones are the test.
- **The screen is on the floor pointing at your knees.** You will not be able to read the small
  cards while standing. That is expected and it is why the game gets audio cues — for now, note
  what you *could* read from where you stood.

## 5. If you want to help me tune

This is the one thing I genuinely cannot do without you. Every threshold in `pose/config.js` is a
plausible shape verified against synthetic bodies — good enough to prove the machines behave, not
proof that any number matches a real person.

**In the game.** Settings → **Record movement**, close the panel, do the thing that misbehaves, then
tap the red **RECORDING** chip in the top right. A `belt-trace-….json` lands in your downloads. On a
laptop, **F2** starts and stops it without opening Settings, which matters when both hands are busy
being a body.

It records the **landmark stream only** — 33 coordinate triples per frame plus visibility, the
metric frame, and what the detector concluded about each one. No pixels are captured, stored or
transmitted by any page here. That is not a concession: the detector never sees pixels either, so
the numbers are its *complete* input, and video would record something no threshold depends on.

Two things worth knowing. It keeps the **last 90 seconds**, so noticing a glitch and then reaching
for the chip still captures what caused it — you do not have to predict it. And it will not record
during calibration, because the calibrator rewrites your body fit on every frame and a trace carries
only one.

`posecheck.html`'s **Record** / **Save JSON** buttons write the same format, for tuning one exercise
in isolation.

**What I do with it.** Replay it offline through the same detector the camera drives:

```bash
node scripts/replay-trace.mjs belt-trace-….json
```

That reports your camera's actual noise floor, how many commands a *motionless* body produced, where
every threshold sits against the range your body actually covered, and — first, before anything else
— whether the replay reproduces your live session at all. If it does not, the tool is lying and
nothing below it counts. `--set smooth.fcMin=2.4` re-runs the whole thing under different constants,
so a candidate fix gets judged against a movement you really performed rather than one I invented.

Traces are gitignored. It is your movement data; send it or don't.

---

## What is still missing

- **The native wrapper.** iOS needs the `WKUIDelegate` permission method or you get prompted on
  every single launch; Android needs `onPermissionRequest` overridden. Until then the camera
  works in a browser but not in a wrapped app.
- **Audio cues.** With the phone on the floor you cannot read the small text while standing, so
  rejections and wall callouts need to be spoken or toned. Currently they are visual only.
- **Real thresholds.** See section 5. Everything in `pose/config.js` is verified against
  synthetic bodies, which proves the machines behave, not that the numbers match a person.
- **Push-up certainty.** It passes on synthetic bodies from a floor-front camera using shoulder
  height above the hands. I trust it least of the five.
