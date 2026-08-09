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
