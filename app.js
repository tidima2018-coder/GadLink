import { supabase } from "./js/supabaseClient.js";
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
let currentChannel = null;
let chatSubscription = null;
let channelSubscription = null;
let resendTimer = null;

const byId = (id) => document.getElementById(id);
const setStatus = (id, message) => {
  byId(id).textContent = message;
};

function showApp(isSignedIn) {
  byId("auth-section").hidden = isSignedIn;
  byId("app").hidden = !isSignedIn;
  byId("sign-out").hidden = !isSignedIn;
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

async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  byId("profile-username").value = data?.username || "";
  byId("profile-about").value = data?.about || "";
  byId("profile-avatar").value = data?.avatar_url || "";
}

async function loadPosts() {
  const { data, error } = await supabase
    .from("posts")
    .select("id,user_id,content,media_url,created_at,profiles(username)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  const container = byId("posts");
  container.replaceChildren();
  for (const post of data || []) {
    const item = document.createElement("article");
    item.className = "item";
    addText(item, "p", post.profiles?.username || "пользователь");
    addText(item, "p", post.content);
    addMedia(item, post.media_url);
    addText(item, "small", formatTime(post.created_at));
    container.append(item);
  }
}

async function loadConversations() {
  const { data: memberships, error } = await supabase
    .from("conversation_members")
    .select("conversation_id")
    .eq("user_id", user.id);
  if (error) throw error;

  const ids = (memberships || []).map((item) => item.conversation_id);
  const list = byId("conversation-list");
  list.replaceChildren();
  if (!ids.length) return;

  const { data: conversations, error: conversationError } = await supabase
    .from("conversations")
    .select("id,name,is_group")
    .in("id", ids);
  if (conversationError) throw conversationError;

  for (const conversation of conversations || []) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = conversation.name || `чат ${conversation.id.slice(0, 8)}`;
    button.addEventListener("click", () => openConversation(conversation));
    item.append(button);
    list.append(item);
  }
}

function addMessage(container, message) {
  const item = document.createElement("article");
  item.className = "item";
  addText(item, "p", message.profiles?.username || (message.user_id === user.id ? "вы" : "пользователь"));
  addText(item, "p", message.content);
  addText(item, "small", formatTime(message.created_at));
  container.append(item);
}

async function openConversation(conversation) {
  currentConversation = conversation;
  byId("chat-view").hidden = false;
  byId("chat-title").textContent = conversation.name || "личный чат";
  byId("messages").replaceChildren();

  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  const { data, error } = await supabase
    .from("messages")
    .select("id,user_id,content,created_at,profiles(username)")
    .eq("conversation_id", conversation.id)
    .order("created_at")
    .limit(100);
  if (error) {
    setStatus("chat-status", error.message);
    return;
  }
  for (const message of data || []) addMessage(byId("messages"), message);

  chatSubscription = supabase
    .channel(`messages-${conversation.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `conversation_id=eq.${conversation.id}`
    }, (payload) => {
      if (payload.new.user_id === user.id) return;
      addMessage(byId("messages"), payload.new);
    })
    .subscribe();
}

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
    .select("id,user_id,content,created_at,profiles(username)")
    .eq("channel_id", channel.id)
    .order("created_at")
    .limit(100);
  if (error) {
    setStatus("community-status", error.message);
    return;
  }
  for (const message of data || []) addMessage(byId("channel-messages"), message);

  channelSubscription = supabase
    .channel(`channel-messages-${channel.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "channel_messages",
      filter: `channel_id=eq.${channel.id}`
    }, (payload) => {
      if (payload.new.user_id === user.id) return;
      addMessage(byId("channel-messages"), payload.new);
    })
    .subscribe();
}

async function loadApp() {
  if (!user || (!user.email_confirmed_at && !user.confirmed_at)) {
    showApp(false);
    throw new Error("Сначала подтвердите адрес электронной почты.");
  }
  showApp(true);
  await Promise.all([loadProfile(), loadPosts(), loadConversations(), loadServers()]);
  supabase
    .channel("feed-posts")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" }, loadPosts)
    .subscribe();
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
    document.querySelectorAll(".page-section").forEach((section) => {
      section.hidden = section.id !== button.dataset.section;
    });
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
    setStatus("auth-status", getAuthErrorMessage(error));
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
  try {
    await signOutUser();
  } catch (error) {
    setStatus("auth-status", error.message);
    return;
  }
  user = null;
  currentConversation = null;
  currentChannel = null;
  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  if (channelSubscription) await supabase.removeChannel(channelSubscription);
  showApp(false);
});

byId("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let avatarUrl = safeUrl(byId("profile-avatar").value.trim()) || null;
  const file = byId("profile-avatar-file").files[0];
  if (file) {
    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif"
    };
    const extension = extensions[file.type];
    if (!extension) {
      setStatus("profile-status", "используйте изображение jpg, png, webp или gif.");
      return;
    }
    const path = `${user.id}/${Date.now()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      setStatus("profile-status", uploadError.message);
      return;
    }
    avatarUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  }
  const profile = {
    id: user.id,
    username: byId("profile-username").value.trim(),
    about: byId("profile-about").value.trim(),
    avatar_url: avatarUrl
  };
  const { error } = await supabase.from("profiles").upsert(profile);
  setStatus("profile-status", error ? error.message : "профиль сохранён.");
  byId("profile-avatar-file").value = "";
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
  const usernames = byId("conversation-users").value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id,username")
    .in("username", usernames);
  if (profileError) {
    setStatus("chat-status", profileError.message);
    return;
  }
  const members = [...new Set([user.id, ...(profiles || []).map((profile) => profile.id)])];
  if (members.length < 2) {
    setStatus("chat-status", "укажите ник существующего пользователя.");
    return;
  }
  const name = byId("conversation-name").value.trim();
  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({ name: name || null, is_group: members.length > 2 || Boolean(name), created_by: user.id })
    .select("id,name,is_group")
    .single();
  if (error) {
    setStatus("chat-status", error.message);
    return;
  }
  const { error: membersError } = await supabase.from("conversation_members").insert(
    members.map((userId) => ({ conversation_id: conversation.id, user_id: userId }))
  );
  if (membersError) {
    setStatus("chat-status", membersError.message);
    return;
  }
  byId("conversation-form").reset();
  await loadConversations();
  await openConversation(conversation);
});

byId("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentConversation) return;
  const content = byId("message-content").value.trim();
  if (!content) return;
  if (content.startsWith("/ai ")) {
    addMessage(byId("messages"), {
      user_id: user.id,
      content,
      created_at: new Date().toISOString()
    });
    addMessage(byId("messages"), {
      user_id: "gadlink-bot",
      profiles: { username: "gadlink bot" },
      content: botAnswer(content.slice(4)),
      created_at: new Date().toISOString()
    });
    byId("message-form").reset();
    return;
  }
  const { error } = await supabase.from("messages").insert({
    conversation_id: currentConversation.id,
    user_id: user.id,
    content
  });
  if (error) {
    setStatus("chat-status", error.message);
    return;
  }
  addMessage(byId("messages"), {
    user_id: user.id,
    content,
    created_at: new Date().toISOString()
  });
  byId("message-form").reset();
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
    user = null;
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
