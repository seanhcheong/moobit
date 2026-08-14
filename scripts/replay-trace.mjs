/* =====================================================================================
   REPLAY A POSE TRACE — turn a recording of a real body into numbers you can tune against.

     node scripts/replay-trace.mjs trace.json
     node scripts/replay-trace.mjs trace.json --set smooth.fcMin=2.4 --set smooth.beta=1.2
     node scripts/replay-trace.mjs trace.json --still 4.0:12.0
     node scripts/replay-trace.mjs trace.json --csv kneeStraight,ankleAlt,cadence > signals.csv

   Every threshold in `pose/config.js` was fitted against synthetic bodies. This is the other half:
   feed a real recording through the SAME `detector.push` the camera drives, and report where the
   real signals actually sit relative to the numbers that judge them.

   WHAT IT CHECKS, IN THE ORDER THAT MATTERS.

   1. FIDELITY, FIRST AND UNCONDITIONALLY. The trace carries what the live session concluded
      alongside the landmarks that produced it. Replay recomputes all of it and compares. If those
      disagree, the tool is broken and every number below it is void — so this runs before anything
      else and says so loudly. It is here because this project has repeatedly been misled by
      harnesses that measured confidently and measured the wrong thing.

   2. THE NOISE FLOOR, measured on the RAW landmarks — before `Smooth.apply`, which is the whole
      point: the question a real trace exists to answer is whether the filter constants are right,
      and a floor measured after filtering cannot answer it. Estimated from the second difference,
      which cancels any smooth underlying motion and leaves the high-frequency part, so a player
      who drifted slightly while "holding still" is not counted as noisy. Directly comparable to
      the synthetic levels the smoothing was tuned against (0.004 / 0.008 / 0.012).

   3. UNINTENDED COMMANDS during the stillest window. A motionless body should produce nothing.
      Whatever it does produce is the bug, quantified.

   4. WHERE THE THRESHOLDS SIT against the observed distribution of the signal each one judges.
      A threshold outside the range of the signal it gates is either never crossed or always
      crossed, and both are findings.

   `--set` re-runs the whole pipeline under different constants, so a candidate fix can be judged
   against a movement a real person actually performed rather than one that was invented for it.
   ===================================================================================== */

import { readFileSync } from 'node:fs';
import * as Det from '../pose/detector.js';
import { CONFIG, EX } from '../pose/config.js';

/* ---- args ------------------------------------------------------------------------------- */
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
if (!file){
  console.error('usage: node scripts/replay-trace.mjs <trace.json> [--set path=value] [--still a:b] [--csv sig,sig]');
  process.exit(2);
}
const opt = (name)=>{ const i = argv.indexOf('--'+name); return i >= 0 ? argv[i+1] : null; };
const sets = argv.reduce((a, v, i)=> (v === '--set' ? a.concat(argv[i+1]) : a), []);
const csvSigs = (opt('csv') || '').split(',').filter(Boolean);
const stillArg = opt('still');

const trace = JSON.parse(readFileSync(file, 'utf8'));
if (trace.format !== 'belt-runner-pose-trace')
  { console.error('not a belt-runner pose trace:', trace.format); process.exit(2); }

const F = trace.frames.filter(f => f && f.live);
if (!F.length){ console.error('trace has no frames'); process.exit(2); }
/* The recorder already emits in capture order, but sort anyway: this script has to be able to read a
   trace written by an older build, and every window and duration below assumes a timeline. Replay
   also has to FEED them in capture order — the machines measure elapsed milliseconds between
   pushes, and a frame stamped in the past would contribute a negative interval. */
let unsorted = 0;
for (let i=1;i<F.length;i++) if (F[i].t < F[i-1].t) unsorted++;
if (unsorted) F.sort((a,b)=>a.t-b.t);
const DERIVED = trace.derived || [];
const di = (n)=> DERIVED.indexOf(n);

/* ---- constants: the trace's own, then any overrides ------------------------------------
   Replaying under today's defaults would compare two unrelated sessions — the same landmarks
   under different thresholds are a different run. So the trace's snapshot is restored first,
   and `--set` is applied visibly on top of it. */
function deepAssign(dst, src){
  for (const k in src){
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') deepAssign(dst[k], v);
    else dst[k] = v;
  }
}
if (trace.config) deepAssign(CONFIG, trace.config);
const applied = [];
for (const s of sets){
  const [path, raw] = String(s).split('=');
  const parts = path.split('.');
  let o = CONFIG;
  for (let i=0;i<parts.length-1;i++) o = o && o[parts[i]];
  if (!o || !(parts[parts.length-1] in o)){ console.error('unknown config path:', path); process.exit(2); }
  const key = parts[parts.length-1];
  const was = o[key];
  const val = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  if (typeof val === 'number' && Number.isNaN(val)){ console.error('bad value for', path, ':', raw); process.exit(2); }
  o[key] = val;
  applied.push(`${path}: ${was} -> ${val}`);
}

