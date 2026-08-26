const CACHE_NAME = "osce-timer-v5";
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.ico",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./fonts/FC_Minimal_Regular.ttf",
  "./fonts/FC_Minimal_Bold.ttf",
  "./sound/เสียงเตือน.wav",
  "./sound/กริ่งยาว.wav",
  "./sound/กริ่งหมดเวลา.wav"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        APP_FILES.map(url =>
          fetch(url).then(response => {
            if (!response.ok) throw new Error(url + " -> " + response.status);
            return cache.put(url, response);
          }).catch(err => {
            console.warn("[service-worker] cache failed for", url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
