
import { supabase } from "./supabaseClient.js";

export function resolveAvatarUrl(value) {
  const avatar = String(value || "").trim();
  if (!avatar) return "";
  try {
    const url = new URL(avatar);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    const path = avatar.replace(/^\/+/, "").replace(/^avatars\//, "");
    const [ownerId, ...segments] = path.split("/");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId || "") ||
        !segments.length || segments.some((part) => !part || part === "." || part === "..")) return "";
    return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  }
}

// Поиск пользователей по нику
export async function searchUsers(username) {
  const { data, error } = await supabase.rpc(
    "search_friend_profiles",
    {
      search_text: username.trim()
    }
  );

  if (error) throw error;

  return (data || []).map((profile) => ({
    ...profile,
    avatar_url: resolveAvatarUrl(profile.avatar_url) || null
  }));
}

export async function getPublicProfileNames(profileIds) {
  const ids = [...new Set(profileIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase.rpc(
    "get_public_profile_names",
    { profile_ids: ids }
  );
  if (error) throw error;

  const profilesById = new Map(
    (data || []).map((profile) => [
      profile.id,
      {
        id: profile.id,
        username: profile.username?.trim() || "Пользователь",
        avatar_url: resolveAvatarUrl(profile.avatar_url) || null
      }
    ])
  );
  const missingAvatarIds = ids.filter((id) => !profilesById.get(id)?.avatar_url);
  if (missingAvatarIds.length) {
    try {
      const { data: avatarRows, error: avatarError } = await supabase
        .from("profiles")
        .select("id,avatar_url")
        .in("id", missingAvatarIds);
      if (avatarError) throw avatarError;
      for (const profile of avatarRows || []) {
        const existing = profilesById.get(profile.id);
        if (existing) existing.avatar_url = resolveAvatarUrl(profile.avatar_url) || null;
      }
    } catch (error) {
      console.error("GadLink public profile avatars:", error);
    }
  }
  for (const id of ids) {
    if (!profilesById.has(id)) {
      profilesById.set(id, { id, username: "Пользователь", avatar_url: null });
    }
  }
  return profilesById;
}

// Отправка заявки в друзья
export async function addFriend(userId) {
  const { data: { user }, error: authError } =
    await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Сначала войдите в аккаунт");
  }

  const { error } = await supabase
    .from("friendships")
    .insert({
      requester_id: user.id,
      addressee_id: userId,
      status: "pending"
    });

  if (error) throw error;
}

// Получение входящих заявок
export async function getFriendRequests() {
  const { data: { user }, error: authError } =
    await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Сначала войдите в аккаунт");
  }

  const { data, error } = await supabase
    .from("friendships")
    .select("id, requester_id, created_at")
    .eq("addressee_id", user.id)
    .eq("status", "pending");

  if (error) throw error;
  return data;
}

// Принятие заявки
export async function acceptFriend(requestId) {
  const { error } = await supabase.rpc(
    "accept_friend_request",
    { p_request_id: requestId }
  );

  if (error) throw error;
}

// Отклонение заявки или удаление друга
export async function removeFriend(requestId) {
  const { error } = await supabase
    .from("friendships")
    .delete()
    .eq("id", requestId);

  if (error) throw error;
}
