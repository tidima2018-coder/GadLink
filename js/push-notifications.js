function decodeVapidKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function subscriptionUsesVapidKey(subscription, publicKey) {
  const subscribedKey = subscription.options?.applicationServerKey;
  if (!subscribedKey) return false;
  const subscribedBytes = new Uint8Array(subscribedKey);
  const currentBytes = decodeVapidKey(publicKey);
  return subscribedBytes.length === currentBytes.length &&
    subscribedBytes.every((value, index) => value === currentBytes[index]);
}

export function createPushNotifications({ supabase, getUser }) {
  const toggleButton = document.getElementById("push-toggle");
  const previewOption = document.getElementById("push-preview-option");
  const previewInput = document.getElementById("push-show-preview");
  const statusBox = document.getElementById("push-status");
  const deliveryStatusBox = document.getElementById("push-delivery-status");
  const installButton = document.getElementById("pwa-install");
  const installStatus = document.getElementById("pwa-install-status");
  let registration = null;
  let endpoint = null;
  let subscriptionNeedsRefresh = false;
  let initializedUserId = null;
  let activeConversationId = null;
  let lastPresenceState = "";
  let lastPresenceAt = 0;
  let presenceUpdatePending = false;
  let presenceTimer = null;
  let deferredInstallPrompt = null;
  let deliveryStatusTimer = null;

  function setStatus(message) {
    statusBox.textContent = message;
  }

  function needsPrompt() {
    const owner = getUser();
    if (!owner?.id || !("serviceWorker" in navigator) || !("PushManager" in window) ||
        !("Notification" in window) || !window.isSecureContext || endpoint ||
        Notification.permission === "denied") return false;
    return localStorage.getItem(`gadlink-push-prompt-dismissed:${owner.id}`) !== "true";
  }

  function dismissPrompt() {
    const owner = getUser();
    if (owner?.id) localStorage.setItem(`gadlink-push-prompt-dismissed:${owner.id}`, "true");
  }

  function postState(forceHidden = false) {
    const visible = !forceHidden && document.visibilityState === "visible";
    const state = {
      userId: getUser()?.id || null,
      conversationId: activeConversationId,
      visible
    };
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
    toggleButton.textContent = enabled
      ? subscriptionNeedsRefresh ? "Обновить Push-подписку" : "Отключить на этом устройстве"
      : "Включить уведомления";
    previewOption.hidden = !enabled;
    if (!supported) {
      const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
      setStatus(isAppleMobile
        ? "На iPhone/iPad Push доступны в iOS/iPadOS 16.4+ после добавления GadLink на экран «Домой»."
        : "Push-уведомления не поддерживаются этим браузером. Попробуйте актуальную версию Chrome, Edge, Firefox или Safari.");
    } else if (!window.isSecureContext) {
      toggleButton.disabled = true;
      setStatus("Для Push-уведомлений откройте GadLink через HTTPS или localhost.");
    } else if (Notification.permission === "denied") {
      setStatus("Уведомления заблокированы. Разрешите их для GadLink в настройках браузера и попробуйте снова.");
    }
  }

  async function loadSubscription() {
    const owner = getUser();
    if (!owner?.id || !registration) return;
    const subscription = await getCurrentSubscription();
    const currentEndpoint = subscription?.endpoint || null;
    if (!currentEndpoint) {
      endpoint = null;
      subscriptionNeedsRefresh = false;
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
    subscriptionNeedsRefresh = false;
    previewInput.checked = Boolean(data?.show_preview);
    if (data && Notification.permission === "granted") {
      try {
        subscriptionNeedsRefresh = !subscriptionUsesVapidKey(
          subscription,
          await getVapidPublicKey()
        );
      } catch (keyError) {
        subscriptionNeedsRefresh = true;
        setStatus(`Не удалось проверить актуальность VAPID-ключа Push: ${keyError.message}`);
      }
    }
    updateControls(Boolean(data));
    if (data && subscriptionNeedsRefresh) {
      setStatus("Push-подписка использует устаревший или непроверенный VAPID-ключ. Нажмите «Обновить Push-подписку».");
    } else if (data && Notification.permission === "granted") {
      setStatus("Push включены в этом браузере для текущего аккаунта. Подписку можно отключить кнопкой.");
    } else if (data) {
      setStatus(Notification.permission === "denied"
        ? "Уведомления заблокированы. Разрешите их для GadLink в настройках браузера."
        : "Подписка найдена, но разрешение ещё не выдано. Разрешите уведомления в браузере.");
    }
    postState();
  }

  async function getVapidPublicKey() {
    const { data, error } = await supabase.functions.invoke("push-config", { method: "GET" });
    if (error) throw new Error(`Не удалось получить ключ Push: ${error.message}`);
    if (typeof data?.vapidPublicKey !== "string") {
      throw new Error("Сервер не настроен: отсутствует VAPID public key.");
    }
    let decodedKey;
    try {
      decodedKey = decodeVapidKey(data.vapidPublicKey);
    } catch {
      throw new Error("Сервер вернул некорректный VAPID public key.");
    }
    if (decodedKey.length !== 65 || decodedKey[0] !== 4) {
      throw new Error("Сервер вернул некорректный VAPID public key.");
    }
    return data.vapidPublicKey;
  }

  async function enable() {
    const owner = getUser();
    if (!owner?.id) throw new Error("Войдите в аккаунт, чтобы включить уведомления.");
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
        : "Разрешение на уведомления не получено. Нажмите «Включить уведомления» и выберите «Разрешить».");
    }
    if (getUser()?.id !== owner.id) {
      throw new Error("Аккаунт изменился. Войдите снова и включите уведомления.");
    }

    await navigator.serviceWorker.register(
      new URL("../sw.js", import.meta.url),
      { scope: new URL("../", import.meta.url).pathname, updateViaCache: "none" }
    );
    registration = await navigator.serviceWorker.ready;
    if (!registration.active) {
      throw new Error("Service Worker ещё не активен. Обновите страницу и попробуйте снова.");
    }
    const vapidPublicKey = await getVapidPublicKey();
    if (getUser()?.id !== owner.id) {
      throw new Error("Аккаунт изменился. Войдите снова и включите уведомления.");
    }
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionUsesVapidKey(subscription, vapidPublicKey)) {
      const { error: deleteError } = await supabase.from("push_subscriptions")
        .delete()
        .eq("endpoint", subscription.endpoint)
        .eq("user_id", owner.id);
      if (deleteError) {
        throw new Error(`Не удалось обновить старую Push-подписку: ${deleteError.message}`);
      }
      const unsubscribed = await subscription.unsubscribe();
      if (!unsubscribed) {
        throw new Error("Не удалось отключить старую Push-подписку. Отключите её в настройках браузера и попробуйте снова.");
      }
      subscription = null;
      endpoint = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey)
      });
    }
    if (getUser()?.id !== owner.id) {
      await subscription.unsubscribe();
      throw new Error("Аккаунт изменился. Войдите снова и включите уведомления.");
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("Браузер вернул неполную Push-подписку.");
    }
    const { error } = await supabase.from("push_subscriptions").upsert({
      user_id: owner.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      show_preview: previewInput.checked
    }, { onConflict: "endpoint" });
    if (error) {
      await subscription.unsubscribe();
      if (error.code === "23505" || error.message?.toLowerCase().includes("duplicate key")) {
        throw new Error("Эта подписка ещё привязана к другому аккаунту. Подписку браузера отключили; нажмите «Включить уведомления» ещё раз.");
      }
      throw new Error(`Не удалось сохранить Push-подписку: ${error.message}`);
    }
    endpoint = json.endpoint;
    subscriptionNeedsRefresh = false;
    updateControls(true);
    lastPresenceState = "";
    postState();
    setStatus("Push включены в этом браузере для текущего аккаунта.");
    window.dispatchEvent(new Event("gadlink:push-enabled"));
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
    subscriptionNeedsRefresh = false;
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
      endpoint = null;
      subscriptionNeedsRefresh = false;
      await navigator.serviceWorker.register(
        new URL("../sw.js", import.meta.url),
        { scope: new URL("../", import.meta.url).pathname, updateViaCache: "none" }
      );
      registration = await navigator.serviceWorker.ready;
      if (!registration.active) {
        throw new Error("Service Worker не активировался. Обновите страницу и попробуйте снова.");
      }
      initializedUserId = owner.id;
      try {
        await registration.update();
      } catch (error) {
        console.warn("GadLink could not check for a Service Worker update:", error);
        setStatus(`Не удалось проверить обновление Service Worker: ${error.message}`);
      }
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
    if (!endpoint && Notification.permission !== "denied") {
      setStatus("Push пока не включены на этом устройстве. Нажмите кнопку и разрешите уведомления в запросе браузера.");
    }
  }

  async function shutdown() {
    postState(true);
    let cleanupError = null;
    try {
      const owner = getUser();
      const subscription = await getCurrentSubscription();
      const currentEndpoint = subscription?.endpoint || endpoint;
      if (currentEndpoint && owner?.id) {
        const { error } = await supabase.from("push_subscriptions")
          .delete()
          .eq("endpoint", currentEndpoint)
          .eq("user_id", owner.id);
        if (error) cleanupError = error;
      }
      if (subscription) {
        const unsubscribed = await subscription.unsubscribe();
        if (!unsubscribed) {
          cleanupError ||= new Error("Браузер не смог отключить Push-подписку.");
        }
      }
    } catch (error) {
      cleanupError ||= error;
    } finally {
      initializedUserId = null;
      clearInterval(presenceTimer);
      presenceTimer = null;
      endpoint = null;
      subscriptionNeedsRefresh = false;
      activeConversationId = null;
      registration = null;
      lastPresenceState = "";
      lastPresenceAt = 0;
      updateControls(false);
    }
    if (cleanupError) throw new Error(`Не удалось полностью отключить Push-подписку: ${cleanupError.message}`);
  }

  function setActiveConversation(conversationId) {
    activeConversationId = conversationId || null;
    postState();
  }

  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    try {
      if (endpoint && !subscriptionNeedsRefresh) await disable();
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
    if (event.data?.type === "GADLINK_PUSH_ERROR") {
      const message = `Браузер не показал Push-уведомление: ${event.data.message || "неизвестная ошибка"}`;
      setStatus(message);
      deliveryStatusBox.textContent = message;
      deliveryStatusBox.hidden = false;
      clearTimeout(deliveryStatusTimer);
      deliveryStatusTimer = setTimeout(() => {
        deliveryStatusBox.hidden = true;
        deliveryStatusTimer = null;
      }, 10_000);
    }
  });
  document.addEventListener("visibilitychange", () => postState());
  window.addEventListener("pagehide", () => postState(true));

  return { initialize, shutdown, setActiveConversation, needsPrompt, dismissPrompt };
}
