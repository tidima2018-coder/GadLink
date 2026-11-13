const RING_TIMEOUT_MS = 45_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_GRACE_MS = 12_000;
const ICE_SERVER_CACHE_MS = 50 * 60_000;
const ICE_CONFIG_WAIT_MS = 3_500;
const ICE_CONFIG_RETRY_MS = 60_000;
const ICE_CONFIG_FETCH_TIMEOUT_MS = 8_000;

const callStatusLabels = {
  ringing: "В процессе",
  accepted: "В разговоре",
  rejected: "Отклонён",
  missed: "Пропущен",
  cancelled: "Отменён",
  ended: "Завершён",
  failed: "Не удалось соединиться"
};

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remaining = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function formatCallDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

const RINGTONE_DATABASE = "gadlink-call-ringtones";
const RINGTONE_STORE = "ringtones";
const DEFAULT_RINGTONE_ID = "gadlink-default";
const MAX_RINGTONE_SIZE = 10 * 1024 * 1024;

let ringtoneDatabasePromise = null;
function openRingtoneDatabase() {
  if (ringtoneDatabasePromise) return ringtoneDatabasePromise;
  ringtoneDatabasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("IndexedDB недоступна в этом браузере."));
      return;
    }
    const request = indexedDB.open(RINGTONE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RINGTONE_STORE)) {
        database.createObjectStore(RINGTONE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("Не удалось открыть локальное хранилище мелодий."));
    request.onblocked = () => reject(new Error("Закройте другие вкладки GadLink и повторите попытку."));
  }).catch((error) => {
    ringtoneDatabasePromise = null;
    throw error;
  });
  return ringtoneDatabasePromise;
}

