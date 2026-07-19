/**
 * ============ Монетки: серверная часть (Google Apps Script) ============
 *
 * Что это: небольшой «сервер», который хранит данные в Google Таблице,
 * проверяет права доступа (админ / сотрудник, падел / разработка)
 * и по расписанию забирает выписку из Точка Банка.
 *
 * Как установить — по шагам в файле SETUP.md в репозитории:
 *   1) script.google.com → новый проект → вставить весь этот файл
 *   2) выполнить один раз функцию setup() — создаст таблицу и админа
 *   3) Развернуть → Веб-приложение (от моего имени, доступ: все) → скопировать URL
 *   4) для Точки: Настройки проекта → Свойства скрипта → TOCHKA_TOKEN и TOCHKA_CUSTOMER_CODE
 */

var SHEETS = {
  employees:     ['id', 'name', 'code', 'role', 'unit', 'phone', 'tg', 'active', 'created'],
  clients:       ['id', 'unit', 'name', 'company', 'phone', 'tg', 'status', 'amount', 'notes', 'created', 'updated'],
  venues:        ['id', 'unit', 'name', 'address', 'contact', 'phone', 'price', 'status', 'notes', 'created', 'updated'],
  players:       ['id', 'unit', 'name', 'phone', 'level', 'city', 'notes', 'created', 'updated'],
  tasks:         ['id', 'unit', 'title', 'desc', 'assigneeId', 'authorId', 'status', 'priority', 'due', 'created', 'updated', 'comments'],
  finance:       ['id', 'unit', 'date', 'type', 'amount', 'method', 'source', 'category', 'counterparty', 'comment', 'bankId', 'created', 'updated'],
  notifications: ['id', 'toId', 'text', 'link', 'read', 'created']
};

var RU_SHEET_NAMES = {
  employees: 'Сотрудники', clients: 'Клиенты', venues: 'Площадки',
  players: 'Игроки', tasks: 'Задачи', finance: 'Финансы', notifications: 'Уведомления'
};

// ---------- Первичная настройка ----------

