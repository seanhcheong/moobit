/* =====================================================================================
   BURPEE — a composite validated as an ORDERED CHAIN inside a time window, never as a
   single pose. Out-of-order transitions reset. Nothing short of the whole chain counts.

     STAND -> SQUAT -> FLOOR_DOWN -> FLOOR_UP -> RETURN -> JUMP -> STAND

   It shares the push-up's problem: from a floor-mounted camera in front of the player, the
   floor phase is the least legible part of the movement. So it degrades rather than refusing.
   If squat and jump both fire in the correct order and window but the floor phase cannot be
   confirmed, the rep counts at a reduced form score. Rejecting it would mean punishing the
   player for where their phone is, which is never the right trade.

   The stage-to-phase mapping is deliberate: the game's burpee pose is built by blending seven
   timed segments, and these numbers put the penguin at the same point in the movement as the
   person doing it, rather than playing an animation at its own pace.
   ===================================================================================== */

import { CONFIG } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.burpee;
const SP = C.stagePhase;

export function create(){
  return {
    kind:'burpee', state:'IDLE', stateT:0, chainT:0, phase:0, reps:0,
    sawFloor:false, sawJump:false, deepest:180, frozen:false,
    reset(){ this.state='IDLE'; this.stateT=0; this.chainT=0; this.phase=0;
             this.sawFloor=false; this.sawJump=false; this.deepest=180; },
  };
}

/* Prone or not, judged ONLY from the metric torso vector.
   There is no usable image-space fallback here, and it is worth saying why: when someone is
   prone and facing a floor camera, their ankles are a whole body-length further from the lens
   than their head, so every ratio measured against the ankle line is unreliable — including
   pushDepth, which reads ~0.6 both standing and at the top of a push-up and therefore cannot
   tell those apart at all. The world-landmark torso vector does not collapse, and it separates
   cleanly: ~89 degrees standing against ~5 degrees prone.

   If world landmarks are ever unavailable the adapter falls back to image space, torsoHoriz
   becomes unreliable, and this returns false — which drops the burpee onto its degraded
   squat-plus-jump path at a reduced form score rather than refusing the rep. That is the
   designed behaviour, not an accident. */
const onFloor = (body, cal)=> body.torsoHoriz <= C.floorTorsoHoriz;

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const squatKnee = cal.burpeeSquatKnee;

  if (body.visMin.burpee < CONFIG.common.visGate){
    m.frozen = true;
    if (m.state !== 'IDLE' && m.state !== 'STAND') ev.reject = 'WE LOST YOU';
    m.reset();
    return;
  }
  m.frozen = false;
  m.stateT += dt;
  if (m.state !== 'IDLE' && m.state !== 'STAND') m.chainT += dt;

  /* the whole chain, or nothing */
  if (m.chainT > C.windowMs){
    ev.reject = m.sawFloor ? 'FINISH WITH A JUMP' : 'ALL THE WAY DOWN, THEN JUMP';
    m.reset(); m.state='STAND'; return;
  }

  switch (m.state){
    case 'IDLE':
      if (body.knee > CONFIG.squat.standKnee){ m.state='STAND'; m.stateT=0; }
      break;

    case 'STAND':
      m.phase = SP.STAND;
      if (body.knee < squatKnee){
        m.state='SQUAT'; m.stateT=0; m.chainT=0;
        m.sawFloor=false; m.sawJump=false; m.deepest=body.knee;
      }
      break;

    case 'SQUAT':
      m.deepest = Math.min(m.deepest, body.knee);
      m.phase = SP.STAND + span01(body.knee, CONFIG.squat.standKnee, squatKnee)*(SP.SQUAT-SP.STAND);
      ev.progress = true; ev.phase = m.phase;
      if (onFloor(body, cal) && m.stateT > C.minStageMs){
        m.state='FLOOR_DOWN'; m.stateT=0; m.sawFloor=true;
      } else if (body.knee > CONFIG.squat.standKnee && body.torsoTilt < C.standTilt &&
                 m.stateT > C.minStageMs){
        /* Stood back up out of the squat: a squat is not a burpee.
           The torso gate is load-bearing, not decoration. Kicking the legs back straightens
           the knees while the torso is still pitching forward, so a knee test on its own
           reads the kick-back — the correct middle of a burpee — as giving up. Standing up
           is the only case where the legs straighten AND the torso is upright. */
        ev.reject = 'DOWN TO THE FLOOR';
        m.reset(); m.state='STAND';
      }
      break;

    case 'FLOOR_DOWN':
      m.phase = SP.FLOOR_DOWN;
      ev.progress = true; ev.phase = m.phase;
      if (m.stateT > C.minStageMs){ m.state='FLOOR_UP'; m.stateT=0; }
      break;

    case 'FLOOR_UP':
      m.phase = SP.FLOOR_UP;
      ev.progress = true; ev.phase = m.phase;
      /* back off the floor and re-verticalising */
      if (!onFloor(body, cal) && body.knee < CONFIG.squat.standKnee && m.stateT > C.minStageMs){
        m.state='RETURN'; m.stateT=0;
      }
      break;

    case 'RETURN':
      m.phase = SP.RETURN;
      ev.progress = true; ev.phase = m.phase;
      if (body.wristsAboveHead || (cal.ready && body.ankleRise > C.jumpAnkleRise)){
        m.state='JUMP'; m.stateT=0; m.sawJump=true;
      } else if (body.knee > CONFIG.squat.standKnee && m.stateT > 900){
        /* stood up and stopped, without the jump */
        ev.reject = 'FINISH WITH A JUMP';
        m.reset(); m.state='STAND';
      }
      break;

    case 'JUMP':
      m.phase = SP.JUMP;
      ev.progress = true; ev.phase = m.phase;
      if (!body.wristsAboveHead && body.knee > CONFIG.squat.standKnee - 12){
        if (m.sawJump && (m.sawFloor || m.deepest < squatKnee)){
          ev.completed = true;
          /* an unconfirmed floor phase still counts, at a reduced score */
          ev.form = m.sawFloor ? 0.85 + 0.15*span01(m.deepest, squatKnee, squatKnee-30)
                               : C.degradedForm;
          m.reps++;
        } else {
          ev.reject = 'ALL THE WAY DOWN, THEN JUMP';
        }
        m.reset(); m.state='STAND'; m.phase = 1;
      }
      break;
  }
}
