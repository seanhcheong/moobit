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
| `jump.js` | A real jump. Also a button: fires at takeoff, with variable height taken from the actual jump. |
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

## Measured against your own body, never against a number

The hardest-won rule here, and the one that took a real player reporting "it's not picking up
push-ups" to learn properly.

Scale invariance was always the design goal, and every threshold was already a ratio against a
body-derived reference. That was not enough. A ratio can still be **absolute** in the sense that
matters: `pushDepth` at the top of a plank is a legitimate shoulder-widths measurement, and it
still depends on forearm length, hand placement, camera tilt and distance. A perfectly good plank
measures 0.63 where the default threshold wanted 0.83 — and a player like that sat in `IDLE`
forever, unable to register a single push-up. Not "detected badly". Undetectable.

So the rep's reference points are now **tracked from the player**, not read from config:

- The top of a push-up is a resting height that follows the shoulders fast upward and slow
  downward. The asymmetry is the point: fast finds the plank within a few frames wherever it sits,
  slow means a descent cannot drag the reference down with it and swallow the rep it is measuring.
- The rep triggers on a *relative* drop from that, and closes on a return to it.
- Depth is proven by **either** reaching the calibrated bottom **or** travelling `dropMin` from
  your own top. One absolute and one relative, so a low plank clears the second and a high plank
  clears the first.
- Leaving the bottom is a fraction of *this rep's* travel, not a fixed threshold. `down*1.08` was
  the same bug wearing a different hat: a player whose bottom sits below the calibrated value could
  never rise above it, so the machine stuck in `DOWN` for the rest of the set.

The general form: **a threshold read from config may gate what COUNTS, but must never gate what
the machine can SEE.** Anything on the path to noticing that a movement is happening has to be
derived from the body in front of the camera.

The burpee had two of these. Its chain could only start from a knee angle of 160 degrees, and
BlazePose runs ~15 degrees pessimistic on knee extension, so a real relaxed stance reads 150-155
and the chain never started. And its finishing hop required wrists overhead *or* a **calibrated**
ankle rise — so an uncalibrated player who keeps their hands low could perform the whole movement,
correctly, forever, and never be credited. The hop now also reads `body.jumpRise`, which the jump
detector maintains against its own self-seeded baseline and needs no calibration at all.

`lenient.mjs` (23 assertions) exists for exactly this class of bug, and it runs **uncalibrated on
purpose** — calibration hides every one of them, which is precisely why they survived so long. The
suites that found nothing were all calibrated first.

## Settling is a stability test, not a timer

A burpee's floor phase contains a genuine push-up, so with the wall asking for push-ups and the
player doing burpees, something has to separate one exercise from the other. That used to be a
400ms settle timer, and raising the prone threshold quietly broke it by giving the timer a head
start — a burpee counted as six push-ups again.

Measured on synthetic bodies: across an entire push-up the torso's angular rate never exceeds
**8 deg/s**. A burpee rotating into prone hits **309, 265, 216, 172** on four consecutive frames.
A gate at 45 separates them by 5x in both directions, and it is a property of the *movement* —
a body passing through prone is rotating, a plank is not.

## What the tests prove, and what they don't

`posetest.mjs` (52 assertions), `negtest.mjs` (42), `jumptest.mjs` (15) and `lenient.mjs` (23) run
synthetic bodies built from anatomy — limb lengths and joint angles — projected through a real
pinhole camera at various heights, tilts and distances. The detector has to recover reps from
actual perspective.

One trap worth naming: `camera()` takes `camH` / `tiltDeg` / `vfov`. Pass `height` / `tilt` /
`fovY` and you silently get the default camera every time, and a cross-camera test proves nothing
at all. That happened here.

That proves the **logic**: the machines count what they should, refuse what they should, hold
across body sizes and distances, and never fire on someone standing still.

It does **not** prove accuracy against real human movement. Only recordings of real bodies can
do that, and they need a phone. Expect the thresholds in `config.js` to move once real data
exists — which is what the calibration layer and the landmark recorder are for.

## The penguin moves with you, not after you

A state machine cannot report a rep until it has evidence, and gathering evidence takes a few
hundred milliseconds — on top of the vision pipeline's own 150-350ms. That is correct for scoring
and wrong for the character: it meant the first third of every movement produced nothing on screen,
which reads as the game ignoring you.

So each machine also exports a `livePhase(m, body, cal)` — a **stateless** read of the shape the
body is in right now. No history, no commitment. The detector emits it only on frames where the
machine is *not* already reporting a phase, so the machine stays authoritative and the two can
never fight over the penguin. It drives the pose and nothing else: no rep, no wall damage, and
deliberately no touch on the belt's idea of rep progress.

The weight arrives with the phase, so the blend is proportional to how far into the movement the
body is — a standing player keeps running, a half-squatting player is half in the squat. Snapping
the pose fully on at the first flicker of movement would have been worse than the lag it removed.

Measured, as milliseconds into the movement before anything drives the character at all:

| exercise | live mirror | state machine | penguin moves sooner by |
|---|---|---|---|
| squat | 280ms | 360ms | **80ms** |
| push-up | 0ms | 280ms | **280ms** |
| jumping jack | 200ms | 240ms | **40ms** |
| burpee | 160ms | 240ms | **80ms** |

The push-up gains most, and it is the one the player complained about: its weight comes from torso
angle rather than depth, so a prone body is already committed on the first frame. On top of that,
`driveSmooth` went from 17 to 26 (settling time 175ms → 115ms) and the capture pump no longer
idles out the rest of the display frame after each inference — so roughly 100–350ms total came off
the gap between moving and seeing the penguin move.

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
