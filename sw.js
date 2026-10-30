// Service worker that adds the cross-origin isolation headers GitHub Pages
// can't set itself. Isolation lets the voice engine use WebAssembly threads
// (SharedArrayBuffer), which is much faster on multi-core phones. The page
// registers this only while threads are enabled; see the script in index.html.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        // Opaque responses (status 0) can't have headers rewritten; pass them through.
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch((err) => console.error('sw fetch failed', err))
  );
});
