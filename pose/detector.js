/* =====================================================================================
   DETECTOR — owns the five machines, routes landmarks to whichever exercise is being asked
   for, and emits exactly the four events the game already speaks:

       laneChange(dir) | repProgress(kind, phase) | repCompleted(kind, form) | trackingState(s)

   The lunge machine always runs, because a lane change is a control input the player needs
   at any moment. Only one *rep* machine runs at a time, chosen by whatever the wall in front
   is asking for — there is no value in detecting a burpee while the wall wants squats, and
   running one machine instead of five removes a whole class of cross-talk false positives.

   Nothing in this file knows about three.js, the DOM, or the game. It takes landmark frames
   and produces events, which is what makes it testable without a camera or a browser.
   ===================================================================================== */

import { CONFIG, EX, defaultCalibration, visGate, lostVis } from './config.js';
import { makeFrame, adapt, NEEDS, minVisOf, visOf } from './landmarks.js';
import { makeBody, readBody } from './body.js';
import * as Squat from './squat.js';
import * as Jack from './jack.js';
import * as Pushup from './pushup.js';
import * as Burpee from './burpee.js';
import * as Lunge from './lunge.js';
import * as Jump from './jump.js';
import * as Run from './run.js';
import * as Crouch from './crouch.js';
import * as Smooth from './smooth.js';
import * as Record from './record.js';
import * as Noise from './noise.js';

export const TRACK = { GOOD:'good', DEGRADED:'degraded', LOST:'lost' };

const REP_MACHINES = {
  [EX.SQUAT]:  Squat,
  [EX.JACK]:   Jack,
  [EX.PUSHUP]: Pushup,
  [EX.BURPEE]: Burpee,
};
const NEED_KEY = {
  [EX.SQUAT]:'squat', [EX.JACK]:'jack', [EX.PUSHUP]:'pushup', [EX.BURPEE]:'burpee',
};

export function create(){
  const d = {
    frame: makeFrame(),
    body:  makeBody(),
    cal:   defaultCalibration(),
    mach: {
      [EX.SQUAT]:  Squat.create(),
      [EX.JACK]:   Jack.create(),
      [EX.PUSHUP]: Pushup.create(),
      [EX.BURPEE]: Burpee.create(),
    },
    lunge: Lunge.create(),
    jumpM: Jump.create(),
    runM:  Run.create(),
    crouchM: Crouch.create(),
    smooth: Smooth.create(33),
    /* the rolling noise floor. Always on: it costs two subtractions per landmark per frame, and
       having it always available is what lets a threshold be stated in multiples of it. */
    noiseM: Noise.create(),
    /* the trace recorder, off and unallocated until somebody asks for it — see record.js */
    rec: null,
    want: EX.JACK,              // which exercise the wall in front is asking for
    track: TRACK.GOOD,
    lastFrameT: -1e9, pushT: -1e9,
    /* dwell timers for the tracking state — see trackOf */
    lostT: 0, foundT: 0,
    /* reused every frame; the event surface allocates nothing */
    ev: { progress:false, phase:0, completed:false, form:1, reject:'', lane:0,
          jump:false, jumpHold:null, live:false, liveU:0, liveW:0,
          /* running in place publishes a RATE every frame, and `step` only on a footfall */
          cadence:0, step:false, crouch:false },
    stats: { frames:0, progress:0, completed:0, rejected:0, lanes:0, lost:0, jumps:0, live:0, steps:0 },
  };
  /* the noise sampler keeps `body.noise` current, so any machine can state a gate in multiples of
     measured jitter without a new parameter reaching it */
  Noise.bindFloors(d.noiseM, d.body.noise);
  return d;
}

export function setWant(d, kind){
  if (kind === d.want) return;
  /* leaving an exercise mid-rep abandons it rather than crediting it */
  const m = d.mach[d.want];
  if (m) m.reset();
  d.want = kind;
}

export function setCalibration(d, cal){ d.cal = cal; }

