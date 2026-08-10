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
   stays perpendicular to the view axis in every pose, so it shrinks with distance without
   collapsing with orientation. The shoulder-to-wrist segment is also short, near the camera and
   fully in-plane, which makes it the most legible thing this camera sees of a push-up. The elbow
   stays as a secondary gate, consulted only when it is legible.

   ### Measured against your own plank, not against a number

   This machine used to compare shoulder height to absolute calibrated thresholds, and that was
   the reason honest push-ups did not register. `pushDepth` at the top of a plank depends on
   forearm length, hand placement, how much the phone is tilted and how far away you are — so
   the top of one person's plank can sit below the value calibration recorded for another
   position entirely, and then the machine waits forever for a height that body never produces.

   So the top of the rep is now TRACKED: a resting height that follows the shoulders quickly
   upward and slowly downward, which converges on wherever this player's plank actually sits and
   cannot be dragged down by a descent. The rep triggers on a RELATIVE drop from it, and closes
   on a return to it. The calibrated `down` threshold survives only as one of two ways to prove
   real depth — either you reached it, or you travelled `dropMin` shoulder widths — so a low
   plank and a high plank both work.

   Lower-body landmarks legitimately drop out in this position, which is why the visibility gate
   is this exercise's own (`visGate('pushup')`) and not the number an upright exercise uses.

   If the framing check fails, or the player declines to lie down, the caller is expected to
   offer an upright substitution against the same wall. A substitution path is a supported
   feature, not an error state — never leave someone facing a wall they cannot register.
   ===================================================================================== */

import { CONFIG, visGate } from './config.js';
import { span01 } from './body.js';

const C = CONFIG.pushup;
const L = CONFIG.live;

export function create(){
  return {
    kind:'pushup', state:'IDLE', stateT:0, repT:0, phase:0, reps:0,
    sawBottom:false, lowest:9, top:0, phTop:0, rest:0, elbowSeen:false,
    proneT:0, prevHoriz:-1, frozen:false,
    reset(){ this.state='IDLE'; this.stateT=0; this.repT=0; this.phase=0;
             this.sawBottom=false; this.lowest=9; this.top=0; this.phTop=0;
             this.elbowSeen=false; },
  };
}

/* Prone or not, from the metric torso vector alone.
   A pushDepth fallback used to sit here, and it was actively harmful: arms overhead drive
   pushDepth negative, so a JUMPING JACK read as prone and its arm swing crossed both depth
   thresholds — six jacks counted as six push-ups. pushDepth measures depth WITHIN a prone
   rep; it cannot tell prone from standing, and asking it to was the bug. */
function isProne(body, cal){ return body.torsoHoriz <= C.torsoHorizMax; }

/* The elbow is a bonus signal, so its bar is the one this exercise already cleared plus a
   margin — not 0.7, which a prone body in front of a floor camera essentially never reaches,
   which made the bonus unreachable and scored every honest push-up as unverified form.

   It asks about the ELBOWS' own visibility. It used to read `visMin.pushup`, the minimum across
   every landmark the exercise needs, back when the elbows were part of that set. They are not
   any more — they were removed so an invisible elbow could not refuse a rep outright — and
   leaving this reading the group would have quietly inverted its meaning: it would have reported
   the elbow as legible whenever the shoulders, hips and wrists were clear, and then read an
   angle off a landmark the model was guessing at. A bonus that fires on a guess is worse than
   no bonus, because it lands in the form score as if it were evidence. */
const elbowLegible = (body)=> body.visMin.pushupElbow > visGate('pushup') + 0.15;

/* the height the shoulders must return to for the rep to close: this player's own plank, or the
   calibrated top if that is lower */
const topGate = (m, up)=> m.top > 0 ? Math.min(up*0.96, m.top*0.97) : up*0.96;

