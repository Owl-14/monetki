// ============ Слой данных «Монеток» ============
// Два режима:
//  - RemoteStore: общая база в Google Таблицах через веб-приложение Apps Script (см. SETUP.md)
//  - LocalStore: демо-режим, данные лежат в localStorage этого браузера
// Оба реализуют один и тот же набор методов, чтобы приложение не знало разницы.

import {
  EVENT_ENTITIES,
  eventDeleteError,
  eventModuleWriteError,
  eventReferenceDeleteError,
  eventRecordError,
  eventSettlementSnapshot,
  staffEventManageError,
  visibleEventCollections,
} from './event-rules.js';
import {
  BANK_RULE_ENGINE_VERSION,
  DEFAULT_BANK_RULE_SETTINGS,
  aggregateBankRulePreview,
  bankRuleEvaluationToken,
  canonicalJson,
  evaluateBankRules,
  publicBankRuleEvaluation,
  isSafeBankSignals,
  safeBankRuleSettings,
  validateBankRule,
} from './bank-rules.js';

export const UNITS = {
  padel: { id: 'padel', name: 'Падел', emoji: '🎾' },
  dev: { id: 'dev', name: 'Разработка', emoji: '💻' }
};

export const BUSINESS_MODULES = {
  dashboard: 'Дашборд', tasks: 'Задачи', clients: 'Клиенты', venues: 'Площадки',
  events: 'События', players: 'Игроки', stock: 'Склад', finance: 'Финансы', money: 'Деньги сотрудника', team: 'Команда'
};

