/* =====================================================================================
   NOISE FLOOR — measure how much of each signal is the camera rather than the body.

   WHY THIS IS THE MOST USEFUL NUMBER IN THE LAYER. Every threshold in `config.js` is an absolute
   value: a knee below 140 degrees is a crouch, an alternation above 0.07 is running. Absolute
   numbers are the wrong shape for the problem. The same threshold on a quiet camera in good light
   and on a noisy one in a dim room is two completely different thresholds, because in one case the
   noise is nowhere near it and in the other the noise crosses it by itself. That is exactly what a
   player means when they say the detection is "spazzing out" — not that a threshold is misplaced,
   but that noise is crossing it wherever it sits.

   So measure the noise, and then a threshold can be expressed as a multiple of it. "Three sigma
   above this body's own measured jitter" adapts to the camera, the lighting and the clothing.
   "0.07" does not.

   THE ESTIMATOR: SECOND DIFFERENCE, NOT STANDARD DEVIATION.

   The obvious approach — ask the player to hold still and take the SD of each landmark over the
   window — measures the wrong thing. Standing still for four seconds, a hip landmark's SD is
   dominated by postural sway, which is the person, not the camera. You would report a steady player
   in a dim room as quieter than a swaying player in good light, which inverts the answer.

   For a signal x = s + n, where s is the true smooth trajectory and n is white noise of standard
   deviation sigma, the second difference

       d2[t] = x[t-1] - 2*x[t] + x[t+1]

   cancels s exactly up to its curvature — any constant or linear drift vanishes — and has variance
   6*sigma^2. So sigma = std(d2)/sqrt(6), and slow sway contributes almost nothing. This is the same
   estimator `scripts/replay-trace.mjs` uses offline, where it recovers an injected sigma to within
   5% across 0.002 to 0.012.

   A MEDIAN, NOT A MEAN, so it can run continuously.

   A one-shot "hold still for two seconds" capture has two problems: it costs the player time, and it
   goes stale the moment the light changes. This instead keeps a rolling window and reports the
   MEDIAN absolute second difference, which for a Gaussian relates to sigma by a constant:

       median|d2| = 0.6745 * std(d2) = 0.6745 * sqrt(6) * sigma  =>  sigma = median|d2| / 1.6520

   The median is what makes it robust enough to leave running. A window that is mostly still with a
   little movement in it still reports the still part, because more than half the samples are quiet.
   Measured: slow and moderate movement does not disturb it at all — see the note above `chan`, where
   a squat reads 1.00x and only fast limb reversals inflate it. That is what removes the need for a
   "hold still and press calibrate" step, and it is why a windowed minimum sits on top.

   RAW LANDMARKS, FILTERED CHANNELS — and the distinction matters.

   Landmark noise is measured BEFORE `Smooth.apply`, because the question is what the camera
   delivers; measuring after the filter would report the filter's residual and could never tell you
   whether the filter is doing enough. Derived channels are measured AFTER, because a threshold is
   compared against the filtered value, so what a threshold contends with is post-filter noise.
   Both are wanted, and they answer different questions:

     the landmark floor    is this camera, in this light, quiet or not
     the channel floor     is a given threshold far enough above the noise to mean anything
   ===================================================================================== */

import { CONFIG } from './config.js';

const C = CONFIG.noise;
const N = 33;

/* median|d2| -> sigma, for Gaussian noise. 0.6745 is the standard normal's quartile, sqrt(6) is the
   second difference's variance inflation. Named rather than inlined because it is the one constant
   here that is not obvious from the surrounding code. */
const MED_TO_SIGMA = 1 / (0.6745 * Math.sqrt(6));

/* The derived channels worth a noise figure: every one that a threshold in `config.js` is compared
   against. A channel nothing thresholds does not need one. */
export const CHANNELS = [
  'hipX', 'hipY', 'ankleSplit', 'ankleAlt', 'ankleSpan', 'ankleSpanVel',
  'kneeStraight', 'knee', 'elbow', 'shoulderW', 'noseOff', 'pushDepth', 'jumpRise',
];

