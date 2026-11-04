import { supabase } from "./supabaseClient.js";
import {
  clearAuthCallback,
  clearPendingEmail,
  getAuthErrorMessage,
  getCallbackParams,
  getCurrentUser,
  getPendingEmail,
  getResendWait,
  hasAuthCallback,
  resendConfirmationEmail
} from "./auth.js";

const status = document.getElementById("confirm-status");
const emailInput = document.getElementById("confirm-email");
const resendButton = document.getElementById("resend-confirmation");
let resendTimer = null;

function updateResendButton() {
  const email = emailInput.value.trim();
  const wait = getResendWait(email);
  resendButton.disabled = !emailInput.validity.valid || wait > 0;
  resendButton.textContent = wait
    ? `Отправить письмо повторно (${wait} с)`
    : "Отправить письмо повторно";
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = wait ? setInterval(updateResendButton, 1000) : null;
}

function showResend(message) {
  status.textContent = message;
  resendButton.hidden = false;
  updateResendButton();
}

async function handleConfirmation() {
  const params = getCallbackParams();
  const callbackError = params.get("error_code") || params.get("error");
  emailInput.value = params.get("email") || getPendingEmail();

  if (callbackError) {
    showResend(getAuthErrorMessage({
      code: callbackError,
      message: params.get("error_description") || callbackError
    }));
    clearAuthCallback();
    return;
  }

  if (!hasAuthCallback(params)) {
    showResend("Откройте ссылку из письма подтверждения или запросите новое письмо.");
    return;
  }

  const user = await getCurrentUser();
  const pendingEmail = getPendingEmail().toLowerCase();
  if (!user || (pendingEmail && user.email?.toLowerCase() !== pendingEmail)) {
    showResend("Не удалось подтвердить почту. Ссылка могла устареть или открыта в другом браузере.");
    clearAuthCallback();
    return;
  }

  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
  clearPendingEmail();
  clearAuthCallback();
  status.textContent = "Почта успешно подтверждена! Теперь вы можете войти";
  resendButton.hidden = true;
}

resendButton.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email || !emailInput.validity.valid) {
    status.textContent = "Введите корректный адрес электронной почты.";
    return;
  }

  resendButton.disabled = true;
  try {
    await resendConfirmationEmail(email);
    status.textContent = "Если для этого адреса требуется подтверждение, письмо будет отправлено.";
  } catch (error) {
    status.textContent = getAuthErrorMessage(error);
  } finally {
    updateResendButton();
  }
});

emailInput.addEventListener("input", updateResendButton);

handleConfirmation().catch((error) => {
  showResend(getAuthErrorMessage(error));
});
