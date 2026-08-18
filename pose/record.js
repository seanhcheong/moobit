/* =====================================================================================
   TRACE RECORDER — capture a real body's landmark stream so thresholds can be fitted to it.

   WHY THIS EXISTS. Every threshold in this layer was fitted against synthetic bodies: anatomical
   skeletons projected through a pinhole camera in plain Node. That harness has been genuinely
   useful — it is deterministic, it runs in milliseconds, and it caught real bugs. But a synthetic
   body is a body somebody invented, and its noise is noise somebody invented. Real landmark noise
   is correlated across joints (the whole skeleton shifts together rather than each point rattling
   independently), it worsens in dim light, and it spikes when a limb crosses the torso. None of
   that is in the synthetic model, so none of the numbers in `config.js` have ever been checked
   against it.

   A player who says "it is spazzing out" cannot be expected to also say WHICH signal, by how much,
   at what frequency. This records it instead: press record, do the movement, download the file.
   The file replays offline through `detector.push` — the same entry point the camera drives — so
   the answer comes from measurement rather than from a guess about someone else's living room.

   WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT.

   Landmark coordinates: 33 points, image-space and metric, plus visibility. NOT video, and not
   because video would be a privacy problem to solve later — because the detector never sees video.
   It sees these numbers and nothing else, so these numbers are a COMPLETE record of its input.
   Recording pixels would capture something no threshold depends on, and would be the one artifact
   here that could identify a person or their room.

   THE RAW RESULT, NOT THE SMOOTHED FRAME. `adapt` flips Y and fills in absent visibility;
   `Smooth.apply` then mutates the frame in place. Recording post-smoothing would bake today's
   filter constants into the trace permanently, which defeats the entire purpose — the first
   question to ask of a real trace is whether those constants are right. So the capture happens at
   the top of `push`, from MediaPipe's own output, and replay enters through the same door the
   camera does. Change `fcMin` and re-replay the same file, and you see what the change would have
   done to a movement a real person actually performed.

   THE DERIVED SIGNALS ARE RECORDED TOO, even though replay recomputes all of them from the
   landmarks and could therefore be expected to agree. That redundancy is the point: it is an
   invariant. If a replay of a trace disagrees with what the live session recorded alongside it,
   then the record/replay path itself is lying, and every conclusion drawn from it is void. This
   project has been bitten repeatedly by harnesses that confidently measured the wrong thing —
   synthetic jumping jacks that never left the ground, a parameter that was destructured and never
   used, a world stepped twice per frame. A cheap self-check that fails loudly is worth its bytes.

   A RING BUFFER, NOT A LOG. Two situations need this tool and they want opposite things. A
   controlled test ("hold still for twenty seconds") wants everything from the moment recording
   started. Noticing a glitch mid-run wants the last minute leading up to now — by the time a
   player has registered that the penguin jumped on its own, the frames that explain it are already
   past. A ring keeps the most recent N frames and so serves both: any test shorter than the
   capacity is contained whole, and a long session always retains the run-up to whatever just went
   wrong. `dropped` reports what fell off the back, so a truncated trace can never be mistaken for
   a complete one.

   ZERO ALLOCATION while recording. The landmark block is one pre-allocated Float32Array and the
   per-frame metadata is a pre-allocated pool of row objects, both sized at create time. Recording
   is a diagnostic, but a diagnostic that adds a GC pause at inference rate would change the very
   timing it exists to measure.
   ===================================================================================== */

import { CONFIG, defaultCalibration } from './config.js';

const N = 33;                     // BlazePose topology; see landmarks.js
const IMG_STRIDE   = N * 4;       // x, y, z, visibility
const WORLD_STRIDE = N * 3;       // x, y, z
const STRIDE = IMG_STRIDE + WORLD_STRIDE;

/* The body-derived scalars worth keeping, in a fixed order. Everything a threshold in `config.js`
   is compared against should appear here — otherwise a trace cannot answer whether that threshold
   is right. Order is part of the file format; append, never reorder. */
export const DERIVED = [
  'shoulderW','torsoLen','legLen',
  'kneeL','kneeR','knee','kneeStraight',
  'elbowL','elbowR','elbow',
  'torsoTilt','torsoHoriz',
  'shoulderY','hipY','wristY','noseY','ankleY','pushDepth',
  'hipX','ankleLX','ankleRX','ankleSpan','ankleSplit','ankleAlt','ankleSpanVel',
  'cadence','noseOff','msSinceProne','hipDrop','ankleRise','jumpRise',
];

/* How much precision to keep on the way out. Image-space landmarks are normalised 0..1, so four
   decimals is a tenth of a pixel on a 1000px frame; the metric frame is in metres, so four
   decimals is a tenth of a millimetre. Both are far below the noise floor this file exists to
   measure, and the rounding roughly halves the download. */