/* ---- TWO measures, because thresholds come in two shapes ---------------------------------
   The second difference above measures CURVATURE: how much the signal rattles frame to frame. That
   is the right description of a camera's noise and it is what the filter is judged against.

   It is the WRONG measure for an amplitude gate, and the numbers say so plainly. Measured at
   landmark noise 0.012 with the filter on, standing perfectly still:

       median |ankleSplit|  0.0169     the filtered noise, robustly
       p90                  0.0397
       MAX over 18s         0.0978     nearly 2x the 0.05 gate it has to not cross
       3 sigma from d2      0.0298     which leaves the 0.05 gate untouched

   So a gate floored on the second difference stays at 0.05 while the noise reaches 0.098, and 22
   phantom steps per 20 motionless seconds walk straight through. The reason is that a low-pass
   filter does not remove noise so much as move it DOWN in frequency: what comes out is slow wander
   with real amplitude, and slow wander is exactly what a second difference is built to ignore.

   Hence an amplitude measure alongside it, for the channels whose value at rest is about zero — for
   those, a robust magnitude IS the noise, and body sway cancels in any left-minus-right difference.
   `median|v| = 0.6745*sigma` for a Gaussian, the same constant as before, used the other way round.
   A channel like `kneeStraight` sits at 175 degrees at rest, so its magnitude means nothing and it
   gets no amplitude figure. */
export const AMP_CHANNELS = [
  'ankleSplit', 'ankleAlt', 'ankleSpanVel', 'hipX', 'noseOff', 'jumpRise',
];

/* ---- WHY THE AMPLITUDE MEASURE IS CAPTURED ON REQUEST AND THE CURVATURE ONE RUNS ALWAYS ----
   The curvature floor can run continuously because movement barely registers in a second difference.
   The amplitude measure cannot, and two attempts to make it failed in ways worth recording, because
   both looked obviously right.

   ATTEMPT 1 — a windowed minimum, no stillness test. A running body's |ankleSplit| genuinely IS large,
   so with no quiet stretch anywhere in the window the minimum reports the SIGNAL as the noise.
   Measured, zero injected noise, 40 seconds of continuous running:

       ankleSplit amplitude floor   0.1474   ->  gate 0.663 against a fixed 0.05
       cadence                      0.00     ->  running no longer detected at all

   ATTEMPT 2 — gate it on a stillness test built from per-frame landmark movement. Two things wrong:
   the bar was built on the live curvature sigma, which movement inflates, so faster running looked
   STILLER (a first difference grows with frequency, a second with its square); and the statistic was a
   mean over nine landmarks, which dilutes the moving ankles with the stationary nose and hips.

   Both fixed, and then the measurement said the whole approach cannot work. Movement, as a multiple of
   the landmark floor, for the loudest tracked point:

       jitter      still   run 1.6   run 2.6   run 3.8
       0.002        5.2      6.5       8.2      10.9      separable
       0.004        5.2      5.5       6.2       6.6      marginal
       0.008        5.2      5.3       5.4       5.5      no
       0.012        5.2      5.3       5.3       5.3      no

   At realistic noise the camera's own frame-to-frame movement is LARGER than a running ankle's, so no
   statistic built on single-frame differences can tell running from standing. The signal is only
   recoverable because it is coherent across frames while the noise is not, and a difference of two
   samples cannot see coherence. The instrument was wrong, not the tuning.

   SO: the amplitude floor is captured during a window in which the player has been ASKED to hold
   still — the framing and A-pose stages of onboarding already are such a window, and the tuning tool
   has a button for it — and then stored on the calibration alongside every other per-body measurement.
   Which is what the original design called for before this was over-engineered into running always.

   The residual risk is a player who moves during the capture. Three things bound it: the instruction
   itself, `floorOf`'s hard cap at `capMul` times the fixed threshold, and the number being displayed
   where a person can see that it is absurd. `motion` is still computed and reported so a capture can
   be judged after the fact, but it is not trusted to gate anything — see the table above. */
