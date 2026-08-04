# Монетки — руководство для разработчика/агента

Внутренний офис бизнесов владельцев (Савва, Андрей, Дмитрий): CRM, задачи, финансы, команда.
Пользователь — не программист: объяснения давать простым языком, инструкции — «дословно куда нажать».
Язык всего проекта (UI, коммиты, комментарии) — русский.

## Архитектура

| Часть | Где | Технологии |
|---|---|---|
| Фронтенд (PWA) | корень репо → GitHub Pages, https://owl-14.github.io/monetki | ванильный JS (ES-модули), без сборки |
| Бэкенд | `supabase/functions/api/index.ts` → Supabase Edge Function | Deno/TS, один HTTP-эндпоинт; логика разделена на `http`, `actions`, `auth/access`, `db/repositories`, `bank`, `events` |
| База | Supabase Postgres, проект ref `pmntdxwdsrdtaindabqb` (Frankfurt) | одна таблица `records(entity, id, data jsonb)` + `kv(key, value)` |
| Банк | API Точка Банка (enter.tochka.com/uapi) | выписка + баланс, cron каждый час в :05 (pg_cron → функция) |

- RLS включён без политик: с anon-ключом данные недоступны, всё ходит только через функцию `api` (service role).
- Секреты `TOCHKA_TOKEN`, `TOCHKA_SYNC_SECRET` — в Edge Function Secrets (в репо их нет и быть не должно). Копия `TOCHKA_SYNC_SECRET` для pg_cron хранится зашифрованной в Supabase Vault. Прежний `TOCHKA_UNIT` больше не используется: бизнес назначается администратором при проведении операции из очереди.
- Старый бэкенд (Google Apps Script, `google-apps-script/Code.gs`) — выключенный архив, не трогать.

## Файлы фронтенда

- `index.html` — оболочка; инлайн-скрипт темы до CSS (не мигает).
- `config.js` — `backendUrl` (адрес функции), версия.
- `js/store.js` — слой данных: `LocalStore` (демо, localStorage) и `RemoteStore` (fetch к функции). Оба реализуют одинаковые методы и симметричные права. Здесь же справочники: `UNITS` (legacy), `DEFAULT_BUSINESSES`, `BUSINESS_MODULES`, `TASK_STATUSES`, `FIN_*`, `OWNERS` (fallback долей) и `ownerBalances()` (расчёт личных счетов из `businessOwners`).
- `js/app.js` — весь UI: роутер по hash (`#/dashboard`, `#/events?view=calendar`, `#/events?id=…&tab=economy` и т.д.), функции `view*` рендерят разделы в `#view`, `open*Form` — модалки. Быстрые сохранения: `doCreate/doUpdate/doDelete` меняют `S.data` локально и шлют запрос, без перечитывания базы. Неизменяемые связи финансов и закрытие расчёта используют специальные методы store с последующим bootstrap.
- `js/event-rules.js` → `supabase/functions/api/event-rules.js` — общие для браузера и сервера правила событий и расчёт экономики в копейках; не дублировать формулы в UI.
- `css/style.css` — стили; переменные тем в `:root` (светлая) + два блока тёмной (`prefers-color-scheme` и `[data-theme="dark"]`).
- `sw.js` — service worker. **При любом изменении фронтенда поднимать версию `CACHE` ('monetki-vN')**.

## Протокол API (общий для LocalStore и функции)

POST на `backendUrl`, `Content-Type: text/plain` (чтобы без preflight), тело JSON:
`{action, token, ...}`. Токен = личный код сотрудника. Ответ `{ok:true,...}` или `{ok:false,error}`.

Действия: `login{code}`, `bootstrap` (все данные с учётом прав), `create/update/delete{entity,item|id}`,
`comment{taskId,text}`, `import_players{rows}`, `mark_read{ids}`, `resolve_expense{id,how}` (how: `bank`|`cash:savva`|`cash:andrey`),
`upload_file{b64}` / `get_file{id}` (фото чеков), `status` (диагностика без авторизации, без личных данных),
`tochka_sync{token,days}` (только активный администратор; pg_cron вместо личного токена передаёт отдельный секрет в заголовке),
`process_bank_transaction{id,businessId,category}` (только администратор; атомарно проводит запись из банковской очереди),
`allocate_event_finance{item}` (только администратор; атомарно и идемпотентно связывает существующий `finance` с событием),
`close_event_settlement{id}` (только администратор; отдельно от операционного статуса фиксирует расчёт завершённого/отменённого события),
`migrate_import{data}` (без токена только пока база пустая).

