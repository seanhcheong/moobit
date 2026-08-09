/* =====================================================================================
   CAMERA SOURCE — getUserMedia, a downscaled frame pump, and the one place mirroring is
   decided. Feeds the worker; never blocks on it.

   ### Mirroring, stated once

   The PREVIEW is mirrored in CSS (`transform: scaleX(-1)`), because users expect a mirror.
   The LANDMARK DATA is never mirrored — not here, not in the worker, not downstream. All
   lateral reasoning happens in landmarks.js against an explicit screen-space frame. Two
   places is one too many for the bug that makes lane changes go the wrong way.

   ### Cadence

   Inference runs at 20-30Hz, rendering at 60Hz, and they are decoupled: a new frame is only
   sent when the worker is idle, so a slow device degrades to a lower inference rate instead of
   dropping the render loop. The last pose is held between inferences. The on-screen skeleton
   may be interpolated for smoothness; the state machines never see an interpolated landmark,
   because that invents motion that did not happen and produces phantom reps.

   Every frame is stamped with `performance.now()` at CAPTURE time, not on arrival, so the
   state machines measure the body's real timing rather than the pipeline's queueing.
   ===================================================================================== */

const CAPTURE = 256;                 // inference input size; more pixels cost heat, not accuracy

export function create(){
  return {
    video: null, stream: null,
    worker: null, mode:'', delegate:'',
    canvas: null, ctx: null, off: null,
    running: false, wantFrame: true,
    lastSentT: 0, minIntervalMs: 1000/30,
    stats: { sent:0, got:0, inferMs:0, fps:0, lastResultT:0, dropped:0 },
    onResult: null, onError: null,
    _fpsWindow: [], _raf: 0,
  };
}

/* ---- camera ---------------------------------------------------------------------------- */
export async function openCamera(S, { width=640, height=480, frameRate=30 } = {}){
  /* 640x480 on purpose. We downscale to 256 before inference anyway, so 1080p buys nothing
     and costs battery and heat — which on a ten-minute fitness session is the whole budget. */
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode:'user', width:{ideal:width}, height:{ideal:height},
             frameRate:{ideal:frameRate} },
  });
  S.stream = stream;
  const v = document.createElement('video');
  v.playsInline = true; v.muted = true; v.autoplay = true;
  v.srcObject = stream;
  await v.play();
  S.video = v;

  S.canvas = document.createElement('canvas');
  S.canvas.width = CAPTURE; S.canvas.height = CAPTURE;
  S.ctx = S.canvas.getContext('2d', { willReadFrequently:false });
  if (typeof OffscreenCanvas !== 'undefined'){
    S.off = new OffscreenCanvas(CAPTURE, CAPTURE);
    S.offCtx = S.off.getContext('2d');
  }
  const t = stream.getVideoTracks()[0];
  return t ? t.getSettings() : {};
}

export function closeCamera(S){
  S.running = false;
  if (S._raf) cancelAnimationFrame(S._raf);
  if (S.stream) for (const t of S.stream.getTracks()) t.stop();
  if (S.worker){ try { S.worker.postMessage({type:'close'}); S.worker.terminate(); } catch(e){} }
  S.stream = null; S.video = null; S.worker = null;
}

/* ---- the inference backend, with its fallback ladder ------------------------------------ */
export async function startWorker(S, { base='./pose', model='lite', delegate='GPU' } = {}){
  const paths = {
    /* Two builds on purpose: the worker needs the CommonJS one loaded through importScripts
       (see the note at the top of worker.js), the main-thread fallback uses the ES module.
       The worker copy is named .js rather than .cjs because importScripts insists on a
       JavaScript MIME type and most static servers do not recognise .cjs. */
    bundlePath: new URL(`${base}/vendor/vision_bundle_worker.js`, location.href).href,
    bundleModulePath: new URL(`${base}/vendor/vision_bundle.mjs`, location.href).href,
    wasmPath:   new URL(`${base}/vendor/wasm`, location.href).href,
    modelPath:  new URL(`${base}/vendor/pose_landmarker_${model}.task`, location.href).href,
  };

  const tryWorker = ()=> new Promise((resolve, reject)=>{
    let w;
    /* classic, NOT a module worker — MediaPipe's internal importScripts needs it */
    try { w = new Worker(new URL(`${base}/worker.js`, location.href)); }
    catch (e){ return reject(e); }
    /* Generous on purpose. This is a cold load of an ~18MB model plus a 12MB wasm off disk,
       which is exactly what a phone's FIRST launch is — and a timeout that fires mid-load does
       real damage: it abandons a load that was going to succeed and starts a second full one on
       the main thread, so the user waits twice and ends up in the slower mode. Only an explicit
       error should count as failure; this is a backstop against a genuine hang, nothing more. */
    const to = setTimeout(()=>{ reject(new Error('worker init timed out after 120s')); }, 120000);
    w.onmessage = (e)=>{
      const m = e.data;
      if (m.type === 'ready'){ clearTimeout(to); resolve({ w, delegate:m.delegate }); }
      else if (m.type === 'error' && m.stage === 'init'){ clearTimeout(to); reject(new Error(m.message)); }
      else handle(S, m);
    };
    w.onerror = (e)=>{ clearTimeout(to); reject(new Error(e.message || 'worker failed')); };
    w.postMessage(Object.assign({ type:'init', delegate, numPoses:1 }, paths));
  });

  try {
    const { w, delegate:d } = await tryWorker();
    S.worker = w; S.mode = 'worker'; S.delegate = d;
    return { mode:'worker', delegate:d };
  } catch (err){
    /* No worker, or no landmarker inside one. Run the same pipeline on the main thread: worse
       for frame pacing, but a working app beats an architecturally tidy broken one. The
       diagnostic page surfaces which mode is live so this is never silent. */
    const { FilesetResolver, PoseLandmarker } = await import(paths.bundleModulePath);
    const fileset = await FilesetResolver.forVisionTasks(paths.wasmPath);
    let lm = null, live = '';
    for (const del of (delegate === 'CPU' ? ['CPU'] : ['GPU','CPU'])){
      try {
        lm = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions:{ modelAssetPath: paths.modelPath, delegate: del },
          runningMode:'VIDEO', numPoses:1, outputSegmentationMasks:false,
        });
        live = del; break;
      } catch (e){ lm = null; }
    }
    if (!lm) throw new Error('pose landmarker unavailable: ' + (err.message||err));
    S.inline = lm; S.mode = 'main'; S.delegate = live;
    S.inlineFallbackReason = String(err.message || err);
    return { mode:'main', delegate:live, reason:S.inlineFallbackReason };
  }
}

