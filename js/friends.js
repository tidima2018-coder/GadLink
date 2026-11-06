
import { supabase } from "./supabaseClient.js";

// Поиск пользователей по нику
export async function searchUsers(username) {
  const { data, error } = await supabase.rpc(
    "search_friend_profiles",
    {
      search_text: username.trim()
    }
  );

  if (error) throw error;

  return data || [];
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
