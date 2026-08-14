/* =====================================================================================
   CALIBRATION — the difference between an app that works for everyone and an app that works
   for whoever it was tuned on.

   Four stages, in order:

     1. FRAME    both ankles, both wrists and both hips above the visibility bar for two
                 continuous seconds, with live specific guidance. Nobody starts with their
                 feet cut off.
     2. APOSE    shoulder width, torso length, leg length, standing hip/ankle/shoulder
                 heights — as a 30-frame MEDIAN, never a single frame.
     3. REPS     one calibration rep of each exercise, recording the observed min and max of
                 that exercise's primary signal for this specific person.
     4. FIT      personal thresholds at 65% of the observed range, clamped, never at textbook
                 angles.

   Stage 3 is where the accessibility of the whole app is decided. Textbook joint angles are
   wrong twice over: wrong for a particular body, and wrong for the estimator, which carries
   systematic offsets on the order of 15 degrees in peak knee angle against motion-capture
   ground truth. Somebody whose deepest squat reads 110 degrees still gets to play the game.

   The framing check runs in the TALLEST pose the session will contain — arms overhead — not
   standing. From a floor-mounted camera a person who fits standing can still have their
   wrists clipped at the top of a jumping jack, and discovering that on the first wall rather
   than during onboarding is the whole failure this stage exists to prevent.

   The camera's geometry ends up baked into these numbers, not just the body's. That is fine
   and it is why calibration matters even more from a floor placement than a chest-height one
   — but it means the thresholds are only valid at the distance and tilt they were taken at,
   so `driftOf()` exists to notice when someone has wandered.
   ===================================================================================== */

import { CONFIG, defaultCalibration, fitThreshold, EX } from './config.js';
import { LM, NEEDS, minVisOf } from './landmarks.js';
import { median } from './body.js';

const K = CONFIG.calib;

export const STAGE = { IDLE:'idle', FRAME:'frame', APOSE:'apose',
                       MOVE:'move', REPS:'reps', DONE:'done' };

/* ---- THE ACCLIMATION STAGE ----------------------------------------------------------------
   The free run is driven by four controls rather than by reps, and every threshold behind them was
   a population guess. This stage asks for each one and fits it, which is the same argument the REPS
   stage already makes for the exercises: a textbook number is wrong twice over, once for the body
   and once for the estimator.

   The turn step is the one that justifies the whole stage. Run-direction steering reads shoulder
   foreshortening against the player's own square-on width — measured, a 15 degree turn gives a
   shoulder ratio of 0.955 while a head-only turn leaves it at exactly 1.000, which is what makes the
   signal usable at all — and how far a particular person turns while jogging on the spot is not
   something worth guessing at.

   Square-on needs no step of its own: the A-pose is already square-on and already medians the
   shoulder width over 30 frames, so `cal.shoulderW` IS the baseline. */
export const MOVE_STEPS = ['run', 'turn', 'jump', 'crouch'];

export const MOVE_PROMPT = {
  run:    ['RUN IN PLACE', 'a pace you could hold for a few minutes'],
  turn:   ['TURN LEFT, THEN RIGHT', 'keep jogging — turn as if rounding a corner'],
  jump:   ['JUMP', 'both feet off the floor'],
  crouch: ['CROUCH', 'as low as you would go to duck under something'],
};

export function create(){
  return {
    stage: STAGE.IDLE,
    cal: defaultCalibration(),
    frameHeldMs: 0,
    guidance: '', guideT: 0, frameOk: false,
    samples: { shoulderW:[], torsoLen:[], legLen:[], hipY:[], ankleY:[], shoulderY:[], stance:[] },
    /* per-exercise observed extremes for this person */
    obs: {},
    exOrder: [EX.JACK, EX.SQUAT, EX.LUNGE_R, EX.PUSHUP, EX.BURPEE],
    exIdx: 0,
    /* the acclimation stage: which controls to teach, where we are, and what has been seen */
    mvOrder: [], mvIdx: 0, mv: null, mvHeldMs: 0,
    /* rolling rejection tracking, for auto-offering a recalibration later */
    recent: [], recentT: 0,
    reset(){
      this.stage = STAGE.IDLE; this.cal = defaultCalibration();
      this.frameHeldMs = 0; this.guidance = ''; this.guideT = 0; this.frameOk = false;
      this.exIdx = 0;
      this.mvIdx = 0; this.mv = null; this.mvHeldMs = 0;
      for (const k in this.samples) this.samples[k].length = 0;
      this.obs = {};
      this.recent.length = 0; this.recentT = 0;
    },
  };
}

