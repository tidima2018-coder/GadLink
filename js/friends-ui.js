
import { supabase } from "./supabaseClient.js";

import {
  searchUsers,
  getPublicProfileNames,
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
const contactsFilter = document.getElementById("contacts-filter");
const contactsList = document.getElementById("contacts-list");
const contactsEmpty = document.getElementById("contacts-empty");

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
    loading: false,
    refreshPending: false
  };
  let friendshipsChannel = null;
  let friendshipsChannelUserId = null;

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
      display: grid;
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      overflow: hidden;
      border-radius: 50%;
      place-items: center;
      background: #4d587b;
    }

    #friends-section .friend-avatar__image {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
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

    const avatar = document.createElement("span");
    avatar.className = "friend-avatar";
    avatar.setAttribute("aria-hidden", "true");

    if (
      profile?.avatar_url &&
      /^https?:\/\//i.test(profile.avatar_url)
    ) {
      const image = document.createElement("img");

      image.className = "friend-avatar__image";
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.src = profile.avatar_url;

      avatar.append(image);
    } else {
      avatar.textContent = (profile?.username || "?").trim().slice(0, 1).toLocaleUpperCase("ru-RU");
    }
    person.append(avatar);

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

  function renderContacts() {
    if (!contactsList || !contactsEmpty) return;
    const query = (contactsFilter?.value || "").trim().toLocaleLowerCase();
    const friends = state.links
      .filter((link) => link.status === "accepted")
      .map((link) => profileFor(otherId(link)))
      .filter((profile) => (profile.username || "Пользователь").toLocaleLowerCase().includes(query))
      .sort((a, b) => (a.username || "").localeCompare(b.username || "", "ru"));

    contactsList.replaceChildren();
    contactsEmpty.hidden = friends.length > 0;
    for (const profile of friends) {
      const row = document.createElement("article");
      row.className = "contact-row";
      const identity = document.createElement("div");
      identity.className = "contact-identity";

      if (profile.avatar_url && /^https?:\/\//i.test(profile.avatar_url)) {
        const avatar = document.createElement("img");
        avatar.className = "contact-avatar";
        avatar.src = profile.avatar_url;
        avatar.alt = "";
        avatar.referrerPolicy = "no-referrer";
        identity.append(avatar);
      } else {
        const avatar = document.createElement("span");
        avatar.className = "contact-avatar contact-avatar--placeholder";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = (profile.username || "?").slice(0, 1).toLocaleUpperCase();
        identity.append(avatar);
      }

      const details = document.createElement("span");
      details.className = "contact-details";
      const name = document.createElement("strong");
      name.textContent = profile.username || "Пользователь";
      const subtitle = document.createElement("small");
      subtitle.textContent = "В друзьях";
      details.append(name, subtitle);
      identity.append(details);

      const chatButton = document.createElement("button");
      chatButton.type = "button";
      chatButton.className = "contact-chat-button";
      chatButton.setAttribute("aria-label", `Открыть чат с ${name.textContent}`);
      chatButton.title = "Открыть чат";
      chatButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2 1-4.2A7.5 7.5 0 1 1 20 11.5Z"/></svg><span>Написать</span>';
      chatButton.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("gadlink:open-contact-chat", {
          detail: { userId: profile.id, username: profile.username || "Пользователь" }
        }));
      });

      row.append(identity, chatButton);
      contactsList.append(row);
    }
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

    renderContacts();

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
      const friend = profileFor(otherId(link));
      const message = createButton("Написать", () => {
        window.dispatchEvent(new CustomEvent("gadlink:open-contact-chat", {
          detail: { userId: friend.id, username: friend.username || "Пользователь" }
        }));
      });
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
          friend,
          [message, remove]
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
    if (state.loading) {
      state.refreshPending = true;
      return;
    }

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
      if (state.userId !== user.id) return;

      state.links = links || [];

      const ids = [...new Set(state.links.map(otherId))];
      state.profileById = await getPublicProfileNames(ids);
      if (state.userId !== user.id) return;

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
      if (state.refreshPending) {
        state.refreshPending = false;
        queueMicrotask(() => void refreshFriends());
      }
    }
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    const userId = session?.user?.id || null;
    if (friendshipsChannelUserId === userId) return;
    if (friendshipsChannel) void supabase.removeChannel(friendshipsChannel);
    friendshipsChannel = null;
    friendshipsChannelUserId = userId;
    state.userId = userId;
    state.links = [];
    state.profileById.clear();
    if (!userId) {
      renderRequestsAndFriends();
      resultsBox.replaceChildren();
      return;
    }

    friendshipsChannel = supabase
      .channel(`friendships-${userId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "friendships"
      }, (payload) => {
        const row = payload.new || payload.old;
        if (row?.requester_id === userId || row?.addressee_id === userId) {
          void refreshFriends();
        }
      })
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          void refreshFriends();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("GadLink friendships Realtime:", error || status);
          setStatus("Не удалось подключить обновление друзей. Данные обновятся при возвращении в раздел.");
        }
      });
  });

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
      const visibleUsers = users.filter(
        person => person.id !== user.id
      );
      const profileById = await getPublicProfileNames(visibleUsers.map((person) => person.id));
      state.searchResults = visibleUsers.map((person) => ({
        ...person,
        ...profileById.get(person.id)
      }));

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

  contactsFilter?.addEventListener("input", renderContacts);
}
