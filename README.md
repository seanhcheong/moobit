# BELT RUNNER

A chunky penguin runs on a giant treadmill. The belt drags the world backward under its feet.
Fall behind and the rear lip throws you off. Push too far forward and the front roller
bounces you back. The belt speeds up. You survive as long as you can.

The belt has **three lanes**. You lunge left and right to change lane, collect coins along
the track, and when a brick wall rolls up with an exercise printed on it you do that
exercise — squats, push-ups, jumping jacks, burpees — to bring it down course by course
before it reaches you.

One self-contained `index.html`. No build step, no external assets. Every mesh is generated
in code, every texture is painted to a `<canvas>` at boot. Desktop keyboard and mobile
touch live in the same build simultaneously — there is no mode switch and no second code path.

---

## Camera control (in progress)

The pose layer lives in [`pose/`](pose/) — five exercise state machines, the normalization that
makes them work for a body other than mine, and the onboarding calibration. It emits the same
four events the keyboard does, so the game cannot tell them apart.

Turn on **Camera control** in Settings and it runs calibration before the run — framing check,
A-pose, then one rep of each exercise, fitted to your body. The keyboard keeps working
throughout; the toggle is live.

```bash
./scripts/fetch-pose-assets.sh      # once: MediaPipe runtime + pose model, ~18MB
python3 -m http.server 8000
# open http://localhost:8000/index.html   (localhost is required — the camera needs a
#                                          secure context, and file:// is not one)
```

The pose modules are **lazy-loaded**, so `index.html` still opens straight off disk and still
runs in a sandbox with no camera — nothing is imported until you turn the camera on, and a
failure to load leaves the keyboard game completely untouched.

### "Importing a module script failed"

That is Safari's wording (Chromium says "Failed to fetch dynamically imported module") and it
almost always means one thing: **`pose/vendor/` is missing, so the MediaPipe bundle 404s.** That
directory is ~18MB of binary fetched at build time and deliberately not committed, so a fresh
clone does not have it and `./scripts/fetch-pose-assets.sh` is a required step rather than an
optional one. A working install has exactly four entries:

```
pose/vendor/pose_landmarker_lite.task    5.8M
pose/vendor/vision_bundle.mjs            155K
pose/vendor/vision_bundle_worker.js      155K
pose/vendor/wasm/                        ~12M
```

Turning the camera on now **preflights those URLs before asking for camera permission** and names
the problem instead of leaking the module loader's error — a real user hit this on a phone, where
there is no console to check and no way to guess that a download step had been skipped. Two
messages, for the two things that actually go wrong:

- `POSE ASSETS NOT INSTALLED` — run the fetch script. It needs `npm` and `curl`; a half-finished
  download looks identical to no download.
- `SERVER IS SENDING THE WRONG FILE TYPE` — the files are there but your static server is handing
  back a non-JavaScript content-type for `.mjs`, which a module import refuses. Some older
  `python3 -m http.server` builds do not know the `.mjs` extension.

Permission order matters here and is deliberate: prompting for the camera and *then* failing on a
missing download is the worst possible sequence, because the player grants a permission, sees an
error, and reasonably concludes the two are related.

[`TESTING.md`](TESTING.md) walks through what to look at and how to get it onto a phone.
[`posecheck.html`](posecheck.html) is the same detection layer with no game attached — a dev tool
for tuning a misbehaving exercise in isolation, not something you need.

## Run it

**Double-click `index.html`.** That's it. The only thing it fetches is three.js r160 from a
CDN via the import map, on first load.

For a completely offline copy (and for app bundles), put `three.module.js` from three r160+
next to `index.html` and change the one import-map line near the top:

```html
<script type="importmap">
{ "imports": { "three": "./three.module.js" } }
</script>
```

A relative module import needs an http origin, so when serving locally use any static
server rather than `file://`:

```bash
npx serve .          # or: python3 -m http.server 8080
```

## Controls

Lane mode is the default. It changes what the movement keys are for: the run throttle holds
station by itself, and your input is lunges and exercises.

