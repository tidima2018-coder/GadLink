# gadlink

Минимальный фронтенд на html, css и vanilla javascript. Авторизация и данные используют существующий проект Supabase.

## Запуск

1. В `js/supabaseClient.js` укажите URL и публичный publishable/anon key существующего Supabase-проекта. Не используйте `service_role`.
2. Откройте проект через локальный статический сервер или HTTPS-хостинг. Не запускайте страницы через `file://`.
3. Настройте email и Resend по инструкции в [supabase/email_setup.md](./supabase/email_setup.md).
4. Убедитесь, что приложение использует таблицы и колонки, перечисленные ниже. Если они ещё не созданы, сначала подготовьте схему данных.
5. Проверьте и примените политики из [supabase/auth_setup.sql](./supabase/auth_setup.sql) в SQL Editor существующего проекта. Прочитайте предупреждения в инструкции перед запуском.

## Используемые таблицы

- `profiles`: `id` (uuid, совпадает с `auth.users.id`), `username` (text, уникальный), `about` (text), `avatar_url` (text).
- `posts`: `id`, `user_id` (uuid), `content` (text), `media_url` (text), `created_at`.
- `conversations`: `id`, `name` (text, допускает null), `is_group` (boolean), `created_by` (uuid), `created_at`.
- `conversation_members`: `conversation_id` (uuid), `user_id` (uuid).
- `messages`: `id`, `conversation_id` (uuid), `user_id` (uuid), `content` (text), `created_at`.
- `servers`: `id`, `name` (text), `created_by` (uuid), `created_at`.
- `text_channels`: `id`, `server_id` (uuid), `name` (text), `created_at`.
- `channel_messages`: `id`, `channel_id` (uuid), `user_id` (uuid), `content` (text), `created_at`.

Добавьте `posts`, `messages` и `channel_messages` в публикацию Supabase Realtime. Приложенный SQL проверяет `auth.users.email_confirmed_at` в RLS-функции и закрывает запись/чтение незарегистрированным и неподтверждённым пользователям. Перед применением сверьте реальные таблицы, колонки и политики существующего проекта. Если bucket `avatars` уже создан как private, измените его на public в панели Storage, чтобы работали публичные ссылки.

Команда `/ai ваш вопрос` вызывает локальные базовые ответы и не использует внешнюю модель ИИ.

## Голосовые звонки

Голосовые звонки используют WebRTC и Supabase Realtime Broadcast. Сначала сверьте
существующую таблицу `friendships` и её статусы, затем выполните
[`supabase/voice_calls.sql`](./supabase/voice_calls.sql) в SQL Editor: миграция
создаёт таблицу истории, ограниченные RPC и RLS-политики приватных каналов.
Она не отключает RLS у существующих таблиц.

Для входящих звонков и истории таблица `voice_calls` должна быть в публикации
`supabase_realtime`; SQL проверит и добавит её. После этого разверните Edge
Function `voice-ice-config`:

```text
supabase functions deploy voice-ice-config
supabase secrets set TURN_URL="turn:turn.example.com:3478?transport=udp" TURN_SHARED_SECRET="секретный shared secret Coturn"
```

Для надёжного соединения настройте TURN-сервер с TURN REST API/shared secret
(например, Coturn `use-auth-secret` и `static-auth-secret`) и доступными клиентам
UDP/TCP портами. Храните `TURN_SHARED_SECRET` только в Supabase Edge Function
Secrets; функция выдаёт аутентифицированному пользователю краткоживущие
учётные данные, подписанные HMAC-SHA1. Адреса `TURN_URL` можно перечислить через
запятую. STUN используется как fallback, если Edge Function/TURN недоступны, но
он не гарантирует соединение между всеми типами сетей.

Для звонков нужны HTTPS (кроме localhost), разрешение пользователя на микрофон,
Realtime включён в проекте и доступ к сети через WebRTC. Реальный звонок между
двумя устройствами необходимо проверить отдельно после применения SQL и
настройки Edge Function/TURN.
