import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from '@/lib/router';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Service worker: makes the app installable and usable offline after the first visit.
registerSW({ immediate: true });

// When a new version of the app takes over, switch to it: straight away on the upload
// screen, otherwise the next time the app is opened again (never in the middle of work).
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let pending = false;
  const reloadIfIdle = () => {
    if (pending && location.pathname === '/') location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    pending = true;
    if (location.pathname === '/') location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pending) location.reload();
  });
  window.addEventListener('popstate', reloadIfIdle);
  window.addEventListener('qp:navigate', reloadIfIdle);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>,
);