| | Desktop | Touch |
|---|---|---|
| Lunge left / right | `A` `D` or `←` `→` | the **← →** buttons |
| Squat | `S` | **SQUAT** |
| Push-up | `X` | **PUSH** |
| Jumping jack | `W` | **JACK** |
| Burpee | `C` | **BURPEE** |
| Jump | `Space` (hold for height) | tap the right half (fires on press, not on release) |
| Dive | `Shift` or left mouse button | swipe the right half in any direction |
| Restart | `R` | tap anywhere on the death screen |
| Settings | `Esc` or the gear | the gear (top-right, out of both thumb zones) |
| Workout mode | `E`, then `1`–`4` | the **GYM** button, then the exercise buttons |
| Debug overlay | `F3` | triple-tap the top-left corner |

Turning **3-lane fitness run** off in settings restores free analog running: `W A S D` steer
anywhere across the belt, and the six obstacle types come at you without walls or coins. Both
modes are the same build and the same physics; the toggle is live mid-run.

A gamepad works too if one is connected: left stick to move, A to jump, B to dive.

**Auto-run** (in settings) holds the forward throttle for you and reduces the left pad to
lateral steering, which makes one-handed play viable.

## The fitness run

Three lanes, spaced as a fraction of the playable belt width so a lane change costs the same
0.24s in portrait as it does in ultrawide (measured: 29 frames in all four aspect ratios).
A lunge is refused at the outside lanes rather than silently swallowed, and it plays the lunge
pose while the body slides — the yaw is capped at 22° so the penguin sidesteps instead of
pivoting, and the lean carries the read at 15–18° of roll.

**Coins** arrive in runs of four to eight in a single lane, sometimes arcing so you have to
jump for them. An unbroken run pays more per coin, up to a ×12 chain — committing to a lane
is worth something.

**Walls** carry one of the four exercise names on a lit sign and stand 2.55 units tall in
courses of brickwork — one course per required rep, two to four depending on the belt tier.
The right exercise takes the top course off; the wrong one costs you nothing but the time.
The wall's remaining height *is* its collider, so grinding a four-course wall down to a stub
and hopping the last course is a legitimate way through, worth a smaller bonus than shattering
it. The HUD says `OR JUMP IT` when the stub is low enough, so the option is never a secret.

The spawner will not put a wall on the belt unless the reps are physically possible in the
time it takes to arrive — sized for a *body*'s rep duration (`repDurBody`, 2.2s) with 15%
slack, against the closing rate a working player actually faces. That rate is the exact one:
the gap closes at belt speed minus the player's net world velocity, which in lane mode is just
the belt, because station-keeping cancels the run. The old free-mode estimate added the
player's forward speed on top and came out 60% too pessimistic here, quietly refusing almost
every wall. Obstacles and walls never share the corridor:
obstacles stop spawning 14 belt-units before a wall is due, and a wall waits for the corridor
to drain before it spawns. Solid lane blockers can never seal all three lanes inside a
16-unit window, which is comfortably more than one lane change.

## Two modes: the arcade run and the workout

Same machinery, one difference — **what the belt is counting toward.** Endless counts toward
nothing and ends when something knocks you down. The workout counts toward a fixed number of work
intervals and ends when you finish it.

That distinction is not cosmetic. Every session in endless mode ends in failure, which is right for
a score chase and useless for something you open daily: you never once close the app having
succeeded. `Game.finish()` exists alongside `Game.over()` for exactly that reason, with its own card
and its own sound.

### Why the workout had to be re-paced

Computed from the shipped tuning before writing any of it: the tier ladder is 4,100 belt units,
which is 11.4 minutes of running, and at `wallEvery` of 74–112 units that is **51 walls and 168
reps in one run**. A hundred and sixty-eight burpees and squats is not a session. Those numbers were
set when a keypress committed a rep in 0.42s; a real rep takes over two seconds.

So the workout is a bounded HIIT protocol instead. Measured, with a body doing its reps:

| level | rounds | work | rest | ratio | reps | length | knocked down |
|---|---|---|---|---|---|---|---|
| easy | 8 | 16.0s | 30.7s | 1:1.9 | 42 | 6.7 min | 0 |
| medium | 10 | 19.3s | 25.1s | 1:1.3 | 70 | 7.9 min | 0 |
| hard | 12 | 21.2s | 22.6s | 1:1.1 | 96 | 9.3 min | 0 |

A **level is a work:rest ratio**, not a difficulty slider on the game. It changes how long you get
to breathe and how many rounds you do — nothing else.

### Reps are derived, so every round is equal work

A burpee costs about three squats, so a fixed rep count would make "4 reps" mean three different
workouts depending on which exercise the wall drew. Instead `need` comes from the work interval
divided by what a rep of *that* exercise costs, then bounded by what the runway can guarantee. One
20-second interval is 9 squats, 8 push-ups, 16 jacks or 6 burpees.

**And the cost is learned.** `HI.repSec` is only a seed. Measured: a body at 3.8s per rep — slower
than average, which is most people by the end of a set — was knocked down by **8 of 10 walls**,
because every wall was sized for someone faster. The session now measures the gap between
consecutive reps of the same kind, blends it in, and persists it to `br.pace`. Second session for
the same body: walls resize from 7 reps to 4, and **knockdowns go from 2 to 0**.

### The drama belongs to endless alone

Belt surges and stutters are what make the arcade run feel dangerous, and they are exactly what a
daily workout must not do — nobody wants the floor to lurch while they are at the bottom of a
push-up. A calm session skips the scheduling entirely rather than damping the effect, so no surge
can be halfway through when a session starts. The spawn klaxon becomes a chime: a workout announces
the next exercise, it does not alarm you.

**The running is still fast.** The recovery segment between walls is 20–30s of free belt, and that
is the cardio half of the workout, not a rest screen — measured at **6.3 u/s of a 7.6 maximum with
6.3 obstacles on screen at a time, peaking at 11.** Dodging, lane changes and coin chains all live
there. The `tierCap` per level turns out to be mostly non-binding: a 9-minute session covers ~3,400
units and the top tiers start at 3,050 and 4,100, so the belt ramps exactly as it does in the arcade
run and the session simply ends before the ramp becomes punishing.

`hiit.mjs` (40 assertions) covers all of it, including that endless keeps every bit of its drama.

### The high bar: what a camera cannot answer

Asked "how do you crouch under the tall bar?" and the answer turned out to be that with a camera you
**cannot**. Worth recording, because it is a whole class of bug.

The geometry: the high bar's collider is y 1.12-1.72 and spans the full belt. A standing player's
collider is 0.04-1.62 — overlap, so it hits. Prone is 0.04-0.72 — clears. The only thing that makes
the penguin prone is `startDive()`, reached solely through `In.diveEdge`, which is set by Shift, the
mouse, a touch swipe and a gamepad button — and by **nothing in the Signal contract.**

Demonstrated rather than assumed. Every camera-available input against one high bar:

| attempt | result |
|---|---|
| stand there | knocked down |
| `Signal.laneChange` | knocked down |
| `Signal.jump` | knocked down |
| a completed rep | knocked down |
| the live pose mirror | knocked down |
| keyboard dive | **passed** |

And the high bar sits in the **tier-0** pattern set, so it is among the first things a camera player
meets. So the spawner now refuses to place an obstacle the active input cannot answer
(`Signal.canDive`), and retires one already in flight if the camera comes on mid-run — the toggle is
live, so filtering at spawn time alone leaves a hole exactly one obstacle wide. Measured over a
4-minute soak at every tier: keyboard 7,614 frames of high bar, camera **0**, while the camera player
still meets 50,335 obstacle-frames of everything else.

The classifier is derived from geometry, not a list of type names — `full && hit.y0 >= dive.colliderH`
— so a new obstacle is classified correctly the day it is added. Today only `OT.HIGH` qualifies.

**Why there is no duck detector yet.** A duck is a fast hip drop, so the obvious signal is hip
velocity. Measured on synthetic bodies, peak downward hip rate in torso-lengths per second:

| movement | rate |
|---|---|
| duck, 350-450ms | 1.28 - 1.64 |
| squat rep, normal | 0.71 - 1.01 |
| **squat rep, fast 900ms** | **1.52** |
| burpee | 6.45 - 7.20 |
| jump pre-crouch | 5.36 |

A fast squat rep lands inside the duck band, and a burpee or a jump's pre-crouch would fire it
constantly. Rate alone is not enough. The workable design is **context**: only listen for a duck when
a bar requiring one is actually in reach, which dissolves the ambiguity because a fast hip drop with
nothing to duck under is just a squat. Flipping `Signal.duck` re-enables the obstacle with no
spawner change.

`divefair.mjs` (9 assertions) holds the guarantee.

## The input contract

Everything the player does reaches the game through four semantic events, and nothing below
that line knows what produced them:

```
laneChange(direction)        -1 | +1
jump() / jumpHold(bool)      a real jump, fired at takeoff
repProgress(kind, phase)     0..1, continuously, while a rep is happening
repCompleted(kind, form)     form 0..1
trackingState(state)         'good' | 'degraded' | 'lost'
```

**Jumping is a jump.** Leave the floor and the penguin leaves the belt — which matters, because
coins arc so you have to jump for them and a ground-down wall stub can be hopped. It fires at
takeoff, not at the apex, because waiting for the top of the jump would add 200–300ms to an input
that already costs the pipeline 150–350ms. Variable height comes from the *real* height: the hold
engages at takeoff and drops early if the jump turns out small, so a bigger jump gives a bigger
game jump with no added latency. Measured: a big jump never drops the hold mid-air, a small hop
drops it 12 times.

It also keeps its own standing baseline rather than depending on calibration, so it works from the
first second and survives you moving to a different spot. And it stands down while a jumping jack
or a burpee is mid-rep — both of those contain a hop, and the penguin should not leap in the
middle of a rep it is already performing.

Keyboard, on-screen buttons and a camera watching a body are interchangeable backends. The
keyboard one is not a shortcut around the contract: a keypress starts a phase ramp that emits
`repProgress` every fixed step and `repCompleted` at the end. So testing with keys exercises
exactly the plumbing a body uses, which is the only reason it stays useful once a camera
exists. `Moves.trigger()` resolves a rep instantly and exists for tests and the debug
overlay, where waiting 0.42s per rep would turn every assertion into a timing test.

**Reps are continuous, not discrete.** A wall crumbles while you are moving, not when you
finish — the top course shrinks as the phase advances, and the course's height *is* the
collider, verified equal to the visible brickwork at every phase to within 0.0000 units.
Abandon a rep half way and the damage heals back at 2.6 courses/second; only completion
commits a course. Feedback arriving during the movement rather than after it is the single
most effective thing available for hiding the 150–350ms a camera will cost.

**Losing sight of the player never fails them.** `trackingState('lost')` freezes the frame
loop outright — the belt, the walls, the coins and the penguin all stop, verified to zero
displacement over a full second of real frames — and shows why. The menu pause and the
tracking hold are independent, so neither clears the other.

**Effort buys time.** This one is forced by arithmetic rather than taste. A keypress commits
a rep in 0.42s; a real squat takes about two seconds, and four of them need ten seconds of
visible wall — which no belt speed can provide across a 34-unit runway. So the wall does not
run on a fixed timer. While a rep is in flight the belt eases to 20% of its tier speed, and
it picks back up when you pause. Measured: bodies at 1.2s, 1.8s and 2.5s per rep all clear
every wall at every tier with zero hits, while a player who dithers 1.5s before each rep gets
caught by four walls out of four, and one who never moves gets caught immediately. The
mechanic works at any rep speed instead of one particular one, and a slower body is
accommodated automatically rather than punished.

**…and the gift is metered, because otherwise it deadlocks.** This is not a balance dial. The
easing reads *rep progress*, and a rep machine emits progress for as long as it believes a rep is
underway — so a movement that keeps producing progress but never **completes**, which is exactly
what a too-strict exercise does to an honest player, pinned the belt near zero indefinitely.
The wall hung a metre from the player's face and the treadmill stopped. Nothing timed out, because
from the belt's point of view the player was working hard the whole time. A real player reported
this as "there's a point in the game where it just stops moving", and they were right.

