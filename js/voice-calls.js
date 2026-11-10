const RING_TIMEOUT_MS = 45_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_GRACE_MS = 12_000;

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

export function createVoiceCallController({ supabase, getUser, getPublicProfileNames }) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("voice-call-dialog");
  const remoteAudio = byId("voice-call-remote-audio");
  let inboxChannel = null;
  let activeCall = null;
  let initialisedUserId = null;
  let historyRequest = 0;
  let historyTimer = null;

  function setStatus(message) {
    byId("calls-status").textContent = message;
  }

  function setCallStatus(message) {
    byId("voice-call-status").textContent = message;
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
    byId("voice-call-timer").hidden = true;
    byId("voice-call-mute").disabled = incoming;
    byId("voice-call-mute").textContent = "Выключить микрофон";
    byId("voice-call-mute").setAttribute("aria-pressed", "false");
    dialog.hidden = false;
  }

  function hideCallDialog() {
    dialog.hidden = true;
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    byId("voice-call-timer").hidden = true;
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

    const history = byId("call-history");
    history.replaceChildren();
    if (!calls.length) {
      const empty = document.createElement("p");
      empty.className = "call-history-empty";
      empty.textContent = "Здесь появится история звонков.";
      history.append(empty);
      setStatus("");
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
    setStatus("");
  }

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

  async function sendCallSignal(callId, fromId, toId, type) {
    const channel = supabase.channel(`voice-call:${callId}`, {
      config: { private: true, broadcast: { ack: true } }
    });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Realtime channel timeout")), 8000);
        channel.subscribe((status, error) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timeout);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(error || new Error(`Realtime: ${status}`));
          }
        });
      });
      const result = await channel.send({
        type: "broadcast",
        event: "call-signal",
        payload: { type, callId, from: fromId, to: toId }
      });
      if (result !== "ok") throw new Error(`Realtime broadcast: ${result}`);
    } finally {
      await supabase.removeChannel(channel);
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
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    const { data, error } = await supabase.functions.invoke("voice-ice-config", { method: "GET" });
    if (error) {
      console.warn("GadLink TURN configuration is unavailable; using STUN only.", error);
      return iceServers;
    }
    if (!Array.isArray(data?.iceServers)) {
      console.warn("GadLink TURN configuration returned no ICE servers.");
      return iceServers;
    }
    return [...iceServers, ...data.iceServers];
  }

  async function createPeerConnection() {
    if (!activeCall) throw new Error("Звонок уже завершён.");
    if (activeCall.peerConnection) return activeCall.peerConnection;

    const iceServers = await getIceServers();
    if (!activeCall) throw new Error("Звонок завершён до подключения.");
    const peerConnection = new RTCPeerConnection({ iceServers });
    activeCall.peerConnection = peerConnection;
    activeCall.pendingCandidates = [];

    for (const track of activeCall.localStream.getAudioTracks()) {
      peerConnection.addTrack(track, activeCall.localStream);
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
      if (event.candidate && activeCall?.peerConnection === peerConnection) {
        void broadcast("ice", { candidate: event.candidate.toJSON() });
      }
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (activeCall?.peerConnection !== peerConnection) return;
      const state = peerConnection.iceConnectionState;
      if (state === "connected" || state === "completed") {
        markConnected();
      } else if (state === "disconnected") {
        setCallStatus("Связь прервалась, пытаемся восстановить…");
        clearTimeout(activeCall.disconnectTimer);
        activeCall.disconnectTimer = setTimeout(() => {
          if (peerConnection.iceConnectionState === "disconnected") {
            void failCall("Соединение потеряно.");
          }
        }, RECONNECT_GRACE_MS);
      } else if (state === "failed") {
        void failCall("Не удалось установить голосовое соединение. Проверьте сеть или TURN.");
      }
    };
    return peerConnection;
  }

  async function flushCandidates() {
    if (!activeCall?.peerConnection?.remoteDescription) return;
    const pending = activeCall.pendingCandidates.splice(0);
    for (const candidate of pending) {
      await activeCall.peerConnection.addIceCandidate(candidate);
    }
  }

  async function createOffer() {
    if (!activeCall?.outgoing || activeCall.peerConnection?.localDescription) return;
    try {
      setCallStatus("Соединение…");
      const peerConnection = await createPeerConnection();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await broadcast("offer", { description: peerConnection.localDescription });
    } catch (error) {
      console.error("GadLink voice call offer:", error);
      await failCall(`Не удалось начать соединение: ${error.message}`);
    }
  }

  async function handleSignal(payload) {
    if (!activeCall || payload?.callId !== activeCall.id ||
        payload.from !== activeCall.peerId || payload.to !== getUser()?.id) return;

    try {
      if (payload.type === "accepted" && activeCall.outgoing) {
        activeCall.accepted = true;
        if (activeCall.timeout) clearTimeout(activeCall.timeout);
        activeCall.connectionTimer = setTimeout(() => {
          void failCall("Не удалось установить соединение за отведённое время.");
        }, 30_000);
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
      } else if (payload.type === "ice" && payload.candidate && activeCall.peerConnection) {
        const candidate = new RTCIceCandidate(payload.candidate);
        if (activeCall.peerConnection.remoteDescription) {
          await activeCall.peerConnection.addIceCandidate(candidate);
        } else {
          activeCall.pendingCandidates.push(candidate);
        }
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
      }
    } catch (error) {
      console.error("GadLink voice call signal:", error);
      await failCall(`Ошибка соединения: ${error.message}`);
    }
  }

  async function joinCallChannel() {
    if (!activeCall) throw new Error("Звонок уже завершён.");
    const call = activeCall;
    const channel = supabase.channel(`voice-call:${call.id}`, {
      config: { private: true, broadcast: { ack: true } }
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
  }

  function startHeartbeat() {
    if (!activeCall) return;
    clearInterval(activeCall.heartbeat);
    activeCall.heartbeat = setInterval(async () => {
      if (!activeCall) return;
      try {
        await transition("heartbeat");
      } catch (error) {
        console.error("GadLink call heartbeat:", error);
        await failCall("Сервер потерял связь со звонком.");
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
    activeCall.timer = setInterval(() => {
      if (!activeCall?.connectedAt) return;
      byId("voice-call-timer").textContent = formatDuration((Date.now() - activeCall.connectedAt) / 1000);
    }, 1000);
    startHeartbeat();
    void refreshHistory();
  }

  async function releaseCallResources() {
    const call = activeCall;
    if (!call) return;
    activeCall = null;
    clearTimeout(call.timeout);
    clearTimeout(call.connectionTimer);
    clearTimeout(call.disconnectTimer);
    clearInterval(call.timer);
    clearInterval(call.heartbeat);
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
      try {
        await supabase.removeChannel(call.channel);
      } catch (error) {
        console.error("GadLink remove call channel:", error);
      }
    }
    hideCallDialog();
    await refreshHistory();
  }

  async function finishCall(message, sendTransition = true, action = null) {
    const call = activeCall;
    if (!call) return;
    if (message) setStatus(message);
    if (sendTransition) {
      try {
        await transition(action || (call.accepted ? "end" : call.outgoing ? "cancel" : "reject"));
      } catch (error) {
        console.error("GadLink finish call:", error);
        setStatus(`Не удалось обновить историю звонка: ${error.message}`);
      }
    }
    await releaseCallResources();
  }

  async function failCall(message) {
    if (!activeCall) return;
    setStatus(message);
    try {
      await broadcast("failed");
      await transition("failed");
    } catch (error) {
      console.error("GadLink fail call:", error);
    }
    await releaseCallResources();
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
    if (activeCall) {
      setStatus("Сначала завершите текущий звонок.");
      return;
    }
    if (!isSecureAudioContext()) {
      setStatus("Для звонков нужен HTTPS и браузер с поддержкой микрофона.");
      return;
    }

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      console.error("GadLink microphone access:", error);
      setStatus(error.name === "NotAllowedError"
        ? "Разрешите доступ к микрофону в настройках браузера."
        : `Не удалось получить доступ к микрофону: ${error.message}`);
      return;
    }

    if (activeCall || getUser()?.id !== owner.id) {
      for (const track of localStream.getTracks()) track.stop();
      return;
    }
    const profile = await getPeerProfile(peerId);
    const peer = {
      username: peerName || profile.username || "Пользователь",
      avatar_url: avatarUrl || profile.avatar_url
    };
    try {
      const { data: callId, error } = await supabase.rpc("gadlink_start_voice_call", {
        peer_user_id: peerId
      });
      if (error) throw error;
      if (!isUuid(callId)) throw new Error("Сервер не вернул идентификатор звонка.");

      activeCall = {
        id: callId,
        peerId,
        username: peer.username || "Пользователь",
        avatarUrl: peer.avatar_url || null,
        outgoing: true,
        accepted: false,
        connected: false,
        localStream,
        peerConnection: null,
        pendingCandidates: []
      };
      showCallDialog(activeCall);
      setCallStatus("Звоним…");
      activeCall.timeout = setTimeout(() => {
        if (activeCall?.id !== callId) return;
        setCallStatus("Нет ответа.");
        void broadcast("missed").finally(() => finishCall(null, true, "missed"));
      }, RING_TIMEOUT_MS);
      await joinCallChannel();
    } catch (error) {
      console.error("GadLink start call:", error);
      for (const track of localStream.getTracks()) track.stop();
      if (activeCall) {
        try {
          await transition("failed");
        } catch (transitionError) {
          console.error("GadLink failed call cleanup:", transitionError);
        }
        await releaseCallResources();
      }
      setStatus(`Не удалось начать звонок: ${error.message}`);
    }
  }

  async function receiveIncomingCall(row) {
    const owner = getUser();
    if (!owner?.id || !isUuid(row?.id) || row.callee_id !== owner.id ||
        !isUuid(row.caller_id) || row.status !== "ringing") return;
    if (activeCall) {
      try {
        const { error } = await supabase.rpc("gadlink_transition_voice_call", {
          target_call_id: row.id,
          call_action: "reject"
        });
        if (error) throw error;
        await sendCallSignal(row.id, owner.id, row.caller_id, "busy");
      } catch (error) {
        console.error("GadLink busy call rejection:", error);
      }
      return;
    }

    const profile = await getPeerProfile(row.caller_id);
    if (getUser()?.id !== owner.id || activeCall) return;
    activeCall = {
      id: row.id,
      peerId: row.caller_id,
      username: profile.username || "Пользователь",
      avatarUrl: profile.avatar_url || null,
      outgoing: false,
      accepted: false,
      connected: false,
      localStream: null,
      peerConnection: null,
      pendingCandidates: []
    };
    showCallDialog(activeCall, true);
    setCallStatus("Входящий звонок…");
    activeCall.timeout = setTimeout(() => {
      if (activeCall?.id !== row.id) return;
      setCallStatus("Пропущенный звонок.");
      void finishCall(null, true, "missed");
    }, Math.max(0, RING_TIMEOUT_MS - (Date.now() - new Date(row.created_at).getTime())));
    try {
      await joinCallChannel();
    } catch (error) {
      console.error("GadLink incoming call channel:", error);
      await failCall(`Не удалось подключиться к звонку: ${error.message}`);
    }
  }

  async function acceptCall() {
    if (!activeCall || activeCall.outgoing || activeCall.accepted) return;
    if (!isSecureAudioContext()) {
      setCallStatus("Для звонка нужен HTTPS и доступ к микрофону.");
      return;
    }

    const acceptButton = byId("voice-call-accept");
    acceptButton.disabled = true;
    try {
      activeCall.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await createPeerConnection();
      await transition("answer");
      activeCall.accepted = true;
      clearTimeout(activeCall.timeout);
      activeCall.connectionTimer = setTimeout(() => {
        void failCall("Не удалось установить соединение за отведённое время.");
      }, 30_000);
      byId("voice-call-incoming-actions").hidden = true;
      byId("voice-call-active-actions").hidden = false;
      byId("voice-call-mute").disabled = false;
      setCallStatus("Соединение…");
      await broadcast("accepted");
    } catch (error) {
      console.error("GadLink accept call:", error);
      setCallStatus(error.name === "NotAllowedError"
        ? "Разрешите доступ к микрофону, чтобы принять звонок."
        : `Не удалось принять звонок: ${error.message}`);
      if (activeCall?.localStream) {
        for (const track of activeCall.localStream.getTracks()) track.stop();
        activeCall.localStream = null;
      }
      if (activeCall?.peerConnection) {
        activeCall.peerConnection.close();
        activeCall.peerConnection = null;
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

  async function subscribeInbox(ownerId) {
    if (inboxChannel) await supabase.removeChannel(inboxChannel);
    const channel = supabase.channel(`voice-inbox:${ownerId}`, { config: { private: true } });
    inboxChannel = channel;
    channel
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "voice_calls",
        filter: `callee_id=eq.${ownerId}`
      }, ({ new: row }) => void receiveIncomingCall(row))
    await new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        setStatus("Не удалось подключить приём звонков. Проверьте Supabase Realtime.");
        resolve(false);
      }, 10_000);
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED" && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !settled) {
          settled = true;
          clearTimeout(timeout);
          console.error("GadLink voice inbox Realtime:", error || status);
          setStatus("Не удалось подключить приём звонков. Проверьте Supabase Realtime.");
          resolve(false);
        }
      });
    });

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

  async function initialize() {
    const owner = getUser();
    if (!owner?.id || initialisedUserId === owner.id) return;
    await shutdown();
    initialisedUserId = owner.id;
    await Promise.all([subscribeInbox(owner.id), refreshHistory()]);
    clearInterval(historyTimer);
    historyTimer = setInterval(() => void refreshHistory(), 30_000);
  }

  async function shutdown() {
    historyRequest += 1;
    initialisedUserId = null;
    clearInterval(historyTimer);
    historyTimer = null;
    if (inboxChannel) {
      await supabase.removeChannel(inboxChannel);
      inboxChannel = null;
    }
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
  byId("voice-call-mute").addEventListener("click", toggleMute);
  byId("voice-call-volume").addEventListener("input", (event) => {
    remoteAudio.volume = Number(event.currentTarget.value);
  });
  byId("voice-call-dialog").addEventListener("click", () => {
    void remoteAudio.play().catch((error) => console.warn("GadLink audio playback:", error));
  });
  window.addEventListener("online", () => {
    if (getUser()?.id && initialisedUserId === getUser().id) {
      void Promise.all([subscribeInbox(getUser().id), refreshHistory()]);
    }
  });
  window.addEventListener("beforeunload", () => {
    if (!activeCall) return;
    for (const track of activeCall.localStream?.getTracks() || []) track.stop();
    activeCall.peerConnection?.close();
  });

  return { initialize, shutdown, startCall, refreshHistory };
}
