import "./js/friends-ui.js";
import { supabase } from "./js/supabaseClient.js";
import { getPublicProfileNames } from "./js/friends.js";
import { createReelsFeed } from "./js/reels.js";
import { createVoiceCallController } from "./js/voice-calls.js";
import {
  getCurrentUser,
  getAuthErrorMessage,
  getResendWait,
  registerWithEmail,
  signInWithEmail,
  signOutUser,
  resendConfirmationEmail
} from "./js/auth.js";

let user = null;
let currentConversation = null;
let currentUsername = "Пользователь";
let currentChannel = null;
let chatSubscription = null;
let conversationMembershipSubscription = null;
let channelSubscription = null;
let feedPostsChannel = null;
let sendingMessage = false;
let conversationSyncTimer = null;
let conversationLoadVersion = 0;
const messageSyncCursors = new Map();
const directConversationByPeer = new Map();
let resendTimer = null;
let conversationFilter = "all";
let reelsController = null;
let menuCloseTimer = null;
let menuAnimationFrame = null;
let friendDialogCloseTimer = null;
let groupDialogCloseTimer = null;
let avatarPreviewUrl = null;
let currentAbout = "";
let currentAvatarUrl = null;

const byId = (id) => document.getElementById(id);
const voiceCallsController = createVoiceCallController({
  supabase,
  getUser: () => user,
  getPublicProfileNames
});
const setStatus = (id, message) => {
  const status = byId(id);
  if (id === "auth-status") status.classList.remove("auth-status--error");
  status.textContent = message;
};

function setMenuOpen(isOpen, restoreFocus = true) {
  const menu = byId("profile-menu");
  const toggle = byId("menu-toggle");
  clearTimeout(menuCloseTimer);
  if (menuAnimationFrame !== null) cancelAnimationFrame(menuAnimationFrame);
  menuAnimationFrame = null;
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-label", isOpen ? "Закрыть меню профиля" : "Открыть меню профиля");
  toggle.classList.toggle("is-open", isOpen);

  if (isOpen) {
    menu.hidden = false;
    menu.removeAttribute("inert");
    menuAnimationFrame = requestAnimationFrame(() => {
      menu.classList.add("is-open");
      menuAnimationFrame = null;
    });
    byId("profile-menu").querySelector('[data-section="profile-section"]').focus();
    return;
  }

  menu.classList.remove("is-open");
  menu.setAttribute("inert", "");
  if (restoreFocus) toggle.focus();
  menuCloseTimer = setTimeout(() => {
    menu.hidden = true;
    menu.removeAttribute("inert");
    menuCloseTimer = null;
  }, 220);
}

function setFriendDialogOpen(isOpen, restoreFocus = true) {
  const dialog = byId("friend-add-dialog");
  clearTimeout(friendDialogCloseTimer);
  if (isOpen) {
    dialog.hidden = false;
    dialog.removeAttribute("inert");
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    byId("friend-search").focus();
    return;
  }

  dialog.classList.remove("is-open");
  dialog.setAttribute("inert", "");
  if (restoreFocus) byId("add-contact-button").focus();
  friendDialogCloseTimer = setTimeout(() => {
    dialog.hidden = true;
    dialog.removeAttribute("inert");
    friendDialogCloseTimer = null;
  }, 200);
}

function setCreateMenuOpen(isOpen) {
  const menu = byId("create-menu");
  const toggle = byId("add-contact-button");
  menu.hidden = !isOpen;
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute("aria-label", isOpen ? "Закрыть меню создания" : "Создать группу, канал или контакт");
  if (isOpen) menu.querySelector('[role="menuitem"]')?.focus();
}

function setCreateGroupDialogOpen(isOpen, restoreFocus = true) {
  const dialog = byId("create-group-dialog");
  clearTimeout(groupDialogCloseTimer);
  if (isOpen) {
    dialog.hidden = false;
    dialog.removeAttribute("inert");
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    byId("conversation-users").focus();
    return;
  }

  dialog.classList.remove("is-open");
  dialog.setAttribute("inert", "");
  if (restoreFocus) byId("add-contact-button").focus();
  groupDialogCloseTimer = setTimeout(() => {
    dialog.hidden = true;
    dialog.removeAttribute("inert");
    groupDialogCloseTimer = null;
  }, 200);
}

function updateMenuAvatar(url) {
  const preview = byId("menu-avatar-preview");
  preview.hidden = !url;
  if (url) preview.src = url;
  byId("menu-avatar-placeholder").hidden = Boolean(url);
}

function showAuthError(message) {
  const status = byId("auth-status");
  status.classList.remove("auth-status--error");
  status.textContent = message;
  void status.offsetWidth;
  status.classList.add("auth-status--error");
}

function showApp(isSignedIn) {
  byId("auth-section").hidden = isSignedIn;
  byId("app").hidden = !isSignedIn;
  byId("menu-toggle").hidden = !isSignedIn;
  byId("add-contact-button").hidden = !isSignedIn;
  byId("sign-out").hidden = !isSignedIn;
  if (!isSignedIn) {
    setMenuOpen(false, false);
    setFriendDialogOpen(false, false);
    setCreateMenuOpen(false);
    setCreateGroupDialogOpen(false, false);
  }
}

