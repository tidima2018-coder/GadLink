// Shared bounded catch-up trigger. WebSocket retries belong to Supabase; views
// reload authoritative state on resume and periodically if a delivery was lost.
export function createRealtimeRecovery() {
  let timer = null;
  let debounce = null;
  let lastRun = 0;
  const request = () => {
    if (document.hidden || !navigator.onLine || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      lastRun = Date.now();
      window.dispatchEvent(new CustomEvent("gadlink:resync"));
    }, Math.max(250, 5000 - (Date.now() - lastRun)));
  };
  return {
    start() {
      if (timer) return;
      window.addEventListener("online", request);
      window.addEventListener("focus", request);
      window.addEventListener("pageshow", request);
      document.addEventListener("visibilitychange", request);
      timer = setInterval(request, 90000);
    },
    stop() {
      clearInterval(timer); timer = null;
      clearTimeout(debounce); debounce = null;
      window.removeEventListener("online", request);
      window.removeEventListener("focus", request);
      window.removeEventListener("pageshow", request);
      document.removeEventListener("visibilitychange", request);
    }
  };
}
