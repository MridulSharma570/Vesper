import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from './App';
import { PublicSite, currentPath } from './components/PublicSite';
import './styles/app.css';

/**
 * Entry point.
 *
 * StrictMode is kept on: it double-invokes effects in development, which is how
 * the socket's connect/disconnect symmetry gets tested before it reaches a user.
 *
 * The root element is removed from the DOM only after React has mounted, so a
 * failed bundle leaves the noscript fallback visible instead of a blank page.
 *
 * The router lives here, above everything: '/', the app's home, mounts the
 * signed-in product; every other path mounts the public site (policies, FAQ,
 * report form, 404). Unknown paths render the not-found view with a truthful
 * 404 status already served by the API, so crawlers and humans agree.
 */
function Root(): JSX.Element {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (path !== '/') return <PublicSite />;
  return <App />;
}

/* Installable PWA: the service worker is what turns the web app into a
 * zero-store Android/desktop install. Development skips it so hot reloads
 * never fight a cache. */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Offline support is progressive enhancement; never block boot. */
    });
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
