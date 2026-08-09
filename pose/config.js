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
    bigRise: 0.13,         // x legLength — above this the game gets a full-height jump
    landRise: 0.020,       // x legLength — back below this counts as landed
    minUpVel: 0.004,       // per frame, must still be going up when it fires
    minAirMs: 140,
    maxAirMs: 1600,        // longer than this and the baseline was wrong; re-seed it
    holdDecideMs: 110,     // how long to wait before judging whether it was a small jump
    refractoryMs: 420,
    /* the standing baseline follows you slowly, and asymmetrically: quick to follow the ankle
       line down (you moved, or it was mis-seeded) and very slow to follow it up, so it cannot
       creep upward during a jump and swallow the signal */
    baseTrackDown: 0.05, baseTrackUp: 0.004,
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
