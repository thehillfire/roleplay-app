import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { registerServiceWorker } from './notifications.js';
import { applyTextSize } from './textSize.js';

registerServiceWorker();
applyTextSize();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