/* Which exercises to teach, chosen by the game rather than fixed here — a run restricted to
   squats should not make the player perform a calibration burpee for a wall that will never ask
   for one. `reset()` deliberately does not touch `exOrder`, so a mode set before calibration
   survives into it; this is the only thing that should ever change the list.
   Empty or missing input falls back to the full set rather than to nothing, because a calibration
   that teaches no exercises would leave every threshold at its population default while claiming
   to be personal — worse than obviously not having calibrated. */
export function setExOrder(c, order){
  c.exOrder = (order && order.length) ? order.slice()
                                      : [EX.JACK, EX.SQUAT, EX.LUNGE_R, EX.PUSHUP, EX.BURPEE];
  c.exIdx = 0;
}

/* Which controls to acclimate. An empty list skips the stage entirely, which is what lane mode
   wants — it steers by lunging and has no cadence, so there is nothing to teach. */
export function setMoveOrder(c, order){
  c.mvOrder = (order && order.length) ? order.slice() : [];
  c.mvIdx = 0; c.mv = null;
}

export function begin(c){ c.reset(); c.stage = STAGE.FRAME; }

/* ---- stage 1: framing, with guidance specific enough to act on -------------------------- */
export const holdMs = ()=> CONFIG.calib.frameHoldMs;

/* `wasOk` widens every threshold slightly once you are already passing. Without it, a body
   sitting right on a boundary flips ok/not-ok every inference frame and the guidance text
   strobes between the specific message and the default — which reads as the screen flickering
   rather than as feedback. */
export function checkFraming(frame, body, wasOk){
  const g = [];
  const h = wasOk ? 1 : 0;                      // hysteresis, applied per threshold below
  const vis = (i)=> frame.img[i].v;
  const lowAnkle = Math.min(vis(LM.ANKLE_L), vis(LM.ANKLE_R));
  const lowWrist = Math.min(vis(LM.WRIST_L), vis(LM.WRIST_R));
  const lowHip   = Math.min(vis(LM.HIP_L), vis(LM.HIP_R));
  const bar = CONFIG.common.visGateFrame - h*0.10;

  if (lowAnkle < bar) g.push('STEP BACK — WE CANNOT SEE YOUR FEET');
  if (lowWrist < bar) g.push('RAISE YOUR ARMS — WE NEED TO SEE YOUR HANDS');
  if (lowHip < bar)   g.push('STEP BACK');
  /* out of frame sideways: the hips have drifted off centre in image space */
  if (Math.abs(body.hipX) > 1.6 + h*0.25) g.push(body.hipX < 0 ? 'MOVE RIGHT' : 'MOVE LEFT');
  /* too close: the body fills the frame, so the head or hands will clip when you reach up */
  if (body.torsoLen > 0.42 + h*0.03) g.push('STEP BACK');
  if (body.torsoLen < 0.10 - h*0.015) g.push('COME CLOSER');
  /* the head near the top of frame from a low camera means the phone is tilted too flat */
  if (frame.img[LM.NOSE].y > 0.96 + h*0.02) g.push('TILT THE PHONE BACK A LITTLE');

  return { ok: g.length === 0, guidance: g[0] || '' };
}

/* A message stays put for a beat before another can replace it. Two conditions taking turns
   at the boundary would otherwise swap the text faster than anyone can read it. */
const GUIDE_HOLD_MS = 700;
function setGuidance(c, text, dt){
  c.guideT = (c.guideT || 0) + dt;
  if (text === c.guidance) return;
  if (c.guidance && c.guideT < GUIDE_HOLD_MS) return;   // let the current one finish being read
  c.guidance = text; c.guideT = 0;
}

