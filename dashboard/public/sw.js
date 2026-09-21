/**
 * Kyro Service Worker
 *
 * Handles incoming Web Push notifications when the app is in background or closed.
 * Clicking the notification opens the Live Cameras page.
 */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); } catch { data = { title: "Kyro Alert", body: event.data.text() }; }

  const title   = data.title || "Kyro Alert";
  const options = {
    body:    data.body || "",
    icon:    "/icon-192.png",
    badge:   "/icon-badge.png",
    tag:     data.tag  || "kyro-alert",
    data:    { url: "/live-cameras", level: data.level || "info", camera_id: data.camera_id },
    vibrate: data.level === "critical" ? [200, 100, 200, 100, 200] : [200, 100, 200],
    requireInteraction: data.level === "critical",   // critical stays until dismissed
    actions: [
      { action: "view",    title: "View cameras" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const url = (event.notification.data && event.notification.data.url) || "/live-cameras";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // Focus existing Kyro tab if open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Keep service worker alive for background sync
self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
