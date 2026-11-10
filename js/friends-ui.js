
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

      const callButton = document.createElement("button");
      callButton.type = "button";
      callButton.className = "contact-call-button";
      callButton.setAttribute("aria-label", `Позвонить ${name.textContent}`);
      callButton.title = "Голосовой звонок";
      callButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3H4.8A1.8 1.8 0 0 0 3 4.8C3 13.7 10.3 21 19.2 21a1.8 1.8 0 0 0 1.8-1.8V17l-5-2-1.8 2.2a14.5 14.5 0 0 1-6.4-6.4L10 9Z"/></svg>';
      callButton.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("gadlink:start-voice-call", {
          detail: {
            userId: profile.id,
            username: profile.username || "Пользователь",
            avatarUrl: profile.avatar_url || null
          }
        }));
      });

      row.append(identity, chatButton, callButton);
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
      const call = createButton("Позвонить", () => {
        window.dispatchEvent(new CustomEvent("gadlink:start-voice-call", {
          detail: {
            userId: friend.id,
            username: friend.username || "Пользователь",
            avatarUrl: friend.avatar_url || null
          }
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
          [message, call, remove]
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

      const ids = [...new Set(state.links.map(otherId))];
      state.profileById = await getPublicProfileNames(ids);

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