/* ---- the driver: feed it every body, it walks itself through the stages ----------------- */
export function step(c, frame, body, ev){
  if (!body.valid) return;
  const dt = body.dtMs;

  if (c.stage === STAGE.FRAME){
    /* judged with the arms up, because that is the tallest the session ever gets */
    const r = checkFraming(frame, body, c.frameOk);
    c.frameOk = r.ok;
    setGuidance(c, r.guidance, dt);
    c.frameHeldMs = r.ok ? c.frameHeldMs + dt : 0;
    if (c.frameHeldMs >= K.frameHoldMs){
      c.stage = STAGE.APOSE; c.guidance = 'HOLD STILL, ARMS OUT';
      for (const k in c.samples) c.samples[k].length = 0;
    }
    return;
  }

  if (c.stage === STAGE.APOSE){
    c.samples.shoulderW.push(body.shoulderW);
    c.samples.torsoLen.push(body.torsoLen);
    c.samples.legLen.push(body.legLen);
    c.samples.hipY.push(body.hipY);
    c.samples.ankleY.push(body.ankleY);
    c.samples.shoulderY.push(body.shoulderY);
    c.samples.stance.push(Math.max(-body.ankleLX, body.ankleRX));
    if (c.samples.shoulderW.length >= K.aposeFrames){
      const cal = c.cal;
      cal.shoulderW = median(c.samples.shoulderW);
      cal.torsoLen  = median(c.samples.torsoLen);
      cal.legLen    = median(c.samples.legLen);
      cal.standHipY      = median(c.samples.hipY);
      cal.standAnkleY    = median(c.samples.ankleY);
      cal.standShoulderY = median(c.samples.shoulderY);
      cal.standStanceHalf = median(c.samples.stance);
      /* acclimate the CONTROLS before the exercises, when there are any to teach. The controls are
         what the player will be using every second; the reps only matter when a wall arrives. */
      if (c.mvOrder.length){
        c.stage = STAGE.MOVE; c.mvIdx = 0; c.guidance = '';
        startMove(c);
      } else {
        c.stage = STAGE.REPS; c.exIdx = 0;
        c.guidance = '';
        startEx(c, c.exOrder[0]);
      }
    }
    return;
  }

  if (c.stage === STAGE.MOVE){
    stepMove(c, body, ev);
    return;
  }

  if (c.stage === STAGE.REPS){
    const kind = c.exOrder[c.exIdx];
    observe(c, kind, body);
    /* the caller advances on a completed rep, since the machines own rep detection */
    return;
  }
}

/* ---- the acclimation stage ---------------------------------------------------------------- */

function startMove(c){
  c.mvHeldMs = 0;
  c.mv = { key: c.mvOrder[c.mvIdx], n: 0, done: false,
           /* run */    cadPeak: 0, cadMs: 0,
           /* turn */   leftMin: 1, rightMin: 1, seenL: false, seenR: false,
           /* jump */   risePeak: 0, jumps: 0,
           /* crouch */ kneeMin: 180 };
}

/* Progress, 0..1, so the player can see the step filling rather than guessing whether it heard
   them. Each step defines its own notion of "enough". */
export function moveProgress(c){
  const m = c.mv;
  if (!m) return 0;
  if (m.key === 'run')    return Math.min(1, m.cadMs/K.moveRunMs);
  if (m.key === 'turn')   return ((m.seenL?0.5:0) + (m.seenR?0.5:0));
  if (m.key === 'jump')   return Math.min(1, m.jumps/1);
  if (m.key === 'crouch') return Math.min(1, c.mvHeldMs/K.moveHoldMs);
  return 0;
}

/* Watch the body through one acclimation step, and advance when it has been demonstrated.
   Everything here reads signals that already exist — the point of the stage is to record the
   player's own range for them, not to detect anything new. */
function stepMove(c, body, ev){
  const m = c.mv;
  if (!m) { startMove(c); return; }
  const dt = body.dtMs;
  m.n++;

  if (m.key === 'run'){
    m.cadPeak = Math.max(m.cadPeak, body.cadence || 0);
    /* time spent at a committed pace, not merely moving — a shuffle should not set `cadFull` */
    if ((body.cadence || 0) > K.moveCadFloor) m.cadMs += dt; else m.cadMs = Math.max(0, m.cadMs - dt);
    if (m.cadMs >= K.moveRunMs) moveDone(c);
    return;
  }

  if (m.key === 'turn'){
    /* Shoulder foreshortening against the A-pose's square-on width gives the MAGNITUDE; the nose
       offset gives the SIDE. Both in-plane. Measured: a body turn takes the ratio to 0.879 while a
       head-only turn leaves it at exactly 1.000, which is why the ratio and not the nose is what
       decides whether a turn happened at all. */
    const sq = c.cal.shoulderW > 0 ? c.cal.shoulderW : body.shoulderW;
    const ratio = body.shoulderW/Math.max(1e-6, sq);
    if (ratio < K.moveTurnGate){
      if (body.noseOff < 0){ m.leftMin  = Math.min(m.leftMin,  ratio); m.seenL = true; }
      else                 { m.rightMin = Math.min(m.rightMin, ratio); m.seenR = true; }
    }
    if (m.seenL && m.seenR) moveDone(c);
    return;
  }

  if (m.key === 'jump'){
    m.risePeak = Math.max(m.risePeak, body.jumpRise || 0);
    if (ev && ev.jump) m.jumps++;
    if (m.jumps >= 1) moveDone(c);
    return;
  }

  if (m.key === 'crouch'){
    m.kneeMin = Math.min(m.kneeMin, body.kneeStraight);
    /* hold it, so a stumble mid-stride is not recorded as this player's duck depth */
    if (body.kneeStraight < K.moveCrouchGate) c.mvHeldMs += dt;
    else c.mvHeldMs = Math.max(0, c.mvHeldMs - dt);
    if (c.mvHeldMs >= K.moveHoldMs) moveDone(c);
    return;
  }
}

