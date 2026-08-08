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

import { CONFIG, EX, defaultCalibration } from './config.js';
import { makeFrame, adapt, NEEDS, minVisOf, visOf } from './landmarks.js';
import { makeBody, readBody } from './body.js';
import * as Squat from './squat.js';
import * as Jack from './jack.js';
import * as Pushup from './pushup.js';
import * as Burpee from './burpee.js';
import * as Lunge from './lunge.js';

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
    want: EX.JACK,              // which exercise the wall in front is asking for
    track: TRACK.GOOD,
    lastFrameT: -1e9,
    /* reused every frame; the event surface allocates nothing */
    ev: { progress:false, phase:0, completed:false, form:1, reject:'', lane:0 },
    stats: { frames:0, progress:0, completed:0, rejected:0, lanes:0, lost:0 },
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

/* ---- tracking state, from the landmarks the ACTIVE exercise needs, not all 33 ---------- */
function trackOf(d, tMs){
  if (!d.frame.valid || tMs - d.lastFrameT > CONFIG.common.staleMs) return TRACK.LOST;
  const key = NEED_KEY[d.want] || 'squat';
  const mn = minVisOf(d.frame, NEEDS[key]);
  const mean = visOf(d.frame, NEEDS[key]);
  if (mn < 0.25) return TRACK.LOST;
  if (mn < CONFIG.common.visGate || mean < 0.7) return TRACK.DEGRADED;
  return TRACK.GOOD;
}

/* ---- the whole pipeline for one inference result -----------------------------------------
   `res`  a MediaPipe PoseLandmarkerResult, or null when the detector found nobody
   `tMs`  the CAPTURE timestamp, stamped when the frame was grabbed, not when it arrived —
          every machine reasons in milliseconds, never in frame counts, so a variable
          inference rate cannot change what counts as a rep
   `sink` { laneChange, repProgress, repCompleted, trackingState } — the game's own contract
*/
export function push(d, res, tMs, sink){
  const ev = d.ev;
  ev.progress = false; ev.phase = 0; ev.completed = false; ev.form = 1;
  ev.reject = ''; ev.lane = 0;

  adapt(d.frame, res, tMs);
  if (d.frame.valid) d.lastFrameT = tMs;
  d.stats.frames++;

  const track = trackOf(d, tMs);
  if (track !== d.track){
    d.track = track;
    if (track === TRACK.LOST) d.stats.lost++;
    if (sink && sink.trackingState) sink.trackingState(track);
  }
  if (track === TRACK.LOST || !d.frame.valid){
    /* freeze everything rather than reasoning about a body we cannot see */
    for (const k in d.mach) d.mach[k].reset();
    d.lunge.reset();
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
    knee: +b.knee.toFixed(1), elbow: +b.elbow.toFixed(1),
    torsoTilt: +b.torsoTilt.toFixed(1), torsoHoriz: +b.torsoHoriz.toFixed(1),
    shoulderY: +b.shoulderY.toFixed(3), ankleSpan: +b.ankleSpan.toFixed(3),
    hipDrop: +b.hipDrop.toFixed(3), hipX: +b.hipX.toFixed(3),
    vis: +b.visMin[NEED_KEY[d.want] || 'squat'].toFixed(2),
    reps: m ? m.reps : 0, stats: d.stats,
  };
}
