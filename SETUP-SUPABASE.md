# Переезд «Монеток» на Supabase

Зачем: база отвечает за ~0,2 сек вместо 1–3 сек у Google, данные надёжнее, а все будущие
обновления серверной части выкатываются автоматически — больше никаких «вставьте код и разверните».

Интерфейс сайта не меняется, адрес тот же: https://owl-14.github.io/monetki
Данные переносятся файлом резервной копии без потерь (включая коды входа сотрудников).

---

## Шаг 1. Создать проект Supabase (~5 минут)

1. Откройте [supabase.com](https://supabase.com) → **Start your project** → войдите через GitHub (проще всего — аккаунт Owl-14 у вас уже есть).
2. **New project**:
   - *Name*: `monetki`
   - *Database Password*: придумайте и **сохраните себе** (нам он не понадобится, но терять нельзя)
   - *Region*: **Frankfurt (eu-central-1)** — ближайший к РФ
3. Подождите минуту-две, пока проект создастся.

## Шаг 2. Создать таблицы

1. В меню слева: **SQL Editor** → **New query**.
2. Вставьте целиком содержимое файла [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) → кнопка **Run**.
3. Внизу должно появиться «Success. No rows returned».

## Шаг 3. Дать GitHub право деплоить серверную часть

Это делается один раз — дальше каждое моё обновление кода будет улетать в Supabase автоматически.

1. Откройте [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → **Generate new token** → имя `github` → скопируйте токен.
2. Откройте [github.com/Owl-14/monetki/settings/secrets/actions](https://github.com/Owl-14/monetki/settings/secrets/actions) → **New repository secret**:
   - *Name*: `SUPABASE_ACCESS_TOKEN` — *Secret*: вставьте токен из п.1
3. Ещё раз **New repository secret**:
   - *Name*: `SUPABASE_PROJECT_ID` — *Secret*: **Reference ID** проекта. Найти его: в Supabase → Project Settings (шестерёнка) → **General** → поле «Reference ID» (строка вроде `abcdefghijklmnop`). Он же виден в адресе: `supabase.com/dashboard/project/ВОТ_ЭТО`.

> Эти два секрета хранятся в защищённом хранилище GitHub, в публичный код они не попадают.

## Шаг 4. Сообщить мне Reference ID

Пришлите мне **Reference ID** (он не секретный — это просто имя проекта). Я:
- впишу адрес новой базы в сайт,
- запущу автодеплой серверной функции,
- проверю, что всё отвечает.

## Шаг 5. Ключ Точки

1. В Supabase: **Edge Functions** (меню слева) → вкладка **Secrets** → **Add new secret**:
   - *Name*: `TOCHKA_TOKEN` — *Value*: ваш JWT-ключ из Точки (тот же, что вставляли в Google)
   - при желании второй: `TOCHKA_UNIT` = `padel` или `dev` (куда по умолчанию писать операции банка)
2. Сохранить.

## Шаг 6. Перенести данные

1. Откройте сайт **пока со старой базой** → войдите админом → «Ещё» → **«⬇️ Скачать копию»** — сохранится файл `monetki-backup-….json`.
2. После того как я переключу сайт (шаг 4), откройте сайт заново — на экране входа появится кнопка **«📦 Загрузить копию»** → выберите скачанный файл.
3. Войдите со своим прежним кодом админа — все данные, сотрудники и их коды на месте.

## Шаг 7. Ежечасная синхронизация с банком

В SQL Editor → New query → вставьте (замените REF на ваш Reference ID) → Run:

```sql
select cron.schedule(
  'tochka-sync-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://REF.supabase.co/functions/v1/api',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "tochka_sync"}'::jsonb
  )
  $$
);
```

Готово. Старый Google-скрипт после переезда можно не трогать — он просто останется выключенным архивом (таблица тоже останется у вас на Диске).
