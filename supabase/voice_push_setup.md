# Push for incoming voice calls

The repository already contains the authenticated call RPCs, the private `voice-inbox` Realtime policies, push subscriptions, and the `push-dispatch` Edge Function. There is no database webhook declaration in the checked-in SQL, so confirm the Dashboard webhook exists before relying on background delivery. Do not create a duplicate if one already targets `push-dispatch` for `voice_calls`.

## Supabase setup

1. In **Edge Functions → Secrets**, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `PUSH_WEBHOOK_SECRET` for `push-dispatch`. `VAPID_SUBJECT` must be a `mailto:` address or HTTPS contact URL. Set the same `VAPID_PUBLIC_KEY` for `push-config`; it validates the user's bearer token. Keep the private key and `SUPABASE_SERVICE_ROLE_KEY` on the server only. Keep `SUPABASE_URL` and `SUPABASE_ANON_KEY` available to `push-config`.
2. Deploy `push-dispatch` with JWT verification disabled at the gateway because Supabase Database Webhooks authenticate it with the configured custom header; the function itself compares `x-gadlink-webhook-secret` in constant time. Example: `supabase functions deploy push-dispatch --no-verify-jwt`.
3. In **Database → Webhooks**, configure a POST webhook for `public.voice_calls` on **INSERT** and **UPDATE**, pointing to `https://efvnyjvvijbwzaglxpbd.supabase.co/functions/v1/push-dispatch`. Add header `x-gadlink-webhook-secret` with the exact `PUSH_WEBHOOK_SECRET` value. Ensure the webhook payload includes the new row and, for UPDATE, the old row. If this webhook already handles `messages`, preserve that configuration and include `voice_calls` rather than adding another duplicate webhook.
4. The existing `push_subscriptions` rows are used as-is. Each user's registered devices receive the event; a device with a fresh visible-presence timestamp skips the incoming-call push because its open GadLink receives the call through Realtime. The Service Worker closes tagged incoming-call notifications when a terminal call-state push arrives.

No new SQL migration is required for this change. The existing `voice_calls.sql`, `push_and_sync.sql`, and `push_retry_migration.sql` provide the tables, RLS-protected RPCs and retryable event log. Apply those existing migrations if they have not already been applied. The client never receives the VAPID private key or service-role key.

## Device setup and limitations

Sign in, open **Settings → Push notifications**, choose **Enable notifications**, and allow browser notifications on each device. On Android, install GadLink using Chrome's **Install app** menu. On iPhone/iPad, open GadLink in Safari, use **Share → Add to Home Screen**, launch the installed app, then enable notifications. iOS Web Push requires a supported iOS/iPadOS version and an installed Home Screen web app. Browser/OS power saving, revoked permission, offline devices, and push-service delays can still prevent or delay delivery. Push opens the app; WebRTC and microphone capture only start in the foreground after the session and live call are checked. It cannot guarantee a ringing call if the browser or operating system suppresses Web Push.

## Manual two-account verification

Use two separate browser profiles or devices, with Push enabled on the recipient device:

1. With both sites open, call from A to B. Confirm Realtime opens the incoming-call dialog with A's name/avatar and the existing ringtone; accept and verify audio.
2. Minimize/background B and place another call. Confirm a single tagged notification appears with **Ответить** and **Отклонить** actions where supported. Choose **Отклонить** and verify the call ends and the notification closes.
3. Repeat, choose **Answer**. Confirm GadLink opens to the calls section and checks the current call. With microphone permission already granted it proceeds to acceptance; otherwise the call dialog waits for the user to press **Answer**.
4. Repeat with B's tab closed, then with the installed PWA/device locked. Check notification delivery, action availability, and that stale/accepted calls cannot be answered.
5. With Push enabled on two B devices, accept on one; the other open device should leave the incoming state via Realtime, and its tagged notification should close via push when supported.

Tests involving two real accounts and a locked phone require the deployed Supabase project, configured Database Webhook/secrets, and physical devices; they cannot be confirmed from this local repository.
