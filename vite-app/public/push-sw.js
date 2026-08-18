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
      // An open app is navigated to the destination, not just focused —
      // a focus alone leaves it on whatever screen it was showing. This
      // began life as a postMessage the page listened for, which broke
      // whenever the running page was a build behind the worker (an
      // app-switcher resume never reloads); a navigation always lands
      // on the newest build, and ?goto=chat does the rest. Both paths,
      // open and closed, now funnel through the same URL.
      for (const c of list) {
        if ("navigate" in c) {
          return c.navigate(url).then(w => (w || c).focus()).catch(() => c.focus());
        }
        if ("focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
