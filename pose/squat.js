/* =====================================================================================
   SQUAT — mean knee angle, with two secondary gates that stop a bend-over counting.

   All four required properties are present, and #4 is the one that matters most: without a
   required return to the entry state, users farm reps by vibrating at the bottom.

     1. valid entry   STANDING (knee > common.standKnee)
     2. transition    knee < the user's personal bottom threshold
     3. min duration  the bottom must be held, and the whole rep has a floor
     4. must return   knee back above common.standKnee, or no rep

   Reliable from a front-facing camera; second most reliable of the five.
   ===================================================================================== */

import { CONFIG, visGate } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.squat;
const L = CONFIG.live;
/* shared with the burpee, so "stood up" means one thing across both machines */
const STAND = CONFIG.common.standKnee;
const HYST = 8;                    // deg of hysteresis, so a jittery angle cannot chatter

export function create(){
  return {
    kind:'squat', state:'IDLE', stateT:0, repT:0, phase:0, reps:0,
    deepest:180, entryKnee:180, sawBottom:false, badTorso:false, frozen:false,
    reset(){ this.state='IDLE'; this.stateT=0; this.repT=0; this.phase=0;
             this.deepest=180; this.entryKnee=180; this.sawBottom=false; this.badTorso=false; },
  };
}

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const bottomKnee = cal.squatBottomKnee;
  const knee = body.knee;

  /* the visibility gate: never count a rep on guessed landmarks, and never fail the player
     for a dropout either — freeze and let the caller pause the world */
  if (body.visMin.squat < visGate('squat')){
    m.frozen = true;
    if (m.state !== 'IDLE' && m.state !== 'STANDING') ev.reject = 'WE LOST YOUR LEGS';
    m.reset();
    return;
  }
  m.frozen = false;
  m.stateT += dt;
  if (m.state !== 'IDLE' && m.state !== 'STANDING'){
    m.repT += dt;
    /* Sampled on EVERY frame of the rep, not just the descent. A burpee contains a perfectly
       good squat, and its kick-back straightens the knees — which used to satisfy the
       completion test while the torso was already halfway to horizontal. Watching the torso
       for the whole rep is what distinguishes "squatted" from "went to the floor". */
    if (body.torsoTilt > C.torsoMaxTilt) m.badTorso = true;
  }

  /* a rep that takes longer than the window was not a rep */
  if (m.repT > C.maxRepMs){ ev.reject = 'TOO SLOW'; m.reset(); m.state = 'STANDING'; return; }

  switch (m.state){
    case 'IDLE':
      if (knee > STAND){ m.state='STANDING'; m.stateT=0; }
      break;

    case 'STANDING':
      m.phase = 0;
      if (knee < STAND - HYST){
        m.state='DESCENDING'; m.stateT=0; m.repT=0;
        m.deepest=knee; m.entryKnee=knee; m.sawBottom=false; m.badTorso=false;
      }
      break;

    case 'DESCENDING':
      m.deepest = Math.min(m.deepest, knee);
      /* Spanned from where the descent was actually DETECTED, not from the STANDING threshold.
         Those differ by the hysteresis plus one frame of real movement, and spanning from the
         threshold made the first phase a wall ever sees jump straight to ~0.15 — so a wall took
         a visible bite of damage the instant a rep began, before the body had done anything. */
      m.phase = span01(knee, m.entryKnee, bottomKnee)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (body.torsoTilt > C.torsoMaxTilt) m.badTorso = true;
      if (knee < bottomKnee){ m.state='BOTTOM'; m.stateT=0; }
      else if (knee > STAND - HYST*0.5){
        /* came back up without ever getting deep enough */
        ev.reject = m.badTorso ? 'KEEP YOUR CHEST UP' : 'GO LOWER';
        m.reset(); m.state='STANDING';
      }
      break;

    case 'BOTTOM':
      m.deepest = Math.min(m.deepest, knee);
      m.phase = 0.5;
      ev.progress = true; ev.phase = m.phase;
      if (body.torsoTilt > C.torsoMaxTilt) m.badTorso = true;
      if (m.stateT >= C.minBottomMs) m.sawBottom = true;
      if (knee > bottomKnee + HYST){
        if (!m.sawBottom){
          /* bounced straight back out: that is not a rep, it is a bounce */
          ev.reject = 'HOLD IT AT THE BOTTOM';
          m.reset(); m.state='STANDING';
        } else { m.state='ASCENDING'; m.stateT=0; }
      }
      break;

    case 'ASCENDING':
      m.phase = 0.5 + span01(knee, bottomKnee, m.entryKnee)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (knee > STAND){
        /* the secondary gates are judged over the whole rep, at the moment it would count */
        if (m.repT < C.minRepMs){ ev.reject = 'TOO FAST'; }
        else if (m.badTorso){ ev.reject = 'KEEP YOUR CHEST UP'; }
        else if (cal.ready && body.hipDrop < C.hipDropMin){ ev.reject = 'GO LOWER'; }
        else {
          ev.completed = true;
          ev.form = formOf(m, bottomKnee);
          m.reps++;
        }
        m.reset(); m.state='STANDING'; m.phase = 1;
      }
      break;
  }
}

/* form: how far past the threshold they actually went, so a deep clean rep scores higher */
function formOf(m, bottomKnee){
  const depth = span01(m.deepest, bottomKnee + 10, bottomKnee - 25);
  return 0.6 + 0.4*depth;
}

/* ---- the live mirror: see the note in pushup.js ---------------------------------------
   Stateless. The penguin is already sinking while the machine is still waiting for the knee to
   cross the STANDING threshold, which is the whole difference between a game that feels
   connected to your body and one that feels like it is watching a replay. */
export function livePhase(m, body, cal){
  const d = span01(body.knee, STAND, cal.squatBottomKnee);
  if (d < L.minW) return null;
  return { u: d*0.5, w: d };
}
