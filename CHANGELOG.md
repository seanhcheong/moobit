# Iteration log

Every pass below was scored against the six categories from the brief, then the weakest
specific element was fixed and the build re-scored. Scores are 1–10. Any missing Part 1
item is an automatic 5 in **Feel**, per the rules.

## How this was actually verified

Not by eye alone. The build exposes a small `window.BR` handle that lets a headless Chromium
drive the fixed-step simulation directly, so feel can be asserted numerically rather than
described. Three suites run against the shipped file (with only the import-map line
rewritten to a local copy of three.js, one line, verified diff):

- **`feel`** — 43 assertions walking the entire Part 1 checklist plus belt behaviour,
  obstacle legibility and physics robustness.
- **`touch`** — 32 assertions dispatching real `PointerEvent`s at the actual handlers:
  drag pad, sliding origin, deadzone, simultaneous pointer tracking, tap-jump latency,
  swipe-dive, auto-run, keyboard coexistence, gesture suppression.
- **`verify`** — 25 assertions across four viewports (16:9, portrait, square, 2.39:1
  ultrawide): draw calls, triangles, aspect-ratio equivalence, catch-up clamping, plus a
  five-minute simulation soak.
- **`frameinput`** — 7 assertions that drive the *real* `requestAnimationFrame` loop under a
  virtualised clock at 60 / 120 / 144Hz. Added in pass 13, after a bug that the other three
  suites were structurally incapable of seeing: they call the fixed step directly and so
  never exercise the frame loop's own input plumbing.

Plus a per-call allocation breakdown and screenshots at every game state in both
orientations.

**What this environment cannot tell me:** the container renders through SwiftShader
(software), at ~160ms/frame. So no fps number here means anything about real hardware.
Performance is therefore scored on the things that *are* measurable and that actually
determine mobile frame time — draw calls, triangle count, per-step CPU cost, and bytes
allocated per frame — with the budgets from Part 5 and 7.5 as the gates. The one claim I
cannot make from here is a measured 60fps at the five-minute mark on a thermally throttled
mid-range phone. Everything that gate depends on is inside budget with margin, and the
runtime auto-downgrade ladder exists precisely for the case where it isn't.

---

## Pass 1 — first working build

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 4 | 6 | 5 | 6 | 7 | 5 |

Boots, plays, all six obstacle types present. Immediately found by test:

- `Cam.dip` was declared as both a property and a method — the property won, so every
  landing threw `Cam.dip is not a function`. **Correctness 4.**
- The apex stretch was driven from raw vertical velocity, which meant it fired at maximum
  right at takeoff and cancelled the takeoff squash (`sy` 0.94 instead of 0.82). Squash on
  takeoff is a Part 1 item, so **Feel 6**.
- Belt distance accumulated on the title screen, so the attract mode tiered itself up.
- Obstacles spawned before the game started.
- The slick patch collider was 0.02u tall and could never overlap a standing player — one
  of six obstacle types was inert.
- Fan blade collision sampled only the outer 2/3 of each blade, leaving a hole at the hub.

## Pass 2 — correctness

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 5 | 7 | 7 | 5 |

- Renamed the camera dip method; fixed the stretch to be driven by apex-ness (`|vy|` small)
  so takeoff squash and apex stretch stop fighting — which is also what the brief asks for
  literally.
- Gated scoring and spawning on the play state; fixed the slick collider and fan sampling.
- Moved `REF_HALF` above its first use (a TDZ crash found by the boot test), and later
  `mergeGeos`/`MTX` above the character build for the same reason.
- Play-area derivation was reading the live player position, so a ragdoll falling into the
  pit collapsed the playfield to its minimum mid-death. Switched to a stable reference point.
- Raised the tier ladder from `[8.5 … 18]` to `[10 … 18]`: at 8.5 the player's 12 u/s top
  speed out-ran tier 1 by 41%, so the opening minute had no belt pressure at all. Holding
  station now costs ~83% throttle from the first second.
- **43/43 feel assertions pass**, including coyote time expiring correctly, jump buffer,
  apex assist firing, dive lockout at 650ms, ragdoll blending back monotonically
  (`w.rag` 0.99 → 0.04, never a pop), and hit-stop.