/* fit what this step observed, then move on — or fall through to the exercises */
function moveDone(c){
  fitMove(c);
  c.mvIdx++;
  c.mvHeldMs = 0;
  if (c.mvIdx < c.mvOrder.length){ startMove(c); return false; }
  c.mv = null;
  if (c.exOrder.length){ c.stage = STAGE.REPS; c.exIdx = 0; startEx(c, c.exOrder[0]); return false; }
  c.cal.ready = true; c.stage = STAGE.DONE;
  return true;
}

/* A step could not be demonstrated at all — skip rather than trapping the player in onboarding,
   and leave that control's population default in place. Same contract as `skipEx`. */
export function skipMove(c){
  if (c.stage !== STAGE.MOVE) return false;
  c.mvIdx++;
  c.mvHeldMs = 0;
  if (c.mvIdx < c.mvOrder.length){ startMove(c); return false; }
  c.mv = null;
  if (c.exOrder.length){ c.stage = STAGE.REPS; c.exIdx = 0; startEx(c, c.exOrder[0]); return false; }
  c.cal.ready = true; c.stage = STAGE.DONE;
  return true;
}

/* Every fit is clamped, for the same reason the exercise fits are: one bad acclimation must not be
   able to make a control impossible or free. */
function fitMove(c){
  const m = c.mv, cal = c.cal, B = K;
  if (!m) return;
  const cl = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));

  if (m.key === 'run' && m.cadPeak > 0){
    /* full throttle a little UNDER their demonstrated pace, so the pace they showed is comfortably
       full rather than only just reaching it */
    cal.cadFull = cl(m.cadPeak*0.90, B.cadBounds[0], B.cadBounds[1]);
  }
  if (m.key === 'turn'){
    cal.swSquare = c.cal.shoulderW;
    const deepest = Math.min(m.leftMin, m.rightMin);
    if (deepest < 1){
      /* full steering at 65% of the turn they actually showed, matching `rangeFrac` elsewhere */
      cal.turnRatio = cl(1 - (1 - deepest)*B.rangeFrac, B.turnBounds[0], B.turnBounds[1]);
    }
  }
  if (m.key === 'jump' && m.risePeak > 0){
    cal.jumpBig = cl(m.risePeak*B.rangeFrac, B.jumpBounds[0], B.jumpBounds[1]);
  }
  if (m.key === 'crouch' && m.kneeMin < 180){
    /* between standing and their deepest, so a partial duck registers */
    cal.crouchKnee = cl(m.kneeMin + (165 - m.kneeMin)*(1 - B.rangeFrac),
                        B.crouchBounds[0], B.crouchBounds[1]);
  }
}

function startEx(c, kind){
  c.obs[kind] = { kneeMin:180, kneeMax:0, shoulderMin:9, shoulderMax:0,
                  spanMin:9, spanMax:0, elbowMin:180, lungeMax:0, n:0 };
}

