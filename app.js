import "./js/friends-ui.js";
import { supabase } from "./js/supabaseClient.js";
import { getPublicProfileNames } from "./js/friends.js";
import { createReelsFeed } from "./js/reels.js?v=4";
import { createVoiceCallController } from "./js/voice-calls.js";
import { createVoiceRooms } from "./js/voice-rooms.js";
import { createPushNotifications } from "./js/push-notifications.js";
import { createChatBackgroundSettings } from "./js/chat-background.js";
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
let currentServer = null;
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
let avatarPreviewUrl = null;
let profileAvatarPreviewUrl = null;
let communityDialogOpener = null;
let serverPhotoPreviewUrl = null;
let pushSettingsOpener = null;
let pushSettingsCloseTimer = null;
const communityDialogCloseTimers = new Map();
let currentAbout = "";
let currentAvatarUrl = null;
let chatOverviewSubscription = null;
const conversationOverviewRows = new Map();
const conversationsById = new Map();
const conversationUnreadCounts = new Map();
let conversationOverviewRequestVersion = 0;
let conversationOverviewRefreshTimer = null;

const byId = (id) => document.getElementById(id);
const voiceCallsController = createVoiceCallController({
  supabase,
  getUser: () => user,
  getPublicProfileNames
});
const voiceRoomsController = createVoiceRooms({
  supabase,
  getUser: () => user,
  getProfile: () => ({ username: currentUsername, avatarUrl: currentAvatarUrl })
});
const pushController = createPushNotifications({
  supabase,
  getUser: () => user
});
const chatBackgroundController = createChatBackgroundSettings({
  getUser: () => user
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
  toggle.setAttribute("aria-label", isOpen ? "Закрыть настройки" : "Открыть настройки");
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

function setPushSettingsDialogOpen(isOpen, rememberDismissal = false) {
  const dialog = byId("push-settings-dialog");
  clearTimeout(pushSettingsCloseTimer);
  if (isOpen) {
    pushSettingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.hidden = false;
    dialog.removeAttribute("inert");
    document.body.classList.add("push-settings-open");
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    byId("push-toggle").focus();
    return;
  }
  if (rememberDismissal) pushController.dismissPrompt();
  dialog.classList.remove("is-open");
  dialog.setAttribute("inert", "");
  document.body.classList.remove("push-settings-open");
  pushSettingsCloseTimer = setTimeout(() => {
    dialog.hidden = true;
    dialog.removeAttribute("inert");
    pushSettingsCloseTimer = null;
  }, 240);
  if (pushSettingsOpener?.isConnected && !pushSettingsOpener.closest("[hidden]")) {
    pushSettingsOpener.focus();
  }
  pushSettingsOpener = null;
}

byId("push-settings-open").addEventListener("click", () => setPushSettingsDialogOpen(true));
document.querySelectorAll("[data-push-settings-close]").forEach((button) => {
  button.addEventListener("click", () => setPushSettingsDialogOpen(false, true));
});
byId("push-prompt-dismiss").addEventListener("click", () => setPushSettingsDialogOpen(false, true));
window.addEventListener("gadlink:push-enabled", () => setPushSettingsDialogOpen(false));
document.addEventListener("keydown", (event) => {
  if (!byId("push-settings-dialog").hidden && event.key === "Escape") {
    setPushSettingsDialogOpen(false, true);
  }
});

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
  toggle.setAttribute("aria-label", isOpen ? "Закрыть меню создания" : "Создать канал или добавить контакт");
  if (isOpen) menu.querySelector('[role="menuitem"]')?.focus();
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

function updateAvatarElement(avatar, profile, className) {
  avatar.className = className;
  avatar.textContent = (profile?.username || "Пользователь").trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "?";
  const avatarUrl = safeUrl(profile?.avatar_url || "");
  if (avatarUrl) {
    const image = document.createElement("img");
    image.src = avatarUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }
  return avatar;
}

function createAvatar(profile, className) {
  return updateAvatarElement(document.createElement("span"), profile, className);
}

function updateProfileAvatarPreview(value) {
  const image = byId("profile-avatar-preview-image");
  const placeholder = byId("profile-avatar-preview-placeholder");
  const avatarUrl = value?.startsWith("blob:") ? value : safeUrl(value || "");
  const username = byId("profile-username").value.trim() || currentUsername || "Пользователь";
  placeholder.textContent = username.slice(0, 1).toLocaleUpperCase("ru-RU") || "?";
  if (!avatarUrl) {
    image.hidden = true;
    image.removeAttribute("src");
    placeholder.hidden = false;
    return;
  }
  image.onload = () => {
    image.hidden = false;
    placeholder.hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    placeholder.hidden = false;
  };
  image.src = avatarUrl;
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
  updateProfileAvatarPreview(profile.avatar_url);
  byId("menu-profile-username").value = profile.username;
  byId("profile-menu-name").textContent = currentUsername;
  updateMenuAvatar(profile.avatar_url);
  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
  avatarPreviewUrl = null;
  if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
  profileAvatarPreviewUrl = null;
  byId("menu-avatar-file").value = "";
}

async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  byId("profile-username").value = data?.username || "";
  currentUsername = data?.username?.trim() || user.user_metadata?.username?.trim() || "Пользователь";
  byId("profile-about").value = data?.about || "";
  byId("profile-avatar").value = data?.avatar_url || "";
  updateProfileAvatarPreview(data?.avatar_url);
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

function updateUnreadBadge() {
  const badge = byId("chat-unread-count");
  const total = [...conversationUnreadCounts.values()]
    .reduce((sum, count) => sum + count, 0);
  badge.textContent = total > 99 ? "99+" : String(total);
  badge.hidden = total < 1;
  document.querySelector('[data-section="chats-section"]')
    ?.setAttribute("aria-label", total ? `Чаты, непрочитанных сообщений: ${total}` : "Чаты");
}

function updateConversationOverview(conversationId, overview = {}, incrementUnread = false) {
  const row = conversationOverviewRows.get(conversationId);
  if (row) {
    const preview = row.querySelector(".conversation-row__preview");
    const unread = row.querySelector(".conversation-row__unread");
    const lastMessage = overview.last_message;
    if (typeof lastMessage === "string" && lastMessage.length) {
      preview.textContent = lastMessage;
      preview.hidden = false;
    } else if (overview.last_message === null) {
      preview.textContent = "Нет сообщений";
      preview.hidden = false;
    }

    const currentCount = conversationUnreadCounts.get(conversationId) || 0;
    const nextCount = Object.hasOwn(overview, "unread_count")
      ? Math.max(0, Number(overview.unread_count) || 0)
      : incrementUnread ? currentCount + 1 : currentCount;
    conversationUnreadCounts.set(conversationId, nextCount);
    unread.textContent = nextCount > 99 ? "99+" : String(nextCount);
    unread.hidden = nextCount < 1;
  } else if (Object.hasOwn(overview, "unread_count")) {
    conversationUnreadCounts.set(
      conversationId,
      Math.max(0, Number(overview.unread_count) || 0)
    );
  } else if (incrementUnread) {
    conversationUnreadCounts.set(
      conversationId,
      (conversationUnreadCounts.get(conversationId) || 0) + 1
    );
  }
  updateUnreadBadge();
}

async function refreshConversationOverview() {
  const ownerId = user?.id;
  if (!ownerId) return;
  const requestVersion = ++conversationOverviewRequestVersion;
  const { data, error } = await supabase.rpc("gadlink_get_chat_overview");
  if (error) throw error;
  if (user?.id !== ownerId || requestVersion !== conversationOverviewRequestVersion) return;
  const currentConversationIds = new Set(
    (data || []).map((overview) => overview.conversation_id)
  );
  for (const conversationId of conversationUnreadCounts.keys()) {
    if (!currentConversationIds.has(conversationId)) {
      conversationUnreadCounts.delete(conversationId);
    }
  }
  for (const overview of data || []) {
    updateConversationOverview(overview.conversation_id, overview);
  }
  updateUnreadBadge();
}

function scheduleConversationOverviewRefresh() {
  clearTimeout(conversationOverviewRefreshTimer);
  conversationOverviewRefreshTimer = setTimeout(() => {
    conversationOverviewRefreshTimer = null;
    void refreshConversationOverview().catch((error) => {
      console.error("GadLink scheduled chat overview refresh:", error);
    });
  }, 120);
}

async function markConversationRead(conversationId) {
  if (!isUuid(conversationId) || !user?.id) return;
  const { error } = await supabase.rpc("gadlink_mark_conversation_read", {
    target_conversation_id: conversationId
  });
  if (error) {
    console.error("GadLink mark conversation read:", error);
    setStatus("chat-status", `Не удалось обновить отметку прочтения: ${error.message}`);
    return;
  }
  conversationOverviewRequestVersion += 1;
  updateConversationOverview(conversationId, { unread_count: 0 });
}

function syncActivePushConversation() {
  const chatIsVisible = isConversationVisible(currentConversation?.id);
  pushController.setActiveConversation(chatIsVisible ? currentConversation?.id : null);
}

function isConversationVisible(conversationId) {
  return Boolean(conversationId) &&
    currentConversation?.id === conversationId &&
    !byId("chats-section").hidden &&
    !byId("chat-view").hidden &&
    document.visibilityState === "visible";
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
  conversationOverviewRows.clear();
  conversationsById.clear();
  conversationUnreadCounts.clear();
  updateUnreadBadge();
  if (!ids.length) {
    directConversationByPeer.clear();
    applyConversationFilters();
    try {
      await refreshConversationOverview();
    } catch (overviewError) {
      console.error("GadLink chat overview:", overviewError);
      setStatus("chat-status", `Не удалось загрузить прочитанные сообщения: ${overviewError.message}`);
    }
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
    const conversationPeerIds = (participants || [])
      .filter((row) => row.conversation_id === conversation.id && row.user_id !== ownerId)
      .map((row) => row.user_id);
    if (!conversation.is_group) {
      if (conversationPeerIds.length === 1) {
        directConversationByPeer.set(conversationPeerIds[0], conversation.id);
      }
    }

    const item = document.createElement("li");
    item.className = "conversation-row";
    item.dataset.type = conversation.is_group ? "group" : "personal";
    const button = document.createElement("button");
    button.type = "button";
    const peers = conversationPeerIds
      .map((peerId) => namesByUserId.get(peerId)?.username || "Пользователь");
    const displayName = conversation.name || (peers.length ? peers.join(", ") : "Пользователь");
    const peerProfile = conversationPeerIds.length === 1
      ? namesByUserId.get(conversationPeerIds[0])
      : { username: conversation.is_group ? "Группа" : displayName };
    button.append(createAvatar(peerProfile, "conversation-avatar"));
    const title = document.createElement("span");
    title.className = "conversation-row__title";
    title.textContent = displayName;
    const preview = document.createElement("span");
    preview.className = "conversation-row__preview";
    preview.textContent = "Нет сообщений";
    const unread = document.createElement("span");
    unread.className = "conversation-row__unread";
    unread.hidden = true;
    button.append(title, preview, unread);
    item.dataset.conversationId = conversation.id;
    conversationsById.set(conversation.id, { ...conversation, name: displayName, peerProfile });
    conversationOverviewRows.set(conversation.id, item);
    button.addEventListener("click", () => openConversation({ ...conversation, name: displayName, peerProfile }));
    item.append(button);
    list.append(item);
  }
  applyConversationFilters();
  try {
    await refreshConversationOverview();
  } catch (overviewError) {
    console.error("GadLink chat overview:", overviewError);
    setStatus("chat-status", `Не удалось загрузить прочитанные сообщения: ${overviewError.message}`);
  }
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
    const profile = message.profiles || (message.user_id === user.id
      ? { username: currentUsername, avatar_url: currentAvatarUrl }
      : null);
    if (author) {
      author.textContent = profile?.username || "Пользователь";
    }
    const currentAvatar = existing?.querySelector(".message-avatar");
    if (currentAvatar) updateAvatarElement(currentAvatar, profile, "message-avatar");
    const content = existing?.querySelector(".message-content");
    if (content) content.textContent = message.content || "";
    return;
  }
  const item = document.createElement("article");
  item.className = `message-item ${message.user_id === user.id ? "is-own" : "is-other"}`;
  if (message.id) item.dataset.messageId = message.id;
  const profile = message.profiles || (message.user_id === user.id
    ? { username: currentUsername, avatar_url: currentAvatarUrl }
    : null);
  item.append(createAvatar(profile, "message-avatar"));
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  const author = addText(bubble, "strong", profile?.username || "Пользователь");
  author.className = "message-author";
  addText(bubble, "p", message.content).className = "message-content";
  const time = document.createElement("time");
  const createdAt = message.created_at ? new Date(message.created_at) : new Date();
  time.dateTime = createdAt.toISOString();
  time.textContent = createdAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  time.className = "message-time";
  bubble.append(time);
  item.append(bubble);
  container.append(item);
  container.scrollTop = container.scrollHeight;
}

async function openConversation(conversation) {
  const conversationId = conversation?.id;
  if (!isUuid(conversationId)) {
    currentConversation = null;
    syncActivePushConversation();
    console.error("GadLink open conversation: invalid conversation id", conversation);
    setStatus("chat-status", "Не удалось открыть чат: сервер не вернул корректный UUID диалога.");
    return false;
  }
  currentConversation = { ...conversation, id: conversationId };
  const peerId = currentConversation.is_group
    ? null
    : [...directConversationByPeer.entries()].find(([, id]) => id === conversationId)?.[0];
  updateAvatarElement(
    byId("chat-peer-avatar"),
    currentConversation.peerProfile || { username: currentConversation.name || "Группа" },
    "chat-peer-avatar"
  );
  const callButton = byId("chat-call-button");
  callButton.hidden = !isUuid(peerId) || peerId === user?.id;
  callButton.dataset.userId = peerId || "";
  callButton.setAttribute("aria-label", `Позвонить ${currentConversation.name || "контакту"}`);
  callButton.title = "Голосовой звонок";
  byId("chat-view").hidden = false;
  syncActivePushConversation();
  byId("chat-title").textContent = currentConversation.name || "Личный чат";
  byId("messages").replaceChildren();

  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  if (currentConversation?.id !== conversationId) return false;
  chatSubscription = supabase
    .channel(`messages-${conversationId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversationId}`
    }, async (payload) => {
      const message = payload.new;
      if (payload.eventType === "DELETE") {
        byId("messages").querySelector(`[data-message-id="${payload.old.id}"]`)?.remove();
        return;
      }
      const namesById = await loadPublicNames([message.user_id], "chat-status");
      if (currentConversation?.id !== conversationId) return;
      message.profiles = namesById.get(message.user_id);
      addMessage(byId("messages"), message);
      updateMessageSyncCursor(conversationId, message.created_at);
      updateConversationOverview(conversationId, { last_message: message.content }, false);
      if (message.user_id !== user?.id && !byId("chats-section").hidden &&
          !byId("chat-view").hidden &&
          document.visibilityState === "visible") {
        void markConversationRead(conversationId);
      }
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
  if (isConversationVisible(conversationId)) {
    void markConversationRead(conversationId);
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
      event: "*",
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

function subscribeToChatOverview() {
  if (!user?.id) return;
  if (chatOverviewSubscription) void supabase.removeChannel(chatOverviewSubscription);
  const ownerId = user.id;
  chatOverviewSubscription = supabase
    .channel(`chat-overview-${ownerId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "messages"
    }, (payload) => {
      const message = payload.new;
      if (payload.eventType === "DELETE" || !message?.conversation_id ||
          !conversationOverviewRows.has(message.conversation_id)) {
        if (payload.eventType === "DELETE") {
          void refreshConversationOverview().catch((error) => {
            console.error("GadLink chat overview refresh:", error);
          });
        }
        return;
      }
      const viewingConversation = isConversationVisible(message.conversation_id);
      updateConversationOverview(message.conversation_id, {
        last_message: message.content
      }, payload.eventType === "INSERT" &&
        message.user_id !== ownerId &&
        !viewingConversation);
      if (payload.eventType === "INSERT") scheduleConversationOverviewRefresh();
      if (payload.eventType === "INSERT" &&
          message.user_id !== ownerId &&
          viewingConversation) {
        void markConversationRead(message.conversation_id);
      }
    })
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "conversation_read_state",
      filter: `user_id=eq.${ownerId}`
    }, () => {
      void refreshConversationOverview().catch((error) => {
        console.error("GadLink read state Realtime:", error);
      });
    })
    .subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        void refreshConversationOverview().catch((overviewError) => {
          console.error("GadLink chat overview reconnect:", overviewError);
        });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("GadLink chat overview Realtime:", error || status);
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

function updateCommunityEmptyState(hasServers) {
  const empty = byId("community-empty");
  empty.classList.toggle("community-empty--no-servers", !hasServers);
  empty.hidden = Boolean(currentServer && hasServers);
  empty.querySelector("h3").textContent = hasServers ? "Выберите сервер" : "У вас пока нет серверов";
  empty.querySelector("p").textContent = hasServers
    ? "Выберите сервер из списка, чтобы открыть его каналы."
    : "Создайте своё пространство или присоединитесь к серверу по ссылке-приглашению.";
  empty.querySelectorAll("[data-community-action]").forEach((button) => { button.hidden = hasServers; });
}

async function loadServers() {
  const list = byId("server-list");
  try {
    let { data, error } = await supabase.from("servers")
      .select("id,name,description,server_type,is_private,avatar_path,invite_code,created_by")
      .order("name");
    let schemaWarning = "";
    if (error) {
      const missingOptionalColumns = error.code === "42703"
        || (error.code === "PGRST204" && /column/i.test(error.message));
      if (!missingOptionalColumns) throw error;
      const fallback = await supabase.from("servers").select("id,name,created_by").order("name");
      if (fallback.error) throw fallback.error;
      data = fallback.data;
      schemaWarning = "Для полного функционала серверов примените supabase/community_setup.sql.";
    }

    const membershipResult = await supabase.from("server_members")
      .select("server_id")
      .eq("user_id", user.id);
    let memberships = membershipResult.data;
    if (membershipResult.error) {
      const missingMembershipTable = membershipResult.error.code === "42P01"
        || (membershipResult.error.code === "PGRST205" && /server_members/i.test(membershipResult.error.message));
      if (!missingMembershipTable) throw membershipResult.error;
      memberships = [];
      schemaWarning = "Показаны созданные вами серверы. Для присоединения и полного функционала примените supabase/community_setup.sql.";
    }
    const memberServerIds = new Set((memberships || []).map((membership) => membership.server_id));
    const servers = (data || []).filter((server) => memberServerIds.has(server.id) || server.created_by === user.id);

    list.replaceChildren();
    for (const server of servers) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "server-list-button";
      button.dataset.serverId = server.id;
      button.setAttribute("aria-current", String(currentServer?.id === server.id));
      const avatar = document.createElement("span");
      avatar.className = "server-list-avatar";
      if (server.avatar_path) {
        const image = document.createElement("img");
        image.src = supabase.storage.from("server-avatars").getPublicUrl(server.avatar_path).data.publicUrl;
        image.alt = "";
        avatar.append(image);
      } else {
        avatar.textContent = server.name.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "С";
      }
      const copy = document.createElement("span");
      copy.className = "server-list-copy";
      const name = document.createElement("strong");
      name.textContent = server.name;
      const description = document.createElement("small");
      description.textContent = server.is_private ? "Приватный сервер" : (server.description || "Сервер");
      const arrow = document.createElement("span");
      arrow.className = "server-list-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "›";
      copy.append(name, description);
      button.append(avatar, copy, arrow);
      button.addEventListener("click", () => openServer(server));
      item.append(button);
      list.append(item);
    }

    byId("server-view").hidden = !currentServer || !servers.some((server) => server.id === currentServer.id);
    if (!servers.some((server) => server.id === currentServer?.id)) {
      currentServer = null;
      currentChannel = null;
      byId("communities-section").classList.remove("is-detail-open", "is-channel-open");
    }
    updateCommunityEmptyState(Boolean(servers.length));
    setStatus("community-status", schemaWarning);
  } catch (error) {
    console.error("GadLink servers load:", error);
    list.replaceChildren();
    currentServer = null;
    currentChannel = null;
    byId("server-view").hidden = true;
    byId("communities-section").classList.remove("is-detail-open", "is-channel-open");
    updateCommunityEmptyState(false);
    byId("community-empty").querySelector("h3").textContent = "Не удалось загрузить серверы";
    byId("community-empty").querySelector("p").textContent = "Проверьте подключение и настройки базы данных.";
    setStatus("community-status", `Не удалось загрузить серверы: ${error.message}. Проверьте схему из supabase/community_setup.sql.`);
  }
}

async function openServer(server) {
  await voiceRoomsController.close();
  currentServer = server;
  currentChannel = null;
  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  channelSubscription = null;
  updateCommunityEmptyState(true);
  byId("server-view").hidden = false;
  byId("communities-section").classList.add("is-detail-open");
  byId("communities-section").classList.remove("is-channel-open");
  byId("server-title").textContent = server.name;
  byId("server-description").textContent = server.description || "";
  byId("server-description").hidden = !server.description;
  byId("server-meta").textContent = `${server.is_private ? "Приватный сервер" : "Открытый сервер"} · ${({ friends: "Для друзей", community: "Для сообщества", study: "Для учёбы", work: "Для работы" })[server.server_type] || "Сервер"}`;
  const serverAvatar = byId("server-avatar");
  serverAvatar.replaceChildren();
  if (server.avatar_path) {
    const avatar = document.createElement("img");
    avatar.src = supabase.storage.from("server-avatars").getPublicUrl(server.avatar_path).data.publicUrl;
    avatar.alt = "";
    serverAvatar.append(avatar);
  } else {
    serverAvatar.textContent = server.name.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "С";
  }
  byId("server-invite").hidden = server.created_by !== user?.id || !server.invite_code;
  byId("channel-view").hidden = true;
  byId("channel-voice-panel").hidden = true;
  byId("channel-readonly-note").hidden = true;
  byId("channel-message-form").hidden = false;
  byId("channel-form").dataset.serverId = server.id;
  byId("channel-list").replaceChildren();
  byId("channel-empty").hidden = true;
  const { data, error } = await supabase.from("text_channels")
    .select("id,name,channel_type,category,is_private,created_by")
    .eq("server_id", server.id)
    .order("name");
  if (error) {
    setStatus("community-status", `Не удалось загрузить каналы: ${error.message}`);
    return;
  }

  const list = byId("channel-list");
  list.replaceChildren();
  const categories = new Map();
  for (const channel of data || []) {
    const categoryName = channel.category?.trim() || "Без категории";
    let categoryList = categories.get(categoryName);
    if (!categoryList) {
      const categoryItem = document.createElement("li");
      categoryItem.className = "channel-category";
      const heading = document.createElement("h5");
      heading.textContent = categoryName;
      categoryList = document.createElement("ul");
      categoryList.className = "channel-category-list";
      categoryItem.append(heading, categoryList);
      list.append(categoryItem);
      categories.set(categoryName, categoryList);
    }
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel-list-button";
    const icon = document.createElement("span");
    icon.className = `channel-list-icon channel-list-icon--${channel.channel_type || "text"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = channel.channel_type === "voice" ? "◖" : channel.channel_type === "announcement" ? "▤" : "#";
    const copy = document.createElement("span");
    copy.className = "channel-list-copy";
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const description = document.createElement("small");
    description.textContent = [channel.category, channel.is_private ? "Приватный" : ""].filter(Boolean).join(" · ") || (channel.channel_type === "voice" ? "Голосовой канал" : channel.channel_type === "announcement" ? "Объявления" : "Текстовый канал");
    copy.append(name, description);
    const arrow = document.createElement("span");
    arrow.className = "server-list-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    button.append(icon, copy, arrow);
    button.addEventListener("click", () => openChannel(channel));
    item.append(button);
    categoryList.append(item);
  }
  byId("channel-empty").hidden = Boolean(data?.length);
  byId("server-meta").textContent += ` · ${data?.length || 0} ${data?.length === 1 ? "канал" : "каналов"}`;
  document.querySelectorAll("#server-list .server-list-button").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.serverId === server.id));
  });
  setStatus("community-status", "");
}

async function openChannel(channel) {
  currentChannel = channel;
  byId("channel-view").hidden = false;
  byId("channel-title").textContent = channel.name;
  byId("channel-description").textContent = [channel.category, channel.is_private ? "Приватный канал" : ""].filter(Boolean).join(" · ");
  byId("communities-section").classList.add("is-channel-open");
  byId("channel-messages").replaceChildren();

  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  channelSubscription = null;
  const isVoice = channel.channel_type === "voice";
  const isReadOnlyAnnouncement = channel.channel_type === "announcement" && currentServer?.created_by !== user?.id;
  byId("channel-voice-panel").hidden = !isVoice;
  byId("channel-readonly-note").hidden = isVoice || !isReadOnlyAnnouncement;
  byId("channel-message-form").hidden = isVoice || isReadOnlyAnnouncement;
  if (isVoice) {
    setStatus("community-status", "");
    void voiceRoomsController.watch(channel).catch((error) => {
      console.error("GadLink voice room watch:", error);
      byId("voice-room-status").textContent = `Не удалось открыть голосовой канал: ${error.message}`;
      byId("voice-room-status").classList.add("is-error");
    });
    return;
  }
  await voiceRoomsController.close();
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
      event: "*",
      schema: "public",
      table: "channel_messages",
      filter: `channel_id=eq.${channel.id}`
    }, async (payload) => {
      if (payload.eventType === "DELETE") {
        byId("channel-messages").querySelector(`[data-message-id="${payload.old.id}"]`)?.remove();
        return;
      }
      const message = payload.new;
      const names = await loadPublicNames([message.user_id], "community-status");
      message.profiles = names.get(message.user_id);
      addMessage(byId("channel-messages"), message);
    })
    .subscribe();
}