## Pass 3 — the legibility guarantee

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 5 | 7 | 7 | 5 |

The brief requires every obstacle to be legible ≥1.2s (1.6s on touch) before contact at the
current belt speed. That is a claim, so it needed to be a measurement:

- The spawner now computes lead time against a *worst-case* closing speed (belt speed plus
  the player's own forward velocity) and refuses to spawn a pattern that would violate the
  window — it delays instead. Surges never spawn anything new, so an in-flight obstacle can
  never become illegible after the fact.
- Moved the front roller to −42 and the spawn point 8u ahead of it, giving 34u of runway.
- `Spawn.minLead` is tracked for the whole session and shown in the debug overlay.
- Measured across all six tiers, both input modes, 25s per tier: **worst lead 1.81s
  (desktop, need 1.2s) and 1.80s (touch, need 1.6s)**, with all six obstacle types
  appearing and 119–123 spawns per run.

## Pass 4 — allocation in the frame loop

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 5 | 7 | 8 | 5 |

Measured 9.3 KB/frame of heap growth. Broke it down per call site: the fixed step, pose
application, particles and camera were all at zero, so the culprit was the HUD writing
freshly-formatted strings into `style.width` and `style.opacity` every single frame.
Both now only touch the DOM when the displayed value actually changes.

Final breakdown, bytes per call: `simStep 0`, `applyPose 11`, `particles 10`,
`camApply 0`, `threeRender 1972`, `postRender 4358` (which includes the scene render plus
six full-screen passes). **Game code allocates nothing per frame. The ~4.4 KB that remains
is inside three.js's own `WebGLRenderer.render()`** and cannot be removed without forking
the engine; at 60fps that is ~260 KB/s, well inside a young-generation scavenge.

## Pass 5 — look, first honest pass

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 7 | 8 | 8 | 5 |

Screenshots at every game state. **Look was the weakest category by a distance**, and for
concrete reasons:

- Obstacle UVs were the source geometry's 0–1 box UVs stretched across a 13.6u bar, which
  turned bold chevrons into thin diagonal filaments — the high bar read as a set of red
  laser lines, not a solid object you must dive under. Added per-part UV scaling to the
  geometry merger so every stripe holds a constant world size, and redesigned the pattern
  as one clean diagonal direction (the two-direction chevron tiled into a diamond net).
- The hazard warning tinted the *entire frame* red, sky included, because it was a flat
  `mix()` over the whole image. It is now a radial outer band at half the strength, plus a
  softer DOM vignette, and it fades to 22% on the death screen.
- ACES was being fed a 0.62 exposure fudge on top of a 0.86 uniform, costing most of the
  range. Rebalanced.
- The camera sat 10.6u back with a 3.6u look-ahead, which put the character small and at the
  very bottom of the frame. Pulled in to 7.9u and clamped the look-ahead to ±1.6u.
- Running dust read as popcorn: too many, too opaque, too white, and the belt velocity was
  being applied twice (once at spawn, once as advection in the pool). Halved the rate,
  shrank the sizes, greyed the tint, removed the double-count.

## Pass 6 — the character silhouette

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 9 | 9 | 8 | 5 |

From a camera that sits above and behind, the bean read as an indistinct blob with a pink
halo. The halo was the neck scarf seen from above; the blob was a smooth yellow dome with no
markings on the surface the camera actually looks at.

- The body is a `LatheGeometry`, and lathe UVs put `u = 0` at `+Z` — which is exactly the
  character's back. So the shell texture now paints a dorsal stripe at the texture seam
  (it runs up the back and over the top) and a cream belly panel at `u = 0.5`. Colour
  blocking that reads from any angle, for zero extra draw calls.
- Deleted the scarf; enlarged the cape into the real back feature, with per-frame flutter
  written into a cached vertex buffer.
- The antenna's chrome bulb was blowing out into a white spike during dives — dropped
  metalness 0.92 → 0.45 and tinted it mint.
- Limbs moved onto an unstriped copy of the skin so the dorsal stripe doesn't wrap the arms.

## Pass 7 — touch

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 9 | 9 | 8 | 9 |

32 assertions against the real pointer handlers found a genuine bug that no amount of
looking would have caught:

**Jump fires on `pointerdown`, not on release** — a tap must not cost the player 180ms of
latency waiting to be classified. If the gesture then turns into a swipe, the dive is meant
to override. But `stepPlayer` evaluated its `locked` snapshot *before* consuming the dive
edge, so the buffered jump from the same press ran after `startDive()` and reset the state
to `RUN`. **Every swipe-dive on touch was being silently cancelled by its own tap-jump.**
Fixed by re-testing the live state before jumping, clearing the jump buffer inside
`startDive()`, and cancelling the provisional jump edge the moment a swipe is recognised.

Also in this pass:
- Score and tier panels overlapped on a 414px-wide screen. Added narrow-screen breakpoints.
- Score pops could render off-screen; now clamped to the viewport.
- The attract mode charged the front roller and bonked forever; it now runs a small
  station-keeping controller like a player would.
- Verified live tuning switchover: touch raises coyote 110→160ms, buffer 140→200ms, drops
  get-up to 520ms, widens legibility to 1.6s, caps FOV kick at 64°, scales shake to 65%,
  caps pixelRatio at 1.5, and enables the 1.12× dodge assist — and a keystroke switches it
  all back in the same session, with no mode switch anywhere.

## Pass 8 — performance

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 9 | 9 | 9 | 9 |

Draw calls were 98–106 when the obstacle pool was force-filled — over the 80 budget.

- `obs.maxActive` was 14 (10 on touch), which is well above what the spawner ever reaches
  naturally (3–6). Lowered to 10 / 8 so the *ceiling* is inside budget rather than merely
  the average.
- Merged the costume (waist band + chest patch + emblem) into one mesh, and both eyes into
  one mesh built around the eye line so a Y-squash still reads as a blink. Both glints into
  one.
- Dropped shadow casting from geometry whose shadow never lands on the play area: rail
  posts, klaxon posts, the rear lip.

Result: **71 calls at the hard ceiling, 52 in ordinary play, 19k–26k triangles**, consistent
across all four viewports.

## Pass 9 — aspect-ratio equivalence

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| 9 | 9 | 9 | 9 | 9 | 9 |

Measuring the time to cross the belt at full lateral input exposed two things the eye
would never have found:

- The lateral wall margin was a constant 0.42u while the play width scales with the
  frustum, so a narrow portrait belt was proportionally *shorter* to cross — portrait had a
  7% advantage. The margin now scales with the play width, which makes traversal time
  algebraically independent of aspect ratio.
- The play width was derived from a fixed world reference point while the camera pans
  laterally with the player, so the playfield subtly *breathed* as the player moved
  sideways. The reference now takes its X from the camera itself.

Measured: **88 / 90 / 89 / 90 frames** for a full-width dodge in 16:9, portrait, square and
ultrawide. Obstacle lateral extent holds at 0.397 of the play half-width in every one.

## Pass 10 — final polish and soak

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **9** |

- Sky horizon bleaching cut from 0.55 to 0.34 so the gradient survives at low camera pitch;
  fog colour resaturated.
- Rear roller was blowing to white; dropped metalness and raised roughness.
- Contact shadow strengthened where the real shadow is also on — the belt is dark, so the
  blob is doing most of the contact read.
- Five-minute simulation soak (18,000 fixed steps with randomised input and repeated
  deaths/restarts): **no NaN, no console errors, obstacle pool bounded at 12 objects, heap
  net shrinks, 0.011 ms per step.**
- Audio verified against a real trusted gesture: no `AudioContext` exists before the first
  click, and it is `running` immediately after. Every one-shot fires clean.
- Backgrounding round-trip: catch-up clamped to 5 steps per frame, peak measured 5.

**Final: 100/100 assertions pass. Zero console errors and zero console warnings in every
suite and every viewport.**

## Pass 11 — the character becomes a penguin

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **9** |

Reshaped from a bean to a penguin against a supplied reference turnaround. The animation rig
turned out to be the right rig for it — a waddle is exactly what a phase accumulator with
lateral sway and counter-swinging limbs produces.

What the reference dictated, and what measuring it changed:

- **Proportions.** My first pass kept the bean's fatness: 0.86 width-to-height against the
  reference's ~0.54. Measured off the image and reprofiled the lathe to 0.66 — slimmer than
  the bean, still chunky enough to read at 640×360.
- **Flippers on the silhouette, not inside it.** Teardrop paddles, tapered in code from a
  sphere. The first attempt pivoted them at x=0.505 while the body radius there was 0.63, so
  they were buried; and at rest the dark tip against the belly read as a *gash*. Fixed by
  moving the pivot out, widening and thickening the paddle, raising the resting flare to
  0.42 rad, and tipping them in the same ember as the beak and feet so the accents read as
  one family.
- **Colour blocking for free.** `LatheGeometry` puts `u = 0` at `+Z`, so the texture seam
  runs up the character's back and `u = 0.5` is the front. The cream bib is painted row by
  row into the shell texture as a real bib shape — widest at the belly, narrowing to a
  throat, stopping under the beak — at zero extra draw calls. The old blossom dorsal stripe
  is gone; a penguin's back is plain, and the golden back is the loud colour the game camera
  actually looks at.
- **A blunt beak.** Pinched 0.70 to a needle it looked right head-on and vanished in profile.
  Now 0.44 with a sharper falloff: mass all the way to the tip.
- **The tail had to stop being a patch.** Plum and near-horizontal, seen face-on from a
  camera 26° above, it read as a hole punched in the silhouette. It is now a shaded
  body-coloured extension of the lower back, which is what the reference actually shows.
- **The crest pointed the wrong way.** `rotation.x` negative pitches a feather *forward*, so
  two ember tufts read as devil horns. Swept back over the crown at +0.92 they read as a
  crest.
- **Eyes.** 0.112 radius with `envMapIntensity: 1.4` gave two glossy grey marbles mirroring
  the sky. Down to 0.083 with env at 0.35 — small, dark, and a single glint each.

Mechanical consequences, all measured rather than assumed:

- The ragdoll pivots about the body centre, which moved from 1.00 to 0.86, and its resting
  centre height from 0.60 to 0.63 (the new half-width). Both are named constants now.
- A prone penguin is an egg on its side, so it is *taller* lying down than the bean was.
  Added a world-vertical flatten group outside the orientation node — a belly slide now
  squashes against the belt (0.76) rather than the body's own axis, which the existing
  squash could never do. High bar raised to 1.12–1.72 to match.
- **Four new clearance gates** in the feel suite, because those heights are now load-bearing:
  standing into a high bar hits, diving under it passes clean, standing into a sweeper hits,
  jumping clears a sweeper. All pass.
- Camera pulled from 7.90 to 7.35 back and 4.45 to 4.20 up, since a narrower character
  occupies less of the frame.
- Draw calls went *down*: the bean's costume, cape, antenna, stalk, bulb, two arm meshes and
  two hand meshes are gone, replaced by body, trim (beak + tail), crest, eyes, glints, two
  flippers and two feet. **53 in ordinary play, 71 at the hard ceiling.**

**104/104 assertions pass** (47 feel, 32 touch, 25 verify). Zero console errors, zero
warnings.

## Pass 12 — matching the second reference

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **9** |

A second reference arrived: a back view of the penguin mid-run. Measured against it, pass 11
was wrong in three specific ways.

- **The body was an egg, not a pear.** The reference is a bowling pin: widest at **19% of
  the body height**, tapering to a head **0.66** of that width. Mine was widest at 42% with a
  head 0.82 of the width, so the silhouette had no taper to speak of. Reprofiled from the
  measurements — the body is wider at the bottom than pass 11 and considerably narrower at
  the shoulders, which is what makes it read as a penguin from behind rather than a lemon.
- **The flippers were long teardrops; the reference's are stubby paddles.** Measured at
  0.31 × 0.42 (a 0.78 ratio, nearly square) with a *rounded* tip, not a point — so the taper
  dropped from 0.80 to 0.42 and the paddle shortened by a third. The reference also holds
  them out at **~35° from vertical**, computed from the offset between flipper root and tip;
  resting flare went from 0.42 to 0.40 rad with a gentler speed ramp so a full run sits at
  40° rather than 56°.
- **The feet had to clear the belly.** A wider bottom hid them completely. Widened the stance
  to ±0.255 and grew the pads, so the outer toes now break the body's flank silhouette. They
  still cannot be fully visible from behind the way the reference shows them — that image is
  shot from a near-level camera, and this game's camera sits 22° above. Stated rather than
  faked: dropping the pitch to match would cost obstacle legibility down the corridor.

One structural fix fell out of this. The belly bib is painted into the shell texture by
texture row, but `LatheGeometry` spreads `v` evenly across *rings*, not evenly in Y — and
the new profile's rings are far from uniform in Y (spans range from 0.014 to 0.135). The bib
top would have landed at world 1.40, above the eyes, covering the face. So the profile is now
a single shared constant, `BODY_PROFILE`, and the texture converts height to texture row
through the actual resampled ring list (`yAtV`). The bib is placed in body-local heights now,
and it stays correct if the profile is ever edited again.

The crest also shrank: the reference's crown is clean, so the tufts are now small enough to
keep the dome's silhouette while still carrying the springy secondary motion.

**104/104 assertions pass.** Draw calls 44–50 in ordinary play, 20–21k triangles, zero
console errors, zero warnings.

## Pass 13 — three real bugs from play feedback

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **9** |

Reported symptoms: *"the jump sometimes doesn't work and the game sometimes resets."* Both
were real. Every fix below is paired with a test, and every test was checked against the
broken build first — a test that only passes on the fixed build proves nothing.

**1. Input was thrown away on frames that ran zero simulation steps.** The frame loop ended
with an unconditional `In.jumpEdge = false; In.diveEdge = false;`. Edges are meant to be
consumed *inside* the fixed step, and a frame can legitimately run zero steps — any display
faster than 60Hz does it roughly every other frame. So the clear was destroying presses
before the simulation ever saw them.

Measured on the broken build: **60Hz 0/14 dropped, 120Hz 7/14, 144Hz 8/14**, and dives
4/8 at 120Hz. Half of every input, on any modern phone. That is the whole of "the jump
sometimes doesn't work", and it explains why it felt random: at exactly 60Hz it is fine.

**2. Being knocked down in the hazard zone hung the run for five seconds.** The rear-lip
death check lived only in the non-ragdoll branch, so a limp body dragged past the lip never
triggered it. The floor drops to −60 past the lip, so the penguin fell into the void for
~3.5s, bounced on the invisible floor, blended back to standing, was teleported to belt
level, and *then* died. From the player's chair: the character vanishes, nothing happens for
five seconds, then a death screen appears out of nowhere — indistinguishable from a crash or
a reset. The check now also runs inside the ragdoll branch, with a fallback for any body
below −25. **300 frames to resolve before, 90 after.**

The first version of that test asserted only "it eventually dies", which *passed on the
broken build*. "Eventually" was never the property that mattered; the assertion is now bounded
to 2.5 seconds.

**3. A tapped jump could not clear the shortest obstacle.** `cutMul` (0.45 on release) scales
velocity, and height goes as velocity squared — so a release before the first step produced
**20% of full height: an apex of 0.47** against a sweeper bar that tops out at 0.70. Worse,
this fired on the *common* pattern of buffering a jump just before landing and letting go
before it comes out. The cut now floors the apex at `jump.minHeight` (1.05) by solving for the
velocity still needed from the current height, so a tap reaches 1.00 and clears with margin
while staying 43% of a held jump. Variable height is intact; the useless hop is gone.

**Two hardening changes** with no reproduction, stated as such rather than dressed up as
fixes. A lost `pointerup` — an app switch, an incoming call — used to leave the action slot
occupied forever, silently ignoring every later tap, and leave steering stuck at its last
value; pointers are now dropped on blur and on hide, and a stale action pointer can be taken
over after 1.2s. And a mouse-clicked button kept focus, so a later Space could have activated
it (on RUN AGAIN, that would restart the run); focus is now dropped after pointer-driven
clicks only, so keyboard navigation still works. In Chrome the existing `preventDefault` on
keydown already suppressed the activation, so this one was never reachable here — it is
insurance for browsers that behave differently.

**114/114 assertions pass** (50 feel, 32 touch, 25 verify, 7 frameinput). Zero console
errors, zero warnings.

## Pass 14 — the penguin works out

| Correctness | Feel | Look | Juice | Performance | Touch |
|---|---|---|---|---|---|
| **9** | **9** | **9** | **9** | **9** | **9** |

Added a workout mode from a second set of reference poses: **squats, push-ups, jumping jacks,
burpees**, with a rep counter, three tempos, and a camera that swings round side-on so the
movement reads. The runner is untouched — `E` or the GYM button goes in, `1`–`4` pick the
exercise, and you come straight back out.

Built the same way as everything else here: pose generators, not keyframes. One phase value
per rep drives eleven channels; burpees blend between squat, plank and overhead sub-poses
across seven timed segments, so an entire burpee is one function of one number.

The rig needed two genuine additions, and finding the second was the useful part:

- **Hip abduction.** Nothing in a running game ever sends a leg out sideways, so the leg
  pivots only had `rotation.x`. Jumping jacks need `rotation.z`.
- **A prone lift.** A body pitched flat pivots about the feet, so laying the penguin down put
  half of it under the belt. Push-ups needed a fix — and rendering the existing *slide* pose
  to check showed the belly slide had been half-sunk into the belt this whole time. One
  correction fixed both.

Two things the tests caught that looking would not have:

- **Entering a workout dragged the penguin 5.2 units down the belt** while the belt spun
  down over half a second. Invisible in the demo footage, because the camera follows the
  player — it would only have shown up as the world sliding under a penguin doing squats.
  Belt drag is now zero in workout mode: the belt slows visibly, the penguin stays planted.
- **My first squat was a bow, not a squat.** This body has no knees and its belly is 0.105
  above the belt, so it cannot sink far; hinging instead just tipped it forward. Rebuilt
  around compression — the soft-vinyl body squashes to 0.81 vertical with a shallow 0.24 rad
  lean — which is the right language for the character anyway.

Also caught by assertion rather than by eye: my burpee jump-height check sampled `u = 0.80`,
mid-blend, and read 0.27 when the actual apex at `u = 0.86` is 0.62. The assertion now tests
the range over the whole cycle instead of one guessed phase.

**132/132 assertions pass** (71 feel, 32 touch, 25 verify, 7 frameinput) — 18 new ones
covering channel ranges per exercise, rep counting against each period, tempo scaling, belt
hold, 80 seconds of continuous exercise without NaN, and a clean handover back to running.
43 draw calls in workout mode. Zero console errors, zero warnings.

---

## Residual, stated plainly

1. **No real-GPU fps number.** SwiftShader is the only renderer available in this
   environment, so the 60fps-at-five-minutes gate is supported by proxy metrics (draw
   calls, triangles, 0.011–0.037 ms/step of CPU, zero game-code allocation) rather than by
   a frame timing on a thermally throttled phone. The pixelRatio ladder and the quality
   fallback ladder are both implemented and exercised for the case where a device
   disagrees.
2. **~4.4 KB/frame allocated inside three.js.** Game code is at zero; this is engine
   internals in `WebGLRenderer.render()` across the scene pass and six full-screen passes.
   Reducing bloom to one level (which is what touch defaults to) removes two of them.
3. **three.js comes from a CDN on first load.** That is what the brief specifies. The
   loader falls back through three mirrors and then a local `./three.module.js` sibling; for
   a wrapped app bundle, ship that file and change the one import-map line, which is
   documented in the README.
4. **The near-miss radius is a world distance and does not scale with the play width.**
   The brief's ×1.3 touch multiplier is applied. In portrait the belt is narrower, so the
   same world radius covers a slightly larger fraction of it — a deliberate leftover, since
   scaling it laterally would distort its vertical component (which is what makes diving
   under a high bar score).
