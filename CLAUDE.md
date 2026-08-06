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
- `js/bank-rules.js` → `supabase/functions/api/bank-rules.js` — общий чистый DSL/validator/evaluator банковских правил: трёхзначная логика `true|false|unknown`, стабильные приоритеты, конфликты, confidence и hard-gates auto. Оба файла должны оставаться точными зеркалами.
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
`bank_rules_list`, `bank_rule_save{rule,expectedVersion}`, `bank_rule_enable{id,enabled,expectedVersion,activationToken?}` (только активный администратор; optimistic concurrency и неизменяемые версии; включённое auto требует токен подтверждённого dry-run той же версии/fingerprint),
`bank_rule_settings_get/update{settings,expectedVersion}` (глобальный auto и лимиты; auto по умолчанию выключен),
`bank_rule_preview_transaction{transactionId,draft?}` и `bank_rule_dry_run{draft?,expectedVersion?}` (только безопасный результат/агрегаты без реквизитов и персональных примеров; для включённого auto сервер выдаёт короткоживущий activationToken),
`bank_rule_apply_suggestion`, `bank_rule_reject_suggestion`, `bank_rule_ignore`, `bank_rule_manual`, `bank_rule_reevaluate`,
`bank_rule_journal{limit?,offset?}`, `bank_rule_correct`, `bank_rule_reverse` (специальный admin-only жизненный цикл; обычный CRUD системных сущностей запрещён),
`allocate_event_finance{item}` (только администратор; атомарно и идемпотентно связывает существующий `finance` с событием),
`close_event_settlement{id}` (только администратор; отдельно от операционного статуса фиксирует расчёт завершённого/отменённого события),
`backup` (только администратор; отдельная полная копия всех записей, включая files и события архивных бизнесов/выключенного модуля; обычный bootstrap не расширяет),
`migrate_import{data}` (без токена только пока база пустая; event-граф восстанавливается одной транзакцией и допускает безопасный повтор той же копии).

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
- `events`: businessId/unit, eventTypeId, title, status `planned|active|completed|cancelled`, отдельный settlementStatus `open|closed`, startsAt/endsAt, responsibleId, capacity/defaultFee, универсальные locationName/resourceName, необязательный same-business venueId, description, append-only history[] изменений карточки события и закрытия расчёта. Изменения участников/бюджета/связей отражаются в соответствующих сущностях, а не дублируются в history. Закрытие сохраняет неизменяемый settlement со снимком плана/факта, прибыли, маржи, долей, staffRate и staffAmount.
- `eventRegistrations`: businessId/unit, eventId, participantType `player|company|contact`, participantId, status `registered|confirmed|attended|cancelled|refunded`, chargeAmount, note. Ссылка участника всегда проверяется внутри того же бизнеса; уникальный SQL-индекс атомарно запрещает повторную регистрацию одного участника.
- `eventBudgetLines`: businessId/unit, eventId, direction `income|expense`, name, plannedAmount, category, note — только план, не денежный факт.
- `eventFinanceAllocations`: неизменяемая связь события с существующим `finance`: eventId, financeId, optional registrationId/budgetLineId, purpose `payment|deposit|expense|refund`, amount, idempotencyKey. Прямая CRUD-запись запрещена; SQL под блокировкой не даёт распределить больше суммы операции. Связанные сумма/type/business у `finance` защищены от изменения и удаления.
- `tasks`: assigneeId, authorId, status `new`(«Не видел», красный)`|progress|question`(жёлтый)`|done`, priority, due, comments[]
- `finance`: unit, date, type `income|expense`, amount, method `account|card|sbp|cash|other`, source `bank|manual`, category, counterparty, comment, bankId (дедуп банка), employeeId (зарплата/компенсация), owner (`savva|andrey|dmitry` — чей расход); проведённое правилом дополнительно содержит безопасный `bankSignals`, appliedRuleId/version и applicationId.
- `bankTransactions`: необработанная очередь банка; id, bankId, date, type, amount, method, source `bank`, counterparty, comment, `bankSignals`, bankSignalFingerprint, bankRuleState `pending|ignored|manual`, created, updated. До проведения намеренно нет `businessId`/`unit`/`category`, поэтому запись не участвует в отчётах и личных счетах. `bankSignals` содержит только allowlist нормализованных признаков schemaVersion 1 (направление, копейки, валюта, способ/type/scheme, нормализованные стороны, полный не-маскированный телефон/ИНН, HMAC-псевдонимы счетов, нормализованное назначение, сила bankId), без raw payload, токенов и полных счетов. В bootstrap `bankSignals` и `bankId` не выдаются; очередь получает только администратор; обычный CRUD запрещён.
- `bankRules` — текущая версия правила; `bankRuleVersions` — неизменяемые снимки ruleId+version+checksum; `bankRuleSettings` — singleton глобального auto/лимитов с settingsVersion, а `bankRuleSettingVersions` — неизменяемая история его версий; `bankRuleApplications` — append-only аудит apply/reject/ignore/manual/correct/reverse; `bankRuleRuns` — только агрегаты dry-run/auto-run; `financeRelations` — неизменяемые same-business связи finance с player/company/contact/deal. Event-связь остаётся в `eventFinanceAllocations`.
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
- Очередь банка, правила, версии, настройки, preview/dry-run, журнал, применение, исправление и отмена доступны только активному администратору. `bankRuleVersions`, `bankRuleSettingVersions`, `bankRuleApplications`, `bankRuleRuns`, `financeRelations` неизменяемы; `bankRules`/settings меняются только специальными versioned RPC. Удаление правила — версионный soft-delete в архив без потери истории. SQL execute выдан только `service_role`.
- Трата без receiptId не создаётся.
- Складские записи доступны активным участникам бизнеса только при включённом модуле `stock`. Все ссылки на склады и позиции проверяются внутри одного businessId/unit; движения и завершённые инвентаризации нельзя менять или удалять, а справочники нельзя удалить при связанных остатках или истории.
- События доступны активным участникам бизнеса только при включённом модуле `events`. Полные типы (`ownerShares/defaultFee/staffRate`), взносы регистраций, план, финансовые связи, полный факт и прибыль доступны только администратору. Сотрудник видит безопасные типы, события и участников; создаёт событие только на себя, управляет только своим открытым событием и его регистрациями, а `defaultFee`/`chargeAmount` сервер берёт из защищённых настроек. Чужие события доступны только для чтения. Сотруднику-ответственному выдаётся только его `staffAmount`: до закрытия расчётный, после закрытия исключительно из settlement; ставка ему не раскрывается.
- `completed`/`cancelled` не закрывает поздние оплаты автоматически. После ручного `close_event_settlement` событие, участники, бюджет и финансовые связи становятся неизменяемыми; история и итог не пересчитываются задним числом.
- Player/company/contact/venue нельзя физически удалить, пока на запись ссылается событие; это сохраняет ссылки закрытой истории. Создание дочерней строки и удаление события сериализуются блокировкой родителя: ни одна из двух очередностей гонки не оставляет сироту.

