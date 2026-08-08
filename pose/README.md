# The pose layer

Five exercise state machines, a calibration flow, and the normalization that makes them work
for a body other than mine. Nothing in here imports three.js, touches the DOM, or knows the
game exists — it takes landmark frames and emits the four events the game already speaks:

```
laneChange(dir)  repProgress(kind, phase)  repCompleted(kind, form)  trackingState(state)
```

That independence is deliberate: it is what lets the whole detection layer be tested in plain
Node, with no camera, no browser and no GPU, and it is what will let it run inside a Worker
without dragging the renderer along.

## Files

| | |
|---|---|
| `config.js` | Every threshold in the layer, in one object. Plus the calibration fitter. |
| `landmarks.js` | The only file that knows what MediaPipe's output looks like. Mirroring and the vertical flip happen here, once. |
| `body.js` | Landmarks → the handful of scale-free numbers the machines reason about. |
| `squat.js` `jack.js` `pushup.js` `burpee.js` | One rep machine each. |
| `lunge.js` | The lane-change control. Not a rep counter — a button, held to a button's latency budget. |
| `calibrate.js` | Framing check, A-pose measurement, one rep per exercise, personal thresholds. |
| `detector.js` | Owns the five, routes to whichever exercise the wall is asking for, emits events. |

## The rules this layer is built on

**No absolute thresholds.** Every spatial number is a ratio against a body-derived reference —
shoulder width, torso length, leg length — or an angle in degrees. A 1.5m person standing close
and a 2m person standing far produce the same numbers. Verified: 4 reps counted identically
across 1.52m/2.0m bodies at 2.2m/3.2m, from a floor camera and a chest-height one.

**Thresholds are personal, not textbook.** Calibration records each person's own observed range
and sets their threshold at 65% of it. Textbook joint angles are wrong twice over — wrong for a
body and wrong for the estimator, which carries systematic offsets around 15° on peak knee
angle. Verified: a shallow squatter gets a 124° threshold where a deep one gets 104°.

**Four properties in every machine.** A valid entry state, a transition condition, a minimum
phase duration, and a required return to entry. The fourth is the one that matters: without it
people farm reps by vibrating.

**A rep is never counted on guessed landmarks, and a dropout never fails the player.** The
visibility gate is computed over the landmarks the *active* exercise needs, never all 33 — a
push-up legitimately loses the ankles. Below the gate the machines freeze and the caller pauses
the world.

**False positives are far worse than false negatives.** One phantom rep destroys trust in the
whole system permanently, so `negtest.mjs` exists purely to try to produce them: every exercise
against every other exercise, plus standing still, weight-shifting, reaching up, shallow knee
bends and bouncing on the spot. Currently 0 false reps in 92 opportunities.

## What the tests prove, and what they don't

`posetest.mjs` (52 assertions) and `negtest.mjs` (42) run synthetic bodies built from anatomy —
limb lengths and joint angles — projected through a real pinhole camera at various heights,
tilts and distances. The detector has to recover reps from actual perspective.

That proves the **logic**: the machines count what they should, refuse what they should, hold
across body sizes and distances, and never fire on someone standing still.

It does **not** prove accuracy against real human movement. Only recordings of real bodies can
do that, and they need a phone. Expect the thresholds in `config.js` to move once real data
exists — which is what the calibration layer and the landmark recorder are for.

## Three things the synthetic bodies caught

Worth recording, because none of them would have been visible from reading the code:

1. **A jumping jack registered as six push-ups.** `isProne` had a fallback on shoulder-above-hands
   depth for when the torso angle is unrecoverable. Arms overhead drive that measure negative, so
   a jack read as prone and its arm swing crossed both depth thresholds. That measure works
   *within* a prone rep and cannot tell prone from standing; asking it to was the bug.

2. **A burpee registered as six squats.** A burpee contains a real squat, and the squat machine's
   torso gate was only sampled on the descent — so the kick-back straightened the knees and
   satisfied the completion test while the torso was already halfway to horizontal.

3. **The kick-back of a burpee read as giving up on it.** The burpee machine treated straight
   knees as "stood back up". But kicking your legs back straightens them while the torso is
   still pitching forward. Standing up is the only case where the legs straighten *and* the
   torso is upright, so the gate needed both.
