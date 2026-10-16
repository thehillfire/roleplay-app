import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { CrisisCard, ReportSheet, heldNote } from '../components/Safety.jsx';
import { ConnectBanner, ConnectSheet } from '../components/Connect.jsx';

const PAGE = 50; // server page size
const UNSEND_WINDOW_MS = 5 * 60 * 1000;
const REACTIONS = [['💙', 'Support'], ['🫂', 'Hug'], ['🙏', 'Thank you']];

// Shown in an empty conversation so nobody has to stare at a blank box.
const OPENERS = [
  'Hey. Rough day?',
  "Hi, I'm here to listen. What's on your mind?",
  "I just need to vent for a minute, if that's okay.",
  'Hi! How are you really doing today?',
];
// Leaving without a word hurts when someone just opened up. One tap drafts a warm
// goodbye they can edit before sending; the conversation stays open.
const GOODBYE = "I need to head off now. Thank you for talking with me. Take care of yourself, and come back anytime 💙";

// On touch devices Enter makes a new line (people write paragraphs when they vent);
// on keyboards it sends. Shift+Enter always makes a new line.
// Only count something as read when the chat is actually on screen.
const markReadIfVisible = (id) => {
  if (document.visibilityState === 'visible') api.markRead(id).catch(() => {});
};