async function openNotificationRoute() {
  const url = new URL(window.location.href);
  const conversationId = url.searchParams.get("conversation");
  const callId = url.searchParams.get("call");
  url.searchParams.delete("conversation");
  url.searchParams.delete("call");
  if (window.location.search !== url.search) {
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  if (isUuid(conversationId)) {
    const conversation = conversationsById.get(conversationId);
    if (conversation) {
      document.querySelector('[data-section="chats-section"]')?.click();
      await openConversation(conversation);
    } else {
      setStatus("chat-status", "Этот диалог больше недоступен.");
    }
  }
  if (isUuid(callId)) {
    document.querySelector('[data-section="calls-section"]')?.click();
    await voiceCallsController.resumeIncomingCall(callId);
  }
}

async function loadApp() {
  if (!user || (!user.email_confirmed_at && !user.confirmed_at)) {
    showApp(false);
    throw new Error("Сначала подтвердите адрес электронной почты.");
  }
  showApp(true);
  await chatBackgroundController.setUser(user.id);
  reelsController ||= createReelsFeed({ supabase, getUser: () => user });
  await Promise.all([
    loadProfile().catch((error) => {
      console.error("GadLink profile load:", error);
      setStatus("profile-status", `Не удалось загрузить профиль: ${error.message}`);
      byId("menu-profile-status").textContent = `Не удалось загрузить профиль: ${error.message}`;
    }),
    loadPosts().catch((error) => {
      console.error("GadLink posts load:", error);
      setStatus("feed-status", `Не удалось загрузить ленту: ${error.message}`);
    }),
    loadConversations().catch((error) => {
      console.error("GadLink conversations load:", error);
      setStatus("chat-status", `Не удалось загрузить список чатов: ${error.message}`);
    }),
    loadServers().catch((error) => {
      console.error("GadLink servers initialization:", error);
      setStatus("community-status", `Не удалось загрузить серверы: ${error.message}`);
    }),
    voiceCallsController.initialize().catch((error) => {
      console.error("GadLink voice calls initialization:", error);
      setStatus("calls-status", `Не удалось подключить звонки: ${error.message}`);
    }),
    pushController.initialize().catch((error) => {
      console.error("GadLink push initialization:", error);
      setStatus("push-status", `Не удалось подготовить уведомления: ${error.message}`);
    })
  ]);
  const inviteToken = new URLSearchParams(window.location.search).get("server");
  if (inviteToken) {
    const url = new URL(window.location.href);
    url.searchParams.delete("server");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    try {
      const { data: serverId, error } = await supabase.rpc("gadlink_join_server", { invite_token: inviteToken });
      if (error) throw error;
      await loadServers();
      const { data: server, error: serverError } = await supabase.from("servers")
        .select("id,name,description,server_type,is_private,avatar_path,invite_code,created_by")
        .eq("id", serverId)
        .single();
      if (serverError) throw serverError;
      document.querySelector('[data-section="communities-section"]')?.click();
      await openServer(server);
      setStatus("community-status", `Вы присоединились к серверу «${server.name}».`);
    } catch (error) {
      console.error("GadLink invite link:", error);
      document.querySelector('[data-section="communities-section"]')?.click();
      setStatus("community-status", `Не удалось присоединиться по ссылке: ${error.message}`);
    }
  }
  subscribeToConversationMemberships();
  subscribeToChatOverview();
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
  try {
    await openNotificationRoute();
  } catch (error) {
    console.error("GadLink notification route:", error);
    setStatus("chat-status", `Вы вошли, но не удалось открыть ссылку из уведомления: ${error.message}`);
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
    if (targetSection === "chats-section" &&
        isConversationVisible(currentConversation?.id)) {
      void markConversationRead(currentConversation.id);
    }
    syncActivePushConversation();
    if (button.closest("#profile-menu")) setMenuOpen(false);
  });
});

