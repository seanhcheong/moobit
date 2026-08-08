# Testing the camera control

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

## 2. Serve it and open the diagnostic page

```bash
python3 -m http.server 8000
```

Then open **http://localhost:8000/posecheck.html** and press **Start camera**.

`http://localhost` counts as a secure context, which is what `getUserMedia` requires. `file://`
does not, and neither does reaching your laptop from your phone by IP over plain http — see
step 4 for that.

## 3. What to look at

This page is the detection layer with no game attached, on purpose: if a squat does not
register, wiring it into the game teaches you nothing.

**First, the top-left `Pipeline` card.** It reports which inference mode actually came up:

| | |
|---|---|
| `worker / GPU` | best case — inference off the render thread, on the GPU |
| `worker / CPU` | the GPU delegate could not be created in a worker; still never blocks rendering |
| `main (fell back) / …` | no worker at all; same pipeline on the main thread |

Which of these you get is the single biggest unknown in the whole project, and it is why the
card says it out loud rather than degrading quietly. **Please tell me what it says on your
phone** — the fallback ladder exists precisely because I could not find out from here.

**Then stand up and move.** Pick an exercise from the bar and do a few reps. Watch:

- the **big number** top-right — accepted reps
- the **skeleton** — green is confident, amber is shaky, red is a guess
- the **`Body` card** — every angle and ratio the machines reason about, live
- the **`Machine` card** — which state the machine is in, and the phase 0→0.5→1
- the **middle of the screen** — when a rep is refused it says *why*: `GO LOWER`,
  `HOLD IT AT THE BOTTOM`, `KEEP YOUR CHEST UP`, `TOO FAST`

**Then press Calibrate** and follow the prompt at the bottom. It runs the real onboarding:
framing check with your arms up, a still A-pose, then one rep of each exercise. Watch the
`Calibration` card fill in — those are *your* thresholds replacing my defaults. Comparing
`squat knee` before and after is the clearest signal that calibration is doing its job.

## 4. Then on the phone, on the floor

The laptop test validates detection. It cannot validate the setup you actually intend: phone on
the floor angled up, you 2.5 m away. For that the page has to reach your phone over a secure
context. Easiest options, in order of hassle:

1. **A tunnel** — `cloudflared tunnel --url http://localhost:8000` or ngrok. Gives you an https
   URL you can open on the phone. Nothing to install on the phone.
2. **https with a self-signed certificate** on your laptop, then accept the warning on the phone.
3. **The Capacitor app** — the real target, and the only one that gets you the native camera
   permission flow. See the device-build section in `README.md`.

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

Press **Record**, do 10–20 reps, press it again, then **Save JSON**.

That writes the **landmark stream only** — 33 coordinate triples per frame plus timestamps. No
pixels are captured, stored or transmitted, by this page or by the app. Send me that file and I
can replay it through the state machines here, at real speed, headless, and tune thresholds
against your actual movement instead of my model of a body.

That is the one thing I genuinely cannot do without you. Every threshold in `pose/config.js` is
currently a plausible shape verified against synthetic bodies — good enough to behave correctly,
not yet proven to match a real person.

---

## What is not built yet

The camera does not control the penguin. The pose layer emits the four events the game speaks,
and the game consumes those four events, but they are not connected — that is the next step.
`posecheck.html` proves the left-hand side works; the keyboard build proves the right-hand side
works. Wiring them is small once the detection is trusted, and doing it in that order is
deliberate: an integration built on unverified detection would be debugging two things at once.
