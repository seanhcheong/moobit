# BELT RUNNER

A chunky bean runs on a giant treadmill. The belt drags the world backward under its feet.
Run forward to hold station. Fall behind and the rear lip throws you off. Push too far
forward and the front roller bounces you back. The belt speeds up. You survive as long as
you can.

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

| | Desktop | Touch |
|---|---|---|
| Move | `W A S D` or arrows | left half of the screen — relative drag pad, origin wherever your thumb lands, sliding origin so you never run out of travel |
| Jump | `Space` (hold for height) | tap the right half (fires on press, not on release) |
| Dive | `Shift` or left mouse button | swipe the right half in any direction |
| Restart | `R` | tap anywhere on the death screen |
| Settings | `Esc` or the gear | the gear (top-right, out of both thumb zones) |
| Debug overlay | `F3` | triple-tap the top-left corner |

A gamepad works too if one is connected: left stick to move, A to jump, B to dive.

**Auto-run** (in settings) holds the forward throttle for you and reduces the left pad to
lateral steering, which makes one-handed play viable.

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
fan blades, inflatable bumpers, and slick patches.

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

Measured across four viewports, a full lateral dodge takes 88 / 90 / 89 / 90 frames in
16:9, 414×896 portrait, square, and 2.39:1 ultrawide.

---

## TUNING values most worth dialling to taste

Everything lives in the single `TUNING` object at the top of the file. These are the ones
that change how the game feels, in the order I would touch them:

| Value | Default | What it does |
|---|---|---|
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
| Draw calls | < 80 | **58–72** — 52 in ordinary play, 71 with the obstacle pool forced to its hard ceiling, across 16:9 / portrait / square / ultrawide |
| Triangles | < 150k | **19k–26k** |
| Fixed-step CPU cost | — | **0.011–0.037 ms/step** (60 steps/s) |
| Allocation in the frame loop | zero | **0 bytes** from game code; ~4.5 KB/frame remains inside three.js's own `WebGLRenderer.render()` |
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