/* ---- trace recording -------------------------------------------------------------------
   Fitting a threshold to a real body needs the real body's numbers, and nothing in this layer
   could previously produce them: a session's landmarks existed for one frame and were then
   overwritten. `record.js` explains what is captured and why it is captured raw. */
export function startRecording(d, opts){
  if (d.rec) Record.clear(d.rec); else d.rec = Record.create(opts);
  d.rec.on = true;
  if (opts && opts.meta) d.rec.meta = opts.meta;
  if (opts && opts.note !== undefined) d.rec.note = opts.note;
  return d.rec;
}
export function stopRecording(d){ if (d.rec) d.rec.on = false; return d.rec; }
export function recording(d){ return !!(d.rec && d.rec.on); }
export function recStats(d){ return d.rec ? Record.stats(d.rec) : { frames:0, seconds:0, dropped:0, fps:0, bytes:0 }; }
export function recTrace(d){ return d.rec ? Record.toTrace(d.rec) : null; }
export function recClear(d){ if (d.rec) Record.clear(d.rec); }

/* ---- the measured noise floor ----------------------------------------------------------
   A snapshot of the rolling estimate. Allocates, so ask for it when something wants to display or
   store it rather than every frame. See `pose/noise.js` for what it means. */
export function noiseFloor(d){ return Noise.result(d.noiseM); }
export function noiseReset(d){ Noise.reset(d.noiseM); }
/* Capture the AMPLITUDE noise, which cannot be measured while the body moves — see noise.js. Arm it
   for a window in which the player has been asked to hold still, then read it out and store it on the
   calibration, where every other per-body measurement lives. */
export function armNoiseCapture(d){ Noise.armAmplitude(d.noiseM); }
export function endNoiseCapture(d){
  const cap = Noise.amplitudeCapture(d.noiseM);
  Noise.disarmAmplitude(d.noiseM);
  if (cap && d.cal) d.cal.noiseAmp = cap;
  return cap;
}
export function noiseCapturing(d){ return !!d.noiseM.ampArmed; }

/* ---- tracking state, from the landmarks the ACTIVE exercise needs, not all 33 ----------

   TRACK.LOST pauses the whole game, which makes this the most consequential number in the file
   and the one that was wrong. Two things were wrong about it:

     1. The LOST threshold was a single 0.25 for every exercise. Prone in front of a floor
        camera, hips sit behind your own shoulders and ankles are a body-length further from the
        lens, so the estimator's confidence in them genuinely collapses — correctly. Judging a
        push-up by the bar a standing squat clears meant the game paused itself in the middle of
        the exercise it had just asked for. It is now per-exercise.

     2. It had no hysteresis. One bad frame paused the world. Both directions now need to
        persist: slow to pause, quicker to resume, so a dropout has to be real.
*/
function rawTrackOf(d, tMs){
  if (!d.frame.valid || tMs - d.lastFrameT > CONFIG.common.staleMs) return TRACK.LOST;
  const key = NEED_KEY[d.want] || 'squat';
  const mn = minVisOf(d.frame, NEEDS[key]);
  const mean = visOf(d.frame, NEEDS[key]);
  if (mn < lostVis(key)) return TRACK.LOST;
  /* DEGRADED is judged against the same per-exercise bar the machine itself uses, mean bar
     included. Against the global 0.5 the chip read TRACKING PATCHY for the entire duration of
     every push-up — permanently on, and therefore meaningless. Riding the per-exercise number
     keeps the upright exercises at their original 0.7 and gives the prone ones a bar their own
     landmarks can actually clear. */
  if (mn < visGate(key) || mean < visGate(key) + 0.2) return TRACK.DEGRADED;
  return TRACK.GOOD;
}

