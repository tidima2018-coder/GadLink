const DATABASE_NAME = "gadlink-chat-preferences";
const DATABASE_VERSION = 1;
const STORE_NAME = "backgrounds";
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const GRADIENTS = {
  rose: "linear-gradient(145deg, #392631 0%, #211b29 52%, #171a24 100%)",
  violet: "linear-gradient(145deg, #302448 0%, #242039 52%, #171a27 100%)",
  ocean: "linear-gradient(145deg, #183543 0%, #1c2837 52%, #171c27 100%)",
  forest: "linear-gradient(145deg, #203b32 0%, #222f31 52%, #191d27 100%)"
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Не удалось открыть хранилище настроек."));
    request.onblocked = () => reject(new Error("Закройте другие вкладки GadLink и повторите попытку."));
  });
}

async function readBackground(userId) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(userId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Не удалось прочитать фон чата."));
    transaction.onabort = () => reject(transaction.error || new Error("Чтение фона чата прервано."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  });
}

async function writeBackground(record, userId) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (record) store.put(record);
    else store.delete(userId);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Не удалось сохранить фон чата."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("Сохранение фона чата прервано."));
    };
  });
}

export function createChatBackgroundSettings({ getUser }) {
  const chatView = document.getElementById("chat-view");
  const fileInput = document.getElementById("chat-background-file");
  const fileName = document.getElementById("chat-background-file-name");
  const imageApplyButton = document.querySelector('[data-chat-bg-apply="image"]');
  const status = document.getElementById("chat-background-status");
  const gradientButtons = [...document.querySelectorAll("[data-chat-bg-gradient]")];
  const applyButtons = [...document.querySelectorAll("[data-chat-bg-apply]")];
  const resetButton = document.querySelector(".chat-background-reset");
  let userId = null;
  let selectedGradient = "rose";
  let selectedFile = null;
  let objectUrl = null;
  let requestVersion = 0;

  function setStatus(message) {
    status.textContent = message;
  }

  function releaseObjectUrl() {
    if (!objectUrl) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function clearAppliedBackground() {
    releaseObjectUrl();
    chatView.style.removeProperty("background-image");
    chatView.style.removeProperty("background-size");
    chatView.style.removeProperty("background-position");
    chatView.style.removeProperty("background-repeat");
  }

  function applyRecord(record) {
    clearAppliedBackground();
    if (!record) return;

    if (record.type === "gradient" && GRADIENTS[record.value]) {
      selectedGradient = record.value;
      chatView.style.backgroundImage = GRADIENTS[record.value];
      chatView.style.backgroundSize = "cover";
      chatView.style.backgroundPosition = "center";
    } else if (record.type === "image" && record.blob instanceof Blob) {
      objectUrl = URL.createObjectURL(record.blob);
      chatView.style.backgroundImage =
        `linear-gradient(rgba(18, 16, 20, .58), rgba(18, 16, 20, .58)), url("${objectUrl}")`;
      chatView.style.backgroundSize = "cover";
      chatView.style.backgroundPosition = "center";
      chatView.style.backgroundRepeat = "no-repeat";
    }

    gradientButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(
        record.type === "gradient" && button.dataset.chatBgGradient === selectedGradient
      ));
    });
  }

  gradientButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedGradient = button.dataset.chatBgGradient;
      gradientButtons.forEach((option) => {
        option.setAttribute("aria-pressed", String(option === button));
      });
      setStatus("");
    });
  });

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files?.[0] || null;
    imageApplyButton.disabled = true;
    if (!selectedFile) {
      fileName.textContent = "Файл не выбран";
      setStatus("");
      return;
    }
    if (!selectedFile.type.startsWith("image/")) {
      selectedFile = null;
      fileInput.value = "";
      fileName.textContent = "Файл не выбран";
      setStatus("Выберите файл изображения.");
      return;
    }
    if (selectedFile.size > MAX_IMAGE_SIZE) {
      selectedFile = null;
      fileInput.value = "";
      fileName.textContent = "Файл не выбран";
      setStatus("Изображение должно быть меньше 8 МБ.");
      return;
    }
    fileName.textContent = selectedFile.name;
    imageApplyButton.disabled = false;
    setStatus("Изображение выбрано. Нажмите «Применить изображение».");
  });

  applyButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const owner = getUser();
      if (!owner?.id || owner.id !== userId) {
        setStatus("Войдите в аккаунт, чтобы изменить фон чата.");
        return;
      }

      const type = button.dataset.chatBgApply;
      const record = type === "gradient"
        ? { userId, type, value: selectedGradient }
        : selectedFile
          ? { userId, type, blob: selectedFile, name: selectedFile.name }
          : null;
      if (!record) {
        setStatus("Сначала выберите файл изображения.");
        return;
      }

      button.disabled = true;
      try {
        await writeBackground(record, userId);
        if (getUser()?.id !== userId) return;
        applyRecord(record);
        if (type === "image") {
          selectedFile = null;
          fileInput.value = "";
          imageApplyButton.disabled = true;
          fileName.textContent = `Сохранено: ${record.name}`;
        }
        setStatus("Фон чата применён и сохранён для этого аккаунта в этом браузере.");
      } catch (error) {
        console.error("GadLink chat background save:", error);
        setStatus(`Не удалось сохранить фон чата: ${error.message}`);
      } finally {
        button.disabled = type === "image" && !selectedFile;
      }
    });
  });

  resetButton.addEventListener("click", async () => {
    if (!userId || getUser()?.id !== userId) {
      setStatus("Войдите в аккаунт, чтобы изменить фон чата.");
      return;
    }
    resetButton.disabled = true;
    try {
      await writeBackground(null, userId);
      if (getUser()?.id !== userId) return;
      clearAppliedBackground();
      gradientButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.chatBgGradient === "rose"));
      });
      selectedGradient = "rose";
      selectedFile = null;
      fileInput.value = "";
      fileName.textContent = "Файл не выбран";
      imageApplyButton.disabled = true;
      setStatus("Возвращён стандартный фон.");
    } catch (error) {
      console.error("GadLink chat background reset:", error);
      setStatus(`Не удалось сбросить фон чата: ${error.message}`);
    } finally {
      resetButton.disabled = false;
    }
  });

  return {
    async setUser(nextUserId) {
      if (userId === nextUserId) return;
      userId = nextUserId;
      const version = ++requestVersion;
      selectedFile = null;
      fileInput.value = "";
      fileName.textContent = "Файл не выбран";
      imageApplyButton.disabled = true;
      clearAppliedBackground();
      gradientButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.chatBgGradient === "rose"));
      });
      selectedGradient = "rose";
      setStatus("");
      if (!nextUserId) return;

      try {
        const record = await readBackground(nextUserId);
        if (version !== requestVersion || userId !== nextUserId || getUser()?.id !== nextUserId) return;
        applyRecord(record);
        if (record?.type === "image") {
          fileName.textContent = `Сохранено: ${record.name || "изображение"}`;
        }
      } catch (error) {
        if (version !== requestVersion) return;
        console.error("GadLink chat background load:", error);
        setStatus(`Не удалось загрузить сохранённый фон: ${error.message}`);
      }
    }
  };
}