const touchKeyboard = () => window.matchMedia?.('(pointer: coarse)').matches;

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function Chat({ id, socket, onBack, onLeft, onPaused, billing, credits, onCreditsChanged }) {
  const [convo, setConvo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [ended, setEnded] = useState(false);
  const [crisis, setCrisis] = useState(null); // 'sender' | 'listener' | null
  const [menuOpen, setMenuOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [connectSheet, setConnectSheet] = useState(null); // null | 'request' | 'accept'
  const [hasMore, setHasMore] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState(false);
  const [kindNote, setKindNote] = useState(null); // null, or the note being written after "it helped"
  const [kindError, setKindError] = useState('');
  const [partnerReadAt, setPartnerReadAt] = useState(0);
  const [reactingTo, setReactingTo] = useState(null); // message id with the picker open
  const [selected, setSelected] = useState(null); // tapped message: shows its actions
  // Ticks so time-limited actions (Unsend) disappear on time even in an idle chat.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const [loadingMore, setLoadingMore] = useState(false);
  const endRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);

  const crisisChecked = useRef(false);
  const load = useCallback(() => {
    setError('');
    api.conversation(id).then((d) => {
      setConvo(d.conversation);
      setMessages(d.messages);
      // Opening a chat whose recent messages from them mention crisis: show listener guidance once.
      if (!crisisChecked.current) {
        crisisChecked.current = true;
        if (d.messages.slice(-10).some((m) => !m.fromMe && m.crisis)) setCrisis((c) => c || 'listener');
      }
      setPartnerReadAt(d.conversation.partnerReadAt || 0);
      setHasMore(d.messages.length >= PAGE);
      markReadIfVisible(id);
    }, (err) => setError(err.message));
  }, [id]);

  useEffect(load, [load]);

  // Live events for this conversation.
  useEffect(() => {
    const offMessage = socket.on('message', ({ message }) => {
      if (message.conversationId !== id) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      setPartnerTyping(false);
      if (message.crisis) setCrisis('listener');
      markReadIfVisible(id);
    });
    const offTyping = socket.on('typing', ({ conversationId }) => {
      if (conversationId !== id) return;
      setPartnerTyping(true);
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setPartnerTyping(false), 4000);
    });
    const offEnded = socket.on('conversation.ended', ({ conversationId }) => {
      if (conversationId === id) setEnded(true);
    });
    const offReacted = socket.on('message.reacted', ({ conversationId, messageId, reaction }) => {
      if (conversationId !== id) return;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reaction } : m)));
    });
    // A moderator delivered one of my held messages after all.
    const offReleased = socket.on('message.released', ({ conversationId, messageId }) => {
      if (conversationId !== id) return;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'delivered', flags: undefined } : m)));
    });
    const offUnsent = socket.on('message.unsent', ({ conversationId, messageId }) => {
      if (conversationId !== id) return;
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'unsent', body: '' } : m)));
    });
    const offRead = socket.on('read', ({ conversationId, at }) => {
      if (conversationId === id) setPartnerReadAt((prev) => Math.max(prev, at));
    });
    const offConnect = socket.on('connect.updated', ({ conversationId, connection }) => {
      if (conversationId !== id) return;
      setConvo((c) => (c ? { ...c, connection } : c));
      onCreditsChanged(); // a declined request refunds the requester's credit
    });
    // After a reconnect, refetch in case messages arrived while offline.
    const offOpen = socket.on('open', load);
    // Coming back to the tab/app marks what arrived meanwhile as read.
    const onVisible = () => markReadIfVisible(id);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offMessage(); offTyping(); offEnded(); offReacted(); offReleased(); offUnsent(); offRead(); offConnect(); offOpen();
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(typingTimer.current);
    };
  }, [socket, id, load, onCreditsChanged]);

  // Follow the newest message (not older pages loaded above).
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId, partnerTyping]);

  const loadEarlier = async () => {
    setLoadingMore(true);
    try {
      const d = await api.conversation(id, messages[0]);
      setMessages((prev) => [...d.messages.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setHasMore(d.messages.length >= PAGE);
    } catch (err) {
      setSendError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    try {
      const res = await api.send(id, body);
      setMessages((prev) => [...prev, res.message]);
      setDraft('');
      if (res.crisis) setCrisis('sender');
      if (res.paused) onPaused();
    } catch (err) {
      if (err.status === 403 && /paused/.test(err.message)) onPaused();
      else if (err.status === 403) setEnded(true);
      else setSendError(err.message);
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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) {
      e.preventDefault();
      send();
    }
  };

  // "End" and "Block" both close the conversation for good; they differ only in tone.
  const close = async (kind) => {
    setMenuOpen(false);
    const ask = kind === 'end'
      ? `End this conversation with ${convo.partner.handle}? Neither of you will be able to message the other, and you won't be matched again.`
      : `Block ${convo.partner.handle}? You won't see each other again.`;
    if (!window.confirm(ask)) return;
    try {
      await api.block(id);
      onLeft(kind === 'end' ? `Conversation with ${convo.partner.handle} ended.` : `You blocked ${convo.partner.handle}.`);
    } catch (err) {
      setSendError(err.message);
    }
  };

  const toggleMute = async () => {
    setMenuOpen(false);
    try {
      const { muted } = await api.mute(id, !convo.muted);
      setConvo((c) => ({ ...c, muted }));
    } catch (err) {
      setSendError(err.message);
    }
  };

  const hide = async () => {
    setMenuOpen(false);
    try {
      await api.hide(id);
      onLeft(`Hidden. ${convo.partner.handle} comes back to your list if either of you writes again.`);
    } catch (err) {
      setSendError(err.message);
    }
  };

  const setConnection = (connection) => setConvo((c) => ({ ...c, connection }));

  const connect = async (name, contact) => {
    const { connection } = await api.connect(id, name, contact);
    setConnection(connection);
    setConnectSheet(null);
    onCreditsChanged();
  };

  const declineConnect = async () => {
    try {
      setConnection((await api.declineConnect(id)).connection);
    } catch (err) {
      setSendError(err.message);
    }
  };

  const cancelConnect = async () => {
    try {
      setConnection((await api.cancelConnect(id)).connection);
      onCreditsChanged();
    } catch (err) {
      setSendError(err.message);
    }
  };

  // Escape or a tap elsewhere closes the options menu.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => e.key === 'Escape' && setMenuOpen(false);
    const onClick = (e) => !e.target.closest('.menu-wrap') && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, [menuOpen]);

  const react = async (messageId, reaction) => {
    setReactingTo(null);
    const current = messages.find((m) => m.id === messageId)?.reaction;
    const next = current === reaction ? null : reaction; // tapping the same one clears it
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reaction: next } : m)));
    try {
      await api.react(id, messageId, next);
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reaction: current } : m)));
      setSendError(err.message);
    }
  };

  const unsend = async (messageId) => {
    try {
      await api.unsend(id, messageId);
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, status: 'unsent', body: '' } : m)));
    } catch (err) {
      setSendError(err.message);
    }
  };

  const giveFeedback = async (helpful) => {
    setFeedbackDone(true);
    try {
      await api.feedback(id, helpful);
      if (helpful) setKindNote('');
    } catch {
      // Not worth interrupting the conversation over.
    }
  };

  const sendKindNote = async (e) => {
    e.preventDefault();
    setKindError('');
    try {
      await api.sendKindWords(id, kindNote);
      setKindNote(null);
    } catch (err) {
      setKindError(err.message);
    }
  };

  // "Seen" goes under my latest delivered message once they've read past it.
  const lastMine = [...messages].reverse().find((m) => m.fromMe && m.status !== 'held');
  const seenId = lastMine && messages[messages.length - 1]?.fromMe && partnerReadAt >= lastMine.createdAt ? lastMine.id : null;

  // Ask once a real exchange has happened (server says so, or we can see it here).
  const sentByMe = messages.filter((m) => m.fromMe && m.status !== 'held').length;
  const sentByThem = messages.filter((m) => !m.fromMe).length;
  const askFeedback = convo && !feedbackDone && !ended && convo.feedback?.helpful == null
    && (convo.feedback?.canRate || (sentByMe >= 2 && sentByThem >= 2));

  const report = async (reason, details) => {
    await api.report(id, reason, details);
    onLeft(`Thanks. ${convo.partner.handle} was reported and blocked. A moderator will review it.`);
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
              <h1 className="chat-name">{convo.partner.handle}</h1>
              <small>{partnerTyping ? 'typing…' : convo.partner.online ? 'online' : 'anonymous'}{convo.muted && <span aria-label=", notifications muted"> · 🔕</span>}</small>
            </span>
          </div>
        )}
        {convo && (
          <div className="menu-wrap">
            <button className="icon-btn" aria-label="Conversation options" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>⋯</button>
            {menuOpen && (
              <div className="menu" role="menu">
                {convo.connection?.status === 'none' && (
                  <button role="menuitem" onClick={() => { setMenuOpen(false); setConnectSheet('request'); }}>Connect…</button>
                )}
                <button role="menuitem" onClick={() => { setMenuOpen(false); setDraft(GOODBYE); document.querySelector('.composer textarea')?.focus(); }}>Say goodbye…</button>
                <button role="menuitem" onClick={toggleMute}>{convo.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
                <button role="menuitem" onClick={hide}>Hide from my list</button>
                <button role="menuitem" onClick={() => close('end')}>End conversation</button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); setReporting(true); }}>Report</button>
                <button role="menuitem" onClick={() => close('block')}>Block</button>
              </div>
            )}
          </div>
        )}
      </header>
      {convo && (
        <ConnectBanner
          connection={convo.connection}
          handle={convo.partner.handle}
          onAccept={() => setConnectSheet('accept')}
          onDecline={declineConnect}
          onCancel={cancelConnect}
        />
      )}
      {crisis && <CrisisCard role={crisis === 'sender' ? 'sender' : 'listener'} onDismiss={() => setCrisis(null)} />}

      <div className="messages" aria-live="polite">
        {hasMore && (
          <button className="link earlier" onClick={loadEarlier} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load earlier messages'}
          </button>
        )}
        {convo && messages.length === 0 && (
          <div className="openers">
            <p className="empty">You're connected with {convo.partner.handle}. Say hi, share what's on your mind, or ask how their day is going.</p>
            <div className="opener-chips">
              {OPENERS.map((o) => <button key={o} className="chip" onClick={() => setDraft(o)}>{o}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          m.status === 'unsent' ? (
            <div key={m.id} className={`bubble unsent ${m.fromMe ? 'me' : 'them'}`}>
              <p>{m.fromMe ? 'You unsent a message' : 'Message unsent'}</p>
            </div>
          ) : (
            <div
              key={m.id}
              className={`bubble ${m.fromMe ? 'me' : 'them'}${m.status === 'held' ? ' held' : ''}${selected === m.id ? ' selected' : ''}`}
              onClick={(e) => { if (!e.target.closest('button')) setSelected(selected === m.id ? null : m.id); }}
            >
              <p>{m.body}</p>
              {m.status === 'held' && <p className="held-note">{heldNote(m.flags)}</p>}
              {m.reaction && <span className="reaction" aria-label={`Reaction ${m.reaction}`}>{m.reaction}</span>}
              {reactingTo === m.id && (
                <div className="reaction-picker" role="group" aria-label="React">
                  {REACTIONS.map(([emoji, label]) => (
                    <button key={emoji} aria-label={label} aria-pressed={m.reaction === emoji} onClick={() => react(m.id, emoji)}>{emoji}</button>
                  ))}
                </div>
              )}
              <time dateTime={new Date(m.createdAt).toISOString()}>
                {formatTime(m.createdAt)}{m.id === seenId && ' · Seen'}
                {!m.fromMe && m.status === 'delivered' && (
                  <span className="msg-actions"> · <button className="link unsend" aria-expanded={reactingTo === m.id} onClick={() => setReactingTo(reactingTo === m.id ? null : m.id)}>React</button></span>
                )}
                {m.fromMe && m.status === 'delivered' && now - m.createdAt < UNSEND_WINDOW_MS - 5000 && (
                  <span className="msg-actions"> · <button className="link unsend" onClick={() => unsend(m.id)}>Unsend</button></span>
                )}
              </time>
            </div>
          )
        ))}
        {partnerTyping && <div className="bubble them typing" aria-label="typing"><span /><span /><span /></div>}
        <div ref={endRef} />
      </div>

      {askFeedback && (
        <div className="feedback-bar">
          <span>Did talking with {convo.partner.handle} help?</span>
          <button className="chip" onClick={() => giveFeedback(true)}>💙 Yes, thank them</button>
          <button className="chip" onClick={() => giveFeedback(false)}>Not really</button>
        </div>
      )}

      {kindNote !== null && (
        <form className="feedback-bar kind-note" onSubmit={sendKindNote}>
          <span>Thanks sent. Want to leave {convo.partner.handle} a few kind words? They'll see them on their home screen, not next to your name.</span>
          <input aria-label="Kind words" value={kindNote} onChange={(e) => setKindNote(e.target.value)} maxLength={140} placeholder="You really listened. Thank you." />
          <button className="chip" type="submit" disabled={!kindNote.trim()}>Leave it</button>
          <button className="chip" type="button" onClick={() => setKindNote(null)}>Skip</button>
          {kindError && <p className="form-error" role="alert">{kindError}</p>}
        </form>
      )}

      {ended ? (
        <div className="composer ended">
          <p>This conversation has ended.</p>
          <button className="btn" onClick={onBack}>Back to conversations</button>
        </div>
      ) : (
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
      )}

      {connectSheet && convo && (
        <ConnectSheet
          handle={convo.partner.handle}
          accepting={connectSheet === 'accept'}
          billing={billing}
          credits={credits}
          onSubmit={connect}
          onClose={() => setConnectSheet(null)}
        />
      )}
      {reporting && convo && <ReportSheet handle={convo.partner.handle} onSubmit={report} onClose={() => setReporting(false)} />}
    </main>
  );
}