function ringtoneDatabaseRequest(mode, operation) {
  return openRingtoneDatabase().then((database) => new Promise((resolve, reject) => {
    let request;
    let transaction;
    try {
      transaction = database.transaction(RINGTONE_STORE, mode);
      request = operation(transaction.objectStore(RINGTONE_STORE));
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Ошибка локального хранилища мелодий."));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("Ошибка локального хранилища мелодий."));
    transaction.onabort = () => reject(transaction.error || new Error("Не удалось сохранить мелодию."));
  }));
}

const ringtoneMimeCandidates = {
  mp3: ["audio/mpeg"],
  wav: ["audio/wav", "audio/x-wav"],
  ogg: ["audio/ogg; codecs=vorbis", "audio/ogg"],
  m4a: ["audio/mp4", "audio/x-m4a"]
};

export function createVoiceCallController({ supabase, getUser, getPublicProfileNames }) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("voice-call-dialog");
  const remoteAudio = byId("voice-call-remote-audio");
  const ringtoneFileInput = byId("call-ringtone-file");
  const ringtoneList = byId("call-ringtone-list");
  const ringtoneStatus = byId("call-ringtone-status");
  let inboxChannel = null;
  let activeCall = null;
  let startingCall = false;
  const incomingCallRequests = new Set();
  let initialisedUserId = null;
  let historyRequest = 0;
  let historyClearing = false;
  let currentHistoryCalls = [];
  let historyFilter = "all";
  const callStatusById = new Map();
  let inboxChannelOwnerId = null;
  let inboxChannelReady = false;
  let inboxSubscriptionPromise = null;
  let iceServerCache = null;
  let iceServerCacheOwnerId = null;
  let iceServerCacheUntil = 0;
  let iceServerRequest = null;
  let iceServerRequestOwnerId = null;
  let soundContext = null;
  let ringtoneTimer = null;
  let ringtoneKind = null;
  let mutedRingtoneKind = null;
  let ringtoneGeneration = 0;
  let previewingRingtone = false;
  let ringtoneAudio = null;
  let ringtoneAudioUrl = null;
  let ringtoneAudioFadeFrame = 0;
  let previewRingtoneId = null;
  let customRingtones = [];
  let activeRingtoneId = "gadlink-default";
  let ringtoneLibraryReady = false;
  const activeTones = new Set();
  const readSoundSetting = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const writeSoundSetting = (key, value) => {
    try { localStorage.setItem(key, String(value)); } catch (error) {
      console.warn("GadLink call sound setting could not be saved:", error);
    }
  };
  const storedVolume = readSoundSetting("gadlink-call-sound-volume");
  let soundEnabled = readSoundSetting("gadlink-call-sounds") !== "false";
  activeRingtoneId = readSoundSetting("gadlink-call-active-tone") || DEFAULT_RINGTONE_ID;
  let soundVolume = storedVolume === null ? 0.45 : Number(storedVolume);
  if (!Number.isFinite(soundVolume)) soundVolume = 0.45;
  soundVolume = Math.min(1, Math.max(0, soundVolume));
  let callOutputMuted = false;

  function setRingtoneStatus(message, isError = false) {
    if (!ringtoneStatus) return;
    ringtoneStatus.textContent = message;
    ringtoneStatus.dataset.state = isError ? "error" : "ok";
  }

  function renderRingtoneList() {
    if (!ringtoneList) return;
    ringtoneList.replaceChildren();
    const entries = [{ id: DEFAULT_RINGTONE_ID, name: "Стандартная мелодия GadLink", type: "audio/webm" }, ...customRingtones];
    for (const entry of entries) {
      const row = document.createElement("article");
      row.className = `call-ringtone-option${activeRingtoneId === entry.id ? " is-selected" : ""}${previewRingtoneId === entry.id ? " is-playing" : ""}`;
      const title = document.createElement("strong");
      title.className = "call-ringtone-option__name";
      title.textContent = entry.name;
      const icon = document.createElement("span");
      icon.className = "call-ringtone-option__icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "♫";
      const info = document.createElement("div");
      info.className = "call-ringtone-option__info";
      info.append(icon, title);
      const state = document.createElement("span");
      state.className = "call-ringtone-option__state";
      state.textContent = activeRingtoneId === entry.id ? "Установлена" : "";
      info.append(state);
      const actions = document.createElement("div");
      actions.className = "call-ringtone-option__actions";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.dataset.ringtoneAction = "preview";
      preview.dataset.ringtoneId = entry.id;
      preview.textContent = previewRingtoneId === entry.id ? "Остановить" : "Прослушать";
      preview.disabled = Boolean(activeCall || startingCall) && previewRingtoneId !== entry.id;
      const install = document.createElement("button");
      install.type = "button";
      install.dataset.ringtoneAction = "install";
      install.dataset.ringtoneId = entry.id;
      install.textContent = activeRingtoneId === entry.id ? "Выбрана" : "Установить";
      install.disabled = activeRingtoneId === entry.id;
      actions.append(preview, install);
      if (entry.id !== DEFAULT_RINGTONE_ID) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.ringtoneAction = "delete";
        remove.dataset.ringtoneId = entry.id;
        remove.textContent = "Удалить";
        actions.append(remove);
      }
      row.append(info, actions);
      if (previewRingtoneId === entry.id) {
        const waves = document.createElement("span");
        waves.className = "call-ringtone-waves";
        waves.setAttribute("aria-label", "Мелодия воспроизводится");
        waves.innerHTML = "<i></i><i></i><i></i><i></i>";
        info.append(waves);
      }
      ringtoneList.append(row);
    }
  }

  async function loadRingtoneLibrary() {
    if (ringtoneLibraryReady) return;
    try {
      customRingtones = (await ringtoneDatabaseRequest("readonly", (store) => store.getAll())) || [];
      customRingtones.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      ringtoneLibraryReady = true;
      if (!customRingtones.some((item) => item.id === activeRingtoneId)) {
        activeRingtoneId = DEFAULT_RINGTONE_ID;
        writeSoundSetting("gadlink-call-active-tone", activeRingtoneId);
      }
      renderRingtoneList();
      setRingtoneStatus(customRingtones.length ? "Мелодии хранятся только в этом браузере на этом устройстве." : "Добавьте аудиофайл до 10 МБ. Он останется на этом устройстве.");
    } catch (error) {
      setRingtoneStatus(error.message || "Не удалось открыть локальное хранилище мелодий.", true);
    }
  }

  function selectRingtone(id) {
    if (id !== DEFAULT_RINGTONE_ID && !customRingtones.some((item) => item.id === id)) return;
    if (previewingRingtone) stopRingtone();
    activeRingtoneId = id;
    writeSoundSetting("gadlink-call-active-tone", id);
    renderRingtoneList();
    setRingtoneStatus("Мелодия будет использоваться для входящих звонков.");
  }

  async function deleteCustomRingtone(id) {
    const entry = customRingtones.find((item) => item.id === id);
    if (!entry) return;
    const wasActiveIncoming = activeRingtoneId === id && ringtoneKind === "incoming" && !previewingRingtone;
    try {
      if (previewRingtoneId === id || wasActiveIncoming) stopRingtone();
      await ringtoneDatabaseRequest("readwrite", (store) => store.delete(id));
      customRingtones = customRingtones.filter((item) => item.id !== id);
      if (activeRingtoneId === id) selectRingtone(DEFAULT_RINGTONE_ID);
      else renderRingtoneList();
      if (wasActiveIncoming && activeCall) void startRingtone("incoming");
      setRingtoneStatus("Мелодия удалена с этого устройства.");
    } catch (error) {
      setRingtoneStatus(error.message || "Не удалось удалить мелодию.", true);
    }
  }

  function getSupportedRingtoneType(file) {
    const extension = file.name.split(".").pop().toLowerCase();
    const candidates = ringtoneMimeCandidates[extension];
    if (!candidates) return null;
    const audio = document.createElement("audio");
    const browserSupports = candidates.some((type) => audio.canPlayType(type) !== "");
    const declaredType = !file.type || candidates.some((candidate) => candidate.split(";")[0] === file.type.split(";")[0]);
    return browserSupports && declaredType ? (file.type || candidates[0]) : null;
  }

  async function saveCustomRingtone(file) {
    if (!file) return;
    if (file.size > MAX_RINGTONE_SIZE) {
      setRingtoneStatus("Размер файла превышает 10 МБ.", true);
      return;
    }
    const type = getSupportedRingtoneType(file);
    if (!type) {
      setRingtoneStatus("Этот формат не поддерживается браузером. Выберите MP3, WAV, OGG или M4A.", true);
      return;
    }
    const id = globalThis.crypto?.randomUUID?.() || `ringtone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const record = { id, name: file.name, type, size: file.size, blob: file, createdAt: Date.now() };
    try {
      await ringtoneDatabaseRequest("readwrite", (store) => store.put(record));
      customRingtones.push(record);
      renderRingtoneList();
      setRingtoneStatus(`Мелодия «${file.name}» сохранена на этом устройстве.`);
    } catch (error) {
      setRingtoneStatus(error.message || "Не удалось сохранить аудиофайл. Проверьте свободное место браузера.", true);
    } finally {
      if (ringtoneFileInput) ringtoneFileInput.value = "";
    }
  }

  function fadeInCustomRingtone(audio, generation) {
    if (ringtoneAudioFadeFrame) cancelAnimationFrame(ringtoneAudioFadeFrame);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const startedAt = performance.now();
    const duration = reducedMotion ? 0 : 280;
    const tick = (now) => {
      if (generation !== ringtoneGeneration || ringtoneAudio !== audio) return;
      const progress = duration ? Math.min(1, (now - startedAt) / duration) : 1;
      audio.volume = soundVolume * progress;
      if (progress < 1) ringtoneAudioFadeFrame = requestAnimationFrame(tick);
      else ringtoneAudioFadeFrame = 0;
    };
    ringtoneAudioFadeFrame = requestAnimationFrame(tick);
  }

  async function resumeCustomPreview() {
    if (!ringtoneAudio) return false;
    try {
      await ringtoneAudio.play();
      fadeInCustomRingtone(ringtoneAudio, ringtoneGeneration);
      byId("voice-call-sound-notice").hidden = true;
      return true;
    } catch (error) {
      setRingtoneStatus("Браузер пока блокирует звук. Проверьте разрешение на воспроизведение для сайта.", true);
      console.warn("GadLink could not resume ringtone preview:", error);
      return false;
    }
  }

  async function playCustomRingtone(id, { preview = false, generation = ringtoneGeneration } = {}) {
    let entry = customRingtones.find((item) => item.id === id);
    if (!entry) {
      try { entry = await ringtoneDatabaseRequest("readonly", (store) => store.get(id)); } catch { /* handled below */ }
    }
    if (generation !== ringtoneGeneration) return;
    if (!entry?.blob) {
      if (!preview && id !== DEFAULT_RINGTONE_ID) {
        selectRingtone(DEFAULT_RINGTONE_ID);
        return startRingtone("incoming");
      }
      setRingtoneStatus("Файл мелодии не найден. Выберите стандартную мелодию или добавьте файл снова.", true);
      stopRingtone();
      return;
    }
    const url = URL.createObjectURL(entry.blob);
    const audio = new Audio(url);
    ringtoneAudio = audio;
    ringtoneAudioUrl = url;
    audio.loop = !preview;
    audio.preload = "auto";
    audio.volume = 0;
    audio.addEventListener("ended", () => { if (preview && generation === ringtoneGeneration) stopRingtone(); }, { once: true });
    audio.addEventListener("error", () => {
      if (generation === ringtoneGeneration) {
        setRingtoneStatus("Браузер не смог воспроизвести этот аудиофайл.", true);
        stopRingtone();
      }
    }, { once: true });
    try {
      await audio.play();
      if (generation !== ringtoneGeneration) {
        releaseRingtoneAudio(audio, url);
        return;
      }
      fadeInCustomRingtone(audio, generation);
      byId("voice-call-sound-notice").hidden = true;
      if (preview) previewRingtoneId = id;
      if (!preview && navigator.vibrate) navigator.vibrate([180, 120, 180, 850]);
      renderRingtoneList();
    } catch (error) {
      if (generation !== ringtoneGeneration) {
        releaseRingtoneAudio(audio, url);
        return;
      }
      byId("voice-call-sound-notice").hidden = !activeCall;
      if (preview) setRingtoneStatus("Браузер заблокировал звук. Нажмите «Прослушать» ещё раз после взаимодействия со страницей.", true);
      else console.info("GadLink incoming ringtone awaits a user gesture:", error);
    }
  }

  function releaseRingtoneAudio(audio, url) {
    try { audio.pause(); } catch { /* already stopped */ }
    try { audio.currentTime = 0; } catch { /* media is not seekable */ }
    try { audio.removeAttribute("src"); audio.load(); } catch { /* already released */ }
    if (ringtoneAudio === audio) ringtoneAudio = null;
    if (ringtoneAudioUrl === url) ringtoneAudioUrl = null;
    URL.revokeObjectURL(url);
  }

  function setStatus(message) {
    byId("calls-status").textContent = message;
  }

  function setCallStatus(message) {
    byId("voice-call-status").textContent = message;
    byId("voice-call-waves").classList.toggle("is-active", message === "В разговоре");
  }

  async function unlockSound() {
    if (!soundContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;
      try { soundContext = new AudioContextClass(); }
      catch (error) {
        console.warn("GadLink Web Audio is unavailable:", error);
        return false;
      }
    }
    try {
      if (soundContext.state !== "running") await soundContext.resume();
      const unlocked = soundContext.state === "running";
      byId("voice-call-sound-notice").hidden = unlocked || !activeCall || !ringtoneKind;
      return unlocked;
    } catch (error) {
      console.warn("GadLink could not unlock call audio:", error);
      byId("voice-call-sound-notice").hidden = false;
      return false;
    }
  }

  function stopRingtone() {
    ringtoneGeneration += 1;
    clearInterval(ringtoneTimer);
    ringtoneTimer = null;
    ringtoneKind = null;
    previewingRingtone = false;
    previewRingtoneId = null;
    if (ringtoneAudioFadeFrame) cancelAnimationFrame(ringtoneAudioFadeFrame);
    ringtoneAudioFadeFrame = 0;
    const audio = ringtoneAudio;
    const audioUrl = ringtoneAudioUrl;
    ringtoneAudio = null;
    ringtoneAudioUrl = null;
    if (audio && audioUrl) releaseRingtoneAudio(audio, audioUrl);
    for (const { oscillator, envelope } of activeTones) {
      try {
        const now = soundContext?.currentTime || 0;
        envelope.gain.cancelScheduledValues(now);
        envelope.gain.setTargetAtTime(0.0001, now, 0.025);
        oscillator.stop(now + 0.12);
      } catch { /* already stopped */ }
    }
    if (navigator.vibrate) navigator.vibrate(0);
    byId("voice-call-sound-notice").hidden = true;
    renderRingtoneList();
  }

  function tone(frequency, start, duration, type = "sine", gain = 0.14) {
    if (!soundEnabled || !soundContext || soundContext.state !== "running") return;
    const oscillator = soundContext.createOscillator();
    const envelope = soundContext.createGain();
    activeTones.add({ oscillator, envelope });
    oscillator.addEventListener("ended", () => {
      for (const entry of activeTones) if (entry.oscillator === oscillator) activeTones.delete(entry);
      try { oscillator.disconnect(); envelope.disconnect(); } catch { /* already disconnected */ }
    }, { once: true });
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * soundVolume), start + 0.035);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope).connect(soundContext.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  async function playPattern(kind, generation = ringtoneGeneration) {
    if (!soundEnabled) return;
    if (!await unlockSound() || generation !== ringtoneGeneration) {
      if (ringtoneKind && ringtoneGeneration === generation) byId("voice-call-sound-notice").hidden = false;
      return;
    }
    if (!soundContext || soundContext.state !== "running") return;
    const now = soundContext.currentTime + 0.04;
    const note = (frequency, offset, duration, gain) => tone(frequency, now + offset, duration, "sine", gain);
    if (kind === "incoming") {
      note(659.25, 0, 0.23, 0.12); note(783.99, 0.28, 0.34, 0.12);
      note(987.77, 0.72, 0.24, 0.1); note(783.99, 1.02, 0.44, 0.1);
    } else {
      note(440, 0, 0.75, 0.09); note(480, 0, 0.75, 0.04);
      note(440, 1.05, 0.75, 0.09); note(480, 1.05, 0.75, 0.04);
    }
  }

  async function startRingtone(kind, { preview = false, customId = null } = {}) {
    stopRingtone();
    if (!soundEnabled) return;
    ringtoneKind = kind;
    previewingRingtone = preview;
    const generation = ringtoneGeneration;
    const selectedRingtoneId = customId || activeRingtoneId;
    if (kind === "incoming" && selectedRingtoneId !== DEFAULT_RINGTONE_ID) {
      await playCustomRingtone(selectedRingtoneId, { preview, generation });
      if (generation === ringtoneGeneration && preview) {
        previewRingtoneId = selectedRingtoneId;
        renderRingtoneList();
      }
      return;
    }
    const unlocked = await unlockSound();
    if (generation !== ringtoneGeneration || ringtoneKind !== kind) return;
    if (!unlocked) {
      byId("voice-call-sound-notice").hidden = !activeCall;
      if (preview) setStatus("Браузер заблокировал мелодию. Разрешите звук для сайта и нажмите «Прослушать» ещё раз.");
      return;
    }
    void playPattern(kind, generation);
    if (navigator.vibrate && typeof navigator.vibrate === "function") {
      navigator.vibrate(kind === "incoming" ? [180, 120, 180, 850] : [90, 1300]);
    }
    ringtoneTimer = setInterval(() => {
      if (generation !== ringtoneGeneration || ringtoneKind !== kind) return;
      void playPattern(kind, generation);
      if (navigator.vibrate) navigator.vibrate(kind === "incoming" ? [180, 120, 180, 850] : [90, 1300]);
    }, 2600);
    if (preview) {
      previewRingtoneId = DEFAULT_RINGTONE_ID;
      renderRingtoneList();
    }
  }

  function playCallCue(kind) {
    stopRingtone();
    if (!soundEnabled) return;
    const generation = ringtoneGeneration;
    void unlockSound().then((unlocked) => {
      if (!unlocked || generation !== ringtoneGeneration || !soundEnabled) return;
      const now = soundContext.currentTime + 0.03;
      if (kind === "connected") { tone(523.25, now, 0.12, "sine", 0.11); tone(783.99, now + 0.1, 0.24, "sine", 0.1); }
      else if (kind === "rejected") { tone(493.88, now, 0.17, "triangle", 0.11); tone(349.23, now + 0.18, 0.34, "triangle", 0.1); }
      else if (kind === "ended") { tone(587.33, now, 0.12, "sine", 0.1); tone(392, now + 0.14, 0.22, "sine", 0.08); }
    });
  }

  function setSoundsEnabled(enabled) {
    soundEnabled = enabled;
    writeSoundSetting("gadlink-call-sounds", enabled);
    if (!enabled) {
      if (ringtoneKind && !previewingRingtone) mutedRingtoneKind = ringtoneKind;
      stopRingtone();
    } else if (mutedRingtoneKind && activeCall && !activeCall.accepted) {
      const kind = mutedRingtoneKind;
      mutedRingtoneKind = null;
      void startRingtone(kind);
    }
    const toggle = byId("call-sounds-enabled");
    if (toggle) toggle.checked = enabled;
  }

  function renderHistory(owner, names = new Map()) {
    const history = byId("call-history");
    const calls = currentHistoryCalls.filter((call) => {
      const outgoing = call.caller_id === owner.id;
      if (historyFilter === "missed") return call.status === "missed" && !outgoing;
      if (historyFilter === "incoming") return !outgoing;
      if (historyFilter === "outgoing") return outgoing;
      return true;
    });
    history.replaceChildren();
    if (!calls.length) {
      const empty = document.createElement("p");
      empty.className = "call-history-empty";
      empty.textContent = currentHistoryCalls.length
        ? "Для этого фильтра звонков нет."
        : "Здесь появится история звонков.";
      history.append(empty);
      return;
    }

    for (const call of calls) {
      const outgoing = call.caller_id === owner.id;
      const peerId = outgoing ? call.callee_id : call.caller_id;
      const peer = names.get(peerId);
      const row = document.createElement("article");
      row.className = `call-history__row call-history__row--${call.status}`;
      const details = document.createElement("div");
      details.className = "call-history__details";
      const name = document.createElement("strong");
      name.textContent = peer?.username || "Пользователь";
      const meta = document.createElement("span");
      const direction = outgoing ? "Исходящий" : "Входящий";
      const status = call.status === "missed" && !outgoing
        ? "Пропущен"
        : callStatusLabels[call.status] || "Звонок";
      const duration = call.status === "ended" && call.duration_seconds
        ? ` · ${formatDuration(call.duration_seconds)}`
        : "";
      meta.textContent = `${direction} · ${status}${duration}`;
      const date = document.createElement("time");
      date.dateTime = call.created_at;
      date.textContent = formatCallDate(call.created_at);
      details.append(name, meta, date);

      const callback = document.createElement("button");
      callback.type = "button";
      callback.className = "call-history__callback";
      callback.setAttribute("aria-label", `Позвонить ${name.textContent}`);
      callback.title = "Позвонить снова";
      callback.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H4.8A1.8 1.8 0 0 0 3 4.8C3 13.7 10.3 21 19.2 21a1.8 1.8 0 0 0 1.8-1.8V17l-5-2-1.8 2.2a14.5 14.5 0 0 1-6.4-6.4L10 9Z"/></svg>';
      callback.addEventListener("click", () => void startCall(peerId, peer?.username, peer?.avatar_url));
      row.append(details, callback);
      history.append(row);
    }
  }

  function isSecureAudioContext() {
    return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
  }

  function setAvatar(url, username) {
    const image = byId("voice-call-avatar");
    const placeholder = byId("voice-call-avatar-placeholder");
    const safeUrl = typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
    image.hidden = !safeUrl;
    if (safeUrl) image.src = safeUrl;
    else image.removeAttribute("src");
    placeholder.hidden = Boolean(safeUrl);
    placeholder.textContent = (username || "?").trim().slice(0, 1).toLocaleUpperCase() || "?";
  }

  function showCallDialog(call, incoming = false) {
    byId("voice-call-name").textContent = call.username || "Пользователь";
    setAvatar(call.avatarUrl, call.username);
    byId("voice-call-incoming-actions").hidden = !incoming;
    byId("voice-call-active-actions").hidden = incoming;
    byId("voice-call-accept").disabled = incoming && !call.channelReady;
    byId("voice-call-error-actions").hidden = true;
    byId("voice-call-timer").hidden = true;
    byId("voice-call-mute").disabled = incoming;
    byId("voice-call-mute").textContent = "Выключить микрофон";
    byId("voice-call-mute").setAttribute("aria-pressed", "false");
    byId("voice-call-peer-state").hidden = true;
    byId("voice-call-quality").textContent = "Сеть: подключение";
    byId("voice-call-dialog").classList.remove("is-minimized");
    byId("voice-call-dialog").setAttribute("aria-modal", "true");
    byId("voice-call-minimized").hidden = true;
    dialog.hidden = false;
  }

  function hideCallDialog() {
    dialog.hidden = true;
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    byId("voice-call-timer").hidden = true;
    byId("voice-call-minimized").hidden = true;
    byId("voice-call-dialog").classList.remove("is-minimized");
  }

  function minimizeCall() {
    if (!activeCall) return;
    dialog.hidden = true;
    dialog.setAttribute("aria-modal", "false");
    byId("voice-call-minimized-name").textContent = activeCall.username || "Звонок";
    byId("voice-call-minimized").hidden = false;
  }

  function restoreCall() {
    if (!activeCall) return;
    byId("voice-call-minimized").hidden = true;
    dialog.hidden = false;
    dialog.setAttribute("aria-modal", "true");
    dialog.classList.remove("is-minimized");
  }

  function requestProfile() {
    if (!activeCall?.peerId) return;
    window.dispatchEvent(new CustomEvent("gadlink:open-contact-profile", {
      detail: { userId: activeCall.peerId, username: activeCall.username, avatarUrl: activeCall.avatarUrl }
    }));
    setCallStatus("Профиль собеседника пока доступен в разделе «Друзья».");
  }

  async function refreshAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = byId("voice-call-input-device");
      const output = byId("voice-call-output-device");
      const selectedInput = input.value;
      const selectedOutput = output.value;
      input.replaceChildren(new Option("По умолчанию", ""));
      output.replaceChildren(new Option("По умолчанию", ""));
      for (const device of devices) {
        if (device.kind === "audioinput") input.add(new Option(device.label || `Микрофон ${input.length}`, device.deviceId));
        if (device.kind === "audiooutput") output.add(new Option(device.label || `Устройство ${output.length}`, device.deviceId));
      }
      if ([...input.options].some((option) => option.value === selectedInput)) input.value = selectedInput;
      if ([...output.options].some((option) => option.value === selectedOutput)) output.value = selectedOutput;
      output.hidden = typeof remoteAudio.setSinkId !== "function";
    } catch (error) {
      console.warn("GadLink call devices:", error);
    }
  }

  async function getPeerProfile(userId) {
    try {
      const profiles = await getPublicProfileNames([userId]);
      return profiles.get(userId) || { username: "Пользователь", avatar_url: null };
    } catch (error) {
      console.error("GadLink voice call profile:", error);
      return { username: "Пользователь", avatar_url: null };
    }
  }

  async function refreshHistory() {
    const owner = getUser();
    if (historyClearing) return;
    const requestId = ++historyRequest;
    if (!owner?.id) return;

    const { data, error } = await supabase.rpc("gadlink_get_voice_call_history");
    if (error) {
      console.error("GadLink voice call history:", error);
      setStatus(`Не удалось загрузить историю звонков: ${error.message}`);
      return;
    }
    if (getUser()?.id !== owner.id || requestId !== historyRequest) return;
    const calls = data || [];

    const peerIds = [...new Set(calls.map((call) =>
      call.caller_id === owner.id ? call.callee_id : call.caller_id
    ).filter(isUuid))];
    let names = new Map();
    try {
      names = await getPublicProfileNames(peerIds);
    } catch (nameError) {
      console.error("GadLink voice call history names:", nameError);
    }
    if (getUser()?.id !== owner.id || requestId !== historyRequest) return;

    currentHistoryCalls = calls;
    for (const call of calls) callStatusById.set(call.id, call.status);
    renderHistory(owner, names);
    setStatus("");
  }

  async function clearHistory() {
    const owner = getUser();
    if (!owner?.id) {
      setStatus("Войдите в аккаунт, чтобы очистить историю звонков.");
      return;
    }
    if (!window.confirm("Удалить всю историю звонков этого аккаунта? Это действие нельзя отменить.")) return;
    const button = byId("call-history-clear");
    button.disabled = true;
    historyClearing = true;
    historyRequest += 1;
    setStatus("Очищаем историю звонков…");
    try {
      const { error } = await supabase.rpc("gadlink_clear_voice_call_history");
      if (error) throw error;
      if (getUser()?.id !== owner.id) return;
      currentHistoryCalls = [];
      renderHistory(owner);
      setStatus("История звонков очищена.");
    } catch (error) {
      console.error("GadLink voice call history clear:", error);
      setStatus(`Не удалось очистить историю звонков: ${error.message}`);
    } finally {
      historyClearing = false;
      button.disabled = false;
    }
  }

  byId("call-history-clear").addEventListener("click", () => void clearHistory());
  document.querySelectorAll("[data-call-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      historyFilter = button.dataset.callFilter;
      document.querySelectorAll("[data-call-filter]").forEach((filterButton) => {
        filterButton.setAttribute("aria-pressed", String(filterButton === button));
      });
      const owner = getUser();
      if (owner?.id) void refreshHistory();
    });
  });

  async function broadcast(type, payload = {}) {
    if (!activeCall?.channel) return;
    try {
      const result = await activeCall.channel.send({
        type: "broadcast",
        event: "call-signal",
        payload: {
          type,
          callId: activeCall.id,
          from: getUser()?.id,
          to: activeCall.peerId,
          ...payload
        }
      });
      if (result !== "ok") {
        console.error("GadLink voice call broadcast:", result);
      }
    } catch (error) {
      console.error("GadLink voice call broadcast:", error);
      setCallStatus(`Проблема с сигнализацией звонка: ${error.message}`);
    }
  }

  async function transition(action) {
    if (!activeCall?.id) return null;
    const { data, error } = await supabase.rpc("gadlink_transition_voice_call", {
      target_call_id: activeCall.id,
      call_action: action
    });
    if (error) throw error;
    return data;
  }

  async function getIceServers() {
    const ownerId = getUser()?.id;
    const stunOnly = [{ urls: "stun:stun.l.google.com:19302" }];
    if (!ownerId) return stunOnly;
    if (iceServerCacheOwnerId === ownerId && Date.now() < iceServerCacheUntil) {
      return iceServerCache;
    }
    if (!iceServerRequest || iceServerRequestOwnerId !== ownerId) {
      iceServerRequestOwnerId = ownerId;
      iceServerRequest = (async () => {
        try {
          let timeout;
          const turnResult = await Promise.race([
            supabase.functions.invoke("voice-ice-config", { method: "GET" }),
            new Promise((resolve) => {
              timeout = setTimeout(() => resolve({ error: new Error("TURN config timeout") }), ICE_CONFIG_FETCH_TIMEOUT_MS);
            })
          ]).finally(() => clearTimeout(timeout));
          const { data, error } = turnResult;
          if (error) throw error;
          const turnServers = (Array.isArray(data?.iceServers) ? data.iceServers : []).filter((server) => {
            const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
            return urls.some((url) => typeof url === "string" && /^turns?:/i.test(url)) &&
              typeof server.username === "string" && typeof server.credential === "string";
          });
          if (!turnServers.length) throw new Error("Сервер не вернул TURN-конфигурацию.");
          const result = [...stunOnly, ...turnServers];
          if (getUser()?.id === ownerId) {
            iceServerCache = result;
            iceServerCacheOwnerId = ownerId;
            iceServerCacheUntil = Date.now() + ICE_SERVER_CACHE_MS;
          }
          return result;
        } catch (error) {
          console.warn("GadLink TURN configuration is unavailable; using STUN only.", error);
          if (getUser()?.id === ownerId) {
            iceServerCache = stunOnly;
            iceServerCacheOwnerId = ownerId;
            iceServerCacheUntil = Date.now() + ICE_CONFIG_RETRY_MS;
          }
          return stunOnly;
        } finally {
          if (iceServerRequestOwnerId === ownerId) {
            iceServerRequest = null;
            iceServerRequestOwnerId = null;
          }
        }
      })();
    }
    const request = iceServerRequest;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(stunOnly), ICE_CONFIG_WAIT_MS);
      request.then((result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  async function createPeerConnection() {
    if (!activeCall) throw new Error("Звонок уже завершён.");
    if (activeCall.peerConnection) return activeCall.peerConnection;
    const call = activeCall;
    if (call.peerConnectionPromise) return call.peerConnectionPromise;
    call.peerConnectionPromise = (async () => {
      const iceServers = await getIceServers();
      if (activeCall !== call) throw new Error("Звонок завершён до подключения.");
      const peerConnection = new RTCPeerConnection({ iceServers });
      call.peerConnection = peerConnection;
      call.pendingCandidates ||= [];

      for (const track of call.localStream?.getAudioTracks() || []) {
        peerConnection.addTrack(track, call.localStream);
      }
      peerConnection.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream || activeCall?.peerConnection !== peerConnection) return;
        remoteAudio.srcObject = stream;
        void remoteAudio.play().catch((error) => {
          console.warn("GadLink remote audio autoplay was blocked:", error);
          setCallStatus("Нажмите на экран, чтобы включить звук собеседника.");
        });
      };
      peerConnection.onicecandidate = (event) => {
        if (activeCall?.peerConnection === peerConnection) {
          void broadcast("ice", event.candidate
            ? { candidate: event.candidate.toJSON() }
            : { candidate: null, complete: true });
        }
      };
      peerConnection.onicecandidateerror = (event) => {
        console.warn("GadLink ICE candidate error:", event.errorCode, event.url, event.errorText);
      };
      peerConnection.oniceconnectionstatechange = () => {
        if (activeCall?.peerConnection !== peerConnection) return;
        const state = peerConnection.iceConnectionState;
        if (state === "connected" || state === "completed") {
          markConnected();
        } else if (state === "disconnected") {
          setCallStatus("Связь прервалась, пытаемся восстановить…");
          byId("voice-call-quality").textContent = "Сеть: переподключение…";
          byId("voice-call-quality").classList.add("is-poor");
          clearTimeout(call.disconnectTimer);
          call.disconnectTimer = setTimeout(() => {
            if (activeCall === call && peerConnection.iceConnectionState === "disconnected") {
              void failCall("Соединение потеряно.");
            }
          }, RECONNECT_GRACE_MS);
        } else if (state === "failed") {
          void failCall("Не удалось установить голосовое соединение. Проверьте сеть или TURN.");
        }
      };
      peerConnection.onconnectionstatechange = () => {
        if (activeCall?.peerConnection !== peerConnection) return;
        if (peerConnection.connectionState === "connected") markConnected();
        if (peerConnection.connectionState === "failed") {
          void failCall("WebRTC не смог установить соединение. Нужен доступный TURN-сервер или другая сеть.");
        }
      };
      call.qualityTimer = setInterval(async () => {
        if (activeCall !== call) return;
        try {
          const report = await peerConnection.getStats();
          let rtt = null;
          for (const stat of report.values()) {
            if (stat.type === "candidate-pair" && stat.state === "succeeded" && (stat.nominated || stat.selected)) rtt = stat.currentRoundTripTime;
          }
          const state = peerConnection.iceConnectionState;
          const label = state === "connected" || state === "completed"
            ? (rtt !== null && rtt > 0.45 ? "Сеть: слабый сигнал" : "Сеть: хорошая")
            : state === "disconnected" ? "Сеть: переподключение…" : "Сеть: соединение";
          byId("voice-call-quality").textContent = label;
          byId("voice-call-quality").classList.toggle("is-poor", label.includes("слабый") || state === "disconnected");
        } catch (error) { console.warn("GadLink call quality:", error); }
      }, 2500);
      return peerConnection;
    })();
    try {
      return await call.peerConnectionPromise;
    } finally {
      call.peerConnectionPromise = null;
    }
  }

  function startConnectionTimer(call) {
    clearTimeout(call.connectionTimer);
    call.connectionTimer = setTimeout(() => {
      if (activeCall === call && !call.connected) {
        void failCall("Не удалось установить соединение. Проверьте микрофон, сеть и настройки TURN.");
      }
    }, 30_000);
  }

  async function flushCandidates() {
    const call = activeCall;
    const peerConnection = call?.peerConnection;
    if (!peerConnection?.remoteDescription) return;
    const pending = call.pendingCandidates.splice(0);
    for (const candidate of pending) {
      if (activeCall !== call) return;
      await peerConnection.addIceCandidate(candidate);
    }
  }

  async function createOffer() {
    if (!activeCall?.outgoing || activeCall.peerConnection?.localDescription || activeCall.offerStarted) return;
    const call = activeCall;
    if (!call.localStream) {
      call.offerPending = true;
      return;
    }
    call.offerStarted = true;
    try {
      setCallStatus("Соединение…");
      const peerConnection = await createPeerConnection();
      if (activeCall !== call || !call.outgoing) return;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await broadcast("offer", { description: peerConnection.localDescription });
    } catch (error) {
      console.error("GadLink voice call offer:", error);
      if (activeCall === call) await failCall(`Не удалось начать соединение: ${error.message}`);
    }
  }

  async function handleSignal(payload) {
    if (!activeCall || payload?.callId !== activeCall.id ||
        payload.from !== activeCall.peerId || payload.to !== getUser()?.id) return;
    const call = activeCall;

    try {
      if (payload.type === "accepted" && activeCall.outgoing) {
        stopRingtone();
        activeCall.accepted = true;
        if (activeCall.timeout) clearTimeout(activeCall.timeout);
        startConnectionTimer(activeCall);
        await createOffer();
      } else if (payload.type === "offer" && !activeCall.outgoing && activeCall.accepted) {
        const peerConnection = await createPeerConnection();
        await peerConnection.setRemoteDescription(payload.description);
        await flushCandidates();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await broadcast("answer", { description: peerConnection.localDescription });
      } else if (payload.type === "answer" && activeCall.outgoing && activeCall.peerConnection) {
        await activeCall.peerConnection.setRemoteDescription(payload.description);
        await flushCandidates();
      } else if (payload.type === "ice" && (payload.candidate || payload.complete)) {
        const peerConnection = activeCall.peerConnection;
        const candidate = payload.candidate ? new RTCIceCandidate(payload.candidate) : null;
        if (peerConnection?.remoteDescription) await peerConnection.addIceCandidate(candidate);
        else activeCall.pendingCandidates.push(candidate);
      } else if (payload.type === "rejected") {
        await finishCall("Звонок отклонён.", false);
      } else if (payload.type === "busy") {
        await finishCall("Собеседник занят.", false);
      } else if (payload.type === "cancelled") {
        await finishCall("Звонок отменён.", false);
      } else if (payload.type === "ended") {
        await finishCall("Звонок завершён собеседником.", false);
      } else if (payload.type === "failed") {
        await finishCall("Соединение завершено.", false);
      } else if (payload.type === "call-state") {
        const peerState = byId("voice-call-peer-state");
        const label = payload.held ? "Собеседник удерживает звонок" : payload.muted ? "Микрофон собеседника выключен" : "";
        peerState.textContent = label;
        peerState.hidden = !label;
      }
    } catch (error) {
      console.error("GadLink voice call signal:", error);
      if (activeCall === call) await failCall(`Ошибка соединения: ${error.message}`);
    }
  }

  async function joinCallChannel() {
    if (!activeCall) throw new Error("Звонок уже завершён.");
    const call = activeCall;
    const channel = supabase.channel(`voice-call:${call.id}`, {
      config: { private: true }
    });
    call.channel = channel;
    channel.on("broadcast", { event: "call-signal" }, ({ payload }) => {
      void handleSignal(payload);
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Не удалось подключиться к приватному каналу звонка."));
      }, 10_000);
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED" && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error || new Error(`Realtime: ${status}`));
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("GadLink call channel:", error || status);
          void failCall("Потеряно подключение к сигнализации звонка.");
        }
      });
    });
    if (activeCall !== call) throw new Error("Звонок завершён.");
    call.channelReady = true;
    if (!call.outgoing) byId("voice-call-accept").disabled = false;
  }

  function startHeartbeat() {
    if (!activeCall) return;
    const call = activeCall;
    clearInterval(call.heartbeat);
    call.heartbeat = setInterval(async () => {
      if (activeCall !== call) return;
      try {
        await transition("heartbeat");
      } catch (error) {
        console.error("GadLink call heartbeat:", error);
        if (activeCall === call) await failCall("Сервер потерял связь со звонком.");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function markConnected() {
    if (!activeCall || activeCall.connected) return;
    activeCall.connected = true;
    activeCall.connectedAt = Date.now();
    clearTimeout(activeCall.timeout);
    clearTimeout(activeCall.connectionTimer);
    clearTimeout(activeCall.disconnectTimer);
    byId("voice-call-incoming-actions").hidden = true;
    byId("voice-call-active-actions").hidden = false;
    byId("voice-call-mute").disabled = false;
    byId("voice-call-timer").hidden = false;
    setCallStatus("В разговоре");
    byId("voice-call-quality").textContent = "Сеть: хорошая";
    byId("voice-call-quality").classList.remove("is-poor");
    playCallCue("connected");
    void broadcast("call-state", { muted: Boolean(callIsMuted()), held: false });
    void refreshAudioDevices();
    const call = activeCall;
    activeCall.timer = setInterval(() => {
      if (activeCall !== call || !call.connectedAt) return;
      const elapsed = formatDuration((Date.now() - call.connectedAt) / 1000);
      byId("voice-call-timer").textContent = elapsed;
      byId("voice-call-minimized-timer").textContent = elapsed;
    }, 1000);
    startHeartbeat();
  }

  async function releaseCallResources({ keepErrorDialog = false, expectedCall = null } = {}) {
    const call = expectedCall || activeCall;
    if (!call || activeCall !== call) return;
    stopRingtone();
    activeCall = null;
    startingCall = false;
    clearTimeout(call.timeout);
    clearTimeout(call.connectionTimer);
    clearTimeout(call.disconnectTimer);
    clearInterval(call.timer);
    clearInterval(call.heartbeat);
    clearInterval(call.qualityTimer);
    if (call.peerConnection) {
      call.peerConnection.ontrack = null;
      call.peerConnection.onicecandidate = null;
      call.peerConnection.oniceconnectionstatechange = null;
      call.peerConnection.close();
    }
    for (const track of call.localStream?.getTracks() || []) track.stop();
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    if (call.channel) {
      void supabase.removeChannel(call.channel).catch((error) => {
        console.error("GadLink remove call channel:", error);
      });
    }
    callOutputMuted = false;
    byId("voice-call-output-toggle").setAttribute("aria-pressed", "false");
    if (keepErrorDialog) {
      byId("voice-call-incoming-actions").hidden = true;
      byId("voice-call-active-actions").hidden = true;
      byId("voice-call-error-actions").hidden = false;
      byId("voice-call-timer").hidden = true;
      dialog.hidden = false;
    } else {
      hideCallDialog();
    }
    void refreshHistory();
  }

  async function finishCall(message, sendTransition = true, action = null) {
    const call = activeCall;
    if (!call || call.finishing) return;
    call.finishing = true;
    const outcome = action === "missed" || message?.toLowerCase().includes("пропущ") ? "missed"
      : message?.toLowerCase().includes("отклон") || message?.toLowerCase().includes("занят") ? "rejected" : "ended";
    if (outcome === "missed" && !call.outgoing) notifyMissedCall(call.username);
    if (message) setStatus(message);
    if (sendTransition) {
      try {
        await transition(action || (call.accepted ? "end" : call.outgoing ? "cancel" : "reject"));
      } catch (error) {
        console.error("GadLink finish call:", error);
        setStatus(`Не удалось обновить историю звонка: ${error.message}`);
      }
    }
    if (activeCall === call) {
      await releaseCallResources({ expectedCall: call });
      playCallCue(outcome === "rejected" ? "rejected" : "ended");
    }
  }

  async function failCall(message) {
    const call = activeCall;
    if (!call || call.finishing) return;
    call.finishing = true;
    setStatus(message);
    setCallStatus(message);
    void broadcast("failed");
    if (call.id) {
      void transition("failed").catch((error) => {
        console.error("GadLink fail call status:", error);
      });
    }
    await releaseCallResources({ keepErrorDialog: true, expectedCall: call });
  }

  async function startCall(peerId, peerName = null, avatarUrl = null) {
    const owner = getUser();
    if (!owner?.id) {
      setStatus("Войдите в аккаунт, чтобы звонить.");
      return;
    }
    if (!isUuid(peerId) || peerId === owner.id) {
      setStatus("Нельзя звонить самому себе или пользователю с некорректным ID.");
      return;
    }
    if (activeCall || startingCall) {
      setStatus("Сначала завершите текущий звонок.");
      return;
    }
    if (!isSecureAudioContext()) {
      setStatus("Для звонков нужен HTTPS и браузер с поддержкой микрофона.");
      return;
    }

    startingCall = true;
    const callStartedAt = Date.now();
    const call = {
      id: null,
      peerId,
      username: peerName || "Пользователь",
      avatarUrl,
      outgoing: true,
      accepted: false,
      connected: false,
      localStream: null,
      peerConnection: null,
      pendingCandidates: []
    };
    activeCall = call;
    showCallDialog(call);
    void startRingtone("outgoing");
    setCallStatus("Готовим вызов…");

    // Fetch ICE credentials while the phone is ringing, instead of after answer.
    void getIceServers();
    void getPeerProfile(peerId).then((profile) => {
      if (activeCall !== call) return;
      call.username = peerName || profile.username || "Пользователь";
      call.avatarUrl = avatarUrl || profile.avatar_url || null;
      byId("voice-call-name").textContent = call.username;
      setAvatar(call.avatarUrl, call.username);
    });

    const mediaSetup = navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (activeCall !== call) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        call.localStream = stream;
        setCallStatus(call.accepted ? "Соединение…" : call.id ? "Звоним…" : "Отправляем вызов…");
        if (call.accepted) void createOffer();
      })
      .catch(async (error) => {
        console.error("GadLink microphone access:", error);
        if (activeCall === call) {
          await failCall(error.name === "NotAllowedError"
            ? "Разрешите доступ к микрофону в настройках браузера."
            : `Не удалось получить доступ к микрофону: ${error.message}`);
        }
        throw error;
      });

    const signalingSetup = (async () => {
      const { data: callId, error } = await supabase.rpc("gadlink_start_voice_call", {
        peer_user_id: peerId
      });
      if (error) throw error;
      if (!isUuid(callId)) throw new Error("Сервер не вернул идентификатор звонка.");
      call.id = callId;
      if (activeCall !== call || getUser()?.id !== owner.id) {
        const { error: cancelError } = await supabase.rpc("gadlink_transition_voice_call", {
          target_call_id: callId,
          call_action: "cancel"
        });
        if (cancelError) {
          await supabase.rpc("gadlink_transition_voice_call", {
            target_call_id: callId,
            call_action: "failed"
          });
        }
        return;
      }
      call.timeout = setTimeout(() => {
        if (activeCall?.id !== callId) return;
        setCallStatus("Нет ответа.");
        void finishCall(null, true, "missed");
      }, Math.max(0, RING_TIMEOUT_MS - (Date.now() - callStartedAt)));
      setCallStatus(call.localStream
        ? call.accepted ? "Соединение…" : "Звоним…"
        : "Вызов отправлен. Ожидаем доступ к микрофону…");
      await joinCallChannel();
    })();
    void signalingSetup.catch((error) => {
      if (activeCall === call) void failCall(`Не удалось начать звонок: ${error.message}`);
    });

    const [mediaResult, signalingResult] = await Promise.allSettled([mediaSetup, signalingSetup]);
    if (activeCall === call && signalingResult.status === "rejected") {
      console.error("GadLink start call:", signalingResult.reason);
      await failCall(`Не удалось начать звонок: ${signalingResult.reason.message}`);
    }
    if (mediaResult.status === "rejected" && signalingResult.status === "rejected") {
      setStatus(`Не удалось начать звонок: ${signalingResult.reason.message}`);
    }
    startingCall = false;
  }

  async function receiveIncomingCall(row) {
    const owner = getUser();
    if (!owner?.id || !isUuid(row?.id) || row.callee_id !== owner.id ||
        !isUuid(row.caller_id) || row.status !== "ringing") return;
    if (activeCall?.id === row.id || incomingCallRequests.has(row.id)) return;
    if (activeCall) {
      try {
        const { error } = await supabase.rpc("gadlink_transition_voice_call", {
          target_call_id: row.id,
          call_action: "reject"
        });
        if (error) throw error;
      } catch (error) {
        console.error("GadLink busy call rejection:", error);
      }
      return;
    }

    incomingCallRequests.add(row.id);
    try {
      const call = {
        id: row.id,
        peerId: row.caller_id,
        username: "Пользователь",
        avatarUrl: null,
        outgoing: false,
        accepted: false,
        connected: false,
        localStream: null,
        peerConnection: null,
        pendingCandidates: []
      };
      if (getUser()?.id !== owner.id || activeCall) return;
      activeCall = call;
      showCallDialog(call, true);
      void startRingtone("incoming");
      setCallStatus("Входящий звонок…");
      void getIceServers();
      void getPeerProfile(row.caller_id).then((profile) => {
        if (activeCall !== call) return;
        call.username = profile.username || "Пользователь";
        call.avatarUrl = profile.avatar_url || null;
        byId("voice-call-name").textContent = call.username;
        setAvatar(call.avatarUrl, call.username);
      });
      call.timeout = setTimeout(() => {
        if (activeCall?.id !== row.id) return;
        setCallStatus("Пропущенный звонок.");
        void finishCall(null, true, "missed");
      }, Math.max(0, RING_TIMEOUT_MS - (Date.now() - new Date(row.created_at).getTime())));
      await joinCallChannel();
    } catch (error) {
      console.error("GadLink incoming call channel:", error);
      if (activeCall?.id === row.id) await failCall(`Не удалось подключиться к звонку: ${error.message}`);
    } finally {
      incomingCallRequests.delete(row.id);
    }
  }

  async function resumeIncomingCall(callId) {
    const owner = getUser();
    if (!owner?.id || !isUuid(callId)) return false;
    const { data: row, error } = await supabase
      .from("voice_calls")
      .select("id,caller_id,callee_id,status,created_at")
      .eq("id", callId)
      .maybeSingle();
    if (error) {
      console.error("GadLink resume incoming call:", error);
      setStatus(`Не удалось проверить звонок: ${error.message}`);
      return false;
    }
    if (!row || row.callee_id !== owner.id) {
      setStatus("Этот входящий звонок недоступен.");
      return false;
    }
    if (row.status !== "ringing") {
      setStatus(row.status === "missed" ? "Это был пропущенный звонок." : "Звонок уже завершён.");
      await refreshHistory();
      return false;
    }
    if (activeCall?.id === row.id) return true;
    const age = Date.now() - new Date(row.created_at).getTime();
    if (!Number.isFinite(age) || age >= RING_TIMEOUT_MS) {
      try {
        const { error: expireError } = await supabase.rpc("gadlink_transition_voice_call", {
          target_call_id: row.id,
          call_action: "missed"
        });
        if (expireError) throw expireError;
      } catch (expireError) {
        console.error("GadLink expire incoming call:", expireError);
        setStatus(`Не удалось обновить пропущенный звонок: ${expireError.message}`);
        return false;
      }
      setStatus("Это был пропущенный звонок.");
      await refreshHistory();
      return false;
    }
    await receiveIncomingCall(row);
    return activeCall?.id === row.id;
  }

  async function handlePushCallAction(callId, action) {
    if (!isUuid(callId) || !["answer", "reject"].includes(action)) return false;
    const owner = getUser();
    if (!owner?.id) return false;

    const { data: row, error } = await supabase
      .from("voice_calls")
      .select("id,caller_id,callee_id,status,created_at")
      .eq("id", callId)
      .maybeSingle();
    if (error) {
      console.error("GadLink notification call lookup:", error);
      setStatus("Не удалось проверить актуальность звонка. Откройте раздел звонков и попробуйте ещё раз.");
      return false;
    }
    if (!row || row.callee_id !== owner.id) {
      setStatus("Этот входящий звонок недоступен.");
      return false;
    }
    const age = Date.now() - new Date(row.created_at).getTime();
    if (row.status !== "ringing" || !Number.isFinite(age) || age < -30_000 || age >= RING_TIMEOUT_MS) {
      if (row.status === "ringing" && Number.isFinite(age) && age >= RING_TIMEOUT_MS) {
        const { error: expireError } = await supabase.rpc("gadlink_transition_voice_call", {
          target_call_id: row.id,
          call_action: "missed"
        });
        if (expireError) console.error("GadLink expire notification call:", expireError);
      }
      setStatus("Звонок уже завершён или истёк.");
      await refreshHistory();
      return false;
    }

    if (action === "reject") {
      const { error: rejectError } = await supabase.rpc("gadlink_transition_voice_call", {
        target_call_id: row.id,
        call_action: "reject"
      });
      if (rejectError) {
        console.error("GadLink reject notification call:", rejectError);
        setStatus("Не удалось отклонить звонок. Откройте GadLink и попробуйте ещё раз.");
        return false;
      }
      if (activeCall?.id === row.id) await releaseCallResources({ expectedCall: activeCall });
      setStatus("Звонок отклонён.");
      await refreshHistory();
      return true;
    }

    if (!await resumeIncomingCall(callId)) return false;
    try {
      const permission = await navigator.permissions?.query?.({ name: "microphone" });
      if (permission?.state === "granted") {
        await acceptCall();
      } else {
        setCallStatus("Звонок открыт. Нажмите «Ответить», чтобы разрешить микрофон и начать разговор.");
      }
    } catch (error) {
      console.warn("GadLink microphone permission status is unavailable:", error);
      setCallStatus("Звонок открыт. Нажмите «Ответить», чтобы начать разговор.");
    }
    return true;
  }

  async function acceptCall() {
    if (!activeCall || activeCall.outgoing || activeCall.accepted || !activeCall.channelReady) return;
    const call = activeCall;
    if (!isSecureAudioContext()) {
      setCallStatus("Для звонка нужен HTTPS и доступ к микрофону.");
      return;
    }

    stopRingtone();
    void unlockSound();
    call.accepting = true;
    const acceptButton = byId("voice-call-accept");
    acceptButton.disabled = true;
    let acceptedOnServer = false;
    try {
      call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (activeCall !== call) {
        call.localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      await createPeerConnection();
      if (activeCall !== call) return;
      await transition("answer");
      if (activeCall !== call) return;
      acceptedOnServer = true;
      call.accepted = true;
      call.accepting = false;
      clearTimeout(call.timeout);
      startConnectionTimer(call);
      byId("voice-call-incoming-actions").hidden = true;
      byId("voice-call-active-actions").hidden = false;
      byId("voice-call-mute").disabled = false;
      setCallStatus("Соединение…");
      await broadcast("accepted");
    } catch (error) {
      console.error("GadLink accept call:", error);
      if (activeCall === call) {
        call.accepting = false;
        if (acceptedOnServer) {
          await failCall(`Не удалось принять звонок: ${error.message}`);
        } else {
          setCallStatus(error.name === "NotAllowedError"
            ? "Разрешите доступ к микрофону, чтобы принять звонок."
            : `Не удалось принять звонок: ${error.message}`);
          if (soundEnabled) void startRingtone("incoming");
        }
      }
      if (call.localStream) {
        call.localStream.getTracks().forEach((track) => track.stop());
        call.localStream = null;
      }
      if (call.peerConnection) {
        call.peerConnection.ontrack = null;
        call.peerConnection.onicecandidate = null;
        call.peerConnection.close();
        call.peerConnection = null;
      }
    } finally {
      acceptButton.disabled = false;
    }
  }

  async function rejectCall() {
    if (!activeCall || activeCall.outgoing) return;
    await broadcast("rejected");
    await finishCall("Звонок отклонён.");
  }

  function toggleMute() {
    if (!activeCall?.localStream) return;
    const track = activeCall.localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    const button = byId("voice-call-mute");
    button.textContent = muted ? "Включить микрофон" : "Выключить микрофон";
    button.setAttribute("aria-pressed", String(muted));
  }

  function renderIncomingHistory(calls) {
    const owner = getUser();
    const pending = (calls || []).find((call) =>
      call.callee_id === owner?.id && call.status === "ringing" &&
      Date.now() - new Date(call.created_at).getTime() < RING_TIMEOUT_MS
    );
    if (pending) void receiveIncomingCall(pending);
  }

  async function syncPendingIncomingCalls(ownerId) {
    const cutoff = new Date(Date.now() - RING_TIMEOUT_MS).toISOString();
    const { data, error } = await supabase
      .from("voice_calls")
      .select("id,caller_id,callee_id,status,created_at")
      .eq("callee_id", ownerId)
      .eq("status", "ringing")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("GadLink pending incoming calls:", error);
      setStatus(`Не удалось проверить входящие звонки: ${error.message}`);
      return;
    }
    renderIncomingHistory(data);
  }

  async function subscribeInbox(ownerId) {
    if (inboxSubscriptionPromise) await inboxSubscriptionPromise;
    if (inboxChannel && inboxChannelOwnerId === ownerId) {
      if (inboxChannelReady) {
        await syncPendingIncomingCalls(ownerId);
        return;
      }
      // A failed or timed-out channel is not reusable. Remove it so a later
      // focus/online/session restore can create a fresh subscription.
      const staleChannel = inboxChannel;
      inboxChannel = null;
      inboxChannelOwnerId = null;
      inboxChannelReady = false;
      await supabase.removeChannel(staleChannel);
    }
    if (inboxChannel) await supabase.removeChannel(inboxChannel);
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (sessionError || !session?.access_token || session.user?.id !== ownerId) {
      const reason = sessionError?.message || "No active session for the current user";
      console.error("GadLink voice inbox Realtime auth:", sessionError || reason);
      setStatus(`Не удалось подключить приём звонков: ${reason}`);
      return;
    }
    // Private channel authorization checks the user's JWT against
    // realtime.messages RLS. Set the current refreshed session token before join.
    try {
      await supabase.realtime.setAuth(session.access_token);
    } catch (error) {
      console.error("GadLink voice inbox Realtime auth:", error);
      setStatus(`Не удалось подключить приём звонков: ${error.message || "Realtime authorization failed"}`);
      return;
    }
    const channel = supabase.channel(`voice-inbox:${ownerId}`, { config: { private: true } });
    inboxChannel = channel;
    inboxChannelOwnerId = ownerId;
    inboxChannelReady = false;
    channel.on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "voice_calls"
      }, (payload) => {
        const row = payload.new || payload.old;
        if (row?.caller_id !== ownerId && row?.callee_id !== ownerId) return;
        const previousStatus = callStatusById.get(row.id);
        const statusChanged = previousStatus === undefined || previousStatus !== row.status;
        callStatusById.set(row.id, row.status);
        if (payload.eventType === "UPDATE" && row.status !== "ringing" && "serviceWorker" in navigator) {
          void navigator.serviceWorker.getRegistration().then(async (registration) => {
            const notifications = await registration?.getNotifications({ tag: `gadlink-call-${row.id}` });
            notifications?.forEach((notification) => notification.close());
          }).catch((error) => console.warn("GadLink could not dismiss a call notification:", error));
        }
        if (payload.eventType === "INSERT" && row.callee_id === ownerId && row.status === "ringing") {
          void receiveIncomingCall(row);
        }
        if (payload.eventType === "UPDATE" && activeCall?.id === row.id) {
          if (row.status === "accepted" && activeCall.outgoing && !activeCall.accepted) {
            stopRingtone();
            activeCall.accepted = true;
            clearTimeout(activeCall.timeout);
            startConnectionTimer(activeCall);
            void createOffer();
          } else if (row.status === "accepted" && !activeCall.outgoing) {
            stopRingtone();
            if (!activeCall.accepted && !activeCall.accepting) {
              setStatus("Звонок принят на другом устройстве.");
              void releaseCallResources({ expectedCall: activeCall });
            }
          } else if (!["ringing", "accepted"].includes(row.status)) {
            void finishCall(
              row.status === "missed" ? "Пропущенный звонок."
                : row.status === "rejected" ? "Собеседник отклонил звонок или занят."
                  : row.status === "cancelled" ? "Звонок отменён собеседником."
                    : row.status === "failed" ? "Не удалось установить соединение."
                      : "Звонок завершён.",
              false
            );
          }
        }
        const historyChanged = payload.eventType === "INSERT" ||
          (payload.eventType === "UPDATE" && statusChanged);
        if (historyChanged) void refreshHistory();
      });

    let resolveSubscription;
    const subscriptionPromise = new Promise((resolve) => {
      resolveSubscription = resolve;
    });
    inboxSubscriptionPromise = subscriptionPromise;
    await new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        setStatus("Не удалось подключить приём звонков. Проверьте Supabase Realtime.");
        resolve(false);
        if (inboxChannel === channel) {
          inboxChannel = null;
          inboxChannelOwnerId = null;
          inboxChannelReady = false;
          void supabase.removeChannel(channel);
        }
      }, 10_000);
      channel.subscribe((status, error) => {
        if (inboxChannel !== channel) return;
        if (status === "SUBSCRIBED") {
          inboxChannelReady = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(true);
          } else {
            void syncPendingIncomingCalls(ownerId);
            void refreshHistory();
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          inboxChannelReady = false;
          console.error("GadLink voice inbox Realtime:", error || status);
          const reason = error?.message || error?.reason || status;
          setStatus(`Не удалось подключить приём звонков: ${reason}`);
          if (inboxChannel === channel) {
            inboxChannel = null;
            inboxChannelOwnerId = null;
            void supabase.removeChannel(channel);
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(false);
          }
        }
      });
    });
    resolveSubscription();
    if (inboxSubscriptionPromise === subscriptionPromise) inboxSubscriptionPromise = null;
    if (inboxChannelReady && getUser()?.id === ownerId) await syncPendingIncomingCalls(ownerId);
  }

  async function initialize() {
    const owner = getUser();
    if (!owner?.id || initialisedUserId === owner.id) return;
    await shutdown();
    initialisedUserId = owner.id;
    await Promise.all([subscribeInbox(owner.id), refreshHistory()]);
  }

  async function shutdown() {
    historyRequest += 1;
    initialisedUserId = null;
    callStatusById.clear();
    if (inboxChannel) {
      await supabase.removeChannel(inboxChannel);
      inboxChannel = null;
    }
    inboxChannelOwnerId = null;
    inboxChannelReady = false;
    inboxSubscriptionPromise = null;
    if (activeCall) await releaseCallResources();
  }

  window.addEventListener("gadlink:start-voice-call", (event) => {
    const detail = event.detail || {};
    void startCall(detail.userId, detail.username, detail.avatarUrl);
  });
  byId("voice-call-accept").addEventListener("click", () => void acceptCall());
  byId("voice-call-reject").addEventListener("click", () => void rejectCall());
  byId("voice-call-hangup").addEventListener("click", () => {
    void broadcast(activeCall?.accepted ? "ended" : "cancelled")
      .finally(() => finishCall("Звонок завершён."));
  });
  byId("voice-call-close").addEventListener("click", hideCallDialog);
  byId("voice-call-mute").addEventListener("click", toggleMute);
  byId("voice-call-volume").addEventListener("input", (event) => {
    remoteAudio.volume = Number(event.currentTarget.value);
  });
  byId("voice-call-dialog").addEventListener("click", () => {
    void unlockSound();
    void remoteAudio.play().catch((error) => console.warn("GadLink audio playback:", error));
  });
  byId("call-sounds-enabled").checked = soundEnabled;
  byId("call-sound-volume").value = String(soundVolume);
  byId("call-sounds-enabled").addEventListener("change", (event) => {
    setSoundsEnabled(event.currentTarget.checked);
    setStatus(event.currentTarget.checked ? "Звуки звонков включены." : "Звуки звонков выключены.");
  });
  byId("call-sound-volume").addEventListener("input", (event) => {
    soundVolume = Math.min(1, Math.max(0, Number(event.currentTarget.value) || 0));
    writeSoundSetting("gadlink-call-sound-volume", soundVolume);
    if (ringtoneAudio) ringtoneAudio.volume = soundVolume;
  });
  ringtoneFileInput?.addEventListener("change", (event) => void saveCustomRingtone(event.currentTarget.files?.[0]));
  ringtoneList?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-ringtone-action]");
    if (!button) return;
    const { ringtoneAction: action, ringtoneId: id } = button.dataset;
    if (action === "install") selectRingtone(id);
    else if (action === "delete") void deleteCustomRingtone(id);
    else if (action === "preview") {
      if (previewRingtoneId === id && ringtoneAudio?.paused) void resumeCustomPreview();
      else if (previewRingtoneId === id) stopRingtone();
      else if (activeCall || startingCall) setRingtoneStatus("Прослушивание недоступно во время звонка.", true);
      else if (!soundEnabled) setRingtoneStatus("Сначала включите звуки звонков.", true);
      else void startRingtone("incoming", { preview: true, customId: id });
    }
  });
  byId("voice-call-sound-enable").addEventListener("click", async () => {
    let enabled = await unlockSound();
    if (ringtoneAudio) {
      try {
        await ringtoneAudio.play();
        enabled = true;
        const generation = ringtoneGeneration;
        fadeInCustomRingtone(ringtoneAudio, generation);
      }
      catch (error) { console.warn("GadLink custom ringtone playback is still blocked:", error); enabled = false; }
    }
    if (!enabled) {
      setStatus("Браузер не разрешил воспроизведение звука. Проверьте настройки сайта и нажмите кнопку ещё раз.");
      return;
    }
    byId("voice-call-sound-notice").hidden = true;
    if (ringtoneKind && !ringtoneTimer) {
      const kind = ringtoneKind;
      const preview = previewingRingtone;
      const customId = previewRingtoneId;
      void startRingtone(kind, { preview, ...(customId ? { customId } : {}) });
    }
  });
  const resumeRingtoneAfterGesture = () => {
    if (!soundEnabled || !ringtoneKind || soundContext?.state === "running") return;
    const kind = ringtoneKind;
    const preview = previewingRingtone;
    const customId = previewRingtoneId;
    void startRingtone(kind, { preview, ...(customId ? { customId } : {}) });
  };
  document.addEventListener("pointerdown", resumeRingtoneAfterGesture, { capture: true });
  document.addEventListener("keydown", resumeRingtoneAfterGesture, { capture: true });
  window.addEventListener("online", () => {
    if (getUser()?.id && initialisedUserId === getUser().id) {
      void Promise.all([subscribeInbox(getUser().id), refreshHistory()]);
    }
  });
  const restoreVoiceInbox = () => {
    const ownerId = getUser()?.id;
    if (!ownerId || initialisedUserId !== ownerId) return;
    void Promise.all([subscribeInbox(ownerId), refreshHistory()]);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restoreVoiceInbox();
  });
  window.addEventListener("focus", restoreVoiceInbox);
  window.addEventListener("beforeunload", () => {
    if (!activeCall) return;
    for (const track of activeCall.localStream?.getTracks() || []) track.stop();
    activeCall.peerConnection?.close();
  });
  renderRingtoneList();
  void loadRingtoneLibrary();

  return {
    initialize,
    shutdown,
    startCall,
    refreshHistory,
    resumeIncomingCall,
    handlePushCallAction,
    syncIncomingCalls: () => {
      const ownerId = getUser()?.id;
      return ownerId ? syncPendingIncomingCalls(ownerId) : Promise.resolve();
    }
  };
}
