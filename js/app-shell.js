// Описание оболочки приложения: группы меню, подписи страниц и мобильные приоритеты.
// Здесь нет данных и прав — доступные пункты по-прежнему формирует app.js.
export const NAV_GROUPS = [
  { id: 'overview', label: 'Обзор' },
  { id: 'work', label: 'Работа' },
  { id: 'operations', label: 'Операции' },
  { id: 'management', label: 'Управление' },
];

export const PAGE_META = {
  dashboard: { group: 'Обзор', subtitle: 'Главное по выбранному бизнесу' },
  tasks: { group: 'Работа', subtitle: 'Планы, сроки и обсуждения команды' },
  clients: { group: 'Продажи', subtitle: 'Клиенты, статусы и история работы' },
  venues: { group: 'Ресурсы', subtitle: 'Площадки, расписание и занятость' },
  players: { group: 'События', subtitle: 'База игроков и история участия' },
  finance: { group: 'Финансы', subtitle: 'Операции, остатки и взаиморасчёты' },
  money: { group: 'Финансы', subtitle: 'Личные выплаты и рабочие траты' },
  team: { group: 'Управление', subtitle: 'Сотрудники, роли и доступы' },
  settings: { group: 'Система', subtitle: 'Настройки приложения и бизнеса' },
};

export const NAV_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 11 2 2 4-4m-3-6a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z"/></svg>',
  clients: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m-2-11.96a4 4 0 0 1 0 7.75"/></svg>',
  venues: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Zm-8 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>',
  players: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6c3.5 1.3 5.5 3.3 6.4 6.4.9 3.1 2.9 5.1 6.4 6.4M18.4 5.6c-3.5 1.3-5.5 3.3-6.4 6.4-.9 3.1-2.9 5.1-6.4 6.4"/></svg>',
  finance: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v12H3V7Zm3-3h12M7 13h4m6 0h.01"/></svg>',
  money: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v12H3V7Zm3-3h12M7 13h4m6 0h.01"/></svg>',
  team: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m7.5-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 11l2 2 4-4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.54 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.54a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.46 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.37.35.7.65.96.3.26.68.4 1.08.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>',
};

export function groupNavItems(items) {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length);
}

export function pickBottomNavItems(items, isAdmin) {
  const routes = new Set(items.map((item) => item.r));
  const businessRoute = ['clients', 'venues', 'players'].find((route) => routes.has(route));
  const wanted = ['dashboard', 'tasks', isAdmin ? 'finance' : 'money', businessRoute, 'settings'].filter(Boolean);
  return wanted.map((route) => items.find((item) => item.r === route)).filter(Boolean);
}

export function pageMeta(route) {
  return PAGE_META[route] || { group: 'Монетки', subtitle: 'Рабочее пространство бизнеса' };
}