function trackOf(d, tMs, dt){
  const raw = rawTrackOf(d, tMs);
  if (raw === TRACK.LOST){ d.lostT += dt; d.foundT = 0; }
  else { d.foundT += dt; d.lostT = 0; }

  if (d.track === TRACK.LOST){
    /* stay lost until we have had the body back for a moment, so recovery cannot strobe */
    return d.foundT >= CONFIG.common.foundDwellMs ? raw : TRACK.LOST;
  }
  if (raw === TRACK.LOST){
    /* not lost yet — report the softer state until the dropout has lasted long enough to be
       worth stopping the game for */
    return d.lostT >= CONFIG.common.lostDwellMs ? TRACK.LOST : TRACK.DEGRADED;
  }
  return raw;
}

/* ---- the whole pipeline for one inference result -----------------------------------------
   `res`  a MediaPipe PoseLandmarkerResult, or null when the detector found nobody
   `tMs`  the CAPTURE timestamp, stamped when the frame was grabbed, not when it arrived —
          every machine reasons in milliseconds, never in frame counts, so a variable
          inference rate cannot change what counts as a rep
   `sink` { laneChange, repProgress, repCompleted, poseLive, trackingState } — the game's contract

   The recorder brackets the real work rather than living inside it, because `pushCore` returns
   early on a lost body and on an unreadable one — and those are exactly the frames somebody
   reporting a dropout needs. Bracketing catches every path; a call placed at the end would omit
   the evidence. One branch on a null field when recording is off.
*/
export function push(d, res, tMs, sink){
  if (d.rec && d.rec.on){
    Record.input(d.rec, res, tMs);
    const ev = pushCore(d, res, tMs, sink);
    Record.output(d.rec, d, ev);
    return ev;
  }
  return pushCore(d, res, tMs, sink);
}