const KEY_LM = [0, 11, 12, 23, 24, 25, 26, 27, 28];   // nose, shoulders, hips, knees, ankles
const IS_AMP = new Set(AMP_CHANNELS);
/* median|v| -> sigma. The inverse of the relation used for the second difference, without the
   sqrt(6): this is the magnitude of the value itself, not of a difference of three of them. */
const MED_ABS_TO_SIGMA = 1/0.6745;

/* ---- why a windowed MINIMUM sits on top of the median ------------------------------------
   The median over a few seconds is exact for a still body and, measured, survives slow movement
   untouched: a 0.5Hz squat and a 1.0Hz squat both leave a 0.0040 floor reading 0.0040. That is the
   second difference being a high-pass — a sinusoid of amplitude A and frequency f contributes at most
   A*(2*pi*f)^2*dt^2, which at 30fps for a squat is about six times SMALLER than the noise it sits on.

   But a jumping jack inflates it 2.19x, measured. Fast limb reversals are exactly the high-frequency
   content the second difference is sensitive to, and no robust statistic within a 4-second window can
   separate them from noise when they happen twice a second throughout it.

   So: the median gives the noise in the last few seconds, and the FLOOR is the minimum of those
   medians over a much longer horizon. Any few seconds of stillness or slow movement in the last half
   minute pins it correctly, and it can never over-report — a minimum only errs downward, and erring
   downward on a noise floor means a threshold derived from it stays where it was rather than becoming
   spuriously strict. A window rather than a running minimum, so that a room getting darker can push
   the floor back UP instead of being remembered as quiet forever.

   Two numbers come out, and they are for different readers:

     now     the last few seconds. What a person watches to see the light get worse.
     floor   the best of the last half minute. What a threshold should be built on.
*/

/* one rolling window of |d2| samples, plus the two previous values needed to form the next one, plus
   the longer ring of periodic sigma samples the floor is the minimum of */
function chan(cap, fcap, amp){
  const c = { buf: new Float32Array(cap), n: 0, head: 0, p1: 0, p2: 0, have: 0,
              fbuf: new Float32Array(fcap), fn: 0, fhead: 0 };
  if (amp){
    /* the value's own magnitude, and its own floor ring — see AMP_CHANNELS */
    c.abuf = new Float32Array(cap); c.an = 0; c.ahead = 0;
    c.afbuf = new Float32Array(fcap); c.afn = 0; c.afhead = 0;
  }
  return c;
}
function feedAmp(c, v, cap){
  if (!c.abuf) return;
  c.abuf[c.ahead] = Math.abs(v);
  c.ahead = (c.ahead + 1) % cap;
  if (c.an < cap) c.an++;
}
function feedAmpFloor(c, sigma, fcap){
  if (!c.afbuf) return;
  c.afbuf[c.afhead] = sigma;
  c.afhead = (c.afhead + 1) % fcap;
  if (c.afn < fcap) c.afn++;
}
function ampFloorOf(c){
  if (!c.afbuf || !c.afn) return 0;
  let m = Infinity;
  for (let i=0;i<c.afn;i++){ const v = c.afbuf[i]; if (v > 0 && v < m) m = v; }
  return Number.isFinite(m) ? m : 0;
}
function feedFloor(c, sigma, fcap){
  c.fbuf[c.fhead] = sigma;
  c.fhead = (c.fhead + 1) % fcap;
  if (c.fn < fcap) c.fn++;
}
function floorOfChan(c){
  if (!c.fn) return 0;
  let m = Infinity;
  for (let i=0;i<c.fn;i++){ const v = c.fbuf[i]; if (v > 0 && v < m) m = v; }
  return Number.isFinite(m) ? m : 0;
}
function feed(c, v, cap){
  if (c.have < 2){ c.p2 = c.p1; c.p1 = v; c.have++; return; }
  const d2 = Math.abs(c.p2 - 2*c.p1 + v);
  c.buf[c.head] = d2;
  c.head = (c.head + 1) % cap;
  if (c.n < cap) c.n++;
  c.p2 = c.p1; c.p1 = v;
}
function breakRun(c){ c.have = 0; }         // a gap invalidates the next two differences

