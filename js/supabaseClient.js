import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = "https://efvnyjvvijbwzaglxpbd.supabase.co";
const supabasePublishableKey = "sb_publishable_W9agBe00b6SuGj_n9a380g_D8Ij8NuK";

async function fetchWithAuthTimeout(input, init) {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!new URL(requestUrl, supabaseUrl).pathname.startsWith("/auth/v1/")) {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const parentSignal = init?.signal || (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Supabase Auth request timed out.", "TimeoutError"));
  }, 12_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  global: { fetch: fetchWithAuthTimeout },
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});