/* ---- replay through the real detector --------------------------------------------------- */
const N = 33;
function resOf(f){
  if (!f.valid || !f.img) return null;
  const L = new Array(N), W = f.world ? new Array(N) : null;
  for (let i=0;i<N;i++){
    const p = i*4;
    L[i] = { x:f.img[p], y:f.img[p+1], z:f.img[p+2], visibility:f.img[p+3] };
    if (W){ const q = i*3; W[i] = { x:f.world[q], y:f.world[q+1], z:f.world[q+2] }; }
  }
  /* worldLandmarks omitted when the recording had none, so adapt()'s image-space fallback is
     reproduced rather than papered over with zeros */
  return W ? { landmarks:[L], worldLandmarks:[W] } : { landmarks:[L] };
}

const counts = { jump:0, step:0, lane:0, crouchOn:0, completed:0, rejected:0, live:0, lostTo:0 };
const sink = {
  laneChange:()=>counts.lane++, jump:()=>counts.jump++, jumpHold:()=>{},
  step:()=>counts.step++, cadence:()=>{}, steer:()=>{}, turn:()=>{},
  crouch:(on)=>{ if (on) counts.crouchOn++; },
  repProgress:()=>{}, repCompleted:()=>counts.completed++, repRejected:()=>counts.rejected++,
  poseLive:()=>counts.live++,
  trackingState:(s)=>{ if (s === 'lost') counts.lostTo++; },
};

const d = Det.create();
if (trace.calibration) Det.setCalibration(d, trace.calibration);
const out = new Array(F.length);
let lastCrouch = false;

/* FED IN ARRIVAL ORDER, ANALYSED ON THE TIMELINE. These are different sequences whenever a result
   comes back after one captured later than it, and the live session's state — the filter's seed, a
   machine reset after a bodyless frame, every dwell timer — evolved in the order results ARRIVED.
   Replaying in capture order therefore reproduces a session that never happened, and the fidelity
   check fails for a reason that has nothing to do with the detector. Measured: one bodyless frame
   arriving late moved a filter re-seed from the end of a trace into the middle of it and threw the
   knee angles out by 20 degrees.

   `out` stays indexed to match capture order, so everything downstream still reads as a timeline. */
const ORDER = F.map((f, i)=>i);
if (F.some(f => f.seq !== undefined)) ORDER.sort((a, b)=> F[a].seq - F[b].seq);
for (const i of ORDER){
  const f = F[i];
  /* the live session followed the wall; replay follows what the recording says was wanted, so the
     same rep machine runs on the same frames */
  if (f.live.want !== undefined && f.live.want !== d.want) Det.setWant(d, f.live.want);
  const ev = Det.push(d, resOf(f), f.t, sink);
  out[i] = {
    t: f.t, track: d.track, bodyValid: !!d.body.valid,
    d: DERIVED.map(k => d.body[k]),
    step: !!ev.step, jump: !!ev.jump, lane: ev.lane, crouch: !!ev.crouch,
    cadence: ev.cadence, completed: !!ev.completed, reject: ev.reject || '',
    crouchEdge: !!ev.crouch && !lastCrouch,
  };
  lastCrouch = !!ev.crouch;
}

/* ---- 1. fidelity ------------------------------------------------------------------------
   Only meaningful with no overrides: `--set` is a deliberate request for a DIFFERENT answer, so
   divergence there is the tool working, not failing. */
const fid = { checked:false, worst:[], evMismatch:0, evTotal:0 };
if (!applied.length){
  fid.checked = true;
  const worst = DERIVED.map(()=>0);
  for (let i=0;i<F.length;i++){
    const rec = F[i].live, got = out[i];
    for (let k=0;k<DERIVED.length;k++){
      const a = rec.d[k], b = got.d[k];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const e = Math.abs(a - b);
      if (e > worst[k]) worst[k] = e;
    }
    for (const key of ['step','jump','crouch','completed']){
      fid.evTotal++;
      if (!!rec[key] !== !!got[key]) fid.evMismatch++;
    }
    if (rec.track !== got.track){ fid.evTotal++; fid.evMismatch++; }
  }
  fid.worst = DERIVED.map((n,k)=>({ n, e:worst[k] }))
    .sort((a,b)=>b.e-a.e).slice(0, 6);
}