const DP = 4;
const r4 = (v)=> Math.round(v * 1e4) / 1e4;
const r3 = (v)=> Math.round(v * 1e3) / 1e3;

function makeRow(){
  return {
    used:false, valid:false, t:0,
    /* ARRIVAL order, as distinct from `t` which is CAPTURE order. Both are needed and they are not
       the same sequence: inference is asynchronous, so a result can come back after one captured
       later than it. The live session's state evolved in arrival order — a filter re-seed, a machine
       reset, a dwell timer — so a replay that follows capture order reproduces a session that never
       happened. Analysis wants the timeline; replay wants the order the detector really saw. */
    seq:0,
    /* what the detector concluded, so replay can be checked against it */
    track:'', want:0, bodyValid:false,
    /* derived body scalars, parallel to DERIVED */
    d: new Float32Array(DERIVED.length),
    /* event edges and levels */
    step:false, cadence:0, jump:false, jumpHold:-1, lane:0, crouch:false,
    progress:false, phase:0, completed:false, form:0, reject:'',
    live:false, liveU:0, liveW:0,
    /* machine states — low-cardinality interned string constants, so storing them costs a
       reference and nothing else */
    repState:'', jumpState:'', lungeState:'',
    /* per-exercise confidence for whichever exercise was active: the number that decides whether
       the world freezes, and therefore the first thing to look at when it froze */
    visMin:0, visMean:0,
  };
}

/* ---- GROUND TRUTH ----------------------------------------------------------------------
   A trace on its own says what the detector concluded. It cannot say whether that was RIGHT, because
   nothing in the file records what the player was actually doing. So while recording, somebody taps a
   button as the movement happens — jump, duck, turn, run — and those taps go in beside the landmarks.
   With them, precision and recall become computable and tuning stops being an argument about what
   looked about right.

   THE ONE THING THESE ARE NOT GOOD FOR. A human tap carries 200-400ms of reaction latency, and no
   amount of care removes it. So labels answer "did this movement register at all, and how many things
   fired that were not movements" — counting questions, which is what tuning a threshold needs. They
   cannot answer "did it fire at takeoff or at the apex", because the reference is looser than the
   quantity being measured. Latency needs a different instrument and this is not it. */
export const LABELS = ['jump', 'duck', 'turn-left', 'turn-right', 'run-start', 'run-stop'];

/* `seconds` is a hint; capacity is frames, because inference rate is not knowable in advance and
   a trace that silently held a different duration than requested would be worse than one that
   states its capacity outright. 30fps is the optimistic case on a phone. */
export function create(opts){
  const o = opts || {};
  const cap = Math.max(60, Math.min(20000, o.frames || Math.round((o.seconds || 60) * 30)));
  const rows = new Array(cap);
  for (let i=0;i<cap;i++) rows[i] = makeRow();
  return {
    cap, rows,
    lm: new Float32Array(cap * STRIDE),
    head: 0,           // next slot to write
    count: 0,          // how many slots hold data (<= cap)
    dropped: 0,        // frames overwritten by the ring — a truncation marker
    cur: -1,           // slot claimed by input(), stamped by output()
    seq: 0,            // monotonic arrival counter, never reset by the ring wrapping
    /* the body fit this trace was recorded under, and whether it moved while recording */
    calFp: null, calDrift: false,
    on: true,
    t0: -1,            // capture timestamp of the first recorded frame
    note: o.note || '',
    meta: o.meta || null,
    /* ground-truth taps, oldest first. A plain array: these arrive at human speed — a few per second
       at the very most — so the zero-allocation discipline the frame path needs does not apply, and a
       ring would risk silently dropping the evidence a trace exists to carry. Capped only to bound a
       stuck finger. */
    labels: [],
  };
}

/* Mark that a movement really happened, now. `tMs` should be the same clock the frames use, so the
   label lands on the timeline rather than near it. */
export function label(rec, kind, tMs){
  if (!rec.on) return false;
  if (rec.labels.length >= 4000) return false;
  rec.labels.push({ kind, t: tMs });
  return true;
}

export function clear(rec){
  rec.labels.length = 0;
  rec.head = 0; rec.count = 0; rec.dropped = 0; rec.cur = -1; rec.t0 = -1;
  rec.seq = 0; rec.calFp = null; rec.calDrift = false;
  for (let i=0;i<rec.cap;i++) rec.rows[i].used = false;
}

/* ---- capture: two halves, because `push` has early returns ------------------------------
   `input` claims a slot and stores what MediaPipe produced. `output` stamps what the detector made
   of it. They are separate calls because `push` returns early on a lost body and on an unreadable
   one, and those are precisely the frames a dropout complaint needs — a single call at the end
   would omit exactly the evidence. Anything `output` never reaches keeps `bodyValid:false`, which
   is itself the finding. */
