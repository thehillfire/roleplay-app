import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import CrashScreen, { reportClientError } from './components/CrashScreen.jsx';
import './styles.css';
import { registerServiceWorker } from './notifications.js';
import { applyTextSize } from './textSize.js';
import { applyAccent } from './accent.js';
import './shell.js'; // tags <html data-shell> before the first render

registerServiceWorker();
window.addEventListener('error', (e) => reportClientError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason));
applyTextSize();
applyAccent();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
