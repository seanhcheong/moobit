/* =====================================================================================
   BURPEE — a composite validated as an ORDERED CHAIN inside a time window, never as a
   single pose. Out-of-order transitions reset. Nothing short of the whole chain counts.

     STAND -> SQUAT -> FLOOR_DOWN -> FLOOR_UP -> RETURN -> JUMP -> STAND

   It shares the push-up's problem: from a floor-mounted camera in front of the player, the
   floor phase is the least legible part of the movement. So it degrades rather than refusing.
   If squat and jump both fire in the correct order and window but the floor phase cannot be
   confirmed, the rep counts at a reduced form score. Rejecting it would mean punishing the
   player for where their phone is, which is never the right trade.

   ### Two gates used to make this undetectable rather than merely strict

   1. The chain could only start from STAND, and STAND needed a knee angle of 160 degrees.
      BlazePose runs roughly 15 degrees pessimistic on peak knee extension, and a relaxed
      standing posture is genuinely a little bent, so a real standing body often reads 150-155.
      For those players the machine sat in IDLE forever and no burpee could ever be counted.
      The bar now lives in `common.standKnee` and is 150, shared with the squat.

   2. RETURN -> JUMP required either wrists above the head or `cal.ready && ankleRise`. Plenty
      of people burpee without throwing their arms overhead, and before calibration the second
      option did not exist at all — so an uncalibrated player who kept their hands low could
      complete the entire movement and never be credited. It now also accepts
      `body.jumpRise`, which the jump detector maintains against its own self-seeded baseline
      and therefore needs no calibration.

   The stage-to-phase mapping is deliberate: the game's burpee pose is built by blending seven
   timed segments, and these numbers put the penguin at the same point in the movement as the
   person doing it, rather than playing an animation at its own pace.
   ===================================================================================== */

import { CONFIG, visGate } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.burpee;
const SP = C.stagePhase;
const L = CONFIG.live;
const STAND_KNEE = CONFIG.common.standKnee;

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

/* the finishing hop, by any of the three things that can evidence it */
const hopping = (body, cal)=>
  body.wristsAboveHead ||
  body.jumpRise > C.jumpAnkleRise ||
  (cal.ready && body.ankleRise > C.jumpAnkleRise);

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const squatKnee = cal.burpeeSquatKnee;

  if (body.visMin.burpee < visGate('burpee')){
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
      if (body.knee > STAND_KNEE){ m.state='STAND'; m.stateT=0; }
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
      m.phase = SP.STAND + span01(body.knee, STAND_KNEE, squatKnee)*(SP.SQUAT-SP.STAND);
      ev.progress = true; ev.phase = m.phase;
      if (onFloor(body, cal) && m.stateT > C.minStageMs){
        m.state='FLOOR_DOWN'; m.stateT=0; m.sawFloor=true;
      } else if (body.knee > STAND_KNEE && body.torsoTilt < C.standTilt &&
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
      if (!onFloor(body, cal) && body.knee < STAND_KNEE && m.stateT > C.minStageMs){
        m.state='RETURN'; m.stateT=0;
      }
      break;

    case 'RETURN':
      m.phase = SP.RETURN;
      ev.progress = true; ev.phase = m.phase;
      if (hopping(body, cal)){
        m.state='JUMP'; m.stateT=0; m.sawJump=true;
      } else if (body.knee > STAND_KNEE && m.stateT > C.returnGiveUpMs){
        /* stood up and stopped, without the jump */
        ev.reject = 'FINISH WITH A JUMP';
        m.reset(); m.state='STAND';
      }
      break;

    case 'JUMP': {
      m.phase = SP.JUMP;
      ev.progress = true; ev.phase = m.phase;
      /* Close on landing, or on a timeout: someone who finishes with their arms still up would
         otherwise sit here waiting for a hand to come down, and the hop — the thing the chain
         was actually waiting for — has already happened. */
      const landed = !body.wristsAboveHead && body.knee > STAND_KNEE - 12;
      if (landed || m.stateT > C.jumpMaxMs){
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
}

/* ---- the live mirror: see the note in pushup.js -----------------------------------------
   A burpee is a chain rather than a depth, so there is no single number to read. What this
   covers is the gap before the chain engages — the player is already dropping into the squat
   while STAND is still waiting for the knee to cross its threshold. Once the machine is running
   its own phase is authoritative and this is not consulted. */
export function livePhase(m, body, cal){
  if (body.torsoHoriz <= C.floorTorsoHoriz) return { u: SP.FLOOR_DOWN, w: 1 };
  if (body.wristsAboveHead) return { u: SP.JUMP, w: 1 };
  const d = span01(body.knee, STAND_KNEE, cal.burpeeSquatKnee);
  if (d < L.minW) return null;
  return { u: SP.STAND + d*(SP.SQUAT - SP.STAND), w: d };
}