function updateResendButton() {
  const button = byId("resend-confirmation");
  if (button.hidden) {
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = null;
    return;
  }

  const email = byId("auth-email").value.trim();
  const wait = getResendWait(email);
  button.disabled = !byId("auth-email").validity.valid || wait > 0;
  button.textContent = wait
    ? `Отправить письмо повторно (${wait} с)`
    : "Отправить письмо повторно";
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = wait ? setInterval(updateResendButton, 1000) : null;
}

function showResendButton(show) {
  byId("resend-confirmation").hidden = !show;
  updateResendButton();
}

function addText(parent, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text || "";
  parent.append(element);
  return element;
}

async function loadPublicNames(profileIds, statusId) {
  const ids = [...new Set(profileIds.filter(Boolean))];
  try {
    return await getPublicProfileNames(ids);
  } catch (error) {
    console.error("GadLink profile names:", error);
    setStatus(statusId, `Не удалось загрузить имена пользователей: ${error.message}`);
    return new Map(ids.map((id) => [id, {
      id,
      username: "Пользователь",
      avatar_url: null
    }]));
  }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function addMedia(parent, value) {
  const url = safeUrl(value);
  if (!url) return;
  const isVideo = /\.(mp4|webm|ogg)(\?.*)?$/i.test(url);
  const media = document.createElement(isVideo ? "video" : "img");
  media.src = url;
  media.setAttribute("controls", "");
  media.setAttribute("alt", "медиа");
  media.setAttribute("referrerpolicy", "no-referrer");
  parent.append(media);
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("ru-RU") : "";
}

async function saveProfile({ username, about, avatarUrl, avatarFile }) {
  if (avatarFile) {
    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif"
    };
    const extension = extensions[avatarFile.type];
    if (!extension) throw new Error("Используйте изображение JPG, PNG, WebP или GIF.");

    const path = `${user.id}/${Date.now()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, avatarFile, { contentType: avatarFile.type });
    if (uploadError) throw uploadError;
    avatarUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  }

  const profile = { id: user.id, username, about, avatar_url: avatarUrl };
  const { error } = await supabase.from("profiles").upsert(profile);
  if (error) throw error;
  return profile;
}

function syncProfileFields(profile) {
  currentUsername = profile.username?.trim() || "Пользователь";
  currentAbout = profile.about;
  currentAvatarUrl = profile.avatar_url;
  byId("profile-username").value = profile.username;
  byId("profile-about").value = profile.about;
  byId("profile-avatar").value = profile.avatar_url || "";
  byId("menu-profile-username").value = profile.username;
  byId("profile-menu-name").textContent = currentUsername;
  updateMenuAvatar(profile.avatar_url);
  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
  avatarPreviewUrl = null;
  byId("menu-avatar-file").value = "";
}

async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  byId("profile-username").value = data?.username || "";
  currentUsername = data?.username?.trim() || user.user_metadata?.username?.trim() || "Пользователь";
  byId("profile-about").value = data?.about || "";
  byId("profile-avatar").value = data?.avatar_url || "";
  byId("menu-profile-username").value = currentUsername;
  currentAbout = data?.about || "";
  currentAvatarUrl = data?.avatar_url || null;
  byId("profile-menu-name").textContent = currentUsername;
  byId("profile-menu-email").textContent = user.email || "";
  updateMenuAvatar(currentAvatarUrl);
}

async function loadPosts() {
  const { data, error } = await supabase
    .from("posts")
    .select("id,user_id,content,media_url,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  const container = byId("posts");
  const namesById = await loadPublicNames((data || []).map((post) => post.user_id), "feed-status");
  container.replaceChildren();
  for (const post of data || []) {
    const item = document.createElement("article");
    item.className = "item";
    addText(item, "p", namesById.get(post.user_id)?.username || "Пользователь");
    addText(item, "p", post.content);
    addMedia(item, post.media_url);
    addText(item, "small", formatTime(post.created_at));
    container.append(item);
  }
}

async function loadConversations() {
  if (!user?.id) return [];
  const ownerId = user.id;
  const loadVersion = ++conversationLoadVersion;
  const { data: memberships, error } = await supabase
    .from("conversation_members")
    .select("conversation_id")
    .eq("user_id", ownerId);
  if (error) throw error;
  if (user?.id !== ownerId || loadVersion !== conversationLoadVersion) return [];

  const ids = [...new Set((memberships || [])
    .map((item) => item.conversation_id)
    .filter(isUuid))];
  const list = byId("conversation-list");
  list.replaceChildren();
  if (!ids.length) {
    directConversationByPeer.clear();
    applyConversationFilters();
    return [];
  }

  const { data: conversations, error: conversationError } = await supabase
    .from("conversations")
    .select("id,name,is_group")
    .in("id", ids);
  if (conversationError) throw conversationError;
  if (user?.id !== ownerId || loadVersion !== conversationLoadVersion) return [];

  const { data: participants, error: participantsError } = await supabase
    .from("conversation_members")
    .select("conversation_id,user_id")
    .in("conversation_id", ids);
  if (participantsError) throw participantsError;
  if (user?.id !== ownerId || loadVersion !== conversationLoadVersion) return [];
  const peerIds = [...new Set((participants || []).map((row) => row.user_id).filter((id) => id !== user.id))];
  const namesByUserId = await loadPublicNames(peerIds, "chat-status");
  if (user?.id !== ownerId || loadVersion !== conversationLoadVersion) return [];

  directConversationByPeer.clear();
  for (const conversation of conversations || []) {
    if (!conversation.is_group) {
      const peers = (participants || [])
        .filter((row) => row.conversation_id === conversation.id && row.user_id !== ownerId)
        .map((row) => row.user_id);
      if (peers.length === 1) directConversationByPeer.set(peers[0], conversation.id);
    }

    const item = document.createElement("li");
    item.className = "conversation-row";
    item.dataset.type = conversation.is_group ? "group" : "personal";
    const button = document.createElement("button");
    button.type = "button";
    const peers = (participants || [])
      .filter((row) => row.conversation_id === conversation.id && row.user_id !== user.id)
      .map((row) => namesByUserId.get(row.user_id)?.username || "Пользователь");
    const displayName = conversation.name || (peers.length ? peers.join(", ") : "Пользователь");
    button.textContent = displayName;
    button.addEventListener("click", () => openConversation({ ...conversation, name: displayName }));
    item.append(button);
    list.append(item);
  }
  applyConversationFilters();
  return conversations || [];
}

function applyConversationFilters() {
  const query = (byId("conversation-search")?.value || "").trim().toLocaleLowerCase();
  const rows = [...(byId("conversation-list")?.querySelectorAll(".conversation-row") || [])];
  let visibleCount = 0;
  for (const row of rows) {
    const matchesFilter = conversationFilter === "all" || row.dataset.type === conversationFilter;
    const matchesSearch = row.textContent.toLocaleLowerCase().includes(query);
    row.hidden = !matchesFilter || !matchesSearch;
    if (!row.hidden) visibleCount += 1;
  }
  const count = byId("conversation-count");
  if (count) count.textContent = String(rows.length);
  const empty = byId("conversation-empty");
  if (empty) empty.hidden = visibleCount > 0;
}

function hasRenderedMessage(container, id) {
  return [...container.querySelectorAll("[data-message-id]")].some((item) => item.dataset.messageId === String(id));
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function getDirectConversationId(rpcResult) {
  return isUuid(rpcResult) ? rpcResult : null;
}

function updateMessageSyncCursor(conversationId, createdAt) {
  if (!isUuid(conversationId) || !createdAt) return;
  const current = messageSyncCursors.get(conversationId);
  if (!current || createdAt > current) messageSyncCursors.set(conversationId, createdAt);
}

async function loadConversationHistory(conversationId, catchUp = false) {
  const ownerId = user?.id;
  if (!isUuid(conversationId) || !ownerId) return false;

  const cursor = catchUp ? messageSyncCursors.get(conversationId) : null;
  const messages = [];
  if (cursor) {
    let offset = 0;
    const pageSize = 500;
    while (true) {
      const { data, error } = await supabase
        .from("messages")
        .select("id,user_id,content,created_at")
        .eq("conversation_id", conversationId)
        .gte("created_at", cursor)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (user?.id !== ownerId || currentConversation?.id !== conversationId) return false;
      messages.push(...(data || []));
      if ((data || []).length < pageSize) break;
      offset += pageSize;
    }
  } else {
    const { data, error } = await supabase
      .from("messages")
      .select("id,user_id,content,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(100);
    if (error) throw error;
    if (user?.id !== ownerId || currentConversation?.id !== conversationId) return false;
    messages.push(...(data || []).reverse());
  }

  if (!messages.length) return true;
  const namesById = await loadPublicNames(messages.map((message) => message.user_id), "chat-status");
  if (user?.id !== ownerId || currentConversation?.id !== conversationId) return false;
  for (const message of messages) {
    message.profiles = namesById.get(message.user_id);
    addMessage(byId("messages"), message);
    updateMessageSyncCursor(conversationId, message.created_at);
  }
  return true;
}

function addMessage(container, message) {
  if (message.id && hasRenderedMessage(container, message.id)) {
    const existing = [...container.querySelectorAll("[data-message-id]")]
      .find((item) => item.dataset.messageId === String(message.id));
    const author = existing?.querySelector(".message-author");
    if (author) {
      author.textContent = message.profiles?.username || (message.user_id === user.id ? currentUsername : "Пользователь");
    }
    return;
  }
  const item = document.createElement("article");
  item.className = `message-item ${message.user_id === user.id ? "is-own" : "is-other"}`;
  if (message.id) item.dataset.messageId = message.id;
  const author = addText(item, "strong", message.profiles?.username || (message.user_id === user.id ? currentUsername : "Пользователь"));
  author.className = "message-author";
  addText(item, "p", message.content).className = "message-content";
  const time = document.createElement("time");
  const createdAt = message.created_at ? new Date(message.created_at) : new Date();
  time.dateTime = createdAt.toISOString();
  time.textContent = createdAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  time.className = "message-time";
  item.append(time);
  container.append(item);
  container.scrollTop = container.scrollHeight;
}

async function openConversation(conversation) {
  const conversationId = conversation?.id;
  if (!isUuid(conversationId)) {
    currentConversation = null;
    console.error("GadLink open conversation: invalid conversation id", conversation);
    setStatus("chat-status", "Не удалось открыть чат: сервер не вернул корректный UUID диалога.");
    return false;
  }
  currentConversation = { ...conversation, id: conversationId };
  const peerId = currentConversation.is_group
    ? null
    : [...directConversationByPeer.entries()].find(([, id]) => id === conversationId)?.[0];
  const callButton = byId("chat-call-button");
  callButton.hidden = !isUuid(peerId) || peerId === user?.id;
  callButton.dataset.userId = peerId || "";
  callButton.setAttribute("aria-label", `Позвонить ${currentConversation.name || "контакту"}`);
  callButton.title = `Позвонить ${currentConversation.name || "контакту"}`;
  byId("chat-view").hidden = false;
  byId("chat-title").textContent = currentConversation.name || "Личный чат";
  byId("messages").replaceChildren();

  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  if (currentConversation?.id !== conversationId) return false;
  chatSubscription = supabase
    .channel(`messages-${conversationId}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversationId}`
    }, async (payload) => {
      const message = payload.new;
      const namesById = await loadPublicNames([message.user_id], "chat-status");
      if (currentConversation?.id !== conversationId) return;
      message.profiles = namesById.get(message.user_id);
      addMessage(byId("messages"), message);
    })
    .subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        void loadConversationHistory(conversationId, true).catch((historyError) => {
          console.error("GadLink message reconnect sync:", historyError);
          setStatus("chat-status", `Не удалось синхронизировать сообщения: ${historyError.message}`);
        });
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("GadLink messages Realtime:", error || status);
        setStatus("chat-status", "Не удалось подключить обновления чата. Проверьте Realtime в Supabase.");
      }
    });

  try {
    const loaded = await loadConversationHistory(conversationId);
    if (!loaded) return false;
  } catch (error) {
    console.error("GadLink messages history:", error);
    setStatus("chat-status", `Не удалось загрузить историю чата: ${error.message}`);
    return false;
  }
  byId("chat-view").scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}

function scheduleChatSync() {
  if (!user?.id) return;
  clearTimeout(conversationSyncTimer);
  conversationSyncTimer = setTimeout(async () => {
    conversationSyncTimer = null;
    try {
      await loadConversations();
      const conversationId = currentConversation?.id;
      if (isUuid(conversationId)) await loadConversationHistory(conversationId, true);
    } catch (error) {
      console.error("GadLink chat sync:", error);
      setStatus("chat-status", `Не удалось синхронизировать чаты: ${error.message}`);
    }
  }, 200);
}

function subscribeToConversationMemberships() {
  if (!user?.id) return;
  if (conversationMembershipSubscription) {
    void supabase.removeChannel(conversationMembershipSubscription);
  }

  const ownerId = user.id;
  conversationMembershipSubscription = supabase
    .channel(`conversation-members-${ownerId}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "conversation_members",
      filter: `user_id=eq.${ownerId}`
    }, scheduleChatSync)
    .subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        scheduleChatSync();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("GadLink conversation membership Realtime:", error || status);
        setStatus("chat-status", "Не удалось подключить обновление списка чатов. Список обновится при возвращении на страницу.");
      }
    });
}

