
import { supabase } from "./supabaseClient.js";

import {
  searchUsers,
  addFriend,
  acceptFriend,
  removeFriend
} from "./friends.js";

// Раздел друзей GadLink
const section = document.getElementById("friends-section");
const navButton = document.querySelector(
  '[data-section="friends-section"]'
);

const searchForm = document.getElementById("friend-search-form");
const searchInput = document.getElementById("friend-search");
const resultsBox = document.getElementById("friend-search-results");
const requestsBox = document.getElementById("friend-requests");
const friendsBox = document.getElementById("friends-list");
const statusBox = document.getElementById("friend-status");

if (
  section &&
  navButton &&
  searchForm &&
  searchInput &&
  resultsBox &&
  requestsBox &&
  friendsBox &&
  statusBox
) {
  const state = {
    userId: null,
    links: [],
    profileById: new Map(),
    searchResults: [],
    loading: false
  };

  // Стили раздела друзей
  const style = document.createElement("style");

  style.textContent = `
    #friends-section .friend-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 15px;
      margin: 10px 0;
      border: 1px solid #353b56;
      border-radius: 12px;
      background: #1b2033;
      color: #f3f5ff;
    }

    #friends-section .friend-person {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 12px;
    }

    #friends-section .friend-avatar {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      object-fit: cover;
      background: #4d587b;
      flex-shrink: 0;
    }

    #friends-section .friend-username {
      overflow-wrap: anywhere;
    }

    #friends-section .friend-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      justify-content: flex-end;
    }

    #friends-section .friend-actions button {
      padding: 8px 12px;
      border-radius: 8px;
    }

    #friends-section .friend-actions button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #friends-section .friend-empty {
      color: #adb5cd;
      margin: 12px 0 24px;
    }

    @media (max-width: 520px) {
      #friends-section .friend-item {
        align-items: flex-start;
        flex-direction: column;
      }

      #friends-section .friend-actions {
        width: 100%;
        justify-content: flex-start;
      }
    }
  `;

  document.head.append(style);

  function setStatus(message) {
    statusBox.textContent = message;
  }

  // Создание кнопки
  function createButton(label, action, disabled = false) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;

    if (action) {
      button.addEventListener("click", async () => {
        button.disabled = true;

        try {
          await action();
        } catch (error) {
          console.error("GadLink friends:", error);

          setStatus(
            error?.message || "Не удалось выполнить действие."
          );
        } finally {
          if (button.isConnected) {
            button.disabled = false;
          }
        }
      });
    }

    return button;
  }

  // Карточка пользователя
  function personCard(profile, actions = []) {
    const card = document.createElement("div");
    card.className = "friend-item";

    const person = document.createElement("div");
    person.className = "friend-person";

    const avatar = document.createElement("div");
    avatar.className = "friend-avatar";

    if (
      profile?.avatar_url &&
      /^https?:\/\//i.test(profile.avatar_url)
    ) {
      const image = document.createElement("img");

      image.className = "friend-avatar";
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.src = profile.avatar_url;

      person.append(image);
    } else {
      person.append(avatar);
    }

    const name = document.createElement("strong");
    name.className = "friend-username";
    name.textContent = profile?.username || "Пользователь";

    person.append(name);

    const actionsBox = document.createElement("div");
    actionsBox.className = "friend-actions";

    for (const button of actions) {
      actionsBox.append(button);
    }

    card.append(person, actionsBox);

    return card;
  }

  function empty(container, message) {
    const text = document.createElement("p");

    text.className = "friend-empty";
    text.textContent = message;

    container.append(text);
  }

  function profileFor(id) {
    return state.profileById.get(id) || {
      username: "Пользователь"
    };
  }

  function otherId(link) {
    return link.requester_id === state.userId
      ? link.addressee_id
      : link.requester_id;
  }

  // Входящие заявки и список друзей
  function renderRequestsAndFriends() {
    requestsBox.replaceChildren();
    friendsBox.replaceChildren();

    const incoming = state.links.filter(
      link =>
        link.status === "pending" &&
        link.addressee_id === state.userId
    );

    const friends = state.links.filter(
      link => link.status === "accepted"
    );

    // Входящие заявки
    for (const link of incoming) {
      const accept = createButton("Принять", async () => {
        await acceptFriend(link.id);
        await refreshFriends();

        setStatus("Заявка принята.");
      });

      const reject = createButton("Отклонить", async () => {
        await removeFriend(link.id);
        await refreshFriends();

        setStatus("Заявка отклонена.");
      });

      requestsBox.append(
        personCard(
          profileFor(link.requester_id),
          [accept, reject]
        )
      );
    }

    if (!incoming.length) {
      empty(requestsBox, "Новых заявок пока нет.");
    }

    // Список друзей
    for (const link of friends) {
      const remove = createButton(
        "Удалить из друзей",
        async () => {
          await removeFriend(link.id);
          await refreshFriends();

          setStatus("Пользователь удалён из друзей.");
        }
      );

      friendsBox.append(
        personCard(
          profileFor(otherId(link)),
          [remove]
        )
      );
    }

    if (!friends.length) {
      empty(friendsBox, "Здесь появятся ваши друзья.");
    }
  }

  // Результаты поиска
  function renderSearch() {
    resultsBox.replaceChildren();

    if (!state.searchResults.length) {
      return;
    }

    for (const person of state.searchResults) {
      const link = state.links.find(
        item => otherId(item) === person.id
      );

      let action;

      // Уже в друзьях
      if (link?.status === "accepted") {
        action = createButton("В друзьях", null, true);

      // Заявка уже отправлена
      } else if (
        link?.status === "pending" &&
        link.requester_id === state.userId
      ) {
        action = createButton(
          "Заявка отправлена",
          null,
          true
        );

      // Есть входящая заявка
      } else if (
        link?.status === "pending" &&
        link.addressee_id === state.userId
      ) {
        action = createButton("Принять", async () => {
          await acceptFriend(link.id);
          await refreshFriends();

          setStatus("Заявка принята.");
        });

      // Отправка новой заявки
      } else {
        action = createButton("Добавить", async () => {
          await addFriend(person.id);
          await refreshFriends();

          setStatus("Заявка отправлена.");
        });
      }

      resultsBox.append(
        personCard(person, [action])
      );
    }
  }

  // Загружаем друзей из Supabase
  async function refreshFriends() {
    if (state.loading) return;

    state.loading = true;

    try {
      const {
        data: { user },
        error: userError
      } = await supabase.auth.getUser();

      if (userError || !user) {
        state.userId = null;
        state.links = [];
        state.searchResults = [];

        requestsBox.replaceChildren();
        friendsBox.replaceChildren();
        resultsBox.replaceChildren();

        setStatus("Сначала войдите в аккаунт GadLink.");
        return;
      }

      state.userId = user.id;

      const { data: links, error } = await supabase
        .from("friendships")
        .select(
          "id,requester_id,addressee_id,status,created_at"
        )
        .or(
          `requester_id.eq.${user.id},addressee_id.eq.${user.id}`
        )
        .order("created_at", {
          ascending: false
        });

      if (error) throw error;

      state.links = links || [];

      const ids = [
        ...new Set(state.links.map(otherId))
      ];

      state.profileById = new Map();

      if (ids.length) {
        const {
          data: profiles,
          error: profileError
        } = await supabase
          .from("profiles")
          .select("id,username,avatar_url")
          .in("id", ids);

        if (profileError) throw profileError;

        for (const profile of profiles || []) {
          state.profileById.set(
            profile.id,
            profile
          );
        }
      }

      renderRequestsAndFriends();
      renderSearch();

      setStatus("");

    } catch (error) {
      console.error("GadLink friends:", error);

      setStatus(
        `Ошибка загрузки друзей: ${error.message}`
      );

    } finally {
      state.loading = false;
    }
  }

  // Поиск пользователей
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const query = searchInput.value.trim();

    if (!query) return;

    setStatus("Ищем пользователей...");
    resultsBox.replaceChildren();

    try {
      const {
        data: { user },
        error: userError
      } = await supabase.auth.getUser();

      if (userError || !user) {
        throw new Error(
          "Сначала войдите в аккаунт GadLink."
        );
      }

      if (user.id !== state.userId) {
        await refreshFriends();
      }

      const users = await searchUsers(query);

      state.searchResults = users.filter(
        person => person.id !== user.id
      );

      renderSearch();

      setStatus(
        state.searchResults.length
          ? ""
          : "Пользователи не найдены."
      );

    } catch (error) {
      console.error("GadLink friends:", error);

      setStatus(
        `Ошибка поиска: ${error.message}`
      );
    }
  });

  // При открытии вкладки "Друзья"
  navButton.addEventListener("click", () => {
    void refreshFriends();
  });
}
