// One WebSocket for the whole app, reconnecting with backoff. Components subscribe
// to server events with `on(type, fn)`; `send` drops events while disconnected.
export function createSocket({ onStatus = () => {} } = {}) {
  const listeners = new Map();
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const emit = (type, event) => {
    for (const fn of listeners.get(type) || []) fn(event);
    for (const fn of listeners.get('*') || []) fn(event);
  };

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    onStatus('connecting');
    ws.onopen = () => {
      attempt = 0;
      onStatus('online');
      emit('open', {});
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        emit(event.type, event);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (e) => {
      onStatus('offline');
      emit('close', { code: e.code, attempt });
      if (closed) return;
      const delay = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      attempt += 1;
      timer = setTimeout(open, delay);
    };
  }

  return {
    // Started (and stopped) by the component that owns it, so React's development double
    // effects can stop and restart it cleanly.
    start() {
      if (ws && !closed) return;
      closed = false;
      attempt = 0;
      open();
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    send(event) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}