function showCommunitiesForChannelCreation() {
  document.querySelector('[data-section="communities-section"]')?.click();
  if (!currentServer) {
    setStatus("community-status", "Сначала выберите сервер, в котором нужно создать канал.");
    byId("server-list").querySelector("button")?.focus();
    return;
  }
  openCommunityDialog("channel-create-dialog", byId("channel-create-open"));
}

function openCommunityDialog(id, opener = document.activeElement) {
  const dialog = byId(id);
  clearTimeout(communityDialogCloseTimers.get(id));
  communityDialogCloseTimers.delete(id);
  const trigger = opener instanceof HTMLElement ? opener : null;
  communityDialogOpener = trigger?.closest("[hidden]") ? byId("community-add-open") : trigger;
  document.body.classList.add("community-dialog-open");
  dialog.hidden = false;
  dialog.removeAttribute("inert");
  requestAnimationFrame(() => dialog.classList.add("is-open"));
  dialog.querySelector("input:not([type=hidden]):not([type=file]), button:not([data-dialog-close]), select")?.focus();
}

function closeCommunityDialog(id, restoreFocus = true) {
  const dialog = byId(id);
  clearTimeout(communityDialogCloseTimers.get(id));
  dialog.classList.remove("is-open");
  dialog.setAttribute("inert", "");
  const timer = setTimeout(() => {
    dialog.hidden = true;
    dialog.removeAttribute("inert");
    communityDialogCloseTimers.delete(id);
    if (![...document.querySelectorAll(".community-dialog")].some((item) => !item.hidden)) {
      document.body.classList.remove("community-dialog-open");
    }
  }, 200);
  communityDialogCloseTimers.set(id, timer);
  if (restoreFocus && communityDialogOpener?.isConnected) communityDialogOpener.focus();
  communityDialogOpener = null;
}

