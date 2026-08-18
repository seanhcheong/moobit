/* =====================================================================================
   POSE CONFIG — every threshold in the detection layer lives here and nowhere else.

   Two rules this file exists to enforce:

   1. No absolute pixel or normalized-coordinate threshold, anywhere. Every spatial number
      is a ratio against a body-derived reference (shoulder width, torso length, leg length)
      or an angle in degrees. A 1.5m user standing close and a 2m user standing far must
      produce identical numbers.

   2. The angle thresholds here are only *defaults*. Onboarding calibration overwrites them
      per user, at ~65% of that person's own observed range. Textbook joint angles are wrong
      twice over: wrong for a particular body, and wrong for the estimator, which carries
      systematic offsets of ~15 degrees on peak knee angle against motion-capture ground
      truth. A user whose deepest squat reads 110 degrees still gets to play.
   ===================================================================================== */

export const EX = { SQUAT:0, PUSHUP:1, JACK:2, BURPEE:3, LUNGE_L:4, LUNGE_R:5 };
export const EX_NAME = ['squat','pushup','jack','burpee','lunge_l','lunge_r'];

export const CONFIG = {
  /* ---- shared ------------------------------------------------------------------------ */
  common: {
    visGate: 0.5,          // below this a landmark is a guess, and a guess never counts a rep
    visGateFrame: 0.6,     // the stricter bar the framing check uses during onboarding
    staleMs: 400,          // no fresh landmarks for this long => freeze every machine
    /* the phase the game's poses expect: 0 = entry, 0.5 = the extreme, 1 = back to entry */
    phaseEntry: 0, phaseExtreme: 0.5, phaseReturn: 1,

    /* Per-exercise visibility gates, because one number cannot be right for both an upright
       exercise and a prone one. Prone in front of a floor camera, your hips sit behind your own
       shoulders and your ankles are a body-length further from the lens, so the estimator's
       confidence in them collapses — and it is *correct* to collapse. Holding a push-up to the
       bar a standing squat clears means the push-up simply never registers, which is the bug
       this fixes rather than a safety property it gives up. */
    visGateFor: { squat:0.5, jack:0.5, lunge:0.5, pushup:0.25, burpee:0.30, frame:0.6 },
    /* the separate, lower bar below which we stop believing we can see the person at all */
    lostVisFor:  { squat:0.25, jack:0.25, lunge:0.25, pushup:0.10, burpee:0.12, frame:0.25 },
    /* LOST pauses the whole game, so it must never fire on one bad frame. Both directions get
       a dwell: slow to pause, quicker to resume. */
    lostDwellMs: 700, foundDwellMs: 160,

    /* The shared "legs are straight" gate. A standing body does NOT read 180 — BlazePose runs
       ~15 deg pessimistic on peak knee extension and a relaxed stance is genuinely bent, so 160
       is a bar some people never clear standing up. That mattered most for the burpee, whose
       whole chain is gated behind reaching STAND first: below this number, burpees were not
       badly detected, they were undetectable. */
    standKnee: 150,
  },

  /* ---- 0: squat — second most reliable from a front camera --------------------------- */
  squat: {
    /* the entry state is `common.standKnee` — one number shared with the burpee, because
       "standing upright" must mean the same thing to both or a burpee's squat phase disagrees
       with the squat machine about whether the player ever stood up */
    bottomKnee: 100,       // deg — default only; calibration replaces it per user
    minBottomMs: 150,      // bouncing at the bottom is not ten reps
    minRepMs: 700,
    maxRepMs: 6000,        // longer than this and the machine gives up and resets
    hipDropMin: 0.15,      // x legLength — stops a bend-over reading as a squat
    torsoMaxTilt: 45,      // deg from vertical — same purpose, from the other direction
    primary: ['kneeL','kneeR'],
    secondary: ['hipDrop','torsoTilt'],
  },

  /* ---- 2: jumping jack — the most reliable of the five. Tutorial exercise. ----------- */
  jack: {
    openAnkleSpan: 1.40,   // x shoulderWidth
    closeAnkleSpan: 0.90,  // x shoulderWidth
    wristAboveShoulder: 0.02,  // x torsoLength of clearance, so a hover does not flicker
    minOpenMs: 120,
    minRepMs: 400,
    maxRepMs: 4000,
    primary: ['ankleSpan','wristY'],
    secondary: [],
  },

  /* ---- 4/5: side lunge — the lane-change control ------------------------------------- */
  /* Deliberately lateral, not forward. A forward lunge from a front-facing camera is almost
     entirely depth motion, and depth is the weakest axis in monocular pose estimation, so
     the direction would be genuinely ambiguous. A side lunge is unmistakable lateral
     displacement in image space. This is a game design decision, not a compromise. */
  lunge: {
    fireFrac: 0.55,        // fire at 55% of the calibrated full-lunge distance, while the
                           // outward velocity is still positive: waiting for the bottom
                           // would add 300-400ms to a control input
    fullSpan: 0.60,        // x shoulderWidth of displacement BEYOND the player's own stance
    kneeMax: 150,          // deg — the lunging leg has to actually bend
    hipShiftMin: 0.12,     // x shoulderWidth — the whole body commits, not just a foot
    neutralSpan: 0.22,     // x shoulderWidth beyond the neutral stance — inside this is home
    refractoryMs: 600,     // the return to neutral must not double-trigger
    minOutwardVel: 0.02,   // shoulderWidths per frame-ish, positive = still going out
    primary: ['ankleX','hipX'],
    secondary: ['knee'],
  },

  /* ---- jump — a control input, not a rep -------------------------------------------- */
  jump: {
    takeoffRise: 0.055,    // x legLength above the standing ankle line — fires here, at takeoff
    /* Multiples of `ankleAlt` that the takeoff rise must ALSO clear, so a running flight phase cannot
       fire a jump while a deliberate jump out of a run still can. 1.2 leaves 45% margin over the worst
       measured stride and still fires a real jump with 70% to spare — see the table in jump.js. */
    strideK: 1.2,
    bigRise: 0.13,         // x legLength — above this the game gets a full-height jump
    landRise: 0.020,       // x legLength — back below this counts as landed
    minUpVel: 0.004,       // per frame, must still be going up when it fires
    minAirMs: 140,
    maxAirMs: 1600,        // longer than this and the baseline was wrong; re-seed it
    /* Widened from 110ms once the landmarks were filtered. 110ms is under three frames at 25fps,
       which is faster than ANY adaptive filter can open its cutoff — so the big/small decision was
       being taken while the filter was still catching up, and a big jump got judged small. That is
       structural rather than a tuning miss: the window and the filter were racing.
       Waiting costs a slightly later height determination. Not waiting cost 21-30 PHANTOM jumps per
       20 seconds of standing still at realistic landmark noise. The trade is not close. */
    holdDecideMs: 260,     // how long to wait before judging whether it was a small jump
    refractoryMs: 420,
    /* the standing baseline follows you slowly, and asymmetrically: quick to follow the ankle
       line down (you moved, or it was mis-seeded) and very slow to follow it up, so it cannot
       creep upward during a jump and swallow the signal */
    baseTrackDown: 0.05, baseTrackUp: 0.004,
    /* ---- IS THIS HOP A DELIBERATE JUMP? ----------------------------------------------------
       Decided from the body, not from what the wall happens to be asking for. The old guard read
       `d.want`, which cannot work in general: exactly one rep machine steps per frame, so the jack
       machine's state is stale whenever the wall wants something else, and a player doing jacks
       while a squat wall was up got a spurious jump on every hop.

       Both numbers come from catching the body state on the exact frames a spurious jump fired:

         movement                     ankleSpan   msSinceProne
         a real jump                      0.796          60000
         a jumping jack's spread hop      1.326          60000
         a burpee's finishing hop         0.792            520

       A jack hops with the feet OUT, which is the whole shape of the exercise; a jump does not.
       And a burpee is the only movement that arrives at a hop straight off the floor. */
    spreadSpan: 1.15,      // x shoulderWidth between the ankles — wider than this is a jack's hop
    afterProneMs: 900,     // a hop this soon after lying down is a burpee finishing, not a jump
    /* And the jack's FIRST hop, where the feet are still together and every positional signal
       reads the same as a jump's. Measured at the emitting frame: a jack spreads at 2.21 shoulder
       widths per second, a jump at -0.02. The gate sits far from both. */
    spreadVel: 0.8,        // x shoulderWidth per second — feet flying apart, so this is a jack
  },

  /* ---- running in place: a RATE, not reps -------------------------------------------------
     Every threshold here is relative to the signal's own amplitude, for the same reason the rest of
     this file is: how far a foot appears to lift depends on the person, their effort and where the
     phone is sitting. See pose/run.js for the measurements these come from. */
  run: {
    /* Raised from 0.03/0.045 after MEASURING what noise does. A still body with realistic landmark
       jitter produced 47 phantom steps at 0.004 of noise and 89 at 0.012, with a reported cadence
       peak of 6.15 steps/s — the penguin sprinting while the player stands there. Smoothing removes
       most of that, but the remainder was almost entirely steps, because these two floors sat close
       enough to the noise to be crossed by it.
       There is room: a quiet real runner measured `ankleAlt` 0.107 at a 9cm knee lift, so 0.07 still
       leaves 1.5x of margin on the movement that matters. */
    minSplit: 0.05,        // floor on the step threshold, x legLength — stops noise counting
    thFrac: 0.50,          // step threshold as a fraction of `ankleAlt` (≈25% of peak-to-peak)
    rearmFrac: 0.40,       // fall back inside this fraction of the threshold to arm that side again
    minStepMs: 140,        // ~7 steps/s ceiling; faster is jitter, not footwork
    maxStepMs: 1200,       // no step for this long and you have stopped running
    cadTau: 0.22,          // s — smoothing on the reported cadence, so it drives without chatter
    /* Below this much alternation there is no running at all. Synthetic non-running movements all
       read exactly 0.000 because a synthetic body is symmetric; a real one is not, so THIS IS THE
       FIRST NUMBER TO CHECK AGAINST A REAL BODY. Running measured 0.107 at a 9cm knee lift and
       0.180 at 14cm, so there is room, but the floor of that range is only ~2x this gate. */
    altGate: 0.07,
  },

  /* ---- landmark smoothing ------------------------------------------------------------------
     A One Euro filter on the landmarks themselves. See pose/smooth.js for why it is adaptive rather
     than a fixed average: this project fires jumps at takeoff and drives the penguin from live pose
     specifically to avoid lag, and a constant heavy enough to kill jitter would hand all of that back.

     `fcMin` is the cutoff when a landmark is still — lower is smoother and laggier at rest. `beta`
     is how fast the cutoff opens with speed. Both are the standard knobs; these values are a
     starting point and the first thing to adjust if a real body still reads noisy. */
  smooth: {
    on: true,
    fcMin: 1.6,           // Hz — cutoff at rest
    /* Raised from 0.06 after measuring the cost. At 0.06 the filter lagged a jump's rise enough that
       the hold-decide window judged a BIG jump as small — dropping the hold 3 times mid-air on a jump
       that should keep it. That is precisely the latency this filter was supposed to avoid paying, so
       the cutoff has to open faster with speed. Fast movement is also far above the noise, so there is
       nothing to protect there. */
    beta: 0.9,
    /* Raised from the textbook 1.0. That value throttles how fast the filter LEARNS that motion has
       started, and a jump is the fastest thing the body does: at 1.0 the adaptive term was still
       catching up while the player was already airborne, so the hold-decide window judged a big jump
       as small and the forward drive collapsed mid-jump. Measured cost at 1.0 vs 4.0 below. */
    dCutoff: 4.0,         // Hz — cutoff on the derivative term
    /* VISIBILITY IS NOT SMOOTHED, and that was a mistake worth recording. The intent was to stop a
       confidence value flickering across a gate — but `trackOf` already solves that properly with
       `lostDwellMs`/`foundDwellMs` hysteresis, so this duplicated it, and averaging confidence
       UPWARD let a marginal framing setup pass the arms-overhead check it exists to fail. A framing
       check has to see the raw number: catching a clipped wrist is its entire job. */
    smoothVis: false,
    worldScale: 0.25,     // metric-frame speeds are numerically larger; put beta on one footing
  },

  /* ---- the measured noise floor ----------------------------------------------------------
     See `pose/noise.js`. This exists so a threshold can be stated as a multiple of THIS camera's
     jitter in THIS light rather than as an absolute that is generous on one phone and impossible on
     another. Every value here is about the measurement, not about any exercise. */
  noise: {
    on: true,
    windowMs: 4000,        // rolling window. 4s, not 2: sigma from 30 samples carries 13% error.
    assumedFps: 30,        // only sizes the ring; the real rate is whatever it turns out to be
    minSamples: 40,        // below this, report 0 rather than a figure nobody should trust
    /* The amplitude capture gets a lower bar than the rolling curvature figure, because it only has the
       A-pose to work with — about a second. A shorter window is a noisier estimate, which is acceptable
       here only because `capMul` bounds what a wrong answer can do. */
    minAmpSamples: 24,
    /* The floor is the MINIMUM of the rolling medians over this much history, sampled this often.
       Measured reason: slow movement leaves the median untouched (a 0.5Hz and a 1.0Hz squat both read
       1.00x) but a jumping jack's fast limb reversals inflate it 2.19x, and no statistic inside a 4s
       window can separate those from noise. Half a minute of history means any few quiet seconds pin
       the floor correctly, and a minimum can only err downward — which leaves a threshold where it
       was rather than making it spuriously strict. */
    floorMs: 30000,
    sampleMs: 1000,
    /* A gap this long breaks the difference run. Differencing across a dropout produces a spike that
       is not sensor noise and, being a median over a few seconds, would otherwise poison a whole
       window. */
    maxGapMs: 120,
    /* Multiples of measured sigma used as FLOORS under the fixed gates — never as replacements, so a
       quiet camera behaves exactly as it did before and only a noisy one gets stricter. Both of these
       gate amplitude on a differential signal, which is the most noise-exposed shape there is: the
       two ankles' errors add rather than cancel. */
    /* Multiples of the captured AMPLITUDE sigma (`cal.noiseAmp`), not of the curvature sigma. Each gate
       has to land in the gap between the noise's worst EXCURSION and the real signal's typical peak, so
       both ends were measured rather than assumed. Standing still for 20s, then running at 2.6 steps/s,
       at three landmark noise levels:

                    still max   running    worst/sigma   the k that fits
         ankleSplit   0.0753     0.1912       3.4          3.4 .. 8.5
         ankleAlt     0.0611     0.1386       1.4          1.4 .. 3.2      (at jitter 0.012)

       The two differ by more than 2x and one number for both was the mistake that broke this: at 4.5
       the alt gate landed at 0.196, ABOVE the 0.139 a running body actually produces, and cadence
       detection switched off at every noise level above quiet.

       Why they differ, since the underlying noise is identical: `ankleAlt` is an asymmetric-EMA
       MAGNITUDE — fast attack, slow decay — so it rectifies the noise and never sits near zero. A
       rectified signal's peak is a much smaller multiple of its own sigma than a zero-centred one's,
       which is a property of the statistic and not of the camera. */
    kAltGate: 2.2,
    kMinSplit: 5.0,
    /* Multiples of the curvature sigma that still counts as a motionless body, for deciding when the
       AMPLITUDE floors may be sampled at all. A still body sits near 2.26 by construction (a first
       difference has sqrt(2) the sigma, and a mean absolute value 0.798 of that, summed over x and y);
       4.0 leaves room for breathing without admitting a step. */
    stillK: 4.0,
    /* No noise-derived floor may exceed this multiple of the fixed threshold it sits under.

       1.4, not 3.0. The looser value was not a backstop at all: 3x on `run.altGate` is 0.21, and a body
       running in place only produces 0.11-0.13, so the "backstop" still permitted a gate that no real
       movement could clear — and that is exactly what happened to a player, whose running stopped
       working entirely after a contaminated capture. A bound has to be chosen against the SIGNAL it
       must not exclude, not as a round number. At 1.4 the worst case is 0.098 against a real 0.11-0.13,
       and the measured benefit at high noise survives: the gate needed to clear filtered noise at
       landmark sigma 0.012 was ~0.096, which fits underneath. */
    capMul: 1.4,
    /* What counts as a camera worth warning the player about, in normalised image units. Anchored to
       the injected levels the smoothing was tuned against: 0.004 produced nothing, 0.008 produced 21
       phantom jumps in 20 seconds unfiltered. */
    warnLm: 0.009,
  },

  /* ---- crouch: a CONTROL, not a rep ------------------------------------------------------
     Read from the STRAIGHTER knee, because running in place bends one knee at a time and locks the
     other out at 171-180 degrees while a crouch bends both. Measured separation is 65 degrees, so
     these thresholds sit in wide open space rather than being squeezed between two distributions.
     Hysteresis because this drives a duck: a control that chatters at its own threshold is worse
     than one that is slightly slow to release. */
  crouch: {
    enterKnee: 140,        // deg — straighter knee below this and you are crouching
    exitKnee: 152,         // deg — and back above this to stand up again
    minMs: 90,             // ms of holding it before it counts, so a stumble is not a duck
  },

  /* ---- 1: push-up — the hard one ----------------------------------------------------- */
  /* The phone is on the floor in FRONT of the player, angled up. That solves framing but not
     legibility: the torso points away from the lens, so the shoulder-to-hip vector projects
     to almost nothing and elbow flexion runs along the depth axis. So the primary signal is
     shoulder height above the floor, which is fully in-plane from a low front view. Elbow
     angle stays as a secondary gate for when the geometry does allow it.

     Every number here is deliberately loose. A push-up is the least legible of the five from
     this camera, so the failure that matters is a rep that does not register — not a sloppy rep
     that does. Only one rep machine runs at a time (see detector.js), chosen by the wall in
     front, which is what makes generosity affordable: there is no other exercise running that
     a loose threshold could leak into.

     Note that `downShoulder` / `upShoulder` no longer gate whether the machine can SEE a rep —
     pushup.js tracks the top of the plank off the body itself. They survive as one of two ways
     to prove depth, and as the phase's reference. See the note at the top of that file. */
  pushup: {
    torsoHorizMax: 46,     // deg from horizontal — you are prone, not standing. Generous because
                           // the world-space torso vector of a prone body is genuinely noisy,
                           // and a plank with the hips high still reads well past 34.
    downShoulder: 0.74,    // x shoulderWidth above the hands — default bottom
    upShoulder: 0.98,      // x shoulderWidth above the hands — default top
    dropMin: 0.12,         // x shoulderWidth of travel required between them. The vertical axis
                           // is the foreshortened one from a floor camera, so asking for a fifth
                           // of a shoulder width of it was asking for a rep nobody performs.
    elbowDown: 100,        // deg — secondary, used only when the elbow is legible
    elbowUp: 155,
    /* The body must SETTLE into the plank before a rep can start, and "settled" is a stability
       test rather than only a timer. Measured on synthetic bodies: across an entire push-up the
       torso's angular rate never exceeds 8 deg/s, while a burpee rotating into prone hits
       309, 265, 216, 172 on four consecutive frames. A gate at 45 separates them by 5x in both
       directions, and unlike a bare timer it is a property of the movement — a body PASSING
       THROUGH prone is rotating, a plank is not.
       This matters because a burpee's floor phase contains a genuine push-up, so with the wall
       asking for push-ups and the player doing burpees, timing alone is what stands between one
       exercise and the other. Costs an honest player nothing: it delays only the first rep after
       lying down, and they are lying down before they start. */
    minProneMs: 650,       // ms of SETTLED prone before a rep can start
    proneSettleRate: 45,   // deg/s of torso rotation above which the body is still moving into
                           // position, so the settle timer restarts
    minBottomMs: 70,
    minRepMs: 380,
    maxRepMs: 8000,
    /* How far back above the player's own tracked plank height counts as abandoning the descent
       rather than wobbling. Above 1.0 on purpose: sitting exactly at the top of your plank is the
       entry pose, not a failed rep. */
    abortUpMul: 1.04,
    primary: ['pushDepth','torsoHoriz'],
    secondary: ['elbowL','elbowR'],
  },

  /* ---- 3: burpee — an ordered chain, not a pose -------------------------------------- */
  burpee: {
    squatKnee: 128,        // deg
    floorTorsoHoriz: 46,   // deg from horizontal — same generosity as the push-up, same reason
    /* no image-space floor fallback: see the note in burpee.js — nothing measured against the
       ankle line survives a prone body facing a floor camera */
    jumpWristAbove: 0.05,  // x torsoLength above the head
    jumpAnkleRise: 0.045,  // x legLength above the standing baseline
    standTilt: 34,         // deg from vertical below which the torso counts as upright
    windowMs: 10000,       // the whole chain, or it resets to STAND with no rep. A real burpee
                           // performed by someone who is tired takes 5-7s, and the old 6s window
                           // was rejecting the back half of a set for being slow.
    minStageMs: 80,        // a stage that flickers past was not a stage
    returnGiveUpMs: 1500,  // stood up out of the return and stopped, without the jump
    jumpMaxMs: 900,        // arms stayed up after the hop — credit it rather than waiting forever
    /* the chain's stages mapped onto the phase the game's burpee pose expects, so the
       penguin is at the same point in the movement as the player */
    stagePhase: { STAND:0, SQUAT:0.18, FLOOR_DOWN:0.40, FLOOR_UP:0.52, RETURN:0.66, JUMP:0.86 },
    /* if the floor phase cannot be confirmed but squat and jump both fire in the right order
       and window, count the rep at a reduced form score rather than rejecting it */
    degradedForm: 0.6,
    primary: ['kneeL','kneeR'],
    secondary: ['torsoHoriz','wristY','ankleY'],
  },

  /* ---- the live pose mirror ----------------------------------------------------------
     A state machine cannot report a rep until it is sure one is happening, and being sure takes
     evidence, which takes time. That is correct for SCORING and wrong for the CHARACTER: it means
     the first third of every movement produces nothing on screen, which reads as the game not
     responding to you.

     So the character is driven from a second, stateless read of the same body — current depth,
     right now, no history and no commitment. It never counts a rep, never damages a wall and
     never rejects anything; it only says "this is the shape the player is in". The machine's
     phase still wins whenever the machine is running. This exists purely to close the gap
     before it starts. */
  live: {
    minW: 0.06,            // below this much depth the player is just standing: let them run
    /* the push-up's weight comes from torso angle rather than depth, because the penguin should
       be prone for the WHOLE exercise including the top of the rep */
    proneW: [62, 38],      // deg from horizontal: fully upright -> fully committed
  },

  /* ---- calibration ------------------------------------------------------------------- */
  calib: {
    frameHoldMs: 2000,     // continuous frames of good framing before onboarding proceeds
    aposeFrames: 30,       // a median over 30 frames, never a single frame
    rangeFrac: 0.65,       // personal threshold at 65% of the observed range
    /* auto-offer recalibration when the player is silently failing */
    rejectWindowMs: 60000,
    rejectRate: 0.40,
    /* thresholds may never be calibrated outside these bounds, in case a calibration rep
       is itself garbage */
    kneeBounds: [70, 150],
    /* bounds for the control fits, same purpose: a garbage acclimation must not make a control
       impossible or free */
    /* how much of each control has to be demonstrated before its step is satisfied */
    moveRunMs: 2200,       // ms at a committed pace
    moveHoldMs: 400,       // ms of holding a crouch
    moveCadFloor: 1.6,     // steps/s that counts as a committed pace rather than a shuffle
    moveTurnGate: 0.975,   // swRatio below which a turn is a real body turn, not a head turn
    moveCrouchGate: 150,   // deg on the straighter knee that counts as starting to crouch
    turnBounds: [0.80, 0.985],   // swRatio; nearer 1.0 means a smaller turn earns full steering
    cadBounds: [1.4, 4.5],       // steps/s
    crouchBounds: [110, 158],    // deg on the straighter knee
    jumpBounds: [0.06, 0.30],    // x legLength
    elbowBounds: [70, 150],
    shoulderYBounds: [0.30, 1.30],
    lungeSpanBounds: [0.30, 1.40],
  },
};

