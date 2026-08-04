// ============ Слой данных «Монеток» ============
// Два режима:
//  - RemoteStore: общая база в Google Таблицах через веб-приложение Apps Script (см. SETUP.md)
//  - LocalStore: демо-режим, данные лежат в localStorage этого браузера
// Оба реализуют один и тот же набор методов, чтобы приложение не знало разницы.

export const UNITS = {
  padel: { id: 'padel', name: 'Падел', emoji: '🎾' },
  dev: { id: 'dev', name: 'Разработка', emoji: '💻' }
};

export const BUSINESS_MODULES = {
  dashboard: 'Дашборд', tasks: 'Задачи', clients: 'Клиенты', venues: 'Площадки',
  players: 'Игроки', finance: 'Финансы', money: 'Деньги сотрудника', team: 'Команда'
};

export const DEFAULT_BUSINESSES = [
  { id: 'padel', name: 'Падел', emoji: '🎾', modules: ['dashboard', 'tasks', 'venues', 'players', 'finance', 'money', 'team'], active: true },
  { id: 'dev', name: 'Разработка', emoji: '💻', modules: ['dashboard', 'tasks', 'clients', 'finance', 'money', 'team'], active: true }
];

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

export const DEFAULT_BUSINESS_OWNERS = [
  { id: 'owner-dev-savva', businessId: 'dev', unit: 'dev', ownerId: 'savva', name: 'Савва', share: 0.5 },
  { id: 'owner-dev-andrey', businessId: 'dev', unit: 'dev', ownerId: 'andrey', name: 'Андрей', share: 0.5 },
  { id: 'owner-padel-andrey', businessId: 'padel', unit: 'padel', ownerId: 'andrey', name: 'Андрей', share: 0.34 },
  { id: 'owner-padel-savva', businessId: 'padel', unit: 'padel', ownerId: 'savva', name: 'Савва', share: 0.33 },
  { id: 'owner-padel-dmitry', businessId: 'padel', unit: 'padel', ownerId: 'dmitry', name: 'Дмитрий', share: 0.33 }
];

export const businessIdOf = (item) => item?.businessId || item?.unit || '';

function scopedItem(item, fallback = '') {
  const businessId = item.businessId || item.unit || fallback;
  if (!businessId || businessId === 'all') return item;
  if (item.businessId && item.unit && item.businessId !== item.unit) return null;
  item.businessId = businessId;
  item.unit = businessId;
  return item;
}

function legacyBusinessIds(employee) {
  if (employee.role === 'admin' || employee.unit === 'all') return DEFAULT_BUSINESSES.map((b) => b.id);
  return employee.unit ? [employee.unit] : [];
}

function ensureCoreData(db) {
  let changed = false;
  ['businesses', 'memberships', 'businessOwners', 'staffExpenses', 'cash', 'files'].forEach((key) => {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  });
  DEFAULT_BUSINESSES.forEach((business) => {
    if (!db.businesses.some((x) => x.id === business.id)) {
      db.businesses.push({ ...business, modules: [...business.modules], created: Date.now(), updated: Date.now() });
      changed = true;
    }
  });
  DEFAULT_BUSINESS_OWNERS.forEach((owner) => {
    if (!db.businessOwners.some((x) => businessIdOf(x) === owner.businessId && x.ownerId === owner.ownerId)) {
      db.businessOwners.push({ ...owner, created: Date.now(), updated: Date.now() });
      changed = true;
    }
  });
  const activeBusinessIds = db.businesses.filter((business) => business.active !== false).map((business) => business.id);
  (db.employees || []).forEach((employee) => {
    const globalAdmin = employee.active !== false && employee.role === 'admin';
    const businessIds = globalAdmin ? activeBusinessIds : legacyBusinessIds(employee);
    businessIds.forEach((businessId) => {
      const existing = db.memberships.find((membership) => membership.employeeId === employee.id && businessIdOf(membership) === businessId);
      if (!existing) {
        db.memberships.push({
          id: `membership-${businessId}-${employee.id}`, businessId, unit: businessId,
          employeeId: employee.id, role: globalAdmin ? 'owner' : 'staff', active: employee.active !== false,
          created: Date.now(), updated: Date.now()
        });
        changed = true;
      } else if (globalAdmin && (existing.active === false || existing.role !== 'owner')) {
        Object.assign(existing, { businessId, unit: businessId, role: 'owner', active: true, updated: Date.now() });
        changed = true;
      }
    });
  });
  ['clients', 'venues', 'players', 'tasks', 'finance', 'staffExpenses'].forEach((entity) => {
    (db[entity] || []).forEach((item) => {
      const beforeBusinessId = item.businessId;
      const beforeUnit = item.unit;
      if (scopedItem(item) && (beforeBusinessId !== item.businessId || beforeUnit !== item.unit)) changed = true;
    });
  });
  return changed;
}