## Бизнес-логика финансов

- Личные счета («Счета»): `ownerBalances()` в store.js — по каждому бизнесу (доходы − расходы) × доли из `businessOwners`, с fallback на прежний `OWNERS`, если CORE-данных ещё нет:
  Разработка 50/50 Савва/Андрей; Падел 34% Андрей / 33% Савва / 33% Дмитрий.
  Расход с `owner` вычитается целиком у него (не делится); категория «Перевод между счетами» игнорируется; cash не участвует.
- Зарплата: в форме операции категория «Зарплата» + сотрудник → выбор источника (счёт / наличные Саввы / наличные Андрея) и зачёт pending-трат (`offsetIds`): сервер уменьшает сумму, создаёт строку «Компенсация сотруднику», траты → `returned_salary`.
- Синхронизация Точки: `tochkaSync` в функции — выписка за N дней (по умолчанию 30), дедуп по bankId одновременно по старым `finance` и новой очереди `bankTransactions`, классификация способа оплаты (`classifyMethod`: transactionTypeCode «Банковские карты», schemeName RU.CBR.PAN/CellphoneNumber, потом текстовые эвристики), баланс из /balances (суммы как отдаёт банк, знак НЕ переворачивать!). Новая завершённая операция нормализуется в allowlisted `bankSignals` и попадает только в `bankTransactions` через `bank_enqueue_transaction`; advisory-lock не даёт sync воскресить очередь после apply. HMAC accountKey использует `BANK_SIGNAL_HMAC_SECRET`, а при его отсутствии — уже настроенный `TOCHKA_SYNC_SECRET`; сырые счета не сохраняются. Старые `finance` не мигрируют и считаются уже проведёнными; legacy очередь честно даёт unknown, но остаётся доступной вручную.
- Evaluator сортирует `priority DESC, order ASC, id ASC`; правила одного максимального приоритета с разными decision/actions дают conflict. `manual` и `stopOnMatch` не позволяют нижнему приоритету решить операцию. Unknown не считается совпадением. Сумма/направление/способ — слабые признаки: amount-only никогда не auto. Auto требует global toggle, score ≥ 0.95, один сильный exact-признак (полный телефон/ИНН/HMAC accountKey) или два независимых семейства контекста, отсутствие повторов одного evidence-поля, unknown/conflict, business+category, активные same-business ссылки и все SQL-лимиты. SQL повторно сверяет число уникальных семейств и не доверяет счётчикам клиента.
- Проведение необработанной операции: ручной сценарий «бизнес + категория» сохранён, а suggest только предзаполняет его. `009_bank_rules.sql` задаёт уникальность bankId, единый порядок блокировок advisory(idempotencyKey) → advisory(bankId) → rows и атомарный `apply_bank_rule_transaction`: finance + financeRelations + event allocation + audit создаются вместе, очередь удаляется последней. Повтор того же idempotencyKey для той же операции возвращает прежний результат, а для другой операции/команды отклоняется. Глобальный auto выключен по умолчанию; превышение лимита оставляет операцию в очереди как suggest.
- `ignore` оставляет операцию в очереди и скрывает отдельным фильтром; `manual` останавливает автоматические правила. При однозначном совпадении cron выставляет эти безопасные состояния даже когда денежное auto выключено; оба состояния обратимы через re-evaluate. Проведённая банковская `finance` не меняется и не удаляется generic CRUD и в UI открывается только для чтения. Correction через журнал меняет только category/method/owner/comment/counterparty, сохраняет сумму/type/bankId и допускает явный `null` для очистки owner/comment/counterparty. Legacy bank-finance без application получает идемпотентный `legacy_backfill` audit: её можно исправить, но нельзя вернуть в очередь. Журнал отдаётся страницами и по allowlist содержит только id действия, статус, дату, business/category/method, версию правила и короткий auditRef — без суммы, банковского ID, реквизитов, телефона, контрагента и комментария. Reverse возвращает запись в очередь только если finance не изменён и нет financeRelations, event allocation, stockMovement или другой неизменяемой downstream-связи; иначе требуется компенсирующая ручная операция.
- Полное восстановление backup выполняется одним `restore_monetki_backup` RPC и одной транзакцией: обычные сущности, затем банковский граф вместе с bank-finance, затем граф событий. Любая ошибка откатывает весь импорт; банковскую finance нельзя обойти через generic upsert.
- Восстановление разрыва 20.07: миграция `006_recover_hidden_bank_transactions.sql` атомарно возвращает в `bankTransactions` только банковские `finance` с отсутствующим, `all`, несовпадающим или несуществующим бизнесом и исходным `bankId`. Валидные и архивные бизнесы не меняются; существующий `finance`/очередь с тем же `bankId` не дублируются; строка без `bankId` или со складской ссылкой блокирует автоматическое перемещение. Admin-bootstrap отдаёт `bankDiagnostics` только как счётчики и границы дат очереди/скрытых областей, включая отдельный счётчик строк без `bankId`, без сумм, контрагентов, счетов и банковских идентификаторов.
- Экономика событий: начислено = активные регистрации; оплачено/депозит/возврат/прямой расход считаются только по неизменяемым `eventFinanceAllocations` к реальным `finance`; прибыль = фактический доход − прямые расходы − возвраты; маржа и прибыль на участника вычисляются из того же снимка. Доли типа должны давать 100%; последняя доля получает копеечный остаток, поэтому распределение точно равно прибыли. `007_atomic_event_finance.sql` фиксирует расчёт, а `008_event_review_guarantees.sql` добавляет атомарную уникальность регистрации, event-delete RPC, строгую businessId/unit-проверку и транзакционный идемпотентный restore графа.
- Диагностика выписки содержит только безопасные границы и счётчики: по каждому запросу `requestedStart`/`requestedEnd`, `count`, раннюю/позднюю валидную `documentProcessDate`, число отсутствующих или неверных дат и `outsideRange`; по запуску — `rawSeen`/`uniqueSeen` и крайние даты. Ответы банка, суммы, контрагенты, `accountId`, `bankId` в диагностику не добавлять. Операции вне диапазона или без валидной даты не теряются, но синхронизация считается частичной и не обновляет `LAST_SYNC`.
- Доступ к `tochka_sync`: ручной вызов разрешён только активному администратору с личным `token`; cron использует `X-Tochka-Sync-Secret`, общий только для Edge Function Secret и Vault. Настройка и ротация — только ручным workflow `configure-tochka-sync-secret.yml`; значение не хранится в repo и не выводится.

