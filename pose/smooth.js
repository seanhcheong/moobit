/* =====================================================================================
   LANDMARK SMOOTHING — a One Euro filter, applied to the landmarks themselves.

   THE GAP THIS FILLS. Every derived signal in this layer is smoothed — `steerTau` on the hip,
   `cadTau` on cadence, the asymmetric attack/decay on `ankleAlt`, the 80ms constant on
   `ankleSpanVel`. The landmarks feeding all of them were not smoothed at all. So each consumer was
   separately fighting the same jitter, and any signal nobody had thought to filter passed it
   straight through into a command.

   A player reported the body-part identification "spazzing out" and producing unintended commands.
   That is not a threshold problem and calibration cannot fix it: calibration places a threshold
   inside a person's range, and if the signal is noisy then every threshold is being crossed by
   noise wherever you put it. The noise has to go.

   WHY ONE EURO AND NOT AN EMA.

   A fixed exponential average trades jitter for lag at a single ratio, and this project has spent a
   lot of effort on latency — firing jumps at takeoff rather than the apex, driving the penguin from
   live pose so it moves with the player rather than after them. A constant heavy enough to kill
   jitter would give all of that back.

   One Euro is adaptive: the cutoff frequency rises with the observed speed of the landmark. Slow or
   stationary, it smooths hard, which is exactly when jitter is visible and when there is no motion
   to preserve. Moving fast, it barely filters, which is when lag would be felt and when the signal
   is far above the noise anyway. Two parameters with physical meaning:

     fcMin   the cutoff when the landmark is still. Lower = smoother, laggier at rest.
     beta    how fast the cutoff opens up with speed. Higher = more responsive when moving.

   Reference: Casiez, Roussel & Vogel, "1 euro filter: a simple speed-based low-pass filter for
   noisy input in interactive systems" (CHI 2012). The formulation here is the standard one.

   VISIBILITY IS DELIBERATELY NOT SMOOTHED. The first version did smooth it, reasoning that a
   confidence flickering across a gate makes a machine freeze and resume. But `trackOf` already
   handles exactly that with dwell hysteresis, so this duplicated it — and averaging a confidence
   UPWARD let a marginal framing setup pass the arms-overhead check whose entire purpose is to fail
   it. A framing check has to see the raw number.
   ===================================================================================== */

import { CONFIG } from './config.js';

const C = CONFIG.smooth;

/* one filtered scalar: the value, its derivative, and whether it has been seeded */
function chan(){ return { x:0, dx:0, has:false }; }

export function create(n){
  const s = { n, x:[], y:[], z:[], v:[], wx:[], wy:[], wz:[], t:-1 };
  for (let i=0;i<n;i++){
    s.x.push(chan()); s.y.push(chan()); s.z.push(chan()); s.v.push(chan());
    s.wx.push(chan()); s.wy.push(chan()); s.wz.push(chan());
  }
  return s;
}

export function reset(s){
  for (const k of ['x','y','z','v','wx','wy','wz'])
    for (const c of s[k]){ c.has = false; c.x = 0; c.dx = 0; }
  s.t = -1;
}

/* the exponential smoothing coefficient for a given cutoff and timestep */
function alphaOf(cutoff, dt){
  const tau = 1/(2*Math.PI*Math.max(1e-4, cutoff));
  return 1/(1 + tau/Math.max(1e-4, dt));
}

/* One Euro on a single channel. `scale` normalises the speed term so `beta` means the same thing
   for a quantity measured in normalised image units as for one in metres. */
function one(c, value, dt, fcMin, beta, scale){
  if (!c.has){ c.has = true; c.x = value; c.dx = 0; return value; }
  /* derivative, itself low-passed on a fixed cutoff — an unfiltered derivative of a noisy signal is
     noisier than the signal, which would make the adaptive term chase the jitter it exists to reject */
  const aD = alphaOf(C.dCutoff, dt);
  const raw = (value - c.x)/dt;
  c.dx = aD*raw + (1 - aD)*c.dx;
  const speed = Math.abs(c.dx)*scale;
  const a = alphaOf(fcMin + beta*speed, dt);
  c.x = a*value + (1 - a)*c.x;
  return c.x;
}

/* Filter a Frame in place. Called once per inference result, before anything reads it, so every
   consumer downstream inherits the same clean signal instead of each fighting the noise alone. */
export function apply(s, frame){
  if (!C.on || !frame.valid) return frame;
  const dt = s.t < 0 ? (1/25) : Math.min(0.5, Math.max(1e-3, (frame.t - s.t)/1000));
  s.t = frame.t;

  for (let i=0;i<s.n;i++){
    const d = frame.img[i];
    d.x = one(s.x[i], d.x, dt, C.fcMin, C.beta, 1);
    d.y = one(s.y[i], d.y, dt, C.fcMin, C.beta, 1);
    d.z = one(s.z[i], d.z, dt, C.fcMin, C.beta, 1);
    /* visibility deliberately left ALONE by default — see `smoothVis` in config for why */
    if (C.smoothVis) d.v = one(s.v[i], d.v, dt, C.fcVis || 2.5, 0, 1);
    const w = frame.world[i];
    /* the metric frame is in metres, so a given amount of jitter is a much larger NUMBER than the
       same jitter in normalised image units — `worldScale` puts `beta` back on the same footing */
    w.x = one(s.wx[i], w.x, dt, C.fcMin, C.beta, C.worldScale);
    w.y = one(s.wy[i], w.y, dt, C.fcMin, C.beta, C.worldScale);
    w.z = one(s.wz[i], w.z, dt, C.fcMin, C.beta, C.worldScale);
  }
  return frame;
}