// Направления, где сотрудникам доступны траты с возмещением (пока только падел).
export const EXPENSE_UNITS = ['padel'];
export const canUseExpenses = (unit) => unit === 'all' || EXPENSE_UNITS.includes(unit);

// Варианты «чей расход»: конкретный владелец или совместный (делится между ними).
// Возвращает [[ownerId, доля], ...] для личного расхода, либо null — если общий.
export const OWNER_GROUPS = { savva_andrey: { name: 'Савва и Андрей', parts: [['savva', 0.5], ['andrey', 0.5]] } };
export function ownerParts(owner) {
  if (!owner) return null;
  if (OWNER_GROUPS[owner]) return OWNER_GROUPS[owner].parts;
  if (OWNERS.some((o) => o.id === owner)) return [[owner, 1]];
  return null; // неизвестное значение — считаем расход общим
}
export const ownerLabel = (owner) => OWNER_GROUPS[owner]?.name || OWNERS.find((o) => o.id === owner)?.name || '';

/**
 * Личные счета владельцев, посчитанные из операций (п.15: всегда согласованы, где бы ни меняли).
 * Каждое направление: (доходы − расходы) делятся по долям OWNERS.
 * Расход, записанный на конкретного человека («Чей расход»), вычитается целиком
 * только у него и не делится на всех. Переводы между своими счетами не считаются.
 */
