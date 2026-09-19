// Enables multi-threaded WebAssembly on static hosts (like GitHub Pages)
// that can't be configured to send the Cross-Origin-Opener-Policy /aCross-
// Origin-Embedder-Policy response headers browsers require for that.
// Standard technique, based on the public-domain "coi-serviceworker" pattern
// (github.com/gzuidhof/coi-serviceworker, MIT).
//
// On first load it registers itself as a service worker, which then adds
// the required headers to every response it proxies (same-origin app files
// as well as cross-origin fetches like the model download), and reloads the
// page once so the browsing context becomes cross-origin-isolated. Without
// this, onnxruntime-web's WASM backend is limited to a single CPU thread.
// With it, it can use multiple cores, which is the single biggest lever for
// generation speed on a phone.

if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
          newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((err) => console.error('[coi-serviceworker] fetch failed', err))
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated) return;
    if (!window.isSecureContext) return;
    if (!navigator.serviceWorker) return;

    navigator.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        registration.addEventListener('updatefound', () => window.location.reload());
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      (err) => console.error('[coi-serviceworker] registration failed', err)
    );
  })();
}
