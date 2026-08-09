/* =====================================================================================
   BODY — turns a Frame of landmarks into the handful of scale-free numbers the state
   machines reason about. This is the layer that makes the app work for a 1.5m user and a
   2m user, at 1.5m and 4m from the lens, on a phone propped at any angle.

   Every spatial quantity here is divided by a body-derived reference before it leaves.
   Nothing downstream ever sees a pixel or a raw normalized coordinate.
   ===================================================================================== */

import { LM, NEEDS, minVisOf, visOf } from './landmarks.js';

const D2R = Math.PI/180, R2D = 180/Math.PI;

export const dist2 = (a,b)=> Math.hypot(a.x-b.x, a.y-b.y);
export const dist3 = (a,b)=> Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);

/* the one shared angle helper: degrees at joint b, from the vectors a-b and c-b */
export function angleAt(a, b, c){
  const abx = a.x-b.x, aby = a.y-b.y, abz = a.z-b.z;
  const cbx = c.x-b.x, cby = c.y-b.y, cbz = c.z-b.z;
  const la = Math.hypot(abx,aby,abz), lc = Math.hypot(cbx,cby,cbz);
  if (la < 1e-9 || lc < 1e-9) return 180;
  let d = (abx*cbx + aby*cby + abz*cbz)/(la*lc);
  if (d > 1) d = 1; else if (d < -1) d = -1;
  return Math.acos(d)*R2D;
}

/* angle of the vector a->b away from vertical, and away from horizontal, in degrees */
export function fromVertical(a, b){
  const dy = Math.abs(b.y-a.y), dxz = Math.hypot(b.x-a.x, b.z-a.z);
  return Math.atan2(dxz, dy)*R2D;
}
export function fromHorizontal(a, b){
  const dy = Math.abs(b.y-a.y), dxz = Math.hypot(b.x-a.x, b.z-a.z);
  return Math.atan2(dy, dxz)*R2D;
}

const midInto = (o,a,b)=>{ o.x=(a.x+b.x)*0.5; o.y=(a.y+b.y)*0.5; o.z=(a.z+b.z)*0.5; return o; };

/* A Body is reused every frame — no allocation at inference rate. */
export function makeBody(){
  return {
    t:0, valid:false, dtMs:0,
    /* scale references, image space (framing / screen-relative logic) */
    shoulderW:1, torsoLen:1, legLen:1,
    /* joint angles, degrees, from the metric frame */
    kneeL:180, kneeR:180, knee:180,
    elbowL:180, elbowR:180, elbow:180,
    torsoTilt:0,        // deg from vertical: 0 = upright
    torsoHoriz:90,      // deg from horizontal: 0 = flat on the floor
    /* body-relative heights, in torso lengths, measured up from the ankles */
    shoulderY:1, hipY:1, wristY:1, noseY:1, ankleY:0,
    /* shoulder height above the planted hands, in SHOULDER WIDTHS. This is the push-up
       signal, and it exists because image-space torso length collapses to nothing when the
       torso points away from the lens — which is exactly the prone pose. Shoulder width is
       perpendicular to the view axis in every pose, so it shrinks with distance without
       collapsing with orientation, and the shoulder-to-wrist segment is short, near the
       camera and fully in-plane: the most legible thing a floor camera sees of a push-up. */
    pushDepth:1,
    /* lateral, in shoulder widths, screen-relative and signed: + is screen-right */
    hipX:0, ankleLX:0, ankleRX:0, ankleSpan:0,
    /* derived gates */
    wristsAboveShoulders:false, wristsAboveHead:false,
    /* descent from the calibrated standing baseline, in leg lengths (+ = lower) */
    hipDrop:0, ankleRise:0,
    /* the SAME rise, but against the jump machine's own self-seeded baseline, so it needs no
       calibration. Written by jump.js each frame; the burpee reads it to see its finishing hop,
       which used to require calibration and therefore could not happen on a first run. */
    jumpRise:0,
    /* per-exercise confidence */
    vis:{ squat:0, jack:0, lunge:0, pushup:0, burpee:0, frame:0 },
    visMin:{ squat:0, jack:0, lunge:0, pushup:0, burpee:0, frame:0 },
    /* scratch, so nothing allocates */
    _sh:{x:0,y:0,z:0}, _hp:{x:0,y:0,z:0}, _an:{x:0,y:0,z:0},
  };
}

/* Fill a Body from a Frame. `cal` supplies the standing baselines; before calibration the
   baselines are whatever it was constructed with, which makes the descent gates useless but
   never wrong. */
