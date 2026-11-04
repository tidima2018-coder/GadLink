import { supabase } from "./supabaseClient.js";

const cooldownLength = 60;
const pendingEmailKey = "gadlink-pending-email";

export function getConfirmationUrl() {
  return new URL("../confirm.html", import.meta.url).href;
}

export function getCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of hashParams) {
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

export function hasAuthCallback(params) {
  return ["code", "access_token", "refresh_token", "token_hash", "type", "error", "error_code"]
    .some((key) => params.has(key));
}

export function clearAuthCallback() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

function createAuthError(error, options = {}) {
  const result = new Error(error?.message || "Не удалось выполнить запрос.");
  result.code = error?.code || "";
  result.canResend = Boolean(options.canResend);
  result.needsConfirmation = Boolean(options.needsConfirmation);
  return result;
}

export function getAuthErrorMessage(error) {
  const code = (error?.code || "").toLowerCase();
  const message = (error?.message || "").toLowerCase();

  if (code.includes("email_not_confirmed") || message.includes("email not confirmed")) {
    return "Почта ещё не подтверждена. Проверьте письмо и попробуйте войти снова.";
  }
  if (code.includes("otp_expired") || message.includes("expired") || message.includes("invalid")) {
    return "Ссылка подтверждения недействительна или устарела. Запросите новое письмо.";
  }
  if (code.includes("email_address_invalid") || message.includes("invalid email")) {
    return "Введите корректный адрес электронной почты.";
  }
  if (code.includes("user_already_exists") || message.includes("already registered")) {
    return "Этот адрес уже зарегистрирован. Попробуйте войти или отправить письмо повторно.";
  }
  if (message.includes("rate limit") || message.includes("too many requests") || message.includes("only request this after")) {
    return "Слишком много запросов. Подождите и попробуйте снова.";
  }
  if (message.includes("smtp") || message.includes("email") || message.includes("mail")) {
    return "Не удалось отправить письмо. Проверьте настройки SMTP и попробуйте позже.";
  }
  return error?.message || "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

function cooldownKey(email) {
  return `gadlink-resend-${email.trim().toLowerCase()}`;
}

export function getResendWait(email) {
  const until = Number(localStorage.getItem(cooldownKey(email))) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function startResendCooldown(email) {
  localStorage.setItem(cooldownKey(email), String(Date.now() + cooldownLength * 1000));
}

export async function registerWithEmail(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: getConfirmationUrl() }
  });

  if (error) {
    const text = `${error.code || ""} ${error.message || ""}`.toLowerCase();
    throw createAuthError(error, {
      canResend: text.includes("email") || text.includes("already") || text.includes("rate limit")
    });
  }

  if (data.user?.identities?.length === 0) {
    throw createAuthError(
      { message: "Если адрес уже зарегистрирован, войдите или запросите письмо повторно." },
      { canResend: true }
    );
  }

  if (data.session) {
    await supabase.auth.signOut({ scope: "local" });
    throw createAuthError({
      message: "Подтверждение обязательно: включите Confirm Email в настройках Supabase Auth."
    });
  }

  localStorage.setItem(pendingEmailKey, email.trim().toLowerCase());
  startResendCooldown(email);
}

export async function signInWithEmail(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const needsConfirmation = error.code === "email_not_confirmed" ||
      (error.message || "").toLowerCase().includes("email not confirmed");
    throw createAuthError(error, {
      canResend: needsConfirmation,
      needsConfirmation
    });
  }

  if (!data.user?.email_confirmed_at && !data.user?.confirmed_at) {
    await supabase.auth.signOut({ scope: "local" });
    throw createAuthError(
      { message: "Почта ещё не подтверждена. Проверьте письмо и попробуйте войти снова." },
      { canResend: true, needsConfirmation: true }
    );
  }

  return data.user;
}

export async function signOutUser() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user?.email_confirmed_at && !data.user?.confirmed_at) {
    await supabase.auth.signOut({ scope: "local" });
    return null;
  }

  return data.user;
}

export async function resendConfirmationEmail(email) {
  const wait = getResendWait(email);
  if (wait > 0) {
    throw createAuthError({ message: `Подождите ${wait} сек. перед повторной отправкой.` });
  }

  startResendCooldown(email);
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: getConfirmationUrl() }
  });
  if (error) throw createAuthError(error, { canResend: true });
}

export function getPendingEmail() {
  return localStorage.getItem(pendingEmailKey) || "";
}

export function clearPendingEmail() {
  localStorage.removeItem(pendingEmailKey);
}
