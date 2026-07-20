// ============ Слой данных «Монеток» ============
// Два режима:
//  - RemoteStore: общая база в Google Таблицах через веб-приложение Apps Script (см. SETUP.md)
//  - LocalStore: демо-режим, данные лежат в localStorage этого браузера
// Оба реализуют один и тот же набор методов, чтобы приложение не знало разницы.

export const UNITS = {
  padel: { id: 'padel', name: 'Падел', emoji: '🎾' },
  dev: { id: 'dev', name: 'Разработка', emoji: '💻' }
};

export const CLIENT_STATUSES = {
  dev: [
    { id: 'lead', name: 'Лид', color: 'blue' },
    { id: 'talks', name: 'Переговоры', color: 'purple' },
    { id: 'work', name: 'В работе', color: 'amber' },
    { id: 'support', name: 'Поддержка', color: 'green' },
    { id: 'refused', name: 'Отказ', color: 'red' }
  ],
  venue: [
    { id: 'talks', name: 'Переговоры', color: 'purple' },
    { id: 'active', name: 'Работаем', color: 'green' },
    { id: 'archive', name: 'Архив', color: 'red' }
  ]
};

export const TASK_STATUSES = [
  { id: 'new', name: 'Не видел', color: 'red' },
  { id: 'progress', name: 'В работе', color: 'blue' },
  { id: 'question', name: 'Есть вопросы', color: 'amber' },
  { id: 'done', name: 'Выполнена', color: 'green' }
];

// Владельцы бизнеса и их доли в направлениях.
// Разработка: пополам Савва/Андрей. Падел: Андрей 34%, Савва 33%, Дмитрий 33%,
// причём делится (приходы − аренда кортов): аренда — операции с пометкой PADEL KLUB.
export const OWNERS = [
  { id: 'savva', name: 'Савва', shares: { dev: 0.5, padel: 0.33 }, cashbox: true },
  { id: 'andrey', name: 'Андрей', shares: { dev: 0.5, padel: 0.34 }, cashbox: true },
  { id: 'dmitry', name: 'Дмитрий', shares: { dev: 0, padel: 0.33 }, cashbox: false }
];

/**
 * Личные счета владельцев, посчитанные из операций (п.15: всегда согласованы, где бы ни меняли).
 * Каждое направление: (доходы − расходы) делятся по долям OWNERS.
 * Расход, записанный на конкретного человека («Чей расход»), вычитается целиком
 * только у него и не делится на всех. Переводы между своими счетами не считаются.
 */
export function ownerBalances(finance) {
  const res = {};
  OWNERS.forEach((o) => { res[o.id] = { dev: 0, padel: 0, personal: 0, total: 0 }; });
  for (const f of finance || []) {
    const amt = Number(f.amount || 0);
    if (!amt) continue;
    if (f.category === 'Перевод между счетами') continue;
    if (f.type === 'income') {
      OWNERS.forEach((o) => {
        const sh = o.shares[f.unit] || 0;
        if (sh) res[o.id][f.unit] += amt * sh;
      });
    } else if (f.owner && res[f.owner]) {
      // личный расход владельца — целиком с его счёта
      res[f.owner].personal += amt;
    } else {
      // общий расход направления — уменьшает делимое по тем же долям
      OWNERS.forEach((o) => {
        const sh = o.shares[f.unit] || 0;
        if (sh) res[o.id][f.unit] -= amt * sh;
      });
    }
  }
  OWNERS.forEach((o) => {
    const r = res[o.id];
    r.total = r.dev + r.padel - r.personal;
  });
  return res;
}

export const FIN_METHODS = [
  { id: 'account', name: 'Счёт' },
  { id: 'card', name: 'Карта' },
  { id: 'sbp', name: 'СБП' },
  { id: 'cash', name: 'Наличные' },
  { id: 'other', name: 'Другое' }
];

