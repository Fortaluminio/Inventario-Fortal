const CACHE = 'inventario-fortal-v13';
const CORE = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './data/products.json', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const isImage = e.request.url.includes('/assets/products/');
  if (isImage) {
    // Fotos de produtos não mudam: cache primeiro, é mais rápido.
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
    return;
  }
  // Código do app: tenta buscar a versão mais nova primeiro; só usa o
  // cache se estiver sem internet.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