## Модель данных (entity → поля в data)

- `businesses`: id (безопасный служебный slug; `padel|dev` — legacy), name, emoji, modules[], active. Число бизнесов не ограничено; `active:false` — мягкий архив без удаления данных.
- `memberships`: employeeId, businessId, unit (=businessId для совместимости), role `owner|staff`, active
- `businessOwners`: businessId, unit (=businessId), ownerId (legacy `savva|andrey|dmitry` или ID создателя нового бизнеса), name, share (0…1), active. При создании бизнеса администратор автоматически получает запись с долей 1; дальше доли редактируются в карточке бизнеса.
- `employees`: id, name, code (=токен входа), role `admin|staff`, unit `padel|dev|all` (legacy/bootstrap), phone, tg, active
- `clients` (legacy, только dev): прежняя карточка клиента с status `lead|talks|work|support|refused`, amount, notes. Новая CRM читает её как помеченную старую карточку, не дублирует и не перезаписывает через новые сущности.
- CRM продаж: `companies` (реквизиты, ответственные и отдельный статус клиента), `contacts` (люди компании), `leads` (сырой входящий контакт), `deals` (сделка и стадия), `pipelines` + `stages` (настраиваемые воронки), `dealItems` (ручные позиции сделки, в том числе регулярные). Все семь сущностей содержат одинаковые `businessId` и `unit`; bootstrap идемпотентно создаёт для активного бизнеса только стандартную пустую воронку и её стадии, но не создаёт компании, контакты, лиды или сделки.
- `venues` (padel): + `slots` — календарь кортов, объект `{"YYYY-MM-DD_HH": {tag, price}}`, tag: `booked|free|busy|want`
- `players` (padel): name, phone, level, notes; импорт вставкой из Excel
- `warehouses`: businessId/unit, name, active — склады бизнеса; модуль `stock` обязателен.
- `stockItems`: businessId/unit, name, sku, unitName, costPrice, minStock, active — складская номенклатура без начальных или демонстрационных остатков.
- `stockMovements`: неизменяемая история `receipt|expense|transfer|inventory`; позиция, склад/склады, количество, дата, поставщик/сумма или причина/событие при наличии. Создание движения системно пересчитывает остатки.
- `stockBalances`: системные остатки и резерв по паре склад + позиция; прямое редактирование запрещено.
- `reservations`: резерв позиции на складе, status `active|released`; активный резерв не может превышать свободный остаток.
- `inventories`: сверка фактических остатков склада, status `draft|completed`; сохранение/удаление черновика и завершение выполняются атомарно с проверкой актуальной версии, завершение создаёт корректирующие движения, завершённая инвентаризация неизменяема.
- `eventTypes`: businessId/unit, name, active, defaultFee, staffRate, ownerShares[] — универсальный тип события и доли его прибыли; модуль `events` обязателен.
- `events`: businessId/unit, eventTypeId, title, status `planned|active|completed|cancelled`, отдельный settlementStatus `open|closed`, startsAt/endsAt, responsibleId, capacity/defaultFee, универсальные locationName/resourceName, необязательный same-business venueId, description, append-only history[] изменений карточки события и закрытия расчёта. Изменения участников/бюджета/связей отражаются в соответствующих сущностях, а не дублируются в history. Закрытие сохраняет неизменяемый settlement со снимком плана/факта, прибыли, маржи и долей.
- `eventRegistrations`: businessId/unit, eventId, participantType `player|company|contact`, participantId, status `registered|confirmed|attended|cancelled|refunded`, chargeAmount, note. Ссылка участника всегда проверяется внутри того же бизнеса; повторная регистрация одного участника запрещена.
- `eventBudgetLines`: businessId/unit, eventId, direction `income|expense`, name, plannedAmount, category, note — только план, не денежный факт.
- `eventFinanceAllocations`: неизменяемая связь события с существующим `finance`: eventId, financeId, optional registrationId/budgetLineId, purpose `payment|deposit|expense|refund`, amount, idempotencyKey. Прямая CRUD-запись запрещена; SQL под блокировкой не даёт распределить больше суммы операции. Связанные сумма/type/business у `finance` защищены от изменения и удаления.
- `tasks`: assigneeId, authorId, status `new`(«Не видел», красный)`|progress|question`(жёлтый)`|done`, priority, due, comments[]
- `finance`: unit, date, type `income|expense`, amount, method `account|card|sbp|cash|other`, source `bank|manual`, category, counterparty, comment, bankId (дедуп банка), employeeId (зарплата/компенсация), owner (`savva|andrey|dmitry` — чей расход)
- `bankTransactions`: необработанная очередь банка; id, bankId, date, type, amount, method, source `bank`, counterparty, comment, created, updated. До проведения намеренно нет `businessId`/`unit`/`category`, поэтому запись не участвует в отчётах и личных счетах. В bootstrap очередь получает только администратор; обычный CRUD запрещён.
- `staffExpenses`: траты сотрудников; receiptId (фото чека, обязателен), status `pending`(красный)`|returned_cash|returned_bank|returned_salary`(зелёные)
- `cash`: наличные кассы владельцев (owner), в общую статистику НЕ входят; employeeId — если выплата сотруднику
- `files`: {id, b64, byId} — фото чеков; НЕ отдаются в bootstrap, только через get_file
- `notifications`: toId, text, link, read

