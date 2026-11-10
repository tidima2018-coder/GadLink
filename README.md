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

## Push-уведомления и PWA

Сначала примените `supabase/push_and_sync.sql` в SQL Editor после миграций
чатов, друзей, Reels и `voice_calls.sql`. Миграция добавляет защищённые
подписки устройств, синхронизируемые отметки прочтения/непрочитанные счётчики,
ограничение в 10 устройств на аккаунт, дедупликацию push и серверное истечение
звонков. RLS остаётся включённым; push диспетчер определяет адресатов из строк
`conversation_members` и `voice_calls`, а не из запроса браузера.

Для идемпотентных повторов после временных ошибок также примените
`supabase/push_retry_migration.sql`. Она сохраняет ранее обработанные события,
добавляет lease для параллельных вызовов и отдельно фиксирует успешную отправку
на каждое устройство.

Сгенерируйте пару VAPID-ключей локально (пакет нужен только для генерации):

```text
npx web-push generate-vapid-keys
```

Секреты добавляйте только в Supabase Edge Function Secrets; не вставляйте
`VAPID_PRIVATE_KEY`, service-role key или webhook secret во фронтенд:

```text
supabase secrets set VAPID_PUBLIC_KEY="<public>" VAPID_PRIVATE_KEY="<private>" PUSH_WEBHOOK_SECRET="<случайный длинный секрет>" CALL_EXPIRY_CRON_SECRET="<другой случайный длинный секрет>"
supabase secrets set VAPID_SUBJECT="<mailto:адрес-которым-вы-владеете-или-HTTPS-контакт>"
supabase functions deploy push-config
supabase functions deploy push-dispatch --no-verify-jwt
supabase functions deploy expire-calls --no-verify-jwt
```

`VAPID_SUBJECT` обязателен: задайте свой действующий контактный email в формате
`mailto:...` или HTTPS URL, который вы контролируете. Edge Function не подставляет
фиктивный контакт по умолчанию.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` и `SUPABASE_SERVICE_ROLE_KEY` доступны
Edge Functions из настроек проекта. `push-config` требует сессию пользователя;
`push-dispatch` принимает только Database Webhook с секретным HTTP-заголовком.
В Supabase Database Webhooks настройте три POST webhook на
`https://<project-ref>.supabase.co/functions/v1/push-dispatch`:

1. `public.messages`, событие `INSERT`.
2. `public.voice_calls`, событие `INSERT`.
3. `public.voice_calls`, событие `UPDATE`.

Для каждого укажите заголовок `x-gadlink-webhook-secret` со значением
`PUSH_WEBHOOK_SECRET`. Обновления звонков отправляют уведомление только для
статуса `missed`. Сообщение по умолчанию содержит только имя отправителя и
общую фразу; текст появляется лишь после отдельного включения предпросмотра в
настройках на конкретном устройстве. Серверный диспетчер не отправляет push
самому отправителю, использует event-id дедупликацию, ограничивает частоту до
60 событий в минуту на пользователя и удаляет подписки, которые возвращают
HTTP 404/410. Для защиты от SSRF отправляются только HTTPS endpoint известных
провайдеров Push (Google, Mozilla, Apple и Windows).

При временной ошибке отправки диспетчер помечает событие как ожидающее повтора
и отвечает HTTP 503. Уже подтверждённые Push-провайдером устройства записываются
отдельно и пропускаются при повторной доставке; параллельный запрос получает
временный отказ, пока действует lease. Повторно передайте то же событие при
получении 503 или настройте повтор HTTP 5xx на уровне используемого механизма
доставки webhook. Не предполагайте, что сам Supabase Database Webhook повторит
неудачный HTTP-запрос автоматически. Web Push не предоставляет транзакцию
совместно с базой: если провайдер принял уведомление, но соединение оборвалось
до сохранения подтверждения, повторная попытка может отправить его повторно;
одинаковый notification tag заставляет браузер заменить такое уведомление,
а не показывать вторую карточку.

В Supabase Dashboard настройте запуск Edge Function `expire-calls` раз в минуту
с методом POST и заголовком `x-gadlink-cron-secret`, равным
`CALL_EXPIRY_CRON_SECRET`. Функция переводит неотвеченные звонки в `missed`
после 45 секунд и завершает разговоры без heartbeat. При открытии уведомления
приложение всё равно перепроверяет статус звонка и RLS-доступ в Supabase;
завершённый звонок принять нельзя.

`sw.js` кэширует только публичную оболочку сайта и статику; Auth, REST, Storage,
Functions и личные данные не попадают в Cache Storage. Обновления загружаются
сначала из сети, а предыдущий статический кеш используется только как offline
fallback. Push-разрешение запрашивается лишь после нажатия «Включить
уведомления». На iPhone/iPad Web Push доступен в iOS/iPadOS 16.4+ для GadLink,
установленного на экран «Домой»; для Android и desktop нужен актуальный браузер
и HTTPS. Подписка сохраняется отдельно для каждого устройства и отключается
отдельно на текущем устройстве.

После миграции проверьте публикацию таблиц в Realtime, состояние webhook-ов,
VAPID-пару и cron-задачу в Supabase Dashboard. Код проекта сам по себе не
разворачивает эти настройки в удалённом Supabase-проекте и не доказывает
доставку push на реальном устройстве.
