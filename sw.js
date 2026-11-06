// Cave Informa: funzionamento offline.
// Quando cambi i file dell'app, aumenta il numero di versione qui sotto (2.0, 2.1, 2.2…)
// e scrivi lo stesso numero in index.html, nella riga "Versione …" della pagina Informazioni.
const VERSION = "allerta-cave-3.22";
const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/badge-96.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pagina: prima la rete (per avere sempre l'ultima versione), poi la copia salvata.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) // salta la cache del browser (GitHub Pages tiene le pagine per 10 minuti)
        .then((res) => {
          // ogni pagina salvata col suo nome (app e pagina amministratori sono pagine diverse)
          if (res.ok) { const copy = res.clone(); const key = /admin\.html$/.test(url.pathname) ? "./admin.html" : "./index.html"; caches.open(VERSION).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(/admin\.html$/.test(url.pathname) ? "./admin.html" : "./index.html"))
    );
    return;
  }

  // Elenco dei DAE: prima la rete (si aggiorna ogni ora), poi la copia salvata.
  if (url.origin === self.location.origin && url.pathname.endsWith("/dae.json")) {
    e.respondWith(fetch(req, { cache: "no-store" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("./dae.json", copy)); }
      return res;
    }).catch(() => caches.match("./dae.json")));
    return;
  }

  // File dell'app e font: prima la copia salvata, poi la rete.
  const isSameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (isSameOrigin || isFont) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});

self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });

/* Notifiche push */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Cave Informa", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png", // Android: sagoma bianca nella barra in alto
    tag: d.tag,
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  const admin = /admin\.html/.test(url);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    // finestra già aperta della stessa pagina (app o pagina admin): la porto in primo piano e le dico dove andare
    const stessa = list.find((c) => c.url.startsWith(self.registration.scope) && /admin\.html/.test(c.url) === admin);
    if (stessa) {
      try { await stessa.focus(); } catch (err) {}
      stessa.postMessage({ tipo: "apri", url });
      return;
    }
    return self.clients.openWindow(url);
  }));
});