export const DEFAULT_BUSINESSES = [
  { id: 'padel', name: 'Падел', emoji: '🎾', modules: ['dashboard', 'tasks', 'events', 'venues', 'players', 'stock', 'finance', 'money', 'team'], active: true },
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

export const CRM_ENTITIES = ['companies', 'contacts', 'leads', 'deals', 'pipelines', 'stages', 'dealItems'];

const DEFAULT_CRM_STAGES = [
  { suffix: 'contact', name: 'Первичный контакт', order: 10, type: 'open' },
  { suffix: 'talks', name: 'Переговоры', order: 20, type: 'open' },
  { suffix: 'prepayment', name: 'Договор и предоплата', order: 30, type: 'open' },
  { suffix: 'work', name: 'В работе', order: 40, type: 'open' },
  { suffix: 'won', name: 'Сдано и оплачено', order: 50, type: 'won' },
  { suffix: 'lost', name: 'Отказ', order: 60, type: 'lost' }
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
  [
    'businesses', 'memberships', 'businessOwners', 'staffExpenses', 'cash', 'files', 'bankTransactions',
    'bankRules', 'bankRuleVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'bankRuleSettingVersions', 'financeRelations', ...CRM_ENTITIES,
    'warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories', ...EVENT_ENTITIES
  ].forEach((key) => {
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
  db.businesses.filter((business) =>
    business.active !== false && Array.isArray(business.modules) && business.modules.includes('clients')
  ).forEach((business) => {
    const businessId = business.id;
    const pipelineId = `pipeline-${businessId}-default`;
    if (!db.pipelines.some((pipeline) => pipeline.id === pipelineId)) {
      db.pipelines.push({
        id: pipelineId, businessId, unit: businessId, name: 'Новые продажи',
        isDefault: true, active: true, created: Date.now(), updated: Date.now()
      });
      changed = true;
    }
    DEFAULT_CRM_STAGES.forEach((stage) => {
      const id = `stage-${businessId}-${stage.suffix}`;
      if (db.stages.some((item) => item.id === id)) return;
      db.stages.push({
        id, businessId, unit: businessId, pipelineId,
        name: stage.name, order: stage.order, type: stage.type,
        created: Date.now(), updated: Date.now()
      });
      changed = true;
    });
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
  [
    'clients', 'venues', 'players', 'tasks', 'finance', 'staffExpenses', ...CRM_ENTITIES,
    'warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories', ...EVENT_ENTITIES
  ].forEach((entity) => {
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
    // Старый список клиентов остаётся доступным для совместимости, но новый демо-режим
    // не подмешивает вымышленные CRM-записи.
    clients: [],
    companies: [],
    contacts: [],
    leads: [],
    deals: [],
    pipelines: [{
      id: 'pipeline-dev-default', businessId: 'dev', unit: 'dev', name: 'Новые продажи',
      isDefault: true, active: true, created: now, updated: now
    }],
    stages: DEFAULT_CRM_STAGES.map((stage) => ({
      id: `stage-dev-${stage.suffix}`, businessId: 'dev', unit: 'dev', pipelineId: 'pipeline-dev-default',
      name: stage.name, order: stage.order, type: stage.type, created: now, updated: now
    })),
    dealItems: [],
    venues: [
      { id: uid(), unit: 'padel', name: 'Padel Arena', address: 'ул. Спортивная, 12', contact: 'Мария', phone: '+7 901 111-22-33', price: '3500 ₽/час', status: 'active', notes: '4 корта, скидка при аренде от 3 часов.', created: now },
      { id: uid(), unit: 'padel', name: 'СК «Олимп»', address: 'пр. Мира, 5', contact: 'Игорь', phone: '+7 902 222-33-44', price: '2800 ₽/час', status: 'talks', notes: 'Обсуждаем субботние слоты.', created: now }
    ],
    players: [
      { id: uid(), unit: 'padel', name: 'Андрей Соколов', phone: '+7 905 111-11-11', level: 'C', city: '', notes: 'Играет с 2024, приводит друзей.', created: now },
      { id: uid(), unit: 'padel', name: 'Мария Ким', phone: '+7 905 222-22-22', level: 'B', city: '', notes: '', created: now },
      { id: uid(), unit: 'padel', name: 'Пётр Волков', phone: '+7 905 333-33-33', level: 'D', city: '', notes: 'Новичок, был на 1 турнире.', created: now }
    ],
    // События начинаются пустыми: исторический импорт MON-003 выполняется отдельной задачей.
    eventTypes: [],
    events: [],
    eventRegistrations: [],
    eventBudgetLines: [],
    eventFinanceAllocations: [],
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
    // Склад начинается пустым: пользователь заводит свои реальные склады и позиции.
    warehouses: [],
    stockItems: [],
    stockMovements: [],
    stockBalances: [],
    reservations: [],
    inventories: [],
    bankTransactions: [
      { id: 'bank-demo-income', bankId: 'demo-bank-income', date: d(-1), type: 'income', amount: 42000, method: 'account', source: 'bank', counterparty: 'ООО «Север»', comment: 'Оплата по счёту', created: now, updated: now },
      { id: 'bank-demo-expense', bankId: 'demo-bank-expense', date: d(-2), type: 'expense', amount: 6900, method: 'card', source: 'bank', counterparty: 'Магазин инвентаря', comment: 'Покупка оборудования', created: now, updated: now }
    ],
    bankRules: [],
    bankRuleVersions: [],
    bankRuleApplications: [],
    bankRuleRuns: [],
    bankRuleSettings: [{ ...DEFAULT_BANK_RULE_SETTINGS }],
    bankRuleSettingVersions: [{ ...DEFAULT_BANK_RULE_SETTINGS, id: 'bank-rule-settings:v1', settingsId: 'bank-rule-settings' }],
    financeRelations: [],
    notifications: [
      { id: uid(), toId: 'u-admin', text: 'Демо-режим: это пример уведомления. Подключите базу — и они станут настоящими.', link: '#/tasks', read: false, created: now }
    ]
  };
}

// ---------- LocalStore (демо) ----------
const LS_KEY = 'monetki_demo_db';
const CORE_ENTITIES = ['businesses', 'memberships', 'businessOwners'];
const STOCK_ENTITIES = ['warehouses', 'stockItems', 'stockMovements', 'stockBalances', 'reservations', 'inventories'];
const BANK_RULE_ENTITIES = ['bankRules', 'bankRuleVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'bankRuleSettingVersions', 'financeRelations'];
const BUSINESS_SCOPED_ENTITIES = ['clients', 'venues', 'players', 'tasks', 'finance', 'staffExpenses', 'financeRelations', ...CRM_ENTITIES, ...STOCK_ENTITIES, ...EVENT_ENTITIES];
const LOCAL_ENTITIES = [...new Set([
  ...CORE_ENTITIES, 'employees', ...BUSINESS_SCOPED_ENTITIES, 'bankTransactions', ...BANK_RULE_ENTITIES,
  'cash', 'files', 'notifications'
])];

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

function safeBankDateBounds(items) {
  const dates = (items || [])
    .map((item) => String(item?.date || ''))
    .filter((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const [year, month, day] = date.split('-').map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day;
    })
    .sort();
  return { count: (items || []).length, earliestDate: dates[0] || null, latestDate: dates.at(-1) || null };
}

function bankQueueSignalError(item) {
  const signals = item?.bankSignals || {};
  if (!Object.keys(signals).length) return null; // Совместимость со старой безопасной очередью без сигналов.
  const amountMinor = Number(signals.amountMinor);
  const visibleAmountMinor = Math.round(Number(item?.amount) * 100);
  if (!isSafeBankSignals(signals) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0
    || amountMinor !== visibleAmountMinor || String(signals.direction || '') !== String(item?.type || '')) {
    return 'Банковские сигналы не совпадают с видимой суммой или направлением операции';
  }
  return null;
}

function isBankManagedFinance(item) {
  return item?.source === 'bank' || String(item?.bankId || '') !== ''
    || ['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
      .some((key) => item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== '');
}

function activationRuleShape(source) {
  const rule = structuredClone(source || {});
  for (const key of ['activationToken', 'activationRunId', 'activationFingerprint', 'checksum', 'updated', 'updatedBy']) delete rule[key];
  return rule;
}

function bankJournalCreated(item) {
  const value = Math.floor(Number(item?.created || 0));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function encodeBankJournalCursor(item) {
  const bytes = new TextEncoder().encode(JSON.stringify([bankJournalCreated(item), String(item?.id || '')]));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBankJournalCursor(source) {
  const cursor = String(source || '').trim();
  if (!cursor) return null;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error('invalid_cursor');
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - cursor.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0
      || typeof parsed[1] !== 'string' || !parsed[1] || parsed[1].length > 200 || /[\u0000-\u001f\u007f]/u.test(parsed[1])) {
      throw new Error('invalid_cursor');
    }
    return { created: parsed[0], id: parsed[1] };
  } catch (_error) {
    throw new Error('invalid_cursor');
  }
}

function bankScopeDiagnostics(db, user) {
  if (user.role !== 'admin') return null;
  const businessById = new Map((db.businesses || []).map((business) => [String(business.id), business]));
  const bankFinance = (db.finance || []).filter((item) => item?.source === 'bank');
  const invalid = [];
  const invalidWithoutBankId = [];
  const archived = [];
  const inaccessible = [];
  bankFinance.forEach((item) => {
    const businessId = businessIdOf(item);
    const business = businessById.get(String(businessId));
    if (scopeError(item) || !businessId || businessId === 'all' || !business) {
      invalid.push(item);
      if (!item?.bankId) invalidWithoutBankId.push(item);
    }
    else if (business.active === false) archived.push(item);
    else if (!canAccessBusiness(db, user, businessId)) inaccessible.push(item);
  });
  return {
    queue: safeBankDateBounds(db.bankTransactions || []),
    hiddenInvalidScope: safeBankDateBounds(invalid),
    hiddenInvalidScopeWithoutBankId: safeBankDateBounds(invalidWithoutBankId),
    hiddenArchivedScope: safeBankDateBounds(archived),
    hiddenInaccessibleScope: safeBankDateBounds(inaccessible),
  };
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

const CRM_LEGACY_PREFIX = 'legacy-client:';

function legacyCompany(client) {
  return {
    id: `${CRM_LEGACY_PREFIX}${client.id}`,
    businessId: businessIdOf(client),
    unit: businessIdOf(client),
    name: client.name || client.company || 'Без названия',
    legalName: client.company || '',
    inn: '',
    address: '',
    responsibleIds: [],
    status: client.status || 'lead',
    notes: client.notes || '',
    legacyPhone: client.phone || '',
    legacyMessenger: client.tg || '',
    legacyAmount: Number(client.amount || 0),
    legacyClientId: client.id,
    legacy: true,
    readOnly: true,
    created: client.created,
    updated: client.updated
  };
}

function crmDefaults(entity, item) {
  const result = { ...item };
  if (entity === 'companies') {
    if (!Array.isArray(result.responsibleIds)) result.responsibleIds = [];
    result.status = result.status || 'lead';
  }
  if (entity === 'contacts' && typeof result.isPrimary !== 'boolean') result.isPrimary = false;
  if (entity === 'leads') result.status = result.status || 'new';
  if (entity === 'pipelines') {
    if (typeof result.isDefault !== 'boolean') result.isDefault = false;
    if (typeof result.active !== 'boolean') result.active = true;
  }
  if (entity === 'deals' && (result.amount === '' || result.amount === undefined || result.amount === null)) result.amount = 0;
  if (entity === 'dealItems') {
    if (result.amount === '' || result.amount === undefined || result.amount === null) result.amount = 0;
    if (typeof result.recurring !== 'boolean') result.recurring = false;
  }
  return result;
}

function crmValidationError(db, entity, item, ignoreId = '') {
  if (!CRM_ENTITIES.includes(entity)) return null;
  const businessId = businessIdOf(item);
  const named = ['companies', 'contacts', 'leads', 'deals', 'pipelines', 'stages', 'dealItems'];
  if (named.includes(entity) && !String(item?.name || '').trim()) return 'Не указано название';

  const relation = (targetEntity, id, label) => {
    if (!id) return null;
    let target = (db[targetEntity] || []).find((record) => record.id === id);
    if (!target && targetEntity === 'companies' && String(id).startsWith(CRM_LEGACY_PREFIX)) {
      const legacyId = String(id).slice(CRM_LEGACY_PREFIX.length);
      const client = (db.clients || []).find((record) => String(record.id) === legacyId);
      if (client) target = legacyCompany(client);
    }
    if (!target) return `${label} ${label === 'Контакт' ? 'не найден' : 'не найдена'}`;
    if (businessIdOf(target) !== businessId) return `${label} относится к другому бизнесу`;
    return null;
  };
  const responsibleError = (employeeId) => {
    if (!employeeId) return null;
    if (!(db.employees || []).some((employee) => employee.id === employeeId)) return 'Ответственный не найден';
    if (!membershipsOf(db, employeeId).some((membership) => businessIdOf(membership) === businessId)) {
      return 'У ответственного нет доступа к этому бизнесу';
    }
    return null;
  };

  if (entity === 'companies') {
    if (!Array.isArray(item.responsibleIds)) return 'Ответственные должны быть списком';
    for (const employeeId of item.responsibleIds) {
      const error = responsibleError(employeeId);
      if (error) return error;
    }
  }
  if (entity === 'contacts') {
    const companyError = relation('companies', item.companyId, 'Компания');
    if (companyError) return companyError;
    if (typeof item.isPrimary !== 'boolean') return 'Признак основного контакта должен быть логическим';
  }
  if (entity === 'leads') {
    if (!['new', 'working', 'qualified', 'refused'].includes(String(item.status || ''))) return 'Неизвестный статус лида';
    const error = responsibleError(item.responsibleId);
    if (error) return error;
  }
  if (entity === 'pipelines') {
    if (typeof item.isDefault !== 'boolean' || typeof item.active !== 'boolean') return 'Настройки воронки должны быть логическими';
  }
  if (entity === 'stages') {
    const pipelineError = relation('pipelines', item.pipelineId, 'Воронка');
    if (pipelineError) return pipelineError;
    const order = Number(item.order);
    if (item.order === '' || item.order === null || !Number.isFinite(order)) return 'Порядок стадии должен быть числом';
    if (!['open', 'won', 'lost'].includes(String(item.type || ''))) return 'Неизвестный тип стадии';
  }
  if (entity === 'deals') {
    const pipelineError = relation('pipelines', item.pipelineId, 'Воронка');
    if (pipelineError) return pipelineError;
    const stageError = relation('stages', item.stageId, 'Стадия');
    if (stageError) return stageError;
    const stage = (db.stages || []).find((record) => record.id === item.stageId);
    if (stage?.pipelineId !== item.pipelineId) return 'Стадия не относится к выбранной воронке';
    const companyError = relation('companies', item.companyId, 'Компания');
    if (companyError) return companyError;
    const contactError = relation('contacts', item.contactId, 'Контакт');
    if (contactError) return contactError;
    const contact = (db.contacts || []).find((record) => record.id === item.contactId);
    if (item.companyId && contact?.companyId && contact.companyId !== item.companyId) return 'Контакт не относится к выбранной компании';
    const amount = Number(item.amount);
    if (item.amount === '' || item.amount === null || !Number.isFinite(amount) || amount < 0) return 'Сумма сделки должна быть неотрицательным числом';
    const responsible = responsibleError(item.responsibleId);
    if (responsible) return responsible;
    if (stage?.type === 'lost' && !String(item.lostReason || '').trim()) return 'Укажите причину отказа';
  }
  if (entity === 'dealItems') {
    const dealError = relation('deals', item.dealId, 'Сделка');
    if (dealError) return dealError;
    const amount = Number(item.amount);
    if (item.amount === '' || item.amount === null || !Number.isFinite(amount) || amount < 0) return 'Сумма позиции должна быть неотрицательным числом';
    if (typeof item.recurring !== 'boolean') return 'Признак регулярного платежа должен быть логическим';
    if (item.recurring && !String(item.period || '').trim()) return 'Укажите период регулярного платежа';
  }

  return null;
}

function crmDeleteError(db, entity, id) {
  if (entity === 'companies' && db.contacts.some((item) => item.companyId === id)) return 'Сначала удалите контакты компании';
  if (entity === 'companies' && db.deals.some((item) => item.companyId === id)) return 'Компания используется в сделках';
  if (entity === 'contacts' && db.deals.some((item) => item.contactId === id)) return 'Контакт используется в сделках';
  if (entity === 'pipelines' && db.stages.some((item) => item.pipelineId === id)) return 'Сначала удалите стадии воронки';
  if (entity === 'pipelines' && db.deals.some((item) => item.pipelineId === id)) return 'Воронка используется в сделках';
  if (entity === 'stages' && db.deals.some((item) => item.stageId === id)) return 'Стадия используется в сделках';
  if (entity === 'deals' && db.dealItems.some((item) => item.dealId === id)) return 'Сначала удалите позиции сделки';
  return null;
}

function crmUpdateError(db, entity, before, after) {
  if (!CRM_ENTITIES.includes(entity)) return null;
  if (businessIdOf(before) !== businessIdOf(after)) return 'Нельзя переносить CRM-запись в другой бизнес';
  if (entity === 'contacts' && before.companyId !== after.companyId && db.deals.some((item) => item.contactId === before.id)) {
    return 'Контакт используется в сделках';
  }
  if (entity === 'stages' && before.pipelineId !== after.pipelineId && db.deals.some((item) => item.stageId === before.id)) {
    return 'Стадия используется в сделках';
  }
  return null;
}

function stockReference(db, entity, id, businessId, activeOnly = true) {
  return (db[entity] || []).find((item) => item.id === id
    && businessIdOf(item) === businessId
    && (!activeOnly || item.active !== false));
}

function nonNegativeNumber(value) {
  return value !== '' && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function positiveNumber(value) {
  return value !== '' && value !== null && Number.isFinite(Number(value)) && Number(value) > 0;
}

function stockValidationError(db, entity, item, ignoreId = '') {
  const businessId = businessIdOf(item);
  if (entity === 'warehouses') {
    if (!String(item?.name || '').trim()) return 'Укажите название склада';
    if (typeof item?.active !== 'boolean') return 'Статус склада должен быть логическим';
    if ((db.warehouses || []).some((x) => x.id !== ignoreId && businessIdOf(x) === businessId
      && String(x.name || '').trim().toLowerCase() === String(item.name).trim().toLowerCase())) return 'Склад с таким названием уже существует';
  }
  if (entity === 'stockItems') {
    if (!String(item?.name || '').trim()) return 'Укажите название позиции';
    if (!String(item?.unitName || '').trim()) return 'Укажите единицу измерения';
    if (!nonNegativeNumber(item?.costPrice)) return 'Себестоимость должна быть числом не меньше нуля';
    if (!nonNegativeNumber(item?.minStock)) return 'Минимальный остаток должен быть числом не меньше нуля';
    if (typeof item?.active !== 'boolean') return 'Статус позиции должен быть логическим';
    const sku = String(item?.sku || '').trim().toLowerCase();
    if (sku && (db.stockItems || []).some((x) => x.id !== ignoreId && businessIdOf(x) === businessId
      && String(x.sku || '').trim().toLowerCase() === sku)) return 'Позиция с таким артикулом уже существует';
  }
  if (entity === 'stockMovements') {
    if (!['receipt', 'expense', 'transfer', 'inventory'].includes(item?.type)) return 'Неизвестный тип движения';
    if (!positiveNumber(item?.quantity)) return 'Количество должно быть больше нуля';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || ''))) return 'Укажите дату движения';
    if (!stockReference(db, 'stockItems', item?.stockItemId, businessId)) return 'Позиция не найдена или выключена';
    if (item.type === 'transfer') {
      if (!stockReference(db, 'warehouses', item?.fromWarehouseId, businessId)) return 'Склад-источник не найден или выключен';
      if (!stockReference(db, 'warehouses', item?.toWarehouseId, businessId)) return 'Склад-получатель не найден или выключен';
      if (item.fromWarehouseId === item.toWarehouseId) return 'Выберите разные склады';
    } else if (!stockReference(db, 'warehouses', item?.warehouseId, businessId)) return 'Склад не найден или выключен';
    if (item.type === 'inventory' && !item.inventoryId) return 'Не указана инвентаризация';
    if (item.type === 'receipt' && item.totalAmount !== undefined && item.totalAmount !== '' && !nonNegativeNumber(item.totalAmount)) return 'Сумма партии должна быть числом не меньше нуля';
    if (item.type === 'receipt' && item.financeId && !(db.finance || []).some((finance) =>
      finance.id === item.financeId && businessIdOf(finance) === businessId && finance.type === 'expense'
    )) return 'Финансовая операция не найдена в этом бизнесе';
  }
  if (entity === 'stockBalances') {
    if (!stockReference(db, 'warehouses', item?.warehouseId, businessId, false)) return 'Склад не найден';
    if (!stockReference(db, 'stockItems', item?.stockItemId, businessId, false)) return 'Позиция не найдена';
    if (!nonNegativeNumber(item?.quantity) || !nonNegativeNumber(item?.reserved)) return 'Остаток и резерв не могут быть отрицательными';
    if (Number(item.reserved) > Number(item.quantity)) return 'Резерв не может быть больше остатка';
    if ((db.stockBalances || []).some((x) => x.id !== ignoreId && businessIdOf(x) === businessId
      && x.warehouseId === item.warehouseId && x.stockItemId === item.stockItemId)) return 'Остаток для этой позиции уже существует';
  }
  if (entity === 'reservations') {
    if (!stockReference(db, 'warehouses', item?.warehouseId, businessId)) return 'Склад не найден или выключен';
    if (!stockReference(db, 'stockItems', item?.stockItemId, businessId)) return 'Позиция не найдена или выключена';
    if (!positiveNumber(item?.quantity)) return 'Количество резерва должно быть больше нуля';
    if (!['active', 'released'].includes(item?.status)) return 'Неизвестный статус резерва';
  }
  if (entity === 'inventories') {
    if (!stockReference(db, 'warehouses', item?.warehouseId, businessId)) return 'Склад не найден или выключен';
    if (!['draft', 'completed'].includes(item?.status)) return 'Неизвестный статус инвентаризации';
    if (!Array.isArray(item?.items)) return 'Позиции инвентаризации должны быть списком';
    const seen = new Set();
    for (const row of item.items) {
      if (!stockReference(db, 'stockItems', row?.stockItemId, businessId)) return 'В инвентаризации есть недоступная позиция';
      if (!nonNegativeNumber(row?.actualQuantity)) return 'Фактический остаток не может быть отрицательным';
      if (seen.has(row.stockItemId)) return 'Позиция добавлена в инвентаризацию дважды';
      seen.add(row.stockItemId);
    }
  }
  return null;
}

function normalizeEventRecord(entity, source) {
  const item = { ...source };
  if (entity === 'eventTypes') {
    item.active = item.active !== false;
    item.defaultFee = Number(item.defaultFee || 0);
    item.staffRate = Number(item.staffRate || 0);
    item.ownerShares = Array.isArray(item.ownerShares) ? item.ownerShares : [];
  }
  if (entity === 'events') {
    item.status = item.status || 'planned';
    item.settlementStatus = item.settlementStatus || 'open';
    item.defaultFee = Number(item.defaultFee || 0);
    item.capacity = Number(item.capacity || 0);
  }
  if (entity === 'eventRegistrations') {
    item.status = item.status || 'registered';
    item.chargeAmount = Number(item.chargeAmount || 0);
  }
  if (entity === 'eventBudgetLines') item.plannedAmount = Number(item.plannedAmount || 0);
  if (entity === 'eventFinanceAllocations') item.amount = Number(item.amount || 0);
  return item;
}

function sanitizeStaffEventPayload(entity, item) {
  if (entity === 'events') {
    delete item.ownerShares;
    delete item.staffRate;
    delete item.chargeAmount;
  }
  if (entity === 'eventRegistrations') {
    delete item.ownerShares;
    delete item.defaultFee;
    delete item.staffRate;
    delete item.settlement;
  }
  return item;
}

function appendEventHistory(before, item, userId, action = '') {
  const history = Array.isArray(before?.history) ? [...before.history] : [];
  const changed = before ? Object.keys(item).filter((key) => !['history', 'updated', 'created'].includes(key)
    && JSON.stringify(before[key]) !== JSON.stringify(item[key])) : [];
  history.push({
    id: uid(), at: Date.now(), byId: userId, action: action || (before ? 'updated' : 'created'),
    fromStatus: before?.status || null, toStatus: item.status || null, changed,
  });
  return history;
}

export class LocalStore {
  constructor() { this.demo = true; }
  _db() {
    let raw = localStorage.getItem(LS_KEY);
    let db;
    if (!raw) { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); return db; }
    try { db = JSON.parse(raw); } catch { db = seedData(); localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    const coreChanged = ensureCoreData(db);
    const bankAuditChanged = this._ensureLegacyBankApplications(db);
    if (coreChanged || bankAuditChanged) localStorage.setItem(LS_KEY, JSON.stringify(db));
    return db;
  }
  _save(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
  _visibleEventItem(db, u, entity, item) {
    if (u.role === 'admin' || !EVENT_ENTITIES.includes(entity)) return item;
    const visible = visibleEventCollections(u, db, false);
    return (visible[entity] || []).find((candidate) => candidate.id === item.id) || { id: item.id };
  }

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
    const legacyCompanies = db.clients
      .filter(canSee)
      .filter((client) => !db.companies.some((company) => company.legacyClientId === client.id))
      .map(legacyCompany);
    const canSeeStock = (item) => !scopeError(item) && canSee(item)
      && db.businesses.some((business) => business.id === businessIdOf(item) && Array.isArray(business.modules) && business.modules.includes('stock'));
    const canSeeEvent = (item) => !scopeError(item) && canSee(item)
      && db.businesses.some((business) => business.id === businessIdOf(item) && Array.isArray(business.modules) && business.modules.includes('events'));
    const eventCollections = visibleEventCollections(u, {
      ...db,
      eventTypes: db.eventTypes.filter(canSeeEvent),
      events: db.events.filter(canSeeEvent),
      eventRegistrations: db.eventRegistrations.filter(canSeeEvent),
      eventBudgetLines: db.eventBudgetLines.filter(canSeeEvent),
      eventFinanceAllocations: db.eventFinanceAllocations.filter(canSeeEvent),
    }, isAdmin);
    const bankSettings = safeBankRuleSettings(db.bankRuleSettings[0] || DEFAULT_BANK_RULE_SETTINGS);
    const visibleBankTransactions = db.bankTransactions.map((item) => {
      const evaluation = evaluateBankRules(item.bankSignals || {}, db.bankRules, bankSettings);
      const { bankSignals: _signals, bankId: _bankId, bankSignalFingerprint: _fingerprint, ...safe } = item;
      return { ...safe, ruleEvaluation: publicBankRuleEvaluation(evaluation), ruleEvaluationToken: bankRuleEvaluationToken(item, evaluation) };
    });
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
        companies: [...db.companies.filter(canSee), ...legacyCompanies],
        contacts: db.contacts.filter(canSee),
        leads: db.leads.filter(canSee),
        deals: db.deals.filter(canSee),
        pipelines: db.pipelines.filter(canSee),
        stages: db.stages.filter(canSee),
        dealItems: db.dealItems.filter(canSee),
        venues: db.venues.filter(canSee),
        players: db.players.filter(canSee),
        ...eventCollections,
        tasks: db.tasks.filter((t) => canSee(t) && (isAdmin || t.assigneeId === u.id)),
        finance: db.finance.filter((f) => canSee(f) && (isAdmin || f.employeeId === u.id)),
        bankTransactions: isAdmin ? visibleBankTransactions : [],
        bankRules: isAdmin ? db.bankRules : [],
        bankRuleVersions: isAdmin ? db.bankRuleVersions : [],
        bankRuleApplications: [],
        bankRuleRuns: [],
        bankRuleSettings: isAdmin ? db.bankRuleSettings : [],
        bankRuleSettingVersions: isAdmin ? db.bankRuleSettingVersions : [],
        financeRelations: isAdmin ? db.financeRelations.filter(canSee) : [],
        bankDiagnostics: isAdmin ? bankScopeDiagnostics(db, u) : null,
        staffExpenses: db.staffExpenses.filter((e) => canSee(e) && (isAdmin || e.employeeId === u.id)),
        warehouses: db.warehouses.filter(canSeeStock),
        stockItems: db.stockItems.filter(canSeeStock),
        stockMovements: db.stockMovements.filter(canSeeStock),
        stockBalances: db.stockBalances.filter(canSeeStock),
        reservations: db.reservations.filter(canSeeStock),
        inventories: db.inventories.filter(canSeeStock),
        cash: isAdmin ? db.cash : db.cash.filter((c) => c.employeeId === u.id),
        bankBalance: isAdmin ? { amount: 175000, updated: new Date().toISOString() } : null,
        notifications: db.notifications.filter((n) => n.toId === u.id)
      }
    };
  }

  _baseWriteError(u, entity) {
    if (!LOCAL_ENTITIES.includes(entity) || entity === 'files') return 'Неизвестная сущность';
    if (entity === 'bankTransactions') return 'Банковскую операцию можно только провести';
    if (BANK_RULE_ENTITIES.includes(entity)) return 'Правила банка изменяются только отдельным безопасным действием';
    if (entity === 'eventFinanceAllocations') return 'Финансовое распределение создаётся отдельным безопасным действием';
    if (entity === 'notifications') return 'Нельзя';
    if (entity === 'stockBalances') return 'Остатки меняются только складскими операциями';
    if ([...CORE_ENTITIES, 'employees', 'finance', 'bankTransactions', 'cash', 'eventTypes', 'eventBudgetLines'].includes(entity) && u.role !== 'admin') return 'Только для админа';
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

  _stockWriteError(db, u, item) {
    const accessError = this._scopeWriteError(db, u, item);
    if (accessError) return accessError;
    const business = db.businesses.find((x) => x.id === businessIdOf(item));
    if (!Array.isArray(business?.modules) || !business.modules.includes('stock')) return 'Модуль «Склад» выключен для этого бизнеса';
    return null;
  }

  _stockBalance(db, businessId, warehouseId, stockItemId, create = false) {
    let balance = db.stockBalances.find((x) => businessIdOf(x) === businessId
      && x.warehouseId === warehouseId && x.stockItemId === stockItemId);
    if (!balance && create) {
      balance = {
        id: uid(), businessId, unit: businessId, warehouseId, stockItemId,
        quantity: 0, reserved: 0, created: Date.now(), updated: Date.now()
      };
      db.stockBalances.push(balance);
    }
    return balance;
  }

  _applyStockMovement(db, item) {
    const businessId = businessIdOf(item);
    const quantity = Number(item.quantity);
    const change = (warehouseId, delta) => {
      const balance = this._stockBalance(db, businessId, warehouseId, item.stockItemId, true);
      const next = Number(balance.quantity || 0) + delta;
      if (next < Number(balance.reserved || 0)) return 'Недостаточно свободного остатка';
      balance.quantity = next;
      balance.updated = Date.now();
      return null;
    };
    if (item.type === 'receipt') return change(item.warehouseId, quantity);
    if (item.type === 'expense') return change(item.warehouseId, -quantity);
    if (item.type === 'transfer') {
      const source = this._stockBalance(db, businessId, item.fromWarehouseId, item.stockItemId, true);
      if (Number(source.quantity || 0) - Number(source.reserved || 0) < quantity) return 'Недостаточно свободного остатка для перемещения';
      source.quantity = Number(source.quantity || 0) - quantity;
      source.updated = Date.now();
      return change(item.toWarehouseId, quantity);
    }
    if (item.type === 'inventory') return change(item.warehouseId, item.direction === 'decrease' ? -quantity : quantity);
    return 'Неизвестный тип движения';
  }

  _completeInventory(db, inventory, userId) {
    const businessId = businessIdOf(inventory);
    for (const row of inventory.items) {
      const balance = this._stockBalance(db, businessId, inventory.warehouseId, row.stockItemId, false);
      if (Number(row.actualQuantity) < Number(balance?.reserved || 0)) return 'Фактический остаток не может быть меньше активного резерва';
    }
    for (const row of inventory.items) {
      const balance = this._stockBalance(db, businessId, inventory.warehouseId, row.stockItemId, true);
      const before = Number(balance.quantity || 0);
      const actual = Number(row.actualQuantity);
      const delta = actual - before;
      balance.quantity = actual;
      balance.updated = Date.now();
      if (!delta) continue;
      db.stockMovements.push({
        id: uid(), businessId, unit: businessId, type: 'inventory', inventoryId: inventory.id,
        stockItemId: row.stockItemId, warehouseId: inventory.warehouseId,
        quantity: Math.abs(delta), direction: delta > 0 ? 'increase' : 'decrease',
        date: inventory.date || new Date().toISOString().slice(0, 10), note: inventory.note || '',
        createdBy: userId, created: Date.now(), updated: Date.now()
      });
    }
    return null;
  }

  _changeReservation(db, before, after) {
    const release = (item) => {
      if (!item || item.status !== 'active') return;
      const balance = this._stockBalance(db, businessIdOf(item), item.warehouseId, item.stockItemId, true);
      balance.reserved = Math.max(0, Number(balance.reserved || 0) - Number(item.quantity || 0));
      balance.updated = Date.now();
    };
    const reserve = (item) => {
      if (!item || item.status !== 'active') return null;
      const balance = this._stockBalance(db, businessIdOf(item), item.warehouseId, item.stockItemId, true);
      if (Number(balance.quantity || 0) - Number(balance.reserved || 0) < Number(item.quantity || 0)) return 'Недостаточно свободного остатка для резерва';
      balance.reserved = Number(balance.reserved || 0) + Number(item.quantity || 0);
      balance.updated = Date.now();
      return null;
    };
    if (after?.status === 'active') {
      const balance = this._stockBalance(db, businessIdOf(after), after.warehouseId, after.stockItemId, true);
      const returned = before?.status === 'active' && businessIdOf(before) === businessIdOf(after)
        && before.warehouseId === after.warehouseId && before.stockItemId === after.stockItemId ? Number(before.quantity || 0) : 0;
      if (Number(balance.quantity || 0) - Number(balance.reserved || 0) + returned < Number(after.quantity || 0)) return 'Недостаточно свободного остатка для резерва';
    }
    release(before);
    return reserve(after);
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
    item = CRM_ENTITIES.includes(entity) ? crmDefaults(entity, item) : { ...item };
    if (entity === 'finance' && (item.source === 'bank' || String(item.bankId || '')
      || ['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
        .some((key) => item[key] !== undefined && item[key] !== null && item[key] !== ''))) {
      return { ok: false, error: 'Банковская операция создаётся только из необработанной очереди' };
    }
    delete item.staffAmount;
    if (u.role !== 'admin') item = sanitizeStaffEventPayload(entity, item);
    if (EVENT_ENTITIES.includes(entity)) item = normalizeEventRecord(entity, item);
    if (entity === 'events') {
      item.settlementStatus = 'open';
      delete item.settlement;
      delete item.settlementClosedAt;
      delete item.completedAt;
    }
    if (entity === 'stockMovements' && item.type === 'inventory') return { ok: false, error: 'Движение инвентаризации создаётся только при её завершении' };
    if (entity === 'businesses') item.id = String(item.id || '').trim();
    if (entity === 'businessOwners') item.ownerId = String(item.ownerId || '').trim();
    if (entity === 'stockItems') {
      item.costPrice = Number(item.costPrice);
      item.minStock = Number(item.minStock);
    }
    if (['stockMovements', 'reservations'].includes(entity)) item.quantity = Number(item.quantity);
    if (entity === 'reservations') item.status = item.status || 'active';
    if (entity === 'inventories') item.items = (item.items || []).map((row) => ({ ...row, actualQuantity: Number(row.actualQuantity) }));
    const coreError = CORE_ENTITIES.includes(entity) ? coreValidationError(db, entity, item) : null;
    if (coreError) return { ok: false, error: coreError };
    if (entity === 'staffExpenses' && u.role !== 'admin' && !businessIdOf(item)) scopedItem(item, u.unit);
    if (BUSINESS_SCOPED_ENTITIES.includes(entity)) {
      const accessError = STOCK_ENTITIES.includes(entity) ? this._stockWriteError(db, u, item) : this._scopeWriteError(db, u, item);
      if (accessError) return { ok: false, error: accessError };
      scopedItem(item);
    }
    if (['memberships', 'businessOwners'].includes(entity)) {
      const accessError = this._scopeWriteError(db, u, item);
      if (accessError) return { ok: false, error: accessError };
      scopedItem(item);
    }
    const crmError = crmValidationError(db, entity, item);
    if (crmError) return { ok: false, error: crmError };
    const stockError = STOCK_ENTITIES.includes(entity) ? stockValidationError(db, entity, item) : null;
    if (stockError) return { ok: false, error: stockError };
    if (EVENT_ENTITIES.includes(entity)) {
      const moduleError = eventModuleWriteError(db.businesses, item);
      if (moduleError) return { ok: false, error: moduleError };
      if (u.role !== 'admin' && entity === 'events') {
        const type = db.eventTypes.find((candidate) => candidate.id === item.eventTypeId
          && businessIdOf(candidate) === businessIdOf(item));
        item.defaultFee = Number(type?.defaultFee || 0);
        item.responsibleId = u.id;
      }
      if (u.role !== 'admin' && entity === 'eventRegistrations') {
        const event = db.events.find((candidate) => candidate.id === item.eventId
          && businessIdOf(candidate) === businessIdOf(item));
        const manageError = staffEventManageError(u, event);
        if (manageError) return { ok: false, error: manageError };
        item.chargeAmount = Number(event.defaultFee || 0);
      }
      const eventError = eventRecordError(entity, item, db);
      if (eventError) return { ok: false, error: eventError };
    }
    // id всегда серверный — нельзя перезаписать чужую запись, прислав её id
    item = { ...item, id: entity === 'businesses' && item.id ? item.id : uid(), created: Date.now(), updated: Date.now() };
    if (entity === 'events') item.history = appendEventHistory(null, item, u.id);
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
    if (entity === 'stockMovements') {
      item.createdBy = u.id;
      const movementError = this._applyStockMovement(db, item);
      if (movementError) return { ok: false, error: movementError };
    }
    if (entity === 'reservations') {
      const reservationError = this._changeReservation(db, null, item);
      if (reservationError) return { ok: false, error: reservationError };
    }
    if (entity === 'inventories') {
      item.createdBy = u.id;
      if (item.status === 'completed') {
        item.completedAt = Date.now();
        const inventoryError = this._completeInventory(db, item, u.id);
        if (inventoryError) return { ok: false, error: inventoryError };
      }
    }
    db[entity].push(item);
    if (entity === 'businesses') {
      db.memberships.push({
        id: `membership-${item.id}-${u.id}`, businessId: item.id, unit: item.id,
        employeeId: u.id, role: 'owner', active: true, created: Date.now(), updated: Date.now()
      });
      db.businessOwners.push({
        id: `business-owner-${item.id}-${u.id}`, businessId: item.id, unit: item.id,
        ownerId: u.id, name: u.name, share: 1, active: true, created: Date.now(), updated: Date.now()
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
    return { ok: true, item: this._visibleEventItem(db, u, entity, item) };
  }

  async update(token, entity, item) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    const db = this._db();
    const baseError = this._baseWriteError(u, entity);
    if (baseError) return { ok: false, error: baseError };
    item = { ...item };
    if (entity === 'finance' && (item.source === 'bank' || String(item.bankId || '')
      || ['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
        .some((key) => item[key] !== undefined && item[key] !== null && item[key] !== ''))) {
      return { ok: false, error: 'Банковская операция изменяется только специальным действием' };
    }
    delete item.staffAmount;
    if (u.role !== 'admin') item = sanitizeStaffEventPayload(entity, item);
    if (entity === 'companies' && String(item?.id || '').startsWith(CRM_LEGACY_PREFIX)) {
      return { ok: false, error: 'Переходная запись клиента доступна только для чтения' };
    }
    const i = db[entity].findIndex((x) => x.id === item.id);
    if (i < 0) return { ok: false, error: 'Не найдено' };
    const before = db[entity][i];
    if (entity === 'finance' && (before.source === 'bank' || String(before.bankId || '')
      || ['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
        .some((key) => before[key] !== undefined && before[key] !== null && before[key] !== ''))) {
      return { ok: false, error: 'Банковская операция изменяется только специальным действием' };
    }
    if (entity === 'stockMovements') return { ok: false, error: 'Проведённые движения нельзя изменять' };
    if (entity === 'inventories' && before.status === 'completed') return { ok: false, error: 'Завершённую инвентаризацию нельзя изменять' };
    if (entity === 'businesses' && !canAccessBusiness(db, u, before.id)) return { ok: false, error: 'Нет доступа к этому бизнесу' };
    if (BUSINESS_SCOPED_ENTITIES.includes(entity) || ['memberships', 'businessOwners'].includes(entity)) {
      const sourceError = STOCK_ENTITIES.includes(entity) ? this._stockWriteError(db, u, before) : this._scopeWriteError(db, u, before);
      if (sourceError) return { ok: false, error: sourceError };
      const mismatch = scopeError(item);
      if (mismatch) return { ok: false, error: mismatch };
      const targetBusinessId = item.businessId || item.unit || businessIdOf(before);
      if ((STOCK_ENTITIES.includes(entity) || EVENT_ENTITIES.includes(entity)) && targetBusinessId !== businessIdOf(before)) {
        return { ok: false, error: `Нельзя перенести ${STOCK_ENTITIES.includes(entity) ? 'складскую' : 'событийную'} запись в другой бизнес` };
      }
      const target = { businessId: targetBusinessId, unit: targetBusinessId };
      const targetError = STOCK_ENTITIES.includes(entity) ? this._stockWriteError(db, u, target) : this._scopeWriteError(db, u, target);
      if (targetError) return { ok: false, error: targetError };
      item = { ...item, businessId: targetBusinessId, unit: targetBusinessId };
    }
    const coreError = CORE_ENTITIES.includes(entity) ? coreValidationError(db, entity, { ...before, ...item }, before.id) : null;
    if (coreError) return { ok: false, error: coreError };
    const mergedForValidation = CRM_ENTITIES.includes(entity)
      ? crmDefaults(entity, { ...before, ...item })
      : { ...before, ...item };
    const crmUpdateDeny = crmUpdateError(db, entity, before, mergedForValidation);
    if (crmUpdateDeny) return { ok: false, error: crmUpdateDeny };
    const crmError = crmValidationError(db, entity, mergedForValidation, before.id);
    if (crmError) return { ok: false, error: crmError };
    if (CRM_ENTITIES.includes(entity)) item = mergedForValidation;
    // п.1–2: сотрудник меняет содержимое только своих задач; в чужих (от админа) — только статус
    if (entity === 'tasks' && u.role !== 'admin' && before.authorId !== u.id) {
      if (before.assigneeId !== u.id) return { ok: false, error: 'Нет доступа' };
      item = { id: before.id, status: item.status };
    }
    if (EVENT_ENTITIES.includes(entity)) {
      const moduleError = eventModuleWriteError(db.businesses, before);
      if (moduleError) return { ok: false, error: moduleError };
      if (u.role !== 'admin') {
        const parent = entity === 'events' ? before : db.events.find((event) => event.id === before.eventId);
        const manageError = staffEventManageError(u, parent);
        if (manageError) return { ok: false, error: manageError };
      }
    }
    if (entity === 'events' && before.settlementStatus === 'closed') return { ok: false, error: 'Закрытый расчёт события нельзя изменять' };
    if (entity === 'events' && item.settlementStatus && item.settlementStatus !== before.settlementStatus) {
      return { ok: false, error: 'Расчёт события закрывается отдельным безопасным действием' };
    }
    if (entity === 'events' && ['settlement', 'settlementClosedAt', 'completedAt'].some((key) =>
      key in item && JSON.stringify(item[key]) !== JSON.stringify(before[key])
    )) return { ok: false, error: 'Системные итоги события нельзя изменять вручную' };
    if (u.role !== 'admin' && entity === 'events') {
      if (('defaultFee' in item && Number(item.defaultFee) !== Number(before.defaultFee))
        || ('eventTypeId' in item && item.eventTypeId !== before.eventTypeId)
        || ('responsibleId' in item && item.responsibleId !== before.responsibleId)) {
        return { ok: false, error: 'Сотрудник не может менять тип, ответственного или финансовые условия события' };
      }
      item = { ...item, defaultFee: before.defaultFee, eventTypeId: before.eventTypeId, responsibleId: before.responsibleId };
    }
    if (u.role !== 'admin' && entity === 'eventRegistrations') {
      if ('chargeAmount' in item && Number(item.chargeAmount) !== Number(before.chargeAmount)) {
        return { ok: false, error: 'Сотрудник не может менять начисление участника' };
      }
      item = { ...item, chargeAmount: before.chargeAmount };
    }
    if (entity === 'finance' && db.eventFinanceAllocations.some((allocation) => allocation.financeId === before.id)) {
      const financeAfter = { ...before, ...item };
      if (businessIdOf(before) !== businessIdOf(financeAfter) || before.type !== financeAfter.type || Number(before.amount) !== Number(financeAfter.amount)) {
        return { ok: false, error: 'Нельзя изменить сумму, тип или бизнес связанной финансовой операции' };
      }
    }
    let next = EVENT_ENTITIES.includes(entity) ? normalizeEventRecord(entity, { ...before, ...item }) : { ...before, ...item };
    if (entity === 'stockItems') next = { ...next, costPrice: Number(next.costPrice), minStock: Number(next.minStock) };
    if (entity === 'reservations') next = { ...next, quantity: Number(next.quantity) };
    if (entity === 'inventories') next = { ...next, items: (next.items || []).map((row) => ({ ...row, actualQuantity: Number(row.actualQuantity) })) };
    if (entity === 'reservations' && (before.warehouseId !== next.warehouseId || before.stockItemId !== next.stockItemId)) {
      return { ok: false, error: 'Нельзя перенести резерв на другой склад или позицию' };
    }
    const stockError = STOCK_ENTITIES.includes(entity) ? stockValidationError(db, entity, next, before.id) : null;
    if (stockError) return { ok: false, error: stockError };
    if (EVENT_ENTITIES.includes(entity)) {
      const eventError = eventRecordError(entity, next, db, before.id);
      if (eventError) return { ok: false, error: eventError };
    }
    if (entity === 'reservations') {
      const reservationError = this._changeReservation(db, before, next);
      if (reservationError) return { ok: false, error: reservationError };
    }
    if (entity === 'inventories' && before.status === 'draft' && next.status === 'completed') {
      next.completedAt = Date.now();
      const inventoryError = this._completeInventory(db, next, u.id);
      if (inventoryError) return { ok: false, error: inventoryError };
    }
    if (entity === 'events') {
      next.history = appendEventHistory(before, next, u.id);
      if (before.status !== 'completed' && next.status === 'completed') next.completedAt = Date.now();
    }
    db[entity][i] = { ...next, updated: Date.now() };
    if (entity === 'businesses') ensureCoreData(db);
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
    return { ok: true, item: this._visibleEventItem(db, u, entity, db[entity][i]) };
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
    if (entity === 'companies' && String(id || '').startsWith(CRM_LEGACY_PREFIX)) {
      return { ok: false, error: 'Переходная запись клиента доступна только для чтения' };
    }
    const before = db[entity].find((x) => x.id === id);
    if (!before) return { ok: false, error: 'Не найдено' };
    if (entity === 'finance' && (before.source === 'bank' || String(before.bankId || '')
      || ['bankQueueId', 'bankSignals', 'bankSignalFingerprint', 'bankOriginal', 'appliedRuleId', 'appliedRuleVersion', 'applicationId']
        .some((key) => before[key] !== undefined && before[key] !== null && before[key] !== ''))) {
      return { ok: false, error: 'Банковская операция удаляется только безопасной отменой из журнала' };
    }
    if (entity === 'stockMovements') return { ok: false, error: 'Проведённые движения нельзя удалять' };
    if (entity === 'inventories' && before.status === 'completed') return { ok: false, error: 'Завершённую инвентаризацию нельзя удалять' };
    if (entity === 'businesses' && !canAccessBusiness(db, u, before.id)) return { ok: false, error: 'Нет доступа к этому бизнесу' };
    if (BUSINESS_SCOPED_ENTITIES.includes(entity) || ['memberships', 'businessOwners'].includes(entity)) {
      const sourceError = STOCK_ENTITIES.includes(entity) ? this._stockWriteError(db, u, before) : this._scopeWriteError(db, u, before);
      if (sourceError) return { ok: false, error: sourceError };
    }
    if (EVENT_ENTITIES.includes(entity)) {
      const moduleError = eventModuleWriteError(db.businesses, before);
      if (moduleError) return { ok: false, error: moduleError };
      if (u.role !== 'admin') {
        const parent = entity === 'events' ? before : db.events.find((event) => event.id === before.eventId);
        const manageError = staffEventManageError(u, parent);
        if (manageError) return { ok: false, error: manageError };
      }
      const eventError = eventDeleteError(entity, before, db);
      if (eventError) return { ok: false, error: eventError };
    }
    if (['players', 'companies', 'contacts', 'venues'].includes(entity)) {
      const referenceError = eventReferenceDeleteError(entity, before, db);
      if (referenceError) return { ok: false, error: referenceError };
    }
    if (entity === 'finance' && db.eventFinanceAllocations.some((allocation) => allocation.financeId === before.id)) {
      return { ok: false, error: 'Связанную финансовую операцию нельзя удалить' };
    }
    if (entity === 'warehouses') {
      const linked = db.stockBalances.some((x) => x.warehouseId === id)
        || db.stockMovements.some((x) => x.warehouseId === id || x.fromWarehouseId === id || x.toWarehouseId === id)
        || db.reservations.some((x) => x.warehouseId === id)
        || db.inventories.some((x) => x.warehouseId === id);
      if (linked) return { ok: false, error: 'Склад уже используется. Его можно выключить, но нельзя удалить' };
    }
    if (entity === 'stockItems') {
      const linked = db.stockBalances.some((x) => x.stockItemId === id)
        || db.stockMovements.some((x) => x.stockItemId === id)
        || db.reservations.some((x) => x.stockItemId === id)
        || db.inventories.some((x) => (x.items || []).some((row) => row.stockItemId === id));
      if (linked) return { ok: false, error: 'Позиция уже используется. Её можно выключить, но нельзя удалить' };
    }
    if (entity === 'tasks' && u.role !== 'admin' && before.authorId !== u.id) return { ok: false, error: 'Удалять можно только свои задачи' };
    if (entity === 'staffExpenses' && u.role !== 'admin' && (before.employeeId !== u.id || before.status !== 'pending')) return { ok: false, error: 'Нет доступа' };
    const crmError = crmDeleteError(db, entity, id);
    if (crmError) return { ok: false, error: crmError };
    if (entity === 'tasks' && before.assigneeId && before.assigneeId !== u.id && before.status !== 'done') {
      db.notifications.push({ id: uid(), toId: before.assigneeId, text: `Задача удалена: ${before.title}`, link: '#/tasks', read: false, created: Date.now() });
    }
    if (entity === 'reservations') this._changeReservation(db, before, null);
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

  async allocateEventFinance(token, source) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    if (u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    let item = normalizeEventRecord('eventFinanceAllocations', { ...source });
    const scopeErrorText = this._scopeWriteError(db, u, item);
    if (scopeErrorText) return { ok: false, error: scopeErrorText };
    scopedItem(item);
    const moduleError = eventModuleWriteError(db.businesses, item);
    if (moduleError) return { ok: false, error: moduleError };
    const existing = db.eventFinanceAllocations.find((allocation) =>
      allocation.idempotencyKey === item.idempotencyKey && businessIdOf(allocation) === businessIdOf(item)
    );
    if (existing) {
      const keys = ['eventId', 'financeId', 'registrationId', 'budgetLineId', 'purpose', 'amount'];
      if (keys.some((key) => String(existing[key] ?? '') !== String(item[key] ?? ''))) {
        return { ok: false, error: 'Ключ повторяемости уже использован для другого распределения' };
      }
      return { ok: true, item: existing, alreadyAllocated: true };
    }
    const eventError = eventRecordError('eventFinanceAllocations', item, db);
    if (eventError) return { ok: false, error: eventError };
    item = { ...item, id: uid(), createdBy: u.id, created: Date.now(), updated: Date.now() };
    db.eventFinanceAllocations.push(item);
    this._save(db);
    return { ok: true, item };
  }

  async closeEventSettlement(token, id) {
    const u = this._user(token); if (!u) return { ok: false, error: 'auth' };
    if (u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const index = db.events.findIndex((event) => event.id === id);
    if (index < 0) return { ok: false, error: 'Событие не найдено' };
    const event = db.events[index];
    const accessError = this._scopeWriteError(db, u, event);
    if (accessError) return { ok: false, error: accessError };
    const moduleError = eventModuleWriteError(db.businesses, event);
    if (moduleError) return { ok: false, error: moduleError };
    if (event.settlementStatus === 'closed') return { ok: true, item: event, alreadyClosed: true };
    if (!['completed', 'cancelled'].includes(event.status)) return { ok: false, error: 'Сначала завершите или отмените событие' };
    const now = Date.now();
    const closed = {
      ...event, settlementStatus: 'closed', settlement: eventSettlementSnapshot(event, db, now),
      settlementClosedAt: now, updated: now,
    };
    closed.history = appendEventHistory(event, closed, u.id, 'settlement_closed');
    db.events[index] = closed;
    this._save(db);
    return { ok: true, item: closed };
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

  _bankFingerprint(value) {
    const source = canonicalJson(value || {});
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `demo:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  _ensureLegacyBankApplications(db) {
    let changed = false;
    for (const finance of db.finance || []) {
      if (!isBankManagedFinance(finance) || (db.bankRuleApplications || []).some((item) => item.financeId === finance.id)) continue;
      const suffix = this._bankFingerprint(finance).replace('demo:', '');
      db.bankRuleApplications.push({
        id: `bank-application:legacy:${suffix}`, idempotencyKey: `legacy:${suffix}`,
        operation: 'legacy_backfill', decision: 'legacy', state: 'applied', financeId: finance.id,
        financeFingerprint: this._bankFingerprint(finance), operationDate: finance.date,
        businessId: businessIdOf(finance), category: finance.category, method: finance.method,
        auditRef: `legacy-${suffix}`, canReverse: false, actor: 'migration', created: finance.updated || finance.created || 0,
      });
      changed = true;
    }
    return changed;
  }

  _bankSettings(db) {
    if (!db.bankRuleSettings.length) db.bankRuleSettings.push({ ...DEFAULT_BANK_RULE_SETTINGS, created: Date.now(), updated: Date.now() });
    return safeBankRuleSettings(db.bankRuleSettings[0]);
  }

  _validateBankRuleActions(db, u, actions = {}, requireClassification = true) {
    const businessId = String(actions.businessId || '').trim();
    if (!businessId) return 'Не указан бизнес';
    const business = db.businesses.find((item) => item.id === businessId && item.active !== false);
    if (!business) return 'Бизнес не найден или находится в архиве';
    const accessDeny = this._scopeWriteError(db, u, { businessId, unit: businessId });
    if (accessDeny) return accessDeny;
    if ((requireClassification && !String(actions.category || '').trim()) || String(actions.category || '').length > 120) return 'Не указана категория';
    if (actions.owner && !db.businessOwners.some((item) => businessIdOf(item) === businessId
      && item.businessId === businessId && item.unit === businessId && item.ownerId === actions.owner && item.active !== false)) {
      return 'Владелец не относится к этому бизнесу';
    }
    const links = actions.links || {};
    const refs = [['playerId', 'players'], ['companyId', 'companies'], ['contactId', 'contacts'], ['dealId', 'deals']];
    for (const [field, entity] of refs) {
      if (!links[field]) continue;
      const item = db[entity].find((candidate) => candidate.id === links[field]);
      if (!item || businessIdOf(item) !== businessId || item.businessId !== businessId || item.unit !== businessId) return 'Связанная запись не относится к этому бизнесу';
    }
    const contact = db.contacts.find((item) => item.id === links.contactId);
    const deal = db.deals.find((item) => item.id === links.dealId);
    if (contact && links.companyId && contact.companyId !== links.companyId) return 'Контакт не относится к выбранной компании';
    if (deal && links.companyId && deal.companyId && deal.companyId !== links.companyId) return 'Сделка не относится к выбранной компании';
    if (deal && links.contactId && deal.contactId && deal.contactId !== links.contactId) return 'Сделка не относится к выбранному контакту';
    const eventLink = links.event;
    if (eventLink?.eventId) {
      if (!business.modules?.includes('events')) return 'Модуль «События» выключен';
      const event = db.events.find((item) => item.id === eventLink.eventId);
      if (!event || businessIdOf(event) !== businessId || event.businessId !== businessId || event.unit !== businessId || event.settlementStatus === 'closed') return 'Событие недоступно для этого бизнеса';
      const registration = eventLink.registrationId && db.eventRegistrations.find((item) => item.id === eventLink.registrationId);
      if (eventLink.registrationId && (!registration || registration.eventId !== event.id || businessIdOf(registration) !== businessId)) return 'Регистрация не относится к событию';
      const expectedParticipant = links.playerId || links.companyId || links.contactId;
      if (registration && expectedParticipant && registration.participantId !== expectedParticipant) return 'Регистрация относится к другому участнику';
      const budget = eventLink.budgetLineId && db.eventBudgetLines.find((item) => item.id === eventLink.budgetLineId);
      if (eventLink.budgetLineId && (!budget || budget.eventId !== event.id || businessIdOf(budget) !== businessId)) return 'Строка бюджета не относится к событию';
    }
    return null;
  }

  async bankRulesList(token) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    return { ok: true, rules: structuredClone(db.bankRules), versions: structuredClone(db.bankRuleVersions) };
  }

  async bankRuleSave(token, source, expectedVersion = 0) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const activationToken = String(source?.activationToken || '');
    const candidate = { ...(source || {}) }; delete candidate.activationToken;
    const validation = validateBankRule(candidate);
    if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
    const db = this._db();
    const id = String(validation.rule.id || `bank-rule:${uid()}`);
    const current = db.bankRules.find((rule) => rule.id === id);
    if (Number(current?.version || 0) !== Number(expectedVersion || 0)) return { ok: false, error: 'Правило уже изменено' };
    if (validation.rule.actions?.businessId) {
      const targetDeny = this._validateBankRuleActions(db, u, validation.rule.actions, validation.rule.decision === 'auto');
      if (targetDeny) return { ok: false, error: targetDeny };
    }
    let activation = {};
    if (validation.rule.decision === 'auto' && validation.rule.enabled !== false) {
      const fingerprint = this._bankFingerprint(activationRuleShape(validation.rule));
      const run = db.bankRuleRuns.find((item) => item.kind === 'dry-run'
        && item.activation?.tokenHash === this._bankFingerprint(activationToken)
        && item.activation?.ruleFingerprint === fingerprint
        && Number(item.activation?.expectedVersion) === Number(expectedVersion || 0)
        && Number(item.activation?.settingsVersion) === Number(this._bankSettings(db).settingsVersion)
        && item.actor === u.id && Number(item.activation?.expiresAt || 0) >= Date.now());
      if (!run) return { ok: false, error: 'Сначала выполните проверку этого auto-правила и явно подтвердите включение' };
      activation = { activationRunId: run.id, activationFingerprint: fingerprint };
    }
    const now = Date.now();
    const rule = {
      ...validation.rule, ...activation, id, version: Number(current?.version || 0) + 1,
      enabled: validation.rule.enabled !== false,
      createdBy: current?.createdBy || u.id, updatedBy: u.id,
      created: current?.created || now, updated: now,
    };
    rule.checksum = this._bankFingerprint({ ...rule, checksum: undefined, updated: undefined });
    if (current) db.bankRules[db.bankRules.indexOf(current)] = rule; else db.bankRules.push(rule);
    db.bankRuleVersions.push({ ...structuredClone(rule), id: `${id}:v${rule.version}`, ruleId: id });
    this._save(db);
    return { ok: true, rule };
  }

  async bankRuleEnable(token, id, enabled, expectedVersion, activationToken = '') {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const current = db.bankRules.find((rule) => rule.id === id);
    if (!current) return { ok: false, error: 'Правило не найдено' };
    if (current.deleted === true && enabled === true) return { ok: false, error: 'Архивное правило нельзя включить' };
    return this.bankRuleSave(token, { ...current, enabled: enabled === true, activationToken }, expectedVersion);
  }

  async bankRuleDelete(token, id, expectedVersion) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const current = db.bankRules.find((rule) => rule.id === id);
    if (!current) return { ok: false, error: 'Правило не найдено' };
    return this.bankRuleSave(token, { ...current, enabled: false, deleted: true, deletedAt: Date.now() }, expectedVersion);
  }

  async bankRuleSettingsGet(token) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    return { ok: true, settings: structuredClone(this._bankSettings(this._db())) };
  }

  async bankRuleSettingsUpdate(token, source, expectedVersion) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const current = this._bankSettings(db);
    if (Number(current.settingsVersion) !== Number(expectedVersion)) return { ok: false, error: 'Настройки уже изменены' };
    const settings = safeBankRuleSettings({ ...source, id: current.id, created: current.created, settingsVersion: current.settingsVersion + 1, updatedBy: u.id, updated: Date.now() });
    if (settings.autoEnabled && (!settings.allowedDirections.length || !settings.maxTransactionsPerDay || !settings.maxTotalAmountMinorPerDay)) {
      return { ok: false, error: 'Перед включением автопроведения задайте безопасные лимиты' };
    }
    db.bankRuleSettings[0] = settings;
    db.bankRuleSettingVersions.push({ ...structuredClone(settings), id: `bank-rule-settings:v${settings.settingsVersion}`, settingsId: 'bank-rule-settings' });
    this._save(db);
    return { ok: true, settings };
  }

  async bankRulePreviewTransaction(token, transactionId, draft) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const transaction = db.bankTransactions.find((item) => item.id === transactionId);
    if (!transaction) return { ok: false, error: 'Банковская операция не найдена' };
    let rules = db.bankRules;
    if (draft) {
      const validation = validateBankRule(draft);
      if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
      const id = String(validation.rule.id || 'draft');
      rules = [{ ...validation.rule, id, version: validation.rule.version || 0 }, ...rules.filter((rule) => rule.id !== id)];
    }
    const evaluation = evaluateBankRules(transaction.bankSignals || {}, rules, this._bankSettings(db));
    return { ok: true, evaluation: publicBankRuleEvaluation(evaluation), evaluationToken: bankRuleEvaluationToken(transaction, evaluation) };
  }

  async bankRuleDryRun(token, draft, expectedVersion = 0) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    let rules = db.bankRules;
    let activationToken = '';
    let activation;
    if (draft) {
      const validation = validateBankRule(draft);
      if (!validation.ok) return { ok: false, error: validation.errors[0], errors: validation.errors };
      const id = String(validation.rule.id || 'draft');
      rules = [{ ...validation.rule, id, version: validation.rule.version || 0 }, ...rules.filter((rule) => rule.id !== id)];
      if (validation.rule.decision === 'auto' && validation.rule.enabled !== false) {
        activationToken = `activate:${uid()}:${uid()}`;
        activation = {
          tokenHash: this._bankFingerprint(activationToken),
          ruleFingerprint: this._bankFingerprint(activationRuleShape(validation.rule)),
          expectedVersion: Number(expectedVersion || 0), settingsVersion: this._bankSettings(db).settingsVersion,
          expiresAt: Date.now() + 15 * 60 * 1000,
        };
      }
    }
    const summary = aggregateBankRulePreview(db.bankTransactions, rules, this._bankSettings(db));
    db.bankRuleRuns.push({ id: `bank-rule-run:${uid()}`, kind: 'dry-run', summary, actor: u.id, engineVersion: BANK_RULE_ENGINE_VERSION, created: Date.now(), ...(activation ? { activation } : {}) });
    this._save(db);
    return { ok: true, summary, ...(activationToken ? { activationToken, expiresAt: activation.expiresAt } : {}) };
  }

  _localApplyBankRule(db, u, transaction, evaluation, idempotencyKey, decision = 'suggest') {
    const existingApplication = db.bankRuleApplications.find((item) => item.idempotencyKey === idempotencyKey);
    if (existingApplication) {
      if (existingApplication.sourceQueueId !== transaction.id || existingApplication.operation !== 'apply') {
        return { ok: false, error: 'Ключ повторяемости использован для другого действия' };
      }
      const item = db.finance.find((finance) => finance.id === existingApplication.financeId);
      return { ok: true, item, application: existingApplication, alreadyProcessed: true };
    }
    const queueState = transaction.bankRuleState || 'pending';
    const signalError = bankQueueSignalError(transaction);
    if (signalError) return { ok: false, error: signalError };
    if ((decision === 'manual' && !['pending', 'manual'].includes(queueState))
      || (decision !== 'manual' && queueState !== 'pending')) return { ok: false, error: 'Сначала верните операцию к проверке' };
    if (evaluation.conflict || !evaluation.actions?.businessId || !evaluation.actions?.category) return { ok: false, error: 'Правила конфликтуют' };
    const targetDeny = this._validateBankRuleActions(db, u, evaluation.actions);
    if (targetDeny) return { ok: false, error: targetDeny };
    const businessId = evaluation.actions.businessId;
    const accessDeny = this._scopeWriteError(db, u, { businessId, unit: businessId });
    if (accessDeny) return { ok: false, error: accessDeny };
    const existingFinance = db.finance.find((item) => transaction.bankId && item.bankId === transaction.bankId);
    if (existingFinance) {
      const application = {
        id: `bank-application:${uid()}`, idempotencyKey, sourceQueueId: transaction.id, operation: 'apply',
        decision, state: 'already_processed', financeId: existingFinance.id,
        financeFingerprint: this._bankFingerprint(existingFinance), actor: u.id, created: Date.now(),
      };
      db.bankRuleApplications.push(application);
      db.bankTransactions = db.bankTransactions.filter((item) => item.id !== transaction.id);
      this._save(db);
      return { ok: true, item: existingFinance, application, alreadyProcessed: true };
    }
    const now = Date.now();
    if (!['pending', 'manual'].includes(transaction.bankRuleState || 'pending')) return { ok: false, error: 'Сначала верните операцию к проверке' };
    const financeId = `bank:${transaction.id}`;
    const amountMinor = Number(transaction.bankSignals?.amountMinor ?? Math.round(Number(transaction.amount || 0) * 100));
    const applicationId = `bank-application:${uid()}`;
    const item = {
      id: financeId, businessId, unit: businessId, date: transaction.date,
      type: transaction.type, amount: amountMinor / 100,
      method: evaluation.actions.methodOverride || transaction.method || 'account', source: 'bank',
      category: evaluation.actions.category,
      counterparty: evaluation.actions.counterpartyOverride || transaction.counterparty || '',
      comment: evaluation.actions.comment
        ? `${transaction.comment || ''}${transaction.comment ? ' · ' : ''}${evaluation.actions.comment}` : transaction.comment || '',
      owner: evaluation.actions.owner || undefined, tags: evaluation.actions.tags || [],
      bankId: transaction.bankId, bankQueueId: transaction.id, bankSignals: transaction.bankSignals,
      bankSignalFingerprint: this._bankFingerprint(transaction.bankSignals || {}),
      bankOriginal: { method: transaction.method || 'account', counterparty: transaction.counterparty || '', comment: transaction.comment || '' },
      appliedRuleId: evaluation.appliedRuleId, appliedRuleVersion: evaluation.appliedRuleVersion,
      applicationId, created: transaction.created || now, updated: now,
    };
    const links = evaluation.actions.links || {};
    const eventAllocation = links.event?.eventId ? normalizeEventRecord('eventFinanceAllocations', {
      id: `event-finance:${uid()}`, businessId, unit: businessId, eventId: links.event.eventId, financeId,
      registrationId: links.event.registrationId || undefined, budgetLineId: links.event.budgetLineId || undefined,
      purpose: links.event.purpose, amount: Number(links.event.amountMinor || amountMinor) / 100,
      idempotencyKey: `${idempotencyKey}:event`, createdBy: u.id, created: now, updated: now,
    }) : null;
    if (eventAllocation) {
      const eventDeny = eventRecordError('eventFinanceAllocations', eventAllocation, { ...db, finance: [...db.finance, item] });
      if (eventDeny) return { ok: false, error: eventDeny };
    }
    db.finance.push(item);
    ['playerId', 'companyId', 'contactId', 'dealId'].forEach((field) => {
      if (!links[field]) return;
      db.financeRelations.push({
        id: `finance-relation:${uid()}`, businessId, unit: businessId, financeId,
        relationType: field.replace(/Id$/, ''), relationId: links[field], applicationId,
        idempotencyKey: `${idempotencyKey}:${field}`, created: now,
      });
    });
    if (eventAllocation) db.eventFinanceAllocations.push(eventAllocation);
    const application = {
      id: applicationId, idempotencyKey, appliedRuleId: evaluation.appliedRuleId,
      sourceQueueId: transaction.id, operation: 'apply',
      appliedRuleVersion: evaluation.appliedRuleVersion,
      settingsVersion: this._bankSettings(db).settingsVersion,
      engineVersion: BANK_RULE_ENGINE_VERSION, decision, state: 'applied',
      confidence: evaluation.confidence, financeId,
      financeFingerprint: this._bankFingerprint(item),
      operationDate: transaction.date, businessId, category: item.category, method: item.method,
      auditRef: `audit-${applicationId.slice(-8)}`, canReverse: true,
      actor: u.id, day: new Date().toISOString().slice(0, 10), amountMinor, created: now,
    };
    db.bankRuleApplications.push(application);
    db.bankTransactions = db.bankTransactions.filter((entry) => entry.id !== transaction.id);
    this._save(db);
    return { ok: true, item, application };
  }

  async bankRuleApplySuggestion(token, transactionId, expectedEvaluationToken, idempotencyKey) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(idempotencyKey || ''))) return { ok: false, error: 'Некорректный ключ повторяемости' };
    const db = this._db();
    const transaction = db.bankTransactions.find((item) => item.id === transactionId);
    if (!transaction) {
      const application = db.bankRuleApplications.find((item) => item.idempotencyKey === idempotencyKey);
      return application && application.sourceQueueId === transactionId && application.operation === 'apply'
        ? { ok: true, item: db.finance.find((item) => item.id === application.financeId), application, alreadyProcessed: true }
        : application ? { ok: false, error: 'Ключ повторяемости использован для другого действия' }
        : { ok: false, error: 'Банковская операция не найдена' };
    }
    if (transaction.bankRuleState && transaction.bankRuleState !== 'pending') return { ok: false, error: 'Сначала верните операцию к проверке' };
    const evaluation = evaluateBankRules(transaction.bankSignals || {}, db.bankRules, this._bankSettings(db));
    if (!evaluation.appliedRuleId || evaluation.conflict || ['manual', 'ignore'].includes(evaluation.requestedDecision)) {
      return { ok: false, error: evaluation.conflict ? 'Правила конфликтуют' : 'Эта операция требует ручной обработки' };
    }
    if (!expectedEvaluationToken || expectedEvaluationToken !== bankRuleEvaluationToken(transaction, evaluation)) return { ok: false, error: 'Предложение устарело' };
    return this._localApplyBankRule(db, u, transaction, evaluation, idempotencyKey, 'suggest');
  }

  async _bankQueueState(token, transactionId, idempotencyKey, state, outcome) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(idempotencyKey || ''))) return { ok: false, error: 'Некорректный ключ повторяемости' };
    const db = this._db();
    const existing = db.bankRuleApplications.find((item) => item.idempotencyKey === idempotencyKey);
    const operation = `queue:${state}:${outcome}`;
    if (existing) return existing.sourceQueueId === transactionId && existing.operation === operation
      ? { ok: true, application: existing, alreadyProcessed: true }
      : { ok: false, error: 'Ключ повторяемости использован для другого действия' };
    const transaction = db.bankTransactions.find((item) => item.id === transactionId);
    if (!transaction) return { ok: false, error: 'Банковская операция не найдена' };
    transaction.bankRuleState = state;
    transaction.updated = Date.now();
    const application = { id: `bank-application:${uid()}`, idempotencyKey, sourceQueueId: transaction.id, operation, decision: state, state: outcome, actor: u.id, created: Date.now() };
    db.bankRuleApplications.push(application);
    this._save(db);
    return { ok: true, application };
  }

  bankRuleRejectSuggestion(token, transactionId, idempotencyKey) { return this._bankQueueState(token, transactionId, idempotencyKey, 'pending', 'rejected'); }
  bankRuleIgnore(token, transactionId, idempotencyKey) { return this._bankQueueState(token, transactionId, idempotencyKey, 'ignored', 'ignored'); }
  bankRuleManual(token, transactionId, idempotencyKey) { return this._bankQueueState(token, transactionId, idempotencyKey, 'manual', 'manual'); }
  bankRuleReevaluate(token, transactionId, idempotencyKey) { return this._bankQueueState(token, transactionId, idempotencyKey, 'pending', 'reevaluated'); }

  async bankRuleJournal(token, limit = 50, cursorSource = '') {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    const count = Math.min(100, Math.max(1, Math.floor(Number(limit || 50))));
    let cursor;
    try { cursor = decodeBankJournalCursor(cursorSource); } catch (_error) {
      return { ok: false, error: 'Некорректный курсор журнала' };
    }
    const ordered = db.bankRuleApplications.slice().sort((a, b) => bankJournalCreated(b) - bankJournalCreated(a) || String(b.id).localeCompare(String(a.id)));
    const afterCursor = cursor ? ordered.filter((item) => bankJournalCreated(item) < cursor.created
      || (bankJournalCreated(item) === cursor.created && String(item.id).localeCompare(cursor.id) < 0)) : ordered;
    const page = afterCursor.slice(0, count + 1);
    const hasMore = page.length > count;
    const pageItems = page.slice(0, count);
    const applications = pageItems.map((item) => {
      const finance = db.finance.find((entry) => entry.id === item.financeId);
      return {
        id: String(item.id || ''), decision: String(item.decision || ''), state: String(item.state || ''),
        operation: String(item.operation || ''),
        appliedRuleId: item.appliedRuleId ? String(item.appliedRuleId) : undefined,
        appliedRuleVersion: item.appliedRuleVersion === undefined ? undefined : Number(item.appliedRuleVersion),
        created: Number(item.created || 0), auditRef: item.auditRef || `audit-${String(item.id || '').slice(-8)}`,
        operationDate: item.operationDate || finance?.date,
        businessId: item.businessId || businessIdOf(finance), category: item.category || finance?.category,
        method: item.method || finance?.method,
        canReverse: item.canReverse !== false && item.operation !== 'legacy_backfill',
      };
    });
    const nextCursor = hasMore && pageItems.length ? encodeBankJournalCursor(pageItems[pageItems.length - 1]) : '';
    return { ok: true, applications, hasMore, nextCursor };
  }

  async bankRuleCorrect(token, applicationId, patch, idempotencyKey) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(idempotencyKey || ''))) return { ok: false, error: 'Некорректный ключ повторяемости' };
    const db = this._db();
    const existing = db.bankRuleApplications.find((item) => item.idempotencyKey === idempotencyKey);
    const patchChecksum = this._bankFingerprint(patch || {});
    if (existing) return existing.sourceApplicationId === applicationId && existing.patchChecksum === patchChecksum
      ? { ok: true, application: existing, alreadyProcessed: true }
      : { ok: false, error: 'Ключ повторяемости использован для другого исправления' };
    const requested = db.bankRuleApplications.find((item) => item.id === applicationId && ['applied', 'corrected'].includes(item.state));
    const application = requested && db.bankRuleApplications.filter((item) => item.financeId === requested.financeId && ['applied', 'corrected'].includes(item.state))
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0) || String(b.id).localeCompare(String(a.id)))[0];
    const finance = db.finance.find((item) => item.id === application?.financeId);
    if (!application || !finance || application.financeFingerprint !== this._bankFingerprint(finance)) return { ok: false, error: 'Операция уже изменилась' };
    const allowed = ['category', 'method', 'owner', 'comment', 'counterparty'];
    if (Object.keys(patch || {}).some((key) => !allowed.includes(key))) return { ok: false, error: 'Можно исправить только классификацию' };
    const clearable = new Set(['owner', 'comment', 'counterparty']);
    if (Object.entries(patch || {}).some(([key, value]) => typeof value !== 'string' && !(value === null && clearable.has(key)))) {
      return { ok: false, error: 'Поля исправления должны быть строками или явным очищением' };
    }
    if (patch.category !== undefined && (!String(patch.category).trim() || String(patch.category).length > 120)) return { ok: false, error: 'Некорректная категория' };
    if (patch.method !== undefined && !FIN_METHODS.some((item) => item.id === patch.method)) return { ok: false, error: 'Некорректный способ оплаты' };
    if (patch.owner && !db.businessOwners.some((item) => businessIdOf(item) === finance.businessId && item.ownerId === patch.owner && item.active !== false)) return { ok: false, error: 'Владелец не относится к бизнесу' };
    if (String(patch.comment || '').length > 300 || String(patch.counterparty || '').length > 160) return { ok: false, error: 'Слишком длинное значение исправления' };
    const before = Object.fromEntries(allowed.map((key) => [key, finance[key]]));
    Object.assign(finance, patch, { updated: Date.now() });
    const audit = {
      id: `bank-application:${uid()}`, idempotencyKey, decision: 'correct', state: 'corrected',
      sourceApplicationId: applicationId, patchChecksum,
      financeId: finance.id, supersedes: application.id, before, after: Object.fromEntries(allowed.map((key) => [key, finance[key]])),
      actor: u.id, created: Date.now(), financeFingerprint: this._bankFingerprint(finance),
      operationDate: finance.date, businessId: businessIdOf(finance), category: finance.category, method: finance.method,
      auditRef: `audit-${this._bankFingerprint(idempotencyKey).slice(-8)}`, canReverse: application.canReverse !== false,
    };
    db.bankRuleApplications.push(audit);
    this._save(db);
    return { ok: true, item: finance, application: audit };
  }

  async bankRuleReverse(token, applicationId, idempotencyKey) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(String(idempotencyKey || ''))) return { ok: false, error: 'Некорректный ключ повторяемости' };
    const db = this._db();
    const existing = db.bankRuleApplications.find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return existing.sourceApplicationId === applicationId
      ? { ok: true, application: existing, alreadyProcessed: true }
      : { ok: false, error: 'Ключ повторяемости использован для другой отмены' };
    const requested = db.bankRuleApplications.find((item) => item.id === applicationId && ['applied', 'corrected'].includes(item.state));
    const application = requested && db.bankRuleApplications.filter((item) => item.financeId === requested.financeId && ['applied', 'corrected'].includes(item.state))
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0) || String(b.id).localeCompare(String(a.id)))[0];
    const finance = db.finance.find((item) => item.id === application?.financeId);
    if (!application || application.canReverse === false || application.operation === 'legacy_backfill'
      || !finance || application.financeFingerprint !== this._bankFingerprint(finance)
      || db.financeRelations.some((item) => item.financeId === finance?.id)
      || db.eventFinanceAllocations.some((item) => item.financeId === finance?.id)
      || db.stockMovements.some((item) => item.financeId === finance?.id)) {
      return { ok: false, error: 'Безопасная отмена невозможна: операция или её связи уже изменились' };
    }
    const now = Date.now();
    db.bankTransactions.push({
      id: finance.bankQueueId, bankId: finance.bankId, date: finance.date, type: finance.type,
      amount: finance.amount, method: finance.bankOriginal?.method || finance.method, source: 'bank',
      counterparty: finance.bankOriginal?.counterparty || '', comment: finance.bankOriginal?.comment || '',
      bankSignals: finance.bankSignals, bankSignalFingerprint: finance.bankSignalFingerprint,
      bankRuleState: 'pending', created: finance.created, updated: now,
    });
    db.finance = db.finance.filter((item) => item.id !== finance.id);
    const reversal = { id: `bank-application:${uid()}`, idempotencyKey, sourceApplicationId: applicationId, decision: 'reverse', state: 'reversed', supersedes: application.id, actor: u.id, created: now };
    db.bankRuleApplications.push(reversal);
    this._save(db);
    return { ok: true, application: reversal };
  }

  async processBankTransaction(token, id, businessId, category) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    id = String(id || '').trim();
    businessId = String(businessId || '').trim();
    category = String(category || '').trim();
    if (!id) return { ok: false, error: 'Не указана банковская операция' };
    if (!businessId) return { ok: false, error: 'Не указан бизнес' };
    if (!category || category.length > 120) return { ok: false, error: 'Не указана категория' };
    const accessError = this._scopeWriteError(db, u, { businessId, unit: businessId });
    if (accessError) return { ok: false, error: accessError };
    const transaction = db.bankTransactions.find((item) => item.id === id);
    if (!transaction) {
      const application = db.bankRuleApplications.find((item) => item.sourceQueueId === id && item.operation === 'apply' && item.decision === 'manual');
      const applied = application && db.finance.find((item) => item.id === application.financeId);
      if (applied) return { ok: true, item: applied, application, alreadyProcessed: true };
      const alreadyProcessed = db.finance.find((item) => item.id === `bank:${id}`);
      return alreadyProcessed
        ? { ok: true, item: alreadyProcessed, alreadyProcessed: true }
        : { ok: false, error: 'Не найдено' };
    }

    // Старые проведённые операции с тем же bankId остаются источником истины.
    // Очередь очищается, но финансовый дубль не создаётся.
    const financeId = `bank:${transaction.id}`;
    const existing = db.finance.find((item) => item.id === financeId || (transaction.bankId && item.bankId === transaction.bankId));
    if (existing) {
      const idempotencyKey = `manual:${id}:${Number(transaction.updated || 0)}:${this._bankFingerprint(transaction.bankSignals || {})}`;
      const application = {
        id: `bank-application:${uid()}`, idempotencyKey, sourceQueueId: transaction.id, operation: 'apply',
        decision: 'manual', state: 'already_processed', financeId: existing.id,
        financeFingerprint: this._bankFingerprint(existing), actor: u.id, created: Date.now(),
      };
      db.bankRuleApplications.push(application);
      db.bankTransactions = db.bankTransactions.filter((item) => item.id !== id);
      this._save(db);
      return { ok: true, item: existing, application, alreadyProcessed: true };
    }

    const now = Date.now();
    return this._localApplyBankRule(db, u, transaction, {
      actions: { businessId, category }, confidence: 1, amountOnly: false, conflict: false,
      appliedRuleId: undefined, appliedRuleVersion: undefined,
    }, `manual:${id}:${Number(transaction.updated || 0)}:${this._bankFingerprint(transaction.bankSignals || {})}`, 'manual');
  }

  async backup(token) {
    const u = this._user(token);
    if (!u || u.role !== 'admin') return { ok: false, error: 'Только для админа' };
    const db = this._db();
    return {
      ok: true,
      data: Object.fromEntries(LOCAL_ENTITIES.map((entity) => [entity, structuredClone(db[entity] || [])])),
    };
  }

  async migrateImport(token, data) {
    const u = this._user(token);
    const current = this._db();
    if (current.employees.length && (!u || u.role !== 'admin')) return { ok: false, error: 'Только для админа' };
    const db = structuredClone(current);
    let imported = 0;
    const ordinaryEntities = LOCAL_ENTITIES.filter((entity) => !EVENT_ENTITIES.includes(entity) && !BANK_RULE_ENTITIES.includes(entity) && entity !== 'employees' && entity !== 'bankTransactions');
    ordinaryEntities.forEach((entity) => {
      (data?.[entity] || []).forEach((source) => {
        const item = structuredClone(source);
        if (!item?.id || (entity === 'finance' && isBankManagedFinance(item))) return;
        db[entity] = db[entity] || [];
        const i = db[entity].findIndex((x) => x.id === item.id);
        if (i >= 0) db[entity][i] = item; else db[entity].push(item);
        imported++;
      });
    });
    for (const item of data?.bankTransactions || []) {
      if (!item?.id || !item?.bankId || !isSafeBankSignals(item.bankSignals || {})
        || bankQueueSignalError(item)
        || ['raw', 'payload', 'token'].some((key) => item[key] !== undefined)) return { ok: false, error: 'Резервная копия содержит небезопасную банковскую очередь' };
      if (item.bankId && db.finance.some((finance) => finance.bankId === item.bankId)) continue;
      if (!db.bankTransactions.some((candidate) => candidate.id === item.id || (item.bankId && candidate.bankId === item.bankId))) {
        db.bankTransactions.push(structuredClone(item));
      }
      imported++;
    }
    const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const normalizeRestoreScope = (source) => {
      const item = structuredClone(source);
      const mismatch = scopeError(item);
      if (mismatch) throw new Error(mismatch);
      const businessId = businessIdOf(item);
      if (!businessId) throw new Error('Не указан бизнес');
      item.businessId = businessId;
      item.unit = businessId;
      if (!db.businesses.some((business) => business.id === businessId)) throw new Error('Бизнес события не найден');
      return item;
    };
    try {
      for (const source of (data?.finance || []).filter(isBankManagedFinance)) {
        const item = structuredClone(source);
        if (!item?.id || !item?.bankId || item.source !== 'bank' || !isSafeBankSignals(item.bankSignals || {})
          || bankQueueSignalError(item) || scopeError(item) || !businessIdOf(item)
          || !db.businesses.some((business) => business.id === businessIdOf(item))) {
          throw new Error('Резервная копия содержит небезопасную банковскую финансовую операцию');
        }
        const conflict = db.bankTransactions.some((candidate) => candidate.bankId === item.bankId);
        const existing = db.finance.find((candidate) => candidate.id === item.id || candidate.bankId === item.bankId);
        if (conflict || (existing && !exact(existing, item))) throw new Error('Конфликт банковской финансовой операции');
        if (!existing) db.finance.push(item);
        imported++;
      }
      const bankRestoreOrder = ['bankRules', 'bankRuleVersions', 'bankRuleSettingVersions', 'bankRuleApplications', 'bankRuleRuns', 'bankRuleSettings', 'financeRelations'];
      const settingsComparable = (item) => JSON.stringify({
        autoEnabled: item.autoEnabled, allowedDirections: item.allowedDirections, maxAmountMinor: item.maxAmountMinor,
        maxTransactionsPerRun: item.maxTransactionsPerRun, maxTransactionsPerDay: item.maxTransactionsPerDay,
        maxTotalAmountMinorPerDay: item.maxTotalAmountMinorPerDay,
      });
      for (const entity of bankRestoreOrder) {
        for (const source of data?.[entity] || []) {
          if (!source?.id) continue;
          const item = structuredClone(source);
          const existing = db[entity].find((candidate) => candidate.id === item.id);
          if (entity === 'bankRuleSettings') {
            const safe = safeBankRuleSettings(item);
            if (item.id !== 'bank-rule-settings' || Object.keys(item).some((key) => !(key in safe))) throw new Error('Некорректные настройки правил в резервной копии');
            const version = db.bankRuleSettingVersions.find((candidate) => Number(candidate.settingsVersion) === Number(safe.settingsVersion));
            if (!version || settingsComparable(version) !== settingsComparable(safe)) throw new Error('Текущие настройки не подтверждены неизменяемой версией');
            const pristine = Number(existing?.settingsVersion) === 1 && settingsComparable(existing) === settingsComparable(DEFAULT_BANK_RULE_SETTINGS);
            if (existing && !pristine && !exact(existing, safe)) throw new Error('Резервная копия не может откатить действующие настройки');
            if (existing) db[entity][db[entity].indexOf(existing)] = safe; else db[entity].push(safe);
          } else if (entity === 'bankRuleSettingVersions' && item.id === 'bank-rule-settings:v1' && existing) {
            if (settingsComparable(existing) !== settingsComparable(item)) throw new Error('Конфликт начальной версии настроек');
          } else {
            if (existing && !exact(existing, item)) throw new Error(`Конфликт повторного восстановления ${entity}:${item.id}`);
            if (!existing) db[entity].push(item);
          }
          imported++;
        }
      }
      for (const relation of db.financeRelations) {
        const businessId = businessIdOf(relation);
        const entity = { player: 'players', company: 'companies', contact: 'contacts', deal: 'deals' }[relation.relationType];
        const finance = db.finance.find((item) => item.id === relation.financeId && businessIdOf(item) === businessId);
        const target = entity && db[entity].find((item) => item.id === relation.relationId && businessIdOf(item) === businessId);
        if (!businessId || relation.businessId !== businessId || relation.unit !== businessId || !finance || !target) {
          throw new Error('Финансовая связь резервной копии не относится к бизнесу');
        }
      }
      for (const entity of EVENT_ENTITIES) {
        for (const source of data?.[entity] || []) {
          if (!source?.id) continue;
          const item = normalizeRestoreScope(source);
          const existing = db[entity].find((candidate) => candidate.id === item.id);
          if (existing && !exact(existing, item)) throw new Error(`Конфликт повторного восстановления ${entity}:${item.id}`);
          if (!existing) db[entity].push(item);
          imported++;
        }
      }
      const byId = (entity, id, businessId) => db[entity].find((item) => item.id === id
        && !scopeError(item) && businessIdOf(item) === businessId);
      for (const event of db.events) {
        const businessId = businessIdOf(event);
        if (!byId('eventTypes', event.eventTypeId, businessId)) throw new Error('Тип события не относится к бизнесу события');
        if (event.venueId && !byId('venues', event.venueId, businessId)) throw new Error('Площадка не относится к бизнесу события');
      }
      const registrationKeys = new Set();
      for (const registration of db.eventRegistrations) {
        const businessId = businessIdOf(registration);
        const event = byId('events', registration.eventId, businessId);
        if (!event) throw new Error('Регистрация не относится к бизнесу события');
        const participantEntity = { player: 'players', company: 'companies', contact: 'contacts' }[registration.participantType];
        if (!participantEntity || !byId(participantEntity, registration.participantId, businessId)) throw new Error('Участник не относится к бизнесу регистрации');
        const key = `${registration.eventId}\0${registration.participantType}\0${registration.participantId}`;
        if (registrationKeys.has(key)) throw new Error('Участник уже зарегистрирован на это событие');
        registrationKeys.add(key);
      }
      for (const line of db.eventBudgetLines) {
        if (!byId('events', line.eventId, businessIdOf(line))) throw new Error('Строка бюджета не относится к бизнесу события');
      }
      const allocatedByFinance = new Map();
      for (const allocation of db.eventFinanceAllocations) {
        const businessId = businessIdOf(allocation);
        if (!byId('events', allocation.eventId, businessId)) throw new Error('Финансовая связь не относится к бизнесу события');
        const finance = byId('finance', allocation.financeId, businessId);
        if (!finance) throw new Error('Финансовая операция не относится к бизнесу события');
        if (allocation.registrationId) {
          const registration = byId('eventRegistrations', allocation.registrationId, businessId);
          if (!registration || registration.eventId !== allocation.eventId) throw new Error('Регистрация не относится к финансовой связи');
        }
        if (allocation.budgetLineId) {
          const line = byId('eventBudgetLines', allocation.budgetLineId, businessId);
          if (!line || line.eventId !== allocation.eventId) throw new Error('Строка бюджета не относится к финансовой связи');
        }
        const allocated = Number(allocatedByFinance.get(finance.id) || 0) + Number(allocation.amount || 0);
        if (Math.round(allocated * 100) > Math.round(Number(finance.amount || 0) * 100)) throw new Error('Распределено больше суммы финансовой операции');
        allocatedByFinance.set(finance.id, allocated);
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
    for (const source of data?.employees || []) {
      if (!source?.id) continue;
      const item = structuredClone(source);
      const i = db.employees.findIndex((candidate) => candidate.id === item.id);
      if (i >= 0) db.employees[i] = item; else db.employees.push(item);
      imported++;
    }
    ensureCoreData(db);
    this._ensureLegacyBankApplications(db);
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
  processBankTransaction(token, id, businessId, category) { return this._call({ action: 'process_bank_transaction', token, id, businessId, category }); }
  bankRulesList(token) { return this._call({ action: 'bank_rules_list', token }); }
  bankRuleSave(token, rule, expectedVersion) { return this._call({ action: 'bank_rule_save', token, rule, expectedVersion }); }
  bankRuleEnable(token, id, enabled, expectedVersion, activationToken = '') { return this._call({ action: 'bank_rule_enable', token, id, enabled, expectedVersion, activationToken }); }
  bankRuleDelete(token, id, expectedVersion) { return this._call({ action: 'bank_rule_delete', token, id, expectedVersion }); }
  bankRuleSettingsGet(token) { return this._call({ action: 'bank_rule_settings_get', token }); }
  bankRuleSettingsUpdate(token, settings, expectedVersion) { return this._call({ action: 'bank_rule_settings_update', token, settings, expectedVersion }); }
  bankRulePreviewTransaction(token, transactionId, draft) { return this._call({ action: 'bank_rule_preview_transaction', token, transactionId, draft }); }
  bankRuleDryRun(token, draft, expectedVersion = 0) { return this._call({ action: 'bank_rule_dry_run', token, draft, expectedVersion }); }
  bankRuleApplySuggestion(token, transactionId, expectedEvaluationToken, idempotencyKey) {
    return this._call({ action: 'bank_rule_apply_suggestion', token, transactionId, expectedEvaluationToken, idempotencyKey });
  }
  bankRuleRejectSuggestion(token, transactionId, idempotencyKey) { return this._call({ action: 'bank_rule_reject_suggestion', token, transactionId, idempotencyKey }); }
  bankRuleIgnore(token, transactionId, idempotencyKey) { return this._call({ action: 'bank_rule_ignore', token, transactionId, idempotencyKey }); }
  bankRuleManual(token, transactionId, idempotencyKey) { return this._call({ action: 'bank_rule_manual', token, transactionId, idempotencyKey }); }
  bankRuleReevaluate(token, transactionId, idempotencyKey) { return this._call({ action: 'bank_rule_reevaluate', token, transactionId, idempotencyKey }); }
  bankRuleJournal(token, limit = 50, cursor = '') { return this._call({ action: 'bank_rule_journal', token, limit, cursor }); }
  bankRuleCorrect(token, applicationId, patch, idempotencyKey) { return this._call({ action: 'bank_rule_correct', token, applicationId, patch, idempotencyKey }); }
  bankRuleReverse(token, applicationId, idempotencyKey) { return this._call({ action: 'bank_rule_reverse', token, applicationId, idempotencyKey }); }
  allocateEventFinance(token, item) { return this._call({ action: 'allocate_event_finance', token, item }); }
  closeEventSettlement(token, id) { return this._call({ action: 'close_event_settlement', token, id }); }
  backup(token) { return this._call({ action: 'backup', token }); }
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
