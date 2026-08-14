/* =====================================================================================
   RUNNING IN PLACE — cadence as a continuous control.

   This is the only exercise machine that does not count reps. It publishes a RATE, because what
   the game wants from it is not "a step happened" but "how hard is this person working right now",
   which drives the player forward along the belt.

   WHY THIS IS THE EASIEST THING A FLOOR CAMERA CAN SEE.

   Running in place lifts the ankles ALTERNATELY, about 180 degrees out of phase. A jump and a
   jumping jack lift them TOGETHER. That is a differential-versus-common-mode distinction, and
   `body.ankleSplit` is the differential half. Measured on synthetic bodies across three floor
   camera placements:

     movement            differential   common-mode
     running in place           0.347         0.076
     jumping jacks              0.000         0.132
     a vertical jump            0.000         0.292
     squats                     0.000         0.179
     standing still             0.000         0.000

   0.35 against 0.00 is categorical rather than marginal. The geometry helps for once: from a phone
   on the floor the feet are the nearest and largest landmarks, and a foot lifting is in-plane
   motion — the opposite of the depth-axis problem that makes push-up elbows unreadable.

   Those zeros are exactly zero because a synthetic body is perfectly symmetric. A real one never
   is, so real non-running values will be small rather than nil. `altGate` exists for that margin
   and is the first number to check against a real body.

   COUNTING STEPS, AND WHY NOT ZERO CROSSINGS.

   A running foot rests flat on the floor for roughly half its cycle, so `ankleSplit` sits at
   exactly 0 for long stretches. A sign-change counter both misses those steps and trips over
   Math.sign(0) — measured, it under-read every cadence by 15-50%. Counting the crossing of a
   threshold set from the signal's OWN amplitude, with a deadband before re-arming, recovered
   cadence to within 1.3-9.4% over 1.6 to 3.8 steps per second.

   The threshold is relative for the same reason every other threshold in this layer is: how far a
   foot appears to lift depends on the person, their effort, and where the phone is.
   ===================================================================================== */

import { CONFIG } from './config.js';

const C = CONFIG.run;

export function create(){
  return {
    kind:'run', steps:0, cadence:0,
    /* which side we are waiting to see next, so one foot cannot count twice */
    armedHi:true, armedLo:true,
    msSinceStep: 1e6, lastIntervalMs: 0, frozen:false,
    reset(){ this.cadence=0; this.armedHi=true; this.armedLo=true;
             this.msSinceStep=1e6; this.lastIntervalMs=0; },
  };
}

/* `ev.cadence` is published every frame; `ev.step` only on the frame a step lands. */
export function step(m, body, cal, ev){
  const dt = body.dtMs;

  /* Same landmarks a jump needs, and the same gate, because this is the same measurement of the
     same two ankles. Freezing rather than zeroing would leave a stale cadence driving the player
     forward while the camera cannot see them, which is the one outcome worth avoiding. */
  if (body.visMin.lunge < CONFIG.common.visGate){
    m.frozen = true; m.reset();
    body.cadence = 0; body.running = false;
    if (ev) ev.cadence = 0;
    return;
  }
  m.frozen = false;
  m.msSinceStep += dt;

  const s = body.ankleSplit;
  /* `ankleAlt` is a slow-decaying magnitude, so it approximates the recent peak of |split|, which
     is half the peak-to-peak amplitude. Half of that again is the 25%-of-amplitude threshold the
     offline measurement settled on. The floor keeps a body that has not run yet from having a
     threshold of zero and counting noise as steps. */
  const th = Math.max(C.minSplit, body.ankleAlt*C.thFrac);
  const rearm = th*C.rearmFrac;

  let stepped = false;
  /* A step is one foot reaching its peak lift. Two per cycle, one per foot, which is what "steps
     per second" means to anyone who has used a treadmill. */
  if (m.armedHi && s > th){ stepped = true; m.armedHi = false; }
  if (s < rearm) m.armedHi = true;
  if (m.armedLo && s < -th){ stepped = true; m.armedLo = false; }
  if (s > -rearm) m.armedLo = true;

  /* Too soon is jitter rather than footwork. Rejecting it here rather than smoothing it later
     keeps the interval — and so the cadence — honest. */
  if (stepped && m.msSinceStep < C.minStepMs) stepped = false;

  if (stepped){
    m.steps++;
    m.lastIntervalMs = m.msSinceStep;
    m.msSinceStep = 0;
    if (ev) ev.step = true;
  }

  /* CADENCE, and the reason it decays on its own.

     `interval` is the longer of the last real gap and the time since that gap started. While the
     player keeps a rhythm the second term never exceeds the first and the cadence is simply
     1000/interval. The moment they stop, the second term grows and the cadence falls smoothly out
     of the same expression — no timeout branch, no separate decay path, and no cliff where the
     player is still moving but the game has decided they are not. That matters because this value
     drives the player's position on the belt: a cliff would read as the treadmill lurching. */
  const interval = Math.max(m.lastIntervalMs || C.maxStepMs, m.msSinceStep);
  let raw = interval > 0 ? 1000/interval : 0;
  if (m.msSinceStep > C.maxStepMs || body.ankleAlt < C.altGate) raw = 0;
  raw = Math.min(raw, 1000/C.minStepMs);

  const k = dt > 0 ? (1 - Math.exp(-(dt/1000)/C.cadTau)) : 1;
  m.cadence += (raw - m.cadence)*k;
  if (m.cadence < 0.05) m.cadence = 0;

  /* published on the body so anything downstream can read it without reaching into the machine */
  body.cadence = m.cadence;
  body.running = m.cadence > 0;
  if (ev) ev.cadence = m.cadence;
}