function pushCore(d, res, tMs, sink){
  const ev = d.ev;
  ev.progress = false; ev.phase = 0; ev.completed = false; ev.form = 1;
  ev.reject = ''; ev.lane = 0; ev.jump = false; ev.jumpHold = null;
  ev.live = false; ev.liveU = 0; ev.liveW = 0;
  ev.step = false;   /* ev.cadence is a level, not an edge, so it is NOT cleared here */

  adapt(d.frame, res, tMs);
  /* The noise floor is measured on the RAW landmarks, BEFORE the filter. The question it answers is
     what the CAMERA delivers; a figure taken after filtering would report the filter's residual and
     so could never tell you whether the filter is doing enough. This line's position relative to the
     next one is the whole meaning of the number. */
  if (CONFIG.noise.on) Noise.pushLandmarks(d.noiseM, d.frame, tMs);
  /* Smooth the LANDMARKS, once, before anything reads them. Every derived signal in this layer was
     already smoothed individually; the source they all share was not, so each consumer was fighting
     the same jitter separately and anything nobody had filtered passed it into a command. */
  Smooth.apply(d.smooth, d.frame);
  if (d.frame.valid) d.lastFrameT = tMs;
  d.stats.frames++;

  /* The dwell timers run on wall-clock between pushes, not on body.dtMs, because they have to
     keep counting through the frames where the body could not be read at all.

     Two different cases look alike here and must not be treated alike. The FIRST push has no
     previous timestamp at all: there is no elapsed time, and counting the sentinel gap as one
     would satisfy any dwell instantly and pause the game on frame one. A long REAL gap — a
     stalled pipeline, a tab resume — is the opposite: time genuinely passed and the body
     genuinely was not seen, which is exactly when the world should be paused. So the first push
     contributes nothing and everything else is clamped rather than discarded. */
  const first = d.pushT < -1e8;
  const gap = tMs - d.pushT;
  const dtPush = first || gap <= 0 ? 0 : Math.min(gap, 1000);
  d.pushT = tMs;

  const track = trackOf(d, tMs, dtPush);
  if (track !== d.track){
    d.track = track;
    if (track === TRACK.LOST) d.stats.lost++;
    if (sink && sink.trackingState) sink.trackingState(track);
  }
  if (track === TRACK.LOST || !d.frame.valid){
    /* freeze everything rather than reasoning about a body we cannot see */
    for (const k in d.mach) d.mach[k].reset();
    d.lunge.reset(); d.jumpM.reset(); d.runM.reset(); d.crouchM.reset();
    /* a stale cadence would keep driving the player forward while the camera cannot see them,
       which is the one failure worth being explicit about on this path */
    d.body.cadence = 0; d.body.running = false; ev.cadence = 0;
    d.body.crouching = false; ev.crouch = false;
    /* re-seed the filter: on the far side of a dropout the body may be somewhere else entirely,
       and a filter carrying its old state would glide across the gap and invent motion */
    Smooth.reset(d.smooth);
    return ev;
  }

  readBody(d.body, d.frame, d.cal);
  /* Channels are measured AFTER the filter, on purpose and for the opposite reason: a threshold is
     compared against the filtered value, so post-filter noise is what a threshold contends with. */
  if (CONFIG.noise.on) Noise.pushChannels(d.noiseM, d.body);
  if (!d.body.valid) return ev;

  /* THE CONTROLS ARE ALWAYS LIVE — lane changes, jumping, and running in place. None of them is
     a rep, none of them is gated on what the wall is asking for, and the player needs all three at
     any moment. Only the REP machines are exclusive.

     Running goes first because the jump arbitration below reads the same two ankles, and because
     `body.cadence` should be settled before anything downstream looks at it. */
  Run.step(d.runM, d.body, d.cal, ev);
  if (ev.step){
    d.stats.steps++;
    if (sink && sink.step) sink.step(d.runM.cadence);
  }
  if (sink && sink.cadence) sink.cadence(d.runM.cadence);
  /* Lateral position, reported every frame as a LEVEL. The free run steers by where the player is
     standing rather than by a gesture, so this is the raw offset and the game decides what centre
     it is relative to — the detector has no business knowing how wide the play area is. */
  if (sink && sink.steer) sink.steer(d.body.hipX);
  /* run direction: the shoulder ratio against the calibrated square-on width, plus the nose side.
     Both raw — the game owns the smoothing and the deadzone, as it does for `hipX`. */
  if (sink && sink.turn){
    const sq = d.cal && d.cal.swSquare > 0 ? d.cal.swSquare : 0;
    sink.turn(sq > 0 ? d.body.shoulderW/sq : 1, d.body.noseOff);
  }

  /* The crouch is a level rather than an edge, and it is published every frame including through a
     dropout, so the game always knows whether the player is currently down. */
  Crouch.step(d.crouchM, d.body, d.cal, ev);
  if (sink && sink.crouch) sink.crouch(ev.crouch);

  Lunge.step(d.lunge, d.body, d.cal, ev);
  if (ev.lane !== 0){
    d.stats.lanes++;
    if (sink && sink.laneChange) sink.laneChange(ev.lane);
  }

  /* Jumping is always live too — except while a rep that CONTAINS a hop is in flight. A
     jumping jack hops on every rep and a burpee ends with a jump, so letting the jump
     detector EMIT through those would make the penguin leap in the middle of a rep it is
     already busy performing.

     It still runs, though. Suppressing the events is not the same as suppressing the machine:
     the burpee reads `body.jumpRise` to see its own finishing hop, and a baseline that stopped
     updating for the duration of every burpee would be stale exactly when it is needed. */
  const hoppy = d.want === EX.JACK || d.want === EX.BURPEE;
  const midRep = hoppy && d.mach[d.want] &&
                 d.mach[d.want].state !== 'IDLE' && d.mach[d.want].state !== 'CLOSED' &&
                 d.mach[d.want].state !== 'STAND';
  /* `midRep` is right when it fires and structurally cannot fire often enough: exactly one rep
     machine steps per frame (see below), so the jack machine's state is stale whenever the wall
     wants something else — and a jack BEGINS in CLOSED, so even the wanted case leaks the first hop
     of every rep. Both holes are the same mistake, which is deciding from INTENT rather than from
     the body. These two read the body and so hold whatever the wall is asking for.
     Running in place needs no gate here at all: `jump.js` measures the LOWER ankle, so a movement
     that always keeps a foot down never looks airborne in the first place. That is what leaves a
     deliberate jump mid-run still detectable. */
  const B = d.body;
  const spreadFooted = B.ankleSpan > CONFIG.jump.spreadSpan ||
                       B.ankleSpanVel > CONFIG.jump.spreadVel;
  const justOnFloor  = B.msSinceProne < CONFIG.jump.afterProneMs;
  Jump.step(d.jumpM, d.frame, d.body, d.cal, ev,
            !midRep && !spreadFooted && !justOnFloor);
  if (ev.jump){
    d.stats.jumps++;
    if (sink && sink.jump) sink.jump();
  }
  if (ev.jumpHold !== null && sink && sink.jumpHold) sink.jumpHold(ev.jumpHold);

  /* exactly one rep machine runs */
  const M = REP_MACHINES[d.want];
  if (M){
    M.step(d.mach[d.want], d.body, d.cal, ev);
    if (ev.progress){
      d.stats.progress++;
      if (sink && sink.repProgress) sink.repProgress(d.want, ev.phase);
    }
    if (ev.completed){
      d.stats.completed++;
      if (sink && sink.repCompleted) sink.repCompleted(d.want, ev.form);
    }
    if (ev.reject){
      d.stats.rejected++;
      if (sink && sink.repRejected) sink.repRejected(d.want, ev.reject);
    }
    /* THE LIVE MIRROR. Only when the machine is not already reporting a phase, so the machine
       stays authoritative and these two can never fight over the penguin. This is what makes the
       character respond to the START of a movement instead of to a recognised rep: the machine
       needs evidence before it will commit, and gathering evidence takes time the player reads
       as the game ignoring them. Drives the pose only — never a rep, never wall damage. */
    if (!ev.progress && M.livePhase){
      const lv = M.livePhase(d.mach[d.want], d.body, d.cal);
      if (lv && lv.w > CONFIG.live.minW){
        ev.live = true; ev.liveU = lv.u; ev.liveW = lv.w;
        d.stats.live++;
        if (sink && sink.poseLive) sink.poseLive(d.want, lv.u, lv.w);
      }
    }
  }
  return ev;
}

