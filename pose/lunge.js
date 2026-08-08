/* =====================================================================================
   SIDE LUNGE — the lane-change control. This one is not a rep counter; it is a button, and
   it is held to a button's latency budget.

   Two deliberate choices:

   LATERAL, not forward. A forward lunge seen from a front-facing camera is almost entirely
   depth motion, and depth is the weakest axis in monocular pose estimation, so the direction
   would be genuinely ambiguous — and a lane change that goes the wrong way is the most
   infuriating failure this app can produce. A side lunge is unmistakable lateral displacement
   in the image plane. Game design decision, not a compromise.

   FIRE ON COMMIT, not completion. The trigger is 55% of the calibrated full-lunge distance
   while the outward velocity is still positive. Waiting for the bottom of the lunge would add
   300-400ms to a control input, on top of the 150-350ms the vision pipeline already costs.

   Direction is resolved in SCREEN space, after the preview mirroring, never from MediaPipe's
   LEFT_/RIGHT_ labels — those refer to the subject's own left and right, which is the
   opposite of the screen's when someone faces the camera.
   ===================================================================================== */

import { CONFIG } from './config.js';

const C = CONFIG.lunge;

export function create(){
  return {
    kind:'lunge', state:'NEUTRAL', stateT:0, reps:0,
    refractory:0, lastDir:0, prevOut:0, vel:0, frozen:false,
    reset(){ this.state='NEUTRAL'; this.stateT=0; this.refractory=0;
             this.lastDir=0; this.prevOut=0; this.vel=0; },
  };
}

/* How far a foot has travelled BEYOND the player's own resting stance, in shoulder widths,
   and to which side of the screen. Measuring from the hip centre instead would mean a person
   standing normally already reads ~0.4 out, so they could never return to neutral and the
   second lunge would never fire. Sign is screen-relative: -1 screen-left, +1 screen-right. */
function outward(body, cal){
  const base = cal.standStanceHalf || 0;
  const l = Math.max(0, -body.ankleLX - base);   // ankleLX is negative when out to screen-left
  const r = Math.max(0,  body.ankleRX - base);
  return (l >= r) ? { mag:l, dir:-1 } : { mag:r, dir:+1 };
}

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  m.stateT += dt;
  if (m.refractory > 0) m.refractory = Math.max(0, m.refractory - dt);

  if (body.visMin.lunge < CONFIG.common.visGate){
    m.frozen = true; m.reset();
    return;
  }
  m.frozen = false;

  const o = outward(body, cal);
  m.vel = (o.mag - m.prevOut);          // per frame; sign is all we use
  m.prevOut = o.mag;

  const fireAt = cal.lungeFullSpan * C.fireFrac;

  switch (m.state){
    case 'NEUTRAL':
      if (m.refractory > 0) break;
      /* the whole body has to commit, not just a foot sliding out: hip centre shifts the same
         way, and the lunging leg actually bends */
      if (o.mag > fireAt && m.vel > C.minOutwardVel &&
          Math.abs(body.hipX) > C.hipShiftMin &&
          Math.sign(body.hipX) === o.dir &&
          Math.min(body.kneeL, body.kneeR) < C.kneeMax){
        ev.lane = o.dir;
        m.lastDir = o.dir;
        m.state = 'OUT'; m.stateT = 0;
        m.refractory = C.refractoryMs;
        m.reps++;
      }
      break;

    case 'OUT':
      /* the same direction cannot fire again until the body has come back to neutral, so the
         return leg of the movement never double-triggers */
      if (o.mag < C.neutralSpan){ m.state='NEUTRAL'; m.stateT=0; }
      break;
  }
}
