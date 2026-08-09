/* =====================================================================================
   JUMPING JACK — the most reliable of the five from a front camera, because both signals
   are pure lateral/vertical motion in the image plane with no depth component at all.

   That is why it is the tutorial exercise and the first wall the player ever meets.

     1. valid entry   CLOSED — wrists below shoulders and feet together
     2. transition    OPEN requires wrists above shoulders AND feet apart, simultaneously
     3. min duration  the open position has to exist for a moment
     4. must return   back to CLOSED, or no rep
   ===================================================================================== */

import { CONFIG, visGate } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.jack;
const L = CONFIG.live;

export function create(){
  return {
    kind:'jack', state:'IDLE', stateT:0, repT:0, phase:0, reps:0,
    sawOpen:false, widest:0, frozen:false,
    reset(){ this.state='IDLE'; this.stateT=0; this.repT=0; this.phase=0;
             this.sawOpen=false; this.widest=0; },
  };
}

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const open = cal.jackOpenSpan, close = cal.jackCloseSpan;
  const span = body.ankleSpan;
  const armsUp = body.wristsAboveShoulders;

  if (body.visMin.jack < visGate('jack')){
    m.frozen = true;
    if (m.state === 'OPEN') ev.reject = 'WE LOST YOUR ARMS OR FEET';
    m.reset();
    return;
  }
  m.frozen = false;
  m.stateT += dt;
  if (m.state === 'OPENING' || m.state === 'OPEN' || m.state === 'CLOSING') m.repT += dt;
  if (m.repT > C.maxRepMs){ ev.reject = 'TOO SLOW'; m.reset(); m.state='CLOSED'; return; }

  switch (m.state){
    case 'IDLE':
      if (span < close && !armsUp){ m.state='CLOSED'; m.stateT=0; }
      break;

    case 'CLOSED':
      m.phase = 0;
      if (span > close*1.12 || armsUp){
        m.state='OPENING'; m.stateT=0; m.repT=0; m.sawOpen=false; m.widest=span;
      }
      break;

    case 'OPENING':
      m.widest = Math.max(m.widest, span);
      /* phase tracks the feet, which is the cleaner of the two signals */
      m.phase = span01(span, close, open)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (span > open && armsUp){ m.state='OPEN'; m.stateT=0; }
      else if (span < close && !armsUp){
        /* went back in without ever reaching a real open position */
        ev.reject = m.widest > open ? 'ARMS ABOVE YOUR SHOULDERS' : 'FEET WIDER';
        m.reset(); m.state='CLOSED';
      }
      break;

    case 'OPEN':
      m.widest = Math.max(m.widest, span);
      m.phase = 0.5;
      ev.progress = true; ev.phase = m.phase;
      if (m.stateT >= C.minOpenMs) m.sawOpen = true;
      if (span < open*0.94 || !armsUp){ m.state='CLOSING'; m.stateT=0; }
      break;

    case 'CLOSING':
      m.phase = 0.5 + span01(span, open, close)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (span < close && !armsUp){
        if (!m.sawOpen){ ev.reject = 'ALL THE WAY OUT'; }
        else if (m.repT < C.minRepMs){ ev.reject = 'TOO FAST'; }
        else {
          ev.completed = true;
          ev.form = 0.6 + 0.4*span01(m.widest, open, open*1.35);
          m.reps++;
        }
        m.reset(); m.state='CLOSED'; m.phase = 1;
      }
      break;
  }
}

/* ---- the live mirror: see the note in pushup.js ---------------------------------------
   Stateless. Takes whichever of the two signals is further along, so the penguin's arms are
   already on the way up as the player's are, rather than snapping when both gates finally
   agree that a rep has begun. */
export function livePhase(m, body, cal){
  const feet = span01(body.ankleSpan, cal.jackCloseSpan, cal.jackOpenSpan);
  const arms = body.wristsAboveShoulders ? 1 : 0;
  const d = Math.max(feet, arms*0.85);
  if (d < L.minW) return null;
  return { u: d*0.5, w: d };
}
