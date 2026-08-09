/* =====================================================================================
   JUMP — a real jump makes the penguin jump. Like the lunge, this is a control input rather
   than a rep counter, so it is held to a button's latency budget rather than a rep's accuracy
   budget.

   FIRE ON TAKEOFF, not apex. Waiting for the top of the jump would add 200-300ms to an input
   that already costs the vision pipeline 150-350ms, and the whole point of jumping is to clear
   something that is arriving.

   VARIABLE HEIGHT, from the real jump. The game supports hold-for-height, which a body cannot
   express as a button hold — but it can express it as an actual jump height. So the signal
   fires at takeoff with the hold engaged, and then releases the hold early if the jump turns
   out to be a small one. A bigger real jump gives a bigger game jump, with no added latency.

   ITS OWN BASELINE. This does not depend on calibration: it keeps a slow-moving estimate of
   where the ankle line sits while you are standing, so it works from the first second and
   survives you moving to a different spot. The rise is divided by leg length in the same
   image space, so it stays scale-free.
   ===================================================================================== */

import { CONFIG } from './config.js';
import { LM } from './landmarks.js';

const C = CONFIG.jump;

export function create(){
  return {
    kind:'jump', state:'GROUND', stateT:0, jumps:0,
    base:0, haveBase:false, prevRise:0, vel:0,
    peak:0, refractory:0, holdFor:0, frozen:false,
    reset(){ this.state='GROUND'; this.stateT=0; this.prevRise=0; this.vel=0;
             this.peak=0; this.refractory=0; this.holdFor=0; },
  };
}

/* how far the ankle line has risen above its standing baseline, in leg lengths */
function riseOf(m, frame, body){
  const aY = (frame.img[LM.ANKLE_L].y + frame.img[LM.ANKLE_R].y)*0.5;
  if (!m.haveBase){ m.base = aY; m.haveBase = true; }
  return (aY - m.base)/Math.max(1e-4, body.legLen);
}

export function step(m, frame, body, cal, ev){
  const dt = body.dtMs;
  m.stateT += dt;
  if (m.refractory > 0) m.refractory = Math.max(0, m.refractory - dt);

  if (body.visMin.lunge < CONFIG.common.visGate){    // same landmarks a jump needs
    m.frozen = true; m.reset();
    return;
  }
  m.frozen = false;

  const rise = riseOf(m, frame, body);
  m.vel = rise - m.prevRise;
  m.prevRise = rise;

  switch (m.state){
    case 'GROUND':
      /* track the baseline only while grounded, and only downward-ish, so a slow drift follows
         you standing somewhere new without the baseline chasing you up mid-jump */
      m.base += (rise < 0 ? rise*C.baseTrackDown : rise*C.baseTrackUp)*Math.max(1e-4, body.legLen);
      m.peak = 0;
      if (m.refractory > 0) break;
      if (rise > C.takeoffRise && m.vel > C.minUpVel){
        ev.jump = true;                 // fired at takeoff, hold engaged
        ev.jumpHold = true;
        m.state = 'AIR'; m.stateT = 0; m.jumps++;
        m.refractory = C.refractoryMs;
        m.peak = rise;
      }
      break;

    case 'AIR':
      m.peak = Math.max(m.peak, rise);
      /* a small jump releases the hold early, which is how a real jump height reaches the game */
      if (m.stateT > C.holdDecideMs && m.peak < C.bigRise) ev.jumpHold = false;
      else if (m.stateT <= C.holdDecideMs) ev.jumpHold = true;
      if (rise < C.landRise && m.stateT > C.minAirMs){
        ev.jumpHold = false;
        m.state = 'GROUND'; m.stateT = 0;
      } else if (m.stateT > C.maxAirMs){
        /* never got back down — the baseline was probably wrong, so re-seed it */
        ev.jumpHold = false;
        m.haveBase = false; m.state = 'GROUND'; m.stateT = 0;
      }
      break;
  }
}
