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
  return {
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
    want: EX.JACK,              // which exercise the wall in front is asking for
    track: TRACK.GOOD,
    lastFrameT: -1e9, pushT: -1e9,
    /* dwell timers for the tracking state — see trackOf */
    lostT: 0, foundT: 0,
    /* reused every frame; the event surface allocates nothing */
    ev: { progress:false, phase:0, completed:false, form:1, reject:'', lane:0,
          jump:false, jumpHold:null, live:false, liveU:0, liveW:0 },
    stats: { frames:0, progress:0, completed:0, rejected:0, lanes:0, lost:0, jumps:0, live:0 },
  };
}

export function setWant(d, kind){
  if (kind === d.want) return;
  /* leaving an exercise mid-rep abandons it rather than crediting it */
  const m = d.mach[d.want];
  if (m) m.reset();
  d.want = kind;
}

export function setCalibration(d, cal){ d.cal = cal; }

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
*/
export function push(d, res, tMs, sink){
  const ev = d.ev;
  ev.progress = false; ev.phase = 0; ev.completed = false; ev.form = 1;
  ev.reject = ''; ev.lane = 0; ev.jump = false; ev.jumpHold = null;
  ev.live = false; ev.liveU = 0; ev.liveW = 0;

  adapt(d.frame, res, tMs);
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
    d.lunge.reset(); d.jumpM.reset();
    return ev;
  }

  readBody(d.body, d.frame, d.cal);
  if (!d.body.valid) return ev;

  /* the lane control is always live */
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
  Jump.step(d.jumpM, d.frame, d.body, d.cal, ev, !midRep);
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