export function input(rec, res, tMs){
  if (!rec.on) return;
  const i = rec.head;
  rec.cur = i;
  rec.head = (i + 1) % rec.cap;
  if (rec.count < rec.cap) rec.count++; else rec.dropped++;

  const row = rec.rows[i];
  row.used = true; row.t = tMs; row.seq = rec.seq++;
  /* reset the conclusion fields: this slot may hold a previous lap's data, and a stale event
     would read as a real one */
  row.track = ''; row.want = 0; row.bodyValid = false;
  row.step = false; row.cadence = 0; row.jump = false; row.jumpHold = -1;
  row.lane = 0; row.crouch = false;
  row.progress = false; row.phase = 0; row.completed = false; row.form = 0; row.reject = '';
  row.live = false; row.liveU = 0; row.liveW = 0;
  row.repState = ''; row.jumpState = ''; row.lungeState = '';
  row.visMin = 0; row.visMean = 0;
  if (rec.t0 < 0) rec.t0 = tMs;

  const L = res && res.landmarks && res.landmarks[0];
  const W = res && res.worldLandmarks && res.worldLandmarks[0];
  if (!L || L.length < N){ row.valid = false; return; }
  row.valid = true;

  const lm = rec.lm;
  let p = i * STRIDE;
  for (let k=0;k<N;k++){
    const s = L[k];
    lm[p++] = s.x;
    lm[p++] = s.y;                                          // RAW: adapt() owns the Y flip
    lm[p++] = s.z === undefined ? 0 : s.z;
    lm[p++] = s.visibility === undefined ? 1 : s.visibility; // absent means reported, not invisible
  }
  const haveW = W && W.length >= N;
  for (let k=0;k<N;k++){
    const s = haveW ? W[k] : null;
    lm[p++] = s ? s.x : 0;
    lm[p++] = s ? s.y : 0;
    lm[p++] = s ? (s.z === undefined ? 0 : s.z) : 0;
  }
  /* A frame with image landmarks but no world landmarks is a real MediaPipe case that `adapt`
     handles by falling back to image space. Marking it lets replay reproduce that fallback
     instead of feeding zeros into every angle. */
  row.noWorld = !haveW;
}

/* A cheap fingerprint of the body fit, to catch it CHANGING mid-recording.

   This matters because a trace carries ONE calibration and replay applies it to every frame. During
   the onboarding stages the calibrator rewrites `cal` on each frame as it learns the body, so a
   trace spanning that would be replayed under the final fit while the live session used a moving
   one — and the fidelity check would fail with no indication of why. Outside calibration `cal` is
   fixed, so this is normally constant and costs an addition per frame. When it is not constant, the
   trace says so instead of quietly disagreeing with itself. */
function calPrint(cal){
  if (!cal) return 0;
  return (cal.ready ? 1 : 0) + (cal.squatBottomKnee || 0) + (cal.crouchKnee || 0)
       + (cal.turnRatio || 0)*1000 + (cal.cadFull || 0)*100 + (cal.swSquare || 0)*10
       + (cal.jackOpenSpan || 0)*7 + (cal.standHipY || 0)*13;
}

export function output(rec, d, ev){
  if (!rec.on || rec.cur < 0) return;
  const row = rec.rows[rec.cur];
  const b = d.body;
  const fp = calPrint(d.cal);
  if (rec.calFp === null) rec.calFp = fp;
  else if (fp !== rec.calFp) rec.calDrift = true;
  row.track = d.track; row.want = d.want; row.bodyValid = !!b.valid;
  for (let i=0;i<DERIVED.length;i++) row.d[i] = b[DERIVED[i]];
  row.step = !!ev.step; row.cadence = ev.cadence;
  row.jump = !!ev.jump;
  row.jumpHold = ev.jumpHold === null ? -1 : (ev.jumpHold ? 1 : 0);
  row.lane = ev.lane; row.crouch = !!ev.crouch;
  row.progress = !!ev.progress; row.phase = ev.phase;
  row.completed = !!ev.completed; row.form = ev.form; row.reject = ev.reject || '';
  row.live = !!ev.live; row.liveU = ev.liveU; row.liveW = ev.liveW;
  const m = d.mach[d.want];
  row.repState = m ? m.state : '';
  row.jumpState = d.jumpM.state; row.lungeState = d.lunge.state;
  row.visMin = b.visMin ? (b.visMin.frame || 0) : 0;
  row.visMean = b.vis ? (b.vis.frame || 0) : 0;
  rec.cur = -1;
}

