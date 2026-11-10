const CACHE_NAME = "gadlink-static-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./confirm.html",
  "./style.css",
  "./app.js",
  "./js/auth.js",
  "./js/confirm.js",
  "./js/supabaseClient.js",
  "./js/push-notifications.js",
  "./manifest.webmanifest",
  "./assets/gadlink-icon.svg"
];
const clientStates = new Map();

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
      url.pathname.includes("/rest/") || url.pathname.includes("/auth/") ||
      url.pathname.includes("/storage/") || url.pathname.includes("/functions/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () =>
      (await caches.match("./index.html")) || Response.error()));
    return;
  }
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
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

async function getVisibleAppState() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const stateRequests = windows.filter((client) => client.visibilityState === "visible")
    .map((client) => new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => resolve(null), 300);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timeout);
        clientStates.set(client.id, data);
        resolve(data);
      };
      client.postMessage({ type: "GADLINK_GET_STATE" }, [channel.port2]);
    }));
  const states = await Promise.all(stateRequests);
  return states.filter(Boolean);
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "GADLINK_STATE" && event.source?.id) {
    clientStates.set(event.source.id, event.data.state);
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data?.json();
    } catch (error) {
      console.error("GadLink push payload is invalid:", error);
      return;
    }
    if (!payload || !["message", "incoming_call", "missed_call"].includes(payload.type)) return;

    const states = await getVisibleAppState();
    if (payload.type === "message" && states.some((state) =>
      state?.visible && state.userId === payload.recipientId &&
      state.conversationId === payload.conversationId
    )) return;
    if (payload.type !== "message" && states.some((state) =>
      state?.visible && state.userId === payload.recipientId
    )) return;

    const options = {
      body: payload.body || "Откройте GadLink, чтобы посмотреть.",
      icon: new URL("./assets/gadlink-icon.svg", self.registration.scope).href,
      badge: new URL("./assets/gadlink-icon.svg", self.registration.scope).href,
      tag: payload.tag || `gadlink-${payload.type}-${payload.eventId || "event"}`,
      renotify: false,
      data: {
        type: payload.type,
        conversationId: payload.conversationId || null,
        callId: payload.callId || null,
        url: payload.url || "./"
      }
    };
    await self.registration.showNotification(payload.title || "GadLink", options);
  })());
});

self.addEventListener("notificationclick", (event) => {
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
