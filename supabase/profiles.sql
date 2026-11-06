
-- 1. Создаём таблицу пользователей
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id)
        ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Включаем защиту данных
ALTER TABLE public.profiles
ENABLE ROW LEVEL SECURITY;

-- 3. Разрешаем просмотр и изменение профилей
GRANT SELECT, UPDATE ON public.profiles
TO authenticated;

-- 4. Пользователи могут искать друг друга
DROP POLICY IF EXISTS "Users can view profiles"
ON public.profiles;

CREATE POLICY "Users can view profiles"
ON public.profiles
FOR SELECT TO authenticated
USING (true);

-- 5. Каждый может изменять только свой профиль
DROP POLICY IF EXISTS "Users can update own profile"
ON public.profiles;

CREATE POLICY "Users can update own profile"
ON public.profiles
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK ((SELECT auth.uid()) = id);

-- 6. Автоматическое создание профиля
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.profiles (id, username)
    VALUES (
        NEW.id,
        'user_' || REPLACE(NEW.id::TEXT, '-', '')
    );

    RETURN NEW;
END;
$$;

-- 7. Запускаем функцию при регистрации
DROP TRIGGER IF EXISTS on_auth_user_created
ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();
