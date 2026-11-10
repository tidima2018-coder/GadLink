import { getPublicProfileNames } from "./friends.js";

const REELS_BUCKET = "reels";
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|ogg)$/i;
const MAX_MEDIA_FILES = 10;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

export function createReelsFeed({ supabase, getUser }) {
  const container = document.getElementById("reels-container");
  const playerLayout = document.querySelector(".reels-player-layout");
  const scrollControls = document.querySelector(".reels-scroll-controls");
  const status = document.getElementById("reels-status");
  const commentsPanel = document.getElementById("reels-comments");
  const commentsList = document.getElementById("reels-comments-list");
  const commentForm = document.getElementById("reels-comment-form");
  const commentInput = document.getElementById("reels-comment-input");
  const searchInput = document.getElementById("reels-search");
  const publishDialog = document.getElementById("reel-publish-dialog");
  const publishForm = document.getElementById("reel-publish-form");
  const publishFiles = document.getElementById("reel-publish-files");
  const publishFileList = document.getElementById("reel-publish-file-list");
  const publishStatus = document.getElementById("reel-publish-status");
  const cardsByPath = new Map();
  const mediaByCard = new WeakMap();
  const mediaUrls = new Map();
  const publishPreviewUrls = [];
  let observer = null;
  let activeVideo = null;
  let activePath = null;
  let commentsPath = null;
  let loading = false;
  let loaded = false;
  let postsTableReady = false;
  let sectionActive = false;
  let interactionsReady = false;
  let repostsReady = false;
  let soundEnabled = false;
  let wheelLocked = false;
  let activationId = 0;
  let interactionsChannel = null;
  let interactionsOwnerId = null;
  let interactionRefreshTimer = null;

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

  async function getMediaUrl(path) {
    if (mediaUrls.has(path)) return mediaUrls.get(path);
    const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUrl(path, 3600);
    if (!error && data?.signedUrl) {
      mediaUrls.set(path, data.signedUrl);
      return data.signedUrl;
    }
    const { data: publicData } = supabase.storage.from(REELS_BUCKET).getPublicUrl(path);
    if (publicData?.publicUrl) {
      mediaUrls.set(path, publicData.publicUrl);
      return publicData.publicUrl;
    }
    throw error || new Error("Не удалось получить ссылку на файл.");
  }

  async function checkInteractionTables() {
    if (!userId()) throw new Error("Войдите в аккаунт, чтобы использовать действия Reels.");
    const { error } = await supabase.from("reel_likes").select("reel_path").limit(1);
    if (error) throw error;
    interactionsReady = true;
    const repostCheck = await supabase.from("reel_reposts").select("reel_path").limit(1);
    repostsReady = !repostCheck.error;
    container.querySelectorAll('[data-action="repost"]').forEach((button) => {
      button.disabled = !repostsReady;
      if (!repostsReady) button.title = "Для репостов обновите таблицы: supabase/reels.sql";
    });
  }

  function disableDbActions(error) {
    interactionsReady = false;
    container.querySelectorAll("[data-db-action]").forEach((button) => {
      button.disabled = true;
      button.title = "Действие станет доступно после подключения таблиц Reels";
    });
    setStatus(`Публикации загружены. Лайки, комментарии и сохранения отключены: ${error.message}. Подготовлен файл supabase/reels.sql.`, true);
  }

  async function refreshStats(card, path) {
    if (!interactionsReady) return;
    const [likes, comments, liked, saved, reposts, reposted] = await Promise.all([
      supabase.from("reel_likes").select("user_id", { count: "exact", head: true }).eq("reel_path", path),
      supabase.from("reel_comments").select("id", { count: "exact", head: true }).eq("reel_path", path),
      supabase.from("reel_likes").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1),
      supabase.from("reel_saves").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1),
      repostsReady
        ? supabase.from("reel_reposts").select("user_id", { count: "exact", head: true }).eq("reel_path", path)
        : Promise.resolve({ count: 0, error: null }),
      repostsReady
        ? supabase.from("reel_reposts").select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1)
        : Promise.resolve({ data: [], error: null })
    ]);
    const failure = [likes, comments, liked, saved].find((result) => result.error);
    if (failure) throw failure.error;
    card.querySelector('[data-count="likes"]').textContent = new Intl.NumberFormat("ru-RU").format(likes.count ?? 0);
    card.querySelector('[data-count="comments"]').textContent = new Intl.NumberFormat("ru-RU").format(comments.count ?? 0);
    card.querySelector('[data-count="reposts"]').textContent = new Intl.NumberFormat("ru-RU").format(reposts.count ?? 0);
    const likeButton = card.querySelector('[data-action="like"]');
    likeButton.classList.toggle("is-active", Boolean(liked.data?.length));
    likeButton.setAttribute("aria-pressed", String(Boolean(liked.data?.length)));
    likeButton.setAttribute("aria-label", liked.data?.length ? "Убрать лайк" : "Поставить лайк");
    card.querySelector('[data-action="save"]').classList.toggle("is-active", Boolean(saved.data?.length));
    const repostButton = card.querySelector('[data-action="repost"]');
    repostButton.classList.toggle("is-active", Boolean(reposted.data?.length));
    repostButton.setAttribute("aria-pressed", String(Boolean(reposted.data?.length)));
    repostButton.setAttribute("aria-label", reposted.data?.length ? "Убрать репост" : "Сделать репост");
  }

  function scheduleInteractionRefresh(payload) {
    const row = payload.new || payload.old;
    const path = row?.reel_path;
    if (!path || (path !== activePath && path !== commentsPath)) return;
    clearTimeout(interactionRefreshTimer);
    interactionRefreshTimer = window.setTimeout(async () => {
      try {
        const card = cardsByPath.get(path);
        if (card && interactionsReady) await refreshStats(card, path);
        if (commentsPath === path && !commentsPanel.hidden) await openComments(path);
      } catch (error) {
        console.error("GadLink Reels Realtime:", error);
        setStatus(`Не удалось обновить Reels: ${error.message}`, true);
      }
    }, 120);
  }

  function subscribeToInteractions() {
    const owner = userId();
    if (!sectionActive || !interactionsReady || !owner) return;
    if (interactionsChannel && interactionsOwnerId === owner) return;
    if (interactionsChannel) void supabase.removeChannel(interactionsChannel);
    interactionsOwnerId = owner;
    interactionsChannel = supabase
      .channel(`reel-interactions-${owner}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "reel_likes"
      }, scheduleInteractionRefresh)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "reel_comments"
      }, scheduleInteractionRefresh)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "reel_saves"
      }, (payload) => {
        const row = payload.new || payload.old;
        if (row?.user_id === owner) scheduleInteractionRefresh(payload);
      })
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "reel_reposts"
      }, scheduleInteractionRefresh)
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          const card = cardsByPath.get(activePath);
          if (card) void refreshStats(card, activePath).catch(disableDbActions);
          if (commentsPath && !commentsPanel.hidden) void openComments(commentsPath);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("GadLink Reels Realtime subscription:", error || status);
        }
      });
  }

  function makeCard(file) {
    const items = file.media || [{ path: file.path, name: file.name, type: "video" }];
    const path = file.path || items[0].path;
    const card = document.createElement("article");
    card.className = "reel-card";
    card.dataset.path = path;
    card.dataset.postId = file.postId || "";
    card.dataset.userId = file.userId || "";
    card.dataset.search = [
      path, file.title, file.description, ...(file.hashtags || [])
    ].filter(Boolean).join(" ").toLocaleLowerCase();

    const mediaState = { items, elements: [], index: 0 };
    const stage = document.createElement("div");
    stage.className = "reel-stage";
    items.forEach((item, index) => {
      const element = item.type === "image" ? document.createElement("img") : document.createElement("video");
      element.className = item.type === "image" ? "reel-image" : "reel-video";
      element.hidden = index !== 0;
      if (item.type === "image") {
        element.alt = file.title || "Фото публикации";
        element.draggable = false;
      } else {
        element.autoplay = true;
        element.playsInline = true;
        element.loop = true;
        element.muted = true;
        element.setAttribute("autoplay", "");
        element.setAttribute("muted", "");
        element.setAttribute("playsinline", "");
        element.preload = "none";
        element.setAttribute("aria-label", `Видео ${file.title || item.name || ""}`);
      }
      mediaState.elements.push(element);
      stage.append(element);
    });

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
      <button type="button" class="reel-action" data-action="like" data-db-action aria-label="Поставить лайк" aria-pressed="false"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.8 8.7c0 5-8.8 10.1-8.8 10.1S3.2 13.7 3.2 8.7A4.7 4.7 0 0 1 12 6.2a4.7 4.7 0 0 1 8.8 2.5Z"/></svg></span><small data-count="likes">—</small></button>
      <button type="button" class="reel-action" data-action="comments" data-db-action aria-label="Комментарии"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.5 11.4a8.4 8.4 0 0 1-8.5 8.1 9 9 0 0 1-3.7-.8L3 20l1.4-4.5a7.6 7.6 0 0 1-1-4.1A8.4 8.4 0 0 1 12 3.3a8.4 8.4 0 0 1 8.5 8.1Z"/></svg></span><small data-count="comments">—</small></button>
      <button type="button" class="reel-action" data-action="repost" data-db-action aria-label="Сделать репост" aria-pressed="false"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m17 3 4 4-4 4"/><path d="M3 11V9a2 2 0 0 1 2-2h16M7 21l-4-4 4-4"/><path d="M21 13v2a2 2 0 0 1-2 2H3"/></svg></span><small data-count="reposts">—</small></button>
      <button type="button" class="reel-action" data-action="share" aria-label="Отправить"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m21 3-7.2 18-3.7-7.1L3 10.2 21 3Z"/><path d="m10.1 13.9 4.8-4.8"/></svg></span><small>Отправить</small></button>
      <button type="button" class="reel-action" data-action="save" data-db-action aria-label="Сохранить"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-4-6 4V4.8Z"/></svg></span><small>Сохранить</small></button>
      <button type="button" class="reel-action" data-action="sound" aria-label="Включить звук"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path class="sound-wave" d="M16 9a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/><path class="sound-muted" d="m17 9 5 6m0-6-5 6"/></svg></span><small>Звук</small></button>
      ${file.userId === userId() && file.postId ? '<button type="button" class="reel-action reel-action--delete" data-action="delete" aria-label="Удалить публикацию"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg></span><small>Удалить</small></button>' : ""}`;
    actions.querySelectorAll("[data-db-action]").forEach((button) => {
      button.disabled = !interactionsReady;
    });

    const progress = document.createElement("input");
    progress.className = "reel-progress";
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.step = "any";
    progress.value = "0";
    progress.setAttribute("aria-label", "Прогресс видео");

    const duration = document.createElement("span");
    duration.className = "reel-duration";
    duration.textContent = "0:00";
    const caption = document.createElement("div");
    caption.className = "reel-caption";
    const title = document.createElement("strong");
    title.className = "reel-caption__title";
    title.textContent = file.title || "";
    const description = document.createElement("p");
    description.className = "reel-caption__description";
    description.textContent = file.description || "";
    const hashtags = document.createElement("p");
    hashtags.className = "reel-caption__hashtags";
    hashtags.textContent = (file.hashtags || []).map((tag) => `#${tag}`).join(" ");
    caption.append(title, description, hashtags);
    if (!title.textContent && !description.textContent && !hashtags.textContent) caption.hidden = true;

    const carousel = document.createElement("div");
    carousel.className = "reel-carousel";
    carousel.hidden = items.length < 2;
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "reel-carousel__previous";
    previous.setAttribute("aria-label", "Предыдущее фото");
    previous.textContent = "‹";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "reel-carousel__next";
    next.setAttribute("aria-label", "Следующее фото");
    next.textContent = "›";
    const counter = document.createElement("span");
    counter.className = "reel-carousel__counter";
    counter.textContent = `1 / ${items.length}`;
    carousel.append(previous, next, counter);
    stage.append(heart, playIndicator, duration, caption, carousel, progress);
    card.append(stage, actions);
    mediaByCard.set(card, mediaState);
    bindCard(card, path, heart, playIndicator, progress, duration, mediaState);
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

  function bindCard(card, path, heart, indicator, progress, duration, mediaState) {
    let clickTimer = 0;
    let lastTouchAt = 0;
    let lastTapAt = 0;
    let progressFrame = 0;
    let isSeeking = false;
    let pointerStart = null;
    let suppressTapUntil = 0;
    const currentMedia = () => mediaState.elements[mediaState.index];
    const currentVideo = () => currentMedia() instanceof HTMLVideoElement ? currentMedia() : null;

    const syncProgress = () => {
      const video = currentVideo();
      if (!video) return;
      if (!isSeeking && Number.isFinite(video.duration) && video.duration > 0) {
        const ratio = Math.min(1, Math.max(0, video.currentTime / video.duration));
        progress.value = String(ratio * Number(progress.max));
      }
    };
    const updateProgress = (video) => {
      progressFrame = 0;
      syncProgress();
      if (video === currentVideo() && !video.paused && !video.ended) {
        progressFrame = window.requestAnimationFrame(() => updateProgress(video));
      }
    };
    const syncMediaControls = () => {
      const isVideo = Boolean(currentVideo());
      progress.hidden = !isVideo;
      duration.hidden = !isVideo;
      indicator.hidden = !isVideo;
      card.querySelector('[data-action="sound"]').hidden = !isVideo;
      if (isVideo) syncProgress();
    };
    const setSlide = (index) => {
      if (index < 0 || index >= mediaState.items.length) return;
      if (clickTimer) window.clearTimeout(clickTimer);
      currentVideo()?.pause();
      mediaState.index = index;
      mediaState.elements.forEach((element, itemIndex) => { element.hidden = itemIndex !== index; });
      card.querySelector(".reel-carousel__counter").textContent = `${index + 1} / ${mediaState.items.length}`;
      card.classList.remove("has-error", "is-buffering");
      syncMediaControls();
      if (sectionActive) activateCard(card);
    };

    mediaState.elements.forEach((media) => {
      media.addEventListener("click", () => {
        if (Date.now() < suppressTapUntil || Date.now() - lastTouchAt < 450) return;
        if (!(media instanceof HTMLVideoElement)) return;
        if (clickTimer) window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => {
          if (currentVideo() !== media || activeVideo !== media) activateCard(card);
          else togglePlayback(media, indicator);
        }, 230);
      });
      media.addEventListener("dblclick", (event) => {
        event.preventDefault();
        if (Date.now() < suppressTapUntil) return;
        if (clickTimer) window.clearTimeout(clickTimer);
        if (interactionsReady) toggleLike(card, path);
      });
      media.addEventListener("touchend", (event) => {
        if (!(media instanceof HTMLVideoElement) || event.changedTouches.length !== 1) return;
        lastTouchAt = Date.now();
        if (lastTouchAt < suppressTapUntil) return;
        if (lastTouchAt - lastTapAt < 280) {
          if (clickTimer) window.clearTimeout(clickTimer);
          lastTapAt = 0;
          if (interactionsReady) toggleLike(card, path);
        } else {
          lastTapAt = lastTouchAt;
          clickTimer = window.setTimeout(() => {
            if (currentVideo() !== media || activeVideo !== media) activateCard(card);
            else togglePlayback(media, indicator);
          }, 290);
        }
      }, { passive: true });

      if (!(media instanceof HTMLVideoElement)) return;
      media.addEventListener("play", () => {
        if (media === currentVideo() && !progressFrame) {
          progressFrame = window.requestAnimationFrame(() => updateProgress(media));
        }
      });
      media.addEventListener("timeupdate", syncProgress);
      media.addEventListener("pause", syncProgress);
      media.addEventListener("ended", syncProgress);
      media.addEventListener("seeked", syncProgress);
      media.addEventListener("loadedmetadata", () => {
        if (media === currentVideo()) {
          fitStage(card, media);
          const minutes = Math.floor(media.duration / 60);
          const seconds = Math.floor(media.duration % 60).toString().padStart(2, "0");
          duration.textContent = `${minutes}:${seconds}`;
        }
      });
      media.addEventListener("waiting", () => card.classList.add("is-buffering"));
      media.addEventListener("canplay", () => {
        card.classList.remove("is-buffering");
        fitStage(card, media);
      });
      media.addEventListener("error", () => {
        card.classList.add("has-error");
        setStatus("Не удалось загрузить одну из публикаций.", true);
      });
    });

    mediaState.elements.forEach((media) => {
      media.addEventListener("load", () => {
        if (media === currentMedia()) fitStage(card, media);
      });
    });

    progress.addEventListener("input", () => {
      const video = currentVideo();
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
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
    card.querySelector(".reel-carousel__previous").addEventListener("click", () => {
      setSlide((mediaState.index - 1 + mediaState.items.length) % mediaState.items.length);
    });
    card.querySelector(".reel-carousel__next").addEventListener("click", () => {
      setSlide((mediaState.index + 1) % mediaState.items.length);
    });
    card.querySelector(".reel-stage").addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, input")) return;
      pointerStart = { x: event.clientX, y: event.clientY };
    });
    card.querySelector(".reel-stage").addEventListener("pointerup", (event) => {
      if (!pointerStart) return;
      const deltaX = event.clientX - pointerStart.x;
      const deltaY = event.clientY - pointerStart.y;
      pointerStart = null;
      if (mediaState.items.length < 2 || Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY)) return;
      suppressTapUntil = Date.now() + 450;
      if (clickTimer) window.clearTimeout(clickTimer);
      setSlide((mediaState.index + (deltaX < 0 ? 1 : -1) + mediaState.items.length) % mediaState.items.length);
    });
    card.querySelector(".reel-stage").addEventListener("pointercancel", () => { pointerStart = null; });
    syncMediaControls();
    card.querySelector(".reel-actions").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "like") toggleLike(card, path);
      if (action === "comments") openComments(path);
      if (action === "repost") toggleRepost(card, path);
      if (action === "save") toggleSave(card, path);
      if (action === "share") share(path);
      if (action === "delete") deletePost(card);
      if (action === "sound" && currentVideo()) toggleSound(currentVideo());
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

  function fitStage(card, media) {
    const mediaWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const mediaHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!mediaWidth || !mediaHeight) return;
    const stage = card.querySelector(".reel-stage");
    const ratio = mediaWidth / mediaHeight;
    const isMobile = window.matchMedia("(max-width: 720px)").matches;
    const availableWidth = Math.max(0, card.clientWidth - (isMobile ? 66 : 220));
    const availableHeight = card.clientHeight;
    if (!availableWidth || !availableHeight) return;

    const width = Math.min(availableWidth, availableHeight * ratio);
    stage.style.width = `${width}px`;
    stage.style.height = `${width / ratio}px`;
    if (card.dataset.path === activePath) syncScrollControlPosition(stage);
  }

  function syncScrollControlPosition(stage) {
    const layoutLeft = playerLayout.getBoundingClientRect().left;
    const stageLeft = stage.getBoundingClientRect().left;
    scrollControls.style.left = `${Math.max(12, stageLeft - layoutLeft - 68)}px`;
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
      if (addingLike) {
        animateHeart(card.querySelector(".reel-heart-burst"));
        animateLikeButton(button);
      }
      await refreshStats(card, path);
    } catch (error) { disableDbActions(error); }
    finally { button.disabled = !interactionsReady; }
  }

  async function toggleRepost(card, path) {
    if (!repostsReady) return;
    const button = card.querySelector('[data-action="repost"]');
    button.disabled = true;
    try {
      const { data, error } = await supabase.from("reel_reposts")
        .select("reel_path").eq("reel_path", path).eq("user_id", userId()).limit(1);
      if (error) throw error;
      const result = data?.length
        ? await supabase.from("reel_reposts").delete().eq("reel_path", path).eq("user_id", userId())
        : await supabase.from("reel_reposts").insert({ reel_path: path, user_id: userId() });
      if (result.error) throw result.error;
      if (!data?.length) {
        button.classList.remove("is-reposting");
        void button.offsetWidth;
        button.classList.add("is-reposting");
        window.setTimeout(() => button.classList.remove("is-reposting"), 700);
      }
      await refreshStats(card, path);
    } catch (error) {
      repostsReady = false;
      button.title = `Не удалось выполнить репост: ${error.message}`;
      setStatus(`Не удалось выполнить репост. Проверьте supabase/reels.sql: ${error.message}`, true);
    } finally {
      button.disabled = !repostsReady;
    }
  }

  async function deletePost(card) {
    const postId = card.dataset.postId;
    if (!postId || card.dataset.userId !== userId()) return;
    if (!window.confirm("Удалить эту публикацию и все её фото или видео? Это действие нельзя отменить.")) return;
    const button = card.querySelector('[data-action="delete"]');
    if (button) button.disabled = true;
    try {
      const { data: paths, error } = await supabase.rpc("gadlink_delete_reel_post", { target_post_id: postId });
      if (error) throw error;
      const mediaPaths = Array.isArray(paths) ? paths : [];
      let storageError = null;
      if (mediaPaths.length) {
        try {
          const result = await supabase.storage.from(REELS_BUCKET).remove(mediaPaths);
          storageError = result.error;
        } catch (error) {
          storageError = error;
        }
      }
      observer?.unobserve(card);
      card.querySelectorAll("video").forEach((video) => { video.pause(); video.removeAttribute("src"); video.load(); });
      mediaPaths.forEach((mediaPath) => {
        cardsByPath.delete(mediaPath);
        mediaUrls.delete(mediaPath);
      });
      card.remove();
      if (activeVideo && !activeVideo.isConnected) activeVideo = null;
      if (activePath && mediaPaths.includes(activePath)) activePath = null;
      setStatus(storageError
        ? `Публикация удалена, но часть медиа не удалена из хранилища: ${storageError.message}`
        : "Публикация удалена.", Boolean(storageError));
    } catch (error) {
      console.error("GadLink Reels delete post:", error);
      setStatus(`Не удалось удалить публикацию: ${error.message}`, true);
      if (button) button.disabled = false;
    }
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
    const mediaState = mediaByCard.get(card);
    const media = mediaState.elements[mediaState.index];
    const video = media instanceof HTMLVideoElement ? media : null;
    if (video && activeVideo === video && !video.paused) return;
    const thisActivation = ++activationId;
    pauseAll(video);
    activePath = card.dataset.path;
    syncScrollControlPosition(card.querySelector(".reel-stage"));
    if (!video) {
      if (!media.src) {
        try {
          media.src = await getMediaUrl(mediaState.items[mediaState.index].path);
          if (thisActivation !== activationId || activePath !== card.dataset.path) return;
        } catch (error) {
          card.classList.add("has-error");
          setStatus(`Не удалось открыть публикацию: ${error.message}`, true);
          return;
        }
      }
      warmNextCard(card);
      if (interactionsReady) refreshStats(card, activePath).catch(disableDbActions);
      return;
    }
    video.muted = !soundEnabled;
    video.preload = "auto";
    if (!video.src) {
      try {
        video.src = await getMediaUrl(mediaState.items[mediaState.index].path);
        if (thisActivation !== activationId || activeVideo !== video) return;
      } catch (error) {
        card.classList.add("has-error");
        setStatus(`Не удалось открыть публикацию: ${error.message}`, true);
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
    const nextState = nextCard && mediaByCard.get(nextCard);
    const nextMedia = nextState?.elements[nextState.index];
    if (!nextCard || nextCard.hidden || !nextMedia || nextMedia.src) return;

    if (nextMedia instanceof HTMLVideoElement) nextMedia.preload = "auto";
    getMediaUrl(nextState.items[nextState.index].path).then((url) => {
      if (!sectionActive || nextCard.hidden || nextMedia.src) return;
      nextMedia.src = url;
      if (nextMedia instanceof HTMLVideoElement) nextMedia.load();
    }).catch((error) => {
      setStatus(`Не удалось подготовить следующую публикацию: ${error.message}`, true);
    });
  }

  window.addEventListener("resize", () => {
    container.querySelectorAll(".reel-card").forEach((card) => {
      const state = mediaByCard.get(card);
      const media = state?.elements[state.index];
      if (media) fitStage(card, media);
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
    setStatus("Загружаем публикации…");
    try {
      const { data: posts, error: postsError } = await supabase.from("reel_posts")
        .select("id,user_id,title,description,hashtags,media_paths,media_types,created_at")
        .order("created_at", { ascending: false });
      postsTableReady = !postsError;
      if (postsError) console.error("GadLink Reel posts:", postsError);

      const uploadedPosts = (posts || []).map((post) => ({
        path: post.media_paths[0],
        postId: post.id,
        title: post.title,
        description: post.description,
        hashtags: post.hashtags || [],
        createdAt: post.created_at,
        userId: post.user_id,
        media: post.media_paths.map((path, index) => ({
          path,
          type: post.media_types[index] === "image" ? "image" : "video",
          name: path.split("/").pop()
        }))
      }));
      const postPaths = new Set(uploadedPosts.flatMap((post) => post.media.map((item) => item.path)));
      const legacyFiles = (await listBucket())
        .filter((file) => !postPaths.has(file.path))
        .map((file) => ({
          path: file.path,
          title: "",
          description: "",
          hashtags: [],
          media: [{ ...file, type: "video" }]
        }));
      const files = [...uploadedPosts, ...legacyFiles];
      if (!files.length) {
        setStatus(postsError
          ? "Публикации пока недоступны. Примените supabase/reels.sql в Supabase SQL Editor."
          : "Публикаций пока нет. Нажмите «Добавить», чтобы опубликовать видео или фото.");
      } else {
        const fragment = document.createDocumentFragment();
        for (const file of files) {
          const card = makeCard(file);
          cardsByPath.set(file.path, card);
          for (const media of file.media) cardsByPath.set(media.path, card);
          fragment.append(card);
        }
        container.append(fragment);
        setStatus(postsError
          ? "Старые видео доступны. Для публикаций примените supabase/reels.sql в Supabase SQL Editor."
          : "");
        filterCards();
        observeCards();
      }
      loaded = true;
      try {
        await checkInteractionTables();
        subscribeToInteractions();
        container.querySelectorAll("[data-db-action]").forEach((button) => {
          button.disabled = button.dataset.action === "repost" && !repostsReady;
        });
        const activeCard = activeVideo?.closest(".reel-card");
        if (activeCard) await refreshStats(activeCard, activeCard.dataset.path);
        if (!postsError && files.length) setStatus("");
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

  function setPublishDialogOpen(isOpen) {
    if (isOpen) {
      publishStatus.textContent = "";
      publishStatus.classList.remove("is-error");
      publishDialog.hidden = false;
      publishDialog.removeAttribute("inert");
      window.requestAnimationFrame(() => {
        publishDialog.classList.add("is-open");
        document.getElementById("reel-publish-title-input").focus();
      });
      return;
    }
    publishDialog.classList.remove("is-open");
    publishDialog.setAttribute("inert", "");
    window.setTimeout(() => { publishDialog.hidden = true; }, 180);
  }

  function formatFileSize(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function getUploadMediaType(file) {
    const mimeType = file.type.toLowerCase();
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) return "image";
    if (["video/mp4", "video/webm", "video/quicktime", "video/ogg", "video/x-m4v"].includes(mimeType)) return "video";
    const extension = file.name.match(/\.[^.]+$/)?.[0].toLowerCase();
    if (/\.(jpe?g|png|webp|gif)$/.test(extension || "")) return "image";
    if (/\.(mp4|mov|webm|m4v|ogg)$/.test(extension || "")) return "video";
    return null;
  }

  function parseHashtags(value) {
    const entered = value.trim().split(/[\s,]+/).filter(Boolean);
    const hashtags = entered.map((tag) => tag.replace(/^#+/, ""));
    if (hashtags.length > 10 || hashtags.some((tag) => !/^[\p{L}\p{N}_]{1,30}$/u.test(tag))) {
      throw new Error("Укажите не более 10 хештегов: буквы, цифры и подчёркивание.");
    }
    return [...new Set(hashtags.map((tag) => tag.toLocaleLowerCase()))];
  }

  function clearPublishPreviews() {
    publishPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    publishPreviewUrls.length = 0;
  }

  const publishDropZone = publishDialog.querySelector(".reel-publish-files");
  publishDropZone.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    publishDropZone.classList.add("is-dragging");
  });
  publishDropZone.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    publishDropZone.classList.add("is-dragging");
  });
  publishDropZone.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && publishDropZone.contains(event.relatedTarget)) return;
    publishDropZone.classList.remove("is-dragging");
  });
  publishDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    publishDropZone.classList.remove("is-dragging");
    if (event.dataTransfer?.files.length) {
      publishFiles.files = event.dataTransfer.files;
      publishFiles.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  publishFiles.addEventListener("change", () => {
    const files = [...publishFiles.files];
    clearPublishPreviews();
    publishFileList.replaceChildren();
    document.getElementById("reel-publish-files-label").textContent = files.length
      ? `Выбрано файлов: ${files.length}`
      : "Файлы не выбраны";
    if (files.length > MAX_MEDIA_FILES) {
      publishStatus.textContent = `Можно выбрать не более ${MAX_MEDIA_FILES} файлов.`;
      publishStatus.classList.add("is-error");
      return;
    }
    for (const file of files) {
      const item = document.createElement("li");
      const type = getUploadMediaType(file);
      const limit = type === "image" ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
      if (type === "image") {
        const previewUrl = URL.createObjectURL(file);
        publishPreviewUrls.push(previewUrl);
        const image = document.createElement("img");
        image.src = previewUrl;
        image.alt = file.name;
        item.append(image);
      } else {
        const icon = document.createElement("span");
        icon.className = "reel-publish-file-list__icon";
        icon.textContent = type === "video" ? "▶" : "＋";
        icon.setAttribute("aria-hidden", "true");
        item.append(icon);
      }
      const name = document.createElement("span");
      name.className = "reel-publish-file-list__name";
      name.textContent = file.name;
      const meta = document.createElement("span");
      meta.className = "reel-publish-file-list__meta";
      meta.textContent = `${formatFileSize(file.size)}${!type ? " · неподдерживаемый формат" : file.size > limit ? " · превышен лимит" : ""}`;
      item.append(name, meta);
      publishFileList.append(item);
    }
    publishStatus.textContent = "";
    publishStatus.classList.remove("is-error");
  });

  publishForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedFiles = [...publishFiles.files];
    const title = document.getElementById("reel-publish-title-input").value.trim();
    const description = document.getElementById("reel-publish-description").value.trim();
    const submitButton = document.getElementById("reel-publish-submit");
    if (!userId()) {
      publishStatus.textContent = "Войдите в аккаунт, чтобы опубликовать.";
      publishStatus.classList.add("is-error");
      return;
    }
    if (!postsTableReady) {
      publishStatus.textContent = "Сначала примените supabase/reels.sql в Supabase SQL Editor.";
      publishStatus.classList.add("is-error");
      return;
    }
    if (selectedFiles.length < 1 || selectedFiles.length > MAX_MEDIA_FILES) {
      publishStatus.textContent = `Выберите от 1 до ${MAX_MEDIA_FILES} файлов.`;
      publishStatus.classList.add("is-error");
      return;
    }
    const mediaTypes = selectedFiles.map(getUploadMediaType);
    const invalidIndex = selectedFiles.findIndex((file, index) => {
      const maxSize = mediaTypes[index] === "image" ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
      return !mediaTypes[index] || file.size > maxSize;
    });
    if (invalidIndex !== -1) {
      const file = selectedFiles[invalidIndex];
      const message = !mediaTypes[invalidIndex]
        ? `Формат файла «${file.name}» не поддерживается.`
        : `Файл «${file.name}» превышает допустимый размер ${mediaTypes[invalidIndex] === "image" ? "15" : "50"} МБ.`;
      publishStatus.textContent = message;
      publishStatus.classList.add("is-error");
      return;
    }

    let hashtags;
    try {
      hashtags = parseHashtags(document.getElementById("reel-publish-hashtags").value);
    } catch (error) {
      publishStatus.textContent = error.message;
      publishStatus.classList.add("is-error");
      return;
    }

    submitButton.disabled = true;
    publishStatus.classList.remove("is-error");
    const postId = crypto.randomUUID();
    const uploadedPaths = [];
    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index];
        const extension = file.name.match(/\.[a-z0-9]{1,8}$/i)?.[0].toLowerCase() || "";
        const path = `${userId()}/${postId}/${index}${extension}`;
        publishStatus.textContent = `Загрузка ${index + 1} из ${selectedFiles.length}…`;
        const { error } = await supabase.storage.from(REELS_BUCKET).upload(path, file, {
          contentType: file.type || undefined,
          upsert: false
        });
        if (error) throw error;
        uploadedPaths.push(path);
      }

      const { error } = await supabase.from("reel_posts").insert({
        id: postId,
        user_id: userId(),
        title,
        description,
        hashtags,
        media_paths: uploadedPaths,
        media_types: mediaTypes
      });
      if (error) throw error;

      const post = {
        path: uploadedPaths[0],
        postId,
        title,
        description,
        hashtags,
        userId: userId(),
        media: uploadedPaths.map((path, index) => ({
          path,
          type: mediaTypes[index],
          name: selectedFiles[index].name
        }))
      };
      const card = makeCard(post);
      cardsByPath.set(post.path, card);
      uploadedPaths.forEach((path) => cardsByPath.set(path, card));
      container.prepend(card);
      container.scrollTo({ top: 0, behavior: "smooth" });
      observeCards();
      await activateCard(card);
      publishForm.reset();
      clearPublishPreviews();
      publishFileList.replaceChildren();
      document.getElementById("reel-publish-files-label").textContent = "Файлы не выбраны";
      setPublishDialogOpen(false);
      setStatus("Публикация добавлена в Reels.");
    } catch (error) {
      let message = `Не удалось опубликовать: ${error.message}`;
      if (uploadedPaths.length) {
        try {
          const { error: cleanupError } = await supabase.storage.from(REELS_BUCKET).remove(uploadedPaths);
          if (cleanupError) message += ` Не удалось удалить загруженные файлы: ${cleanupError.message}`;
        } catch (cleanupError) {
          message += ` Не удалось удалить загруженные файлы: ${cleanupError.message}`;
        }
      }
      publishStatus.textContent = message;
      publishStatus.classList.add("is-error");
    } finally {
      submitButton.disabled = false;
    }
  });

  const publishOpenButton = document.getElementById("reel-publish-open");
  publishOpenButton.addEventListener("click", () => {
    if (document.getElementById("reels-section").hidden) {
      document.querySelector('[data-section="reels-section"]').click();
    }
    setPublishDialogOpen(true);
  });
  document.getElementById("reel-publish-close").addEventListener("click", () => setPublishDialogOpen(false));
  publishDialog.querySelector(".reel-publish-dialog__backdrop")
    .addEventListener("click", () => setPublishDialogOpen(false));
  publishDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setPublishDialogOpen(false);
      publishOpenButton.focus();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...publishDialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

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
    activate() {
      sectionActive = true;
      load().then(() => {
        if (loaded) {
          observeCards();
          subscribeToInteractions();
        }
      });
    },
    deactivate() {
      sectionActive = false;
      activationId += 1;
      pauseAll();
      observer?.disconnect();
      commentsPanel.hidden = true;
      commentsPath = null;
      if (interactionsChannel) void supabase.removeChannel(interactionsChannel);
      interactionsChannel = null;
      interactionsOwnerId = null;
      if (!publishDialog.hidden) setPublishDialogOpen(false);
    },
    reset() {
      this.deactivate();
      clearTimeout(interactionRefreshTimer);
      container.replaceChildren();
      cardsByPath.clear();
      mediaUrls.clear();
      loaded = false;
      postsTableReady = false;
      interactionsReady = false;
    }
  };
}