/* the debug overlay wants all of this, and it is the only honest way to tune thresholds */
export function debugState(d){
  const b = d.body, m = d.mach[d.want];
  return {
    want: d.want, track: d.track,
    state: m ? m.state : '-', phase: m ? +m.phase.toFixed(3) : 0,
    lungeState: d.lunge.state, refractory: Math.round(d.lunge.refractory),
    jumpState: d.jumpM.state, jumpRise: +d.jumpM.prevRise.toFixed(3), jumps: d.jumpM.jumps,
    live: d.ev.live, liveU: +d.ev.liveU.toFixed(3), liveW: +d.ev.liveW.toFixed(2),
    lostT: Math.round(d.lostT), pushDepth: +b.pushDepth.toFixed(3),
    /* the push-up's own tracked plank height and settle clock. These are what you look at when
       a push-up is not registering, and the whole reason the old absolute thresholds were
       impossible to diagnose from the outside. */
    rest: +((m && m.rest) || 0).toFixed(3), proneT: Math.round((m && m.proneT) || 0),
    knee: +b.knee.toFixed(1), elbow: +b.elbow.toFixed(1),
    torsoTilt: +b.torsoTilt.toFixed(1), torsoHoriz: +b.torsoHoriz.toFixed(1),
    shoulderY: +b.shoulderY.toFixed(3), ankleSpan: +b.ankleSpan.toFixed(3),
    hipDrop: +b.hipDrop.toFixed(3), hipX: +b.hipX.toFixed(3),
    vis: +b.visMin[NEED_KEY[d.want] || 'squat'].toFixed(2),
    reps: m ? m.reps : 0, stats: d.stats,
  };
}