/* ---- 2. noise floor, on the raw landmarks ----------------------------------------------
   Second-difference estimator: for a signal x = s + n where s is smooth and n is white with
   standard deviation sigma, the second difference x[t-1] - 2x[t] + x[t+1] has variance 6*sigma^2
   and cancels s entirely up to its curvature. So sigma ~= std(d2)/sqrt(6), and a player who was
   slowly drifting rather than truly still does not inflate it. */
const KEY_LM = { NOSE:0, SH_L:11, SH_R:12, HIP_L:23, HIP_R:24, KNEE_L:25, KNEE_R:26, ANKLE_L:27, ANKLE_R:28 };
function noiseOf(a, b){                       // frame index range [a,b)
  const per = {};
  for (const [name, li] of Object.entries(KEY_LM)){
    let s2 = 0, n = 0;
    for (let i=a+1;i<b-1;i++){
      const p = F[i-1], c = F[i], q = F[i+1];
      if (!p.valid || !c.valid || !q.valid) continue;
      for (const off of [0,1]){               // x and y; z is a depth guess, not a measurement
        const j = li*4 + off;
        const d2 = p.img[j] - 2*c.img[j] + q.img[j];
        s2 += d2*d2; n++;
      }
    }
    per[name] = n > 1 ? Math.sqrt(s2/n/6) : 0;
  }
  const vals = Object.values(per);
  return { per, mean: vals.reduce((s,v)=>s+v,0)/(vals.length||1), max: Math.max(...vals) };
}

/* stillest window: lowest total landmark motion over a 3s span */
function motionAt(i){
  const p = F[i-1], c = F[i];
  if (!p.valid || !c.valid) return Infinity;
  let s = 0;
  for (const li of Object.values(KEY_LM)){
    const j = li*4;
    s += Math.abs(c.img[j]-p.img[j]) + Math.abs(c.img[j+1]-p.img[j+1]);
  }
  return s / Object.keys(KEY_LM).length;
}
/* Every return here is clamped into the array. A short trace, a trace whose frames all share a
   timestamp, or a `--still` range past the end each produced a window reaching beyond the last frame,
   and the command counter then read `undefined.jump` and took the whole tool down. A diagnostic that
   crashes on an unusual recording is useless precisely when it is needed. */
function clampWin(a, b){
  const lo = Math.max(0, Math.min(F.length - 1, a|0));
  const hi = Math.max(lo + 1, Math.min(F.length, b|0));
  return [lo, hi];
}
function pickStill(){
  if (stillArg){
    const [a, b] = stillArg.split(':').map(Number);
    const t0 = F[0].t;
    let ia = 0, ib = F.length;
    for (let i=0;i<F.length;i++){ if ((F[i].t-t0)/1000 <= a) ia = i; if ((F[i].t-t0)/1000 <= b) ib = i+1; }
    return clampWin(ia, ib);
  }
  /* 2s, searched frame by frame. A coarse stride can only land the window ON a boundary, and a
     window that straddles the still part and the moving part reports the average of the two —
     which reads as "somewhat noisy while still" and is the wrong conclusion entirely. */
  /* `fps` is non-finite when every frame shares a timestamp, which `Math.round` then turns into a
     span longer than the trace. Half the trace is the fallback: still a window, never out of bounds. */
  const want = Number.isFinite(fps) && fps > 0 ? Math.round(2 * fps) : Math.floor(F.length/2);
  const span = Math.max(4, Math.min(Math.max(4, F.length - 2), want));
  let best = Infinity, bi = 1;
  for (let i=1;i+span<F.length;i++){
    let s = 0, n = 0;
    for (let k=i;k<i+span;k++){ const m = motionAt(k); if (Number.isFinite(m)){ s += m; n++; } }
    const avg = n ? s/n : Infinity;
    if (avg < best){ best = avg; bi = i; }
  }
  stillMotion = best;
  return clampWin(bi, bi+span);
}
let stillMotion = Infinity;

const dur = (F[F.length-1].t - F[0].t)/1000;
const fps = dur > 0 ? F.length/dur : 0;
const [sa, sb] = pickStill();
const noise = noiseOf(sa, sb);
const noiseAll = noiseOf(0, F.length);

/* commands issued while nobody was moving */
const stillEv = { jump:0, step:0, lane:0, crouch:0, cadPeak:0 };
for (let i=sa;i<sb;i++){
  const o = out[i];
  if (o.jump) stillEv.jump++;
  if (o.step) stillEv.step++;
  if (o.lane) stillEv.lane++;
  if (o.crouchEdge) stillEv.crouch++;
  stillEv.cadPeak = Math.max(stillEv.cadPeak, o.cadence);
}

