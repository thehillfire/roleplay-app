import { Component } from 'react';

// Sends what broke to the server log, once per distinct error. Never throws.
const reported = new Set();
export function reportClientError(error) {
  try {
    const message = String(error?.message || error || 'Unknown error').slice(0, 300);
    if (reported.has(message) || reported.size > 20) return;
    reported.add(message);
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, stack: String(error?.stack || '').slice(0, 600), where: window.location.pathname }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* reporting is best effort */ }
}

// If a screen crashes, show a way out instead of a blank page.
export default class CrashScreen extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    reportClientError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="screen crash" role="alert">
        <h1 className="find-title">Something broke</h1>
        <p className="hint">That screen hit a problem. It has been reported. Reloading usually fixes it, and your chats are safe.</p>
        <button className="btn primary big" onClick={() => window.location.assign('/')}>Reload Kindred</button>
      </main>
    );
  }
}