function normalizeChannelName(value) {
  return value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, "-").replace(/-+/g, "-");
}

function setServerPhotoPreview(file) {
  const preview = byId("server-avatar-preview");
  if (serverPhotoPreviewUrl) URL.revokeObjectURL(serverPhotoPreviewUrl);
  serverPhotoPreviewUrl = null;
  preview.replaceChildren();
  preview.textContent = "▧";
  if (!file) return;
  serverPhotoPreviewUrl = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.src = serverPhotoPreviewUrl;
  image.alt = "";
  preview.replaceChildren(image);
}

byId("menu-toggle").addEventListener("click", () => {
  setMenuOpen(byId("menu-toggle").getAttribute("aria-expanded") !== "true");
});
byId("community-add-open").addEventListener("click", () => {
  const menu = byId("community-add-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  byId("community-add-open").setAttribute("aria-expanded", String(open));
  if (open) {
    const anchor = byId("community-add-open").getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - menu.offsetWidth - 12, anchor.right - menu.offsetWidth));
    const top = Math.max(12, Math.min(window.innerHeight - menu.offsetHeight - 12, anchor.bottom + 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('[role="menuitem"]')?.focus();
  }
});
byId("channel-create-open").addEventListener("click", () => {
  if (!currentServer) {
    setStatus("community-status", "Сначала выберите сервер.");
    return;
  }
  byId("channel-server-name").textContent = currentServer.name;
  byId("channel-form").reset();
  byId("channel-name-count").textContent = "0/32";
  byId("channel-name-error").hidden = true;
  setStatus("channel-create-status", "");
  openCommunityDialog("channel-create-dialog", byId("channel-create-open"));
});
document.querySelectorAll("[data-community-action]").forEach((button) => {
  button.addEventListener("click", () => {
    byId("community-add-menu").hidden = true;
    byId("community-add-open").setAttribute("aria-expanded", "false");
    const action = button.dataset.communityAction;
    if (action === "create-server") {
      byId("server-form").reset();
      byId("server-name-count").textContent = "0/50";
      byId("server-create-status").textContent = "";
      setServerPhotoPreview(null);
      openCommunityDialog("server-create-dialog", button);
    } else if (action === "join-server") {
      byId("server-join-form").reset();
      byId("server-join-status").textContent = "";
      openCommunityDialog("server-join-dialog", button);
    }
  });
});
document.querySelectorAll("[data-dialog-close]").forEach((button) => {
  button.addEventListener("click", () => closeCommunityDialog(button.dataset.dialogClose));
});
byId("server-name").addEventListener("input", () => {
  byId("server-name-count").textContent = `${byId("server-name").value.length}/50`;
  byId("server-name").removeAttribute("aria-invalid");
  setStatus("server-create-status", "");
});
byId("server-name").addEventListener("invalid", (event) => {
  event.preventDefault();
  setStatus("server-create-status", "Введите название сервера.");
  byId("server-name").setAttribute("aria-invalid", "true");
});
byId("server-avatar-file").addEventListener("change", () => {
  const file = byId("server-avatar-file").files[0];
  if (file && (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024)) {
    byId("server-create-status").textContent = "Выберите JPG, PNG, WebP или GIF размером до 5 МБ.";
    byId("server-avatar-file").value = "";
    setServerPhotoPreview(null);
    return;
  }
  byId("server-create-status").textContent = "";
  setServerPhotoPreview(file);
});
byId("channel-name").addEventListener("input", () => {
  const input = byId("channel-name");
  const normalized = normalizeChannelName(input.value);
  if (normalized !== input.value) {
    const cursor = input.selectionStart;
    input.value = normalized;
    input.setSelectionRange(Math.min(cursor, normalized.length), Math.min(cursor, normalized.length));
  }
  byId("channel-name-count").textContent = `${input.value.length}/32`;
  byId("channel-name-error").hidden = true;
  input.removeAttribute("aria-invalid");
});
byId("channel-name").addEventListener("invalid", (event) => {
  event.preventDefault();
  byId("channel-name-error").textContent = "Введите название канала.";
  byId("channel-name-error").hidden = false;
  byId("channel-name").setAttribute("aria-invalid", "true");
});
byId("channel-category").addEventListener("change", () => {
  byId("channel-new-category").hidden = byId("channel-category").value !== "__new__";
  if (!byId("channel-new-category").hidden) byId("channel-new-category").focus();
});
byId("server-back").addEventListener("click", () => {
  currentServer = null;
  currentChannel = null;
  if (channelSubscription) void supabase.removeChannel(channelSubscription);
  channelSubscription = null;
  byId("server-view").hidden = true;
  updateCommunityEmptyState(byId("server-list").children.length > 0);
  byId("communities-section").classList.remove("is-detail-open", "is-channel-open");
});
byId("channel-back").addEventListener("click", async () => {
  currentChannel = null;
  byId("channel-view").hidden = true;
  byId("communities-section").classList.remove("is-channel-open");
  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  channelSubscription = null;
});
byId("server-invite").addEventListener("click", async () => {
  if (!currentServer?.invite_code) return;
  const inviteUrl = new URL(window.location.pathname, window.location.origin);
  inviteUrl.searchParams.set("server", currentServer.invite_code);
  try {
    await navigator.clipboard.writeText(inviteUrl.href);
    setStatus("community-status", "Ссылка-приглашение скопирована.");
  } catch (error) {
    console.error("GadLink invite clipboard:", error);
    setStatus("community-status", `Не удалось скопировать ссылку: ${inviteUrl.href}`);
  }
});
document.querySelector(".profile-menu__backdrop").addEventListener("click", () => setMenuOpen(false));
byId("add-contact-button").addEventListener("click", () => {
  setCreateMenuOpen(byId("create-menu").hidden);
});
byId("create-menu").addEventListener("click", (event) => {
  const action = event.target.closest("[data-create-action]")?.dataset.createAction;
  if (!action) return;
  setCreateMenuOpen(false);

  if (action === "channel") {
    showCommunitiesForChannelCreation();
  } else if (action === "contact") {
    setFriendDialogOpen(true);
  }
});
document.addEventListener("click", (event) => {
  if (byId("community-add-menu").hidden) return;
  if (event.target.closest("#community-add-menu, #community-add-open")) return;
  byId("community-add-menu").hidden = true;
  byId("community-add-open").setAttribute("aria-expanded", "false");
});
document.addEventListener("click", (event) => {
  if (byId("create-menu").hidden) return;
  if (event.target.closest("#create-menu, #add-contact-button")) return;
  setCreateMenuOpen(false);
});
byId("friend-add-close").addEventListener("click", () => setFriendDialogOpen(false));
document.querySelector(".friend-add-dialog__backdrop").addEventListener("click", () => setFriendDialogOpen(false));
byId("menu-avatar-file").parentElement.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    byId("menu-avatar-file").click();
  }
});
document.addEventListener("keydown", (event) => {
  const communityDialog = [...document.querySelectorAll(".community-dialog")]
    .find((dialog) => !dialog.hidden);
  if (communityDialog) {
    if (event.key === "Escape") {
      closeCommunityDialog(communityDialog.id);
      return;
    }
    if (!byId("community-add-menu").hidden) {
      const actions = [...byId("community-add-menu").querySelectorAll('[role="menuitem"]')];
      if (event.key === "Escape") {
        byId("community-add-menu").hidden = true;
        byId("community-add-open").setAttribute("aria-expanded", "false");
        byId("community-add-open").focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const index = actions.indexOf(document.activeElement);
        actions[(index + direction + actions.length) % actions.length]?.focus();
        event.preventDefault();
      } else if (event.key === "Tab") {
        const first = actions[0];
        const last = actions[actions.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          byId("community-add-open").focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          byId("community-add-open").focus();
        }
      }
      return;
    }
    if (event.key === "Tab") {
      const actions = [...communityDialog.querySelectorAll("button:not(:disabled), input:not(:disabled):not([type=file]), select:not(:disabled), textarea:not(:disabled)")]
        .filter((element) => element.offsetParent !== null);
      const first = actions[0];
      const last = actions[actions.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
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
  if (document.visibilityState === "visible") {
    scheduleChatSync();
    syncActivePushConversation();
    if (isConversationVisible(currentConversation?.id)) {
      void markConversationRead(currentConversation.id);
    }
  }
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

byId("auth-form").querySelector('button[type="submit"]').addEventListener("click", () => {
  byId("auth-form").classList.add("auth-form--signup-primary");
});

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  byId("auth-form").classList.add("auth-form--signup-primary");
  const submitButton = byId("auth-form").querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    user = await signInWithEmail(byId("auth-email").value.trim(), byId("auth-password").value);
  } catch (error) {
    showApp(false);
    showAuthError(getAuthErrorMessage(error));
    showResendButton(error.needsConfirmation);
    submitButton.disabled = false;
    return;
  }

  showResendButton(false);
  setStatus("auth-status", "");
  try {
    await loadApp();
  } catch (error) {
    console.error("GadLink app initialization after sign-in:", error);
    const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);
    showApp(confirmed);
    setStatus(
      "auth-status",
      confirmed
        ? `Вы вошли, но приложение загрузилось не полностью: ${error.message}`
        : error.message
    );
  } finally {
    submitButton.disabled = false;
  }
});

byId("sign-up").addEventListener("click", async () => {
  byId("auth-form").classList.remove("auth-form--signup-primary");
  if (!byId("auth-form").reportValidity()) return;

  const button = byId("sign-up");
  const email = byId("auth-email").value.trim();
  button.disabled = true;
  showResendButton(false);

  try {
    const registeredUser = await registerWithEmail(email, byId("auth-password").value);
    if (registeredUser) {
      user = registeredUser;
      setStatus("auth-status", "");
      await loadApp();
      return;
    }

    setStatus("auth-status", "Регистрация создана. Подтвердите почту по ссылке из письма, затем войдите в аккаунт. Если письма нет, запросите его повторно.");
    showResendButton(true);
  } catch (error) {
    const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);
    if (confirmed) {
      console.error("GadLink app initialization after sign-up:", error);
      showApp(true);
      setStatus("auth-status", `Аккаунт создан и выполнен вход, но приложение загрузилось не полностью: ${error.message}`);
    } else {
      setStatus("auth-status", getAuthErrorMessage(error));
    }
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
    await pushController.shutdown();
  } catch (error) {
    console.error("GadLink push sign-out cleanup:", error);
    byId("push-status").textContent = `Не удалось отключить уведомления на этом устройстве: ${error.message}`;
  }
  try {
    await signOutUser();
  } catch (error) {
    switchStatus.textContent = `Не удалось сменить аккаунт: ${error.message}`;
    return;
  }
  try {
    await voiceCallsController.shutdown();
  } catch (error) {
    console.error("GadLink voice sign-out cleanup:", error);
    byId("calls-status").textContent = `Не удалось полностью закрыть звонок: ${error.message}`;
  }
  user = null;
  chatBackgroundController.setUser(null);
  reelsController?.reset();
  currentConversation = null;
  currentChannel = null;
  currentServer = null;
  byId("server-list").replaceChildren();
  byId("server-view").hidden = true;
  updateCommunityEmptyState(false);
  byId("communities-section").classList.remove("is-detail-open", "is-channel-open");
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

byId("profile-avatar-file").addEventListener("change", () => {
  const file = byId("profile-avatar-file").files[0];
  if (!file) return;
  const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!supportedTypes.includes(file.type)) {
    setStatus("profile-status", "Используйте изображение JPG, PNG, WebP или GIF.");
    byId("profile-avatar-file").value = "";
    return;
  }
  if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
  profileAvatarPreviewUrl = URL.createObjectURL(file);
  byId("profile-avatar").value = "";
  updateProfileAvatarPreview(profileAvatarPreviewUrl);
});
byId("profile-avatar").addEventListener("input", () => {
  if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
  profileAvatarPreviewUrl = null;
  byId("profile-avatar-file").value = "";
  updateProfileAvatarPreview(byId("profile-avatar").value);
});
byId("profile-username").addEventListener("input", () => {
  if (byId("profile-avatar-preview-image").hidden) updateProfileAvatarPreview("");
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
  const form = byId("server-form");
  const submit = form.querySelector('[type="submit"]');
  const name = byId("server-name").value.trim();
  const file = byId("server-avatar-file").files[0];
  if (!name) {
    setStatus("server-create-status", "Введите название сервера.");
    byId("server-name").focus();
    return;
  }
  if (!user?.id) {
    setStatus("server-create-status", "Войдите в аккаунт, чтобы создать сервер.");
    return;
  }
  submit.disabled = true;
  setStatus("server-create-status", "Создаём сервер…");
  let avatarPath = null;
  let serverCreated = false;
  try {
    if (file) {
      const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[file.type];
      if (!extension || file.size > 5 * 1024 * 1024) throw new Error("Выберите изображение JPG, PNG, WebP или GIF размером до 5 МБ.");
      avatarPath = `${user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("server-avatars").upload(avatarPath, file, { contentType: file.type });
      if (uploadError) throw uploadError;
    }

    const { data, error } = await supabase.from("servers").insert({
      name,
      created_by: user.id,
      server_type: form.querySelector('[name="server-type"]:checked')?.value || "friends",
      is_private: byId("server-private").checked,
      description: byId("server-description-input").value.trim(),
      avatar_path: avatarPath
    }).select("id,name,description,server_type,is_private,avatar_path,invite_code,created_by").single();
    if (error) throw error;
    serverCreated = true;

    byId("community-empty").hidden = true;
    form.reset();
    byId("server-name-count").textContent = "0/50";
    setServerPhotoPreview(null);
    closeCommunityDialog("server-create-dialog");
    await loadServers();
    if (data) await openServer(data);
    setStatus("community-status", "Сервер создан.");
  } catch (error) {
    console.error("GadLink create server:", error);
    if (avatarPath && !serverCreated) {
      try {
        const { error: cleanupError } = await supabase.storage.from("server-avatars").remove([avatarPath]);
        if (cleanupError) console.error("GadLink server avatar cleanup:", cleanupError);
      } catch (cleanupError) {
        console.error("GadLink server avatar cleanup:", cleanupError);
      }
    }
    const message = error.code === "42501" || /row-level security|permission denied/i.test(error.message)
      ? "У вас нет прав на создание сервера. Проверьте RLS-политики."
      : error.message;
    setStatus(serverCreated ? "community-status" : "server-create-status", `Не удалось создать сервер: ${message}`);
  } finally {
    submit.disabled = false;
  }
});

byId("channel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("channel-form");
  const submit = form.querySelector('[type="submit"]');
  const nameInput = byId("channel-name");
  const name = normalizeChannelName(nameInput.value);
  const channels = [...byId("channel-list").querySelectorAll(".channel-list-button strong")].map((node) => normalizeChannelName(node.textContent));
  if (!name) {
    byId("channel-name-error").textContent = "Введите название канала.";
    byId("channel-name-error").hidden = false;
    nameInput.setAttribute("aria-invalid", "true");
    nameInput.focus();
    return;
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(name)) {
    byId("channel-name-error").textContent = "Используйте буквы, цифры, дефис или подчёркивание.";
    byId("channel-name-error").hidden = false;
    nameInput.setAttribute("aria-invalid", "true");
    nameInput.focus();
    return;
  }
  if (channels.includes(name)) {
    byId("channel-name-error").textContent = `Канал «${name}» уже есть на этом сервере. Выберите другое имя.`;
    byId("channel-name-error").hidden = false;
    nameInput.setAttribute("aria-invalid", "true");
    nameInput.focus();
    return;
  }
  const categorySelection = byId("channel-category").value;
  const category = categorySelection === "__new__"
    ? byId("channel-new-category").value.trim()
    : categorySelection;
  if (categorySelection === "__new__" && !category) {
    setStatus("channel-create-status", "Введите название категории.");
    byId("channel-new-category").focus();
    return;
  }
  if (!currentServer?.id || !user?.id) {
    setStatus("channel-create-status", "Выберите сервер и войдите в аккаунт.");
    return;
  }

  submit.disabled = true;
  setStatus("channel-create-status", "Создаём канал…");
  let channelCreated = false;
  try {
    const { error } = await supabase.from("text_channels").insert({
      server_id: currentServer.id,
      created_by: user.id,
      name,
      channel_type: form.querySelector('[name="channel-type"]:checked')?.value || "text",
      category: category || null,
      is_private: byId("channel-private").checked
    });
    if (error) throw error;
    channelCreated = true;
    const server = currentServer;
    closeCommunityDialog("channel-create-dialog");
    form.reset();
    byId("channel-name-count").textContent = "0/32";
    byId("channel-name-error").hidden = true;
    byId("channel-new-category").hidden = true;
    await openServer(server);
    setStatus("community-status", "Канал создан.");
  } catch (error) {
    console.error("GadLink create channel:", error);
    const message = error.code === "42501" || /row-level security|permission denied/i.test(error.message)
      ? "У вас нет прав на создание канала в этом сервере."
      : error.code === "23505"
        ? "Канал с таким названием уже существует. Выберите другое имя."
        : error.message;
    byId("channel-name-error").textContent = message;
    byId("channel-name-error").hidden = false;
    nameInput.setAttribute("aria-invalid", "true");
    setStatus(channelCreated ? "community-status" : "channel-create-status", `Не удалось создать канал: ${message}`);
  } finally {
    submit.disabled = false;
  }
});

byId("server-join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = byId("server-join-form").querySelector('[type="submit"]');
  const rawLink = byId("server-invite-link").value.trim();
  let inviteToken = rawLink;
  try {
    inviteToken = new URL(rawLink, window.location.href).searchParams.get("server") || rawLink;
  } catch {
    inviteToken = rawLink;
  }
  if (!inviteToken || inviteToken.length > 200) {
    setStatus("server-join-status", "Введите корректную ссылку-приглашение.");
    return;
  }
  submit.disabled = true;
  setStatus("server-join-status", "Подключаемся…");
  let joinedServer = false;
  try {
    const { data: serverId, error } = await supabase.rpc("gadlink_join_server", { invite_token: inviteToken });
    if (error) throw error;
    if (!serverId) throw new Error("Сервер по этой ссылке не найден.");
    joinedServer = true;
    closeCommunityDialog("server-join-dialog");
    await loadServers();
    const { data: server, error: serverError } = await supabase.from("servers")
      .select("id,name,description,server_type,is_private,avatar_path,invite_code,created_by")
      .eq("id", serverId)
      .single();
    if (serverError) throw serverError;
    if (!server) throw new Error("Вы присоединились, но сервер не удалось открыть.");
    await openServer(server);
    setStatus("community-status", `Вы присоединились к серверу «${server.name}».`);
  } catch (error) {
    console.error("GadLink join server:", error);
    const message = error.code === "42501" ? "Войдите в аккаунт, чтобы присоединиться к серверу." : error.message;
    setStatus(joinedServer ? "community-status" : "server-join-status", `Не удалось присоединиться: ${message}`);
  } finally {
    submit.disabled = false;
  }
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
    void voiceRoomsController.shutdown().catch((error) => {
      console.error("GadLink voice room auth cleanup:", error);
    });
    void voiceCallsController.shutdown().catch((error) => {
      console.error("GadLink voice auth cleanup:", error);
    });
    void pushController.shutdown().catch((error) => {
      console.error("GadLink push auth cleanup:", error);
    });
    reelsController?.reset();
    if (chatSubscription) void supabase.removeChannel(chatSubscription);
    chatSubscription = null;
    if (conversationMembershipSubscription) void supabase.removeChannel(conversationMembershipSubscription);
    conversationMembershipSubscription = null;
    if (chatOverviewSubscription) void supabase.removeChannel(chatOverviewSubscription);
    chatOverviewSubscription = null;
    if (channelSubscription) void supabase.removeChannel(channelSubscription);
    channelSubscription = null;
    currentChannel = null;
    currentServer = null;
    byId("server-list").replaceChildren();
    byId("server-view").hidden = true;
    updateCommunityEmptyState(false);
    conversationLoadVersion += 1;
    clearTimeout(conversationSyncTimer);
    conversationSyncTimer = null;
    messageSyncCursors.clear();
    directConversationByPeer.clear();
    currentConversation = null;
    conversationsById.clear();
    conversationOverviewRows.clear();
    conversationUnreadCounts.clear();
    conversationOverviewRequestVersion += 1;
    clearTimeout(conversationOverviewRefreshTimer);
    conversationOverviewRefreshTimer = null;
    updateUnreadBadge();
    byId("chat-call-button").hidden = true;
    byId("chat-call-button").dataset.userId = "";
    user = null;
    chatBackgroundController.setUser(null);
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
    console.error("GadLink app restoration:", error);
    const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);
    showApp(confirmed);
    setStatus(
      "auth-status",
      confirmed
        ? `Вы вошли, но приложение загрузилось не полностью: ${error.message}`
        : error.message
    );
  }
}).catch((error) => {
  showApp(false);
  setStatus("auth-status", getAuthErrorMessage(error));
});