/* ---- 4. signal distributions ------------------------------------------------------------ */
function pct(arr, p){
  if (!arr.length) return 0;
  const s = arr.slice().sort((a,b)=>a-b);
  return s[Math.min(s.length-1, Math.max(0, Math.round(p*(s.length-1))))];
}
function seriesOf(name){
  const k = di(name);
  const a = [];
  for (let i=0;i<out.length;i++){
    if (!out[i].bodyValid) continue;
    const v = k >= 0 ? out[i].d[k] : (name === 'cadence' ? out[i].cadence : NaN);
    if (Number.isFinite(v)) a.push(v);
  }
  return a;
}

/* Each threshold, paired with the signal it actually judges. This mapping is the useful part —
   a number in config.js is meaningless without knowing which measurement it is compared to. */
const AUDIT = [
  ['crouch.enterKnee',   'kneeStraight', 'crouch fires below'],
  ['crouch.exitKnee',    'kneeStraight', 'crouch releases above'],
  ['run.altGate',        'ankleAlt',     'cadence needs above'],
  ['run.minSplit',       'ankleSplit',   'a step needs |split| above'],
  ['jack.openAnkleSpan', 'ankleSpan',    'jack open above'],
  ['jack.closeAnkleSpan','ankleSpan',    'jack closed below'],
  ['squat.bottomKnee',   'knee',         'squat bottom below'],
  ['jump.spreadSpan',    'ankleSpan',    'jump vetoed above'],
  ['jump.spreadVel',     'ankleSpanVel', 'jump vetoed above'],
];
function cfgAt(path){
  let o = CONFIG;
  for (const p of path.split('.')) o = o && o[p];
  return o;
}

/* ---- report ---------------------------------------------------------------------------- */
const f2 = (v)=> (Number.isFinite(v) ? v.toFixed(2) : '-').padStart(8);
const f4 = (v)=> (Number.isFinite(v) ? v.toFixed(4) : '-').padStart(8);

console.log(`\nTRACE  ${file}`);
console.log(`  ${F.length} frames · ${dur.toFixed(1)}s · ${Number.isFinite(fps) ? fps.toFixed(1) : '?'} fps` +
            (trace.dropped ? ` · ${trace.dropped} dropped off the back of the ring` : '') +
            (trace.outOfOrder ? ` · ${trace.outOfOrder} results arrived out of capture order` : '') +
            (unsorted ? ` · re-sorted ${unsorted} frames into capture order` : ''));
if (trace.note) console.log(`  note: ${trace.note}`);
if (trace.device) console.log(`  device: ${[trace.device.mode, trace.device.delegate, trace.device.ua].filter(Boolean).join(' · ').slice(0,140)}`);
console.log(`  calibrated: ${trace.calibration && trace.calibration.ready ? 'yes' : 'NO — population defaults'}`);
/* One fit is applied to every frame here. If it moved during the recording, that is a real reason
   for the fidelity check below to disagree, and saying so beats letting it read as a broken tool. */
if (trace.calDrift)
  console.log('  WARNING: the body fit CHANGED while recording — one fit is replayed over all frames,\n' +
              '           so expect fidelity divergence that is the trace\'s fault, not the detector\'s');
if (applied.length){ console.log('\nOVERRIDES'); for (const a of applied) console.log('  ' + a); }

console.log('\n1. FIDELITY  (replay vs what the live session recorded)');
if (!fid.checked) console.log('  skipped — overrides applied, so divergence is the point');
else {
  const bad = fid.worst[0] && fid.worst[0].e > 0.05;
  console.log(`  events: ${fid.evMismatch}/${fid.evTotal} disagree` +
              `   worst signals: ${fid.worst.map(w=>`${w.n} ${w.e.toExponential(1)}`).join(', ')}`);
  console.log(bad || fid.evMismatch
    ? '  *** REPLAY DOES NOT REPRODUCE THE LIVE SESSION — nothing below can be trusted ***'
    : '  ok — replay reproduces the live session, so the numbers below are the real ones');
}

console.log('\n2. NOISE FLOOR  (raw landmarks, normalised image units, before any smoothing)');
console.log(`  ${stillArg ? 'requested' : 'stillest'} ${((F[sb-1].t-F[sa].t)/1000).toFixed(1)}s window at t+${((F[sa].t-F[0].t)/1000).toFixed(1)}s` +
            (Number.isFinite(stillMotion) ? `  (residual motion ${stillMotion.toFixed(4)}/frame)` : ''));
