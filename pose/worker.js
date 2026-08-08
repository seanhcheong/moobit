/* =====================================================================================
   INFERENCE WORKER — MediaPipe PoseLandmarker, off the render thread.

   The render loop must never block on inference. That is the whole reason this file exists,
   and it is why the main thread only ever posts a frame and receives landmarks.

   ### The fallback ladder, and why it is not optional

   WebGL inside a Worker needs OffscreenCanvas, which has been late and uneven in WKWebView —
   and even where it works, the GPU delegate contends with the game's own WebGL2 context for
   the same GPU. So "run in a worker" and "use the GPU delegate" can genuinely conflict on the
   exact device we are shipping to. Rather than assume, this tries in order:

       1. worker + GPU delegate      (fastest when it works)
       2. worker + CPU delegate      (slower, but never blocks the render thread)

   and reports which one is live, so the diagnostic page can show it and we find out from a
   real phone instead of guessing. If the worker cannot be created at all, the caller falls
   back to running this same pipeline on the main thread — see source.js.

   Messages in:   {type:'init', modelPath, wasmPath, delegate, numPoses, modelComplexity}
                  {type:'frame', bitmap, t}          bitmap is transferred, not copied
                  {type:'close'}
   Messages out:  {type:'ready', delegate}
                  {type:'error', message, stage}
                  {type:'result', landmarks, worldLandmarks, t, inferMs}
   ===================================================================================== */

let landmarker = null;
let busy = false;
let liveDelegate = '';

/* This is a CLASSIC worker, deliberately, and it loads the CommonJS bundle.
   MediaPipe's runtime calls `importScripts` internally to pull in the WASM loader — and
   `importScripts` does not exist in a MODULE worker. A module worker therefore fails at
   `ModuleFactory not set`, which reads like a platform limitation and is not one. Classic
   worker plus the .cjs build is the combination that works. */
function loadBundle(bundlePath){
  /* the CJS build writes onto `exports`, so give it one */
  self.module = { exports: {} };
  self.exports = self.module.exports;
  importScripts(bundlePath);
  return self.module.exports;
}

async function init(msg){
  const { FilesetResolver, PoseLandmarker } = loadBundle(msg.bundlePath);
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath);

  /* try GPU, then CPU. Creating the landmarker is what actually fails on a device that cannot
     give a worker a GL context, so the attempt has to be the test. */
  const order = msg.delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr = null;
  for (const delegate of order){
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelPath, delegate },
        runningMode: 'VIDEO',
        numPoses: msg.numPoses || 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      liveDelegate = delegate;
      lastErr = null;
      break;
    } catch (e){
      lastErr = e;
      landmarker = null;
    }
  }
  if (!landmarker) throw lastErr || new Error('could not create a PoseLandmarker');
  self.postMessage({ type:'ready', delegate: liveDelegate });
}

/* VIDEO running mode matters, and not only for accuracy: the pipeline runs the full detector
   on the first frame and when tracking is lost, and derives the region of interest from the
   previous frame's landmarks otherwise. That is a large latency saving over re-detecting every
   frame — but it also means timestamps MUST be strictly monotonic or MediaPipe throws. */
let lastT = -1;

function onFrame(msg){
  if (!landmarker || busy){ if (msg.bitmap) msg.bitmap.close(); return; }
  let t = msg.t;
  if (t <= lastT) t = lastT + 1;          // strictly monotonic, always
  lastT = t;
  busy = true;
  const t0 = performance.now();
  let res = null;
  try {
    res = landmarker.detectForVideo(msg.bitmap, t);
  } catch (e){
    self.postMessage({ type:'error', stage:'detect', message: String(e && e.message || e) });
  }
  const inferMs = performance.now() - t0;
  msg.bitmap.close();
  busy = false;

  /* Post plain arrays, not MediaPipe's objects: the result is reused internally and would be
     mutated out from under the main thread. Copying 33 points is far cheaper than the risk. */
  const out = { type:'result', t, inferMs, landmarks:null, worldLandmarks:null };
  if (res && res.landmarks && res.landmarks.length){
    const L = res.landmarks[0], W = res.worldLandmarks && res.worldLandmarks[0];
    const a = new Array(L.length);
    for (let i=0;i<L.length;i++){
      const p = L[i];
      a[i] = { x:p.x, y:p.y, z:p.z, visibility: p.visibility === undefined ? 1 : p.visibility };
    }
    out.landmarks = [a];
    if (W){
      const b = new Array(W.length);
      for (let i=0;i<W.length;i++){ const p = W[i]; b[i] = { x:p.x, y:p.y, z:p.z }; }
      out.worldLandmarks = [b];
    }
  }
  self.postMessage(out);
}

self.onmessage = async (e)=>{
  const msg = e.data;
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'frame') onFrame(msg);
    else if (msg.type === 'close'){ if (landmarker) landmarker.close(); landmarker = null; }
  } catch (err){
    self.postMessage({ type:'error', stage: msg && msg.type || 'unknown',
                       message: String(err && err.message || err) });
  }
};