/* ---- read back, in CAPTURE order -------------------------------------------------------
   Not arrival order, which is what the ring holds. Inference is asynchronous and its results can
   come back out of order relative to the capture timestamps they carry — the entire pose layer
   already reasons in capture-ms rather than frame counts for exactly this reason. A real trace
   caught it: two results arrived after a later batch while stamped ~7 seconds earlier, which made
   `last - first` read as 106ms for a 7-second recording. Every duration, every fps, and every
   window derived from it was then wrong, and the replay script indexed past the end of the array
   and crashed.

   So the buffer keeps arrival order (that is what "the last 90 seconds" means for a ring) and
   everything that reads it works on a timeline. `outOfOrder` reports how many needed moving, since
   a trace full of them says something real about the device. */
function order(rec){
  const out = [];
  const start = rec.count < rec.cap ? 0 : rec.head;
  for (let k=0;k<rec.count;k++){
    const i = (start + k) % rec.cap;
    if (rec.rows[i].used) out.push(i);
  }
  out.sort((a,b)=> rec.rows[a].t - rec.rows[b].t);
  return out;
}

/* how many arrived later than a frame captured after them */
function outOfOrderCount(rec){
  const start = rec.count < rec.cap ? 0 : rec.head;
  let n = 0, prev = -Infinity;
  for (let k=0;k<rec.count;k++){
    const r = rec.rows[(start + k) % rec.cap];
    if (!r.used) continue;
    if (r.t < prev) n++; else prev = r.t;
  }
  return n;
}

export function stats(rec){
  const idx = order(rec);
  if (!idx.length) return { frames:0, seconds:0, dropped:rec.dropped, fps:0, bytes:0, outOfOrder:0 };
  /* min and max, not first and last: `idx` is sorted, but saying so here keeps this correct even if
     that ever changes */
  const seconds = Math.max(0, (rec.rows[idx[idx.length-1]].t - rec.rows[idx[0]].t) / 1000);
  return {
    frames: idx.length,
    seconds: +seconds.toFixed(1),
    dropped: rec.dropped,
    fps: seconds > 0 ? +(idx.length / seconds).toFixed(1) : 0,
    /* the landmark block dominates and rounds to roughly 7 characters per number */
    bytes: idx.length * STRIDE * 7,
    outOfOrder: outOfOrderCount(rec),
  };
}

/* Serialise to the trace format. A plain object, so the caller decides whether it becomes a
   download, a fetch body, or a string in a test. */
export function toTrace(rec){
  const idx = order(rec);
  const lm = rec.lm;
  const frames = new Array(idx.length);
  for (let k=0;k<idx.length;k++){
    const i = idx[k];
    const row = rec.rows[i];
    const f = { t: Math.round(row.t * 100) / 100, seq: row.seq, valid: row.valid };
    if (row.valid){
      const img = new Array(IMG_STRIDE), world = new Array(WORLD_STRIDE);
      let p = i * STRIDE;
      for (let j=0;j<IMG_STRIDE;j++) img[j] = r4(lm[p++]);
      for (let j=0;j<WORLD_STRIDE;j++) world[j] = r4(lm[p++]);
      f.img = img;
      if (!row.noWorld) f.world = world;    // absent => adapt()'s image-space fallback, faithfully
    }
    /* what the live session concluded — replay is checked against this, not trusted over it */
    f.live = {
      track: row.track, want: row.want, bodyValid: row.bodyValid,
      d: Array.from(row.d, r4),
      step: row.step, cadence: r3(row.cadence), jump: row.jump, jumpHold: row.jumpHold,
      lane: row.lane, crouch: row.crouch,
      progress: row.progress, phase: r3(row.phase),
      completed: row.completed, form: r3(row.form), reject: row.reject,
      liveW: r3(row.liveW), liveU: r3(row.liveU),
      repState: row.repState, jumpState: row.jumpState, lungeState: row.lungeState,
      visMin: r3(row.visMin), visMean: r3(row.visMean),
    };
    frames[k] = f;
  }
  return {
    format: 'belt-runner-pose-trace',
    version: 1,
    note: rec.note,
    dropped: rec.dropped,
    /* frames whose results came back after a later capture. Emitted in capture order regardless,
       so a consumer never has to know — but worth carrying, because a device doing a lot of it is
       a device whose timing is worth looking at. */
    outOfOrder: outOfOrderCount(rec),
    /* true if the body fit changed while recording — replay applies one fit to every frame, so a
       trace with this set cannot be reproduced exactly and the report has to say so */
    calDrift: rec.calDrift,
    derived: DERIVED,
    /* what the player says they did, against which what the detector said can be scored */
    labels: rec.labels.slice().sort((a,b)=> a.t - b.t),
    /* The thresholds and the body fit that produced the `live` values. Without these a trace
       cannot be reproduced: the same landmarks under different constants are a different session,
       and a replay that quietly used today's defaults would compare two unrelated things. */
    config: CONFIG,
    calibration: rec.meta && rec.meta.calibration ? rec.meta.calibration : defaultCalibration(),
    device: rec.meta && rec.meta.device ? rec.meta.device : null,
    frames,
  };
}
