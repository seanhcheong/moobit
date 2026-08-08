/* =====================================================================================
   LANDMARKS — the one and only place that knows what MediaPipe's output looks like.

   ### Mirroring lives here, and only here.

   Left/right inversion is the most common bug in this class of app, and here it means lane
   changes going the wrong way, which is the most infuriating possible failure. So:

     - The camera PREVIEW is mirrored in CSS. Users expect a mirror. That is presentation.
     - The landmark DATA is never mirrored. Not here, not downstream, nowhere.
     - Instead this adapter converts once into an explicit screen-space frame, and every
       rule downstream is written against that frame by name (`screenX`), never against
       MediaPipe's `LEFT_`/`RIGHT_` labels.

   MediaPipe's LEFT_* / RIGHT_* refer to the SUBJECT's left and right, not the screen's. A
   person facing the camera has their left hand on the screen's right. Downstream code must
   never reason about which is which; it asks for `leftmostAnkle` / `rightmostAnkle` in
   screen terms and gets an answer that is correct regardless.

   ### Vertical convention

   MediaPipe image-space landmarks have y increasing DOWNWARD. Every rule in this codebase
   wants y increasing UPWARD, because "the hips dropped" should be a negative number going
   negative, not a positive number going positive. So this adapter flips y exactly once, in
   `adapt()`, and every consumer works in a y-up frame. If the source convention ever turns
   out to differ, `FLIP_Y` below is the single place to change.
   ===================================================================================== */

/* BlazePose 33-point topology, by index. */
export const LM = {
  NOSE:0,
  EYE_INNER_L:1, EYE_L:2, EYE_OUTER_L:3,
  EYE_INNER_R:4, EYE_R:5, EYE_OUTER_R:6,
  EAR_L:7, EAR_R:8,
  MOUTH_L:9, MOUTH_R:10,
  SHOULDER_L:11, SHOULDER_R:12,
  ELBOW_L:13, ELBOW_R:14,
  WRIST_L:15, WRIST_R:16,
  PINKY_L:17, PINKY_R:18,
  INDEX_L:19, INDEX_R:20,
  THUMB_L:21, THUMB_R:22,
  HIP_L:23, HIP_R:24,
  KNEE_L:25, KNEE_R:26,
  ANKLE_L:27, ANKLE_R:28,
  HEEL_L:29, HEEL_R:30,
  FOOT_L:31, FOOT_R:32,
};
export const LM_COUNT = 33;

/* image-space y grows downward in the source; every rule here wants it growing upward */
const FLIP_Y = true;

/* Landmark sets each exercise genuinely depends on. The visibility gate is computed over
   these and never over all 33 — a push-up legitimately loses the ankles, and failing the
   player for that would be absurd. */
export const NEEDS = {
  squat:  [LM.HIP_L, LM.HIP_R, LM.KNEE_L, LM.KNEE_R, LM.ANKLE_L, LM.ANKLE_R,
           LM.SHOULDER_L, LM.SHOULDER_R],
  jack:   [LM.SHOULDER_L, LM.SHOULDER_R, LM.WRIST_L, LM.WRIST_R,
           LM.ANKLE_L, LM.ANKLE_R, LM.HIP_L, LM.HIP_R],
  lunge:  [LM.HIP_L, LM.HIP_R, LM.ANKLE_L, LM.ANKLE_R, LM.KNEE_L, LM.KNEE_R,
           LM.SHOULDER_L, LM.SHOULDER_R],
  pushup: [LM.SHOULDER_L, LM.SHOULDER_R, LM.HIP_L, LM.HIP_R,
           LM.ELBOW_L, LM.ELBOW_R, LM.WRIST_L, LM.WRIST_R],
  burpee: [LM.SHOULDER_L, LM.SHOULDER_R, LM.HIP_L, LM.HIP_R,
           LM.KNEE_L, LM.KNEE_R, LM.ANKLE_L, LM.ANKLE_R, LM.WRIST_L, LM.WRIST_R],
  frame:  [LM.ANKLE_L, LM.ANKLE_R, LM.WRIST_L, LM.WRIST_R, LM.HIP_L, LM.HIP_R, LM.NOSE],
};

