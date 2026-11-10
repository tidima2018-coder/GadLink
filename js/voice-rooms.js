const MAX_ROOM_PARTICIPANTS = 4;
const ICE_SERVER_CACHE_MS = 50 * 60_000;
const ICE_CONFIG_WAIT_MS = 3_500;

export function createVoiceRooms({ supabase, getUser, getProfile }) {
  const byId = (id) => document.getElementById(id);
  const panel = byId("channel-voice-panel");
  const status = byId("voice-room-status");
  const count = byId("voice-room-count");
  const participants = byId("voice-room-participants");
  const audioContainer = byId("voice-room-audio");
  const joinButton = byId("voice-room-join");
  const micButton = byId("voice-room-mic");
  const outputButton = byId("voice-room-output");
  const leaveButton = byId("voice-room-leave");
  let room = null;
  let iceServerCache = null;
  let iceServerCacheUntil = 0;
  let iceServerRequest = null;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function getIceServers() {
    const stunServers = [{ urls: "stun:stun.l.google.com:19302" }];
    if (iceServerCache && Date.now() < iceServerCacheUntil) return Promise.resolve(iceServerCache);
    if (!iceServerRequest) {
      iceServerRequest = (async () => {
        let timeout;
        try {
          const result = await Promise.race([
            supabase.functions.invoke("voice-ice-config", { method: "GET" }),
            new Promise((resolve) => {
              timeout = setTimeout(() => resolve({ error: new Error("TURN configuration timeout") }), 8_000);
            })
          ]).finally(() => clearTimeout(timeout));
          if (result.error) throw result.error;
          const turnServers = (Array.isArray(result.data?.iceServers) ? result.data.iceServers : [])
            .filter((server) => {
              const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
              return urls.some((url) => typeof url === "string" && /^turns?:/i.test(url)) &&
                typeof server.username === "string" && typeof server.credential === "string";
            });
          if (!turnServers.length) throw new Error("TURN-сервер не настроен.");
          iceServerCache = [...stunServers, ...turnServers];
          iceServerCacheUntil = Date.now() + ICE_SERVER_CACHE_MS;
          return iceServerCache;
        } catch (error) {
          console.warn("GadLink voice room TURN configuration:", error);
          return stunServers;
        } finally {
          iceServerRequest = null;
        }
      })();
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(stunServers), ICE_CONFIG_WAIT_MS);
      iceServerRequest.then((servers) => {
        clearTimeout(timeout);
        resolve(servers);
      });
    });
  }

  function renderControls(ctx) {
    const connecting = ctx.joining;
    joinButton.hidden = ctx.joined;
    joinButton.disabled = connecting || !ctx.channelReady || ctx.remoteParticipants.length >= MAX_ROOM_PARTICIPANTS;
    joinButton.textContent = connecting ? "Подключаемся…" : "Подключиться";
    micButton.hidden = !ctx.joined;
    micButton.disabled = !ctx.joined;
    micButton.textContent = ctx.micMuted ? "Включить микрофон" : "Выключить микрофон";
    micButton.setAttribute("aria-pressed", String(ctx.micMuted));
    outputButton.hidden = !ctx.joined;
    outputButton.textContent = ctx.outputMuted ? "Включить звук" : "Выключить звук";
    outputButton.setAttribute("aria-pressed", String(ctx.outputMuted));
    leaveButton.hidden = !ctx.joined && !connecting;
  }

  function renderParticipants(ctx) {
    if (room !== ctx) return;
    const roster = [...ctx.remoteParticipants];
    if (ctx.joined || ctx.joining) {
      roster.push({
        key: ctx.sessionKey,
        userId: ctx.user.id,
        username: ctx.profile.username,
        avatarUrl: ctx.profile.avatarUrl,
        muted: ctx.micMuted,
        speaking: ctx.selfSpeaking,
        joinedAt: ctx.joinedAt,
        local: true
      });
    }
    roster.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.key.localeCompare(b.key));
    count.textContent = `${roster.length} из ${MAX_ROOM_PARTICIPANTS} участников`;
    participants.replaceChildren();

    if (!roster.length) {
      const empty = document.createElement("p");
      empty.className = "voice-room__empty";
      empty.textContent = "В канале пока никого нет.";
      participants.append(empty);
    }

    for (const member of roster) {
      const row = document.createElement("div");
      row.className = `voice-room__participant${member.speaking ? " is-speaking" : ""}`;
      row.setAttribute("role", "listitem");
      const avatar = document.createElement("span");
      avatar.className = "voice-room__avatar";
      if (member.avatarUrl && /^https?:\/\//i.test(member.avatarUrl)) {
        const image = document.createElement("img");
        image.src = member.avatarUrl;
        image.alt = "";
        image.loading = "lazy";
        avatar.append(image);
      } else {
        avatar.textContent = (member.username || "?").trim().slice(0, 1).toLocaleUpperCase() || "?";
      }
      const name = document.createElement("strong");
      name.textContent = `${member.username || "Пользователь"}${member.local ? " (вы)" : ""}`;
      const state = document.createElement("span");
      state.className = `voice-room__member-state${member.muted ? " is-muted" : member.speaking ? " is-speaking" : ""}`;
      state.setAttribute("aria-label", member.muted ? "Микрофон выключен" : member.speaking ? "Говорит" : "На связи");
      state.title = member.muted ? "Микрофон выключен" : member.speaking ? "Говорит" : "На связи";
      state.innerHTML = member.muted
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V6a3 3 0 0 0-5.8-1M5 10v2a7 7 0 0 0 11.9 5M19 10v2a7 7 0 0 1-.4 2.3M12 19v3m-4 0h8M3 3l18 18"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v3a3 3 0 0 0 6 0V6a3 3 0 0 0-6 0v1M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
      row.append(avatar, name, state);
      participants.append(row);
    }
    renderControls(ctx);
  }

  function rosterFromChannel(ctx) {
    const entries = ctx.channel?.presenceState?.() || {};
    const roster = new Map();
    for (const [presenceKey, presences] of Object.entries(entries)) {
      if (presenceKey === ctx.sessionKey) continue;
      const presence = presences?.[presences.length - 1];
      if (!presence?.sessionKey || !presence?.userId || presence.sessionKey !== presenceKey) continue;
      roster.set(presenceKey, {
        key: presenceKey,
        userId: presence.userId,
        username: presence.username || "Пользователь",
        avatarUrl: presence.avatarUrl || null,
        muted: Boolean(presence.muted),
        speaking: Boolean(ctx.remoteSpeaking.get(presenceKey)),
        joinedAt: presence.joinedAt || ""
      });
    }
    return roster;
  }

  function memberOrder(a, b) {
    return a.joinedAt.localeCompare(b.joinedAt) || a.key.localeCompare(b.key);
  }

  async function syncRoster(ctx) {
    if (room !== ctx || ctx.closed) return;
    let roster = rosterFromChannel(ctx);
    const self = {
      key: ctx.sessionKey,
      userId: ctx.user.id,
      username: ctx.profile.username,
      avatarUrl: ctx.profile.avatarUrl,
      muted: ctx.micMuted,
      speaking: ctx.selfSpeaking,
      joinedAt: ctx.joinedAt
    };
    const shouldCountSelf = ctx.joined || ctx.joining;
    const everyone = [...roster.values(), ...(shouldCountSelf ? [self] : [])].sort(memberOrder);
    if (everyone.length > MAX_ROOM_PARTICIPANTS) {
      const allowed = new Set(everyone.slice(0, MAX_ROOM_PARTICIPANTS).map((member) => member.key));
      if (shouldCountSelf && !allowed.has(ctx.sessionKey)) {
        void leaveVoice(ctx, "В канале уже 4 участника.");
        return;
      }
      roster = new Map([...roster].filter(([key]) => allowed.has(key)));
    }

    ctx.remoteParticipants = [...roster.values()].sort(memberOrder);
    const remoteKeys = new Set(ctx.remoteParticipants.map((member) => member.key));
    for (const [key, peer] of ctx.peers) {
      if (!remoteKeys.has(key)) removePeer(ctx, key, peer);
    }
    renderParticipants(ctx);

    if (ctx.joined) {
      for (const member of ctx.remoteParticipants) {
        void ensurePeer(ctx, member).catch((error) => {
          if (room === ctx) setStatus(`Не удалось подключить ${member.username}: ${error.message}`, true);
        });
      }
      const queued = ctx.pendingSignals.splice(0);
      for (const signal of queued) {
        if (remoteKeys.has(signal.from)) queueSignal(ctx, signal);
        else ctx.pendingSignals.push(signal);
      }
    }
  }

  async function broadcast(ctx, event, payload) {
    if (room !== ctx || !ctx.channelReady) return;
    const result = await ctx.channel.send({
      type: "broadcast",
      event,
      payload: { roomId: ctx.channelId, from: ctx.sessionKey, ...payload }
    });
    if (result !== "ok") throw new Error(`Realtime broadcast: ${result}`);
  }

  async function sendSignal(ctx, target, type, data = {}) {
    await broadcast(ctx, "voice-signal", { to: target, type, ...data });
  }

  function ensurePeer(ctx, member) {
    if (room !== ctx || !ctx.joined) return Promise.resolve(null);
    const existing = ctx.peers.get(member.key);
    if (existing) return Promise.resolve(existing);
    const pending = ctx.peerSetup.get(member.key);
    if (pending) return pending;
    const setup = ensurePeerConnection(ctx, member);
    ctx.peerSetup.set(member.key, setup);
    const clearSetup = () => {
      if (ctx.peerSetup.get(member.key) === setup) ctx.peerSetup.delete(member.key);
    };
    setup.then(clearSetup, clearSetup);
    return setup;
  }

  async function ensurePeerConnection(ctx, member) {
    if (room !== ctx || !ctx.joined) return null;

    const iceServers = await ctx.iceServersPromise;
    if (room !== ctx || !ctx.joined) return null;

    const peerConnection = new RTCPeerConnection({ iceServers });
    const peer = {
      key: member.key,
      member,
      peerConnection,
      pendingCandidates: [],
      signalQueue: Promise.resolve(),
      offerStarted: false,
      restartCount: 0,
      remoteStream: null,
      audio: null,
      meter: null,
      disconnectTimer: null
    };
    ctx.peers.set(member.key, peer);
    const queuedSignals = ctx.pendingSignals.filter((signal) => signal.from === member.key);
    ctx.pendingSignals = ctx.pendingSignals.filter((signal) => signal.from !== member.key);
    for (const signal of queuedSignals) queueSignal(ctx, signal);
    for (const track of ctx.localStream.getAudioTracks()) peerConnection.addTrack(track, ctx.localStream);

    peerConnection.onicecandidate = (event) => {
      if (room !== ctx || ctx.peers.get(member.key) !== peer) return;
      void sendSignal(ctx, member.key, "ice", event.candidate
        ? { candidate: event.candidate.toJSON() }
        : { complete: true });
    };
    peerConnection.ontrack = (event) => {
      if (room !== ctx || ctx.peers.get(member.key) !== peer) return;
      const stream = event.streams?.[0] || peer.remoteStream || new MediaStream();
      if (!event.streams?.[0] && !stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      peer.remoteStream = stream;
      if (!peer.audio) {
        peer.audio = document.createElement("audio");
        peer.audio.autoplay = true;
        peer.audio.playsInline = true;
        peer.audio.dataset.session = member.key;
        audioContainer.append(peer.audio);
      }
      peer.audio.srcObject = stream;
      peer.audio.muted = ctx.outputMuted;
      void peer.audio.play().catch((error) => {
        console.warn("GadLink voice room autoplay:", error);
        ctx.outputMuted = true;
        for (const remotePeer of ctx.peers.values()) {
          if (remotePeer.audio) remotePeer.audio.muted = true;
        }
        renderControls(ctx);
        setStatus("Нажмите «Включить звук», чтобы услышать участников.");
      });
      attachMeter(ctx, peer.key, stream, peer);
    };
    peerConnection.onconnectionstatechange = () => {
      if (room !== ctx || ctx.peers.get(member.key) !== peer) return;
      const connectionState = peerConnection.connectionState;
      if (connectionState === "connected") {
        clearTimeout(peer.disconnectTimer);
        peer.restartCount = 0;
      } else if (connectionState === "disconnected") {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => {
          if (room === ctx && peerConnection.connectionState === "disconnected") {
            void restartPeer(ctx, peer);
          }
        }, 5_000);
      } else if (connectionState === "failed") {
        void restartPeer(ctx, peer);
      }
    };

    if (ctx.sessionKey.localeCompare(member.key) < 0) {
      void makeOffer(ctx, peer);
    }
    return Promise.resolve(peer);
  }

  async function makeOffer(ctx, peer, iceRestart = false) {
    if (room !== ctx || ctx.peers.get(peer.key) !== peer || peer.offerStarted) return;
    peer.offerStarted = true;
    try {
      const offer = await peer.peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.peerConnection.setLocalDescription(offer);
      await sendSignal(ctx, peer.key, "offer", { description: peer.peerConnection.localDescription });
    } catch (error) {
      if (room === ctx) setStatus(`Не удалось начать соединение с ${peer.member.username}: ${error.message}`, true);
    } finally {
      peer.offerStarted = false;
    }
  }

  async function restartPeer(ctx, peer) {
    if (room !== ctx || ctx.peers.get(peer.key) !== peer || peer.restartCount >= 2) return;
    if (ctx.sessionKey.localeCompare(peer.key) > 0) {
      setStatus(`Переподключаем ${peer.member.username}…`);
      return;
    }
    peer.restartCount += 1;
    setStatus(`Переподключаем ${peer.member.username}…`);
    peer.peerConnection.restartIce();
    await makeOffer(ctx, peer, true);
  }

  function queueSignal(ctx, signal) {
    const peer = ctx.peers.get(signal.from);
    if (!peer) {
      if (ctx.pendingSignals.length < 100) ctx.pendingSignals.push(signal);
      return;
    }
    peer.signalQueue = peer.signalQueue
      .then(() => handleSignal(ctx, peer, signal))
      .catch((error) => {
        if (room === ctx) setStatus(`Ошибка голосового соединения: ${error.message}`, true);
      });
  }

  async function flushCandidates(peer) {
    if (!peer.peerConnection.remoteDescription) return;
    const candidates = peer.pendingCandidates.splice(0);
    for (const candidate of candidates) await peer.peerConnection.addIceCandidate(candidate);
  }

  async function handleSignal(ctx, peer, signal) {
    if (room !== ctx || signal.roomId !== ctx.channelId || signal.to !== ctx.sessionKey ||
        signal.from !== peer.key || !ctx.joined) return;
    const pc = peer.peerConnection;
    if (signal.type === "offer") {
      if (pc.signalingState === "have-local-offer") {
        if (ctx.sessionKey.localeCompare(peer.key) < 0) return;
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription(signal.description);
      await flushCandidates(peer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(ctx, peer.key, "answer", { description: pc.localDescription });
    } else if (signal.type === "answer") {
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription(signal.description);
      await flushCandidates(peer);
    } else if (signal.type === "ice" && (signal.candidate || signal.complete)) {
      const candidate = signal.candidate ? new RTCIceCandidate(signal.candidate) : null;
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else peer.pendingCandidates.push(candidate);
    }
  }

  function attachMeter(ctx, key, stream, peer = null) {
    if (!ctx.audioContext || ctx.meters.has(key)) return;
    try {
      const source = ctx.audioContext.createMediaStreamSource(stream);
      const analyser = ctx.audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const meter = { source, analyser, peer };
      ctx.meters.set(key, meter);
      if (peer) peer.meter = meter;
    } catch (error) {
      console.warn("GadLink voice room meter:", error);
    }
  }

  function updateMeterStates(ctx) {
    if (room !== ctx) return;
    const samples = new Float32Array(512);
    let needsRender = false;
    for (const [key, meter] of ctx.meters) {
      meter.analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const level = Math.sqrt(energy / samples.length);
      const speaking = level > 0.035 && (key !== ctx.sessionKey || !ctx.micMuted);
      if (key === ctx.sessionKey) {
        if (ctx.selfSpeaking !== speaking) {
          ctx.selfSpeaking = speaking;
          needsRender = true;
          void broadcast(ctx, "voice-state", { speaking }).catch((error) => {
            console.warn("GadLink voice room state:", error);
          });
        }
      } else {
        const member = ctx.remoteParticipants.find((participant) => participant.key === key);
        if (member && member.speaking !== speaking) {
          ctx.remoteSpeaking.set(key, speaking);
          member.speaking = speaking;
          needsRender = true;
        }
      }
    }
    if (needsRender) renderParticipants(ctx);
  }

  function setUpAudioContext(ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      ctx.audioContext = new AudioContextClass();
      void ctx.audioContext.resume();
      attachMeter(ctx, ctx.sessionKey, ctx.localStream);
      ctx.meterTimer = setInterval(() => updateMeterStates(ctx), 140);
    } catch (error) {
      console.warn("GadLink voice room audio context:", error);
    }
  }

  function removePeer(ctx, key, peer) {
    clearTimeout(peer.disconnectTimer);
    peer.peerConnection.onicecandidate = null;
    peer.peerConnection.ontrack = null;
    peer.peerConnection.onconnectionstatechange = null;
    peer.peerConnection.close();
    if (peer.audio) {
      peer.audio.pause();
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    if (peer.meter) {
      peer.meter.source.disconnect();
      ctx.meters.delete(key);
    }
    ctx.remoteSpeaking.delete(key);
    ctx.peers.delete(key);
  }

  function stopLocalMedia(ctx) {
    clearInterval(ctx.meterTimer);
    ctx.meterTimer = null;
    for (const meter of ctx.meters.values()) meter.source.disconnect();
    ctx.meters.clear();
    for (const [key, peer] of [...ctx.peers]) removePeer(ctx, key, peer);
    for (const track of ctx.localStream?.getTracks() || []) track.stop();
    ctx.localStream = null;
    ctx.audioContext?.close().catch(() => {});
    ctx.audioContext = null;
    ctx.selfSpeaking = false;
    ctx.remoteSpeaking.clear();
    audioContainer.replaceChildren();
  }

  async function leaveVoice(ctx = room, message = "Вы отключились от голосового канала.") {
    if (!ctx || room !== ctx || (!ctx.joined && !ctx.joining)) return;
    const wasTracked = ctx.joined || ctx.joining;
    ctx.joined = false;
    ctx.joining = false;
    stopLocalMedia(ctx);
    if (wasTracked) {
      try { await ctx.channel.untrack(); } catch (error) { console.warn("GadLink voice room untrack:", error); }
    }
    if (room !== ctx) return;
    ctx.micMuted = false;
    ctx.outputMuted = false;
    setStatus(message);
    await syncRoster(ctx);
  }

  async function teardownRoom(ctx = room) {
    if (!ctx || room !== ctx) return;
    ctx.closed = true;
    room = null;
    if (ctx.joined || ctx.joining) {
      try { void ctx.channel.untrack().catch((error) => console.warn("GadLink voice room untrack:", error)); }
      catch (error) { console.warn("GadLink voice room untrack:", error); }
    }
    stopLocalMedia(ctx);
    if (ctx.channel) {
      void supabase.removeChannel(ctx.channel).catch((error) => {
        console.error("GadLink voice room remove channel:", error);
      });
    }
    panel.hidden = true;
    participants.replaceChildren();
    audioContainer.replaceChildren();
    count.textContent = `0 из ${MAX_ROOM_PARTICIPANTS} участников`;
    status.textContent = "";
    status.classList.remove("is-error");
    joinButton.hidden = false;
    joinButton.disabled = true;
    joinButton.textContent = "Подключиться";
    micButton.hidden = true;
    outputButton.hidden = true;
    leaveButton.hidden = true;
  }

  async function watch(channelInfo) {
    if (room?.channelId === channelInfo.id) {
      panel.hidden = false;
      return;
    }
    await teardownRoom();
    const currentUser = getUser();
    if (!currentUser?.id) {
      panel.hidden = false;
      setStatus("Войдите в аккаунт, чтобы подключиться.", true);
      joinButton.disabled = true;
      return;
    }
    const profile = getProfile() || {};
    const sessionKey = `${currentUser.id}:${crypto.randomUUID()}`;
    const ctx = {
      channelId: channelInfo.id,
      channel: null,
      channelReady: false,
      sessionKey,
      user: currentUser,
      profile: {
        username: profile.username?.trim() || "Пользователь",
        avatarUrl: profile.avatarUrl || null
      },
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      joinedAt: new Date().toISOString(),
      joined: false,
      joining: false,
      micMuted: false,
      outputMuted: false,
      selfSpeaking: false,
      remoteSpeaking: new Map(),
      remoteParticipants: [],
      peers: new Map(),
      peerSetup: new Map(),
      pendingSignals: [],
      meters: new Map(),
      audioContext: null,
      meterTimer: null,
      closed: false
    };
    room = ctx;
    panel.hidden = false;
    setStatus("Подключаем голосовой канал…");
    renderControls(ctx);
    ctx.iceServersPromise = getIceServers().then((servers) => {
      if (room === ctx) ctx.iceServers = servers;
      return servers;
    });

    ctx.channel = supabase.channel(`voice-room:${channelInfo.id}`, {
      config: {
        private: true,
        presence: { key: sessionKey },
        broadcast: { ack: false }
      }
    });
    ctx.channel
      .on("presence", { event: "sync" }, () => { void syncRoster(ctx); })
      .on("presence", { event: "join" }, () => { void syncRoster(ctx); })
      .on("presence", { event: "leave" }, () => { void syncRoster(ctx); })
      .on("broadcast", { event: "voice-signal" }, ({ payload }) => {
        if (room !== ctx || payload?.roomId !== ctx.channelId || payload.to !== ctx.sessionKey || !payload.from) return;
        if (!ctx.remoteParticipants.some((member) => member.key === payload.from)) {
          if (ctx.pendingSignals.length < 100) ctx.pendingSignals.push(payload);
          return;
        }
        queueSignal(ctx, payload);
      })
      .on("broadcast", { event: "voice-state" }, ({ payload }) => {
        if (room !== ctx || payload?.roomId !== ctx.channelId || !payload.from) return;
        const member = ctx.remoteParticipants.find((participant) => participant.key === payload.from);
        if (!member) return;
        member.speaking = Boolean(payload.speaking);
        ctx.remoteSpeaking.set(payload.from, member.speaking);
        renderParticipants(ctx);
      })
      .subscribe((state, error) => {
        if (room !== ctx) return;
        if (state === "SUBSCRIBED") {
          ctx.channelReady = true;
          setStatus("Канал готов. Подключитесь, чтобы начать говорить.");
          void syncRoster(ctx);
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(state)) {
          ctx.channelReady = false;
          setStatus(`Не удалось подключить голосовой канал: ${error?.message || state}. Проверьте supabase/voice_rooms.sql и доступ к серверу.`, true);
          renderControls(ctx);
        }
      });
  }

  async function join() {
    const ctx = room;
    if (!ctx || !ctx.channelReady || ctx.joined || ctx.joining) return;
    if (!getUser()?.id || getUser().id !== ctx.user.id) {
      setStatus("Сессия изменилась. Откройте канал снова.", true);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus("Для голосового канала нужен HTTPS и браузер с поддержкой микрофона.", true);
      return;
    }
    if (ctx.remoteParticipants.length >= MAX_ROOM_PARTICIPANTS) {
      setStatus("В канале уже 4 участника.", true);
      return;
    }
    ctx.joining = true;
    renderControls(ctx);
    setStatus("Запрашиваем доступ к микрофону…");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (room !== ctx || !ctx.joining || !ctx.channelReady) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      ctx.localStream = stream;
      ctx.micMuted = false;
      ctx.outputMuted = false;
      ctx.joinedAt = new Date().toISOString();
      setUpAudioContext(ctx);
      ctx.joined = true;
      const result = await ctx.channel.track({
        sessionKey: ctx.sessionKey,
        userId: ctx.user.id,
        username: ctx.profile.username,
        avatarUrl: ctx.profile.avatarUrl,
        muted: false,
        speaking: false,
        joinedAt: ctx.joinedAt
      });
      if (room !== ctx) return;
      if (result !== "ok") throw new Error(`Не удалось объявить присутствие: ${result}`);
      ctx.joining = false;
      setStatus("Вы подключены. Микрофон включён.");
      renderControls(ctx);
      await syncRoster(ctx);
    } catch (error) {
      if (stream && room !== ctx) stream.getTracks().forEach((track) => track.stop());
      if (room === ctx && ctx.joining) {
        ctx.joined = false;
        ctx.joining = false;
        stopLocalMedia(ctx);
        setStatus(error.name === "NotAllowedError"
          ? "Разрешите доступ к микрофону в настройках браузера."
          : `Не удалось подключиться: ${error.message}`, true);
        renderControls(ctx);
      }
    }
  }

  async function toggleMic() {
    const ctx = room;
    if (!ctx?.joined || !ctx.localStream) return;
    ctx.micMuted = !ctx.micMuted;
    for (const track of ctx.localStream.getAudioTracks()) track.enabled = !ctx.micMuted;
    if (ctx.micMuted) ctx.selfSpeaking = false;
    renderParticipants(ctx);
    try {
      await ctx.channel.track({
        sessionKey: ctx.sessionKey,
        userId: ctx.user.id,
        username: ctx.profile.username,
        avatarUrl: ctx.profile.avatarUrl,
        muted: ctx.micMuted,
        speaking: ctx.selfSpeaking,
        joinedAt: ctx.joinedAt
      });
      if (room === ctx) setStatus(ctx.micMuted ? "Микрофон выключен." : "Микрофон включён.");
    } catch (error) {
      if (room === ctx) setStatus(`Не удалось обновить состояние микрофона: ${error.message}`, true);
    }
  }

  function toggleOutput() {
    const ctx = room;
    if (!ctx?.joined) return;
    ctx.outputMuted = !ctx.outputMuted;
    for (const peer of ctx.peers.values()) {
      if (peer.audio) {
        peer.audio.muted = ctx.outputMuted;
        if (!ctx.outputMuted) void peer.audio.play().catch((error) => {
          console.warn("GadLink voice room audio resume:", error);
          setStatus("Браузер не разрешил воспроизвести звук. Нажмите кнопку ещё раз.", true);
        });
      }
    }
    renderControls(ctx);
  }

  joinButton.addEventListener("click", () => void join());
  micButton.addEventListener("click", () => void toggleMic());
  outputButton.addEventListener("click", toggleOutput);
  leaveButton.addEventListener("click", () => void leaveVoice());
  window.addEventListener("pagehide", () => { void teardownRoom(); });

  return {
    watch,
    close: () => teardownRoom(),
    shutdown: () => teardownRoom()
  };
}
