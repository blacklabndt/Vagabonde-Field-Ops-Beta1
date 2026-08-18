// Push handlers, importScripts'd into the generated service worker (see
// vite.config.js). Kept as its own file because workbox's generateSW
// writes sw.js itself — this is the one piece of hand-written worker
// code the app has.

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* an unreadable payload still buzzes */ }
  event.waitUntil(self.registration.showNotification(data.title || "Team chat", {
    body: data.body || "New message",
    icon: "/icons/icon-192.png",
    // The status-bar icon. Android renders only its alpha silhouette —
    // this is the wordmark's V, white on transparent (badge-96.png,
    // extracted from icon-192) — and without one, Chrome shows a
    // generic bell up there instead of the app.
    badge: "/icons/badge-96.png",
    // One tag: a burst of messages collapses into the latest notification
    // instead of stacking a dozen on the lock screen.
    tag: "team-chat",
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      // An open app gets focused rather than duplicated — and told where
      // the tap meant to land, because a focus alone would leave it on
      // whatever screen it happened to be showing. The closed-app path
      // carries the same destination in the URL instead.
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "goto", screen: "chat" });
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