export const FIN_CATEGORIES = [
  'Оплата клиента', 'Аренда', 'Зарплата', 'Компенсация сотруднику', 'Реклама', 'Инвентарь', 'Сервисы', 'Налоги', 'Перевод между счетами', 'Прочее'
];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- Демо-данные ----------
function seedData() {
  const now = Date.now();
  const d = (days) => new Date(now + days * 864e5).toISOString().slice(0, 10);
  const admin = { id: 'u-admin', name: 'Савва', code: '111111', role: 'admin', unit: 'all', phone: '', tg: '', active: true, created: now };
  const emp1 = { id: 'u-oleg', name: 'Олег (падел)', code: '222222', role: 'staff', unit: 'padel', phone: '+7 900 000-00-01', tg: '@oleg', active: true, created: now };
  const emp2 = { id: 'u-dasha', name: 'Даша (разработка)', code: '333333', role: 'staff', unit: 'dev', phone: '+7 900 000-00-02', tg: '@dasha', active: true, created: now };
  return {
    employees: [admin, emp1, emp2],
    clients: [
      { id: uid(), unit: 'dev', name: 'Кофейня «Зерно»', company: 'ИП Иванов', phone: '+7 912 345-67-89', tg: '@zerno', status: 'work', amount: 120000, notes: 'Сайт + онлайн-меню. Предоплата получена.', created: now, updated: now },
      { id: uid(), unit: 'dev', name: 'Барбершоп TRIM', company: 'ООО «Трим»', phone: '+7 923 456-78-90', tg: '', status: 'talks', amount: 80000, notes: 'Хотят запись онлайн, ждут КП.', created: now, updated: now },
      { id: uid(), unit: 'dev', name: 'Автосервис 777', company: '', phone: '+7 934 567-89-01', tg: '', status: 'lead', amount: 0, notes: 'Пришёл с сайта, перезвонить.', created: now, updated: now }
    ],
    venues: [
      { id: uid(), unit: 'padel', name: 'Padel Arena', address: 'ул. Спортивная, 12', contact: 'Мария', phone: '+7 901 111-22-33', price: '3500 ₽/час', status: 'active', notes: '4 корта, скидка при аренде от 3 часов.', created: now },
      { id: uid(), unit: 'padel', name: 'СК «Олимп»', address: 'пр. Мира, 5', contact: 'Игорь', phone: '+7 902 222-33-44', price: '2800 ₽/час', status: 'talks', notes: 'Обсуждаем субботние слоты.', created: now }
    ],
    players: [
      { id: uid(), unit: 'padel', name: 'Андрей Соколов', phone: '+7 905 111-11-11', level: 'C', city: '', notes: 'Играет с 2024, приводит друзей.', created: now },
      { id: uid(), unit: 'padel', name: 'Мария Ким', phone: '+7 905 222-22-22', level: 'B', city: '', notes: '', created: now },
      { id: uid(), unit: 'padel', name: 'Пётр Волков', phone: '+7 905 333-33-33', level: 'D', city: '', notes: 'Новичок, был на 1 турнире.', created: now }
    ],
    tasks: [
      { id: uid(), unit: 'padel', title: 'Подтвердить корты на субботу', desc: 'Позвонить в Padel Arena, забронировать 4 корта на 12:00–16:00.', assigneeId: 'u-oleg', authorId: 'u-admin', status: 'progress', priority: 'high', due: d(1), created: now, updated: now, comments: [{ authorId: 'u-oleg', text: 'Позвонил, ждут предоплату до пятницы', ts: now }] },
      { id: uid(), unit: 'padel', title: 'Собрать список игроков на турнир', desc: 'Обзвонить базу, цель — 16 участников.', assigneeId: 'u-oleg', authorId: 'u-admin', status: 'new', priority: 'normal', due: d(3), created: now, updated: now, comments: [] },
      { id: uid(), unit: 'dev', title: 'Показать макет кофейне «Зерно»', desc: '', assigneeId: 'u-dasha', authorId: 'u-admin', status: 'new', priority: 'normal', due: d(2), created: now, updated: now, comments: [] },
      { id: uid(), unit: 'dev', title: 'Выставить счёт барбершопу', desc: 'После согласования КП.', assigneeId: 'u-admin', authorId: 'u-admin', status: 'new', priority: 'low', due: d(5), created: now, updated: now, comments: [] }
    ],
    staffExpenses: [
      { id: uid(), employeeId: 'u-oleg', unit: 'padel', date: d(-1), amount: 500, title: 'Бананы и вода на турнир', status: 'pending', receiptId: 'f-demo', created: now, updated: now }
    ],
    files: [
      { id: 'f-demo', b64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', byId: 'u-oleg', created: now }
    ],
    cash: [
      { id: uid(), owner: 'savva', date: d(-4), type: 'income', amount: 20000, category: 'Прочее', comment: 'Пополнение кассы', created: now, updated: now }
    ],
    finance: [
      { id: uid(), unit: 'padel', date: d(-1), type: 'expense', amount: 30000, method: 'cash', source: 'manual', category: 'Зарплата', counterparty: 'Олег (падел)', comment: 'Зарплата за месяц', bankId: '', employeeId: 'u-oleg' },
      { id: uid(), unit: 'dev', date: d(-2), type: 'income', amount: 60000, method: 'account', source: 'manual', category: 'Оплата клиента', counterparty: 'Кофейня «Зерно»', comment: 'Предоплата 50% за сайт', bankId: '' },
      { id: uid(), unit: 'padel', date: d(-3), type: 'income', amount: 24000, method: 'sbp', source: 'manual', category: 'Оплата клиента', counterparty: 'Взносы игроков', comment: 'Турнир 12 участников × 2000', bankId: '' },
      { id: uid(), unit: 'padel', date: d(-3), type: 'expense', amount: 14000, method: 'card', source: 'manual', category: 'Аренда', counterparty: 'Padel Arena', comment: 'PADEL KLUB корты на турнир', bankId: '' },
      { id: uid(), unit: 'dev', date: d(-6), type: 'expense', amount: 3500, method: 'card', source: 'manual', category: 'Сервисы', counterparty: 'Хостинг', comment: '', bankId: '' }
    ],
    notifications: [
      { id: uid(), toId: 'u-admin', text: 'Демо-режим: это пример уведомления. Подключите базу — и они станут настоящими.', link: '#/tasks', read: false, created: now }
    ]
  };
}

// ---------- LocalStore (демо) ----------
const LS_KEY = 'monetki_demo_db';

class LocalStore {
  constructor() { this.demo = true; }
  _db() {
    let raw = localStorage.getItem(LS_KEY);
    let db;
    if (!raw) { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); return db; }
    try { db = JSON.parse(raw); } catch { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    ['staffExpenses', 'cash', 'files'].forEach((k) => { if (!db[k]) db[k] = []; });
    return db;
  }
  _save(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }

  async login(code) {
    const db = this._db();
    const u = db.employees.find((e) => e.code === String(code).trim() && e.active);
    if (!u) return { ok: false, error: 'Неверный код доступа' };
    return { ok: true, token: 'demo:' + u.id, profile: this._profile(u) };
  }
  _profile(u) { return { id: u.id, name: u.name, role: u.role, unit: u.unit, phone: u.phone, tg: u.tg }; }
  _user(token) {
    const db = this._db();
    const id = String(token || '').replace('demo:', '');
    return db.employees.find((e) => e.id === id && e.active) || null;
  }

  async bootstrap(token) {
    const db = this._db();
    const u = this._user(token);
    if (!u) return { ok: false, error: 'auth' };
    const isAdmin = u.role === 'admin';
    const canSee = (unit) => isAdmin || u.unit === 'all' || u.unit === unit;
    return {
      ok: true,
      profile: this._profile(u),
      data: {
        // сотрудник видит только людей своего направления (и админов) — п.7
        employees: db.employees
          .filter((e) => isAdmin || e.unit === u.unit || e.unit === 'all' || e.role === 'admin')
          .map((e) => (isAdmin ? e : { id: e.id, name: e.name, role: e.role, unit: e.unit, active: e.active })),
        clients: db.clients.filter((c) => canSee(c.unit)),
        venues: db.venues.filter((v) => canSee(v.unit)),
        players: db.players.filter((p) => canSee(p.unit)),
        tasks: db.tasks.filter((t) => canSee(t.unit)),
        finance: isAdmin ? db.finance : db.finance.filter((f) => f.employeeId === u.id),
        staffExpenses: isAdmin ? db.staffExpenses : db.staffExpenses.filter((e) => e.employeeId === u.id),
        cash: isAdmin ? db.cash : db.cash.filter((c) => c.employeeId === u.id),
        bankBalance: isAdmin ? { amount: 175000, updated: new Date().toISOString() } : null,
        notifications: db.notifications.filter((n) => n.toId === u.id)
      }
    };
  }

  _salaryOffsets(db, u, item) {
    // Зарплата с зачётом трат: вычитаем выбранные траты, помечаем их погашенными
    const ids = item.offsetIds || [];
    delete item.offsetIds;
    if (!ids.length || item.category !== 'Зарплата' || !item.employeeId) return null;
    const exps = db.staffExpenses.filter((e) => ids.includes(e.id) && e.employeeId === item.employeeId && e.status === 'pending');
    const sum = exps.reduce((s, e) => s + Number(e.amount || 0), 0);
    if (!sum) return null;
    if (Number(item.amount) < sum) return { error: 'Сумма трат больше зарплаты' };
    item.amount = Number(item.amount) - sum;
    item.comment = ((item.comment || '') + ` (за вычетом трат ${sum} ₽)`).trim();
    exps.forEach((e) => { e.status = 'returned_salary'; e.updated = Date.now(); });
    return { sum, titles: exps.map((e) => e.title).join(', ') };
  }

  async create(token, entity, item) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    if (['employees', 'finance', 'cash'].includes(entity) && u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    item = { ...item, id: item.id || uid(), created: Date.now(), updated: Date.now() };
    if (entity === 'employees' && !item.code) item.code = String(Math.floor(100000 + Math.random() * 900000));
    if (entity === 'tasks' && u.role !== 'admin') item.assigneeId = u.id; // п.3: сотрудник ставит задачи только себе
    if (entity === 'staffExpenses') {
      if (!item.receiptId) return { ok: false, error: 'Прикрепите фото чека' };
      if (u.role !== 'admin') { item.employeeId = u.id; item.unit = u.unit === 'all' ? (item.unit || 'padel') : u.unit; }
      item.status = item.status || 'pending';
      db.employees.filter((e) => e.role === 'admin' && e.active && e.id !== u.id)
        .forEach((a) => db.notifications.push({ id: uid(), toId: a.id, text: `${u.name}: трата ${item.amount} ₽ — ${item.title}`, link: '#/finance', read: false, created: Date.now() }));
    }
    let offsets = null;
    if ((entity === 'finance' || entity === 'cash') && item.category === 'Зарплата') {
      offsets = this._salaryOffsets(db, u, item);
      if (offsets?.error) return { ok: false, error: offsets.error };
    }
    db[entity].push(item);
    if (offsets?.sum) {
      db[entity].push({
        id: uid(), unit: item.unit, owner: item.owner, date: item.date,
        type: 'expense', amount: offsets.sum, method: item.method || 'cash', source: 'manual',
        category: 'Компенсация сотруднику', counterparty: '', comment: `Зачтено в зарплате: ${offsets.titles}`,
        employeeId: item.employeeId, created: Date.now(), updated: Date.now()
      });
    }
    if (entity === 'tasks' && item.assigneeId && item.assigneeId !== u.id) {
      db.notifications.push({ id: uid(), toId: item.assigneeId, text: `Новая задача: ${item.title}`, link: '#/tasks', read: false, created: Date.now() });
    }
    if ((entity === 'finance' || entity === 'cash') && item.employeeId) {
      db.notifications.push({ id: uid(), toId: item.employeeId, text: `Вам ${item.category === 'Зарплата' ? 'начислена зарплата' : 'проведена выплата'}: ${item.amount} ₽${entity === 'cash' ? ' (наличными)' : ''}`, link: '#/money', read: false, created: Date.now() });
    }
    this._save(db);
    return { ok: true, item };
  }

  async update(token, entity, item) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    if (['employees', 'finance', 'cash'].includes(entity) && u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const i = db[entity].findIndex((x) => x.id === item.id);
    if (i < 0) return { ok: false, error: 'Не найдено' };
    const before = db[entity][i];
    // п.1–2: сотрудник меняет содержимое только своих задач; в чужих (от админа) — только статус
    if (entity === 'tasks' && u.role !== 'admin' && before.authorId !== u.id) {
      if (before.assigneeId !== u.id) return { ok: false, error: 'Нет доступа' };
      item = { id: before.id, status: item.status };
    }
    db[entity][i] = { ...before, ...item, updated: Date.now() };
    if (entity === 'tasks') {
      const t = db[entity][i];
      if (before.status !== t.status && t.authorId && t.authorId !== u.id) {
        const st = TASK_STATUSES.find((s) => s.id === t.status);
        db.notifications.push({ id: uid(), toId: t.authorId, text: `${u.name} — «${t.title}»: ${st ? st.name : t.status}`, link: '#/tasks', read: false, created: Date.now() });
      }
      if (before.assigneeId !== t.assigneeId && t.assigneeId && t.assigneeId !== u.id) {
        db.notifications.push({ id: uid(), toId: t.assigneeId, text: `Вам передали задачу: ${t.title}`, link: '#/tasks', read: false, created: Date.now() });
      }
    }
    this._save(db);
    return { ok: true, item: db[entity][i] };
  }

  async uploadFile(token, b64) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    if (!b64 || b64.length > 2000000) return { ok: false, error: 'Фото слишком большое' };
    const db = this._db();
    const item = { id: uid(), b64, byId: u.id, created: Date.now() };
    db.files.push(item);
    this._save(db);
    return { ok: true, id: item.id };
  }

  async getFile(token, id) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    const f = db.files.find((x) => x.id === id);
    if (!f) return { ok: false, error: 'Не найдено' };
    const linked = db.staffExpenses.find((e) => e.receiptId === id);
    if (u.role !== 'admin' && f.byId !== u.id && linked?.employeeId !== u.id) return { ok: false, error: 'Нет доступа' };
    return { ok: true, b64: f.b64 };
  }

  async remove(token, entity, id) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    if (['employees', 'finance', 'cash'].includes(entity) && u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const before = db[entity].find((x) => x.id === id);
    if (!before) return { ok: false, error: 'Не найдено' };
    if (entity === 'tasks' && u.role !== 'admin' && before.authorId !== u.id) return { ok: false, error: 'Удалять можно только свои задачи' };
    if (entity === 'staffExpenses' && u.role !== 'admin' && (before.employeeId !== u.id || before.status !== 'pending')) return { ok: false, error: 'Нет доступа' };
    db[entity] = db[entity].filter((x) => x.id !== id);
    this._save(db);
    return { ok: true };
  }

  async addComment(token, taskId, text) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    const t = db.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, error: 'Задача не найдена' };
    t.comments = t.comments || [];
    t.comments.push({ authorId: u.id, text, ts: Date.now() });
    const others = [t.authorId, t.assigneeId].filter((id) => id && id !== u.id);
    [...new Set(others)].forEach((id) => db.notifications.push({ id: uid(), toId: id, text: `${u.name}: ${text.slice(0, 80)} (задача «${t.title}»)`, link: '#/tasks', read: false, created: Date.now() }));
    this._save(db);
    return { ok: true, item: t };
  }

  async importPlayers(token, rows) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    let added = 0;
    for (const r of rows) {
      if (!r.name) continue;
      const dup = db.players.find((p) => p.name.toLowerCase() === r.name.toLowerCase() && (p.phone || '') === (r.phone || ''));
      if (dup) continue;
      db.players.push({ id: uid(), unit: 'padel', name: r.name, phone: r.phone || '', level: r.level || '', city: r.city || '', notes: r.notes || '', created: Date.now() });
      added++;
    }
    this._save(db);
    return { ok: true, added };
  }

  async status() {
    const db = this._db();
    return { ok: true, backend: 'demo', employees: db.employees.length };
  }

  async migrateImport(token, data) {
    const u = this._user(token);
    const db = this._db();
    if (db.employees.length && (!u || u.role !== 'admin')) return { ok: false, error: 'Только для админа' };
    let imported = 0;
    ['employees', 'clients', 'venues', 'players', 'tasks', 'finance', 'staffExpenses', 'cash', 'files', 'notifications'].forEach((entity) => {
      (data?.[entity] || []).forEach((item) => {
        if (!item?.id) return;
        db[entity] = db[entity] || [];
        const i = db[entity].findIndex((x) => x.id === item.id);
        if (i >= 0) db[entity][i] = item; else db[entity].push(item);
        imported++;
      });
    });
    this._save(db);
    return { ok: true, imported };
  }

  async resolveExpense(token, id, how) {
    const u = this._user(token); if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const ex = db.staffExpenses.find((x) => x.id === id);
    if (!ex) return { ok: false, error: 'Не найдено' };
    if (ex.status !== 'pending') return { ok: false, error: 'Уже возвращено' };
    const emp = db.employees.find((e) => e.id === ex.employeeId);
    const cashOwner = String(how).startsWith('cash:') ? String(how).slice(5) : null;
    ex.status = cashOwner ? 'returned_cash' : 'returned_bank';
    ex.updated = Date.now();
    if (cashOwner) {
      // возврат наличными — списывается с кассы владельца, в общую статистику не попадает
      db.cash.push({ id: uid(), owner: cashOwner, date: new Date().toISOString().slice(0, 10), type: 'expense', amount: ex.amount, category: 'Компенсация сотруднику', comment: ex.title, employeeId: ex.employeeId, created: Date.now(), updated: Date.now() });
    }
    db.notifications.push({ id: uid(), toId: ex.employeeId, text: `Вам вернули ${ex.amount} ₽ (${cashOwner ? 'наличными' : 'со счёта'}) — ${ex.title}`, link: '#/money', read: false, created: Date.now() });
    this._save(db);
    return { ok: true, item: ex };
  }

  async markRead(token, ids) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    db.notifications.forEach((n) => { if (ids.includes(n.id)) n.read = true; });
    this._save(db);
    return { ok: true };
  }

  reset() { localStorage.removeItem(LS_KEY); }
}