/** Выполните эту функцию ОДИН раз вручную: создаст таблицу и первого админа. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty('SPREADSHEET_ID');
  var ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create('Монетки — база данных');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (key) {
    var name = RU_SHEET_NAMES[key];
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(SHEETS[key]);
      sheet.setFrozenRows(1);
    }
  });
  var def = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  // Первый админ, если сотрудников ещё нет
  if (readAll('employees').length === 0) {
    var code = String(Math.floor(100000 + Math.random() * 900000));
    writeRow('employees', { id: newId(), name: 'Админ', code: code, role: 'admin', unit: 'all', phone: '', tg: '', active: true, created: Date.now() });
    Logger.log('Создан админ. КОД ДЛЯ ВХОДА: ' + code);
  }
  Logger.log('Таблица: ' + ss.getUrl());
}

// ---------- Утилиты таблицы ----------

function getSheet(key) {
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return SpreadsheetApp.openById(ssId).getSheetByName(RU_SHEET_NAMES[key]);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function readAll(key) {
  var sheet = getSheet(key);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var cols = SHEETS[key];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols.length).getValues();
  return values.map(function (row) {
    var obj = {};
    cols.forEach(function (c, i) {
      var v = row[i];
      if (c === 'comments') { try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; } }
      if (c === 'active' || c === 'read') v = (v === true || v === 'true' || v === 'TRUE');
      if (c === 'date' && v instanceof Date) v = Utilities.formatDate(v, 'Europe/Moscow', 'yyyy-MM-dd');
      if (c === 'due' && v instanceof Date) v = Utilities.formatDate(v, 'Europe/Moscow', 'yyyy-MM-dd');
      obj[c] = v === '' ? '' : v;
    });
    return obj;
  }).filter(function (o) { return o.id; });
}

function toRow(key, obj) {
  return SHEETS[key].map(function (c) {
    var v = obj[c];
    if (c === 'comments') return JSON.stringify(v || []);
    if (v === undefined || v === null) return '';
    return v;
  });
}

function writeRow(key, obj) {
  getSheet(key).appendRow(toRow(key, obj));
  return obj;
}

function updateRow(key, obj) {
  var sheet = getSheet(key);
  var ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(obj.id)) {
      sheet.getRange(i + 2, 1, 1, SHEETS[key].length).setValues([toRow(key, obj)]);
      return obj;
    }
  }
  return null;
}

function deleteRow(key, id) {
  var sheet = getSheet(key);
  var ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) { sheet.deleteRow(i + 2); return true; }
  }
  return false;
}

// ---------- Доступы ----------

function findUser(token) {
  if (!token) return null;
  var users = readAll('employees');
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].code) === String(token) && users[i].active) return users[i];
  }
  return null;
}

function isAdmin(u) { return u.role === 'admin'; }
function canSeeUnit(u, unit) { return isAdmin(u) || u.unit === 'all' || u.unit === unit; }
function profileOf(u) { return { id: u.id, name: u.name, role: u.role, unit: u.unit, phone: u.phone, tg: u.tg }; }

function notify(toId, text, link) {
  if (!toId) return;
  writeRow('notifications', { id: newId(), toId: toId, text: text, link: link || '#/tasks', read: false, created: Date.now() });
}

// ---------- HTTP-обработчики ----------

function doGet() {
  return json({ ok: true, app: 'monetki', time: new Date().toISOString() });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var action = body.action;

    if (action === 'login') {
      var u = findUser(body.code);
      if (!u) return json({ ok: false, error: 'Неверный код доступа' });
      return json({ ok: true, token: u.code, profile: profileOf(u) });
    }

    // Техническая диагностика без личных данных: только счётчики и флаги настройки.
    if (action === 'status') return json(statusInfo());

    var user = findUser(body.token);
    if (!user) return json({ ok: false, error: 'auth' });

    switch (action) {
      case 'bootstrap':      return json(bootstrap(user));
      case 'create':         return json(createItem(user, body.entity, body.item));
      case 'update':         return json(updateItem(user, body.entity, body.item));
      case 'delete':         return json(deleteItem(user, body.entity, body.id));
      case 'comment':        return json(addComment(user, body.taskId, body.text));
      case 'import_players': return json(importPlayers(user, body.rows));
      case 'mark_read':      return json(markRead(user, body.ids));
      default:               return json({ ok: false, error: 'Неизвестное действие' });
    }
  } catch (err) {
    return json({ ok: false, error: 'Ошибка сервера: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ---------- Действия ----------

function bootstrap(u) {
  var admin = isAdmin(u);
  function unitFilter(list) { return list.filter(function (x) { return canSeeUnit(u, x.unit); }); }
  var employees = readAll('employees');
  return {
    ok: true,
    profile: profileOf(u),
    data: {
      // сотрудники: админ видит всё (включая коды), остальные — только имена/роли
      employees: admin ? employees : employees.map(function (e) { return { id: e.id, name: e.name, role: e.role, unit: e.unit, active: e.active }; }),
      clients: unitFilter(readAll('clients')),
      venues: unitFilter(readAll('venues')),
      players: unitFilter(readAll('players')),
      tasks: unitFilter(readAll('tasks')),
      finance: admin ? readAll('finance') : [],
      notifications: readAll('notifications').filter(function (n) { return n.toId === u.id; })
    }
  };
}

function checkWriteAccess(u, entity, item) {
  if (!SHEETS[entity]) return 'Неизвестная сущность';
  if ((entity === 'employees' || entity === 'finance') && !isAdmin(u)) return 'Только для админа';
  if (entity === 'notifications') return 'Нельзя';
  if (item && item.unit && item.unit !== 'all' && !canSeeUnit(u, item.unit)) return 'Нет доступа к этому направлению';
  return null;
}

function createItem(u, entity, item) {
  var deny = checkWriteAccess(u, entity, item);
  if (deny) return { ok: false, error: deny };
  item.id = item.id || newId();
  item.created = Date.now();
  item.updated = Date.now();
  if (entity === 'employees' && !item.code) {
    item.code = String(Math.floor(100000 + Math.random() * 900000));
  }
  if (entity === 'tasks') {
    item.authorId = item.authorId || u.id;
    item.comments = item.comments || [];
    if (item.assigneeId && item.assigneeId !== u.id) notify(item.assigneeId, 'Новая задача: ' + item.title);
  }
  writeRow(entity, item);
  return { ok: true, item: item };
}

function updateItem(u, entity, item) {
  var deny = checkWriteAccess(u, entity, item);
  if (deny) return { ok: false, error: deny };
  var before = readAll(entity).filter(function (x) { return x.id === item.id; })[0];
  if (!before) return { ok: false, error: 'Не найдено' };
  if (!canSeeUnit(u, before.unit || item.unit)) return { ok: false, error: 'Нет доступа' };
  var merged = {};
  SHEETS[entity].forEach(function (c) { merged[c] = (item[c] !== undefined) ? item[c] : before[c]; });
  merged.updated = Date.now();
  if (entity === 'tasks') {
    if (before.status !== 'done' && merged.status === 'done' && merged.authorId && merged.authorId !== u.id) {
      notify(merged.authorId, 'Задача выполнена: ' + merged.title);
    }
    if (before.assigneeId !== merged.assigneeId && merged.assigneeId && merged.assigneeId !== u.id) {
      notify(merged.assigneeId, 'Вам передали задачу: ' + merged.title);
    }
  }
  updateRow(entity, merged);
  return { ok: true, item: merged };
}

function deleteItem(u, entity, id) {
  var before = readAll(entity).filter(function (x) { return x.id === id; })[0];
  if (!before) return { ok: false, error: 'Не найдено' };
  var deny = checkWriteAccess(u, entity, before);
  if (deny) return { ok: false, error: deny };
  deleteRow(entity, id);
  return { ok: true };
}

function addComment(u, taskId, text) {
  var task = readAll('tasks').filter(function (t) { return t.id === taskId; })[0];
  if (!task) return { ok: false, error: 'Задача не найдена' };
  if (!canSeeUnit(u, task.unit)) return { ok: false, error: 'Нет доступа' };
  task.comments = task.comments || [];
  task.comments.push({ authorId: u.id, text: String(text).slice(0, 2000), ts: Date.now() });
  updateRow('tasks', task);
  var others = [task.authorId, task.assigneeId].filter(function (id, i, arr) {
    return id && id !== u.id && arr.indexOf(id) === i;
  });
  others.forEach(function (id) { notify(id, u.name + ': ' + String(text).slice(0, 80) + ' (задача «' + task.title + '»)'); });
  return { ok: true, item: task };
}

function importPlayers(u, rows) {
  if (!canSeeUnit(u, 'padel')) return { ok: false, error: 'Нет доступа' };
  var existing = readAll('players');
  var added = 0;
  (rows || []).forEach(function (r) {
    if (!r.name) return;
    var dup = existing.filter(function (p) {
      return String(p.name).toLowerCase() === String(r.name).toLowerCase() && String(p.phone || '') === String(r.phone || '');
    })[0];
    if (dup) return;
    writeRow('players', { id: newId(), unit: 'padel', name: r.name, phone: r.phone || '', level: r.level || '', city: r.city || '', notes: r.notes || '', created: Date.now(), updated: Date.now() });
    added++;
  });
  return { ok: true, added: added };
}

/** Диагностика для проверки подключения: без имён, сумм и других личных данных. */
function statusInfo() {
  var props = PropertiesService.getScriptProperties();
  var fin = readAll('finance');
  var hourly = false;
  try {
    hourly = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tochkaSync'; }).length > 0;
  } catch (e) { hourly = 'нет прав (не запускали enableHourlySync)'; }
  return {
    ok: true,
    employees: readAll('employees').length,
    tochkaTokenSet: !!props.getProperty('TOCHKA_TOKEN'),
    tochkaUnit: props.getProperty('TOCHKA_UNIT') || 'dev (по умолчанию)',
    hourlyTrigger: hourly,
    financeTotal: fin.length,
    financeFromBank: fin.filter(function (f) { return f.source === 'bank'; }).length,
    lastSync: props.getProperty('LAST_SYNC') || null
  };
}