function handle(S, m){
  if (m.type === 'result'){
    S.stats.got++; S.stats.inferMs = m.inferMs;
    S.stats.lastResultT = m.t;
    S.wantFrame = true;
    if (S.onResult) S.onResult(m, m.t);
    /* Grab the next frame NOW rather than waiting for the next animation frame. The pump used to
       only send from inside requestAnimationFrame, so every inference was followed by up to a
       full display frame of doing nothing — pure added staleness in the pose the game reacts to,
       for no benefit. This costs nothing: the same number of inferences run, they just stop
       idling between them. The 30Hz interval below still caps the rate, so heat is unchanged. */
    if (S.running) pump(S);
  } else if (m.type === 'error'){
    if (S.onError) S.onError(m);
    S.wantFrame = true;
  }
}

/* ---- the pump: one frame in flight at a time --------------------------------------------
   Driven from two places, on purpose: the animation frame keeps it ticking when nothing is in
   flight, and `handle()` calls it the instant a result lands so the next capture does not wait
   out the rest of the display frame. Guarded by `wantFrame` and `minIntervalMs`, so calling it
   twice in quick succession is harmless — the second call simply returns. */
function pump(S){
    if (!S.running) return;
    const now = performance.now();
    if (!S.video || S.video.readyState < 2) return;
    if (!S.wantFrame) { S.stats.dropped++; return; }     // inference still busy: skip, never queue
    if (now - S.lastSentT < S.minIntervalMs) return;

    /* the capture timestamp is taken HERE, when the pixels are grabbed */
    const t = now;
    S.lastSentT = t;

    /* letterbox the camera frame into a square without distorting the body: a stretched body
       would change every angle we measure */
    const v = S.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const s = Math.min(CAPTURE/vw, CAPTURE/vh);
    const dw = vw*s, dh = vh*s, dx = (CAPTURE-dw)/2, dy = (CAPTURE-dh)/2;

    if (S.mode === 'worker' && S.off){
      const g = S.offCtx;
      g.clearRect(0,0,CAPTURE,CAPTURE);
      g.drawImage(v, dx, dy, dw, dh);
      const bmp = S.off.transferToImageBitmap();
      S.wantFrame = false; S.stats.sent++;
      S.worker.postMessage({ type:'frame', bitmap:bmp, t }, [bmp]);
    } else if (S.mode === 'worker'){
      /* no OffscreenCanvas: hand over an ImageBitmap made from the visible canvas instead */
      const g = S.ctx;
      g.clearRect(0,0,CAPTURE,CAPTURE);
      g.drawImage(v, dx, dy, dw, dh);
      S.wantFrame = false; S.stats.sent++;
      createImageBitmap(S.canvas).then((bmp)=>{
        S.worker.postMessage({ type:'frame', bitmap:bmp, t }, [bmp]);
      }).catch(()=>{ S.wantFrame = true; });
    } else if (S.inline){
      const g = S.ctx;
      g.clearRect(0,0,CAPTURE,CAPTURE);
      g.drawImage(v, dx, dy, dw, dh);
      S.stats.sent++;
      const t0 = performance.now();
      let res = null;
      try { res = S.inline.detectForVideo(S.canvas, t); } catch (e){ /* monotonic guard below */ }
      S.stats.inferMs = performance.now() - t0;
      S.stats.got++;
      if (S.onResult) S.onResult(res, t);
    }
    /* the letterbox offsets, so a caller drawing an overlay can undo them */
    S.box = { dx, dy, dw, dh, size:CAPTURE };
}

export function start(S){
  if (S.running) return;
  S.running = true;
  let lastTick = performance.now();

  const tick = ()=>{
    if (!S.running) return;
    S._raf = requestAnimationFrame(tick);
    const now = performance.now();
    /* rolling fps of the capture loop, which is the render rate, not the inference rate */
    S._fpsWindow.push(now - lastTick); if (S._fpsWindow.length > 30) S._fpsWindow.shift();
    lastTick = now;
    let sum = 0; for (const d of S._fpsWindow) sum += d;
    S.stats.fps = S._fpsWindow.length ? 1000/(sum/S._fpsWindow.length) : 0;
    pump(S);
  };
  S._raf = requestAnimationFrame(tick);
}

export function stop(S){ S.running = false; if (S._raf) cancelAnimationFrame(S._raf); }

/* Landmarks come back in the letterboxed square's coordinates. Undo that so x and y are
   fractions of the ORIGINAL camera frame, which is what every ratio downstream assumes. */
export function unletterbox(S, res){
  if (!res || !res.landmarks || !res.landmarks[0] || !S.box) return res;
  const { dx, dy, dw, dh, size } = S.box;
  for (const p of res.landmarks[0]){
    p.x = (p.x*size - dx)/dw;
    p.y = (p.y*size - dy)/dh;
  }
  return res;
}
