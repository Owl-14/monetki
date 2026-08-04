# Переезд «Монеток» на Supabase

Зачем: база отвечает за ~0,2 сек вместо 1–3 сек у Google, данные надёжнее, а все будущие
обновления серверной функции выкатываются автоматически. Миграции базы нужно выполнять
отдельно через SQL Editor — деплой Edge Function их не применяет.

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

### Что произойдёт с бизнесами и доступами

Отдельную SQL-миграцию запускать не нужно: CORE-модель хранится в той же таблице
`records`. При первом входе и bootstrap сервер безопасно и повторяемо:

- создаст карточки `padel` и `dev`, если их ещё нет;
- создаст memberships из прежнего `employees.unit`: администратор получит роль владельца
  в обоих бизнесах, сотрудник — доступ к своему направлению;
- создаст прежние доли в `businessOwners`: dev 50/50, padel 34/33/33;
- добавит `businessId` старым бизнес-записям, сохранив совпадающий `unit` для старого интерфейса
  и резервных копий.

Существующие CORE-записи не перезаписываются, поэтому повторный bootstrap не возвращает
отключённый доступ и не сбрасывает изменённые модули или доли.

## Шаг 7. Защитить и включить ежечасную синхронизацию с банком

Для cron нужен отдельный случайный секрет. Его одинаковые копии хранятся в Edge Function
Secrets и в зашифрованном Supabase Vault; в репозитории и в команде cron значения нет.
Официальная документация Supabase рекомендует Vault для токенов вызовов Edge Functions из
`pg_cron`/`pg_net`: [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Vault](https://supabase.com/docs/guides/database/vault),
[Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets).

1. Дождитесь успешного workflow **Deploy backend (Supabase)** после merge.
2. В GitHub откройте **Actions** → **Настроить или ротировать секрет синхронизации Точки**.
3. Нажмите **Run workflow** → ещё раз **Run workflow**. Значение будет сгенерировано внутри
   базы без открытого литерала в SQL, прочитано в защищённый временный файл GitHub Actions,
   сразу замаскировано и передано в Edge Function Secrets через Management API.
4. Workflow обновит Edge Function Secret, создаст или обновит запись Vault и идемпотентно
   пересоздаст ровно одно задание `tochka-sync-hourly` на пятой минуте каждого часа.

Для плановой или аварийной ротации повторите эти четыре действия. Новые GitHub secrets
добавлять не нужно: используются существующие `SUPABASE_ACCESS_TOKEN` и
`SUPABASE_PROJECT_ID`. Не запускайте workflow до ревью изменений.

Workflow **Применить расписание синхронизации Точка Банка** остаётся отдельным безопасным
способом повторно применить миграцию 002 без ротации. Его следует запускать только после
первичной настройки секрета.

### Проверка расписания

Выполните в SQL Editor:

```sql
select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'tochka-sync-hourly';
```

Должна вернуться ровно одна активная строка: расписание `5 * * * *`, в команде — адрес
`https://pmntdxwdsrdtaindabqb.supabase.co/functions/v1/api`, действие `tochka_sync`, чтение
`tochka_sync_secret` из `vault.decrypted_secrets` и `timeout_milliseconds := 180000`.
Самого значения секрета в `command` быть не должно.

После ближайшей пятой минуты часа проверьте диагностические отметки:

```sql
select key, value
from kv
where key in ('LAST_SYNC_ATTEMPT', 'LAST_SYNC', 'LAST_SYNC_ERROR')
order by key;
```

`LAST_SYNC_ATTEMPT` обновляется при каждом запуске, `LAST_SYNC` — только после успешной
синхронизации, а `LAST_SYNC_ERROR` равен `null` после успеха или содержит безопасное
сообщение о последней ошибке.

Ручной вызов выполняется с действующим личным кодом администратора в поле `token`.
Вызов без токена, с токеном сотрудника или с неверным cron-секретом получает HTTP 401 и
`{"ok":false,"error":"auth"}` до обращения к банку. Ответ разрешённого `tochka_sync`
содержит только безопасные агрегаты: количество счетов,
запрошенных/готовых/пустых/неготовых выписок, увиденных транзакций, дублей, ожидающих
операций и ошибок. `outcome` различает `zero_transactions`, `all_duplicates`, `partial`
и `failed`; идентификаторы счетов, операций и тексты ответов банка не возвращаются.
`ok: false` означает, что из-за ошибок или неготовых выписок не обработан ни один счёт.

Проверьте ответ HTTP-вызова cron:

```sql
select id, status_code, timed_out, error_msg, created
from net._http_response
order by id desc
limit 10;
```

У последнего вызова должны быть `status_code = 200`, `timed_out = false` и пустой
`error_msg`. Старый Google-скрипт после переезда можно не трогать — он останется
выключенным архивом (таблица тоже останется у вас на Диске).
