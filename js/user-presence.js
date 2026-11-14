import { supabase } from "./supabaseClient.js";

export function formatActivity(lastSeen, now = new Date()) {
  const date = new Date(lastSeen || NaN);
  if (!Number.isFinite(date.getTime())) return "Не в сети";
  const minutes = Math.max(0, Math.floor((now - date) / 60000));
  if (minutes < 5) return "Был недавно";
  if (minutes < 60) {
    const mod100 = minutes % 100;
    const mod10 = minutes % 10;
    const unit = mod100 >= 11 && mod100 <= 14 ? "минут" : mod10 === 1 ? "минуту" : mod10 >= 2 && mod10 <= 4 ? "минуты" : "минут";
    return `Был ${minutes} ${unit} назад`;
  }
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date >= today) return `Был сегодня в ${time}`;
  if (date >= yesterday) return `Был вчера в ${time}`;
  return `Был ${date.toLocaleDateString("ru-RU")} в ${time}`;
}

// One private topic per observed user. Only that user can publish Presence;
// several devices share a topic, but each has a distinct Presence key.
export function createUserPresence() {
  let owner = null;
  let generation = 0;
  let settingsChannel = null;
  let timer = null;
  let refreshTimer = null;
  let refreshing = false;
  let pending = false;
  let ownVisible = false;
  let observer = null;
  const rows = new Map();
  const channels = new Map();
  const connected = new Set();
  const deviceKey = crypto.randomUUID();
  const toggle = document.getElementById("show-online-status");

  function ids() {
    return new Set([owner, ...Array.from(document.querySelectorAll("[data-profile-avatar-user-id]:not(.message-avatar)"))
      .filter(element => !element.closest?.("[hidden]"))
      .map(element => element.dataset.profileAvatarUserId)].filter(Boolean));
  }

  function paint() {
    for (const element of document.querySelectorAll("[data-profile-avatar-user-id]")) {
      if (element.classList.contains("message-avatar")) continue;
      const id = element.dataset.profileAvatarUserId;
      const row = rows.get(id);
      const online = Boolean(owner && navigator.onLine && row?.show_online_status && connected.has(id));
      element.classList.toggle("is-user-online", online);
      const text = online ? "В сети" : formatActivity(row?.show_online_status ? row.last_seen_at : null);
      // Keep status outside the avatar: avatar renderers replace its children.
      const target = element.parentElement.querySelector(".contact-details, .friend-username, .conversation-row__title, #chat-title") ||
        (element.classList.contains("public-profile__avatar") ? document.getElementById("public-profile-name") : element.parentElement);
      let label = target.querySelector(".user-activity");
      if (!label) {
        label = document.createElement("small");
        label.className = "user-activity";
        target.append(label);
      }
      if (label.textContent !== text) label.textContent = text;
      label.classList.toggle("is-online", online);
      if (element.title !== text) element.title = text;
    }
  }

  function schedule() {
    if (!owner || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 300);
  }

  async function heartbeat() {
    if (!owner || !ownVisible || !navigator.onLine) return;
    const { error } = await supabase.rpc("gadlink_touch_activity");
    if (error) console.warn("GadLink activity heartbeat:", error);
  }

  function join(id) {
    if (channels.has(id)) return;
    const version = generation;
    const channel = supabase.channel(`user-presence:${id}`, {
      config: { private: true, presence: { key: deviceKey } }
    });
    channels.set(id, channel);
    channel.on("presence", { event: "sync" }, () => {
      if (version !== generation || channels.get(id) !== channel) return;
      const wasOnline = connected.has(id);
      const online = Object.values(channel.presenceState()).some(entries => entries.length > 0);
      if (online) connected.add(id);
      else connected.delete(id);
      if (wasOnline && !online) schedule();
      paint();
    }).subscribe(status => {
      if (version !== generation || channels.get(id) !== channel) return;
      if (status === "SUBSCRIBED") {
        if (id === owner && ownVisible) {
          void channel.track({ connected: true });
          void heartbeat();
        }
        schedule();
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        connected.delete(id);
        paint();
      }
    });
  }

  async function refresh() {
    if (!owner || !navigator.onLine) return;
    if (refreshing) { pending = true; return; }
    refreshing = true;
    const version = generation;
    try {
      const wanted = ids();
      const list = [...wanted];
      const result = [];
      for (let offset = 0; offset < list.length; offset += 100) {
        const { data, error } = await supabase.from("user_activity")
          .select("user_id,show_online_status,last_seen_at").in("user_id", list.slice(offset, offset + 100));
        if (error) throw error;
        result.push(...(data || []));
      }
      if (generation !== version) return;
      rows.clear();
      for (const row of result) rows.set(row.user_id, row);
      ownVisible = Boolean(rows.get(owner)?.show_online_status);
      if (toggle && !toggle.disabled) toggle.checked = ownVisible;
      for (const [id, channel] of channels) {
        if (!wanted.has(id) || !rows.get(id)?.show_online_status) {
          channels.delete(id);
          connected.delete(id);
          await supabase.removeChannel(channel);
        }
      }
      if (generation !== version) return;
      for (const id of wanted) if (rows.get(id)?.show_online_status) join(id);
      paint();
    } catch (error) {
      console.warn("GadLink activity sync (apply user_activity_realtime.sql):", error);
    } finally {
      refreshing = false;
      if (pending) { pending = false; schedule(); }
    }
  }

  const resume = () => {
    if (!owner || document.hidden) return;
    schedule();
    void heartbeat();
  };
  const offline = () => { connected.clear(); paint(); };
  const pagehide = () => {
    // Best effort only; server Presence detects an abrupt disconnect as well.
    const channel = channels.get(owner);
    if (channel) void channel.untrack();
    void heartbeat();
  };
  const pageshow = () => {
    const channel = channels.get(owner);
    if (channel && ownVisible) void channel.track({ connected: true });
    resume();
  };

  toggle?.addEventListener("change", async () => {
    if (!owner) return;
    toggle.disabled = true;
    const visible = toggle.checked;
    try {
      const { error } = await supabase.rpc("gadlink_set_activity_visibility", { visible });
      if (error) throw error;
      ownVisible = visible;
      await refresh();
    } catch (error) {
      toggle.checked = ownVisible;
      window.dispatchEvent(new CustomEvent("gadlink:activity-error", { detail: { message: `Не удалось сохранить сетевой статус: ${error.message}` } }));
    } finally { toggle.disabled = false; }
  });

  return {
    async start(userId) {
      if (owner === userId) { schedule(); return; }
      const transition = generation + 1;
      await this.stop();
      if (generation !== transition) return;
      owner = userId;
      const version = generation;
      const { error } = await supabase.rpc("gadlink_touch_activity");
      if (version !== generation) return;
      if (error) console.warn("GadLink activity initialization:", error);
      settingsChannel = supabase.channel(`activity-settings-${owner}`, { config: { private: true } })
        .on("postgres_changes", { event: "*", schema: "public", table: "user_activity" }, payload => {
          const row = payload.new;
          if (row?.user_id && !ids().has(row.user_id)) return;
          const previous = rows.get(row?.user_id);
          if (row?.user_id) rows.set(row.user_id, row);
          if (row?.user_id && !row.show_online_status) {
            rows.set(row.user_id, row);
            connected.delete(row.user_id);
            if (row.user_id === owner) {
              ownVisible = false;
              const channel = channels.get(owner);
              if (channel) void channel.untrack();
            }
            paint();
          }
          if (row?.user_id && previous?.show_online_status === row.show_online_status) {
            paint();
            return;
          }
          schedule();
        })
        .subscribe(status => { if (status === "SUBSCRIBED") schedule(); });
      observer = new MutationObserver(mutations => {
        if (mutations.some(m => m.type === "attributes" || [...m.addedNodes, ...m.removedNodes]
          .some(node => node.nodeType === 1 && (node.matches?.("[data-profile-avatar-user-id]") || node.querySelector?.("[data-profile-avatar-user-id]"))))) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-profile-avatar-user-id", "hidden"] });
      window.addEventListener("online", resume);
      window.addEventListener("gadlink:resync", resume);
      window.addEventListener("offline", offline);
      window.addEventListener("pageshow", pageshow);
      window.addEventListener("pagehide", pagehide);
      document.addEventListener("visibilitychange", resume);
      timer = setInterval(() => { paint(); void heartbeat(); }, 60000);
      await refresh();
    },
    async stop() {
      generation += 1;
      owner = null;
      ownVisible = false;
      clearInterval(timer); timer = null;
      clearTimeout(refreshTimer); refreshTimer = null;
      observer?.disconnect(); observer = null;
      window.removeEventListener("online", resume);
      window.removeEventListener("gadlink:resync", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", resume);
      const oldChannels = [...channels.values(), settingsChannel].filter(Boolean);
      channels.clear(); settingsChannel = null;
      rows.clear(); connected.clear();
      document.querySelectorAll(".user-activity").forEach(element => element.remove());
      document.querySelectorAll(".is-user-online").forEach(element => element.classList.remove("is-user-online"));
      await Promise.all(oldChannels.map(channel => supabase.removeChannel(channel)));
    }
  };
}