// ---------- RemoteStore (Google Apps Script) ----------
class RemoteStore {
  constructor(url) { this.url = url; this.demo = false; }
  async _call(body) {
    try {
      // POST с text/plain — чтобы браузер не делал preflight-запрос (Apps Script его не умеет).
      const resp = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      return await resp.json();
    } catch (e) {
      return { ok: false, error: 'Нет связи с базой. Проверьте интернет.' };
    }
  }
  login(code) { return this._call({ action: 'login', code }); }
  bootstrap(token) { return this._call({ action: 'bootstrap', token }); }
  create(token, entity, item) { return this._call({ action: 'create', token, entity, item }); }
  update(token, entity, item) { return this._call({ action: 'update', token, entity, item }); }
  remove(token, entity, id) { return this._call({ action: 'delete', token, entity, id }); }
  addComment(token, taskId, text) { return this._call({ action: 'comment', token, taskId, text }); }
  importPlayers(token, rows) { return this._call({ action: 'import_players', token, rows }); }
  markRead(token, ids) { return this._call({ action: 'mark_read', token, ids }); }
  resolveExpense(token, id, how) { return this._call({ action: 'resolve_expense', token, id, how }); }
  status() { return this._call({ action: 'status' }); }
  migrateImport(token, data) { return this._call({ action: 'migrate_import', token, data }); }
  uploadFile(token, b64) { return this._call({ action: 'upload_file', token, b64 }); }
  getFile(token, id) { return this._call({ action: 'get_file', token, id }); }
}

export function makeStore() {
  const cfg = window.MONETKI_CONFIG || {};
  const override = (localStorage.getItem('monetki_backend') || '').trim();
  if (override === 'demo') return new LocalStore(); // служебный режим для тестирования интерфейса
  const url = override || (cfg.backendUrl || '').trim();
  return url ? new RemoteStore(url) : new LocalStore();
}