Все бизнес-записи читают область через `businessId || unit`. Новые/изменённые строки записывают оба поля одинаковыми. При bootstrap CORE идемпотентно создаёт `padel`/`dev`, memberships из `employees.unit`, прежние доли и дополняет старые строки `businessId`, не перезаписывая существующие настройки.

## Права (дублируются в LocalStore и в функции — менять оба!)

- Доступ к бизнесу задаётся активным `memberships`. Сотрудник видит только доступные бизнесы, общих с ним людей и только свои задачи. Финансы/Команда — только legacy-админ; модули дополнительно должны быть включены в карточке бизнеса.
- `create` проверяет целевой бизнес, `delete` — исходный, `update` — оба до слияния. Нельзя обойти изоляцию несовпадающими `businessId`/`unit` или переносом доступной записи в недоступный бизнес. В архивный бизнес нельзя писать; `delete` для самого `businesses` означает мягкий архив, а не физическое удаление.
- Задачи: сотрудник ставит только себе; чужие (от админа) не редактирует — сервер режет апдейт до `{status}`; удаляет только свои.
- Финансы/наличные/сотрудники: только админ. Сотруднику в bootstrap приходят только его выплаты (finance/cash с его employeeId) и его траты.
- Трата без receiptId не создаётся.
- Складские записи доступны активным участникам бизнеса только при включённом модуле `stock`. Все ссылки на склады и позиции проверяются внутри одного businessId/unit; движения и завершённые инвентаризации нельзя менять или удалять, а справочники нельзя удалить при связанных остатках или истории.
- События доступны активным участникам бизнеса только при включённом модуле `events`. Типы, план, финансовые связи, полный факт и прибыль доступны только администратору; сотрудник видит события/участников и своё начисление по ставке типа, но не доли владельцев и общий финансовый результат. Все event-ссылки проверяются в одном businessId/unit.
- `completed`/`cancelled` не закрывает поздние оплаты автоматически. После ручного `close_event_settlement` событие, участники, бюджет и финансовые связи становятся неизменяемыми; история и итог не пересчитываются задним числом.

## Бизнес-логика финансов

- Личные счета («Счета»): `ownerBalances()` в store.js — по каждому бизнесу (доходы − расходы) × доли из `businessOwners`, с fallback на прежний `OWNERS`, если CORE-данных ещё нет:
  Разработка 50/50 Савва/Андрей; Падел 34% Андрей / 33% Савва / 33% Дмитрий.
  Расход с `owner` вычитается целиком у него (не делится); категория «Перевод между счетами» игнорируется; cash не участвует.