export function create(){
  const cap  = Math.max(24, Math.round((C.windowMs/1000) * C.assumedFps));
  const fcap = Math.max(4, Math.round(C.floorMs / C.sampleMs));
  const s = { cap, fcap, lmX: [], lmY: [], ch: {}, t: -1, gaps: 0, frames: 0, sampleT: -1, out: null,
              /* the movement statistic, reported for judging a capture after the fact — never trusted
                 to gate one; the table above is why */
              mo: null, still: false, motion: 0, lmFloorNow: 0,
              /* amplitude sampling is armed explicitly, for a window in which the player was asked to
                 hold still */
              ampArmed: false,
              /* scratch for the median, pre-allocated so a query allocates nothing */
              scratch: new Float32Array(cap) };
  for (let i=0;i<N;i++){ s.lmX.push(chan(cap, fcap, false)); s.lmY.push(chan(cap, fcap, false)); }
  for (const k of CHANNELS) s.ch[k] = chan(cap, fcap, IS_AMP.has(k));
  s.mo = chan(cap, fcap, true);
  return s;
}

export function reset(s){
  const clr = (c)=>{ c.n = c.head = c.have = 0; c.fn = c.fhead = 0;
                     if (c.abuf){ c.an = c.ahead = 0; c.afn = c.afhead = 0; } };
  for (let i=0;i<N;i++){ clr(s.lmX[i]); clr(s.lmY[i]); }
  for (const k of CHANNELS) clr(s.ch[k]);
  clr(s.mo);
  s.t = -1; s.gaps = 0; s.frames = 0; s.sampleT = -1; s.still = false;
}

/* RAW landmarks, called before the filter touches them. `tMs` is the capture timestamp: a real gap
   in the stream has to break the difference run, because differencing across a dropout produces a
   spike that has nothing to do with sensor noise and would dominate the median for a whole window. */
export function pushLandmarks(s, frame, tMs){
  if (!frame.valid) { for (let i=0;i<N;i++){ breakRun(s.lmX[i]); breakRun(s.lmY[i]); } s.t = -1; return; }
  const gap = s.t < 0 ? 0 : (tMs - s.t);
  s.t = tMs;
  if (gap > C.maxGapMs){
    s.gaps++;
    for (let i=0;i<N;i++){ breakRun(s.lmX[i]); breakRun(s.lmY[i]); }
    for (const k of CHANNELS) breakRun(s.ch[k]);
    return;
  }
  s.frames++;
  /* the stillness statistic, taken BEFORE `feed` overwrites the previous values it needs */
  let mo = 0, moN = 0;
  for (const i of KEY_LM){
    const cx = s.lmX[i], cy = s.lmY[i];
    if (cx.have >= 1 && cy.have >= 1){
      const p = frame.img[i];
      const v = Math.abs(p.x - cx.p1) + Math.abs(p.y - cy.p1);
      if (v > mo) mo = v;
      moN++;
    }
  }
  if (moN) feedAmp(s.mo, mo, s.cap);          // `mo` is the MAX, see note 2 above

  for (let i=0;i<N;i++){
    const p = frame.img[i];
    /* x and y only. `z` is a monocular depth guess rather than a measurement, so its "noise" is
       mostly the estimator changing its mind and is not comparable to the other two. */
    feed(s.lmX[i], p.x, s.cap);
    feed(s.lmY[i], p.y, s.cap);
  }

  /* Sample the medians into the floor rings once a second. NOT per frame: this is 79 medians of a
     120-element window, which is nothing at 1Hz and would be silly at 30Hz. The per-frame path above
     stays free of it, so the zero-allocation property that matters — the one measured over 200k
     frames — is unaffected. */
  if (s.sampleT < 0 || tMs - s.sampleT >= C.sampleMs){
    s.sampleT = tMs;
    /* the landmark floors first: the stillness bar is built on them, not on the live sigma */
    let lmSum = 0;
    for (let i=0;i<N;i++){
      const sx = sigmaOf(s, s.lmX[i]), sy = sigmaOf(s, s.lmY[i]);
      feedFloor(s.lmX[i], sx, s.fcap);
      feedFloor(s.lmY[i], sy, s.fcap);
      lmSum += floorOfChan(s.lmX[i]) + floorOfChan(s.lmY[i]);
    }
    const lmFloor = lmSum/(2*N);
    const motion = (s.mo.an >= C.minSamples) ? medianOf(s, s.mo.abuf, s.mo.an) : Infinity;
    s.motion = motion; s.lmFloorNow = lmFloor;
    /* reported, not trusted: at realistic noise this does not separate running from standing */
    s.still = lmFloor > 0 && motion < C.stillK * lmFloor;

    for (const k of CHANNELS){
      feedFloor(s.ch[k], sigmaOf(s, s.ch[k]), s.fcap);
      /* the amplitude floor only while a caller has ARMED a stillness capture */
      if (s.ampArmed) feedAmpFloor(s.ch[k], ampSigmaOf(s, s.ch[k]), s.fcap);
    }
    if (s.out) writeFloors(s, s.out, s.outAmp);
  }
}