async function openContactChat({ userId, username }) {
  if (!user || !userId) return;
  setStatus("chat-status", "Открываем диалог…");

  try {
    const namesById = await loadPublicNames([userId], "chat-status");
    const contactName = namesById.get(userId)?.username || username || "Пользователь";
    let id = directConversationByPeer.get(userId);
    if (!id) {
      const { data: conversationId, error } = await supabase.rpc("gadlink_get_or_create_direct_conversation", { peer_user_id: userId });
      if (error) throw error;
      id = getDirectConversationId(conversationId);
      if (!id) throw new Error("Supabase не вернул корректный UUID диалога.");
    }

    document.querySelector('[data-section="chats-section"]')?.click();
    await loadConversations();
    const opened = await openConversation({ id, name: contactName, is_group: false });
    if (opened) setStatus("chat-status", `Диалог с ${contactName} открыт.`);
  } catch (error) {
    console.error("GadLink contact chat:", error);
    setStatus("chat-status", `Не удалось открыть чат: ${error.message}`);
    document.querySelector('[data-section="chats-section"]')?.click();
  }
}

window.addEventListener("gadlink:open-contact-chat", (event) => {
  void openContactChat(event.detail || {});
});

byId("chat-call-button").addEventListener("click", (event) => {
  const peerId = event.currentTarget.dataset.userId;
  if (!isUuid(peerId) || peerId === user?.id) {
    setStatus("chat-status", "Не удалось определить собеседника для звонка.");
    return;
  }
  window.dispatchEvent(new CustomEvent("gadlink:start-voice-call", {
    detail: { userId: peerId, username: currentConversation?.name || "Пользователь" }
  }));
});

