import { useEffect, useRef, useState } from 'react';
import { hype } from '../hype.js';

const SMILE_AT = 0.55; // MediaPipe's smile score, 0 to 1
const COOLDOWN_MS = 4000; // one smile counts once, not every frame

// Don't Smile: text each other until someone cracks. Your camera (optional) only checks your
// own face, on this device; the other person never sees it. Without a camera, own up with a tap.
// The score is kept per conversation on this device, so a reload doesn't wipe it.
const scoreKey = (id) => `kindred.nosmile.${id}`;
function readScore(id) {
  try {
    const s = JSON.parse(localStorage.getItem(scoreKey(id)) || 'null');
    return { mine: Number(s?.mine) || 0, theirs: Number(s?.theirs) || 0 };
  } catch {
    return { mine: 0, theirs: 0 };
  }
}

export default function NoSmile({ conversationId, socket, solo = false }) {
  const [mine, setMine] = useState(() => (solo ? 0 : readScore(conversationId).mine)); // times I smiled (their points)
  const [theirs, setTheirs] = useState(() => (solo ? 0 : readScore(conversationId).theirs)); // times they smiled (my points)
  const [cooling, setCooling] = useState(false); // just counted: show it, so repeat taps don't look ignored
  useEffect(() => {
    if (solo) return;
    try { localStorage.setItem(scoreKey(conversationId), JSON.stringify({ mine, theirs })); } catch { /* private mode */ }
  }, [solo, conversationId, mine, theirs]);
  const [camera, setCamera] = useState('off'); // off | loading | on | error
  const [cameraError, setCameraError] = useState('');
  const [live, setLive] = useState(null); // current smile score, for the meter
  const videoRef = useRef(null);
  const stopRef = useRef(() => {});
  const lastSmile = useRef(0);

  const smiled = () => {
    const t = Date.now();
    if (t - lastSmile.current < COOLDOWN_MS) return;
    lastSmile.current = t;
    setMine((n) => n + 1);
    setCooling(true);
    setTimeout(() => setCooling(false), COOLDOWN_MS);
    if (!solo) socket.send({ type: 'game', conversationId, kind: 'smiled' });
    hype({ kind: 'cracked' });
  };
  const smiledRef = useRef(smiled);
  smiledRef.current = smiled;

  useEffect(() => {
    if (solo) return undefined; // practice: nobody on the other end
    return socket.on('game', (e) => {
      if (e.conversationId !== conversationId || e.kind !== 'smiled') return;
      setTheirs((n) => n + 1);
      hype({ kind: 'gotem' });
    });
  }, [socket, conversationId, solo]);

  useEffect(() => () => stopRef.current(), []);

  const startCamera = async () => {
    setCamera('loading');
    setCameraError('');
    let stream;
    let detector;
    let frame;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((tr) => tr.stop());
      detector?.close();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    stopRef.current = stop;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 }, audio: false });
      const { createSmileDetector } = await import('../smile.js');
      detector = await createSmileDetector();
      if (stopped) return;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      setCamera('on');
      let lastCheck = 0;
      const loop = (t) => {
        if (stopped) return;
        if (t - lastCheck > 120 && video.readyState >= 2) {
          lastCheck = t;
          const score = detector.smile(video, t);
          setLive(score);
          if (score !== null && score > SMILE_AT) smiledRef.current();
        }
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    } catch (err) {
      stop();
      setCamera('error');
      setCameraError(err?.name === 'NotAllowedError'
        ? 'Camera permission was refused. You can still play: tap "I smiled" when you crack.'
        : "This device couldn't start the smile check. You can still play on the honor system.");
    }
  };

  const stopCamera = () => {
    stopRef.current();
    setCamera('off');
    setLive(null);
  };

  const watching = camera === 'loading' || camera === 'on';
  return (
    <section className="game-panel nosmile" aria-label="Don't Smile">
      <header>
        <span className="game-tag">#dontsmile</span>
        <span className="game-score" aria-live="polite">{solo ? `Cracked ${mine}` : `You ${theirs} · Them ${mine}`}</span>
      </header>
      <p className="game-card">
        {solo
          ? 'Practice round: keep a straight face. Every time you crack, tap "I smiled" (or let the camera catch you).'
          : "Make them smile. Don't smile yourself. Every time someone cracks, the other one scores."}
      </p>
      <div className="game-actions">
        {/* One <video> for the panel's whole life: the stream is attached to this element, so it
            must never be swapped for another one (that left the preview a black box). */}
        <div className="selfcam" hidden={!watching}>
          <video ref={videoRef} muted playsInline aria-label="Your camera (only you can see this)" />
          <span className="meter" aria-hidden="true"><span style={{ width: `${Math.round((live || 0) * 100)}%` }} /></span>
          <small className="hint">{camera === 'on' ? 'Only you see this. It never leaves your phone.' : 'Starting the camera…'}</small>
          {camera === 'on' && <button className="link" onClick={stopCamera}>Turn camera off</button>}
        </div>
        {!watching && <button className="btn" onClick={startCamera}>Use my camera</button>}
        <button className="btn" onClick={smiled} disabled={cooling}>{cooling ? 'Counted ✓' : 'I smiled 😬'}</button>
      </div>
      {cameraError && <p className="hint">{cameraError}</p>}
    </section>
  );
}
