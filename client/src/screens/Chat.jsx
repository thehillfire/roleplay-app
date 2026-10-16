import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function Chat({ id, socket, onBack }) {
  const [convo, setConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const endRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);

  const load = useCallback(() => {
    setError('');
    api.conversation(id).then((d) => {
      setConvo(d.conversation);
      setMessages(d.messages);
      api.markRead(id).catch(() => {});
    }, (err) => setError(err.message));
  }, [id]);

  useEffect(load, [load]);

  // Live events for this conversation.
  useEffect(() => {
    const offMessage = socket.on('message', ({ message }) => {
      if (message.conversationId !== id) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setPartnerTyping(false);
      api.markRead(id).catch(() => {});
    });
    const offTyping = socket.on('typing', ({ conversationId }) => {
      if (conversationId !== id) return;
      setPartnerTyping(true);
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setPartnerTyping(false), 4000);
    });
    // After a reconnect, refetch in case messages arrived while offline.
    const offOpen = socket.on('open', load);
    return () => { offMessage(); offTyping(); offOpen(); clearTimeout(typingTimer.current); };
  }, [socket, id, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, partnerTyping]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    try {
      const message = await api.send(id, body);
      setMessages((prev) => [...prev, message]);
      setDraft('');
    } catch (err) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const onChange = (e) => {
    setDraft(e.target.value);
    const t = Date.now();
    if (t - lastTypingSent.current > 2500) {
      lastTypingSent.current = t;
      socket.send({ type: 'typing', conversationId: id });
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  if (error) {
    return (
      <main className="screen">
        <button className="back" onClick={onBack}>← Back</button>
        <div className="card error"><p>{error}</p><button className="btn" onClick={load}>Try again</button></div>
      </main>
    );
  }

  return (
    <main className="chat">
      <header className="chat-head">
        <button className="back" onClick={onBack} aria-label="Back to conversations">←</button>
        {convo && (
          <div className="chat-who">
            <span className="avatar" aria-hidden="true">{convo.partner.handle.slice(0, 1)}</span>
            <span>
              <strong>{convo.partner.handle}</strong>
              <small>{partnerTyping ? 'typing…' : convo.partner.online ? 'online' : 'anonymous'}</small>
            </span>
          </div>
        )}
      </header>

      <div className="messages" aria-live="polite">
        {convo && messages.length === 0 && (
          <p className="empty">You're connected with {convo.partner.handle}. Say hi, share what's on your mind, or ask how their day is going.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.fromMe ? 'bubble me' : 'bubble them'}>
            <p>{m.body}</p>
            <time dateTime={new Date(m.createdAt).toISOString()}>{formatTime(m.createdAt)}</time>
          </div>
        ))}
        {partnerTyping && <div className="bubble them typing" aria-label="typing"><span /><span /><span /></div>}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        {sendError && <p className="form-error" role="alert">{sendError}</p>}
        <div className="composer-row">
          <textarea
            value={draft}
            onChange={onChange}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={2000}
            placeholder="Message"
            aria-label="Message"
          />
          <button className="btn primary" type="submit" disabled={sending || !draft.trim()}>Send</button>
        </div>
      </form>
    </main>
  );
}
