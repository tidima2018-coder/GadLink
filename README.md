# gadlink

Минимальный фронтенд на html, css и vanilla javascript. Авторизация и данные используют существующий проект Supabase.

## Запуск

1. В `js/supabaseClient.js` укажите URL и публичный publishable/anon key существующего Supabase-проекта. Не используйте `service_role`.
2. Откройте проект через локальный статический сервер или HTTPS-хостинг. Не запускайте страницы через `file://`.
3. Настройте email и Resend по инструкции в [supabase/email_setup.md](./supabase/email_setup.md).
4. Убедитесь, что приложение использует таблицы и колонки, перечисленные ниже. Если они ещё не созданы, сначала подготовьте схему данных.
5. Проверьте и примените политики из [supabase/auth_setup.sql](./supabase/auth_setup.sql) в SQL Editor существующего проекта. Прочитайте предупреждения в инструкции перед запуском.
6. Создайте private Storage bucket `reels`, если его ещё нет, и примените [supabase/reels.sql](./supabase/reels.sql) в SQL Editor. Скрипт создаёт таблицы Reels и разрешает авторизованным пользователям читать публикации, а загружать и удалять медиа — только внутри своей папки.

## Используемые таблицы

- `profiles`: `id` (uuid, совпадает с `auth.users.id`), `username` (text, уникальный), `about` (text), `avatar_url` (text).
- `posts`: `id`, `user_id` (uuid), `content` (text), `media_url` (text), `created_at`.
- `conversations`: `id`, `name` (text, допускает null), `is_group` (boolean), `created_by` (uuid), `created_at`.
- `conversation_members`: `conversation_id` (uuid), `user_id` (uuid).
- `messages`: `id`, `conversation_id` (uuid), `user_id` (uuid), `content` (text), `created_at`.
- `servers`: `id`, `name` (text), `created_by` (uuid), `created_at`.
- `text_channels`: `id`, `server_id` (uuid), `name` (text), `created_at`.
- `channel_messages`: `id`, `channel_id` (uuid), `user_id` (uuid), `content` (text), `created_at`.
- `reel_posts`: публикации Reels с названием, описанием, хештегами и массивами путей/типов медиа; таблица создаётся скриптом `supabase/reels.sql`.

Добавьте `posts`, `messages` и `channel_messages` в публикацию Supabase Realtime. Приложенный SQL проверяет `auth.users.email_confirmed_at` в RLS-функции и закрывает запись/чтение незарегистрированным и неподтверждённым пользователям. Перед применением сверьте реальные таблицы, колонки и политики существующего проекта. Если bucket `avatars` уже создан как private, измените его на public в панели Storage, чтобы работали публичные ссылки.

В Reels можно опубликовать видео или карусель до 10 фото/видео. Ограничения интерфейса: 50 МБ на видео и 15 МБ на изображение; проверьте, что лимит размера файлов bucket `reels` в Supabase не ниже 50 МБ.

Команда `/ai ваш вопрос` вызывает локальные базовые ответы и не использует внешнюю модель ИИ.
