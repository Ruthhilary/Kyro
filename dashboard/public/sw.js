/**
 * Kyro Service Worker
 *
 * Delivers Web Push notifications when the app is in the background, the
 * browser is closed, or (on installed PWAs) the phone is locked.
 *
 * Routes tap-through by notification type:
 *   • review    → /seating?camera=<id>&review=<id>   (AI question to answer)
 *   • warning   → /attendance?camera=<id>             (capacity crossing)
 *   • critical  → /attendance?camera=<id>             (capacity exceeded)
 *   • offline   → /live-cameras?camera=<id>           (camera down)
 *   • anything else → payload.url if provided, else /live-cameras
 *
 * Backend can override the destination by putting `url` on the payload.
 */

const DEFAULT_URL = "/live-cameras";

function urlFromPayload(data) {
  if (data && typeof data.url === "string") return data.url;
  const camera = data && data.camera_id ? `?camera=${encodeURIComponent(data.camera_id)}` : "";
  switch (data && data.level) {
    case "review":                 return "/seating" + camera;
    case "warning":
    case "critical":               return "/attendance" + camera;
    case "offline":                return "/live-cameras" + camera;
    default:                       return DEFAULT_URL + camera;
  }
}

function actionsFor(level) {
  // iOS shows at most two actions; keep the primary one first everywhere.
  switch (level) {
    case "review":
      return [
        { action: "answer",  title: "Answer question" },
        { action: "dismiss", title: "Later" },
      ];
    case "critical":
    case "warning":
      return [
        { action: "view",    title: "View attendance" },
        { action: "dismiss", title: "Dismiss" },
      ];
    case "offline":
      return [
        { action: "view",    title: "View cameras" },
        { action: "dismiss", title: "Dismiss" },
      ];
    default:
      return [
        { action: "view",    title: "Open Kyro" },
        { action: "dismiss", title: "Dismiss" },
      ];
  }
}

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data = {};
  try { data = event.data.json(); }
  catch { data = { title: "Kyro Alert", body: event.data.text() }; }

  const title  = data.title || "Kyro Alert";
  const url    = urlFromPayload(data);
  const level  = data.level || "info";

  const options = {
    body:    data.body || "",
    icon:    "/icon-192.png",
    badge:   "/icon-badge.png",
    tag:     data.tag  || `kyro-${level}`,
    data:    { url, level, camera_id: data.camera_id, review_id: data.review_id },
    vibrate: level === "critical" ? [200, 100, 200, 100, 200]
           : level === "review"   ? [120, 60, 120]
                                  : [200, 100, 200],
    // Sticky for critical + review — anything requiring an operator to act.
    // Backend can also set this via payload.requireInteraction.
    requireInteraction:
      data.requireInteraction === true ||
      level === "critical" ||
      level === "review",
    renotify: true,
    actions: actionsFor(level),
    silent: false,
    timestamp: Date.now(),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  // "answer" is the review-notification primary action — same destination
  // as "view" but semantically labels the intent. The seating page reads
  // `?review=…` from the URL and auto-opens the answer panel for that
  // review, so the operator lands ONE tap away from Yes/No.
  const url =
    (event.notification.data && event.notification.data.url) || DEFAULT_URL;
  const origin = self.location.origin;

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // Reuse an existing Kyro tab if we have one.
    for (const client of wins) {
      if (!client.url.startsWith(origin)) continue;
      try {
        await client.focus();
        // navigate() only works on same-origin. Wrap in try — some
        // browsers throw when the client hasn't been controlled by the SW
        // (e.g. very first load).
        if (client.url !== origin + url) await client.navigate(url);
        return;
      } catch { /* fall through to openWindow below */ }
    }

    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// Firefox/Android also fire this when the user swipes the notification away
// without tapping — no action needed, just leave the hook so backend metrics
// stay consistent if we ever wire it up.
self.addEventListener("notificationclose", () => { /* no-op */ });

// Skip the "waiting" state so a new SW starts controlling pages immediately
// after deploy — otherwise users would keep the old SW until every tab
// closes, and old code paths could linger for days.
self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