export function step(m, body, cal, ev){
  const dt = body.dtMs;
  const down = cal.pushupDownShoulder, up = cal.pushupUpShoulder;
  const sy = body.pushDepth;

  if (body.visMin.pushup < visGate('pushup')){
    m.frozen = true;
    if (m.state === 'DOWN' || m.state === 'DESCENDING') ev.reject = 'WE LOST YOUR SHOULDERS';
    m.reset();
    return;
  }
  m.frozen = false;
  m.stateT += dt;
  if (m.state !== 'IDLE' && m.state !== 'UP') m.repT += dt;
  if (m.repT > C.maxRepMs){ ev.reject = 'TOO SLOW'; m.reset(); m.state='UP'; m.rest = sy; return; }

  /* torso angular rate, deg/s — the settle test's real signal */
  const rate = (m.prevHoriz < 0 || dt <= 0) ? 0 : Math.abs(body.torsoHoriz - m.prevHoriz)/(dt/1000);
  m.prevHoriz = body.torsoHoriz;

  if (!isProne(body, cal)){
    /* standing up mid-set is not a failed rep, it is leaving the exercise */
    m.proneT = 0; m.rest = 0;
    if (m.state !== 'IDLE') m.reset();
    return;
  }
  /* prone, but still rotating into or out of position: not settled, so the clock restarts */
  if (rate > C.proneSettleRate) m.proneT = 0;
  else m.proneT += dt;

  switch (m.state){
    case 'IDLE':
      /* A burpee passes through a brief prone phase on its way past. Requiring the body to have
         SETTLED into the position before a rep can even begin is what stops the middle of a
         burpee registering as a push-up — and settling is now tested by torso stability, not by
         shoulder height.

         There is deliberately NO height condition here. One used to be, and it was the whole
         bug: `pushDepth` at the top of a plank depends on forearm length, hand placement, camera
         tilt and distance, and a perfectly good plank measures 0.63 where the default threshold
         wanted 0.83. Such a player sat in IDLE forever and could not register a single push-up.
         Nothing is lost by dropping it: `rest` below converges on the top of the plank within a
         few frames wherever it happens to be, and a rep still has to travel `dropMin` to count,
         so starting the watch from the bottom cannot manufacture one. */
      if (m.proneT >= C.minProneMs){ m.state='UP'; m.stateT=0; m.rest=sy; }
      break;

    case 'UP':
      m.phase = 0;
      /* Track the resting plank height: fast upward, slow downward. Asymmetry is the whole
         point — the fast direction lets it find the top of the plank within a few frames, the
         slow direction means a descent cannot drag the reference down with it and swallow the
         rep it is supposed to be measuring. */
      m.rest += (sy - m.rest) * (sy > m.rest ? 0.25 : 0.02);
      if (sy < m.rest - C.dropMin*0.35){
        m.state='DESCENDING'; m.stateT=0; m.repT=0;
        m.lowest=sy; m.top=m.rest; m.phTop=sy; m.sawBottom=false; m.elbowSeen=false;
      }
      break;

    case 'DESCENDING':
      m.lowest = Math.min(m.lowest, sy);
      /* Two references, each doing one job. TRAVEL is measured from `top` — the resting plank —
         because that is the honest extent of the movement. PHASE spans from `phTop`, where
         reporting actually began, so the first progress event a wall sees is ~0 rather than an
         instant jump to wherever the trigger threshold happened to sit. Its bottom end is
         whichever of the calibrated threshold and a full `dropMin` of travel this body can
         actually reach, so the phase always spans a range that exists. */
      m.phase = span01(sy, m.phTop, Math.min(down, m.phTop - C.dropMin))*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (elbowLegible(body) && body.elbow < C.elbowDown) m.elbowSeen = true;
      /* Two ways to prove real depth, and either is enough: you reached the calibrated bottom,
         or you travelled far enough from your own top. One absolute and one relative, because
         a low plank clears the second and a high plank clears the first. */
      if (sy < down || (m.top - sy) >= C.dropMin){ m.state='DOWN'; m.stateT=0; }
      else if (sy > m.top*C.abortUpMul){
        /* Back above the top. Only call that a failure if they had actually committed to going
           down — the alternative is scolding someone for a shoulder-height wobble while they
           settle into the plank, which reads as the game being broken rather than strict. */
        if (m.top - m.lowest > C.dropMin*0.4) ev.reject = 'ALL THE WAY DOWN';
        m.reset(); m.state='UP'; m.rest = sy;
      }
      break;

    case 'DOWN':
      m.lowest = Math.min(m.lowest, sy);
      m.phase = 0.5;
      ev.progress = true; ev.phase = m.phase;
      if (m.stateT >= C.minBottomMs) m.sawBottom = true;
      if (elbowLegible(body) && body.elbow < C.elbowDown) m.elbowSeen = true;
      /* "started coming back up", as a fraction of THIS rep's own travel. `down*1.08` was the
         other absolute leak: a player whose bottom sits well below the calibrated threshold could
         never rise above it, so the machine stayed in DOWN for the rest of the set. */
      if (sy > m.lowest + (m.top - m.lowest)*0.12){
        if (!m.sawBottom){ ev.reject = 'PAUSE AT THE BOTTOM'; m.reset(); m.state='UP'; m.rest = sy; }
        else { m.state='ASCENDING'; m.stateT=0; }
      }
      break;

    case 'ASCENDING':
      m.phase = 0.5 + span01(sy, m.lowest, m.phTop)*0.5;
      ev.progress = true; ev.phase = m.phase;
      if (sy > topGate(m, up)){
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
        m.reset(); m.state='UP'; m.phase = 1; m.rest = sy;
      }
      break;
  }
}

/* ---- the live mirror: what shape is this body in RIGHT NOW ------------------------------
   Stateless by design. No history, no commitment, no rep — this only exists so the penguin is
   already going down while the machine above is still deciding whether a rep is happening.

   The weight comes from the TORSO ANGLE rather than from depth, because the penguin should be
   prone for the whole exercise including the top of the plank, where depth is zero. */
export function livePhase(m, body, cal){
  const w = span01(body.torsoHoriz, L.proneW[0], L.proneW[1]);
  if (w < L.minW) return null;
  const ref = m && m.rest > 0 ? m.rest : cal.pushupUpShoulder;
  return { u: span01(body.pushDepth, ref, cal.pushupDownShoulder)*0.5, w };
}
