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