/* ---- capturing the amplitude floor -----------------------------------------------------
   Arm during a window in which the player has been asked to hold still, then read it out. Returns
   null until there are enough samples, so a caller can keep asking and take the first real answer
   rather than having to time the window itself. */
export function armAmplitude(s){
  s.ampArmed = true;
  for (const k of CHANNELS){ const c = s.ch[k]; if (c.afbuf){ c.afn = c.afhead = 0; } }
}
export function disarmAmplitude(s){ s.ampArmed = false; }
export function amplitudeCapture(s){
  const c0 = s.ch[AMP_CHANNELS[0]];
  if (!c0.afn) return null;
  const out = { measuredAt: 0, motion: s.motion, lmFloor: s.lmFloorNow, samples: c0.afn };
  for (const k of AMP_CHANNELS) out[k] = ampFloorOf(s.ch[k]);
  return out;
}

/* Point the sampler at the object it should keep up to date. */
export function bindFloors(s, out, outAmp){
  s.out = out; s.outAmp = outAmp || null;
  writeFloors(s, out, s.outAmp);
}

/* Derived channels, called after `readBody`, so these are what the thresholds actually see. */
export function pushChannels(s, body){
  if (!body.valid){ for (const k of CHANNELS) breakRun(s.ch[k]); return; }
  for (const k of CHANNELS){
    const v = body[k];
    if (Number.isFinite(v)){ feed(s.ch[k], v, s.cap); feedAmp(s.ch[k], v, s.cap); }
    else breakRun(s.ch[k]);
  }
}

/* Write the channel FLOORS into an object the body already owns, in place. This is how a machine
   gets at them: every machine already receives `body`, so nothing needs a new parameter and no signature
   changes ripple through the layer. Called on the sample tick rather than per frame — the floors move
   on a 30-second horizon, so recomputing them 30 times a second would be arithmetic for its own sake. */
export function writeFloors(s, out, outAmp){
  for (const k of CHANNELS){
    out[k] = floorOfChan(s.ch[k]);
    if (outAmp && IS_AMP.has(k)) outAmp[k] = ampFloorOf(s.ch[k]);
  }
  return out;
}

/* median of a ring, into the pre-allocated scratch */
function medianOf(s, buf, n){
  const a = s.scratch;
  for (let i=0;i<n;i++) a[i] = buf[i];
  const sub = a.subarray(0, n);
  sub.sort();
  return n & 1 ? sub[(n-1)>>1] : (sub[n/2 - 1] + sub[n/2])/2;
}

