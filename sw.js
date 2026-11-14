const CACHE_NAME = "gadlink-static-v37";
const APP_SHELL = [
  "./",
  "./index.html",
  "./confirm.html",
  "./style.css?v=14",
  "./app.js?v=20",
  "./js/auth.js",
  "./js/confirm.js",
  "./js/supabaseClient.js",
  "./js/push-notifications.js",
  "./js/pwa-install.js",
  "./js/chat-background.js",
  "./js/friends-ui.js?v=4",
  "./js/friends.js",
  "./js/reels.js?v=5",
  "./js/voice-calls.js?v=2",
  "./js/voice-rooms.js",
  "./manifest.webmanifest",
  "./assets/gadlink-icon.svg",
  "./assets/gadlink-icon-192.png",
  "./assets/gadlink-icon-512.png",
  "./assets/gadlink-icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("gadlink-static-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      request.headers.has("range") || /\.(mp4|m4v|mov|webm|ogg)$/i.test(url.pathname) ||
      url.pathname.includes("/rest/") || url.pathname.includes("/auth/") ||
      url.pathname.includes("/storage/") || url.pathname.includes("/functions/")) return;
  if (request.mode === "navigate") {
  event.respondWith(
    fetch(request, { cache: "no-cache" }).catch(async () => {
      const page = url.pathname.endsWith("/confirm.html")
        ? "./confirm.html"
        : "./index.html";

      return (await caches.match(page)) || Response.error();
    })
  );
  return;
}
  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: "no-cache" });
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});

async function reportPushFailure(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: "GADLINK_PUSH_ERROR", message });
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data?.json();
    } catch (error) {
      console.error("GadLink push payload is invalid:", error);
      await reportPushFailure("Получено некорректное сообщение от сервера уведомлений.");
      return;
    }
    if (!payload || !["message", "incoming_call", "missed_call", "call_state"].includes(payload.type)) {
      console.error("GadLink push payload has an unsupported notification type.");
      await reportPushFailure("Сервер прислал уведомление неподдерживаемого типа.");
      return;
    }

    if (payload.type === "call_state") {
      if (!payload.callId) return;
      const notifications = await self.registration.getNotifications({
        tag: `gadlink-call-${payload.callId}`
      });
      notifications.forEach((notification) => notification.close());
      return;
    }

    const options = {
      body: payload.body || "Откройте GadLink, чтобы посмотреть.",
      icon: new URL("./assets/gadlink-icon-192.png", self.registration.scope).href,
      badge: new URL("./assets/gadlink-icon-192.png", self.registration.scope).href,
      tag: payload.tag || `gadlink-${payload.type}-${payload.eventId || "event"}`,
      renotify: false,
      data: {
        type: payload.type,
        conversationId: payload.conversationId || null,
        callId: payload.callId || null,
        url: payload.url || "./"
      }
    };
    if (payload.type === "incoming_call") {
      options.requireInteraction = true;
      options.actions = [
        { action: "answer", title: "Ответить" },
        { action: "reject", title: "Отклонить" }
      ];
      if (typeof payload.image === "string" && payload.image.startsWith("https://")) {
        options.image = payload.image;
      }
    }
    try {
      await self.registration.showNotification(payload.title || "GadLink", options);
    } catch (error) {
      console.error("GadLink could not display push notification:", error);
      try {
        await reportPushFailure(
          error?.name === "NotAllowedError"
            ? "Уведомления заблокированы в настройках браузера."
            : (error instanceof Error ? error.message : "Проверьте разрешение на уведомления в браузере.")
        );
      } catch (reportError) {
        console.error("GadLink could not report push notification error:", reportError);
      }
      throw error;
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action;
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    const target = new URL(data.url || "./", self.registration.scope);
    if (target.origin !== self.location.origin ||
        !target.pathname.startsWith(new URL(self.registration.scope).pathname)) {
      target.href = self.registration.scope;
    }
    if (data.conversationId) target.searchParams.set("conversation", data.conversationId);
    if (data.callId) target.searchParams.set("call", data.callId);
    if (data.callId && (action === "answer" || action === "reject")) {
      target.searchParams.set("callAction", action);
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope) && "focus" in client) {
        await client.navigate(target.href);
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