So easing spends a budget (`effortBudget`, 5s) and a **completed rep refunds it in full**. Anyone
genuinely doing the work has an unlimited allowance and never learns this exists — measured: a
player completing a rep every 0.5s stays eased for 13.3 of 14 seconds. Flail for five seconds
without finishing one and the belt resumes and the wall arrives, which is the fail condition the
design already wanted rather than a silent stall with no way out. `stall.mjs` (20 assertions)
covers both halves.

## Workout mode

Press `E` or hit **GYM**. The belt spins down, the camera swings round to a side-on
three-quarter view, and the penguin works out: **squats, push-ups, jumping jacks, burpees**,
with a rep counter and three tempos. `1`–`4` switch exercise, `E` or **BACK TO RUNNING**
returns you to the game.

The exercises are pose generators, not keyframes — the same principle as the run cycle. One
phase value per rep drives eleven channels (body height, pitch, hip swing and abduction, foot
angle, flipper swing and flare, leg compression, squash, flatten). Burpees are built by
blending between the squat, plank and overhead sub-poses across seven timed segments, so the
whole movement is one function of one number.

Two rig additions were needed to reach these poses: **hip abduction**, because nothing in the
running game ever sends a leg out sideways; and a **prone lift**, because a body pitched flat
pivots about the feet and would otherwise sink halfway into the belt — which, it turned out,
it had been doing during every belly slide.

---

## Device builds

Both platforms need the game inside `www/`, because Capacitor copies `webDir` wholesale and
you do not want the repo root in your app bundle.

```bash
# once
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android

# stage the game (repeat after every edit to index.html)
mkdir -p www && cp index.html www/
# optional but recommended for app bundles: ship the engine so the app never needs a network
cp node_modules/three/build/three.module.js www/          # then edit the import map as above
```

`capacitor.config.json` is already in this repo — app id `com.moobit.beltrunner`,
`webDir: "www"`, background `#2f7fd8` (the top of the sky gradient), and
`ios.contentInset: "always"`.

### iOS

```bash
npx cap add ios
npx cap sync ios
npx cap open ios          # then set your signing team in Xcode and run on a device
```

Notes:
- iOS Safari and WKWebView do not implement the Screen Orientation lock API. The game
  requests it, ignores the rejection, and plays fine in both orientations. If you want the
  app locked to portrait, uncheck Landscape Left/Right in the Xcode target's
  *Deployment Info → Device Orientation*.
- The HUD already respects `env(safe-area-inset-*)` on every edge, and
  `viewport-fit=cover` is set, so notch and home-indicator areas are handled.

### Android

```bash
npx cap add android
npx cap sync android
npx cap open android      # then Run
# or, without Android Studio:
npx cap run android
```

For a release build:

```bash
cd android && ./gradlew assembleRelease
```

Notes:
- Gesture-navigation phones get bottom-inset padding from the same safe-area CSS.
- WebGL2 needs Android 7+ / Chrome 58+, which is also Capacitor 6's floor.

### After any change to the game

```bash
cp index.html www/ && npx cap sync
```

---

## What is actually in here

**The character** is an original penguin: one continuous egg with no neck, teardrop flippers
hanging off the upper third, a blunt beak, two crest tufts and stubby feet that poke out from
under the belly. Its colour blocking is painted into the lathe's own UVs — the seam sits at
the back and `u = 0.5` is the front, so a cream bib comes free with no extra draw call. The
beak, flipper tips, crest and feet all share one ember accent, and the golden shell is the
loud colour because the camera spends its life looking at the character's back.

**Movement** is the whole game. Momentum-based acceleration (~0.21s to top speed), a
separate deceleration curve that overshoots where you released, a distinct and heavier
turn acceleration so reversing at speed slides before it commits, smoothed yaw with roll
that banks into the turn, asymmetric jump gravity (rise is 0.65× fall) with an apex hang,
variable jump height, coyote time, a jump buffer, air control at 60%, and squash/stretch
on springs rather than tweens.