export function ownerBalances(finance, businessOwners = []) {
  const emptyBalance = () => new Map([['dev', 0], ['padel', 0], ['personal', 0], ['total', 0]]);
  const res = new Map();
  OWNERS.forEach((o) => { res.set(o.id, emptyBalance()); });
  const configured = new Map();
  (businessOwners || []).filter((x) => x.active !== false).forEach((x) => {
    const businessId = businessIdOf(x);
    if (!businessId || !x.ownerId) return;
    if (!configured.has(businessId)) configured.set(businessId, []);
    configured.get(businessId).push([x.ownerId, Number(x.share || 0)]);
    if (!res.has(x.ownerId)) res.set(x.ownerId, emptyBalance());
    const balance = res.get(x.ownerId);
    if (!balance.has(businessId)) balance.set(businessId, 0);
  });
  const shares = (businessId) => configured.get(businessId)?.length
    ? configured.get(businessId)
    : OWNERS.map((o) => [o.id, Number(Object.hasOwn(o.shares, businessId) ? o.shares[businessId] : 0)]).filter(([, share]) => share);
  for (const f of finance || []) {
    const amt = Number(f.amount || 0);
    const businessId = businessIdOf(f);
    if (!amt) continue;
    if (f.category === 'Перевод между счетами') continue;
    if (f.type === 'income') {
      shares(businessId).forEach(([ownerId, share]) => {
        const balance = res.get(ownerId);
        if (balance && share) balance.set(businessId, Number(balance.get(businessId) || 0) + amt * share);
      });
    } else if (ownerParts(f.owner)) {
      // расход на конкретного владельца или на пару (Савва и Андрей — пополам)
      for (const [oid, sh] of ownerParts(f.owner)) {
        const balance = res.get(oid);
        if (balance) balance.set('personal', Number(balance.get('personal') || 0) + amt * sh);
      }
    } else {
      // общий расход направления — уменьшает делимое по тем же долям
      shares(businessId).forEach(([ownerId, share]) => {
        const balance = res.get(ownerId);
        if (balance && share) balance.set(businessId, Number(balance.get(businessId) || 0) - amt * share);
      });
    }
  }
  res.forEach((balance) => {
    const businessTotal = [...balance.entries()]
      .filter(([key]) => key !== 'personal' && key !== 'total')
      .reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
    balance.set('total', businessTotal - Number(balance.get('personal') || 0));
  });
  return Object.fromEntries([...res.entries()].map(([ownerId, balance]) => [ownerId, Object.fromEntries(balance)]));
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
    businesses: DEFAULT_BUSINESSES.map((x) => ({ ...x, modules: [...x.modules], created: now, updated: now })),
    memberships: [
      { id: 'membership-padel-u-admin', businessId: 'padel', unit: 'padel', employeeId: 'u-admin', role: 'owner', active: true, created: now, updated: now },
      { id: 'membership-dev-u-admin', businessId: 'dev', unit: 'dev', employeeId: 'u-admin', role: 'owner', active: true, created: now, updated: now },
      { id: 'membership-padel-u-oleg', businessId: 'padel', unit: 'padel', employeeId: 'u-oleg', role: 'staff', active: true, created: now, updated: now },
      { id: 'membership-dev-u-dasha', businessId: 'dev', unit: 'dev', employeeId: 'u-dasha', role: 'staff', active: true, created: now, updated: now }
    ],
    businessOwners: DEFAULT_BUSINESS_OWNERS.map((x) => ({ ...x, created: now, updated: now })),
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
const CORE_ENTITIES = ['businesses', 'memberships', 'businessOwners'];
const BUSINESS_SCOPED_ENTITIES = ['clients', 'venues', 'players', 'tasks', 'finance', 'staffExpenses'];
const LOCAL_ENTITIES = [
  ...CORE_ENTITIES, 'employees', ...BUSINESS_SCOPED_ENTITIES, 'cash', 'files', 'notifications'
];

function membershipsOf(db, employeeId) {
  return (db.memberships || []).filter((x) => x.employeeId === employeeId && x.active !== false);
}

function canAccessBusiness(db, user, businessId) {
  if (!businessId || businessId === 'all') return false;
  return membershipsOf(db, user.id).some((x) => businessIdOf(x) === businessId);
}

function sharedBusiness(db, leftId, rightId) {
  const left = new Set(membershipsOf(db, leftId).map(businessIdOf));
  return membershipsOf(db, rightId).some((x) => left.has(businessIdOf(x)));
}

function scopeError(item) {
  if (item?.businessId && item?.unit && item.businessId !== item.unit) return 'businessId и unit должны совпадать';
  return null;
}

function coreValidationError(db, entity, item, ignoreId = '') {
  if (entity === 'businesses') {
    const id = String(item?.id || '').trim();
    if (!id || ['all', 'personal', 'total'].includes(id) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return 'ID бизнеса должен быть безопасным slug';
    if (db.businesses.some((business) => business.id === id && business.id !== ignoreId)) return 'Бизнес с таким ID уже существует';
    if (!String(item?.name || '').trim()) return 'Не указано название бизнеса';
    if (!Array.isArray(item?.modules)) return 'Модули бизнеса должны быть списком';
    if (typeof item?.active !== 'boolean') return 'Статус бизнеса должен быть логическим';
  }
  if (entity === 'memberships') {
    const businessId = businessIdOf(item);
    if (!db.businesses.some((business) => business.id === businessId)) return 'Бизнес не найден';
    if (!db.employees.some((employee) => employee.id === item?.employeeId)) return 'Сотрудник не найден';
    if (!['owner', 'manager', 'staff'].includes(String(item?.role || ''))) return 'Неизвестная роль доступа';
    if (db.memberships.some((membership) => membership.id !== ignoreId && membership.employeeId === item.employeeId && businessIdOf(membership) === businessId)) {
      return 'Доступ сотрудника к этому бизнесу уже существует';
    }
  }
  if (entity === 'businessOwners') {
    const businessId = businessIdOf(item);
    const ownerId = String(item?.ownerId || '').trim();
    const share = Number(item?.share);
    if (!db.businesses.some((business) => business.id === businessId)) return 'Бизнес не найден';
    if (!ownerId) return 'Не указан участник бизнеса';
    if (item?.share === '' || item?.share === null || !Number.isFinite(share) || share < 0 || share > 1) return 'Доля должна быть числом от 0 до 1';
    if (db.businessOwners.some((owner) => owner.id !== ignoreId && owner.ownerId === ownerId && businessIdOf(owner) === businessId)) {
      return 'Участник уже добавлен в этот бизнес';
    }
  }
  return null;
}

export class LocalStore {
  constructor() { this.demo = true; }
  _db() {
    let raw = localStorage.getItem(LS_KEY);
    let db;
    if (!raw) { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); return db; }
    try { db = JSON.parse(raw); } catch { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    if (ensureCoreData(db)) localStorage.setItem(LS_KEY, JSON.stringify(db));
    return db;
  }
  _save(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }

  async login(code) {
    const db = this._db();
    const u = db.employees.find((e) => e.code === String(code).trim() && e.active);
    if (!u) return { ok: false, error: 'Неверный код доступа' };
    return { ok: true, token: 'demo:' + u.id, profile: this._profile(db, u) };
  }
  _profile(db, u) {
    return {
      id: u.id, name: u.name, role: u.role, unit: u.unit, phone: u.phone, tg: u.tg,
      businessIds: membershipsOf(db, u.id).map(businessIdOf)
    };
  }
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
    const activeBusinessIds = new Set(db.businesses.filter((business) => business.active !== false).map((business) => business.id));
    const canSee = (item) => activeBusinessIds.has(businessIdOf(item)) && canAccessBusiness(db, u, businessIdOf(item));
    return {
      ok: true,
      profile: this._profile(db, u),
      data: {
        businesses: db.businesses.filter((b) => canAccessBusiness(db, u, b.id) && (isAdmin || b.active !== false)),
        memberships: isAdmin ? db.memberships : db.memberships.filter((m) => m.employeeId === u.id),
        businessOwners: isAdmin ? db.businessOwners : [],
        // сотрудник видит только людей доступных ему бизнесов (и админов)
        employees: db.employees
          .filter((e) => isAdmin || e.id === u.id || e.role === 'admin' || sharedBusiness(db, u.id, e.id))
          .map((e) => (isAdmin ? e : { id: e.id, name: e.name, role: e.role, unit: e.unit, active: e.active })),
        clients: db.clients.filter(canSee),
        venues: db.venues.filter(canSee),
        players: db.players.filter(canSee),
        tasks: db.tasks.filter((t) => canSee(t) && (isAdmin || t.assigneeId === u.id)),
        finance: db.finance.filter((f) => canSee(f) && (isAdmin || f.employeeId === u.id)),
        staffExpenses: db.staffExpenses.filter((e) => canSee(e) && (isAdmin || e.employeeId === u.id)),
        cash: isAdmin ? db.cash : db.cash.filter((c) => c.employeeId === u.id),
        bankBalance: isAdmin ? { amount: 175000, updated: new Date().toISOString() } : null,
        notifications: db.notifications.filter((n) => n.toId === u.id)
      }
    };
  }

  _baseWriteError(u, entity) {
    if (!LOCAL_ENTITIES.includes(entity) || entity === 'files') return 'Неизвестная сущность';
    if (entity === 'notifications') return 'Нельзя';
    if ([...CORE_ENTITIES, 'employees', 'finance', 'cash'].includes(entity) && u.role !== 'admin') return 'Только для админа';
    return null;
  }

  _scopeWriteError(db, u, item) {
    const mismatch = scopeError(item);
    if (mismatch) return mismatch;
    const businessId = businessIdOf(item);
    if (!businessId) return 'Не указан бизнес';
    if (!canAccessBusiness(db, u, businessId)) return 'Нет доступа к этому бизнесу';
    if (!db.businesses.some((business) => business.id === businessId && business.active !== false)) return 'Бизнес в архиве';
    return null;
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
    const baseError = this._baseWriteError(u, entity);
    if (baseError) return { ok: false, error: baseError };
    item = { ...item };
    if (entity === 'businesses') item.id = String(item.id || '').trim();
    if (entity === 'businessOwners') item.ownerId = String(item.ownerId || '').trim();
    const coreError = CORE_ENTITIES.includes(entity) ? coreValidationError(db, entity, item) : null;
    if (coreError) return { ok: false, error: coreError };
    if (entity === 'staffExpenses' && u.role !== 'admin' && !businessIdOf(item)) scopedItem(item, u.unit);
    if (BUSINESS_SCOPED_ENTITIES.includes(entity)) {
      const accessError = this._scopeWriteError(db, u, item);
      if (accessError) return { ok: false, error: accessError };
      scopedItem(item);
    }
    if (['memberships', 'businessOwners'].includes(entity)) {
      const accessError = this._scopeWriteError(db, u, item);
      if (accessError) return { ok: false, error: accessError };
      scopedItem(item);
    }
    // id всегда серверный — нельзя перезаписать чужую запись, прислав её id
    item = { ...item, id: entity === 'businesses' && item.id ? item.id : uid(), created: Date.now(), updated: Date.now() };
    if (entity === 'employees' && !item.code) item.code = String(Math.floor(100000 + Math.random() * 900000));
    if (entity === 'tasks' && u.role !== 'admin') item.assigneeId = u.id; // п.3: сотрудник ставит задачи только себе
    if (entity === 'staffExpenses') {
      const exUnit = businessIdOf(item) || (u.role === 'admin' ? 'padel' : u.unit);
      if (!canUseExpenses(exUnit)) return { ok: false, error: 'Траты для этого направления отключены' };
      if (!item.receiptId) return { ok: false, error: 'Прикрепите фото чека' };
      if (u.role !== 'admin') item.employeeId = u.id;
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
    if (entity === 'businesses') {
      db.memberships.push({
        id: `membership-${item.id}-${u.id}`, businessId: item.id, unit: item.id,
        employeeId: u.id, role: 'owner', active: true, created: Date.now(), updated: Date.now()
      });
    }
    if (entity === 'employees' || entity === 'businesses') ensureCoreData(db);
    if (offsets?.sum) {
      db[entity].push({
        id: uid(), businessId: item.businessId, unit: item.unit, owner: item.owner, date: item.date,
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
    const baseError = this._baseWriteError(u, entity);
    if (baseError) return { ok: false, error: baseError };
    const i = db[entity].findIndex((x) => x.id === item.id);
    if (i < 0) return { ok: false, error: 'Не найдено' };
    const before = db[entity][i];
    if (entity === 'businesses' && !canAccessBusiness(db, u, before.id)) return { ok: false, error: 'Нет доступа к этому бизнесу' };
    if (BUSINESS_SCOPED_ENTITIES.includes(entity) || ['memberships', 'businessOwners'].includes(entity)) {
      const sourceError = this._scopeWriteError(db, u, before);
      if (sourceError) return { ok: false, error: sourceError };
      const mismatch = scopeError(item);
      if (mismatch) return { ok: false, error: mismatch };
      const targetBusinessId = item.businessId || item.unit || businessIdOf(before);
      const targetError = this._scopeWriteError(db, u, { businessId: targetBusinessId, unit: targetBusinessId });
      if (targetError) return { ok: false, error: targetError };
      item = { ...item, businessId: targetBusinessId, unit: targetBusinessId };
    }
    const coreError = CORE_ENTITIES.includes(entity) ? coreValidationError(db, entity, { ...before, ...item }, before.id) : null;
    if (coreError) return { ok: false, error: coreError };
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
    const baseError = this._baseWriteError(u, entity);
    if (baseError) return { ok: false, error: baseError };
    const before = db[entity].find((x) => x.id === id);
    if (!before) return { ok: false, error: 'Не найдено' };
    if (entity === 'businesses' && !canAccessBusiness(db, u, before.id)) return { ok: false, error: 'Нет доступа к этому бизнесу' };
    if (BUSINESS_SCOPED_ENTITIES.includes(entity) || ['memberships', 'businessOwners'].includes(entity)) {
      const sourceError = this._scopeWriteError(db, u, before);
      if (sourceError) return { ok: false, error: sourceError };
    }
    if (entity === 'tasks' && u.role !== 'admin' && before.authorId !== u.id) return { ok: false, error: 'Удалять можно только свои задачи' };
    if (entity === 'staffExpenses' && u.role !== 'admin' && (before.employeeId !== u.id || before.status !== 'pending')) return { ok: false, error: 'Нет доступа' };
    if (entity === 'tasks' && before.assigneeId && before.assigneeId !== u.id && before.status !== 'done') {
      db.notifications.push({ id: uid(), toId: before.assigneeId, text: `Задача удалена: ${before.title}`, link: '#/tasks', read: false, created: Date.now() });
    }
    if (entity === 'businesses') {
      const archived = { ...before, active: false, updated: Date.now() };
      db[entity] = db[entity].map((item) => item.id === id ? archived : item);
      this._save(db);
      return { ok: true, item: archived };
    }
    db[entity] = db[entity].filter((x) => x.id !== id);
    this._save(db);
    return { ok: true };
  }

  async addComment(token, taskId, text) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    const t = db.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, error: 'Задача не найдена' };
    if (!canAccessBusiness(db, u, businessIdOf(t))) return { ok: false, error: 'Нет доступа' };
    if (!db.businesses.some((business) => business.id === businessIdOf(t) && business.active !== false)) return { ok: false, error: 'Бизнес в архиве' };
    if (u.role !== 'admin' && t.assigneeId !== u.id) return { ok: false, error: 'Нет доступа' };
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
    if (!canAccessBusiness(db, u, 'padel')) return { ok: false, error: 'Нет доступа' };
    if (!db.businesses.some((business) => business.id === 'padel' && business.active !== false)) return { ok: false, error: 'Бизнес в архиве' };
    let added = 0;
    for (const r of rows) {
      if (!r.name) continue;
      const dup = db.players.find((p) => p.name.toLowerCase() === r.name.toLowerCase() && (p.phone || '') === (r.phone || ''));
      if (dup) continue;
      db.players.push({ id: uid(), businessId: 'padel', unit: 'padel', name: r.name, phone: r.phone || '', level: r.level || '', city: r.city || '', notes: r.notes || '', created: Date.now() });
      added++;
    }
    this._save(db);
    return { ok: true, added };
  }

  async status() {
    const db = this._db();
    return { ok: true, backend: 'demo', empty: db.employees.length === 0, employees: db.employees.length };
  }

  async tochkaSync(token, days = 30) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'auth' };
    return {
      ok: true,
      added: 0,
      outcome: 'zero_transactions',
      diagnostics: {
        accounts: { total: 0, processed: 0, failed: 0 },
        statements: { requested: 0, ready: 0, empty: 0, notReady: 0, failed: 0 },
        transactions: { seen: 0, duplicates: 0, pending: 0 },
        errors: 0
      }
    };
  }

  async migrateImport(token, data) {
    const u = this._user(token);
    const db = this._db();
    if (db.employees.length && (!u || u.role !== 'admin')) return { ok: false, error: 'Только для админа' };
    let imported = 0;
    LOCAL_ENTITIES.forEach((entity) => {
      (data?.[entity] || []).forEach((item) => {
        if (!item?.id) return;
        db[entity] = db[entity] || [];
        const i = db[entity].findIndex((x) => x.id === item.id);
        if (i >= 0) db[entity][i] = item; else db[entity].push(item);
        imported++;
      });
    });
    ensureCoreData(db);
    this._save(db);
    return { ok: true, imported };
  }

  async resolveExpense(token, id, how) {
    const u = this._user(token); if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const ex = db.staffExpenses.find((x) => x.id === id);
    if (!ex) return { ok: false, error: 'Не найдено' };
    if (!canAccessBusiness(db, u, businessIdOf(ex))) return { ok: false, error: 'Нет доступа' };
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
    db.notifications.forEach((n) => { if (ids.includes(n.id) && n.toId === u.id) n.read = true; });
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
  tochkaSync(token, days = 30) { return this._call({ action: 'tochka_sync', token, days }); }
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