/* The visibility bar one exercise's landmarks must clear before a rep can count, and the lower
   bar below which we stop believing we can see the person at all. Both are per-exercise; asking
   for a single number was what made prone exercises unplayable. */
export const visGate = (key)=>
  CONFIG.common.visGateFor[key] !== undefined ? CONFIG.common.visGateFor[key]
                                              : CONFIG.common.visGate;
export const lostVis = (key)=>
  CONFIG.common.lostVisFor[key] !== undefined ? CONFIG.common.lostVisFor[key] : 0.25;

/* Personal thresholds live here after onboarding. Defaults mirror CONFIG so the detector is
   usable before calibration — badly, but usable, which matters for a first-run demo. */
export function defaultCalibration(){
  return {
    ready: false,
    shoulderW: 1, torsoLen: 1, legLen: 1,     // in whatever unit the frame source uses
    standHipY: 0, standAnkleY: 0, standShoulderY: 0,
    /* how wide the player naturally stands, half-span in shoulder widths. A lunge is measured
       as displacement BEYOND this, because feet at rest are already ~0.4 shoulder widths out
       and measuring from the hip centre would mean never returning to neutral. */
    standStanceHalf: 0.40,
    squatBottomKnee: CONFIG.squat.bottomKnee,
    pushupDownShoulder: CONFIG.pushup.downShoulder,
    pushupUpShoulder: CONFIG.pushup.upShoulder,
    pushupElbowDown: CONFIG.pushup.elbowDown,
    jackOpenSpan: CONFIG.jack.openAnkleSpan,
    jackCloseSpan: CONFIG.jack.closeAnkleSpan,
    lungeFullSpan: CONFIG.lunge.fullSpan,
    burpeeSquatKnee: CONFIG.burpee.squatKnee,
    /* ---- the free run's four CONTROLS, fitted by the MOVE acclimation stage --------------
       Defaults are population guesses, exactly like the exercise thresholds above, and exactly as
       wrong for any particular body. The turn one is the reason this stage exists: run-direction
       steering reads shoulder foreshortening against the player's own square-on width, and how far
       a given person turns while jogging on the spot is not something worth guessing. */
    /* THE MEASURED AMPLITUDE NOISE of the zero-centred channels, captured while the player held still
       during onboarding. Belongs here rather than on `body` because it is a property of this body in
       front of this camera in this room — exactly like every other value in this object — and because
       storing it here means it persists between sessions and travels inside a recorded trace for free.
       Empty until measured, and every gate keeps its fixed value until then. See `pose/noise.js`. */
    noiseAmp: null,
    swSquare: 0,                 // square-on shoulder width; 0 = not measured, fall back to live
    turnRatio: 0.94,             // swRatio at this player's comfortable turn — full steering there
    cadFull: CONFIG.run ? 3.0 : 3.0,   // steps/s that earns full throttle
    crouchKnee: CONFIG.crouch.enterKnee,
    jumpBig: CONFIG.jump.bigRise,
  };
}

/* Turn an observed [min,max] for one user into a threshold at rangeFrac of their own range,
   clamped so one bad calibration rep cannot make an exercise impossible or free.
   `dir` is -1 when smaller means deeper (knee, elbow, shoulder height) and +1 when larger
   means further (lunge span, ankle separation). */
export function fitThreshold(min, max, dir, bounds){
  const f = CONFIG.calib.rangeFrac;
  const v = dir < 0 ? max - (max - min)*f : min + (max - min)*f;
  return Math.min(bounds[1], Math.max(bounds[0], v));
}