**The dive** is a commitment: a forward impulse at 1.35× top speed, zero steering while
airborne, a belly slide with its own friction, and a get-up lockout of 550–750ms
(440–600ms on touch). Diving into an obstacle cancels straight into ragdoll.

**Ragdoll** is velocity-driven physics, not an animation: linear velocity from the impulse,
angular velocity from the off-centre hit, ground bounce at 0.35 restitution, angular
damping. When it settles it *blends* back to the animated pose over 300ms and then plays
the same get-up beat as the dive.

**The treadmill** ramps through eight speed tiers on long plateaus with hard step-ups,
throws telegraphed surges (0.8s of klaxon and rumble first) and unannounced stutters that
pitch an over-committed runner into the front roller. Six obstacle types ride the belt
toward you: low sweeper bars, high bars you must dive under, swinging pendulums, rotating
fan blades, inflatable bumpers, and slick patches. In lane mode they snap to lane centres —
and keep tracking those centres if the playfield width changes underneath them — so dodging
is a lane decision rather than a nudge.

**Physics runs on a fixed 60Hz accumulator** with interpolated rendering, and the
accumulator is clamped to five steps of catch-up so backgrounding the app for thirty
seconds cannot detonate the simulation on resume.

---

## The playfield is derived from the camera, not hard-coded

The playable belt width is computed every frame from the camera frustum at the player's
depth, so the gameplay space is identical at every aspect ratio and nothing is ever
letterboxed. Portrait gets a narrower belt — and lateral speed, lateral acceleration, the
lateral wall margin, and every obstacle's lateral extent all scale with that width. The
consequence, which is the point: a full-width dodge costs the same *time* and the same
*fraction of thumb travel* in portrait as it does in ultrawide. Depth (Z) extents never
scale, so timing windows are identical too.

Measured across four viewports, a full lateral dodge takes 90 / 90 / 90 / 90 frames in
16:9, 414×896 portrait, square, and 2.39:1 ultrawide, and an outside-to-outside lane change
takes 29 / 29 / 29 / 29.

The distance the width is derived from is measured in the ZY plane rather than along the
camera's own axis. That matters in lane mode: the camera picks up a little yaw while tracking
a side lane, and along-axis distance would feed that yaw back into the very width that defines
where the lanes are. It converged, but to lanes that shifted 20% inward whenever you used one.

---

## TUNING values most worth dialling to taste

Everything lives in the single `TUNING` object at the top of the file. These are the ones
that change how the game feels, in the order I would touch them:

| Value | Default | What it does |
|---|---|---|
| `run.laneTime` | `0.24s` | How long a lane change takes, at any belt width. Below ~0.18s it stops reading as a lunge; above ~0.32s you cannot react to a late obstacle. |
| `run.laneFrac` | `0.62` | Lane spacing as a fraction of the playable half-width. Raise it and the outer lanes hug the edges; lower it and the three lanes bunch up in the middle. |
| `run.laneYaw` / `laneBank` | `0.38` / `0.30` rad | The sidestep read. Uncapped yaw sends the penguin running fully sideways at ~60°; the bank is driven straight off the lateral rate so the lean survives the cap. |
| `run.wallReps` | `[2, 4]` | Courses of brickwork in ENDLESS mode, scaled by belt tier. Four is about the most you can hit cleanly before the wall arrives. The workout derives its own count instead — see `hiit.repSec`. |
| `hiit.levels` | 8/10/12 rounds | A level is a work:rest ratio (1:1.9 / 1:1.3 / 1:1.1) and a round count, not a difficulty slider on the game. `tierCap` is belt speed and is deliberately high — the recovery segment is the cardio half. |
| `hiit.repSec` | `[2.2, 2.4, 1.2, 3.5]` | Seconds one rep costs, per exercise — only a SEED. The session measures the player's real pace and persists it to `br.pace`, which is what stops a slower body being knocked down by walls sized for someone faster. |
| `hiit.warmupSec` | `18s` | Belt-only movement before round one. Also where framing and tracking settle. Die during it and you restart it, which is why the endless soak tests set `Settings.hiit = false`. |
| `run.repGap` / `repSlack` | `0.20s` / `1.35` | Minimum time between reps, and the margin the spawner assumes on top of it. Drop `repSlack` toward 1.0 and walls start arriving that are only *theoretically* survivable. |
| `run.repDurBody` | `2.2s` | What the spawner assumes one *real* rep takes. This is the number the whole wall-timing model hangs off; `repDur` (0.42s) is only how long the keyboard's stand-in animation plays. Raise it and walls get further apart and more forgiving. |
| `run.workBeltMul` | `0.20` | Belt speed while a rep is in flight, as a fraction of tier speed. This is what buys a slow body time. At 1.0 the wall runs on a pure timer and only very fast reps survive; below ~0.15 the world reads as stopped dead rather than slowed. |
| `run.effortBudget` / `effortRefill` | `5.0s` / `1.5` | How long the belt will stay eased without a **completed** rep, and how fast that budget recovers. A completed rep refunds it entirely, so this only ever bites a player who is moving without finishing anything. Set the budget very high and you restore the original deadlock. |
| `run.effortUp` / `effortDown` / `workGap` | `9` / `2.6` / `0.30s` | How fast the easing engages, lets go, and how long a gap in the progress signal counts as having stopped. `workGap` has to comfortably exceed the inference interval or the belt will stutter between frames. |
| `run.beltTiers` | `[5.0 … 7.6]` | The lane-mode ladder, roughly half the free-run one. Difficulty lives in reps-per-wall and wall frequency, not here. |
| `run.wallEvery` / `wallQuiet` | `[74, 112]` / `14` | Belt-units between walls, and the quiet zone before one where obstacles stop spawning. The gap between those two numbers is the entire obstacle budget in lane mode — shrink `wallEvery` and obstacles disappear from the game. |
| `run.coinValue` | `12` | Per coin, ×(1 + 0.25 per chain step) up to a ×12 chain. |
| `move.topSpeed` | `12.0` | The whole difficulty curve hangs off this. It sits deliberately just under the mid-game belt speed (`belt.tiers[2] = 12.4`), so holding station is always a small fight. Raise it and the belt stops mattering. |
| `belt.tiers` | `[10 … 18]` | The pressure ladder. `tiers[0] = 10.0` already needs ~83% throttle to hold station. Lower the first entry for a gentler opening. |
| `belt.tierAt` | `[0 … 4100]` | Distance at which each tier begins. Widen the gaps for longer plateaus. |
| `jump.riseRatio` | `0.65` | Rise gravity as a fraction of fall gravity. This one number is most of the "floaty up, decisive down" feel. |
| `jump.apexScale` / `apexFrames` | `0.80` / `8` | The apex hang. Worth more to the bounce than anything else in the file. Turn it off and the jump immediately feels cheap. |
| `jump.coyote` / `jump.buffer` | `110ms` / `140ms` | Forgiveness. `mobile.coyote` / `mobile.buffer` (160 / 200ms) override these whenever touch is the active input. |
| `move.turnAccelScale` | `0.52` | Below 1 means reversing at speed slides before it commits. Push it toward 1.0 for a twitchier, less comic character. |
| `move.bankPerAngVel` / `bankMax` | `0.090` / `0.335` | How hard the body leans into a turn. `bankMax` is ~19°. |
| `dive.getUp` | `0.65s` | The price of a dive. Shorten it and diving stops being a gamble. `mobile.getUp` is 0.52s. |
| `dive.slideDecel` | `8.0` | Belly-slide friction, against ~40 for a running stop. Lower it for longer, riskier slides. |
| `cam.hitStop` | `0.075s` | Frozen simulation on a ragdoll-triggering impact. Worth more than any shader. |
| `cam.posFreq` / `lookFreq` | `9.0` / `6.0` | Critically damped spring stiffness. The look-at is deliberately softer so the camera trails the body and leads the motion. |
| `cam.fovTop` | `68°` (touch `64°`) | FOV kick at top speed from a 55° base. Big swings on a small screen read as nausea, not speed. |
| `obs.legibility` | `1.2s` (touch `1.6s`) | Guaranteed lead time before contact. The spawner enforces it against a worst-case closing speed and simply delays a pattern rather than shipping an unreadable one. |
| `obs.gapSeconds` | `[0.95, 1.85]` | Spacing between patterns, measured in belt-seconds so density holds as the belt speeds up. |
| `mobile.dodgeAssist` | `1.12` | Silent lateral help when the player is inside a near-miss window *and* steering the correct way. Invisible, and the difference between touch dodging feeling possible and feeling arbitrary. |
| `perf.downFps` / `downHold` / `upFps` / `upHold` | `55` / `2s` / `58.5` / `30s` | The pixelRatio ladder's hysteresis. Slow to recover on purpose, so it never visibly oscillates. |

