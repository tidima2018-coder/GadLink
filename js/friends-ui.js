
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
const statusBox = document.getElementById("friend-status");
const contactsFilter = document.getElementById("contacts-filter");
const contactsList = document.getElementById("contacts-list");
const contactsEmpty = document.getElementById("contacts-empty");
const requestsToggle = document.getElementById("friend-requests-toggle");
const requestsPanel = document.getElementById("friend-requests-panel");
const requestsCount = document.getElementById("friend-requests-count");
const navRequestsCount = document.getElementById("friend-requests-nav-count");
const publicProfileDialog = document.getElementById("public-profile-dialog");
const publicProfileName = document.getElementById("public-profile-name");
const publicProfileAbout = document.getElementById("public-profile-about");
const publicProfileAvatarImage = document.getElementById("public-profile-avatar-image");
const publicProfileAvatarPlaceholder = document.getElementById("public-profile-avatar-placeholder");
const EMPTY_ABOUT_TEXT = "Информация о себе не указана";
const ABOUT_LOADING_TEXT = "Загружаем информацию о себе…";
const ABOUT_LOAD_ERROR_TEXT = "Не удалось загрузить описание профиля. Проверьте подключение и попробуйте снова.";

if (
  section &&
  navButton &&
  searchForm &&
  searchInput &&
  resultsBox &&
  requestsBox &&
  statusBox &&
  requestsToggle &&
  requestsPanel &&
  requestsCount &&
  navRequestsCount &&
  publicProfileDialog &&
  publicProfileName &&
  publicProfileAbout &&
  publicProfileAvatarImage &&
  publicProfileAvatarPlaceholder
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
  let friendshipsSessionVersion = 0;
  let friendshipsChannelTransition = Promise.resolve();
  let friendsRefreshTimer = null;
  let publicProfileOpener = null;
  let publicProfileUserId = null;
  let publicProfileCloseTimer = null;
  let publicProfileRequestId = 0;
  const publicProfileAboutVersions = new Map();

  function closePublicProfile(restoreFocus = true) {
    publicProfileRequestId += 1;
    clearTimeout(publicProfileCloseTimer);
    publicProfileDialog.classList.remove("is-open");
    publicProfileDialog.setAttribute("inert", "");
    publicProfileCloseTimer = setTimeout(() => {
      publicProfileDialog.hidden = true;
      publicProfileDialog.removeAttribute("inert");
      publicProfileCloseTimer = null;
    }, 180);
    if (restoreFocus) {
      const focusTarget = publicProfileOpener?.closest("[hidden]")
        ? document.getElementById("add-contact-button")
        : publicProfileOpener;
      if (focusTarget?.isConnected) focusTarget.focus();
    }
    publicProfileOpener = null;
    publicProfileUserId = null;
  }

  function setPublicProfileAvatar(profile) {
    publicProfileAvatarPlaceholder.textContent = (profile?.username || "?").trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "?";
    publicProfileAvatarPlaceholder.hidden = false;
    publicProfileAvatarImage.onload = null;
    publicProfileAvatarImage.onerror = null;
    publicProfileAvatarImage.hidden = true;
    publicProfileAvatarImage.removeAttribute("src");
    if (profile?.avatar_url && /^https?:\/\//i.test(profile.avatar_url)) {
      publicProfileAvatarImage.onload = () => {
        publicProfileAvatarImage.hidden = false;
        publicProfileAvatarPlaceholder.hidden = true;
      };
      publicProfileAvatarImage.onerror = () => {
        publicProfileAvatarImage.hidden = true;
        publicProfileAvatarPlaceholder.hidden = false;
      };
      publicProfileAvatarImage.src = profile.avatar_url;
    }
  }

  async function openPublicProfile(profile, opener) {
    if (!profile?.id) return;
    const profileId = profile.id;
    const requestId = ++publicProfileRequestId;
    const aboutVersion = publicProfileAboutVersions.get(profileId) || 0;
    publicProfileUserId = profileId;
    publicProfileOpener = opener instanceof HTMLElement ? opener : document.activeElement;
    publicProfileName.textContent = profile.username?.trim() || "Пользователь";
    publicProfileAbout.textContent = ABOUT_LOADING_TEXT;
    setPublicProfileAvatar(profile);
    window.dispatchEvent(new CustomEvent("gadlink:friend-profile-open"));
    publicProfileDialog.hidden = false;
    publicProfileDialog.removeAttribute("inert");
    requestAnimationFrame(() => publicProfileDialog.classList.add("is-open"));
    publicProfileDialog.querySelector(".public-profile-dialog__close")?.focus();
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,about")
        .eq("id", profileId)
        .maybeSingle();
      if (error) throw error;
      if (requestId !== publicProfileRequestId || publicProfileDialog.hidden || publicProfileUserId !== profileId) return;
      if ((publicProfileAboutVersions.get(profileId) || 0) !== aboutVersion) return;
      if (!data || data.id !== profileId) {
        console.error("GadLink public profile about load failed:", "PROFILE_ROW_NOT_VISIBLE");
        publicProfileAbout.textContent = ABOUT_LOAD_ERROR_TEXT;
        return;
      }
      publicProfileAbout.textContent = data.about?.trim() || EMPTY_ABOUT_TEXT;
    } catch (error) {
      console.error("GadLink public profile about load failed:", error?.code || "UNKNOWN_ERROR");
      if (requestId === publicProfileRequestId && !publicProfileDialog.hidden && publicProfileUserId === profileId &&
          (publicProfileAboutVersions.get(profileId) || 0) === aboutVersion) {
        publicProfileAbout.textContent = ABOUT_LOAD_ERROR_TEXT;
      }
    }
  }

  window.addEventListener("gadlink:open-chat-profile", (event) => {
    const details = event.detail || {};
    if (!details.userId) return;
    const cachedProfile = state.profileById.get(details.userId) || {};
    void openPublicProfile({
      ...cachedProfile,
      id: details.userId,
      username: cachedProfile.username || details.username,
      avatar_url: cachedProfile.avatar_url || details.avatarUrl || null
    }, details.opener);
  });

  publicProfileDialog.querySelectorAll("[data-public-profile-close]").forEach((button) => {
    button.addEventListener("click", () => closePublicProfile());
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !publicProfileDialog.hidden) {
      event.preventDefault();
      closePublicProfile();
    }
  });

  function updateIncomingRequestBadges(count) {
    const label = count > 99 ? "99+" : String(count);
    requestsCount.textContent = label;
    navRequestsCount.textContent = label;
    requestsCount.hidden = count === 0;
    navRequestsCount.hidden = count === 0;
    requestsToggle.setAttribute(
      "aria-label",
      count ? `Заявки в друзья: ${count}` : "Заявки в друзья"
    );
  }

  function scheduleFriendsRefresh() {
    clearTimeout(friendsRefreshTimer);
    friendsRefreshTimer = setTimeout(() => {
      friendsRefreshTimer = null;
      if (!friendshipsChannelUserId) return;
      void refreshFriends();
    }, 120);
  }

  function enqueueFriendshipsChannelTransition(transition) {
    friendshipsChannelTransition = friendshipsChannelTransition
      .catch((error) => console.error("GadLink friendships channel cleanup:", error))
      .then(transition);
  }

  function setRequestsPanelOpen(open) {
    requestsPanel.hidden = !open;
    requestsToggle.setAttribute("aria-expanded", String(open));
  }

  requestsToggle.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("gadlink:friend-requests-open"));
    setRequestsPanelOpen(requestsPanel.hidden);
  });
  window.addEventListener("gadlink:friend-add-open", () => setRequestsPanelOpen(false));
  document.addEventListener("click", (event) => {
    if (!requestsPanel.hidden && !(event.target instanceof Element && event.target.closest(".friend-requests-menu"))) {
      setRequestsPanelOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !requestsPanel.hidden) {
      setRequestsPanelOpen(false);
      requestsToggle.focus();
    }
  });

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

    #friends-section .friend-item--search {
      padding: 13px;
      border-color: rgba(238,145,165,.17);
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(47,38,46,.92), rgba(31,28,34,.96));
      transition: border-color .18s ease, transform .18s ease, background .18s ease;
    }
    #friends-section .friend-item--search:hover {
      border-color: rgba(238,145,165,.42);
      background: linear-gradient(135deg, rgba(58,43,53,.96), rgba(35,30,36,.98));
      transform: translateY(-1px);
    }

    #friends-section .friend-person {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      min-width: 0;
      gap: 12px;
      padding: 0;
      border: 0;
      border-radius: 10px;
      color: inherit;
      background: transparent;
      box-shadow: none;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    #friends-section .friend-person:hover:not(:disabled) {
      color: inherit;
      border-color: transparent;
      background: transparent;
      box-shadow: none;
    }
    #friends-section .friend-person:focus-visible {
      outline: 2px solid #ee91a5;
      outline-offset: 3px;
    }
    #friends-section .friend-item--search .friend-person::after {
      margin-left: auto;
      color: #d99aa8;
      content: "›";
      font-size: 24px;
      line-height: 1;
    }

    #friends-section .friend-avatar {
      display: grid;
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      overflow: hidden;
      border-radius: 50%;
      place-items: center;
      border: 1px solid rgba(238,145,165,.3);
      color: #f4c4cd;
      background: linear-gradient(145deg, #67404d, #302832);
    }

    #friends-section .friend-avatar__image {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    #friends-section .friend-username {
      overflow-wrap: anywhere;
      font-size: 15px;
      font-weight: 700;
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
    statusBox.textContent = "";
    if (message) window.dispatchEvent(new CustomEvent("gadlink:activity-error", { detail: { message } }));
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
  function personCard(profile, actions = [], variant = "default") {
    const card = document.createElement("div");
    card.className = `friend-item${variant === "search" ? " friend-item--search" : ""}`;

    const person = document.createElement("button");
    person.type = "button";
    person.className = "friend-person";
    person.setAttribute("aria-label", `Открыть профиль: ${profile?.username || "Пользователь"}`);
    person.addEventListener("click", () => openPublicProfile(profile, person));

    const avatar = document.createElement("span");
    avatar.className = "friend-avatar";
    avatar.setAttribute("aria-hidden", "true");
    if (profile?.id) avatar.dataset.profileAvatarUserId = profile.id;

    if (
      profile?.avatar_url &&
      /^https?:\/\//i.test(profile.avatar_url)
    ) {
      const image = document.createElement("img");

      image.className = "friend-avatar__image";
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.src = profile.avatar_url;
      image.addEventListener("error", () => {
        image.remove();
        avatar.textContent = (profile?.username || "?").trim().slice(0, 1).toLocaleUpperCase("ru-RU");
      }, { once: true });

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
      .map((link) => ({ link, profile: profileFor(otherId(link)) }))
      .filter(({ profile }) => (profile.username || "Пользователь").toLocaleLowerCase().includes(query))
      .sort((a, b) => (a.profile.username || "").localeCompare(b.profile.username || "", "ru"));

    contactsList.replaceChildren();
    contactsEmpty.hidden = friends.length > 0;
    for (const { link, profile } of friends) {
      const row = document.createElement("article");
      row.className = "contact-row";
      const identity = document.createElement("button");
      identity.type = "button";
      identity.className = "contact-identity";
      identity.setAttribute("aria-label", `Открыть профиль: ${profile.username || "Пользователь"}`);
      identity.addEventListener("click", () => openPublicProfile(profile, identity));

      const avatar = document.createElement("span");
      avatar.className = "contact-avatar contact-avatar--placeholder";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = (profile.username || "?").trim().slice(0, 1).toLocaleUpperCase("ru-RU");
      if (profile.id) avatar.dataset.profileAvatarUserId = profile.id;
      if (profile.avatar_url && /^https?:\/\//i.test(profile.avatar_url)) {
        const image = document.createElement("img");
        image.src = profile.avatar_url;
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => {
          image.remove();
          avatar.textContent = (profile.username || "?").trim().slice(0, 1).toLocaleUpperCase("ru-RU");
        }, { once: true });
        avatar.replaceChildren(image);
      }
      identity.append(avatar);

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

      const removeButton = createButton("Удалить из друзей", async () => {
        await removeFriend(link.id);
        await refreshFriends();
        setStatus("Пользователь удалён из друзей.");
      });
      removeButton.className = "contact-remove-button";
      const trashIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      trashIcon.setAttribute("viewBox", "0 0 24 24");
      trashIcon.setAttribute("aria-hidden", "true");
      const trashPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      trashPath.setAttribute("d", "M8 3h8l1 2h4v2H3V5h4l1-2Zm-3 6h14l-1 12H6L5 9Zm4 2v8h2v-8H9Zm4 0v8h2v-8h-2Z");
      trashIcon.append(trashPath);
      removeButton.prepend(trashIcon);

      const actions = document.createElement("div");
      actions.className = "contact-actions";
      actions.append(chatButton, removeButton);
      row.append(identity, actions);
      contactsList.append(row);
    }
  }

  // Входящие заявки и список друзей
  function renderRequestsAndFriends() {
    requestsBox.replaceChildren();

    const incoming = state.links.filter(
      link =>
        link.status === "pending" &&
        link.addressee_id === state.userId
    );
    updateIncomingRequestBadges(incoming.length);

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

      resultsBox.append(personCard(person, [action], "search"));
    }
  }

  function mergeProfileData(previous, next) {
    const merged = { ...(previous || {}) };
    for (const [key, value] of Object.entries(next || {})) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  window.addEventListener("gadlink:profile-updated", (event) => {
    const profile = event.detail;
    if (!profile?.id) return;
    if (Object.prototype.hasOwnProperty.call(profile, "about")) {
      publicProfileAboutVersions.set(profile.id, (publicProfileAboutVersions.get(profile.id) || 0) + 1);
    }
    if (state.profileById.has(profile.id)) {
      state.profileById.set(profile.id, mergeProfileData(state.profileById.get(profile.id), profile));
    }
    state.searchResults = state.searchResults.map((item) => item.id === profile.id ? mergeProfileData(item, profile) : item);
    if (publicProfileUserId === profile.id && !publicProfileDialog.hidden) {
      publicProfileName.textContent = profile.username?.trim() || "Пользователь";
      if (Object.prototype.hasOwnProperty.call(profile, "about")) {
        publicProfileAbout.textContent = profile.about?.trim() || EMPTY_ABOUT_TEXT;
      }
      setPublicProfileAvatar(profile);
    }
    if (state.profileById.has(profile.id) || state.searchResults.some((item) => item.id === profile.id)) {
      renderRequestsAndFriends();
      renderSearch();
    }
  });

  // Загружаем друзей из Supabase
  async function refreshFriends() {
    if (state.loading) {
      state.refreshPending = true;
      return;
    }

    const sessionVersion = friendshipsSessionVersion;
    state.loading = true;

    try {
      const {
        data: { user },
        error: userError
      } = await supabase.auth.getUser();

      if (sessionVersion !== friendshipsSessionVersion) return;
      if (userError || !user) {
        state.userId = null;
        state.links = [];
        state.searchResults = [];
        updateIncomingRequestBadges(0);
        setRequestsPanelOpen(false);

        requestsBox.replaceChildren();
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
      if (sessionVersion !== friendshipsSessionVersion || state.userId !== user.id) return;

      state.links = links || [];
      updateIncomingRequestBadges(state.links.filter(
        (link) => link.status === "pending" && link.addressee_id === user.id
      ).length);

      const ids = [...new Set(state.links.map(otherId))];
      state.profileById = await getPublicProfileNames(ids);
      if (sessionVersion !== friendshipsSessionVersion || state.userId !== user.id) return;

      renderRequestsAndFriends();
      renderSearch();

      setStatus("");

    } catch (error) {
      if (sessionVersion !== friendshipsSessionVersion) return;
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
    if (friendshipsChannelUserId === userId) {
      if (userId) scheduleFriendsRefresh();
      return;
    }
    const sessionVersion = ++friendshipsSessionVersion;
    const previousChannel = friendshipsChannel;
    friendshipsChannel = null;
    friendshipsChannelUserId = userId;
    state.userId = userId;
    state.links = [];
    state.profileById.clear();
    clearTimeout(friendsRefreshTimer);
    friendsRefreshTimer = null;
    setRequestsPanelOpen(false);
    renderRequestsAndFriends();
    resultsBox.replaceChildren();
    if (!userId) {
      enqueueFriendshipsChannelTransition(async () => {
        if (previousChannel) await supabase.removeChannel(previousChannel);
      });
      return;
    }

    const activateFriendshipsChannel = () => {
      if (sessionVersion !== friendshipsSessionVersion || friendshipsChannelUserId !== userId) return;
      friendshipsChannel = supabase
        .channel(`friendships-${userId}`)
        .on("postgres_changes", {
          event: "*",
          schema: "public",
          table: "friendships"
        }, () => {
          // DELETE payloads may contain only the primary key under RLS. Always
          // reload the user's visible rows instead of inspecting old/new data.
          if (sessionVersion === friendshipsSessionVersion) scheduleFriendsRefresh();
        })
        .subscribe((status, error) => {
          if (sessionVersion !== friendshipsSessionVersion) return;
          if (status === "SUBSCRIBED") {
            scheduleFriendsRefresh();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            console.error("GadLink friendships Realtime:", error || status);
            setStatus("Соединение с обновлениями друзей прервано. Данные синхронизируются после восстановления связи.");
          }
        });
    };

    enqueueFriendshipsChannelTransition(async () => {
      if (previousChannel) await supabase.removeChannel(previousChannel);
      activateFriendshipsChannel();
    });
  });

  window.addEventListener("online", scheduleFriendsRefresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleFriendsRefresh();
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
      state.searchResults = visibleUsers.map((person) => {
        const merged = { ...person };
        for (const [key, value] of Object.entries(profileById.get(person.id) || {})) {
          if (value !== undefined) merged[key] = value;
        }
        return merged;
      });

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
