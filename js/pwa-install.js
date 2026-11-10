const installButton = document.getElementById("pwa-install");
const installStatus = document.getElementById("pwa-install-status");
const installGuide = document.getElementById("pwa-install-guide");
let installPrompt = null;

function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent) ||
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

function showInstallGuide(message) {
  installGuide.textContent = message;
  installGuide.hidden = false;
  installStatus.textContent = "";
}

if (installButton && installStatus && installGuide) {
  installButton.hidden = isInstalled();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(
      new URL("../sw.js", import.meta.url),
      { scope: new URL("../", import.meta.url).pathname, updateViaCache: "none" }
    ).then((registration) => registration.update().catch((error) => {
      console.warn("GadLink could not check for a Service Worker update:", error);
    })).catch((error) => {
      console.error("GadLink could not register its Service Worker:", error);
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = isInstalled();
    installStatus.textContent = "";
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.hidden = true;
    installGuide.hidden = true;
    installStatus.textContent = "GadLink установлен на устройство.";
  });

  installButton.addEventListener("click", async () => {
    installGuide.hidden = true;
    if (!window.isSecureContext) {
      installStatus.textContent = "Установка доступна при открытии GadLink через HTTPS.";
      return;
    }

    if (isInstalled()) {
      installButton.hidden = true;
      return;
    }

    if (isIosDevice()) {
      const isSafari = /Safari/.test(window.navigator.userAgent) &&
        !/CriOS|FxiOS|EdgiOS|OPiOS/.test(window.navigator.userAgent);
      showInstallGuide(isSafari
        ? "В Safari нажмите «Поделиться», затем «На экран „Домой“» и подтвердите добавление GadLink."
        : "Откройте эту страницу в Safari, нажмите «Поделиться», затем «На экран „Домой“» и подтвердите добавление GadLink.");
      return;
    }

    if (!installPrompt) {
      showInstallGuide("Откройте меню браузера и выберите «Установить GadLink» или «Установить приложение». Если такого пункта нет, попробуйте Chrome или Edge и проверьте, что страница открыта через HTTPS.");
      return;
    }

    const prompt = installPrompt;
    installPrompt = null;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === "accepted") {
        installButton.hidden = true;
        installStatus.textContent = "GadLink устанавливается.";
      } else {
        installStatus.textContent = "Установка отменена. Её можно запустить позже.";
      }
    } catch (error) {
      console.error("GadLink PWA installation failed:", error);
      installStatus.textContent = "Не удалось начать установку. Попробуйте через меню браузера.";
    }
  });
}