---

## Size

Measured, for a `SHIP=1` build:

| | on disk | |
|---|---|---|
| MediaPipe WASM | 12.08 MB | the pose runtime |
| Pose model (lite) | 5.78 MB | float16 weights |
| three.js (vendored) | 1.27 MB | needed for an offline app bundle |
| The game | 0.24 MB | one `index.html`, everything generated in code |
| Pose layer source | 0.09 MB | five state machines, calibration, normalization |
| MediaPipe JS glue | 0.16 MB | |
| **Total** | **19.6 MB** | **~8.9 MB** over the air after store compression |

That is small for a game with on-device pose estimation — the App Store's cellular download limit
is 200 MB and a typical mobile game is 5–20× this. **94% of it is the vision runtime**, and none of
that is code anyone wrote here: the game itself is a quarter of a megabyte because every mesh is
generated and every texture is painted to a canvas at boot.

Run the fetch script with `SHIP=1` for an app bundle. It drops the sourcemaps and the 11 MB
no-SIMD WASM fallback, which only matters on devices predating WASM SIMD (roughly pre-iOS-16.4,
pre-Chrome-91). Dev builds keep both, so the console stays useful and an older device still runs.

If 19.6 MB ever needs to be less, in order of what it costs you:

- **Quantise the model.** An int8 pose model is roughly half the float16 one, for some accuracy.
- **Strip the WASM.** `wasm-opt -Oz` on the MediaPipe binary typically takes 10–20% off.
- **Download the model on first run** instead of bundling it. Saves 5.8 MB of install size but
  breaks the offline guarantee, which is why it is bundled now.

## Performance

Budgets, and what was actually measured (see `CHANGELOG.md` for the method and its limits):

| | Budget | Measured |
|---|---|---|
| Draw calls | < 80 | **70–77** at the reachable worst case — obstacle pool at its lane-mode ceiling *plus* two standing walls, a full 48-coin field and the lane guides, across 16:9 / portrait / square / ultrawide |
| Triangles | < 150k | **31k–35k** |
| Fixed-step CPU cost | — | **0.011–0.037 ms/step** (60 steps/s) |
| Allocation in the frame loop | zero | **0 bytes** from game code — measured over 12,000 lane-mode steps driving ~9,000 continuous `repProgress` calls, across which the heap *shrinks* 1.8 MB; ~4.5 KB/frame remains inside three.js's own `WebGLRenderer.render()` |
| Heap growth over 18,000 steps | none | **none** (heap net shrinks; nothing accumulates) |
| Catch-up steps after backgrounding | ≤ 5 | **5**, clamped |

Mobile runs the same code with `pixelRatio` capped at 1.5 (auto-stepping down by 0.25 to a
floor of 1.0 when the rolling 60-frame average sits under 55fps for 2s, and back up only
after 30s of headroom), a 1024² shadow map, single-pass half-resolution bloom, and particle
pools at 40% of desktop counts. Quality `LOW` drops real shadows entirely in favour of the
projected blob shadow that is always under the character anyway — an honest blob at 60fps
beats a real one at 45.

The debug overlay (triple-tap top-left, or `F3`) shows fps, frame time, scene and total
draw calls, triangle count, current pixelRatio, quality tier, belt tier and speed, live
obstacle count, the worst obstacle lead time seen this run, particle count, active input
mode, playfield half-width, player state, NaN count, and fixed steps per frame.
