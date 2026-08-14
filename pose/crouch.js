/* =====================================================================================
   CROUCH — a control, not a rep.

   The game needs a duck: the high bar spans the belt and cannot be answered by changing lane, so
   until now `retireUnanswerable()` simply hid it from camera players rather than showing them an
   obstacle they had no way through.

   THE SIGNAL IS THE STRAIGHTER KNEE, and that choice is the whole content of this file.

   A crouch bends both knees. Running in place bends one at a time and stands on the other — and
   that stance leg locks out HARDER than a relaxed stand. Measured across floor-camera placements:

     movement            straighter knee
     standing still            167 deg
     running in place       171-180 deg
     a shallow duck            106 deg
     a real crouch              90 deg
     a full squat               70 deg

   65 degrees of clear air between running and the shallowest duck worth answering. That is the
   same common-mode-versus-differential idea that separates a jump from a footfall (`jump.js` takes
   the LOWER ankle, because a jump lifts both) applied one joint further up.

   Everything image-space was tried first and rejected, which is worth recording so it is not
   retried: hip height over LEG length inverts, because a bending knee foreshortens the thigh from a
   low camera and shrinks the divisor during the exact movement being measured. Hip height over
   SHOULDER width does not invert but puts running's hip dip at 0.061 against a crouch's 0.076 —
   1.25x, which no threshold separates. Joint angles come from the metric frame and have neither
   problem.

   A DEEP SQUAT ALSO CROSSES THIS THRESHOLD, and that is correct rather than a flaw. The crouch is a
   raw capability; whether it should DO anything is the game's business, and the game only arms the
   duck when something is actually there to duck under. Squatting in open space is just squatting.
   ===================================================================================== */

import { CONFIG } from './config.js';

const C = CONFIG.crouch;

export function create(){
  return {
    kind:'crouch', down:false, heldMs:0, frozen:false,
    reset(){ this.down = false; this.heldMs = 0; },
  };
}

/* Publishes a LEVEL — `ev.crouch` is "are you down right now", not "you ducked just now". A level is
   the right shape for this: an edge could be missed, and a duck the player is still holding while
   the obstacle arrives has to keep counting. */
export function step(m, body, cal, ev){
  const dt = body.dtMs;

  /* Same landmarks and gate the lunge uses, because this is the same two legs. Freezing rather than
     releasing matters: dropping the crouch the instant tracking flickers would stand the player up
     underneath a bar they were correctly ducking. */
  if (body.visMin.lunge < CONFIG.common.visGate){
    m.frozen = true;
    body.crouching = m.down;          /* hold the last known state rather than lying about it */
    if (ev) ev.crouch = m.down;
    return;
  }
  m.frozen = false;

  const k = body.kneeStraight;
  /* Hysteresis, because this drives a duck and a control that chatters at its own threshold is
     worse than one that is slightly slow to release. Entering needs a dwell as well — a stumble
     mid-stride briefly bends both knees, and that is not a duck. */
  if (!m.down){
    if (k < C.enterKnee){
      m.heldMs += dt;
      if (m.heldMs >= C.minMs) m.down = true;
    } else m.heldMs = 0;
  } else {
    if (k > C.exitKnee){ m.down = false; m.heldMs = 0; }
  }

  body.crouching = m.down;
  if (ev) ev.crouch = m.down;
}