export function readBody(body, frame, cal){
  if (!frame.valid){ body.valid = false; return body; }
  /* Clamp the step. Timestamps are meant to be strictly monotonic, but a tab resume, a clock
     adjustment or a restarted stream can hand us a negative or enormous delta — and every
     machine integrates this, so one bad value can poison an accumulator permanently and
     silently stop counting reps. Same lesson as clamping a physics accumulator. */
  const raw = frame.t - body.t;
  body.dtMs = (raw > 0 && raw < 200) ? raw : (raw >= 200 ? 200 : 0);
  body.t = frame.t;

  const I = frame.img, W = frame.world;
  const sh = midInto(body._sh, I[LM.SHOULDER_L], I[LM.SHOULDER_R]);
  const hp = midInto(body._hp, I[LM.HIP_L], I[LM.HIP_R]);
  const an = midInto(body._an, I[LM.ANKLE_L], I[LM.ANKLE_R]);

  /* --- scale references. Image space on purpose: these normalise screen-relative numbers,
     and they have to shrink with distance in the same way the numbers they divide do. --- */
  body.shoulderW = Math.max(1e-4, dist2(I[LM.SHOULDER_L], I[LM.SHOULDER_R]));
  body.torsoLen  = Math.max(1e-4, dist2(sh, hp));
  body.legLen    = Math.max(1e-4,
      dist2(I[LM.HIP_L], I[LM.KNEE_L]) + dist2(I[LM.KNEE_L], I[LM.ANKLE_L]));

  /* --- joint angles, from the metric frame. A floor-mounted camera foreshortens the
     vertical axis hard, and angles taken in image space would drift with distance; the
     metric frame is what makes them hold still. --- */
  body.kneeL = angleAt(W[LM.HIP_L], W[LM.KNEE_L], W[LM.ANKLE_L]);
  body.kneeR = angleAt(W[LM.HIP_R], W[LM.KNEE_R], W[LM.ANKLE_R]);
  body.knee  = (body.kneeL + body.kneeR)*0.5;
  body.elbowL = angleAt(W[LM.SHOULDER_L], W[LM.ELBOW_L], W[LM.WRIST_L]);
  body.elbowR = angleAt(W[LM.SHOULDER_R], W[LM.ELBOW_R], W[LM.WRIST_R]);
  body.elbow  = (body.elbowL + body.elbowR)*0.5;

  const wsh = midInto({x:0,y:0,z:0}, W[LM.SHOULDER_L], W[LM.SHOULDER_R]);
  const whp = midInto({x:0,y:0,z:0}, W[LM.HIP_L], W[LM.HIP_R]);
  body.torsoTilt  = fromVertical(whp, wsh);
  body.torsoHoriz = fromHorizontal(whp, wsh);

  /* --- heights, in torso lengths above the ankles. Same-region-ish, and the ankle line is
     the one reference a floor camera sees most reliably. --- */
  const T = body.torsoLen;
  body.ankleY    = an.y;
  body.shoulderY = (sh.y - an.y)/T;
  body.hipY      = (hp.y - an.y)/T;
  body.noseY     = (I[LM.NOSE].y - an.y)/T;
  body.wristY    = (Math.max(I[LM.WRIST_L].y, I[LM.WRIST_R].y) - an.y)/T;

  /* prone-safe depth: shoulders above the hands, in shoulder widths */
  const wy = (I[LM.WRIST_L].y + I[LM.WRIST_R].y)*0.5;
  body.pushDepth = (sh.y - wy)/body.shoulderW;

  body.wristsAboveShoulders =
    (I[LM.WRIST_L].y - sh.y)/T > 0.02 && (I[LM.WRIST_R].y - sh.y)/T > 0.02;
  body.wristsAboveHead =
    (I[LM.WRIST_L].y - I[LM.NOSE].y)/T > 0.05 && (I[LM.WRIST_R].y - I[LM.NOSE].y)/T > 0.05;

  /* --- lateral, in shoulder widths, screen-relative. Never LEFT_/RIGHT_: a subject facing
     the camera has their left hand on the screen's right, so we take whichever ankle is
     further screen-left and let the labels look after themselves. --- */
  const S = body.shoulderW;
  const aL = Math.min(I[LM.ANKLE_L].x, I[LM.ANKLE_R].x);   // screen-left ankle
  const aR = Math.max(I[LM.ANKLE_L].x, I[LM.ANKLE_R].x);   // screen-right ankle
  body.hipX     = (hp.x - 0.5)/S;
  body.ankleLX  = (aL - hp.x)/S;                           // negative: out to screen-left
  body.ankleRX  = (aR - hp.x)/S;                           // positive: out to screen-right
  body.ankleSpan = (aR - aL)/S;

  /* --- descent from the calibrated standing baseline, in leg lengths --- */
  const Lg = body.legLen;
  body.hipDrop   = cal && cal.ready ? (cal.standHipY - (hp.y - an.y))/Lg : 0;
  body.ankleRise = cal && cal.ready ? (an.y - cal.standAnkleY)/Lg : 0;

  /* --- confidence, per exercise, over only the landmarks that exercise needs --- */
  for (const k of ['squat','jack','lunge','pushup','burpee','frame']){
    body.vis[k]    = visOf(frame, NEEDS[k]);
    body.visMin[k] = minVisOf(frame, NEEDS[k]);
  }
  body.valid = true;
  return body;
}

/* A running median, used by calibration. Never trust a single frame for a body measurement. */
export function median(arr){
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m-1]+a[m])*0.5;
}

/* map v from [a,b] to [0,1], clamped — the workhorse for turning an angle into a phase */
export function span01(v, a, b){
  if (Math.abs(b-a) < 1e-9) return 0;
  const t = (v-a)/(b-a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