function markRead(u, ids) {
  (ids || []).forEach(function (id) {
    var n = readAll('notifications').filter(function (x) { return x.id === id && x.toId === u.id; })[0];
    if (n) { n.read = true; updateRow('notifications', n); }
  });
  return { ok: true };
}

// ---------- Точка Банк: синхронизация выписки ----------
//
// Свойства скрипта (Настройки проекта → Свойства скрипта):
//   TOCHKA_TOKEN         — ваш токен (JWT) из раздела интеграций Точки
//   TOCHKA_CUSTOMER_CODE — код клиента (customerCode)
//   TOCHKA_UNIT          — какому направлению относить операции по умолчанию: dev | padel (по умолчанию dev)
//
// После настройки свойств добавьте триггер: Триггеры → tochkaSync → каждый час.
// Первый запуск сделайте вручную (Выполнить → tochkaSync) и посмотрите журнал.

var TOCHKA_BASE = 'https://enter.tochka.com/uapi';

function tochkaFetch(path, options) {
  var token = PropertiesService.getScriptProperties().getProperty('TOCHKA_TOKEN');
  if (!token) throw new Error('Не задано свойство TOCHKA_TOKEN');
  var opts = options || {};
  opts.headers = { Authorization: 'Bearer ' + token };
  if (opts.payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(opts.payload);
  }
  opts.muteHttpExceptions = true;
  var resp = UrlFetchApp.fetch(TOCHKA_BASE + path, opts);
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code >= 300) throw new Error('Точка API ' + code + ': ' + body.slice(0, 300));
  return JSON.parse(body);
}