/* median of the window, then the Gaussian conversion. Returns 0 when there is not enough yet, so a
   caller can tell "quiet" from "unmeasured" by checking `frames`. */
function sigmaOf(s, c){
  if (c.n < C.minSamples) return 0;
  return medianOf(s, c.buf, c.n) * MED_TO_SIGMA;
}

/* the AMPLITUDE sigma: the robust magnitude of the value itself, for a channel that rests near zero */
function ampSigmaOf(s, c){
  if (!c.abuf || c.an < C.minSamples) return 0;
  return medianOf(s, c.abuf, c.an) * MED_ABS_TO_SIGMA;
}

/* A snapshot. Allocates — call it when something asks, not every frame. */
export function result(s){
  const lm = new Array(N);
  let sum = 0, max = 0, worst = -1, fsum = 0;
  for (let i=0;i<N;i++){
    const x = sigmaOf(s, s.lmX[i]), y = sigmaOf(s, s.lmY[i]);
    const fx = floorOfChan(s.lmX[i]), fy = floorOfChan(s.lmY[i]);
    /* one figure per landmark: the RMS of its two axes, which is the radial jitter of the point */
    const r = Math.sqrt((x*x + y*y)/2);
    const fr = Math.sqrt((fx*fx + fy*fy)/2);
    lm[i] = { x, y, r, floor: fr };
    sum += r; fsum += fr;
    if (r > max){ max = r; worst = i; }
  }
  const ch = {}, chFloor = {};
  for (const k of CHANNELS){ ch[k] = sigmaOf(s, s.ch[k]); chFloor[k] = floorOfChan(s.ch[k]); }
  const ready = s.ch[CHANNELS[0]].n >= C.minSamples;
  return {
    ready,
    frames: s.frames,
    samples: s.ch[CHANNELS[0]].n,
    /* the standard error of a sigma estimated from n samples, as a fraction. Reported so the figure
       carries its own uncertainty instead of looking more precise than it is. */
    relErr: s.ch[CHANNELS[0]].n > 2 ? 1/Math.sqrt(2*(s.ch[CHANNELS[0]].n - 2)) : 1,
    gaps: s.gaps,
    lm,
    /* `lmMean`/`ch` are the last few seconds — what to display, and what rises when the light drops.
       `lmFloor`/`chFloor` are the best of the last half minute — what a threshold should be built on.
       See the note above `chan` for why these are two numbers rather than one. */
    lmMean: sum/N, lmMax: max, lmWorst: worst,
    lmFloor: fsum/N,
    ch, chFloor,
    /* the amplitude floors, for the zero-centred channels only. What an amplitude GATE has to clear;
       `chFloor` is what the FILTER is judged against. They differ by ~4x after filtering, which is
       the entire reason both exist. */
    chAmp: (()=>{ const o = {}; for (const k of AMP_CHANNELS) o[k] = ampFloorOf(s.ch[k]); return o; })(),
  };
}

/* ---- using it ---------------------------------------------------------------------------
   A threshold expressed as a multiple of measured noise, but never LOOSER than the fixed value it
   replaces. That asymmetry is deliberate: raising a gate on a noisy camera can only reject more
   noise, while lowering one on a quiet camera would accept movements the machines were never tuned
   for and is a behaviour change nobody asked for. So this is a floor, not a substitution — quiet
   cameras behave exactly as before, and noisy ones get stricter. */
export function floorOf(fixed, sigma, k){
  if (!(sigma > 0)) return fixed;
  /* A backstop cap as well as the stillness gate, because the failure mode of getting this wrong is a
     control that silently stops working: a measurement taken during movement inflated a gate 13x and
     turned running off entirely on a clean camera. The stillness gate is the fix; this bounds how bad
     a future mistake in it can be. */
  return Math.min(fixed*C.capMul, Math.max(fixed, k*sigma));
}