/* A Frame is what everything downstream consumes. Two coordinate sets, kept explicitly
   separate because mixing them is the other classic bug here:

     img[i]    = {x, y, z, v}  normalized image space, y UP after the flip. Use for framing,
                               visibility, and anything screen-relative.
     world[i]  = {x, y, z}     metric-ish, hip-origin, y UP. Use for joint angles, which is
                               the only place a metric frame is actually needed.

   A floor-mounted camera angled up makes this distinction matter more, not less: your feet
   are near the lens and your shoulders are far, so an image-space ratio that mixes the two
   regions drifts with distance. Angles from `world` do not.
*/
export function makeFrame(){
  const img = new Array(LM_COUNT), world = new Array(LM_COUNT);
  for (let i=0;i<LM_COUNT;i++){ img[i] = {x:0,y:0,z:0,v:0}; world[i] = {x:0,y:0,z:0}; }
  return { t:0, img, world, valid:false };
}

/* Convert one MediaPipe PoseLandmarkerResult into a Frame, in place. Zero allocation, so
   this is safe to call at inference rate forever.

   `res.landmarks[0]` and `res.worldLandmarks[0]` are the arrays MediaPipe hands back.
   Anything missing leaves the frame invalid rather than half-filled. */
export function adapt(frame, res, tMs){
  const L = res && res.landmarks && res.landmarks[0];
  const W = res && res.worldLandmarks && res.worldLandmarks[0];
  if (!L || L.length < LM_COUNT){ frame.valid = false; return frame; }
  frame.t = tMs;
  for (let i=0;i<LM_COUNT;i++){
    const s = L[i], d = frame.img[i];
    d.x = s.x;
    d.y = FLIP_Y ? (1 - s.y) : s.y;
    d.z = s.z === undefined ? 0 : s.z;
    /* MediaPipe omits `visibility` on some builds; absent means "reported", not "invisible" */
    d.v = (s.visibility === undefined) ? 1 : s.visibility;
  }
  if (W && W.length >= LM_COUNT){
    for (let i=0;i<LM_COUNT;i++){
      const s = W[i], d = frame.world[i];
      d.x = s.x;
      d.y = FLIP_Y ? -s.y : s.y;
      d.z = s.z === undefined ? 0 : s.z;
    }
  } else {
    /* No world landmarks: fall back to image space for angles. Less accurate, still usable,
       and better than freezing the whole detector. */
    for (let i=0;i<LM_COUNT;i++){
      const s = frame.img[i], d = frame.world[i];
      d.x = s.x; d.y = s.y; d.z = s.z;
    }
  }
  frame.valid = true;
  return frame;
}

/* --- screen-relative accessors: downstream never touches LEFT_/RIGHT_ for lateral logic --- */
export const screenLeftAnkle  = (f)=> f.img[LM.ANKLE_L].x <= f.img[LM.ANKLE_R].x ? LM.ANKLE_L : LM.ANKLE_R;
export const screenRightAnkle = (f)=> f.img[LM.ANKLE_L].x >  f.img[LM.ANKLE_R].x ? LM.ANKLE_L : LM.ANKLE_R;

/* Mean visibility over the landmarks one exercise actually needs. */
export function visOf(frame, need){
  let s = 0;
  for (let i=0;i<need.length;i++) s += frame.img[need[i]].v;
  return need.length ? s/need.length : 0;
}
/* The weakest link, which is what a gate should test rather than the mean. */
export function minVisOf(frame, need){
  let m = 1;
  for (let i=0;i<need.length;i++) m = Math.min(m, frame.img[need[i]].v);
  return m;
}