- Зарплата: в форме операции категория «Зарплата» + сотрудник → выбор источника (счёт / наличные Саввы / наличные Андрея) и зачёт pending-трат (`offsetIds`): сервер уменьшает сумму, создаёт строку «Компенсация сотруднику», траты → `returned_salary`.
- Синхронизация Точки: `tochkaSync` в функции — выписка за N дней (по умолчанию 30), дедуп по bankId одновременно по старым `finance` и новой очереди `bankTransactions`, классификация способа оплаты (`classifyMethod`: transactionTypeCode «Банковские карты», schemeName RU.CBR.PAN/CellphoneNumber, потом текстовые эвристики), баланс из /balances (суммы как отдаёт банк, знак НЕ переворачивать!). Новая завершённая операция попадает только в `bankTransactions`; старые `finance` не мигрируют и считаются уже проведёнными.
- Проведение необработанной операции: администратор назначает активный доступный бизнес и категорию. SQL-функция из `005_process_bank_transaction.sql` под блокировкой и в одной транзакции сохраняет исходный `bankId`, создаёт `finance` и удаляет очередь. Повторный запрос, двойной клик и уже существующий legacy-`finance.bankId` не создают дубль.
- Экономика событий: начислено = активные регистрации; оплачено/депозит/возврат/прямой расход считаются только по неизменяемым `eventFinanceAllocations` к реальным `finance`; прибыль = фактический доход − прямые расходы − возвраты; маржа и прибыль на участника вычисляются из того же снимка. Доли типа должны давать 100%; последняя доля получает копеечный остаток, поэтому распределение точно равно прибыли. `006_atomic_event_finance.sql` содержит RPC, блокировки и защитный trigger.
- Диагностика выписки содержит только безопасные границы и счётчики: по каждому запросу `requestedStart`/`requestedEnd`, `count`, раннюю/позднюю валидную `documentProcessDate`, число отсутствующих или неверных дат и `outsideRange`; по запуску — `rawSeen`/`uniqueSeen` и крайние даты. Ответы банка, суммы, контрагенты, `accountId`, `bankId` в диагностику не добавлять. Операции вне диапазона или без валидной даты не теряются, но синхронизация считается частичной и не обновляет `LAST_SYNC`.
- Доступ к `tochka_sync`: ручной вызов разрешён только активному администратору с личным `token`; cron использует `X-Tochka-Sync-Secret`, общий только для Edge Function Secret и Vault. Настройка и ротация — только ручным workflow `configure-tochka-sync-secret.yml`; значение не хранится в repo и не выводится.

## Процесс изменений (ВАЖНО)

1. Ветка от `main` → изменения → **commit → push → PR → merge** (пользователь просил через PR, не пушить в main напрямую). `gh pr create` / `gh pr merge`.
2. После merge в main всё деплоится само: фронт — GitHub Pages (~1 мин), бэкенд — Action `deploy-backend.yml` при изменении `supabase/**` (секреты в GitHub стоят). Вручную: `gh workflow run deploy-backend.yml`.
3. Изменил фронт → подними `CACHE` в `sw.js` и версию в `config.js`. Изменил права/протокол → поменяй И `LocalStore`, И серверные модули `rules.js`/`auth`/`actions`/`http`. Для событий общие чистые правила живут в `event-rules.js`, атомарные гарантии — в миграции и RPC.
4. Проверка: демо-режим — `localStorage.setItem('monetki_backend','demo')` на localhost (коды: 111111 админ, 222222 падел, 333333 dev). Прод-диагностика: `POST {"action":"status"}` на backendUrl.
5. Git identity: Owl-14 / savva.karetin0@gmail.com (уже в .git/config).

## Инструкции для людей

- `README.md` — обзор для людей; `SETUP-SUPABASE.md` — как поднималась Supabase; `SETUP.md` — архив (эпоха Apps Script).
- Резервная копия: сайт → Ещё → «Скачать копию» (JSON всех данных); восстановление — кнопка на экране входа при пустой базе.