/** Проверка связи с Точкой: выполните вручную, в журнале будет список счетов. */
function tochkaTest() {
  var res = tochkaFetch('/open-banking/v1.0/accounts', { method: 'get' });
  Logger.log(JSON.stringify(res, null, 2));
}

/**
 * Свежие операции по корпоративным картам: маскированный номер карты (pan),
 * магазин и город. Именно так видно, ЧЬЕЙ картой сделана трата, пока она не
 * попала в выписку. Выполните вручную — результат в журнале.
 */
function tochkaCards() {
  var accountsRes = tochkaFetch('/open-banking/v1.0/accounts', { method: 'get' });
  var accounts = (accountsRes.Data && accountsRes.Data.Account) || [];
  accounts.forEach(function (acc) {
    var res = tochkaFetch('/open-banking/v1.0/accounts/' + encodeURIComponent(acc.accountId) + '/authorized-card-transactions', { method: 'get' });
    Logger.log('Счёт ' + acc.accountId + ':\n' + JSON.stringify(res, null, 2));
  });
}

/**
 * Определяем способ оплаты по данным транзакции.
 * По документации Точки: transactionTypeCode «Банковские карты» = карта,
 * «Денежный чек, РКО» / «Объявление на взнос наличными, ПКО» = наличные;
 * schemeName счёта контрагента RU.CBR.PAN = карта, RU.CBR.CellphoneNumber = СБП по телефону.
 * Остальное — эвристики по тексту назначения платежа.
 */
function classifyMethod(t) {
  var ttc = String(t.transactionTypeCode || '');
  if (/Банковские карты/i.test(ttc)) return 'card';
  if (/Денежный чек|взнос наличными/i.test(ttc)) return 'cash';
  var side = (t.creditDebitIndicator === 'Credit') ? t.DebtorAccount : t.CreditorAccount;
  var scheme = (side && side.schemeName) || '';
  if (scheme === 'RU.CBR.PAN') return 'card';
  if (scheme === 'RU.CBR.CellphoneNumber') return 'sbp';
  var p = String(t.description || '').toLowerCase();
  if (/сбп|c2b|нспк|быстрых платежей|qr/.test(p)) return 'sbp';
  if (/карт|терминал|pos/.test(p)) return 'card';
  if (/наличн|банкомат|atm/.test(p)) return 'cash';
  return 'account';
}

/**
 * Включает автосинхронизацию с банком КАЖДЫЙ ЧАС и сразу запускает первую.
 * Запустите один раз вручную (повторный запуск не создаст дублей).
 */