## Процесс изменений (ВАЖНО)

1. Ветка от `main` → изменения → **commit → push → PR → merge** (пользователь просил через PR, не пушить в main напрямую). `gh pr create` / `gh pr merge`.
2. После merge в main всё деплоится само: фронт — GitHub Pages (~1 мин), бэкенд — Action `deploy-backend.yml` при изменении `supabase/**` (секреты в GitHub стоят). Вручную: `gh workflow run deploy-backend.yml`.
3. Изменил фронт → подними `CACHE` в `sw.js` и версию в `config.js`. Изменил права/протокол → поменяй И `LocalStore`, И серверные модули `rules.js`/`auth`/`actions`/`http`. Для событий общие чистые правила живут в `event-rules.js`; для банка — в зеркальных `bank-rules.js`; атомарные гарантии — в миграциях и RPC.
4. Проверка: демо-режим — `localStorage.setItem('monetki_backend','demo')` на localhost (коды: 111111 админ, 222222 падел, 333333 dev). Прод-диагностика: `POST {"action":"status"}` на backendUrl.
5. Git identity: Owl-14 / savva.karetin0@gmail.com (уже в .git/config).

## Инструкции для людей

- `README.md` — обзор для людей; `SETUP-SUPABASE.md` — как поднималась Supabase; `SETUP.md` — архив (эпоха Apps Script).
- Резервная копия: сайт → Ещё → «Скачать копию» (JSON всех данных); восстановление — кнопка на экране входа при пустой базе.
