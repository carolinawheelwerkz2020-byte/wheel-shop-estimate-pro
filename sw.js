/* Wheel Shop Estimate Pro — offline service worker (phone copy) */
const CACHE = 'wsep-v4';
/* Core app: installed atomically. The OCR engine (~18 MB) and PDF library
   load on demand from pinned CDNs (see app.js / index.html) and are cached
   by the fetch handler below, so a slow first download can never break the
   core offline install. */
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './tesseract.min.js',
  './tesseract-worker.min.js',
];

/* App icons ship as base64 text (real name + '.b64') because this copy is
   deployed through a text-only channel. Decoded to true bytes on first
   request and cached. */
const B64 = {
  'icon-192.png': { src: 'icons/icon-192.png.b64', type: 'image/png' },
  'icon-512.png': { src: 'icons/icon-512.png.b64', type: 'image/png' },
};

function fileName(pathname) {
  const parts = pathname.split('/');
  return parts[parts.length - 1];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Base64-wrapped icons: decode once, cache the true bytes.
  const b64 = B64[fileName(url.pathname)];
  if (b64) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        const srcUrl = new URL(b64.src, self.location.href).href;
        return fetch(srcUrl).then((r) => {
          if (!r || r.status !== 200) throw new Error('b64 missing: ' + b64.src);
          return r.text();
        }).then((text) => {
          const raw = atob(text.replace(/\s+/g, ''));
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          const res = new Response(bytes, { headers: { 'Content-Type': b64.type } });
          caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
