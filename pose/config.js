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
  },

  /* ---- 0: squat — second most reliable from a front camera --------------------------- */
  squat: {
    standKnee: 160,        // deg — the entry state. A rep that never started from standing
                           //       is not a rep, so this gate is load-bearing.
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

  /* ---- 1: push-up — the hard one ----------------------------------------------------- */
  /* The phone is on the floor in FRONT of the player, angled up. That solves framing but not
     legibility: the torso points away from the lens, so the shoulder-to-hip vector projects
     to almost nothing and elbow flexion runs along the depth axis. So the primary signal is
     shoulder height above the floor, which is fully in-plane from a low front view. Elbow
     angle stays as a secondary gate for when the geometry does allow it. */
  pushup: {
    torsoHorizMax: 34,     // deg from horizontal — you are prone, not standing
    downShoulder: 0.62,    // x shoulderWidth above the hands — default bottom
    upShoulder: 1.00,       // x shoulderWidth above the hands — default top
    dropMin: 0.22,         // x shoulderWidth of travel required between them
    elbowDown: 100,        // deg — secondary, used only when the elbow is legible
    elbowUp: 155,
    minProneMs: 400,       // the body must settle into the position before a rep can start
    minBottomMs: 150,
    minRepMs: 600,
    maxRepMs: 6000,
    primary: ['pushDepth','torsoHoriz'],
    secondary: ['elbowL','elbowR'],
  },

  /* ---- 3: burpee — an ordered chain, not a pose -------------------------------------- */
  burpee: {
    squatKnee: 120,        // deg
    floorTorsoHoriz: 34,   // deg from horizontal
    /* no image-space floor fallback: see the note in burpee.js — nothing measured against the
       ankle line survives a prone body facing a floor camera */
    jumpWristAbove: 0.05,  // x torsoLength above the head
    jumpAnkleRise: 0.05,   // x legLength above the standing baseline
    standTilt: 25,         // deg from vertical below which the torso counts as upright
    windowMs: 6000,        // the whole chain, or it resets to STAND with no rep
    minStageMs: 90,        // a stage that flickers past was not a stage
    /* the chain's stages mapped onto the phase the game's burpee pose expects, so the
       penguin is at the same point in the movement as the player */
    stagePhase: { STAND:0, SQUAT:0.18, FLOOR_DOWN:0.40, FLOOR_UP:0.52, RETURN:0.66, JUMP:0.86 },
    /* if the floor phase cannot be confirmed but squat and jump both fire in the right order
       and window, count the rep at a reduced form score rather than rejecting it */
    degradedForm: 0.6,
    primary: ['kneeL','kneeR'],
    secondary: ['torsoHoriz','wristY','ankleY'],
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
