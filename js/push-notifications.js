function decodeVapidKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function createPushNotifications({ supabase, getUser }) {
  const toggleButton = document.getElementById("push-toggle");
  const previewOption = document.getElementById("push-preview-option");
  const previewInput = document.getElementById("push-show-preview");
  const statusBox = document.getElementById("push-status");
  const installButton = document.getElementById("pwa-install");
  const installStatus = document.getElementById("pwa-install-status");
  let registration = null;
  let endpoint = null;
  let initializedUserId = null;
  let activeConversationId = null;
  let lastPresenceState = "";
  let lastPresenceAt = 0;
  let presenceUpdatePending = false;
  let presenceTimer = null;
  let deferredInstallPrompt = null;

  function setStatus(message) {
    statusBox.textContent = message;
  }

  function postState(forceHidden = false) {
    const visible = !forceHidden && document.visibilityState === "visible";
    const state = {
      userId: getUser()?.id || null,
      conversationId: activeConversationId,
      visible
    };
    if (!registration?.active) return;
    registration.active.postMessage({
      type: "GADLINK_STATE",
      state
    });
    const owner = getUser();
    const signature = `${owner?.id || ""}:${state.conversationId || ""}:${visible}`;
    if (!owner?.id || !endpoint || presenceUpdatePending ||
        (signature === lastPresenceState && Date.now() - lastPresenceAt < 10_000)) return;
    presenceUpdatePending = true;
    void supabase.from("push_subscriptions").update({
      active_conversation_id: visible ? state.conversationId : null,
      is_visible: visible,
      last_seen_at: new Date().toISOString()
    }).eq("endpoint", endpoint).eq("user_id", owner.id)
      .then(({ error }) => {
        if (error) console.error("GadLink push presence:", error);
        else {
          lastPresenceState = signature;
          lastPresenceAt = Date.now();
        }
      })
      .catch((error) => console.error("GadLink push presence request:", error))
      .finally(() => { presenceUpdatePending = false; });
  }

  async function getCurrentSubscription() {
    if (!registration || !("PushManager" in window)) return null;
    return registration.pushManager.getSubscription();
  }

  function updateControls(enabled) {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    toggleButton.disabled = !supported || !getUser()?.id;
    toggleButton.textContent = enabled ? "Отключить на этом устройстве" : "Включить уведомления";
    previewOption.hidden = !enabled;
    if (!supported) {
      setStatus("Push-уведомления не поддерживаются этим браузером.");
    }
  }

  async function loadSubscription() {
    const owner = getUser();
    if (!owner?.id || !registration) return;
    const subscription = await getCurrentSubscription();
    const currentEndpoint = subscription?.endpoint || null;
    if (!currentEndpoint) {
      endpoint = null;
      previewInput.checked = false;
      updateControls(false);
      return;
    }
    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("show_preview")
      .eq("endpoint", currentEndpoint)
      .eq("user_id", owner.id)
      .maybeSingle();
    if (error) throw error;
    endpoint = data ? currentEndpoint : null;
    previewInput.checked = Boolean(data?.show_preview);
    updateControls(Boolean(data));
    postState();
  }

  async function getVapidPublicKey() {
    const { data, error } = await supabase.functions.invoke("push-config", { method: "GET" });
    if (error) throw new Error(`Не удалось получить ключ Push: ${error.message}`);
    if (typeof data?.vapidPublicKey !== "string" || data.vapidPublicKey.length < 40) {
      throw new Error("Сервер не настроен: отсутствует VAPID public key.");
    }
    return data.vapidPublicKey;
  }

  async function enable() {
    if (!getUser()?.id) throw new Error("Войдите в аккаунт, чтобы включить уведомления.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      throw new Error("Push API недоступен в этом браузере.");
    }
    if (!window.isSecureContext) {
      throw new Error("Для Push-уведомлений требуется HTTPS.");
    }

    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") {
      throw new Error(permission === "denied"
        ? "Уведомления запрещены в настройках браузера."
        : "Разрешение на уведомления не получено.");
    }

    registration ||= await navigator.serviceWorker.register(
      new URL("../sw.js", import.meta.url),
      { scope: new URL("../", import.meta.url).pathname, updateViaCache: "none" }
    );
    await navigator.serviceWorker.ready;
    const vapidPublicKey = await getVapidPublicKey();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey)
      });
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("Браузер вернул неполную Push-подписку.");
    }
    const owner = getUser();
    const { error } = await supabase.from("push_subscriptions").upsert({
      user_id: owner.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      show_preview: previewInput.checked
    }, { onConflict: "endpoint" });
    if (error) {
      await subscription.unsubscribe();
      throw new Error(`Не удалось сохранить Push-подписку: ${error.message}`);
    }
    endpoint = json.endpoint;
    updateControls(true);
    lastPresenceState = "";
    postState();
    setStatus("Уведомления включены на этом устройстве.");
  }

  async function disable() {
    const owner = getUser();
    const subscription = await getCurrentSubscription();
    const currentEndpoint = subscription?.endpoint || endpoint;
    let deleteError = null;
    if (currentEndpoint && owner?.id) {
      const { error } = await supabase.from("push_subscriptions")
        .delete()
        .eq("endpoint", currentEndpoint)
        .eq("user_id", owner.id);
      deleteError = error;
    }
    let unsubscribeError = null;
    if (subscription) {
      try {
        const unsubscribed = await subscription.unsubscribe();
        if (!unsubscribed) unsubscribeError = new Error("Браузер не смог отключить Push-подписку.");
      } catch (error) {
        unsubscribeError = error;
      }
    }
    endpoint = null;
    previewInput.checked = false;
    updateControls(false);
    if (deleteError || unsubscribeError) {
      throw new Error(`Не удалось полностью отключить уведомления: ${deleteError?.message || unsubscribeError?.message}`);
    }
    setStatus("Уведомления отключены на этом устройстве.");
  }

  async function savePreviewPreference() {
    const owner = getUser();
    if (!owner?.id || !endpoint) return;
    const { error } = await supabase.from("push_subscriptions")
      .update({ show_preview: previewInput.checked })
      .eq("endpoint", endpoint)
      .eq("user_id", owner.id);
    if (error) {
      previewInput.checked = !previewInput.checked;
      throw error;
    }
    setStatus(previewInput.checked
      ? "Предпросмотр сообщений включён на этом устройстве."
      : "В уведомлениях показывается только общий текст.");
  }

  async function initialize() {
    const owner = getUser();
    if (!owner?.id) return;
    if (!("serviceWorker" in navigator)) {
      updateControls(false);
      return;
    }
    if (initializedUserId !== owner.id) {
      initializedUserId = owner.id;
      endpoint = null;
      registration = await navigator.serviceWorker.register(
        new URL("../sw.js", import.meta.url),
        { scope: new URL("../", import.meta.url).pathname, updateViaCache: "none" }
      );
      await navigator.serviceWorker.ready;
      await registration.update();
      clearInterval(presenceTimer);
      presenceTimer = setInterval(() => {
        if (document.visibilityState === "visible") postState();
      }, 10_000);
      if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) {
        installStatus.textContent = "GadLink установлен на этом устройстве.";
      } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
        installStatus.textContent = "Чтобы установить приложение: Поделиться → На экран «Домой». Push поддерживается в iOS 16.4 и новее.";
      }
    }
    if (!("PushManager" in window) || !("Notification" in window)) {
      updateControls(false);
      return;
    }
    await loadSubscription();
  }

  async function shutdown() {
    postState(true);
    try {
      if (registration) {
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription) {
          const unsubscribed = await subscription.unsubscribe();
          if (!unsubscribed) console.warn("GadLink could not unsubscribe the current push device during sign-out.");
        }
      }
    } catch (error) {
      console.error("GadLink push sign-out unsubscribe:", error);
    } finally {
      initializedUserId = null;
      clearInterval(presenceTimer);
      presenceTimer = null;
      endpoint = null;
      activeConversationId = null;
      registration = null;
      lastPresenceState = "";
      lastPresenceAt = 0;
      updateControls(false);
    }
  }

  function setActiveConversation(conversationId) {
    activeConversationId = conversationId || null;
    postState();
  }

  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    try {
      if (endpoint) await disable();
      else {
        setStatus("Запрашиваем разрешение и подключаем уведомления…");
        await enable();
      }
    } catch (error) {
      console.error("GadLink push settings:", error);
      setStatus(error.message);
    } finally {
      updateControls(Boolean(endpoint));
    }
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    installButton.disabled = true;
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      installStatus.textContent = choice.outcome === "accepted"
        ? "GadLink добавляется на главный экран."
        : "Установку можно выполнить позже из меню браузера.";
    } catch (error) {
      console.error("GadLink PWA install:", error);
      installStatus.textContent = `Не удалось начать установку: ${error.message}`;
    } finally {
      deferredInstallPrompt = null;
      installButton.hidden = true;
      installButton.disabled = false;
    }
  });
  window.addEventListener("appinstalled", () => {
    installButton.hidden = true;
    installStatus.textContent = "GadLink установлен на этом устройстве.";
  });
  previewInput.addEventListener("change", () => {
    void savePreviewPreference().catch((error) => {
      console.error("GadLink push preview setting:", error);
      setStatus(`Не удалось сохранить настройку: ${error.message}`);
    });
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "GADLINK_GET_STATE") {
      event.ports[0]?.postMessage({
        userId: getUser()?.id || null,
        conversationId: activeConversationId,
        visible: document.visibilityState === "visible"
      });
    }
  });
  document.addEventListener("visibilitychange", () => postState());
  window.addEventListener("pagehide", () => postState(true));

  return { initialize, shutdown, setActiveConversation };
}
