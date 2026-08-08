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
time it takes to arrive — measured against the worst-case closing speed, and against the
minimum rep cadence with 35% slack on top. Obstacles and walls never share the corridor:
obstacles stop spawning 14 belt-units before a wall is due, and a wall waits for the corridor
to drain before it spawns. Solid lane blockers can never seal all three lanes inside a
16-unit window, which is comfortably more than one lane change.

Every movement signal in the game — key, on-screen button, or anything added later — enters
through a single `Moves.trigger(kind)` call. Nothing downstream knows which produced it, so
a camera-based pose detector could drive the same function without touching game logic.

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
| `run.wallReps` | `[2, 4]` | Courses of brickwork, scaled by belt tier. Four is about the most you can hit cleanly before the wall arrives. |
| `run.repGap` / `repSlack` | `0.20s` / `1.35` | Minimum time between reps, and the margin the spawner assumes on top of it. Drop `repSlack` toward 1.0 and walls start arriving that are only *theoretically* survivable. |
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

## Performance

Budgets, and what was actually measured (see `CHANGELOG.md` for the method and its limits):

| | Budget | Measured |
|---|---|---|
| Draw calls | < 80 | **69–76** at the reachable worst case — obstacle pool at its lane-mode ceiling *plus* two standing walls, a full 48-coin field and the lane guides, across 16:9 / portrait / square / ultrawide |
| Triangles | < 150k | **31k–35k** |
| Fixed-step CPU cost | — | **0.011–0.037 ms/step** (60 steps/s) |
| Allocation in the frame loop | zero | **0 bytes** from game code, in free mode and in lane mode; ~4.5 KB/frame remains inside three.js's own `WebGLRenderer.render()` |
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