/* A trace with no still part at all would silently report the quietest MOVING window as the noise
   floor, which overstates it. Say so rather than letting the number stand unqualified.

   The bar is relative to the noise, not an absolute number. Frame-to-frame motion of a perfectly
   still body is not zero — it is the noise itself, and a difference of two independent samples has
   about 1.4x the standard deviation of one, summed over x and y. So a genuinely still window sits
   at roughly 2-3 sigma of motion by construction. An absolute threshold flagged every noisy camera
   as "not really still", which is precisely backwards: a noisy camera is when the floor matters
   most. Only motion the noise cannot account for means the body was actually moving. */
if (Number.isFinite(stillMotion) && noise.mean > 0 && stillMotion > 4*noise.mean)
  console.log(`  NOTE: nothing in this trace is really still (motion ${stillMotion.toFixed(4)} is ` +
              `${(stillMotion/noise.mean).toFixed(1)}x the noise) — treat the floor as an upper bound`);
console.log(`    mean ${f4(noise.mean)}   worst ${f4(noise.max)}   ` +
            Object.entries(noise.per).map(([k,v])=>`${k} ${v.toFixed(4)}`).join(' '));
console.log(`  whole trace: mean ${f4(noiseAll.mean)}   worst ${f4(noiseAll.max)}`);
const ref = noise.mean;
console.log(`  synthetic reference: 0.0040 quiet · 0.0080 the level that produced 21 phantom jumps · 0.0120 bad`);
console.log(`  => this camera is ${ref < 0.005 ? 'QUIET' : ref < 0.009 ? 'MID — the level the filter was tuned for' : 'NOISY — worse than anything tested'}`);

console.log('\n3. UNINTENDED COMMANDS  (during that still window — every one of these is a bug)');
console.log(`  jumps ${stillEv.jump}   steps ${stillEv.step}   lanes ${stillEv.lane}   crouches ${stillEv.crouch}   peak cadence ${stillEv.cadPeak.toFixed(2)}`);

console.log('\n4. WHOLE-TRACE TOTALS');
console.log(`  jumps ${counts.jump}   steps ${counts.step}   lanes ${counts.lane}   crouches ${counts.crouchOn}` +
            `   reps ${counts.completed}   rejected ${counts.rejected}   went LOST ${counts.lostTo}x`);
const trackN = out.reduce((a,o)=>(a[o.track]=(a[o.track]||0)+1, a), {});
console.log(`  tracking: ` + Object.entries(trackN).map(([k,v])=>`${k} ${(100*v/out.length).toFixed(0)}%`).join('  '));

console.log('\n5. SIGNAL RANGES  (p5 / median / p95 over frames with a readable body)');
const SHOW = ['kneeStraight','knee','ankleAlt','ankleSplit','ankleSpan','ankleSpanVel','hipX','noseOff','shoulderW','cadence','hipDrop','jumpRise'];
for (const n of SHOW){
  const a = seriesOf(n);
  if (!a.length) continue;
  console.log(`  ${n.padEnd(14)} ${f2(pct(a,0.05))} ${f2(pct(a,0.5))} ${f2(pct(a,0.95))}   (min ${f2(Math.min(...a))} max ${f2(Math.max(...a))})`);
}

console.log('\n6. THRESHOLDS vs WHAT THIS BODY ACTUALLY DID');
for (const [path, sig, what] of AUDIT){
  const th = cfgAt(path);
  const a = seriesOf(sig);
  if (!a.length || !Number.isFinite(th)) continue;
  const lo = Math.min(...a), hi = Math.max(...a);
  const frac = a.filter(v=>v >= th).length / a.length;
  const flag = th < lo ? 'ALWAYS above it' : th > hi ? 'NEVER reached' : `${(100*frac).toFixed(0)}% of frames above`;
  console.log(`  ${path.padEnd(20)} ${String(th).padStart(7)}  ${what} ${sig}  [${lo.toFixed(2)}..${hi.toFixed(2)}]  ${flag}`);
}

if (csvSigs.length){
  console.log('\n--- csv ---');
  console.log(['t', ...csvSigs].join(','));
  for (let i=0;i<out.length;i++){
    const row = [((out[i].t - F[0].t)/1000).toFixed(3)];
    for (const s of csvSigs){
      const k = di(s);
      row.push(k >= 0 ? out[i].d[k] : (s === 'cadence' ? out[i].cadence : ''));
    }
    console.log(row.join(','));
  }
}
console.log('');
