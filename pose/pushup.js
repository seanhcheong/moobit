/* =====================================================================================
   PUSH-UP — the hard one, and the reason it is hard is geometry, not code.

   The phone is on the floor IN FRONT of the player, angled up. That solves framing: your
   whole body is in shot. It does not solve legibility. Prone and facing the lens, your torso
   points away from the camera, so:

     - the shoulder-to-hip vector projects to almost nothing, which makes a pure
       torso-angle gate degenerate;
     - elbow flexion happens largely along the depth axis, which is the weakest axis in
       monocular pose estimation — exactly the axis the floor placement was meant to avoid.

   So the primary signal is not the elbow. It is SHOULDER HEIGHT ABOVE THE PLANTED HANDS,
   measured in shoulder widths (`body.pushDepth`). Normalising against torso length — which is
   what every other exercise uses — does not work here: prone, the torso points away from the
   lens and its image-space length collapses toward zero, so the ratio explodes. Shoulder width
   stays perpendicular to the view axis in every pose. The shoulder-to-wrist segment is also
   short, near the camera and fully in-plane, which makes it the most legible thing this camera
   sees of a push-up. The elbow stays as a secondary gate, consulted only when it is legible.

   Lower-body landmarks legitimately drop out in this position, which is why the visibility
   gate is computed over this exercise's own landmark set and not all 33.

   If the framing check fails, or the player declines to lie down, the caller is expected to
   offer an upright substitution against the same wall. A substitution path is a supported
   feature, not an error state — never leave someone facing a wall they cannot register.
   ===================================================================================== */

import { CONFIG } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.pushup;

export function create(){
  return {
    kind:'pushup', state:'IDLE', stateT:0, repT:0, phase:0, reps:0,
    sawBottom:false, lowest:9, top:0, elbowSeen:false, proneT:0, frozen:false,
    reset(){ this.state='IDLE'; this.stateT=0; this.repT=0; this.phase=0;
             this.sawBottom=false; this.lowest=9; this.top=0; this.elbowSeen=false; },
  };
}

/* Prone or not, from the metric torso vector alone.
   A pushDepth fallback used to sit here, and it was actively harmful: arms overhead drive
   pushDepth negative, so a JUMPING JACK read as prone and its arm swing crossed both depth
   thresholds — six jacks counted as six push-ups. pushDepth measures depth WITHIN a prone
   rep; it cannot tell prone from standing, and asking it to was the bug. */
function isProne(body, cal){ return body.torsoHoriz <= C.torsoHorizMax; }

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const down = cal.pushupDownShoulder, up = cal.pushupUpShoulder;
  const sy = body.pushDepth;

  if (body.visMin.pushup < CONFIG.common.visGate){
    m.frozen = true;
    if (m.state === 'DOWN' || m.state === 'DESCENDING') ev.reject = 'WE LOST YOUR SHOULDERS';
    m.reset();
    return;
  }
  m.frozen = false;
  m.stateT += dt;
  if (m.state !== 'IDLE' && m.state !== 'UP') m.repT += dt;
  if (m.repT > C.maxRepMs){ ev.reject = 'TOO SLOW'; m.reset(); m.state='UP'; return; }

  if (!isProne(body, cal)){
    /* standing up mid-set is not a failed rep, it is leaving the exercise */
    m.proneT = 0;
    if (m.state !== 'IDLE') m.reset();
    return;
  }
  m.proneT += dt;

  switch (m.state){
    case 'IDLE':
      /* A burpee passes through a brief prone phase on its way past. Requiring the body to
         have SETTLED into the position before a rep can even begin is what stops the middle
         of a burpee registering as a push-up. */
      if (sy > up*0.94 && m.proneT >= C.minProneMs){ m.state='UP'; m.stateT=0; }
      break;

    case 'UP':
      m.phase = 0;
      if (sy < up*0.94){
        m.state='DESCENDING'; m.stateT=0; m.repT=0;
        m.lowest=sy; m.top=sy; m.sawBottom=false; m.elbowSeen=false;
      }
      break;

    case 'DESCENDING':
      m.lowest = Math.min(m.lowest, sy);
      m.phase = span01(sy, up, down)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (body.visMin.pushup > 0.7 && body.elbow < C.elbowDown) m.elbowSeen = true;
      if (sy < down){ m.state='DOWN'; m.stateT=0; }
      else if (sy > up*0.98){
        ev.reject = 'ALL THE WAY DOWN';
        m.reset(); m.state='UP';
      }
      break;

    case 'DOWN':
      m.lowest = Math.min(m.lowest, sy);
      m.phase = 0.5;
      ev.progress = true; ev.phase = m.phase;
      if (m.stateT >= C.minBottomMs) m.sawBottom = true;
      if (body.visMin.pushup > 0.7 && body.elbow < C.elbowDown) m.elbowSeen = true;
      if (sy > down*1.08){
        if (!m.sawBottom){ ev.reject = 'PAUSE AT THE BOTTOM'; m.reset(); m.state='UP'; }
        else { m.state='ASCENDING'; m.stateT=0; }
      }
      break;

    case 'ASCENDING':
      m.phase = 0.5 + span01(sy, down, up)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (sy > up*0.96){
        const travel = m.top - m.lowest;
        if (m.repT < C.minRepMs){ ev.reject = 'TOO FAST'; }
        else if (travel < C.dropMin){ ev.reject = 'ALL THE WAY DOWN'; }
        else {
          ev.completed = true;
          /* elbow evidence is a bonus, not a requirement — from this camera it is often
             simply unavailable, and a rep is not worth less because of where the phone is */
          ev.form = (m.elbowSeen ? 0.8 : 0.65) + 0.2*span01(travel, C.dropMin, C.dropMin*2.2);
          m.reps++;
        }
        m.reset(); m.state='UP'; m.phase = 1;
      }
      break;
  }
}