async function loadServers() {
  const { data, error } = await supabase.from("servers").select("id,name").order("name");
  if (error) throw error;

  const list = byId("server-list");
  list.replaceChildren();
  for (const server of data || []) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = server.name;
    button.addEventListener("click", () => openServer(server));
    item.append(button);
    list.append(item);
  }
}

async function openServer(server) {
  byId("server-view").hidden = false;
  byId("server-title").textContent = server.name;
  byId("channel-view").hidden = true;
  const { data, error } = await supabase
    .from("text_channels")
    .select("id,name")
    .eq("server_id", server.id)
    .order("name");
  if (error) {
    setStatus("community-status", error.message);
    return;
  }

  const list = byId("channel-list");
  list.replaceChildren();
  for (const channel of data || []) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = channel.name;
    button.addEventListener("click", () => openChannel(channel));
    item.append(button);
    list.append(item);
  }
  byId("channel-form").dataset.serverId = server.id;
}

async function openChannel(channel) {
  currentChannel = channel;
  byId("channel-view").hidden = false;
  byId("channel-title").textContent = channel.name;
  byId("channel-messages").replaceChildren();

  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  const { data, error } = await supabase
    .from("channel_messages")
    .select("id,user_id,content,created_at")
    .eq("channel_id", channel.id)
    .order("created_at")
    .limit(100);
  if (error) {
    setStatus("community-status", error.message);
    return;
  }
  const namesById = await loadPublicNames((data || []).map((message) => message.user_id), "community-status");
  for (const message of data || []) {
    message.profiles = namesById.get(message.user_id);
    addMessage(byId("channel-messages"), message);
  }

  channelSubscription = supabase
    .channel(`channel-messages-${channel.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "channel_messages",
      filter: `channel_id=eq.${channel.id}`
    }, async (payload) => {
      const message = payload.new;
      const names = await loadPublicNames([message.user_id], "community-status");
      message.profiles = names.get(message.user_id);
      addMessage(byId("channel-messages"), message);
    })
    .subscribe();
}

async function loadApp() {
  if (!user || (!user.email_confirmed_at && !user.confirmed_at)) {
    showApp(false);
    throw new Error("Сначала подтвердите адрес электронной почты.");
  }
  showApp(true);
  reelsController ||= createReelsFeed({ supabase, getUser: () => user });
  await Promise.all([
    loadProfile(),
    loadPosts(),
    loadConversations().catch((error) => {
      console.error("GadLink conversations load:", error);
      setStatus("chat-status", `Не удалось загрузить список чатов: ${error.message}`);
    }),
    loadServers(),
    voiceCallsController.initialize()
  ]);
  subscribeToConversationMemberships();
  if (!feedPostsChannel) {
    feedPostsChannel = supabase
      .channel("feed-posts")
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "posts"
      }, loadPosts)
      .subscribe();
  }
}

function botAnswer(text) {
  const value = text.toLowerCase();
  if (value.includes("привет") || value.includes("здравств")) return "привет! чем могу помочь?";
  if (value.includes("время")) return `сейчас ${new Date().toLocaleTimeString("ru-RU")}`;
  if (value.includes("gadlink") || value.includes("что ты умеешь")) return "я простой бот gadlink. могу поздороваться, подсказать время или ответить на базовые вопросы.";
  if (value.includes("помощ")) return "попробуй спросить меня о времени или о том, что я умею.";
  return "пока я умею отвечать только на простые вопросы. попробуй написать «привет», «сколько времени» или «что ты умеешь».";
}

document.querySelectorAll("[data-section]").forEach((button) => {
  button.addEventListener("click", () => {
    const targetSection = button.dataset.section;
    document.querySelectorAll(".page-section").forEach((section) => {
      section.hidden = section.id !== targetSection;
    });
    document.querySelectorAll("[data-section]").forEach((item) => item.classList.toggle("is-active", item === button));
    if (targetSection === "reels-section") reelsController?.activate();
    else reelsController?.deactivate();
    if (targetSection === "calls-section") void voiceCallsController.refreshHistory();
    if (button.closest("#profile-menu")) setMenuOpen(false);
  });
});

function showCommunitiesForChannelCreation() {
  document.querySelectorAll(".page-section").forEach((section) => {
    section.hidden = section.id !== "communities-section";
  });
  document.querySelectorAll("[data-section]").forEach((item) => item.classList.remove("is-active"));
  reelsController?.deactivate();

  if (!byId("server-view").hidden && byId("channel-form").dataset.serverId) {
    setStatus("community-status", "Введите название канала для выбранного сервера.");
    byId("channel-name").focus();
    return;
  }

  const firstServer = byId("server-list").querySelector("button");
  if (firstServer) {
    setStatus("community-status", "Выберите сервер, в котором нужно создать канал.");
    firstServer.focus();
  } else {
    setStatus("community-status", "Сначала создайте сервер, затем добавьте в него канал.");
    byId("server-name").focus();
  }
}

byId("menu-toggle").addEventListener("click", () => {
  setMenuOpen(byId("menu-toggle").getAttribute("aria-expanded") !== "true");
});
document.querySelector(".profile-menu__backdrop").addEventListener("click", () => setMenuOpen(false));
byId("add-contact-button").addEventListener("click", () => {
  setCreateMenuOpen(byId("create-menu").hidden);
});
byId("create-menu").addEventListener("click", (event) => {
  const action = event.target.closest("[data-create-action]")?.dataset.createAction;
  if (!action) return;
  setCreateMenuOpen(false);

  if (action === "group") {
    document.querySelector('[data-section="chats-section"]')?.click();
    byId("conversation-form").reset();
    setStatus("group-create-status", "");
    setCreateGroupDialogOpen(true);
  } else if (action === "channel") {
    showCommunitiesForChannelCreation();
  } else if (action === "contact") {
    setFriendDialogOpen(true);
  }
});
document.addEventListener("click", (event) => {
  if (byId("create-menu").hidden) return;
  if (event.target.closest("#create-menu, #add-contact-button")) return;
  setCreateMenuOpen(false);
});
byId("friend-add-close").addEventListener("click", () => setFriendDialogOpen(false));
document.querySelector(".friend-add-dialog__backdrop").addEventListener("click", () => setFriendDialogOpen(false));
byId("create-group-close").addEventListener("click", () => setCreateGroupDialogOpen(false));
byId("create-group-dialog").querySelector(".friend-add-dialog__backdrop")
  .addEventListener("click", () => setCreateGroupDialogOpen(false));
byId("menu-avatar-file").parentElement.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    byId("menu-avatar-file").click();
  }
});
document.addEventListener("keydown", (event) => {
  if (!byId("create-group-dialog").hidden) {
    if (event.key === "Escape") {
      setCreateGroupDialogOpen(false);
      return;
    }
    if (event.key === "Tab") {
      const actions = [...byId("create-group-dialog").querySelectorAll(".friend-add-dialog__panel button:not(:disabled), .friend-add-dialog__panel input:not(:disabled)")];
      const first = actions[0];
      const last = actions[actions.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (!byId("friend-add-dialog").hidden) {
    if (event.key === "Escape") {
      setFriendDialogOpen(false);
      return;
    }
    if (event.key === "Tab") {
      const actions = [...byId("friend-add-dialog").querySelectorAll(".friend-add-dialog__panel button:not(:disabled), .friend-add-dialog__panel input:not(:disabled)")];
      const first = actions[0];
      const last = actions[actions.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (!byId("create-menu").hidden) {
    if (event.key === "Escape") {
      setCreateMenuOpen(false);
      byId("add-contact-button").focus();
    } else if (event.key === "Tab") {
      const actions = [...byId("create-menu").querySelectorAll('[role="menuitem"]')];
      const first = actions[0];
      const last = actions[actions.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        byId("add-contact-button").focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        byId("add-contact-button").focus();
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const actions = [...byId("create-menu").querySelectorAll('[role="menuitem"]')];
      const currentIndex = actions.indexOf(document.activeElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (currentIndex + direction + actions.length) % actions.length;
      event.preventDefault();
      actions[nextIndex].focus();
    }
    return;
  }
  if (byId("menu-toggle").getAttribute("aria-expanded") !== "true") return;
  if (event.key === "Escape") {
    setMenuOpen(false);
    return;
  }
  if (event.key === "Tab") {
    const actions = [...byId("profile-menu").querySelectorAll(".profile-menu__panel button:not([hidden]):not(:disabled)")];
    const first = actions[0];
    const last = actions[actions.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});


byId("conversation-search").addEventListener("input", applyConversationFilters);
window.addEventListener("online", scheduleChatSync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleChatSync();
});
document.querySelectorAll("[data-conversation-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    conversationFilter = button.dataset.conversationFilter;
    document.querySelectorAll("[data-conversation-filter]").forEach((filterButton) => {
      const selected = filterButton === button;
      filterButton.classList.toggle("selected", selected);
      filterButton.setAttribute("aria-pressed", String(selected));
    });
    applyConversationFilters();
  });
});

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = byId("auth-form").querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    user = await signInWithEmail(byId("auth-email").value.trim(), byId("auth-password").value);
    showResendButton(false);
    setStatus("auth-status", "");
    await loadApp();
  } catch (error) {
    showApp(false);
    showAuthError(getAuthErrorMessage(error));
    showResendButton(error.needsConfirmation);
  } finally {
    submitButton.disabled = false;
  }
});

byId("sign-up").addEventListener("click", async () => {
  if (!byId("auth-form").reportValidity()) return;

  const button = byId("sign-up");
  const email = byId("auth-email").value.trim();
  button.disabled = true;
  showResendButton(false);

  try {
    await registerWithEmail(email, byId("auth-password").value);
    setStatus("auth-status", "Подтвердите вашу почту");
    showResendButton(true);
  } catch (error) {
    setStatus("auth-status", getAuthErrorMessage(error));
    showResendButton(error.canResend);
  } finally {
    button.disabled = false;
  }
});

byId("resend-confirmation").addEventListener("click", async () => {
  const email = byId("auth-email").value.trim();
  if (!email || !byId("auth-email").validity.valid) {
    setStatus("auth-status", "Введите корректный адрес электронной почты.");
    return;
  }

  const button = byId("resend-confirmation");
  button.disabled = true;
  try {
    await resendConfirmationEmail(email);
    setStatus("auth-status", "Если для этого адреса требуется подтверждение, письмо будет отправлено.");
  } catch (error) {
    setStatus("auth-status", getAuthErrorMessage(error));
  } finally {
    button.disabled = false;
    updateResendButton();
  }
});

byId("auth-email").addEventListener("input", () => {
  updateResendButton();
});

byId("sign-out").addEventListener("click", async () => {
  const switchStatus = byId("account-switch-status");
  switchStatus.textContent = "";
  try {
    await signOutUser();
  } catch (error) {
    switchStatus.textContent = `Не удалось сменить аккаунт: ${error.message}`;
    return;
  }
  await voiceCallsController.shutdown();
  user = null;
  reelsController?.reset();
  currentConversation = null;
  currentChannel = null;
  conversationLoadVersion += 1;
  clearTimeout(conversationSyncTimer);
  conversationSyncTimer = null;
  messageSyncCursors.clear();
  directConversationByPeer.clear();
  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  chatSubscription = null;
  if (conversationMembershipSubscription) await supabase.removeChannel(conversationMembershipSubscription);
  conversationMembershipSubscription = null;
  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  showApp(false);
});

byId("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = byId("profile-form").querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const profile = await saveProfile({
      username: byId("profile-username").value.trim(),
      about: byId("profile-about").value.trim(),
      avatarUrl: safeUrl(byId("profile-avatar").value.trim()) || null,
      avatarFile: byId("profile-avatar-file").files[0]
    });
    syncProfileFields(profile);
    setStatus("profile-status", "Профиль сохранён.");
  } catch (error) {
    setStatus("profile-status", error.message);
  } finally {
    submitButton.disabled = false;
    byId("profile-avatar-file").value = "";
  }
});

byId("menu-avatar-file").addEventListener("change", () => {
  const file = byId("menu-avatar-file").files[0];
  if (!file) return;
  const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!supportedTypes.includes(file.type)) {
    setStatus("menu-profile-status", "Используйте изображение JPG, PNG, WebP или GIF.");
    byId("menu-avatar-file").value = "";
    return;
  }
  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
  avatarPreviewUrl = URL.createObjectURL(file);
  updateMenuAvatar(avatarPreviewUrl);
  setStatus("menu-profile-status", "Аватар выбран. Сохраните профиль, чтобы применить изменения.");
});

byId("menu-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("menu-profile-form");
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  setStatus("menu-profile-status", "Сохраняем профиль...");
  try {
    const profile = await saveProfile({
      username: byId("menu-profile-username").value.trim(),
      about: currentAbout,
      avatarUrl: currentAvatarUrl,
      avatarFile: byId("menu-avatar-file").files[0]
    });
    syncProfileFields(profile);
    setStatus("menu-profile-status", "Профиль сохранён.");
  } catch (error) {
    setStatus("menu-profile-status", `Не удалось сохранить профиль: ${error.message}`);
  } finally {
    submitButton.disabled = false;
  }
});

byId("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("password-form");
  const submitButton = form.querySelector('[type="submit"]');
  const newPassword = byId("new-password").value;
  if (newPassword !== byId("confirm-password").value) {
    setStatus("password-status", "Новые пароли не совпадают.");
    return;
  }

  submitButton.disabled = true;
  setStatus("password-status", "Обновляем пароль...");
  try {
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: byId("current-password").value
    });
    if (verifyError) throw verifyError;

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    form.reset();
    setStatus("password-status", "Пароль успешно изменён.");
  } catch (error) {
    setStatus("password-status", `Не удалось изменить пароль: ${getAuthErrorMessage(error)}`);
  } finally {
    submitButton.disabled = false;
  }
});

byId("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = byId("post-content").value.trim();
  const mediaUrl = safeUrl(byId("post-media").value.trim());
  if (!content && !mediaUrl) {
    setStatus("feed-status", "добавьте текст или ссылку на медиа.");
    return;
  }
  const { error } = await supabase.from("posts").insert({
    user_id: user.id,
    content,
    media_url: mediaUrl || null
  });
  if (error) {
    setStatus("feed-status", error.message);
    return;
  }
  byId("post-form").reset();
  setStatus("feed-status", "пост опубликован.");
  await loadPosts();
});

byId("conversation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("conversation-form");
  const submitButton = form.querySelector('button[type="submit"]');
  const usernames = [...new Set(byId("conversation-users").value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean))];
  const name = byId("conversation-name").value.trim();
  if (!name) {
    setStatus("group-create-status", "Укажите название группы.");
    return;
  }
  if (!user?.id) {
    setStatus("group-create-status", "Войдите в аккаунт, чтобы создать группу.");
    return;
  }
  submitButton.disabled = true;
  setStatus("group-create-status", "Создаём группу…");
  try {
    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("id,username")
      .in("username", usernames);
    if (profileError) throw profileError;

    const members = [...new Set([user.id, ...(profiles || []).map((profile) => profile.id)])];
    if (members.length < 2) throw new Error("Укажите ник хотя бы одного существующего пользователя.");
    if ((profiles || []).length !== usernames.length) {
      throw new Error("Некоторые ники не найдены. Проверьте написание и попробуйте снова.");
    }

    const { data: conversation, error } = await supabase
      .from("conversations")
      .insert({ name, is_group: true, created_by: user.id })
      .select("id,name,is_group")
      .single();
    if (error) throw error;

    const { error: membersError } = await supabase.from("conversation_members").insert(
      members.map((userId) => ({ conversation_id: conversation.id, user_id: userId }))
    );
    if (membersError) throw membersError;

    form.reset();
    await loadConversations();
    setCreateGroupDialogOpen(false);
    await openConversation(conversation);
    setStatus("chat-status", "Группа создана.");
  } catch (error) {
    console.error("GadLink create group:", error);
    setStatus("group-create-status", `Не удалось создать группу: ${error.message}`);
  } finally {
    submitButton.disabled = false;
  }
});

byId("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("message-form");
  const input = byId("message-content");
  const submitButton = form.querySelector('button[type="submit"]');
  if (sendingMessage) return;

  const conversationId = currentConversation?.id;
  const content = input.value.trim();
  if (!isUuid(conversationId)) {
    console.error("GadLink send message: invalid active conversation id", conversationId);
    setStatus("chat-status", "Не удалось отправить сообщение: откройте чат с корректным идентификатором.");
    return;
  }
  if (!content) return;
  if (!user?.id) {
    setStatus("chat-status", "Сессия истекла. Войдите в аккаунт снова.");
    return;
  }

  sendingMessage = true;
  submitButton.disabled = true;
  setStatus("chat-status", "Отправляем сообщение…");
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    if (!authData.user || authData.user.id !== user.id) {
      throw new Error("Сессия авторизации не совпадает с текущим пользователем. Войдите в аккаунт снова.");
    }

    const { data: savedMessage, error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: authData.user.id,
      content
    }).select("id,conversation_id,user_id,content,created_at").single();
    if (error) throw error;

    if (savedMessage.conversation_id !== conversationId || savedMessage.user_id !== authData.user.id) {
      throw new Error("Supabase вернул сообщение для другого чата или пользователя.");
    }
    if (currentConversation?.id === conversationId) {
      addMessage(byId("messages"), savedMessage);
      if (input.value.trim() === content) form.reset();

      if (content.startsWith("/ai ")) {
        addMessage(byId("messages"), {
          user_id: "gadlink-bot",
          profiles: { username: "gadlink bot" },
          content: botAnswer(content.slice(4)),
          created_at: new Date().toISOString()
        });
      }
    }
    setStatus("chat-status", "Сообщение отправлено.");
  } catch (error) {
    console.error("GadLink send message:", error);
    setStatus("chat-status", `Не удалось отправить сообщение: ${error.message || error}`);
  } finally {
    sendingMessage = false;
    submitButton.disabled = false;
  }
});

byId("server-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { data, error } = await supabase
    .from("servers")
    .insert({ name: byId("server-name").value.trim(), created_by: user.id })
    .select("id,name")
    .single();
  if (error) {
    setStatus("community-status", error.message);
    return;
  }
  byId("server-form").reset();
  setStatus("community-status", "сервер создан.");
  await loadServers();
  await openServer(data);
});

byId("channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.from("text_channels").insert({
    server_id: byId("channel-form").dataset.serverId,
    name: byId("channel-name").value.trim()
  });
  if (error) {
    setStatus("community-status", error.message);
    return;
  }
  byId("channel-form").reset();
  const { data: server } = await supabase
    .from("servers")
    .select("id,name")
    .eq("id", byId("channel-form").dataset.serverId)
    .single();
  if (server) await openServer(server);
});

byId("channel-message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentChannel) return;
  const content = byId("channel-message-content").value.trim();
  if (!content) return;
  const { error } = await supabase.from("channel_messages").insert({
    channel_id: currentChannel.id,
    user_id: user.id,
    content
  });
  if (error) {
    setStatus("community-status", error.message);
    return;
  }
  addMessage(byId("channel-messages"), {
    user_id: user.id,
    content,
    created_at: new Date().toISOString()
  });
  byId("channel-message-form").reset();
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    void voiceCallsController.shutdown();
    reelsController?.reset();
    if (chatSubscription) void supabase.removeChannel(chatSubscription);
    chatSubscription = null;
    if (conversationMembershipSubscription) void supabase.removeChannel(conversationMembershipSubscription);
    conversationMembershipSubscription = null;
    conversationLoadVersion += 1;
    clearTimeout(conversationSyncTimer);
    conversationSyncTimer = null;
    messageSyncCursors.clear();
    directConversationByPeer.clear();
    currentConversation = null;
    byId("chat-call-button").hidden = true;
    byId("chat-call-button").dataset.userId = "";
    user = null;
    byId("conversation-list").replaceChildren();
    applyConversationFilters();
    showApp(false);
  }
});

getCurrentUser().then(async (currentUser) => {
  if (!currentUser) return;
  user = currentUser;
  try {
    await loadApp();
  } catch (error) {
    showApp(false);
    setStatus("auth-status", error.message);
  }
}).catch((error) => {
  showApp(false);
  setStatus("auth-status", getAuthErrorMessage(error));
});
