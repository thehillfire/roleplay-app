import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { registerServiceWorker } from './notifications.js';
import { applyTextSize } from './textSize.js';
import { applyAccent } from './accent.js';

registerServiceWorker();
applyTextSize();
applyAccent();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
