import { getPublicProfileNames } from "./friends.js";

const REELS_BUCKET = "reels";
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|ogg)$/i;

export function createReelsFeed({ supabase, getUser }) {
  const container = document.getElementById("reels-container");
  const status = document.getElementById("reels-status");
  const commentsPanel = document.getElementById("reels-comments");
  const commentsList = document.getElementById("reels-comments-list");
  const commentForm = document.getElementById("reels-comment-form");
  const commentInput = document.getElementById("reels-comment-input");
  const searchInput = document.getElementById("reels-search");
  const cardsByPath = new Map();
  const videoUrls = new Map();
  let observer = null;
  let activeVideo = null;
  let activePath = null;
  let commentsPath = null;
  let loading = false;
  let loaded = false;
  let sectionActive = false;
  let interactionsReady = false;
  let soundEnabled = false;
  let wheelLocked = false;
  let activationId = 0;

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  }

  function userId() {
    return getUser()?.id || null;
  }

  async function listBucket(prefix = "") {
    const { data, error } = await supabase.storage
      .from(REELS_BUCKET)
      .list(prefix, { limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;

    const files = [];
    for (const entry of data || []) {
      const path = [prefix.replace(/\/$/, ""), entry.name].filter(Boolean).join("/");
      if (entry.id == null && !entry.metadata) {
        files.push(...await listBucket(path));
      } else if (VIDEO_EXTENSIONS.test(entry.name) || entry.metadata?.mimetype?.startsWith("video/")) {
        files.push({ path, name: entry.name });
      }
    }
    return files;
  }

  async function getVideoUrl(path) {
    if (videoUrls.has(path)) return videoUrls.get(path);
    const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUrl(path, 3600);
    if (!error && data?.signedUrl) {
      videoUrls.set(path, data.signedUrl);
      return data.signedUrl;
    }
    const { data: publicData } = supabase.storage.from(REELS_BUCKET).getPublicUrl(path);
    if (publicData?.publicUrl) {
      videoUrls.set(path, publicData.publicUrl);
      return publicData.publicUrl;
    }
    throw error || new Error("Не удалось получить ссылку на видео.");
  }

  async function checkInteractionTables() {
    if (!userId()) throw new Error("Войдите в аккаунт, чтобы использовать действия Reels.");
    const { error } = await supabase.from("reel_likes").select("reel_path").limit(1);
    if (error) throw error;
    interactionsReady = true;
  }

  function disableDbActions(error) {
    interactionsReady = false;
    container.querySelectorAll("[data-db-action]").forEach((button) => {
      button.disabled = true;
      button.title = "Действие станет доступно после подключения таблиц Reels";
    });
    setStatus(`Видео загружены. Лайки, комментарии и сохранения отключены: ${error.message}. Подготовлен файл supabase/reels.sql.`, true);
  }

  async function refreshStats(card, path) {
    if (!interactionsReady) return;
    const [likes, comments, liked, saved] = await Promise.all([
      supabase.from("reel_likes").select("user_id", { count: "exact", head: true }).eq("reel_path", path),
      supabase.from("reel_comments").select("id", { count: "exact", head: true }).eq("reel_path", path),
      supabase.from("reel_likes").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1),
      supabase.from("reel_saves").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1)
    ]);
    const failure = [likes, comments, liked, saved].find((result) => result.error);
    if (failure) throw failure.error;
    card.querySelector('[data-count="likes"]').textContent = new Intl.NumberFormat("ru-RU").format(likes.count ?? 0);
    card.querySelector('[data-count="comments"]').textContent = new Intl.NumberFormat("ru-RU").format(comments.count ?? 0);
    card.querySelector('[data-action="like"]').classList.toggle("is-active", Boolean(liked.data?.length));
    card.querySelector('[data-action="save"]').classList.toggle("is-active", Boolean(saved.data?.length));
  }

  function makeCard(file) {
    const card = document.createElement("article");
    card.className = "reel-card";
    card.dataset.path = file.path;
    card.dataset.search = file.path.toLocaleLowerCase();

    const video = document.createElement("video");
    video.className = "reel-video";
    video.autoplay = true;
    video.playsInline = true;
    video.loop = true;
    video.muted = true;
    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.preload = "none";
    video.setAttribute("aria-label", `Видео ${file.name}`);

    const heart = document.createElement("span");
    heart.className = "reel-heart-burst";
    heart.textContent = "♥";
    heart.setAttribute("aria-hidden", "true");

    const playIndicator = document.createElement("span");
    playIndicator.className = "reel-play-indicator";
    playIndicator.textContent = "▶";
    playIndicator.setAttribute("aria-hidden", "true");

    const actions = document.createElement("div");
    actions.className = "reel-actions";
    actions.innerHTML = `
      <button type="button" class="reel-action" data-action="like" data-db-action aria-label="Лайк"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.8 8.7c0 5-8.8 10.1-8.8 10.1S3.2 13.7 3.2 8.7A4.7 4.7 0 0 1 12 6.2a4.7 4.7 0 0 1 8.8 2.5Z"/></svg></span><small data-count="likes">—</small></button>
      <button type="button" class="reel-action" data-action="comments" data-db-action aria-label="Комментарии"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.5 11.4a8.4 8.4 0 0 1-8.5 8.1 9 9 0 0 1-3.7-.8L3 20l1.4-4.5a7.6 7.6 0 0 1-1-4.1A8.4 8.4 0 0 1 12 3.3a8.4 8.4 0 0 1 8.5 8.1Z"/></svg></span><small data-count="comments">—</small></button>
      <button type="button" class="reel-action" data-action="share" aria-label="Отправить"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m21 3-7.2 18-3.7-7.1L3 10.2 21 3Z"/><path d="m10.1 13.9 4.8-4.8"/></svg></span><small>Отправить</small></button>
      <button type="button" class="reel-action" data-action="save" data-db-action aria-label="Сохранить"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-4-6 4V4.8Z"/></svg></span><small>Сохранить</small></button>
      <button type="button" class="reel-action" data-action="sound" aria-label="Включить звук"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path class="sound-wave" d="M16 9a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/><path class="sound-muted" d="m17 9 5 6m0-6-5 6"/></svg></span><small>Звук</small></button>`;

    const progress = document.createElement("input");
    progress.className = "reel-progress";
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.step = "any";
    progress.value = "0";
    progress.setAttribute("aria-label", "Прогресс видео");

    const stage = document.createElement("div");
    stage.className = "reel-stage";
    const duration = document.createElement("span");
    duration.className = "reel-duration";
    duration.textContent = "0:00";
    stage.append(video, heart, playIndicator, duration, progress);
    card.append(stage, actions);
    bindCard(card, file.path, video, heart, playIndicator, progress);
    return card;
  }

  function animateHeart(heart) {
    heart.classList.remove("is-animating");
    void heart.offsetWidth;
    heart.classList.add("is-animating");
    window.setTimeout(() => heart.classList.remove("is-animating"), 750);
  }

  function animateLikeButton(button) {
    button.classList.remove("is-pulsing");
    void button.offsetWidth;
    button.classList.add("is-pulsing");
    window.setTimeout(() => button.classList.remove("is-pulsing"), 420);
  }

  function togglePlayback(video, indicator) {
    if (video.paused) {
      video.play().then(() => indicator.classList.remove("is-visible")).catch(() => indicator.classList.add("is-visible"));
    } else {
      video.pause();
      indicator.classList.add("is-visible");
    }
  }

  function bindCard(card, path, video, heart, indicator, progress) {
    let clickTimer = 0;
    let lastTouchAt = 0;
    let lastTapAt = 0;
    let progressFrame = 0;
    let isSeeking = false;

    const syncProgress = () => {
      if (!isSeeking && Number.isFinite(video.duration) && video.duration > 0) {
        const ratio = Math.min(1, Math.max(0, video.currentTime / video.duration));
        progress.value = String(ratio * Number(progress.max));
      }
    };
    const updateProgress = () => {
      progressFrame = 0;
      syncProgress();
      if (!video.paused && !video.ended) {
        progressFrame = window.requestAnimationFrame(updateProgress);
      }
    };

    video.addEventListener("click", () => {
      if (Date.now() - lastTouchAt < 450) return;
      if (clickTimer) window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        if (activeVideo !== video) activateCard(card);
        else togglePlayback(video, indicator);
      }, 230);
    });
    video.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (clickTimer) window.clearTimeout(clickTimer);
      if (interactionsReady) { animateHeart(heart); toggleLike(card, path); }
    });
    video.addEventListener("touchend", (event) => {
      if (event.changedTouches.length !== 1) return;
      lastTouchAt = Date.now();
      if (lastTouchAt - lastTapAt < 280) {
        if (clickTimer) window.clearTimeout(clickTimer);
        lastTapAt = 0;
        if (interactionsReady) { animateHeart(heart); toggleLike(card, path); }
      } else {
        lastTapAt = lastTouchAt;
        clickTimer = window.setTimeout(() => {
          if (activeVideo !== video) activateCard(card);
          else togglePlayback(video, indicator);
        }, 290);
      }
    }, { passive: true });
    video.addEventListener("play", () => {
      if (!progressFrame) progressFrame = window.requestAnimationFrame(updateProgress);
    });
    video.addEventListener("timeupdate", syncProgress);
    video.addEventListener("pause", syncProgress);
    video.addEventListener("ended", syncProgress);
    video.addEventListener("seeked", syncProgress);
    video.addEventListener("loadedmetadata", () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const ratio = video.videoWidth / video.videoHeight;
        const stage = card.querySelector(".reel-stage");
        stage.style.setProperty("--reel-aspect", `${ratio} / 1`);
        fitStage(card, video);
      }
      const duration = card.querySelector(".reel-duration");
      if (!Number.isFinite(video.duration)) return;
      const minutes = Math.floor(video.duration / 60);
      const seconds = Math.floor(video.duration % 60).toString().padStart(2, "0");
      duration.textContent = `${minutes}:${seconds}`;
    });
    video.addEventListener("waiting", () => card.classList.add("is-buffering"));
    video.addEventListener("canplay", () => card.classList.remove("is-buffering"));
    video.addEventListener("error", () => {
      card.classList.add("has-error");
      setStatus("Не удалось загрузить одно из видео.", true);
    });
    video.addEventListener("canplay", () => fitStage(card, video));
    progress.addEventListener("input", () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration * Number(progress.value) / Number(progress.max);
      }
    });
    progress.addEventListener("pointerdown", () => { isSeeking = true; });
    progress.addEventListener("pointerup", () => { isSeeking = false; });
    progress.addEventListener("pointercancel", () => { isSeeking = false; });
    progress.addEventListener("keydown", () => { isSeeking = true; });
    progress.addEventListener("keyup", () => { isSeeking = false; });
    progress.addEventListener("change", () => { isSeeking = false; });
    progress.addEventListener("blur", () => { isSeeking = false; });
    card.querySelector(".reel-actions").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "like") toggleLike(card, path);
      if (action === "comments") openComments(path);
      if (action === "save") toggleSave(card, path);
      if (action === "share") share(path);
      if (action === "sound") toggleSound(video);
    });
  }

  function toggleSound(active) {
    soundEnabled = !soundEnabled;
    container.querySelectorAll("video").forEach((video) => { video.muted = !soundEnabled; });
    syncSoundControls();
    if (active.paused) active.play().catch(() => {});
  }

  function syncSoundControls() {
    container.querySelectorAll('[data-action="sound"]').forEach((button) => {
      button.setAttribute("aria-label", soundEnabled ? "Выключить звук" : "Включить звук");
      button.classList.toggle("is-active", soundEnabled);
    });
  }

  function playVideo(video, card) {
    const indicator = card.querySelector(".reel-play-indicator");
    video.play()
      .then(() => indicator.classList.remove("is-visible"))
      .catch(async () => {
        // If autoplay with sound is blocked, retry muted; browsers allow muted inline autoplay.
        if (!video.muted) {
          soundEnabled = false;
          container.querySelectorAll("video").forEach((item) => { item.muted = true; });
          syncSoundControls();
          try {
            await video.play();
            indicator.classList.remove("is-visible");
            return;
          } catch { /* show the play control if the browser still requires a user gesture */ }
        }

        indicator.classList.add("is-visible");
      });
  }

  function fitStage(card, video) {
    if (!video.videoWidth || !video.videoHeight) return;
    const stage = card.querySelector(".reel-stage");
    const ratio = video.videoWidth / video.videoHeight;
    const isMobile = window.matchMedia("(max-width: 720px)").matches;
    const availableWidth = Math.max(0, card.clientWidth - (isMobile ? 66 : 220));
    const availableHeight = card.clientHeight;
    if (!availableWidth || !availableHeight) return;

    const width = Math.min(availableWidth, availableHeight * ratio);
    stage.style.width = `${width}px`;
    stage.style.height = `${width / ratio}px`;
  }

  async function toggleLike(card, path) {
    if (!interactionsReady) return;
    const button = card.querySelector('[data-action="like"]');
    button.disabled = true;
    try {
      const { data, error } = await supabase.from("reel_likes").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1);
      if (error) throw error;
      const addingLike = !data?.length;
      const result = !addingLike
        ? await supabase.from("reel_likes").delete().eq("reel_path", path).eq("user_id", userId())
        : await supabase.from("reel_likes").insert({ reel_path: path, user_id: userId() });
      if (result.error) throw result.error;
      if (addingLike) animateLikeButton(button);
      await refreshStats(card, path);
    } catch (error) { disableDbActions(error); }
    finally { button.disabled = !interactionsReady; }
  }

  async function toggleSave(card, path) {
    if (!interactionsReady) return;
    const button = card.querySelector('[data-action="save"]');
    button.disabled = true;
    try {
      const { data, error } = await supabase.from("reel_saves").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1);
      if (error) throw error;
      const result = data?.length
        ? await supabase.from("reel_saves").delete().eq("reel_path", path).eq("user_id", userId())
        : await supabase.from("reel_saves").insert({ reel_path: path, user_id: userId() });
      if (result.error) throw result.error;
      await refreshStats(card, path);
    } catch (error) { disableDbActions(error); }
    finally { button.disabled = !interactionsReady; }
  }

  async function openComments(path) {
    commentsPath = path;
    commentsPanel.hidden = false;
    commentsList.replaceChildren();
    if (!interactionsReady) {
      commentsList.textContent = "Комментарии станут доступны после подключения таблиц Reels и входа в аккаунт.";
      return;
    }
    const { data, error } = await supabase.from("reel_comments")
      .select("id,user_id,content,created_at")
      .eq("reel_path", path).order("created_at", { ascending: true }).limit(100);
    if (error) { commentsList.textContent = error.message; disableDbActions(error); return; }
    let namesById;
    try {
      namesById = await getPublicProfileNames((data || []).map((comment) => comment.user_id));
    } catch (nameError) {
      console.error("GadLink Reel profile names:", nameError);
      setStatus(`Не удалось загрузить имена авторов комментариев: ${nameError.message}`, true);
      namesById = new Map();
    }
    if (!data?.length) commentsList.textContent = "Пока нет комментариев.";
    for (const comment of data || []) {
      const row = document.createElement("p");
      row.className = "reel-comment";
      const name = document.createElement("strong");
      name.textContent = namesById.get(comment.user_id)?.username || "Пользователь";
      const text = document.createElement("span");
      text.textContent = comment.content;
      row.append(name, text);
      if (comment.user_id === userId()) {
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "reel-comment-delete";
        removeButton.textContent = "Удалить";
        removeButton.setAttribute("aria-label", "Удалить свой комментарий");
        removeButton.addEventListener("click", () => deleteComment(comment.id, path, removeButton));
        row.append(removeButton);
      }
      commentsList.append(row);
    }
  }

  async function deleteComment(commentId, path, button) {
    button.disabled = true;
    const { error } = await supabase.from("reel_comments")
      .delete().eq("id", commentId).eq("reel_path", path).eq("user_id", userId());
    if (error) {
      const notice = document.createElement("small");
      notice.className = "reel-comment-error";
      notice.textContent = `Не удалось удалить: ${error.message}`;
      button.insertAdjacentElement("afterend", notice);
      button.disabled = false;
      return;
    }
    await openComments(path);
    const card = cardsByPath.get(path);
    if (card) await refreshStats(card, path);
  }

  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = commentInput.value.trim();
    if (!content || !commentsPath || !interactionsReady) return;
    const { error } = await supabase.from("reel_comments").insert({ reel_path: commentsPath, user_id: userId(), content });
    if (error) { commentsList.textContent = error.message; disableDbActions(error); return; }
    commentInput.value = "";
    await openComments(commentsPath);
    const card = cardsByPath.get(commentsPath);
    if (card) await refreshStats(card, commentsPath);
  });

  document.getElementById("reels-comments-close").addEventListener("click", () => {
    commentsPanel.hidden = true;
    commentsPath = null;
  });

  async function share(path) {
    const url = new URL(window.location.href);
    url.searchParams.set("reel", path);
    try {
      if (navigator.share) await navigator.share({ title: "GadLink Reels", url: url.href });
      else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url.href);
        setStatus("Ссылка на видео скопирована.");
      } else setStatus(url.href);
    } catch (error) {
      if (error.name !== "AbortError") setStatus("Не удалось поделиться ссылкой.", true);
    }
  }

  function pauseAll(except = null) {
    container.querySelectorAll("video").forEach((video) => { if (video !== except) video.pause(); });
    activeVideo = except;
  }

  async function activateCard(card) {
    if (!sectionActive || document.hidden || card.hidden) return;
    const video = card.querySelector("video");
    if (activeVideo === video && !video.paused) return;
    const thisActivation = ++activationId;
    pauseAll(video);
    activePath = card.dataset.path;
    video.muted = !soundEnabled;
    video.preload = "auto";
    if (!video.src) {
      try {
        video.src = await getVideoUrl(activePath);
        if (thisActivation !== activationId || activeVideo !== video) return;
      } catch (error) {
        card.classList.add("has-error");
        setStatus(`Не удалось открыть видео: ${error.message}`, true);
        return;
      }
    }
    playVideo(video, card);
    warmNextCard(card);
    if (interactionsReady) refreshStats(card, activePath).catch(disableDbActions);
  }

  function warmNextCard(card) {
    const visibleCards = [...container.querySelectorAll(".reel-card:not([hidden])")];
    const nextCard = visibleCards[visibleCards.indexOf(card) + 1];
    const nextVideo = nextCard?.querySelector("video");
    if (!nextCard || nextCard.hidden || !nextVideo || nextVideo.src) return;

    nextVideo.preload = "auto";
    getVideoUrl(nextCard.dataset.path).then((url) => {
      if (!sectionActive || nextCard.hidden || nextVideo.src) return;
      nextVideo.src = url;
      nextVideo.load();
    }).catch((error) => {
      setStatus(`Не удалось подготовить следующее видео: ${error.message}`, true);
    });
  }

  window.addEventListener("resize", () => {
    container.querySelectorAll(".reel-card").forEach((card) => {
      const video = card.querySelector("video");
      if (video) fitStage(card, video);
    });
  });

  function observeCards() {
    observer?.disconnect();
    if (!sectionActive || document.hidden) return;
    observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.intersectionRatio >= 0.6) activateCard(visible.target);
    }, { root: container, threshold: [0.25, 0.6, 0.85] });
    container.querySelectorAll(".reel-card:not([hidden])").forEach((card) => observer.observe(card));
  }

  function filterCards() {
    const query = searchInput.value.trim().toLocaleLowerCase();
    let firstMatch = null;
    for (const card of container.querySelectorAll(".reel-card")) {
      card.hidden = Boolean(query) && !card.dataset.search.includes(query);
      if (!card.hidden && !firstMatch) firstMatch = card;
    }
    if (activeVideo?.closest(".reel-card")?.hidden) {
      activeVideo.pause();
      activeVideo = null;
      activePath = null;
    }
    if (query && !firstMatch) setStatus("По этому запросу видео не найдены.");
    else if (loaded && interactionsReady) setStatus("");
    observeCards();
    if (firstMatch) {
      const top = firstMatch.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top, behavior: "smooth" });
    }
  }

  function stepVideo(direction) {
    container.scrollBy({ top: direction * container.clientHeight, behavior: "smooth" });
  }

  async function load() {
    if (loaded || loading) return;
    loading = true;
    setStatus("Загружаем видео из Supabase Storage…");
    try {
      const files = await listBucket();
      if (!files.length) {
        loaded = true;
        setStatus("В bucket reels пока нет доступных видео.");
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const file of files) {
        const card = makeCard(file);
        cardsByPath.set(file.path, card);
        fragment.append(card);
      }
      container.append(fragment);
      loaded = true;
      setStatus("");
      filterCards();
      observeCards();
      try {
        await checkInteractionTables();
        container.querySelectorAll("[data-db-action]").forEach((button) => { button.disabled = false; });
        const activeCard = activeVideo?.closest(".reel-card");
        if (activeCard) await refreshStats(activeCard, activeCard.dataset.path);
        setStatus("");
        if (searchInput.value.trim()) filterCards();
      } catch (error) { disableDbActions(error); }
      const requestedPath = new URLSearchParams(window.location.search).get("reel");
      if (requestedPath && cardsByPath.has(requestedPath)) {
        const card = cardsByPath.get(requestedPath);
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        activateCard(card);
      }
    } catch (error) {
      setStatus(`Не удалось загрузить Reels: ${error.message}`, true);
    } finally { loading = false; }
  }

  container.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) < 20 || wheelLocked) return;
    event.preventDefault();
    wheelLocked = true;
    container.scrollBy({ top: Math.sign(event.deltaY) * container.clientHeight, behavior: "smooth" });
    window.setTimeout(() => { wheelLocked = false; }, 520);
  }, { passive: false });
  container.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) return;
    event.preventDefault();
    const direction = ["ArrowDown", "PageDown"].includes(event.key) ? 1 : -1;
    container.scrollBy({ top: direction * container.clientHeight, behavior: "smooth" });
  });
  searchInput.addEventListener("input", filterCards);
  document.getElementById("reels-prev").addEventListener("click", () => stepVideo(-1));
  document.getElementById("reels-next").addEventListener("click", () => stepVideo(1));
  document.getElementById("reels-comments").addEventListener("keydown", (event) => {
    if (event.key === "Escape") commentsPanel.hidden = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseAll();
    else if (!document.getElementById("reels-section").hidden && activePath) {
      const card = cardsByPath.get(activePath);
      if (card && !card.hidden) activateCard(card);
    }
  });
  window.addEventListener("pagehide", () => pauseAll());
  window.addEventListener("pageshow", () => {
    if (!document.hidden && !document.getElementById("reels-section").hidden && activePath) {
      const card = cardsByPath.get(activePath);
      if (card && !card.hidden) activateCard(card);
    }
  });

  return {
    activate() { sectionActive = true; load().then(() => { if (loaded) observeCards(); }); },
    deactivate() { sectionActive = false; activationId += 1; pauseAll(); observer?.disconnect(); commentsPanel.hidden = true; },
    reset() {
      this.deactivate();
      container.replaceChildren();
      cardsByPath.clear();
      videoUrls.clear();
      loaded = false;
      interactionsReady = false;
    }
  };
}
