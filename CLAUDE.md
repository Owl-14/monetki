# Монетки — руководство для разработчика/агента

Внутренний офис двух бизнесов владельцев (Савва, Андрей, Дмитрий): CRM, задачи, финансы, команда.
Пользователь — не программист: объяснения давать простым языком, инструкции — «дословно куда нажать».
Язык всего проекта (UI, коммиты, комментарии) — русский.

## Архитектура

| Часть | Где | Технологии |
|---|---|---|
| Фронтенд (PWA) | корень репо → GitHub Pages, https://owl-14.github.io/monetki | ванильный JS (ES-модули), без сборки |
| Бэкенд | `supabase/functions/api/index.ts` → Supabase Edge Function | Deno/TS, один HTTP-эндпоинт |
| База | Supabase Postgres, проект ref `pmntdxwdsrdtaindabqb` (Frankfurt) | одна таблица `records(entity, id, data jsonb)` + `kv(key, value)` |
| Банк | API Точка Банка (enter.tochka.com/uapi) | выписка + баланс, cron каждый час в :05 (pg_cron → функция) |

- RLS включён без политик: с anon-ключом данные недоступны, всё ходит только через функцию `api` (service role).
- Секреты `TOCHKA_TOKEN`, `TOCHKA_UNIT` — в Edge Function Secrets (в репо их нет и быть не должно).
- Старый бэкенд (Google Apps Script, `google-apps-script/Code.gs`) — выключенный архив, не трогать.

## Файлы фронтенда

- `index.html` — оболочка; инлайн-скрипт темы до CSS (не мигает).
- `config.js` — `backendUrl` (адрес функции), версия.
- `js/store.js` — слой данных: `LocalStore` (демо, localStorage) и `RemoteStore` (fetch к функции). Оба реализуют одинаковые методы. Здесь же справочники: `UNITS`, `TASK_STATUSES`, `FIN_*`, `OWNERS` (доли владельцев) и `ownerBalances()` (расчёт личных счетов).
- `js/app.js` — весь UI: роутер по hash (`#/dashboard` и т.д.), функции `view*` рендерят разделы в `#view`, `open*Form` — модалки. Быстрые сохранения: `doCreate/doUpdate/doDelete` меняют `S.data` локально и шлют запрос, без перечитывания базы.
- `css/style.css` — стили; переменные тем в `:root` (светлая) + два блока тёмной (`prefers-color-scheme` и `[data-theme="dark"]`).
- `sw.js` — service worker. **При любом изменении фронтенда поднимать версию `CACHE` ('monetki-vN')**.

## Протокол API (общий для LocalStore и функции)

POST на `backendUrl`, `Content-Type: text/plain` (чтобы без preflight), тело JSON:
`{action, token, ...}`. Токен = личный код сотрудника. Ответ `{ok:true,...}` или `{ok:false,error}`.

Действия: `login{code}`, `bootstrap` (все данные с учётом прав), `create/update/delete{entity,item|id}`,
`comment{taskId,text}`, `import_players{rows}`, `mark_read{ids}`, `resolve_expense{id,how}` (how: `bank`|`cash:savva`|`cash:andrey`),
`upload_file{b64}` / `get_file{id}` (фото чеков), `status` (диагностика без авторизации, без личных данных),
`tochka_sync{days}`, `migrate_import{data}` (без токена только пока база пустая).

## Модель данных (entity → поля в data)

- `employees`: id, name, code (=токен входа), role `admin|staff`, unit `padel|dev|all`, phone, tg, active
- `clients` (только dev): воронка status `lead|talks|work|support|refused`, amount, notes
- `venues` (padel): + `slots` — календарь кортов, объект `{"YYYY-MM-DD_HH": {tag, price}}`, tag: `booked|free|busy|want`
- `players` (padel): name, phone, level, notes; импорт вставкой из Excel
- `tasks`: assigneeId, authorId, status `new`(«Не видел», красный)`|progress|question`(жёлтый)`|done`, priority, due, comments[]
- `finance`: unit, date, type `income|expense`, amount, method `account|card|sbp|cash|other`, source `bank|manual`, category, counterparty, comment, bankId (дедуп банка), employeeId (зарплата/компенсация), owner (`savva|andrey|dmitry` — чей расход)
- `staffExpenses`: траты сотрудников; receiptId (фото чека, обязателен), status `pending`(красный)`|returned_cash|returned_bank|returned_salary`(зелёные)
- `cash`: наличные кассы владельцев (owner), в общую статистику НЕ входят; employeeId — если выплата сотруднику
- `files`: {id, b64, byId} — фото чеков; НЕ отдаются в bootstrap, только через get_file
- `notifications`: toId, text, link, read

## Права (дублируются в LocalStore и в функции — менять оба!)

- Сотрудник видит только своё направление: люди, клиенты/площадки/игроки, задачи. Финансы/Команда — только админ.
- Задачи: сотрудник ставит только себе; чужие (от админа) не редактирует — сервер режет апдейт до `{status}`; удаляет только свои.
- Финансы/наличные/сотрудники: только админ. Сотруднику в bootstrap приходят только его выплаты (finance/cash с его employeeId) и его траты.
- Трата без receiptId не создаётся.

## Бизнес-логика финансов

- Личные счета («Счета»): `ownerBalances()` в store.js — по каждому направлению (доходы − расходы) × доли:
  Разработка 50/50 Савва/Андрей; Падел 34% Андрей / 33% Савва / 33% Дмитрий.
  Расход с `owner` вычитается целиком у него (не делится); категория «Перевод между счетами» игнорируется; cash не участвует.
- Зарплата: в форме операции категория «Зарплата» + сотрудник → выбор источника (счёт / наличные Саввы / наличные Андрея) и зачёт pending-трат (`offsetIds`): сервер уменьшает сумму, создаёт строку «Компенсация сотруднику», траты → `returned_salary`.
- Синхронизация Точки: `tochkaSync` в функции — выписка за N дней (по умолчанию 30), дедуп по bankId, классификация способа оплаты (`classifyMethod`: transactionTypeCode «Банковские карты», schemeName RU.CBR.PAN/CellphoneNumber, потом текстовые эвристики), баланс из /balances (суммы как отдаёт банк, знак НЕ переворачивать!).

## Процесс изменений (ВАЖНО)

1. Ветка от `main` → изменения → **commit → push → PR → merge** (пользователь просил через PR, не пушить в main напрямую). `gh pr create` / `gh pr merge`.
2. После merge в main всё деплоится само: фронт — GitHub Pages (~1 мин), бэкенд — Action `deploy-backend.yml` при изменении `supabase/**` (секреты в GitHub стоят). Вручную: `gh workflow run deploy-backend.yml`.
3. Изменил фронт → подними `CACHE` в `sw.js`. Изменил права/протокол → поменяй И `LocalStore`, И `index.ts`.
4. Проверка: демо-режим — `localStorage.setItem('monetki_backend','demo')` на localhost (коды: 111111 админ, 222222 падел, 333333 dev). Прод-диагностика: `POST {"action":"status"}` на backendUrl.
5. Git identity: Owl-14 / savva.karetin0@gmail.com (уже в .git/config).

## Инструкции для людей

- `README.md` — обзор для людей; `SETUP-SUPABASE.md` — как поднималась Supabase; `SETUP.md` — архив (эпоха Apps Script).
- Резервная копия: сайт → Ещё → «Скачать копию» (JSON всех данных); восстановление — кнопка на экране входа при пустой базе.