/* record the extremes of whatever this exercise's primary signal is */
export function observe(c, kind, body){
  const o = c.obs[kind] || (c.obs[kind] = {}, startEx(c, kind), c.obs[kind]);
  o.n++;
  o.kneeMin = Math.min(o.kneeMin === undefined ? 180 : o.kneeMin, body.knee);
  o.kneeMax = Math.max(o.kneeMax || 0, body.knee);
  o.shoulderMin = Math.min(o.shoulderMin === undefined ? 9 : o.shoulderMin, body.pushDepth);
  o.shoulderMax = Math.max(o.shoulderMax || 0, body.pushDepth);
  o.spanMin = Math.min(o.spanMin === undefined ? 9 : o.spanMin, body.ankleSpan);
  o.spanMax = Math.max(o.spanMax || 0, body.ankleSpan);
  o.elbowMin = Math.min(o.elbowMin === undefined ? 180 : o.elbowMin, body.elbow);
  o.lungeMax = Math.max(o.lungeMax || 0, Math.max(-body.ankleLX, body.ankleRX));
}

/* the calibration rep for the current exercise landed: fit its thresholds and move on */
export function repDone(c){
  if (c.stage !== STAGE.REPS) return false;
  const kind = c.exOrder[c.exIdx];
  fitOne(c, kind);
  c.exIdx++;
  if (c.exIdx >= c.exOrder.length){
    c.cal.ready = true;
    c.stage = STAGE.DONE;
    return true;
  }
  startEx(c, c.exOrder[c.exIdx]);
  return false;
}

/* the current exercise could not be registered at all — skip it rather than trapping the
   player in onboarding, and leave its defaults in place */
export function skipEx(c){
  if (c.stage !== STAGE.REPS) return false;
  c.exIdx++;
  if (c.exIdx >= c.exOrder.length){ c.cal.ready = true; c.stage = STAGE.DONE; return true; }
  startEx(c, c.exOrder[c.exIdx]);
  return false;
}

function fitOne(c, kind){
  const o = c.obs[kind], cal = c.cal;
  if (!o || !o.n) return;
  if (kind === EX.SQUAT){
    cal.squatBottomKnee = fitThreshold(o.kneeMin, o.kneeMax, -1, K.kneeBounds);
  } else if (kind === EX.PUSHUP){
    cal.pushupDownShoulder = fitThreshold(o.shoulderMin, o.shoulderMax, -1, K.shoulderYBounds);
    cal.pushupUpShoulder   = Math.max(cal.pushupDownShoulder + 0.20, o.shoulderMax*0.92);
    if (o.elbowMin < 170) cal.pushupElbowDown = fitThreshold(o.elbowMin, 175, -1, K.elbowBounds);
  } else if (kind === EX.JACK){
    cal.jackOpenSpan  = fitThreshold(o.spanMin, o.spanMax, +1, [0.9, 2.6]);
    cal.jackCloseSpan = Math.min(cal.jackOpenSpan*0.65, o.spanMin*1.35);
  } else if (kind === EX.LUNGE_L || kind === EX.LUNGE_R){
    /* the calibrated span is displacement beyond the resting stance, matching how the lunge
       machine measures it */
    cal.lungeFullSpan = Math.min(K.lungeSpanBounds[1],
                        Math.max(K.lungeSpanBounds[0], o.lungeMax - cal.standStanceHalf));
  } else if (kind === EX.BURPEE){
    cal.burpeeSquatKnee = fitThreshold(o.kneeMin, o.kneeMax, -1, K.kneeBounds);
  }
}

/* ---- has the player wandered away from where they calibrated? -------------------------- */
/* The thresholds carry the camera geometry, so they are only valid near the distance they
   were taken at. Image-space torso length is the cheapest proxy for distance. */
export function driftOf(c, body){
  if (!c.cal.ready || !c.cal.torsoLen) return 0;
  return body.torsoLen/c.cal.torsoLen - 1;
}
export function driftGuidance(c, body){
  const d = driftOf(c, body);
  if (d > 0.22) return 'STEP BACK TO YOUR SPOT';
  if (d < -0.20) return 'COME FORWARD TO YOUR SPOT';
  return '';
}

/* ---- rescue a player who is silently failing ------------------------------------------- */
/* Someone quietly failing reps must be rescued, not left to conclude the app is broken. */
export function noteOutcome(c, accepted, tMs){
  c.recent.push({ ok: !!accepted, t: tMs });
  while (c.recent.length && tMs - c.recent[0].t > K.rejectWindowMs) c.recent.shift();
}
export function shouldRecalibrate(c){
  if (c.recent.length < 6) return false;
  let bad = 0;
  for (const r of c.recent) if (!r.ok) bad++;
  return bad/c.recent.length > K.rejectRate;
}