function enableHourlySync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tochkaSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tochkaSync').timeBased().everyHours(1).create();
  Logger.log('Готово: выписка будет обновляться каждый час.');
  tochkaSync();
}

/** Забирает операции за последние 7 дней и дописывает новые в «Финансы». */
function tochkaSync() {
  var props = PropertiesService.getScriptProperties();
  try {
    tochkaSyncInner(props);
  } catch (err) {
    props.setProperty('LAST_SYNC', new Date().toISOString() + ' | ОШИБКА: ' + err.message);
    throw err;
  }
}

function tochkaSyncInner(props) {
  var unit = props.getProperty('TOCHKA_UNIT') || 'dev';

  var accountsRes = tochkaFetch('/open-banking/v1.0/accounts', { method: 'get' });
  var accounts = (accountsRes.Data && accountsRes.Data.Account) || [];
  if (!accounts.length) { Logger.log('Счета не найдены'); return; }

  var end = new Date();
  var start = new Date(end.getTime() - 7 * 864e5);
  var fmt = function (d) { return Utilities.formatDate(d, 'Europe/Moscow', 'yyyy-MM-dd'); };

  var existing = readAll('finance');
  var known = {};
  existing.forEach(function (f) { if (f.bankId) known[f.bankId] = true; });
  var addedTotal = 0;

  accounts.forEach(function (acc) {
    var accountId = acc.accountId;
    // 1) заказываем выписку
    var init = tochkaFetch('/open-banking/v1.0/statements', {
      method: 'post',
      payload: { Data: { Statement: { accountId: accountId, startDateTime: fmt(start), endDateTime: fmt(end) } } }
    });
    var stId = init.Data && init.Data.Statement && init.Data.Statement.statementId;
    if (!stId) { Logger.log('Не удалось создать выписку для ' + accountId); return; }

    // 2) ждём готовности (Created → Processing → Ready) и забираем, до ~50 секунд
    var st = null;
    for (var i = 0; i < 10; i++) {
      Utilities.sleep(5000);
      var got = tochkaFetch('/open-banking/v1.0/accounts/' + encodeURIComponent(accountId) + '/statements/' + encodeURIComponent(stId), { method: 'get' });
      var d = got.Data && got.Data.Statement;
      st = (d && d.length !== undefined) ? d[0] : d; // спека допускает объект или массив
      if (st && (st.status === 'Ready' || st.status === 'Error' || st.Transaction)) break;
    }
    if (!st || st.status === 'Error') { Logger.log('Выписка не готова для ' + accountId + ': ' + (st && st.status)); return; }
    var txs = st.Transaction || [];

    // 3) добавляем новые операции (только проведённые — Booked)
    txs.forEach(function (t) {
      if (t.status === 'Pending') return;
      var bankId = t.transactionId || t.paymentId || ((t.documentNumber || '') + '|' + (t.Amount && t.Amount.amount) + '|' + t.documentProcessDate);
      if (known[bankId]) return;
      known[bankId] = true;
      var isIncome = (t.creditDebitIndicator === 'Credit');
      // по спеке: у входящей операции заполнен DebtorParty (кто прислал), у исходящей — CreditorParty (кому ушло)
      var cp = isIncome
        ? ((t.DebtorParty && t.DebtorParty.name) || '')
        : ((t.CreditorParty && t.CreditorParty.name) || '');
      var purpose = t.description || '';
      writeRow('finance', {
        id: newId(), unit: unit,
        date: String(t.documentProcessDate || fmt(new Date())).slice(0, 10),
        type: isIncome ? 'income' : 'expense',
        amount: Number(t.Amount && t.Amount.amount) || 0,
        method: classifyMethod(t),
        source: 'bank', category: isIncome ? 'Оплата клиента' : 'Прочее',
        counterparty: cp, comment: String(purpose).slice(0, 300),
        bankId: bankId, created: Date.now(), updated: Date.now()
      });
      addedTotal++;
    });
  });
  props.setProperty('LAST_SYNC', new Date().toISOString() + ' | добавлено операций: ' + addedTotal);
  Logger.log('Добавлено операций: ' + addedTotal);
}
