// ============ Монетки: приложение ============
import { makeStore, UNITS, BUSINESS_MODULES, CLIENT_STATUSES, TASK_STATUSES, FIN_METHODS, FIN_CATEGORIES, OWNERS, ownerBalances, canUseExpenses, ownerLabel, businessIdOf, uid } from './store.js';
import { $, closeModal, esc, fmtDate, fmtDT, money, openModal, telHref, toast, today } from './ui.js';
import { businessIdFromName, createAppState, createCrudHelpers } from './app-state.js';
import { CRM_TABS, EVENT_TABS, crmTabFromHash, eventIdFromHash, eventTabFromHash, eventViewFromHash, groupNavItems, NAV_ICONS, pageMeta, pickBottomNavItems } from './app-shell.js';
import { eventEconomy } from './event-rules.js';
import { normalizeBankText, normalizeInn, normalizePhone } from './bank-rules.js';

// ---------- Состояние ----------
const S = createAppState(makeStore());

function isAdmin() { return S.profile && S.profile.role === 'admin'; }
function canManageEvent(event) { return isAdmin() || event?.responsibleId === S.profile?.id; }
function allBusinesses() { return S.data?.businesses || []; }
function businesses() { return allBusinesses().filter((b) => b.active !== false); }
function business(id) { return allBusinesses().find((b) => b.id === id) || UNITS[id] || { id, name: id, emoji: '🏢', modules: [] }; }
function businessName(id) { return business(id).name || id; }
function businessEmoji(id) { return business(id).emoji || '🏢'; }
function businessHasModule(item, moduleId) {
  if (moduleId === 'events') return Array.isArray(item?.modules) && item.modules.includes(moduleId);
  return !Array.isArray(item?.modules) || item.modules.includes(moduleId);
}
function myUnits() {
  if (!S.profile) return [];
  const ids = businesses().map((b) => b.id);
  if (ids.length) return ids;
  if (S.profile.businessIds?.length) return S.profile.businessIds;
  return (isAdmin() || S.profile.unit === 'all') ? ['padel', 'dev'] : [S.profile.unit];
}
function activeUnits() {
  if (S.unit === 'all') return myUnits();
  return myUnits().includes(S.unit) ? [S.unit] : myUnits();
}
function hasModule(moduleId) {
  return activeUnits().some((id) => businessHasModule(business(id), moduleId));
}
function moduleBusinessId(moduleId, item) {
  const current = businessIdOf(item);
  if (current) return current;
  if (S.unit !== 'all' && businessHasModule(business(S.unit), moduleId)) return S.unit;
  return myUnits().find((id) => businessHasModule(business(id), moduleId)) || myUnits()[0] || '';
}
function inActiveBusiness(item) {
  return activeUnits().includes(businessIdOf(item));
}
function empName(id) {
  const e = (S.data?.employees || []).find((x) => x.id === id);
  return e ? e.name : '—';
}
function employeeBusinessIds(employee) {
  const memberships = (S.data?.memberships || []).filter((m) => m.employeeId === employee.id && m.active !== false).map(businessIdOf);
  if (memberships.length) return memberships;
  if (employee.role === 'admin' || employee.unit === 'all') return myUnits();
  return employee.unit ? [employee.unit] : [];
}

// ---------- Данные ----------
async function refresh(silent = false) {
  if (!S.token) return;
  if (!silent) S.loading = true;
  const res = await S.store.bootstrap(S.token);
  S.loading = false;
  if (!res.ok) {
    if (res.error === 'auth') { logout(); return; }
    if (!silent) toast(res.error || 'Ошибка загрузки', true);
    return;
  }
  const prevUnread = (S.data?.notifications || []).filter((n) => !n.read).map((n) => n.id);
  S.profile = res.profile;
  S.data = res.data;
  if (!myUnits().includes(S.unit) && S.unit !== 'all') S.unit = myUnits()[0] || 'padel';
  maybeSystemNotify(prevUnread);
  render();
}

function maybeSystemNotify(prevUnreadIds) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const fresh = (S.data?.notifications || []).filter((n) => !n.read && !prevUnreadIds.includes(n.id));
  fresh.slice(0, 3).forEach((n) => {
    try {
      navigator.serviceWorker?.ready.then((reg) =>
        reg.showNotification('Монетки', { body: n.text, icon: 'icons/icon-192.png', tag: n.id, data: { hash: n.link || '#/dashboard' } })
      );
    } catch { /* не критично */ }
  });
}

// Быстрые изменения: применяем к данным на экране сразу, не дожидаясь полной
// перезагрузки базы (сверка с сервером происходит фоновым refresh'ем).
const { doCreate, doUpdate, doDelete } = createCrudHelpers(S, { toast, render, refresh });

function logout() {
  S.token = ''; S.profile = null; S.data = null;
  localStorage.removeItem('monetki_token');
  location.hash = '#/login';
  render();
}

// ---------- Роутер ----------
const routes = ['dashboard', 'tasks', 'clients', 'events', 'venues', 'players', 'stock', 'finance', 'money', 'team', 'settings', 'login'];
function currentRoute() {
  const r = (location.hash || '').replace('#/', '').split('?')[0];
  return routes.includes(r) ? r : 'dashboard';
}
window.addEventListener('hashchange', render);

// ---------- Навигация ----------
function navItems() {
  const items = [];
  const item = (r, label, group, badge = '') => ({ r, label, group, badge, ico: NAV_ICONS[r] || '📦' });
  if (hasModule('dashboard')) items.push(item('dashboard', 'Дашборд', 'overview'));
  if (hasModule('tasks')) items.push(item('tasks', 'Задачи', 'work', (S.data?.tasks || []).filter((t) => t.assigneeId === S.profile.id && t.status !== 'done').length || ''));
  if (!isAdmin() && hasModule('money')) items.push(item('money', 'Мои деньги', 'management'));
  if (hasModule('clients')) items.push(item('clients', 'CRM продаж', 'work'));
  if (hasModule('events')) items.push(item('events', 'События', 'operations'));
  if (hasModule('venues') || hasModule('players')) {
    if (hasModule('venues')) {
    items.push(item('venues', 'Площадки', 'operations'));
    }
    if (hasModule('players')) {
    items.push(item('players', 'Игроки', 'operations'));
    }
  }
  if (hasModule('stock')) items.push(item('stock', 'Склад', 'operations'));
  if (isAdmin()) {
    if (hasModule('finance')) items.push(item('finance', 'Финансы', 'management'));
    if (hasModule('team')) items.push(item('team', 'Команда', 'management'));
  }
  items.push(item('settings', 'Ещё', 'system'));
  return items;
}

function unreadCount() { return (S.data?.notifications || []).filter((n) => !n.read).length; }

// ---------- Рендер ----------
function render() {
  const app = $('#app');
  if (!S.token || !S.profile) { renderLogin(app); return; }
  const items = navItems();
  const requestedRoute = currentRoute() === 'login' ? 'dashboard' : currentRoute();
  const route = items.some((i) => i.r === requestedRoute) ? requestedRoute : (items[0]?.r || 'settings');
  S.route = route;
  if (requestedRoute !== route) history.replaceState(null, '', `#/${route}`);
  const navButton = (i) => `
    <button class="nav-item ${route === i.r ? 'active' : ''}" data-nav="${i.r}" ${route === i.r ? 'aria-current="page"' : ''}>
      <span class="ico">${i.ico}</span><span>${i.label}</span>
      ${i.badge ? `<span class="badge red">${i.badge}</span>` : ''}
    </button>`;
  const nav = groupNavItems(items.filter((i) => i.r !== 'settings')).map((group) => `
    <section class="nav-group" aria-label="${group.label}">
      <div class="nav-group-label">${group.label}</div>
      ${group.items.map(navButton).join('')}
    </section>`).join('');
  const settingsItem = items.find((i) => i.r === 'settings');
  // Нижняя навигация (телефон): главное всегда под рукой — админу Финансы, сотруднику Деньги
  const bottomItems = pickBottomNavItems(items, isAdmin());
  const bottomHasRoute = bottomItems.some((i) => i.r === route);
  const bottomNav = bottomItems.map((i) => {
    const current = route === i.r;
    const active = current || (!bottomHasRoute && i.r === 'settings');
    return `<button class="${active ? 'active' : ''}" data-nav="${i.r}" ${current ? 'aria-current="page"' : ''}><span class="ico">${i.ico}</span><span>${i.label}</span></button>`;
  }).join('');

  const showUnitSwitch = myUnits().length > 1;
  const unitSwitch = showUnitSwitch ? `
    <div class="unit-switch business-switch" role="group" aria-label="Выбор бизнеса">
      ${myUnits().map((u) => `<button class="${S.unit === u ? 'active' : ''}" data-unit="${u}" aria-pressed="${S.unit === u}">${esc(businessEmoji(u))} ${esc(businessName(u))}</button>`).join('')}
      <button class="${S.unit === 'all' ? 'active' : ''}" data-unit="all" aria-pressed="${S.unit === 'all'}">Все бизнесы</button>
    </div>` : `<div class="business-single"><span>${esc(businessEmoji(myUnits()[0]))}</span>${esc(businessName(myUnits()[0]))}</div>`;

  const unread = unreadCount();
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo">М</div><div><div class="name">Монетки</div><div class="sub">${S.store.demo ? 'демо-режим' : 'общая база'}</div></div></div>
        <div class="business-context">
          <div class="business-label">Текущий бизнес</div>
          ${unitSwitch}
        </div>
        <div class="nav-scroll">${nav}</div>
        <div class="sidebar-settings">${navButton(settingsItem)}</div>
        <div class="whoami"><span class="avatar">${esc(S.profile.name).slice(0, 1).toUpperCase()}</span><span><b>${esc(S.profile.name)}</b>${isAdmin() ? 'администратор' : esc(myUnits().map(businessName).join(', '))}</span></div>
      </aside>
      <main class="main">
        <div class="mobile-topbar">
          <div class="mobile-brand"><span class="logo">М</span><b>Монетки</b></div>
          <button class="btn ghost bell" id="bell-mobile" title="Уведомления" aria-label="Уведомления">🔔${unread ? `<span class="count">${unread}</span>` : ''}</button>
        </div>
        <div class="mobile-business">${unitSwitch}</div>
        <header class="page-header">
          <div class="page-heading">
            <div class="page-eyebrow" id="page-eyebrow"></div>
            <h1 id="page-title"></h1>
            <p id="page-subtitle"></p>
          </div>
          <button class="btn ghost bell desktop-bell" id="bell" title="Уведомления" aria-label="Уведомления">🔔${unread ? `<span class="count">${unread}</span>` : ''}</button>
        </header>
        ${S.store.demo ? `<div class="banner warn">🧪 Демо-режим: данные хранятся только в этом браузере. Подключение общей базы — в «Ещё».</div>` : ''}
        <div id="view"></div>
      </main>
    </div>
    <nav class="bottomnav">${bottomNav}</nav>
  `;

  app.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.nav; }));
  app.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    S.unit = b.dataset.unit; localStorage.setItem('monetki_unit', S.unit); render();
  }));
  $('#bell').addEventListener('click', showNotifications);
  $('#bell-mobile').addEventListener('click', showNotifications);

  const views = { dashboard: viewDashboard, tasks: viewTasks, clients: viewClients, events: viewEvents, venues: viewVenues, players: viewPlayers, stock: viewStock, finance: viewFinance, money: viewMoney, team: viewTeam, settings: viewSettings };
  (views[route] || viewDashboard)();
}

function setTitle(t) {
  const meta = pageMeta(S.route || currentRoute());
  $('#page-title').textContent = t;
  $('#page-eyebrow').textContent = meta.group;
  $('#page-subtitle').textContent = meta.subtitle;
  document.title = `${t} — Монетки`;
}

// ---------- Логин ----------
function renderLogin(app) {
  const demo = S.store.demo;
  document.title = 'Вход — Монетки';
  app.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <div class="logo">М</div>
        <h1>Монетки</h1>
        <p class="sub">клиенты · задачи · финансы</p>
        <form id="login-form">
          <label class="field"><input type="password" id="code" inputmode="numeric" autocomplete="current-password" placeholder="Код доступа" required></label>
          <button class="btn primary" style="width:100%" type="submit">Войти</button>
        </form>
        ${demo ? `
        <div class="demo-note">
          Демо-режим (общая база ещё не подключена).<br>
          Коды для входа: <b class="mono">111111</b> — админ,<br>
          <b class="mono">222222</b> — сотрудник падела, <b class="mono">333333</b> — разработка.
        </div>` : ''}
      </div>
    </div>`;
  // Пустая база (свежий переезд)? Предлагаем загрузить резервную копию
  S.store.status?.().then((st) => {
    if (!(st?.ok && st.empty)) return;
    const el = document.createElement('div');
    el.className = 'demo-note';
    el.innerHTML = `База новая и пустая. Переезжаете со старой? Загрузите резервную копию:<br><br>
      <input type="file" id="restore-file" accept="application/json,.json" style="display:none">
      <button class="btn" id="restore-btn">📦 Загрузить копию</button>`;
    $('.login-card').appendChild(el);
    $('#restore-btn').addEventListener('click', () => $('#restore-file').click());
    $('#restore-file').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        toast('Загружаю…');
        const res = await S.store.migrateImport('', data);
        if (!res.ok) { toast(res.error || 'Ошибка', true); return; }
        toast(`Готово! Записей загружено: ${res.imported}. Войдите со своим кодом.`);
        el.remove();
      } catch {
        toast('Не удалось прочитать файл', true);
      }
    });
  }).catch(() => {});

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#code').value;
    const res = await S.store.login(code);
    if (!res.ok) { toast(res.error || 'Не удалось войти', true); return; }
    S.token = res.token; S.profile = res.profile;
    localStorage.setItem('monetki_token', S.token);
    if (!myUnits().includes(S.unit) && S.unit !== 'all') S.unit = myUnits()[0];
    location.hash = '#/dashboard';
    askNotifPermission();
    await refresh();
  });
}

function askNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission().catch(() => {}), 1500);
  }
}

// ---------- Дашборд ----------
function viewDashboard() {
  setTitle('Дашборд');
  const units = activeUnits();
  const tasks = (S.data.tasks || []).filter((t) => units.includes(businessIdOf(t)));
  const mine = tasks.filter((t) => t.assigneeId === S.profile.id && t.status !== 'done');
  const overdue = mine.filter((t) => t.due && t.due < today());
  const month = today().slice(0, 7);
  const fin = (S.data.finance || []).filter((f) => units.includes(businessIdOf(f)) && (f.date || '').startsWith(month));
  const income = fin.filter((f) => f.type === 'income').reduce((s, f) => s + Number(f.amount || 0), 0);
  const expense = fin.filter((f) => f.type === 'expense').reduce((s, f) => s + Number(f.amount || 0), 0);

  let clientsStat = '';
  if (hasModule('clients')) {
    const cl = (S.data.clients || []).filter((c) => units.includes(businessIdOf(c)) && (c.status === 'work' || c.status === 'talks'));
    clientsStat = `<div class="card stat"><div class="label">Клиенты в работе</div><div class="value">${cl.length}</div><div class="hint">${esc(units.map(businessName).join(', '))}</div></div>`;
  }
  let padelStat = '';
  if (hasModule('players')) {
    const players = (S.data.players || []).filter((p) => units.includes(businessIdOf(p)));
    padelStat = `<div class="card stat"><div class="label">Игроков в базе</div><div class="value">${players.length}</div><div class="hint">${esc(units.map(businessName).join(', '))}</div></div>`;
  }

  const staffPaid = !isAdmin() ? [...(S.data.finance || []), ...(S.data.cash || [])].filter((f) => (f.date || '').startsWith(month)).reduce((s, f) => s + Number(f.amount || 0), 0) : 0;
  const staffCard = !isAdmin() ? `<div class="card stat"><div class="label">Выплачено мне за месяц</div><div class="value green">${money(staffPaid)}</div><div class="hint">подробнее — в «Деньгах»</div></div>` : '';
  const bb = S.data.bankBalance;
  const finCards = isAdmin() ? `
    ${bb ? `<div class="card stat"><div class="label">На счёте в банке</div><div class="value">${money(bb.amount)}</div><div class="hint">обновлено ${fmtDT(new Date(bb.updated).getTime())}</div></div>` : ''}
    <div class="card stat"><div class="label">Доход за месяц</div><div class="value green">${money(income)}</div></div>
    <div class="card stat"><div class="label">Расход за месяц</div><div class="value red">${money(expense)}</div></div>
    <div class="card stat"><div class="label">Итог</div><div class="value ${income - expense >= 0 ? 'green' : 'red'}">${money(income - expense)}</div></div>` : '';

  const upcoming = mine.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 6);
  const lastOps = isAdmin() ? (S.data.finance || []).filter((f) => units.includes(businessIdOf(f))).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5) : [];

  $('#view').innerHTML = `
    <div class="cards-row">
      <div class="card stat"><div class="label">Мои задачи</div><div class="value">${mine.length}</div>${overdue.length ? `<div class="hint" style="color:var(--red)">${overdue.length} просрочено</div>` : '<div class="hint">активных</div>'}</div>
      ${clientsStat}${padelStat}${staffCard}${finCards}
    </div>
    <div class="section-title">Мои ближайшие задачи</div>
    <div class="list">
      ${upcoming.length ? upcoming.map(taskRow).join('') : `<div class="card empty"><div class="big">🎉</div>Активных задач нет</div>`}
    </div>
    ${lastOps.length ? `<div class="section-title">Последние операции</div><div class="list">${lastOps.map(finRow).join('')}</div>` : ''}
  `;
  bindTaskRows();
  bindFinRows($('#view'));
}

// ---------- Задачи ----------
function taskRow(t) {
  const st = TASK_STATUSES.find((s) => s.id === t.status) || TASK_STATUSES[0];
  const over = t.due && t.due < today() && t.status !== 'done';
  const taskBusinessId = businessIdOf(t);
  const unitTag = activeUnits().length > 1 ? `<span class="badge">${esc(businessEmoji(taskBusinessId))}</span>` : '';
  return `
    <div class="row-card ${t.status === 'done' ? 'done' : ''} ${over || t.status === 'new' ? 'overdue' : ''}" data-task="${t.id}">
      <div class="grow col">
        <div class="title">${t.priority === 'high' ? '🔥 ' : ''}${esc(t.title)}</div>
        <div class="sub">${esc(empName(t.assigneeId))}${t.due ? ' · до ' + fmtDate(t.due) : ''}${t.comments?.length ? ' · 💬 ' + t.comments.length : ''}</div>
      </div>
      ${unitTag}
      <span class="badge ${st.color} dot">${st.name}</span>
    </div>`;
}
function bindTaskRows() {
  $('#view').querySelectorAll('[data-task]').forEach((el) => el.addEventListener('click', () => openTaskForm((S.data.tasks || []).find((t) => t.id === el.dataset.task))));
}

function viewTasks() {
  setTitle('Задачи');
  const units = activeUnits();
  const f = S.taskFilter;
  // Переключатель «Мои / От меня / Все» — только у админов; сотрудник видит лишь свои задачи
  const who = isAdmin() ? f.who : 'mine';
  let tasks = (S.data.tasks || []).filter((t) => units.includes(businessIdOf(t)));
  if (who === 'mine') tasks = tasks.filter((t) => t.assigneeId === S.profile.id);
  if (who === 'from-me') tasks = tasks.filter((t) => t.authorId === S.profile.id && t.assigneeId !== S.profile.id);
  if (f.status === 'active') tasks = tasks.filter((t) => t.status !== 'done');
  if (f.status === 'done') tasks = tasks.filter((t) => t.status === 'done');
  tasks.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.due || '9999').localeCompare(b.due || '9999'));

  $('#view').innerHTML = `
    <div class="searchbar">
      <button class="btn primary" id="add-task">+ Задача</button>
    </div>
    ${isAdmin() ? `<div class="chip-row" style="margin-bottom:6px">
      ${[['mine', 'Мои'], ['from-me', 'От меня'], ['all', 'Все']].map(([k, l]) => `<button class="chip ${who === k ? 'active' : ''}" data-who="${k}">${l}</button>`).join('')}
    </div>` : ''}
    <div class="chip-row">
      ${[['active', 'Активные'], ['done', 'Выполнены'], ['any', 'Любые']].map(([k, l]) => `<button class="chip ${f.status === k ? 'active' : ''}" data-status="${k}">${l}</button>`).join('')}
    </div>
    <div class="list">${tasks.length ? tasks.map(taskRow).join('') : `<div class="card empty"><div class="big">📭</div>Задач нет</div>`}</div>`;

  $('#add-task').addEventListener('click', () => openTaskForm());
  $('#view').querySelectorAll('[data-who]').forEach((b) => b.addEventListener('click', () => { S.taskFilter.who = b.dataset.who; render(); }));
  $('#view').querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { S.taskFilter.status = b.dataset.status; render(); }));
  bindTaskRows();
}

function openTaskForm(task) {
  const isNew = !task;
  const units = activeUnits();
  const unit = businessIdOf(task) || (units.length === 1 ? units[0] : (S.unit !== 'all' ? S.unit : units[0]));
  const people = (S.data.employees || []).filter((e) => e.active !== false);
  // Права: содержимое меняет админ или автор задачи; сотрудник в чужой задаче меняет только статус
  const canEditContent = isNew || isAdmin() || task.authorId === S.profile.id;
  const isAssignee = !isNew && task.assigneeId === S.profile.id;
  const st = task ? (TASK_STATUSES.find((s) => s.id === task.status) || TASK_STATUSES[0]) : null;

  // Кнопки смены статуса для исполнителя
  let statusButtons = '';
  if (isAssignee && !isAdmin()) {
    const btn = (to, label, primary) => `<button type="button" class="btn ${primary ? 'primary' : ''}" data-setstatus="${to}">${label}</button>`;
    if (task.status === 'new') statusButtons = btn('progress', '▶ Взял в работу', true);
    else if (task.status === 'progress') statusButtons = btn('done', '✅ Выполнена', true) + btn('question', '❓ Есть вопросы');
    else if (task.status === 'question') statusButtons = btn('progress', '▶ Снова в работе') + btn('done', '✅ Выполнена', true);
  }
  if (isAssignee && isAdmin() && task.status !== 'done') {
    statusButtons = `<button type="button" class="btn primary" data-setstatus="done">✅ Выполнена</button>`;
  }

  const ro = canEditContent ? '' : 'disabled';
  openModal(`
    <h2>${isNew ? 'Новая задача' : 'Задача'} ${st ? `<span class="badge ${st.color} dot">${st.name}</span>` : ''}</h2>
    <form id="task-form">
      <label class="field"><span>Название</span><input type="text" name="title" required value="${esc(task?.title || '')}" ${ro}></label>
      <label class="field"><span>Описание</span><textarea name="desc" ${ro}>${esc(task?.desc || '')}</textarea></label>
      <div class="form-row">
        ${isAdmin() ? `<label class="field"><span>Исполнитель</span>
          <select name="assigneeId" ${ro}>${people.map((p) => `<option value="${p.id}" ${(task?.assigneeId || S.profile.id) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        </label>` : `<label class="field"><span>Исполнитель</span><input type="text" value="${esc(isNew ? 'Вы' : empName(task.assigneeId))}" disabled></label>`}
        <label class="field"><span>Срок</span><input type="date" name="due" value="${esc(task?.due || '')}" ${ro}></label>
      </div>
      <div class="form-row">
        ${canEditContent ? `<label class="field"><span>Статус</span>
          <select name="status">${TASK_STATUSES.map((s) => `<option value="${s.id}" ${(task?.status || 'new') === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
        </label>` : ''}
        <label class="field"><span>Приоритет</span>
          <select name="priority" ${ro}>${[['low', 'Низкий'], ['normal', 'Обычный'], ['high', '🔥 Высокий']].map(([k, l]) => `<option value="${k}" ${(task?.priority || 'normal') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
      </div>
      ${canEditContent && units.length > 1 ? `<label class="field"><span>Направление</span>
        <select name="unit">${units.map((u) => `<option value="${u}" ${unit === u ? 'selected' : ''}>${esc(businessName(u))}</option>`).join('')}</select></label>` : `<input type="hidden" name="unit" value="${unit}">`}
      ${!isNew ? `
        <div class="section-title" style="margin-top:8px">Обсуждение</div>
        <div class="chat">${(task.comments || []).map((c) => `<div class="msg ${c.authorId === S.profile.id ? 'mine' : ''}"><span class="who">${esc(empName(c.authorId))}</span><span class="when">${fmtDT(c.ts)}</span><div>${esc(c.text)}</div></div>`).join('') || '<div class="muted small">Пока пусто — напишите первым.</div>'}</div>
        <div class="chat-input"><input type="text" id="chat-text" placeholder="Написать сообщение…"><button type="button" class="btn" id="chat-send">➤</button></div>` : ''}
      ${statusButtons ? `<div class="actions" style="justify-content:center">${statusButtons}</div>` : ''}
      <div class="actions">
        ${!isNew && canEditContent ? `<button type="button" class="btn danger ghost left" id="task-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">${canEditContent ? 'Отмена' : 'Закрыть'}</button>
        ${canEditContent ? `<button type="submit" class="btn primary">${isNew ? 'Создать' : 'Сохранить'}</button>` : ''}
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#task-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!canEditContent) return;
      const fd = new FormData(e.target);
      const item = Object.fromEntries(fd.entries());
      item.businessId = item.unit;
      if (!isAdmin()) item.assigneeId = S.profile.id;
      closeModal();
      if (isNew) await doCreate('tasks', { ...item, authorId: S.profile.id, comments: [] }, 'Задача создана');
      else await doUpdate('tasks', { ...task, ...item }, 'Сохранено');
    });
    root.querySelectorAll('[data-setstatus]').forEach((b) => b.addEventListener('click', async () => {
      closeModal();
      const to = b.dataset.setstatus;
      const msg = { progress: 'Взято в работу', done: 'Отличная работа! ✓', question: 'Отмечено: есть вопросы — напишите их в обсуждении задачи' }[to];
      await doUpdate('tasks', { ...task, status: to }, msg);
    }));
    $('#task-del', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить задачу?')) return;
      closeModal();
      await doDelete('tasks', task.id, 'Удалено');
    });
    $('#chat-send', root)?.addEventListener('click', async () => {
      const text = $('#chat-text', root).value.trim();
      if (!text) return;
      const res = await S.store.addComment(S.token, task.id, text);
      if (!res.ok) { toast(res.error || 'Ошибка', true); return; }
      applyLocal('tasks', 'update', res.item);
      closeModal();
      openTaskForm(res.item);
    });
  });
}

// ---------- CRM продаж ----------
const CRM_COMPANY_STATUSES = [
  ['lead', 'Лид'], ['talks', 'Переговоры'], ['work', 'В работе'],
  ['support', 'На обслуживании'], ['refused', 'Отказ'], ['former', 'Бывший'],
];
const CRM_LEAD_STATUSES = [
  ['new', 'Новый'], ['working', 'В работе'], ['qualified', 'Квалифицирован'], ['refused', 'Отказ'],
];

function crmRecords(entity) {
  return (S.data?.[entity] || []).filter(inActiveBusiness);
}

function crmBusinessId(item) {
  return moduleBusinessId('clients', item);
}

function crmScope(item) {
  const id = crmBusinessId(item);
  return { businessId: id, unit: id };
}

function crmEmployees(item) {
  const id = crmBusinessId(item);
  return (S.data?.employees || []).filter((employee) => employee.active !== false && employeeBusinessIds(employee).includes(id));
}

function crmEmployeeOptions(selectedId, item) {
  return `<option value="">— не назначен —</option>${crmEmployees(item).map((employee) =>
    `<option value="${employee.id}" ${employee.id === selectedId ? 'selected' : ''}>${esc(employee.name)}</option>`).join('')}`;
}

function crmEmpty(icon, title, text, action = '') {
  return `<div class="card empty crm-empty"><div class="big">${icon}</div><strong>${esc(title)}</strong><span>${esc(text)}</span>${action}</div>`;
}

function crmTabNav(active) {
  return `<nav class="crm-tabs" aria-label="Разделы CRM">${CRM_TABS.map((tab) =>
    `<button class="crm-tab ${tab.id === active ? 'active' : ''}" data-crm-tab="${tab.id}" ${tab.id === active ? 'aria-current="page"' : ''}>${tab.label}</button>`).join('')}</nav>`;
}

function viewClients() {
  setTitle('CRM продаж');
  const active = crmTabFromHash(location.hash);
  const contents = {
    deals: crmDealsHtml,
    companies: crmCompaniesHtml,
    contacts: crmContactsHtml,
    leads: crmLeadsHtml,
  };
  $('#view').innerHTML = `${crmTabNav(active)}<section class="crm-view" data-crm-view="${active}">${contents[active]()}</section>`;
  $('#view').querySelectorAll('[data-crm-tab]').forEach((button) => button.addEventListener('click', () => {
    location.hash = `#/clients?tab=${button.dataset.crmTab}`;
  }));
  bindCrmView(active);
}

function bindCrmView(active) {
  if (active === 'deals') bindCrmDeals();
  if (active === 'companies') bindCrmCompanies();
  if (active === 'contacts') bindCrmContacts();
  if (active === 'leads') bindCrmLeads();
}

function crmDealsHtml() {
  const pipelines = crmRecords('pipelines').filter((pipeline) => pipeline.active !== false);
  if (!pipelines.some((pipeline) => pipeline.id === S.crmPipelineId)) {
    S.crmPipelineId = pipelines.find((pipeline) => pipeline.isDefault)?.id || pipelines[0]?.id || '';
  }
  const pipeline = pipelines.find((item) => item.id === S.crmPipelineId);
  const stages = crmRecords('stages').filter((stage) => stage.pipelineId === pipeline?.id).sort((a, b) => Number(a.order) - Number(b.order));
  const deals = crmRecords('deals').filter((deal) => deal.pipelineId === pipeline?.id);
  const items = crmRecords('dealItems');
  const dealAmount = (deal) => Number(deal.amount) || items.filter((item) => item.dealId === deal.id).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return `
    <div class="crm-toolbar">
      <label class="crm-pipeline-pick"><span>Воронка</span><select id="crm-pipeline">${pipelines.map((entry) => `<option value="${entry.id}" ${entry.id === pipeline?.id ? 'selected' : ''}>${esc(entry.name)}</option>`).join('')}</select></label>
      <button class="btn" id="crm-pipeline-settings">⚙ Настроить</button>
      <button class="btn primary" id="add-deal" ${stages.length ? '' : 'disabled'}>+ Сделка</button>
    </div>
    ${!pipeline ? crmEmpty('🪜', 'Воронок пока нет', 'Создайте первую воронку и её стадии.', '<button class="btn primary" id="crm-create-pipeline">Создать воронку</button>') : !stages.length
      ? crmEmpty('🧩', 'Добавьте стадии', 'Без стадий сделки некуда помещать.', '<button class="btn primary" id="crm-create-stage">Добавить стадию</button>')
      : `<div class="crm-kanban" aria-label="Воронка сделок">${stages.map((stage) => {
          const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
          return `<section class="crm-column stage-${esc(stage.type || 'open')}" data-drop-stage="${stage.id}">
            <header><span>${esc(stage.name)}</span><b>${stageDeals.length}</b></header>
            <div class="crm-column-total">${money(stageDeals.reduce((sum, deal) => sum + dealAmount(deal), 0))}</div>
            <div class="crm-deal-list">${stageDeals.length ? stageDeals.map((deal) => {
              const company = crmRecords('companies').find((entry) => entry.id === deal.companyId);
              return `<article class="crm-deal-card" draggable="true" tabindex="0" data-deal="${deal.id}">
                <strong>${esc(deal.name)}</strong>
                <span>${esc(company?.name || 'Без компании')}</span>
                <b>${money(dealAmount(deal))}</b>
                ${deal.responsibleId ? `<small>👤 ${esc(empName(deal.responsibleId))}</small>` : ''}
                <label><span class="sr-only">Стадия сделки</span><select data-deal-stage="${deal.id}">${stages.map((option) => `<option value="${option.id}" ${option.id === deal.stageId ? 'selected' : ''}>${esc(option.name)}</option>`).join('')}</select></label>
              </article>`;
            }).join('') : '<div class="crm-column-empty">Перетащите сделку сюда</div>'}</div>
          </section>`;
        }).join('')}</div>`}`;
}

function bindCrmDeals() {
  $('#crm-pipeline')?.addEventListener('change', (event) => { S.crmPipelineId = event.target.value; viewClients(); });
  $('#crm-pipeline-settings')?.addEventListener('click', openPipelineManager);
  $('#crm-create-pipeline')?.addEventListener('click', () => openPipelineForm());
  $('#crm-create-stage')?.addEventListener('click', () => openStageForm(null, crmRecords('pipelines').find((pipeline) => pipeline.id === S.crmPipelineId)));
  $('#add-deal')?.addEventListener('click', () => openDealForm());
  $('#view').querySelectorAll('[data-deal]').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('select')) return;
      openDealForm(crmRecords('deals').find((deal) => deal.id === card.dataset.deal));
    });
    card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', card.dataset.deal));
  });
  $('#view').querySelectorAll('[data-deal-stage]').forEach((select) => select.addEventListener('change', async () => {
    const deal = crmRecords('deals').find((entry) => entry.id === select.dataset.dealStage);
    if (deal) {
      const nextStageId = select.value;
      select.value = deal.stageId;
      await moveDealToStage(deal, nextStageId);
    }
  }));
  $('#view').querySelectorAll('[data-drop-stage]').forEach((column) => {
    column.addEventListener('dragover', (event) => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const deal = crmRecords('deals').find((entry) => entry.id === event.dataTransfer.getData('text/plain'));
      if (deal && deal.stageId !== column.dataset.dropStage) await moveDealToStage(deal, column.dataset.dropStage);
    });
  });
}

async function moveDealToStage(deal, stageId) {
  const stage = crmRecords('stages').find((entry) => entry.id === stageId);
  if (!stage || stageId === deal.stageId) return;
  if (stage.type === 'lost' && !deal.lostReason) {
    openLostReasonForm(deal, stage);
    return;
  }
  const closing = stage.type === 'won' || stage.type === 'lost';
  await doUpdate('deals', { ...deal, stageId, ...(closing && !deal.closedAt ? { closedAt: today() } : {}) }, 'Стадия изменена');
}

function openLostReasonForm(deal, stage) {
  openModal(`<h2>Причина отказа</h2><p class="muted small">Чтобы перенести «${esc(deal.name)}» в стадию «${esc(stage.name)}», укажите причину.</p><form id="lost-reason-form"><label class="field"><span>Почему сделка не состоялась</span><textarea name="lostReason" required autofocus>${esc(deal.lostReason || '')}</textarea></label><div class="actions"><button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary">Перенести</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', () => { closeModal(); viewClients(); });
    $('#lost-reason-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const lostReason = event.target.elements.lostReason.value.trim();
      if (!lostReason) return;
      closeModal();
      await doUpdate('deals', { ...deal, stageId: stage.id, lostReason, closedAt: deal.closedAt || today() }, 'Сделка закрыта с отказом');
    });
  });
}

function crmCompaniesHtml() {
  const companies = crmRecords('companies');
  const syntheticIds = new Set(companies.map((company) => company.legacyClientId).filter(Boolean));
  const oldClients = (S.data?.clients || []).filter(inActiveBusiness).filter((client) => !syntheticIds.has(client.id));
  const q = String(S.search.companies || '').toLowerCase();
  const list = companies.filter((company) => !q || `${company.name} ${company.legalName || ''} ${company.inn || ''}`.toLowerCase().includes(q));
  return `
    <div class="searchbar"><input type="search" id="company-search" placeholder="Название, юрлицо или ИНН" value="${esc(S.search.companies || '')}"><button class="btn primary" id="add-company">+ Компания</button></div>
    <div class="list">${list.length ? list.map((company) => `<div class="row-card ${company.legacy ? 'legacy-row' : ''}" data-company="${company.id}">
      <div class="grow col"><div class="title">${esc(company.name)}</div><div class="sub">${esc(company.legalName || company.inn || 'Реквизиты не заполнены')}</div></div>
      ${company.legacy ? '<span class="badge">Старая карточка</span>' : `<span class="badge">${esc(CRM_COMPANY_STATUSES.find(([id]) => id === company.status)?.[1] || 'Без статуса')}</span>`}
    </div>`).join('') : crmEmpty('🏢', 'Компаний пока нет', 'Добавьте первую компанию, чтобы связать её со сделкой.')}</div>
    ${oldClients.length ? `<section class="crm-legacy"><h3>Переходные клиенты</h3><p>Старые карточки сохранены только для чтения. Их можно перенести в новую CRM позже.</p><div class="list">${oldClients.map((client) => `<div class="row-card legacy-row" data-legacy-client="${client.id}"><div class="grow col"><div class="title">${esc(client.name)}</div><div class="sub">${esc(client.company || client.phone || 'Старая карточка клиента')}</div></div><span class="badge">Старая карточка</span></div>`).join('')}</div></section>` : ''}`;
}

function bindCrmCompanies() {
  $('#add-company')?.addEventListener('click', () => openCompanyForm());
  $('#company-search')?.addEventListener('input', (event) => { S.search.companies = event.target.value; viewClients(); });
  $('#view').querySelectorAll('[data-company]').forEach((row) => row.addEventListener('click', () => {
    const company = crmRecords('companies').find((item) => item.id === row.dataset.company);
    if (company?.legacy) openLegacyClient((S.data?.clients || []).find((client) => client.id === company.legacyClientId) || company);
    else openCompanyForm(company);
  }));
  $('#view').querySelectorAll('[data-legacy-client]').forEach((row) => row.addEventListener('click', () => openLegacyClient((S.data?.clients || []).find((client) => client.id === row.dataset.legacyClient))));
}

function crmContactsHtml() {
  const q = String(S.search.contacts || '').toLowerCase();
  const companies = crmRecords('companies');
  const contacts = crmRecords('contacts').filter((contact) => !q || `${contact.name} ${contact.phone || ''} ${contact.email || ''}`.toLowerCase().includes(q));
  return `<div class="searchbar"><input type="search" id="contact-search" placeholder="Имя, телефон или почта" value="${esc(S.search.contacts || '')}"><button class="btn primary" id="add-contact">+ Контакт</button></div>
    <div class="list">${contacts.length ? contacts.map((contact) => {
      const company = companies.find((item) => item.id === contact.companyId);
      return `<div class="row-card" data-contact="${contact.id}"><div class="grow col"><div class="title">${esc(contact.name)}${contact.isPrimary ? ' <span class="badge green">Основной</span>' : ''}</div><div class="sub">${esc([contact.position, company?.name, contact.phone || contact.email].filter(Boolean).join(' · ') || 'Контактные данные не заполнены')}</div></div></div>`;
    }).join('') : crmEmpty('👤', 'Контактов пока нет', 'Контакт можно связать с компанией и сделкой.')}</div>`;
}

function bindCrmContacts() {
  $('#add-contact')?.addEventListener('click', () => openContactForm());
  $('#contact-search')?.addEventListener('input', (event) => { S.search.contacts = event.target.value; viewClients(); });
  $('#view').querySelectorAll('[data-contact]').forEach((row) => row.addEventListener('click', () => openContactForm(crmRecords('contacts').find((contact) => contact.id === row.dataset.contact))));
}

function crmLeadsHtml() {
  const active = S.leadStatus || 'all';
  const leads = crmRecords('leads').filter((lead) => active === 'all' || lead.status === active);
  return `<div class="crm-toolbar"><div class="chip-row grow"><button class="chip ${active === 'all' ? 'active' : ''}" data-lead-status="all">Все · ${crmRecords('leads').length}</button>${CRM_LEAD_STATUSES.map(([id, name]) => `<button class="chip ${active === id ? 'active' : ''}" data-lead-status="${id}">${name}</button>`).join('')}</div><button class="btn primary" id="add-lead">+ Лид</button></div>
    <div class="list">${leads.length ? leads.map((lead) => `<div class="row-card" data-lead="${lead.id}"><div class="grow col"><div class="title">${esc(lead.name)}</div><div class="sub">${esc([lead.source, lead.phone || lead.email, lead.responsibleId ? empName(lead.responsibleId) : ''].filter(Boolean).join(' · '))}</div></div><span class="badge">${esc(CRM_LEAD_STATUSES.find(([id]) => id === lead.status)?.[1] || 'Новый')}</span></div>`).join('') : crmEmpty('📥', active === 'all' ? 'Лидов пока нет' : 'В этом статусе лидов нет', 'Новая заявка или звонок появятся здесь.')}</div>`;
}

function bindCrmLeads() {
  $('#add-lead')?.addEventListener('click', () => openLeadForm());
  $('#view').querySelectorAll('[data-lead-status]').forEach((button) => button.addEventListener('click', () => { S.leadStatus = button.dataset.leadStatus; viewClients(); }));
  $('#view').querySelectorAll('[data-lead]').forEach((row) => row.addEventListener('click', () => openLeadForm(crmRecords('leads').find((lead) => lead.id === row.dataset.lead))));
}

function openCompanyForm(company) {
  if (company?.legacy) { openLegacyClient(company); return; }
  const isNew = !company;
  const selected = new Set(company?.responsibleIds || []);
  openModal(`<h2>${isNew ? 'Новая компания' : esc(company.name)}</h2><form id="company-form">
    <label class="field"><span>Название</span><input name="name" required value="${esc(company?.name || '')}"></label>
    <div class="form-row"><label class="field"><span>Юридическое название</span><input name="legalName" value="${esc(company?.legalName || '')}"></label><label class="field"><span>ИНН</span><input name="inn" inputmode="numeric" value="${esc(company?.inn || '')}"></label></div>
    <label class="field"><span>Адрес</span><input name="address" value="${esc(company?.address || '')}"></label>
    <label class="field"><span>Статус клиента</span><select name="status">${CRM_COMPANY_STATUSES.map(([id, name]) => `<option value="${id}" ${(company?.status || 'lead') === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <fieldset class="crm-fieldset"><legend>Ответственные</legend>${crmEmployees(company).map((employee) => `<label class="checkline"><input type="checkbox" name="responsibleIds" value="${employee.id}" ${selected.has(employee.id) ? 'checked' : ''}> ${esc(employee.name)}</label>`).join('') || '<span class="muted small">Нет доступных сотрудников</span>'}</fieldset>
    <label class="field"><span>Заметки</span><textarea name="notes">${esc(company?.notes || '')}</textarea></label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="company-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#company-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      data.responsibleIds = [...event.target.querySelectorAll('[name="responsibleIds"]:checked')].map((input) => input.value);
      closeModal();
      if (company) await doUpdate('companies', { ...company, ...data }, 'Компания сохранена');
      else await doCreate('companies', { ...data, ...crmScope(company) }, 'Компания добавлена');
    });
    $('#company-delete', root)?.addEventListener('click', async () => {
      const linked = crmRecords('deals').some((deal) => deal.companyId === company.id) || crmRecords('contacts').some((contact) => contact.companyId === company.id);
      if (linked) { toast('Сначала уберите компанию из связанных сделок и контактов', true); return; }
      if (confirm('Удалить компанию?')) { closeModal(); await doDelete('companies', company.id, 'Компания удалена'); }
    });
  });
}

function openContactForm(contact) {
  const isNew = !contact;
  const companies = crmRecords('companies').filter((company) => !company.legacy);
  openModal(`<h2>${isNew ? 'Новый контакт' : esc(contact.name)}</h2><form id="ent-form">
    <label class="field"><span>ФИО</span><input name="name" required value="${esc(contact?.name || '')}"></label>
    <div class="form-row"><label class="field"><span>Компания</span><select name="companyId"><option value="">— без компании —</option>${companies.map((company) => `<option value="${company.id}" ${contact?.companyId === company.id ? 'selected' : ''}>${esc(company.name)}</option>`).join('')}</select></label><label class="field"><span>Должность</span><input name="position" value="${esc(contact?.position || '')}"></label></div>
    <div class="form-row"><label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(contact?.phone || '')}"></label><label class="field"><span>Почта</span><input type="email" name="email" value="${esc(contact?.email || '')}"></label></div>
    <label class="field"><span>Мессенджер</span><input name="messenger" value="${esc(contact?.messenger || '')}"></label>
    <label class="checkline"><input type="checkbox" name="isPrimary" value="true" ${contact?.isPrimary ? 'checked' : ''}> Основной контакт</label>
    <label class="field"><span>Комментарий</span><textarea name="notes">${esc(contact?.notes || '')}</textarea></label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>' : ''}${contact?.phone ? `<a class="btn" href="${telHref(contact.phone)}">Позвонить</a>` : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#ent-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      data.isPrimary = event.target.elements.isPrimary.checked;
      closeModal();
      if (contact) await doUpdate('contacts', { ...contact, ...data }, 'Контакт сохранён');
      else await doCreate('contacts', { ...data, ...crmScope(contact) }, 'Контакт добавлен');
    });
    $('#ent-del', root)?.addEventListener('click', async () => { if (confirm('Удалить контакт?')) { closeModal(); await doDelete('contacts', contact.id, 'Контакт удалён'); } });
  });
}

function openLeadForm(lead) {
  const isNew = !lead;
  openModal(`<h2>${isNew ? 'Новый лид' : esc(lead.name)}</h2><form id="ent-form">
    <label class="field"><span>Имя или название</span><input name="name" required value="${esc(lead?.name || '')}"></label>
    <div class="form-row"><label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(lead?.phone || '')}"></label><label class="field"><span>Почта</span><input type="email" name="email" value="${esc(lead?.email || '')}"></label></div>
    <div class="form-row"><label class="field"><span>Мессенджер</span><input name="messenger" value="${esc(lead?.messenger || '')}"></label><label class="field"><span>Источник</span><input name="source" placeholder="Сайт, рекомендация, звонок" value="${esc(lead?.source || '')}"></label></div>
    <div class="form-row"><label class="field"><span>Статус</span><select name="status">${CRM_LEAD_STATUSES.map(([id, name]) => `<option value="${id}" ${(lead?.status || 'new') === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="field"><span>Ответственный</span><select name="responsibleId">${crmEmployeeOptions(lead?.responsibleId, lead)}</select></label></div>
    <label class="field"><span>Комментарий</span><textarea name="notes">${esc(lead?.notes || '')}</textarea></label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button><button type="button" class="btn" id="convert-lead">Конвертировать</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div>
  </form>`, (root) => {
    bindEntityForm(root, 'leads', lead, crmScope(lead));
    $('#convert-lead', root)?.addEventListener('click', () => openLeadConversion(lead));
  });
}

function openLegacyClient(client) {
  openModal(`<h2>${esc(client?.name || 'Старая карточка')}</h2><div class="banner warn">Старая карточка — только чтение. Она сохранена без изменений для безопасного перехода.</div>
    <dl class="crm-details"><dt>Компания</dt><dd>${esc(client?.company || client?.legalName || '—')}</dd><dt>Телефон</dt><dd>${client?.phone || client?.legacyPhone ? `<a href="${telHref(client.phone || client.legacyPhone)}">${esc(client.phone || client.legacyPhone)}</a>` : '—'}</dd><dt>Сумма</dt><dd>${client?.amount || client?.legacyAmount ? money(client.amount || client.legacyAmount) : '—'}</dd><dt>Заметки</dt><dd>${esc(client?.notes || '—')}</dd></dl>
    <div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>`, (root) => $('#modal-cancel', root).addEventListener('click', closeModal));
}

function openPipelineManager() {
  const pipelines = crmRecords('pipelines');
  const stages = crmRecords('stages');
  openModal(`<div class="crm-modal-heading"><div><h2>Воронки и стадии</h2><p class="muted small">Порядок стадий задаётся числом: от меньшего к большему.</p></div><button class="btn primary small" id="add-pipeline">+ Воронка</button></div>
    <div class="crm-settings-list">${pipelines.length ? pipelines.map((pipeline) => `<section class="crm-settings-card"><header><strong>${esc(pipeline.name)}</strong>${pipeline.isDefault ? '<span class="badge green">По умолчанию</span>' : ''}<button class="btn ghost small" data-edit-pipeline="${pipeline.id}">Изменить</button></header>
      <div class="crm-stage-list">${stages.filter((stage) => stage.pipelineId === pipeline.id).sort((a, b) => Number(a.order) - Number(b.order)).map((stage) => `<button class="crm-stage-row" data-edit-stage="${stage.id}"><span>${esc(stage.name)}</span><small>${stage.type === 'won' ? 'Успех' : stage.type === 'lost' ? 'Отказ' : `Порядок ${Number(stage.order)}`}</small></button>`).join('') || '<span class="muted small">Стадий пока нет</span>'}</div>
      <button class="btn small" data-add-stage="${pipeline.id}">+ Стадия</button></section>`).join('') : crmEmpty('🪜', 'Воронок пока нет', 'Создайте воронку, затем добавьте её стадии.')}</div>
    <div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#add-pipeline', root).addEventListener('click', () => openPipelineForm());
    root.querySelectorAll('[data-edit-pipeline]').forEach((button) => button.addEventListener('click', () => openPipelineForm(pipelines.find((pipeline) => pipeline.id === button.dataset.editPipeline))));
    root.querySelectorAll('[data-add-stage]').forEach((button) => button.addEventListener('click', () => openStageForm(null, pipelines.find((pipeline) => pipeline.id === button.dataset.addStage))));
    root.querySelectorAll('[data-edit-stage]').forEach((button) => button.addEventListener('click', () => {
      const stage = stages.find((item) => item.id === button.dataset.editStage);
      openStageForm(stage, pipelines.find((pipeline) => pipeline.id === stage?.pipelineId));
    }));
  });
}

function openPipelineForm(pipeline) {
  const isNew = !pipeline;
  openModal(`<h2>${isNew ? 'Новая воронка' : 'Настройка воронки'}</h2><form id="pipeline-form">
    <label class="field"><span>Название</span><input name="name" required value="${esc(pipeline?.name || '')}" placeholder="Например, Новые продажи"></label>
    <label class="checkline"><input type="checkbox" name="isDefault" ${pipeline?.isDefault ? 'checked' : ''}> Использовать по умолчанию</label>
    <label class="checkline"><input type="checkbox" name="active" ${pipeline?.active !== false ? 'checked' : ''}> Воронка активна</label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="pipeline-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#pipeline-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const data = { name: form.elements.name.value.trim(), isDefault: form.elements.isDefault.checked, active: form.elements.active.checked };
      closeModal();
      if (pipeline) await doUpdate('pipelines', { ...pipeline, ...data }, 'Воронка сохранена');
      else {
        const result = await doCreate('pipelines', { ...data, ...crmScope(pipeline) }, 'Воронка создана');
        if (result?.item?.id) S.crmPipelineId = result.item.id;
      }
    });
    $('#pipeline-delete', root)?.addEventListener('click', async () => {
      const hasDeals = crmRecords('deals').some((deal) => deal.pipelineId === pipeline.id);
      if (hasDeals) { toast('Сначала перенесите или удалите сделки этой воронки', true); return; }
      if (!confirm('Удалить воронку и её пустые стадии?')) return;
      closeModal();
      for (const stage of crmRecords('stages').filter((item) => item.pipelineId === pipeline.id)) await doDelete('stages', stage.id);
      await doDelete('pipelines', pipeline.id, 'Воронка удалена');
    });
  });
}

function openStageForm(stage, pipeline) {
  if (!pipeline) { toast('Сначала создайте воронку', true); return; }
  const isNew = !stage;
  const siblings = crmRecords('stages').filter((item) => item.pipelineId === pipeline.id);
  openModal(`<h2>${isNew ? 'Новая стадия' : 'Настройка стадии'}</h2><p class="muted small">Воронка: ${esc(pipeline.name)}</p><form id="stage-form">
    <label class="field"><span>Название</span><input name="name" required value="${esc(stage?.name || '')}"></label>
    <div class="form-row"><label class="field"><span>Порядок</span><input type="number" min="0" name="order" required value="${esc(stage?.order ?? siblings.length)}"></label><label class="field"><span>Тип</span><select name="type"><option value="open" ${(stage?.type || 'open') === 'open' ? 'selected' : ''}>Открытая</option><option value="won" ${stage?.type === 'won' ? 'selected' : ''}>Успешно</option><option value="lost" ${stage?.type === 'lost' ? 'selected' : ''}>Отказ</option></select></label></div>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="stage-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#stage-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      data.order = Number(data.order);
      closeModal();
      if (stage) await doUpdate('stages', { ...stage, ...data }, 'Стадия сохранена');
      else await doCreate('stages', { ...data, pipelineId: pipeline.id, ...crmScope(pipeline) }, 'Стадия добавлена');
    });
    $('#stage-delete', root)?.addEventListener('click', async () => {
      if (crmRecords('deals').some((deal) => deal.stageId === stage.id)) { toast('На этой стадии есть сделки', true); return; }
      if (confirm('Удалить пустую стадию?')) { closeModal(); await doDelete('stages', stage.id, 'Стадия удалена'); }
    });
  });
}

function dealItemRow(item = {}) {
  return `<div class="crm-deal-item" data-deal-item="${esc(item.id || '')}">
    <div class="crm-deal-item-main"><input name="itemName" aria-label="Наименование позиции" placeholder="Что продаём" value="${esc(item.name || '')}"><input type="number" min="0" step="0.01" name="itemAmount" aria-label="Сумма позиции" placeholder="Сумма, ₽" value="${esc(item.amount || '')}"><button type="button" class="btn danger ghost small" data-remove-item aria-label="Удалить позицию">×</button></div>
    <input name="itemComment" aria-label="Комментарий к позиции" placeholder="Комментарий" value="${esc(item.comment || '')}">
    <div class="crm-item-recurring"><label class="checkline"><input type="checkbox" name="itemRecurring" ${item.recurring ? 'checked' : ''}> Регулярный платёж</label><select name="itemPeriod" aria-label="Периодичность"><option value="">— период —</option><option value="month" ${item.period === 'month' ? 'selected' : ''}>Ежемесячно</option><option value="quarter" ${item.period === 'quarter' ? 'selected' : ''}>Ежеквартально</option><option value="year" ${item.period === 'year' ? 'selected' : ''}>Ежегодно</option></select></div>
  </div>`;
}

function openDealForm(deal) {
  const isNew = !deal;
  const pipelines = crmRecords('pipelines').filter((pipeline) => pipeline.active !== false);
  const initialPipelineId = deal?.pipelineId || S.crmPipelineId || pipelines[0]?.id;
  const allStages = crmRecords('stages').sort((a, b) => Number(a.order) - Number(b.order));
  if (!initialPipelineId || !allStages.some((stage) => stage.pipelineId === initialPipelineId)) { toast('Сначала создайте воронку и стадии', true); return; }
  const companies = crmRecords('companies').filter((company) => !company.legacy);
  const contacts = crmRecords('contacts');
  const existingItems = deal ? crmRecords('dealItems').filter((item) => item.dealId === deal.id) : [];
  openModal(`<h2>${isNew ? 'Новая сделка' : esc(deal.name)}</h2><form id="deal-form">
    <label class="field"><span>Название сделки</span><input name="name" required value="${esc(deal?.name || '')}" placeholder="Что продаём"></label>
    <div class="form-row"><label class="field"><span>Компания</span><select name="companyId"><option value="">— без компании —</option>${companies.map((company) => `<option value="${company.id}" ${deal?.companyId === company.id ? 'selected' : ''}>${esc(company.name)}</option>`).join('')}</select></label><label class="field"><span>Контакт</span><select name="contactId"><option value="">— без контакта —</option>${contacts.map((contact) => `<option value="${contact.id}" ${deal?.contactId === contact.id ? 'selected' : ''}>${esc(contact.name)}</option>`).join('')}</select></label></div>
    <div class="form-row"><label class="field"><span>Воронка</span><select name="pipelineId">${pipelines.map((pipeline) => `<option value="${pipeline.id}" ${pipeline.id === initialPipelineId ? 'selected' : ''}>${esc(pipeline.name)}</option>`).join('')}</select></label><label class="field"><span>Стадия</span><select name="stageId"></select></label></div>
    <div class="form-row"><label class="field"><span>Сумма вручную, ₽</span><input type="number" min="0" step="0.01" name="amount" value="${esc(deal?.amount || '')}" placeholder="Если нет позиций"></label><label class="field"><span>Ответственный</span><select name="responsibleId">${crmEmployeeOptions(deal?.responsibleId, deal)}</select></label></div>
    <div class="form-row"><label class="field"><span>План закрытия</span><input type="date" name="plannedCloseDate" value="${esc(deal?.plannedCloseDate || '')}"></label><label class="field"><span>Фактически закрыта</span><input type="date" name="closedAt" value="${esc(deal?.closedAt || '')}"></label></div>
    <label class="field"><span>Причина отказа</span><input name="lostReason" value="${esc(deal?.lostReason || '')}" placeholder="Обязательна для стадии «Отказ»"></label>
    <label class="field"><span>Заметки</span><textarea name="notes">${esc(deal?.notes || '')}</textarea></label>
    <div class="crm-items-heading"><strong>Позиции сделки</strong><button class="btn small" type="button" id="add-deal-item">+ Позиция</button></div><div id="deal-items">${existingItems.map(dealItemRow).join('')}</div>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="deal-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary">${isNew ? 'Создать' : 'Сохранить'}</button></div>
  </form>`, (root) => {
    const form = $('#deal-form', root);
    const pipelineSelect = form.elements.pipelineId;
    const stageSelect = form.elements.stageId;
    const updateStages = () => {
      const selected = stageSelect.value || deal?.stageId;
      const options = allStages.filter((stage) => stage.pipelineId === pipelineSelect.value);
      stageSelect.innerHTML = options.map((stage) => `<option value="${stage.id}" ${stage.id === selected ? 'selected' : ''}>${esc(stage.name)}</option>`).join('');
    };
    updateStages();
    pipelineSelect.addEventListener('change', updateStages);
    const bindRemove = () => root.querySelectorAll('[data-remove-item]').forEach((button) => { button.onclick = () => button.closest('[data-deal-item]').remove(); });
    bindRemove();
    $('#add-deal-item', root).addEventListener('click', () => { $('#deal-items', root).insertAdjacentHTML('beforeend', dealItemRow()); bindRemove(); });
    $('#modal-cancel', root).addEventListener('click', closeModal);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rows = [...root.querySelectorAll('[data-deal-item]')];
      const invalidRecurring = rows.find((row) => row.querySelector('[name="itemRecurring"]').checked && !row.querySelector('[name="itemPeriod"]').value);
      if (invalidRecurring) { toast('Выберите период регулярного платежа', true); invalidRecurring.querySelector('[name="itemPeriod"]').focus(); return; }
      const data = Object.fromEntries(new FormData(form).entries());
      for (const key of ['itemName', 'itemAmount', 'itemComment', 'itemRecurring', 'itemPeriod']) delete data[key];
      data.amount = Number(data.amount || 0);
      const selectedStage = allStages.find((stage) => stage.id === data.stageId);
      if (selectedStage?.type === 'lost' && !String(data.lostReason || '').trim()) { toast('Укажите причину отказа', true); form.elements.lostReason.focus(); return; }
      const result = deal ? await doUpdate('deals', { ...deal, ...data }, 'Сделка сохранена') : await doCreate('deals', { ...data, ...crmScope(deal) }, 'Сделка создана');
      if (!result) return;
      const savedDeal = result.item || { ...deal, ...data };
      const keptIds = new Set(rows.map((row) => row.dataset.dealItem).filter(Boolean));
      for (const item of existingItems.filter((entry) => !keptIds.has(entry.id))) await doDelete('dealItems', item.id);
      for (const row of rows) {
        const itemData = {
          dealId: savedDeal.id,
          name: row.querySelector('[name="itemName"]').value.trim(),
          amount: Number(row.querySelector('[name="itemAmount"]').value || 0),
          comment: row.querySelector('[name="itemComment"]').value.trim(),
          recurring: row.querySelector('[name="itemRecurring"]').checked,
          period: row.querySelector('[name="itemPeriod"]').value,
        };
        if (!itemData.name) continue;
        const old = existingItems.find((entry) => entry.id === row.dataset.dealItem);
        if (old) await doUpdate('dealItems', { ...old, ...itemData });
        else await doCreate('dealItems', { ...itemData, ...crmScope(savedDeal) });
      }
      closeModal();
      render();
    });
    $('#deal-delete', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить сделку и её позиции?')) return;
      closeModal();
      for (const item of existingItems) await doDelete('dealItems', item.id);
      await doDelete('deals', deal.id, 'Сделка удалена');
    });
  });
}

function openLeadConversion(lead) {
  const pipelines = crmRecords('pipelines').filter((pipeline) => pipeline.active !== false);
  const stages = crmRecords('stages').filter((stage) => stage.type === 'open');
  if (!pipelines.length || !stages.length) { toast('Сначала настройте воронку продаж', true); return; }
  const pipeline = pipelines.find((item) => item.isDefault) || pipelines[0];
  const firstStage = stages.filter((stage) => stage.pipelineId === pipeline.id).sort((a, b) => Number(a.order) - Number(b.order))[0];
  if (!firstStage) { toast('В воронке нет открытой стадии', true); return; }
  openModal(`<h2>Конвертировать лид</h2><p class="muted small">Будут созданы компания, контакт и первая сделка. Исходный лид останется в истории со статусом «Квалифицирован».</p><form id="convert-form">
    <label class="field"><span>Название компании</span><input name="companyName" required value="${esc(lead.name)}"></label><label class="field"><span>Название сделки</span><input name="dealName" required value="${esc(`Первая сделка — ${lead.name}`)}"></label>
    <div class="actions"><button type="button" class="btn" id="modal-cancel">Отмена</button><button class="btn primary">Конвертировать</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#convert-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const companyResult = await doCreate('companies', { name: data.companyName, status: 'talks', responsibleIds: lead.responsibleId ? [lead.responsibleId] : [], notes: lead.notes || '', ...crmScope(lead) });
      if (!companyResult?.item?.id) return;
      const contactResult = await doCreate('contacts', { companyId: companyResult.item.id, name: lead.name, phone: lead.phone || '', email: lead.email || '', messenger: lead.messenger || '', isPrimary: true, notes: '', ...crmScope(lead) });
      if (!contactResult?.item?.id) return;
      const dealResult = await doCreate('deals', { name: data.dealName, companyId: companyResult.item.id, contactId: contactResult.item.id, pipelineId: pipeline.id, stageId: firstStage.id, amount: 0, responsibleId: lead.responsibleId || '', notes: lead.notes || '', ...crmScope(lead) });
      if (!dealResult) return;
      await doUpdate('leads', { ...lead, status: 'qualified' }, 'Лид конвертирован');
      closeModal();
      location.hash = '#/clients?tab=deals';
    });
  });
}

// ---------- Универсальные события ----------
const EVENT_STATUS = {
  planned: { name: 'Запланировано', color: 'blue' },
  active: { name: 'Идёт', color: 'amber' },
  completed: { name: 'Завершено', color: 'green' },
  cancelled: { name: 'Отменено', color: 'red' },
};
const REGISTRATION_STATUS = {
  registered: { name: 'Зарегистрирован', color: 'blue' },
  confirmed: { name: 'Подтверждён', color: 'green' },
  attended: { name: 'Участвовал', color: 'green' },
  cancelled: { name: 'Отменён', color: 'red' },
  refunded: { name: 'Возврат', color: 'amber' },
};
const PARTICIPANT_LABEL = { player: 'Игрок', company: 'Контрагент', contact: 'Контакт' };

function eventRows(entity, businessId = '') {
  return (S.data?.[entity] || []).filter((item) => {
    const scope = businessIdOf(item);
    return (!businessId ? activeUnits().includes(scope) : scope === businessId)
      && businessHasModule(business(scope), 'events');
  });
}
function eventTypeFor(event) {
  return eventRows('eventTypes', businessIdOf(event)).find((type) => type.id === event.eventTypeId);
}
function eventDateTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? fmtDT(time) : '—';
}
function eventParticipant(registration) {
  const entity = { player: 'players', company: 'companies', contact: 'contacts' }[registration.participantType];
  const record = (S.data?.[entity] || []).find((item) => item.id === registration.participantId
    && businessIdOf(item) === businessIdOf(registration));
  return record ? (record.name || record.company || 'Без названия') : 'Связанная запись недоступна';
}
function eventParticipantMoney(registration, event) {
  const allocations = eventRows('eventFinanceAllocations', businessIdOf(event)).filter((item) => item.registrationId === registration.id);
  const finance = new Map((S.data.finance || []).map((item) => [item.id, item]));
  let paid = 0; let refund = 0;
  allocations.forEach((allocation) => {
    const operation = finance.get(allocation.financeId);
    if (operation?.type === 'income') paid += Number(allocation.amount || 0);
    if (operation?.type === 'expense' && allocation.purpose === 'refund') refund += Number(allocation.amount || 0);
  });
  const charged = ['cancelled', 'refunded'].includes(registration.status) ? 0 : Number(registration.chargeAmount || 0);
  return { charged, paid, debt: Math.max(0, charged - paid), refund };
}
function eventHash(id = '', tab = 'overview', view = '') {
  const params = new URLSearchParams(String(location.hash).split('?')[1] || '');
  const origin = params.get('from') || eventViewFromHash(location.hash);
  if (id) return `#/events?id=${encodeURIComponent(id)}&tab=${tab}&from=${origin}`;
  return `#/events?view=${view || params.get('from') || eventViewFromHash(location.hash)}`;
}

function eventLocalDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : isoDay(date);
}

function viewEvents() {
  if (!hasModule('events')) { location.hash = '#/dashboard'; return; }
  const id = eventIdFromHash(location.hash);
  if (id) viewEventCard(id);
  else viewEventDirectory();
}

function viewEventDirectory() {
  setTitle('События');
  const mode = eventViewFromHash(location.hash);
  const types = eventRows('eventTypes');
  if (S.eventFilter.typeId && !types.some((type) => type.id === S.eventFilter.typeId)) S.eventFilter.typeId = '';
  const q = String(S.eventSearch || '').trim().toLowerCase();
  const list = eventRows('events')
    .filter((event) => S.eventFilter.status === 'all' || event.status === S.eventFilter.status)
    .filter((event) => !S.eventFilter.typeId || event.eventTypeId === S.eventFilter.typeId)
    .filter((event) => !q || [event.title, event.locationName, event.resourceName, eventTypeFor(event)?.name]
      .some((value) => String(value || '').toLowerCase().includes(q)))
    .sort((left, right) => String(left.startsAt || '').localeCompare(String(right.startsAt || '')));
  const filtered = q || S.eventFilter.status !== 'all' || S.eventFilter.typeId;
  const toolbar = `
    <div class="event-toolbar">
      <div class="event-view-toggle" role="group" aria-label="Вид событий">
        <button class="btn ${mode === 'list' ? 'primary' : ''}" data-event-view="list">Список</button>
        <button class="btn ${mode === 'calendar' ? 'primary' : ''}" data-event-view="calendar">Календарь</button>
      </div>
      <input class="event-search" id="event-search" type="search" placeholder="Название, место или ресурс" value="${esc(S.eventSearch || '')}">
      <select id="event-status-filter"><option value="all">Все статусы</option>${Object.entries(EVENT_STATUS).map(([id, status]) => `<option value="${id}" ${S.eventFilter.status === id ? 'selected' : ''}>${status.name}</option>`).join('')}</select>
      <select id="event-type-filter"><option value="">Все типы</option>${types.map((type) => `<option value="${type.id}" ${S.eventFilter.typeId === type.id ? 'selected' : ''}>${esc(type.name)}</option>`).join('')}</select>
      <div class="event-toolbar-actions">${isAdmin() ? '<button class="btn" id="event-types">Типы событий</button>' : ''}<button class="btn primary" id="add-event">+ Событие</button></div>
    </div>`;
  $('#view').innerHTML = `${toolbar}${mode === 'calendar' ? eventCalendarHtml(list) : eventListHtml(list, filtered)}`;
  bindEventDirectory();
}

function eventListHtml(list, filtered) {
  if (!list.length) return `<div class="card empty event-empty"><div class="big">📅</div><b>${filtered ? 'По выбранным фильтрам событий нет' : 'Событий пока нет'}</b><span>${filtered ? 'Измените условия поиска или сбросьте фильтры.' : 'Создайте тип события, затем добавьте первое мероприятие.'}</span>${filtered ? '<button class="btn" id="event-reset">Сбросить фильтры</button>' : '<button class="btn primary" id="event-first">Создать первое событие</button>'}</div>`;
  return `<div class="event-list">${list.map((event) => {
    const status = EVENT_STATUS[event.status] || EVENT_STATUS.planned;
    const registrations = eventRows('eventRegistrations', businessIdOf(event)).filter((item) => item.eventId === event.id && item.status !== 'cancelled').length;
    return `<button class="card event-row" data-event-id="${event.id}">
      <time><b>${fmtDate(eventLocalDay(event.startsAt))}</b><span>${new Date(event.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></time>
      <span class="event-row-main"><strong>${esc(event.title)}</strong><small>${esc(eventTypeFor(event)?.name || 'Тип недоступен')}${event.locationName ? ` · ${esc(event.locationName)}` : ''}${event.resourceName ? ` · ${esc(event.resourceName)}` : ''}</small></span>
      ${S.unit === 'all' ? `<span class="badge">${esc(businessName(businessIdOf(event)))}</span>` : ''}
      <span class="event-capacity">${registrations}${Number(event.capacity) ? ` / ${Number(event.capacity)}` : ''} участ.</span>
      <span class="badge ${status.color} dot">${status.name}</span>
    </button>`;
  }).join('')}</div>`;
}

function eventCalendarHtml(list) {
  const month = S.eventMonth || today().slice(0, 7);
  const first = new Date(`${month}-01T00:00:00`);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  const byDate = new Map();
  list.filter((event) => eventLocalDay(event.startsAt).slice(0, 7) === month).forEach((event) => {
    const date = eventLocalDay(event.startsAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(event);
  });
  const title = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const agenda = [...byDate.entries()].sort().map(([date, events]) => `<section class="event-agenda-day"><h3>${fmtDate(date)}</h3>${events.map((event) => `<button data-event-id="${event.id}"><span>${new Date(event.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><b>${esc(event.title)}</b><small>${esc(event.locationName || event.resourceName || '')}</small></button>`).join('')}</section>`).join('');
  return `<div class="event-calendar-nav"><button class="btn" id="event-month-prev">←</button><strong>${title}</strong><button class="btn" id="event-month-next">→</button><button class="btn" id="event-month-today">Сегодня</button></div>
    <div class="event-calendar-head">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => `<span>${day}</span>`).join('')}</div>
    <div class="event-calendar-grid">${cells.map((date) => {
      const iso = isoDay(date); const events = byDate.get(iso) || [];
      return `<div class="event-day ${date.getMonth() !== first.getMonth() ? 'outside' : ''}"><span>${date.getDate()}</span><div class="event-day-events">${events.map((event) => `<button data-event-id="${event.id}" class="event-calendar-item">${new Date(event.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} ${esc(event.title)}</button>`).join('')}</div></div>`;
    }).join('')}</div>
    <div class="event-agenda">${agenda || '<div class="card empty">В этом месяце событий нет</div>'}</div>`;
}

function bindEventDirectory() {
  $('#view').querySelectorAll('[data-event-view]').forEach((button) => button.addEventListener('click', () => { location.hash = eventHash('', '', button.dataset.eventView); }));
  $('#event-search')?.addEventListener('input', (event) => {
    S.eventSearch = event.target.value;
    viewEventDirectory();
    const search = $('#event-search');
    search?.focus();
    search?.setSelectionRange(S.eventSearch.length, S.eventSearch.length);
  });
  $('#event-status-filter')?.addEventListener('change', (event) => { S.eventFilter.status = event.target.value; viewEventDirectory(); });
  $('#event-type-filter')?.addEventListener('change', (event) => { S.eventFilter.typeId = event.target.value; viewEventDirectory(); });
  $('#event-reset')?.addEventListener('click', () => { S.eventSearch = ''; S.eventFilter = { status: 'all', typeId: '' }; viewEventDirectory(); });
  $('#add-event')?.addEventListener('click', () => openEventForm());
  $('#event-first')?.addEventListener('click', () => openEventForm());
  $('#event-types')?.addEventListener('click', () => openEventTypeManager());
  $('#view').querySelectorAll('[data-event-id]').forEach((button) => button.addEventListener('click', () => { location.hash = eventHash(button.dataset.eventId); }));
  const shift = (delta) => { const date = new Date(`${S.eventMonth}-01T00:00:00`); date.setMonth(date.getMonth() + delta); S.eventMonth = isoDay(date).slice(0, 7); viewEventDirectory(); };
  $('#event-month-prev')?.addEventListener('click', () => shift(-1));
  $('#event-month-next')?.addEventListener('click', () => shift(1));
  $('#event-month-today')?.addEventListener('click', () => { S.eventMonth = today().slice(0, 7); viewEventDirectory(); });
}

function viewEventCard(id) {
  const event = eventRows('events').find((item) => item.id === id);
  if (!event) { history.replaceState(null, '', eventHash()); viewEventDirectory(); return; }
  setTitle(event.title);
  const tab = eventTabFromHash(location.hash);
  const status = EVENT_STATUS[event.status] || EVENT_STATUS.planned;
  const locked = event.settlementStatus === 'closed';
  const manageable = canManageEvent(event);
  $('#view').innerHTML = `
    <div class="event-card-head">
      <button class="btn ghost" id="event-back">← Все события</button>
      <div class="grow"><div class="event-card-title"><h2>${esc(event.title)}</h2><span class="badge ${status.color} dot">${status.name}</span></div><p>${eventDateTime(event.startsAt)}${event.locationName ? ` · ${esc(event.locationName)}` : ''}${event.resourceName ? ` · ${esc(event.resourceName)}` : ''}</p></div>
      ${locked ? '<span class="badge green">Расчёт зафиксирован</span>' : `${manageable ? '<button class="btn" id="event-edit">Изменить</button>' : ''}${isAdmin() && ['completed', 'cancelled'].includes(event.status) ? '<button class="btn primary" id="event-close-settlement">Зафиксировать расчёт</button>' : ''}`}
    </div>
    ${locked ? '<div class="banner event-locked">🔒 Расчёт зафиксирован. Участники, план и финансовые связи доступны только для чтения.</div>' : ''}
    <div class="event-tabs" role="tablist">${EVENT_TABS.map((item) => `<button class="${tab === item.id ? 'active' : ''}" data-event-tab="${item.id}">${item.label}</button>`).join('')}</div>
    <div class="event-tab-panel">${tab === 'overview' ? eventOverviewHtml(event) : tab === 'participants' ? eventParticipantsHtml(event, locked || !manageable) : tab === 'economy' ? eventEconomyHtml(event, locked) : eventHistoryHtml(event)}</div>`;
  bindEventCard(event, tab, locked);
}

function eventOverviewHtml(event) {
  const type = eventTypeFor(event);
  return `<div class="event-overview-grid">
    <section class="card event-section"><h3>Основное</h3><dl class="event-details"><dt>Тип</dt><dd>${esc(type?.name || 'Связанная запись недоступна')}</dd><dt>Начало</dt><dd>${eventDateTime(event.startsAt)}</dd><dt>Окончание</dt><dd>${event.endsAt ? eventDateTime(event.endsAt) : '—'}</dd><dt>Ответственный</dt><dd>${esc(empName(event.responsibleId))}</dd><dt>Вместимость</dt><dd>${Number(event.capacity) || 'без ограничения'}</dd>${isAdmin() ? `<dt>Стоимость участия</dt><dd>${money(event.defaultFee)}</dd>` : ''}</dl></section>
    <section class="card event-section"><h3>Место и ресурс</h3><dl class="event-details"><dt>Площадка</dt><dd>${esc(event.locationName || 'не указана')}</dd><dt>Ресурс</dt><dd>${esc(event.resourceName || 'не указан')}</dd>${event.venueId ? `<dt>Справочник</dt><dd>${esc((S.data.venues || []).find((venue) => venue.id === event.venueId && businessIdOf(venue) === businessIdOf(event))?.name || 'Связанная запись недоступна')}</dd>` : ''}</dl></section>
    <section class="card event-section event-description"><h3>Описание</h3><p>${esc(event.description || 'Описание пока не добавлено')}</p></section>
  </div>`;
}

function eventParticipantsHtml(event, locked) {
  const registrations = eventRows('eventRegistrations', businessIdOf(event)).filter((item) => item.eventId === event.id);
  const rows = registrations.map((registration) => {
    const status = REGISTRATION_STATUS[registration.status] || REGISTRATION_STATUS.registered;
    if (!isAdmin()) return `<button class="event-participant-row" data-registration-id="${registration.id}"><span><b>${esc(eventParticipant(registration))}</b><small>${PARTICIPANT_LABEL[registration.participantType] || 'Участник'}</small></span><span class="badge ${status.color} dot">${status.name}</span></button>`;
    const amounts = eventParticipantMoney(registration, event);
    const charged = ['cancelled', 'refunded'].includes(registration.status) ? 0 : Number(registration.chargeAmount || 0);
    return `<button class="event-participant-row" data-registration-id="${registration.id}"><span><b>${esc(eventParticipant(registration))}</b><small>${PARTICIPANT_LABEL[registration.participantType] || 'Участник'}</small></span><span class="badge ${status.color} dot">${status.name}</span><span>${money(charged)}</span><span>${money(amounts.paid)}</span><span>${money(amounts.debt)}</span><span>${money(amounts.refund)}</span></button>`;
  }).join('');
  return `<section class="card event-section"><header><div><h3>Участники</h3><p>${registrations.length ? `${registrations.length} записей` : 'Участников пока нет'}</p></div>${locked ? '' : '<button class="btn primary" id="add-registration">+ Участник</button>'}</header>
    ${registrations.length ? `<div class="event-participant-head"><span>Участник</span><span>Статус</span>${isAdmin() ? '<span>Начислено</span><span>Оплачено</span><span>Долг</span><span>Возврат</span>' : ''}</div><div class="event-participant-table">${rows}</div>` : '<div class="empty">Добавьте первого участника события.</div>'}
  </section>`;
}

function eventEconomyHtml(event, locked) {
  if (!isAdmin()) {
    const isResponsible = event.responsibleId === S.profile.id;
    const ownIncome = isResponsible ? event.staffAmount : 0;
    return `<div class="banner">У вас нет доступа к прибыли и финансовым операциям события.</div><div class="card stat"><div class="label">Ваше начисление по событию</div><div class="value">${ownIncome == null ? '—' : money(ownIncome)}</div><div class="hint">${isResponsible ? (event.settlementStatus === 'closed' ? 'зафиксировано при закрытии расчёта' : 'рассчитано по текущим участникам') : 'начисление доступно ответственному сотруднику'}</div></div>`;
  }
  const data = {
    eventRegistrations: eventRows('eventRegistrations', businessIdOf(event)),
    eventBudgetLines: eventRows('eventBudgetLines', businessIdOf(event)),
    eventFinanceAllocations: eventRows('eventFinanceAllocations', businessIdOf(event)),
    finance: (S.data.finance || []).filter((item) => businessIdOf(item) === businessIdOf(event)),
  };
  const economy = event.settlementStatus === 'closed' && event.settlement ? event.settlement : eventEconomy(event, data);
  const lines = data.eventBudgetLines.filter((item) => item.eventId === event.id);
  const allocations = data.eventFinanceAllocations.filter((item) => item.eventId === event.id);
  const finance = new Map(data.finance.map((item) => [item.id, item]));
  const margin = economy.margin == null ? '—' : `${(Number(economy.margin) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  const ownerShares = Array.isArray(economy.ownerShares) ? economy.ownerShares : [];
  return `<div class="event-kpi-grid">
      ${[['Начислено', economy.accrued], ['Оплачено', economy.paid], ['Долг', economy.debt], ['Возврат', economy.refunds]].map(([label, value]) => `<div class="card stat"><div class="label">${label}</div><div class="value">${money(value)}</div></div>`).join('')}
    </div>
    <div class="event-economy-grid">
      <section class="card event-section"><h3>План</h3><dl class="event-details"><dt>Доход</dt><dd>${money(economy.plannedIncome)}</dd><dt>Прямые расходы</dt><dd>${money(economy.plannedExpenses)}</dd><dt>Прибыль</dt><dd>${money(economy.plannedProfit)}</dd><dt>Маржа</dt><dd>${economy.plannedMargin == null ? '—' : `${(Number(economy.plannedMargin) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`}</dd><dt>Прибыль на участника</dt><dd>${economy.plannedProfitPerParticipant == null ? '—' : money(economy.plannedProfitPerParticipant)}</dd></dl></section>
      <section class="card event-section"><h3>Факт</h3><dl class="event-details"><dt>Доход</dt><dd>${money(economy.actualIncome)}</dd><dt>Прямые расходы</dt><dd>${money(economy.directExpenses)}</dd><dt>Прибыль</dt><dd>${money(economy.profit)}</dd><dt>Маржа</dt><dd>${margin}</dd><dt>Прибыль на участника</dt><dd>${economy.profitPerParticipant == null ? '—' : money(economy.profitPerParticipant)}</dd><dt>Зачтено депозитом</dt><dd>${money(economy.depositApplied)}</dd></dl></section>
    </div>
    ${ownerShares.length ? `<section class="card event-section"><h3>Доли организаторов</h3><div class="list">${ownerShares.map((share) => `<div class="row-card"><span class="grow">${esc(share.name || ownerLabel(share.ownerId))} · ${(Number(share.share) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%</span><strong>${money(share.amount)}</strong></div>`).join('')}</div></section>` : ''}
    <section class="card event-section"><header><div><h3>Плановые строки</h3><p>${lines.length ? `${lines.length} строк` : 'План ещё не заполнен'}</p></div>${locked ? '' : '<button class="btn" id="add-budget-line">+ Строка плана</button>'}</header>${lines.length ? `<div class="list">${lines.map((line) => `<button class="row-card" data-budget-line="${line.id}"><span class="grow col"><b>${esc(line.name)}</b><small>${line.direction === 'income' ? 'Доход' : 'Расход'}${line.category ? ` · ${esc(line.category)}` : ''}</small></span><strong>${money(line.plannedAmount)}</strong></button>`).join('')}</div>` : '<div class="empty">Добавьте ожидаемые доходы и прямые расходы.</div>'}</section>
    <section class="card event-section"><header><div><h3>Фактические операции</h3><p>${allocations.length ? `${allocations.length} связей` : 'Фактические операции пока не связаны'}</p></div>${locked ? '' : '<button class="btn primary" id="add-event-allocation">Привязать операцию</button>'}</header>${allocations.length ? `<div class="list">${allocations.map((allocation) => { const operation = finance.get(allocation.financeId); return `<div class="row-card"><span class="grow col"><b>${allocation.purpose === 'deposit' ? 'Зачёт депозита' : allocation.purpose === 'refund' ? 'Возврат' : allocation.purpose === 'expense' ? 'Прямой расход' : 'Оплата'}</b><small>${operation ? `${fmtDate(operation.date)} · ${esc(operation.category || '')}` : 'Связанная операция недоступна'}</small></span><strong>${money(allocation.amount)}</strong><span class="badge">неизменяемо</span></div>`; }).join('')}</div>` : '<div class="empty">Свяжите существующую операцию из раздела «Финансы».</div>'}</section>`;
}

function eventHistoryHtml(event) {
  const historyItems = [...(Array.isArray(event.history) ? event.history : [])].sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
  return `<section class="card event-section"><h3>История</h3>${historyItems.length ? `<div class="event-history-list">${historyItems.map((item) => `<div class="event-history-item"><span class="event-history-dot"></span><div><b>${item.action === 'created' ? 'Событие создано' : item.action === 'settlement_closed' ? 'Расчёт зафиксирован' : item.fromStatus !== item.toStatus ? `Статус: ${(EVENT_STATUS[item.fromStatus] || {}).name || '—'} → ${(EVENT_STATUS[item.toStatus] || {}).name || '—'}` : 'Карточка изменена'}</b><small>${esc(empName(item.byId))} · ${fmtDT(Number(item.at || 0))}${item.changed?.length ? ` · ${esc(item.changed.join(', '))}` : ''}</small></div></div>`).join('')}</div>` : '<div class="empty">История пока пуста</div>'}</section>`;
}

function bindEventCard(event, tab, locked) {
  $('#event-back')?.addEventListener('click', () => { location.hash = eventHash(); });
  $('#event-edit')?.addEventListener('click', () => openEventForm(event));
  $('#view').querySelectorAll('[data-event-tab]').forEach((button) => button.addEventListener('click', () => { location.hash = eventHash(event.id, button.dataset.eventTab); }));
  $('#add-registration')?.addEventListener('click', () => openEventRegistrationForm(event));
  $('#view').querySelectorAll('[data-registration-id]').forEach((button) => button.addEventListener('click', () => {
    const registration = eventRows('eventRegistrations', businessIdOf(event)).find((item) => item.id === button.dataset.registrationId);
    if (registration && !locked && canManageEvent(event)) openEventRegistrationForm(event, registration);
  }));
  $('#add-budget-line')?.addEventListener('click', () => openEventBudgetLineForm(event));
  $('#view').querySelectorAll('[data-budget-line]').forEach((button) => button.addEventListener('click', () => {
    const line = eventRows('eventBudgetLines', businessIdOf(event)).find((item) => item.id === button.dataset.budgetLine);
    if (line && !locked) openEventBudgetLineForm(event, line);
  }));
  $('#add-event-allocation')?.addEventListener('click', () => openEventFinanceAllocationForm(event));
  $('#event-close-settlement')?.addEventListener('click', async () => {
    if (!confirm('Зафиксировать расчёт? После этого участники, план и финансовые связи станут неизменяемыми.')) return;
    const result = await S.store.closeEventSettlement(S.token, event.id);
    if (!result.ok) { toast(result.error || 'Не удалось зафиксировать расчёт', true); return; }
    toast('Расчёт зафиксирован'); await refresh(true); location.hash = eventHash(event.id, tab);
  });
}

function openEventTypeManager() {
  const targetBusinessId = moduleBusinessId('events');
  const types = eventRows('eventTypes', targetBusinessId);
  openModal(`<div class="crm-modal-heading"><div><h2>Типы событий</h2><p class="muted small">Тип задаёт базовый взнос, ставку сотрудника и доли прибыли.</p></div><button class="btn primary" id="add-event-type">+ Тип</button></div>
    <div class="list">${types.length ? types.map((type) => `<button class="row-card" data-event-type="${type.id}"><span class="grow col"><b>${esc(type.name)}</b><small>${type.active === false ? 'выключен' : 'активен'} · взнос ${money(type.defaultFee)}</small></span><span>Изменить</span></button>`).join('') : '<div class="empty">Типов событий пока нет</div>'}</div><div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#add-event-type', root).addEventListener('click', () => openEventTypeForm(null, targetBusinessId));
    root.querySelectorAll('[data-event-type]').forEach((button) => button.addEventListener('click', () => openEventTypeForm(types.find((type) => type.id === button.dataset.eventType), targetBusinessId)));
  });
}

function openEventTypeForm(type, forcedBusinessId = '') {
  const isNew = !type;
  const businessId = businessIdOf(type) || forcedBusinessId || moduleBusinessId('events');
  const owners = (S.data.businessOwners || []).filter((owner) => businessIdOf(owner) === businessId && owner.active !== false);
  const shares = new Map((type?.ownerShares || []).map((share) => [share.ownerId, Number(share.share || 0)]));
  openModal(`<h2>${isNew ? 'Новый тип события' : esc(type.name)}</h2><form id="event-type-form">
    <label class="field"><span>Название</span><input name="name" required value="${esc(type?.name || '')}"></label>
    <div class="form-row"><label class="field"><span>Взнос по умолчанию, ₽</span><input name="defaultFee" type="number" min="0" step="0.01" value="${Number(type?.defaultFee || 0)}"></label><label class="field"><span>Ставка сотрудника за участника, ₽</span><input name="staffRate" type="number" min="0" step="0.01" value="${Number(type?.staffRate || 0)}"></label></div>
    <label class="checkline"><input name="active" type="checkbox" ${type?.active !== false ? 'checked' : ''}><span>Тип доступен для новых событий</span></label>
    <div class="section-title">Доли прибыли</div><div class="owner-grid">${owners.map((owner) => `<label class="field owner-share"><span>${esc(owner.name || owner.ownerId)}</span><div class="suffix-input"><input type="number" min="0" max="100" step="0.01" data-event-owner="${owner.ownerId}" data-owner-name="${esc(owner.name || '')}" value="${(shares.has(owner.ownerId) ? shares.get(owner.ownerId) : Number(owner.share || 0)) * 100}"><span>%</span></div></label>`).join('') || '<p class="muted small">Сначала добавьте участников бизнеса в настройках.</p>'}</div>
    <div class="actions">${!isNew ? '<button class="btn danger ghost left" type="button" id="event-type-delete">Удалить</button>' : ''}<button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#event-type-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить этот тип события?')) return; const result = await doDelete('eventTypes', type.id, 'Тип удалён'); if (result) { closeModal(); render(); } });
    $('#event-type-form', root).addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault(); const form = submitEvent.currentTarget;
      const inputs = [...form.querySelectorAll('[data-event-owner]')];
      const total = inputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
      if (inputs.length && Math.abs(total - 100) > 0.01) { toast('Доли должны в сумме давать 100%', true); return; }
      const ownerShares = inputs.filter((input) => Number(input.value) > 0).map((input) => ({ ownerId: input.dataset.eventOwner, name: input.dataset.ownerName, share: Number(input.value) / 100 }));
      const item = { ...(type || {}), businessId, unit: businessId, name: form.elements.name.value.trim(), defaultFee: Number(form.elements.defaultFee.value || 0), staffRate: Number(form.elements.staffRate.value || 0), active: form.elements.active.checked, ownerShares };
      const result = isNew ? await doCreate('eventTypes', item, 'Тип создан') : await doUpdate('eventTypes', item, 'Тип сохранён');
      if (result) { closeModal(); render(); }
    });
  });
}

function openEventForm(event, forcedBusinessId = '') {
  const isNew = !event;
  const eventBusinesses = myUnits().filter((id) => businessHasModule(business(id), 'events'));
  const businessId = businessIdOf(event) || forcedBusinessId || (S.unit !== 'all' && eventBusinesses.includes(S.unit) ? S.unit : eventBusinesses[0]);
  const types = eventRows('eventTypes', businessId).filter((type) => type.active !== false || type.id === event?.eventTypeId);
  if (!types.length) { toast('Сначала создайте тип события', true); if (isAdmin()) openEventTypeManager(); return; }
  const selectedType = types.find((type) => type.id === event?.eventTypeId) || types[0];
  const venues = (S.data.venues || []).filter((venue) => businessIdOf(venue) === businessId);
  const employees = (S.data.employees || []).filter((employee) => employeeBusinessIds(employee).includes(businessId));
  openModal(`<h2>${isNew ? 'Новое событие' : esc(event.title)}</h2><form id="event-form">
    ${isNew && eventBusinesses.length > 1 ? `<label class="field"><span>Бизнес</span><select name="businessId">${eventBusinesses.map((id) => `<option value="${id}" ${id === businessId ? 'selected' : ''}>${esc(businessName(id))}</option>`).join('')}</select></label>` : ''}
    <label class="field"><span>Название</span><input name="title" required value="${esc(event?.title || '')}"></label>
    <div class="form-row"><label class="field"><span>Тип</span><select name="eventTypeId" ${!isAdmin() && !isNew ? 'disabled' : ''}>${types.map((type) => `<option value="${type.id}" ${type.id === (event?.eventTypeId || selectedType.id) ? 'selected' : ''}>${esc(type.name)}</option>`).join('')}</select></label><label class="field"><span>Статус</span><select name="status">${Object.entries(EVENT_STATUS).map(([id, status]) => `<option value="${id}" ${id === (event?.status || 'planned') ? 'selected' : ''}>${status.name}</option>`).join('')}</select></label></div>
    <div class="form-row"><label class="field"><span>Начало</span><input name="startsAt" type="datetime-local" required value="${esc(String(event?.startsAt || '').slice(0, 16))}"></label><label class="field"><span>Окончание</span><input name="endsAt" type="datetime-local" value="${esc(String(event?.endsAt || '').slice(0, 16))}"></label></div>
    <div class="form-row">${isAdmin() ? `<label class="field"><span>Ответственный</span><select name="responsibleId"><option value="">— не выбран —</option>${employees.map((employee) => `<option value="${employee.id}" ${employee.id === event?.responsibleId ? 'selected' : ''}>${esc(employee.name)}</option>`).join('')}</select></label>` : ''}<label class="field"><span>Вместимость</span><input name="capacity" type="number" min="0" step="1" value="${Number(event?.capacity || 0)}"></label>${isAdmin() ? `<label class="field"><span>Стоимость участия, ₽</span><input name="defaultFee" type="number" min="0" step="0.01" value="${Number(event?.defaultFee ?? selectedType.defaultFee ?? 0)}"></label>` : ''}</div>
    <div class="form-row"><label class="field"><span>Площадка — текст</span><input name="locationName" value="${esc(event?.locationName || '')}" placeholder="Любое место"></label><label class="field"><span>Ресурс</span><input name="resourceName" value="${esc(event?.resourceName || '')}" placeholder="Зал, кабинет, машина…"></label></div>
    ${venues.length ? `<label class="field"><span>Связать со справочником площадок (необязательно)</span><select name="venueId"><option value="">— без ссылки —</option>${venues.map((venue) => `<option value="${venue.id}" ${venue.id === event?.venueId ? 'selected' : ''}>${esc(venue.name)}</option>`).join('')}</select></label>` : ''}
    <label class="field"><span>Описание</span><textarea name="description">${esc(event?.description || '')}</textarea></label>
    <div class="actions">${!isNew && canManageEvent(event) ? '<button class="btn danger ghost left" type="button" id="event-delete">Удалить</button>' : ''}<button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    const businessSelect = $('#event-form', root).elements.businessId;
    businessSelect?.addEventListener('change', () => openEventForm(null, businessSelect.value));
    const form = $('#event-form', root);
    form.elements.eventTypeId.addEventListener('change', () => {
      if (!isNew) return;
      const selected = types.find((type) => type.id === form.elements.eventTypeId.value);
      if (form.elements.defaultFee) form.elements.defaultFee.value = Number(selected?.defaultFee || 0);
    });
    $('#event-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить это событие?')) return; const result = await doDelete('events', event.id, 'Событие удалено'); if (result) { closeModal(); location.hash = eventHash(); } });
    $('#event-form', root).addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault(); const form = submitEvent.currentTarget;
      const item = { ...(isNew ? {} : { id: event.id }), businessId, unit: businessId, title: form.elements.title.value.trim(), eventTypeId: isAdmin() || isNew ? form.elements.eventTypeId.value : event.eventTypeId, status: form.elements.status.value, startsAt: form.elements.startsAt.value, endsAt: form.elements.endsAt.value, capacity: Number(form.elements.capacity.value || 0), locationName: form.elements.locationName.value.trim(), resourceName: form.elements.resourceName.value.trim(), venueId: form.elements.venueId?.value || '', description: form.elements.description.value.trim() };
      if (isAdmin()) { item.responsibleId = form.elements.responsibleId.value; item.defaultFee = Number(form.elements.defaultFee.value || 0); }
      const result = isNew ? await doCreate('events', item, 'Событие создано') : await doUpdate('events', item, 'Событие сохранено');
      if (result) { if (!isAdmin()) await refresh(true); closeModal(); location.hash = eventHash(result.item?.id || event.id); }
    });
  });
}

function openEventRegistrationForm(event, registration) {
  const isNew = !registration; const businessId = businessIdOf(event);
  const options = [
    ...(S.data.players || []).filter((item) => businessIdOf(item) === businessId).map((item) => ({ type: 'player', id: item.id, name: item.name })),
    ...(S.data.companies || []).filter((item) => businessIdOf(item) === businessId && !item.legacy).map((item) => ({ type: 'company', id: item.id, name: item.name })),
    ...(S.data.contacts || []).filter((item) => businessIdOf(item) === businessId).map((item) => ({ type: 'contact', id: item.id, name: item.name })),
  ];
  if (!options.length) { toast('Сначала добавьте игрока, контрагента или контакт в этом бизнесе', true); return; }
  const currentRef = registration ? `${registration.participantType}:${registration.participantId}` : '';
  openModal(`<h2>${isNew ? 'Добавить участника' : esc(eventParticipant(registration))}</h2><form id="event-registration-form"><label class="field"><span>Участник</span><select name="participantRef" required>${options.map((option) => `<option value="${option.type}:${option.id}" ${`${option.type}:${option.id}` === currentRef ? 'selected' : ''}>${PARTICIPANT_LABEL[option.type]} · ${esc(option.name)}</option>`).join('')}</select></label><div class="form-row"><label class="field"><span>Статус</span><select name="status">${Object.entries(REGISTRATION_STATUS).map(([id, status]) => `<option value="${id}" ${id === (registration?.status || 'registered') ? 'selected' : ''}>${status.name}</option>`).join('')}</select></label>${isAdmin() ? `<label class="field"><span>Начислено, ₽</span><input name="chargeAmount" type="number" min="0" step="0.01" value="${Number(registration?.chargeAmount ?? event.defaultFee ?? 0)}"></label>` : ''}</div><label class="field"><span>Результат или примечание</span><textarea name="note">${esc(registration?.note || '')}</textarea></label><div class="actions">${!isNew ? '<button class="btn danger ghost left" type="button" id="registration-delete">Удалить</button>' : ''}<button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#registration-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить регистрацию участника?')) return; const result = await doDelete('eventRegistrations', registration.id, 'Участник удалён'); if (result) { closeModal(); location.hash = eventHash(event.id, 'participants'); } });
    $('#event-registration-form', root).addEventListener('submit', async (submitEvent) => { submitEvent.preventDefault(); const form = submitEvent.currentTarget; const [participantType, participantId] = form.elements.participantRef.value.split(':'); const item = { ...(isNew ? {} : { id: registration.id }), businessId, unit: businessId, eventId: event.id, participantType, participantId, status: form.elements.status.value, note: form.elements.note.value.trim() }; if (isAdmin()) item.chargeAmount = Number(form.elements.chargeAmount.value || 0); const result = isNew ? await doCreate('eventRegistrations', item, 'Участник добавлен') : await doUpdate('eventRegistrations', item, 'Регистрация сохранена'); if (result) { if (!isAdmin()) await refresh(true); closeModal(); location.hash = eventHash(event.id, 'participants'); } });
  });
}

function openEventBudgetLineForm(event, line) {
  const isNew = !line; const businessId = businessIdOf(event);
  openModal(`<h2>${isNew ? 'Строка плана' : esc(line.name)}</h2><form id="event-budget-form"><label class="field"><span>Название</span><input name="name" required value="${esc(line?.name || '')}"></label><div class="form-row"><label class="field"><span>Направление</span><select name="direction"><option value="income" ${line?.direction === 'income' ? 'selected' : ''}>Доход</option><option value="expense" ${line?.direction !== 'income' ? 'selected' : ''}>Расход</option></select></label><label class="field"><span>Плановая сумма, ₽</span><input name="plannedAmount" type="number" min="0" step="0.01" value="${Number(line?.plannedAmount || 0)}"></label></div><label class="field"><span>Категория</span><input name="category" value="${esc(line?.category || '')}"></label><label class="field"><span>Комментарий</span><textarea name="note">${esc(line?.note || '')}</textarea></label><div class="actions">${!isNew ? '<button class="btn danger ghost left" type="button" id="budget-delete">Удалить</button>' : ''}<button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary">Сохранить</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#budget-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить строку плана?')) return; const result = await doDelete('eventBudgetLines', line.id, 'Строка удалена'); if (result) { closeModal(); location.hash = eventHash(event.id, 'economy'); } });
    $('#event-budget-form', root).addEventListener('submit', async (submitEvent) => { submitEvent.preventDefault(); const form = submitEvent.currentTarget; const item = { ...(line || {}), businessId, unit: businessId, eventId: event.id, name: form.elements.name.value.trim(), direction: form.elements.direction.value, plannedAmount: Number(form.elements.plannedAmount.value || 0), category: form.elements.category.value.trim(), note: form.elements.note.value.trim() }; const result = isNew ? await doCreate('eventBudgetLines', item, 'Строка добавлена') : await doUpdate('eventBudgetLines', item, 'Строка сохранена'); if (result) { closeModal(); location.hash = eventHash(event.id, 'economy'); } });
  });
}

function openEventFinanceAllocationForm(event) {
  const businessId = businessIdOf(event); const key = `event:${event.id}:${uid()}`;
  const allocations = eventRows('eventFinanceAllocations', businessId);
  const allocated = (financeId) => allocations.filter((item) => item.financeId === financeId).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const operations = (S.data.finance || []).filter((item) => businessIdOf(item) === businessId && Number(item.amount || 0) - allocated(item.id) > 0.009);
  const registrations = eventRows('eventRegistrations', businessId).filter((item) => item.eventId === event.id);
  const lines = eventRows('eventBudgetLines', businessId).filter((item) => item.eventId === event.id);
  if (!operations.length) { toast('Нет финансовых операций с нераспределённым остатком', true); return; }
  openModal(`<h2>Привязать финансовую операцию</h2><p class="muted small">Новая денежная операция не создаётся. Связь после сохранения нельзя изменить или удалить.</p><form id="event-allocation-form"><label class="field"><span>Операция</span><select name="financeId">${operations.map((operation) => `<option value="${operation.id}">${fmtDate(operation.date)} · ${operation.type === 'income' ? 'приход' : 'расход'} · ${esc(operation.category || '')} · остаток ${money(Number(operation.amount) - allocated(operation.id))}</option>`).join('')}</select></label><div class="form-row"><label class="field"><span>Назначение</span><select name="purpose"><option value="payment">Оплата участия</option><option value="deposit">Депозит участника (приход)</option><option value="expense">Прямой расход</option><option value="refund">Возврат участнику</option></select></label><label class="field"><span>Сумма, ₽</span><input name="amount" type="number" min="0.01" step="0.01" required></label></div><label class="field"><span>Участник (обязательно для оплаты, депозита и возврата)</span><select name="registrationId"><option value="">— без участника —</option>${registrations.map((registration) => `<option value="${registration.id}">${esc(eventParticipant(registration))}</option>`).join('')}</select></label><label class="field"><span>Строка плана</span><select name="budgetLineId"><option value="">— без строки —</option>${lines.map((line) => `<option value="${line.id}">${esc(line.name)}</option>`).join('')}</select></label><div class="actions"><button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">Связать навсегда</button></div></form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#event-allocation-form', root).addEventListener('submit', async (submitEvent) => { submitEvent.preventDefault(); const form = submitEvent.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; const item = { businessId, unit: businessId, eventId: event.id, financeId: form.elements.financeId.value, registrationId: form.elements.registrationId.value, budgetLineId: form.elements.budgetLineId.value, purpose: form.elements.purpose.value, amount: Number(form.elements.amount.value), idempotencyKey: key }; const result = await S.store.allocateEventFinance(S.token, item); if (!result.ok) { submit.disabled = false; toast(result.error || 'Не удалось связать операцию', true); return; } closeModal(); toast(result.alreadyAllocated ? 'Связь уже была сохранена' : 'Операция связана'); await refresh(true); location.hash = eventHash(event.id, 'economy'); });
  });
}

// ---------- Площадки (падел) ----------
function viewVenues() {
  setTitle('Площадки');
  const list = (S.data.venues || []).filter(inActiveBusiness);
  $('#view').innerHTML = `
    <div class="searchbar"><div class="grow"></div><button class="btn primary" id="add-venue">+ Площадка</button></div>
    <div class="list">
      ${list.length ? list.map((v) => {
        const st = CLIENT_STATUSES.venue.find((s) => s.id === v.status) || CLIENT_STATUSES.venue[0];
        return `<div class="row-card" data-venue="${v.id}">
          <div class="grow col">
            <div class="title">${esc(v.name)}</div>
            <div class="sub">${esc(v.address || '')}${v.price ? ' · ' + esc(v.price) : ''}</div>
          </div>
          <span class="badge ${st.color} dot">${st.name}</span>
        </div>`;
      }).join('') : `<div class="card empty"><div class="big">🏟️</div>Площадок пока нет</div>`}
    </div>`;
  $('#add-venue').addEventListener('click', () => openVenueForm());
  $('#view').querySelectorAll('[data-venue]').forEach((el) => el.addEventListener('click', () => openVenueForm((S.data.venues || []).find((v) => v.id === el.dataset.venue))));
}

function openVenueForm(v) {
  const isNew = !v;
  const targetBusinessId = moduleBusinessId('venues', v);
  openModal(`
    <h2>${isNew ? 'Новая площадка' : esc(v.name)}</h2>
    <form id="ent-form">
      <label class="field"><span>Название</span><input type="text" name="name" required value="${esc(v?.name || '')}"></label>
      <label class="field"><span>Адрес</span><input type="text" name="address" value="${esc(v?.address || '')}"></label>
      <div class="form-row">
        <label class="field"><span>Контактное лицо</span><input type="text" name="contact" value="${esc(v?.contact || '')}"></label>
        <label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(v?.phone || '')}"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Цена аренды</span><input type="text" name="price" value="${esc(v?.price || '')}" placeholder="3500 ₽/час"></label>
        <label class="field"><span>Статус</span>
          <select name="status">${CLIENT_STATUSES.venue.map((s) => `<option value="${s.id}" ${(v?.status || 'talks') === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field"><span>Заметки</span><textarea name="notes">${esc(v?.notes || '')}</textarea></label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        ${!isNew ? `<button type="button" class="btn" id="open-courts">📅 Корты</button>` : ''}
        ${v?.phone ? `<a class="btn" href="${telHref(v.phone)}">📞 Позвонить</a>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => {
    bindEntityForm(root, 'venues', v, { unit: targetBusinessId });
    $('#open-courts', root)?.addEventListener('click', () => openCourts(v.id, 0));
  });
}

// ---------- Корты: недельная сетка брони (будни, 18:00–23:00) ----------
const SLOT_TAGS = [
  { id: 'booked', name: 'Забронировано', short: 'бронь', cls: 'booked' },
  { id: 'free', name: 'Свободно', short: 'своб.', cls: 'free' },
  { id: 'busy', name: 'Занято', short: 'занято', cls: 'busy' },
  { id: 'want', name: 'Хотелось бы', short: 'хотим', cls: 'want' }
];
const COURT_HOURS = [18, 19, 20, 21, 22];

function mondayOf(weekOffset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weekOffset * 7);
  return d;
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function openCourts(venueId, week = 0) {
  const v = (S.data.venues || []).find((x) => x.id === venueId);
  if (!v) { closeModal(); return; }
  const slots = v.slots || {};
  const mon = mondayOf(week);
  const days = [0, 1, 2, 3, 4].map((i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
  const todayIso = today();

  const cells = COURT_HOURS.map((h) => `
    <div class="time-label">${h}:00</div>
    ${days.map((d) => {
      const key = `${isoDay(d)}_${h}`;
      const s = slots[key];
      const tag = s ? SLOT_TAGS.find((t) => t.id === s.tag) : null;
      return `<div class="slot ${tag ? tag.cls : ''}" data-slot="${key}">
        ${tag ? tag.short : ''}
        ${s?.price ? `<span class="price">${new Intl.NumberFormat('ru-RU').format(s.price)}₽</span>` : ''}
      </div>`;
    }).join('')}`).join('');

  openModal(`
    <h2>📅 Корты — ${esc(v.name)}</h2>
    <div class="searchbar" style="margin-bottom:2px">
      <button class="btn small" id="w-prev">←</button>
      <span class="btn small ghost nowrap" style="cursor:default">${fmtDate(isoDay(days[0]))} – ${fmtDate(isoDay(days[4]))}</span>
      <button class="btn small" id="w-next">→</button>
      ${week !== 0 ? `<button class="btn small" id="w-today">сегодня</button>` : ''}
    </div>
    <div class="courts-grid">
      <div></div>
      ${days.map((d, i) => `<div class="head ${isoDay(d) === todayIso ? '' : ''}">${dayNames[i]}<b>${d.getDate()}</b></div>`).join('')}
      ${cells}
    </div>
    <div class="legend">
      ${SLOT_TAGS.map((t) => `<span><i class="slot ${t.cls}" style="padding:0;min-height:10px"></i>${t.name}</span>`).join('')}
    </div>
    <p class="muted small">Нажмите на ячейку, чтобы отметить статус и цену.</p>
    <div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#w-prev', root).addEventListener('click', () => openCourts(venueId, week - 1));
    $('#w-next', root).addEventListener('click', () => openCourts(venueId, week + 1));
    $('#w-today', root)?.addEventListener('click', () => openCourts(venueId, 0));
    root.querySelectorAll('[data-slot]').forEach((el) => el.addEventListener('click', () => openSlotEditor(venueId, week, el.dataset.slot)));
  });
}

function openSlotEditor(venueId, week, key) {
  const v = (S.data.venues || []).find((x) => x.id === venueId);
  if (!v) { closeModal(); return; }
  const cur = (v.slots || {})[key];
  const [dateIso, hour] = key.split('_');
  openModal(`
    <h2>${fmtDate(dateIso)}, ${hour}:00–${Number(hour) + 1}:00</h2>
    <p class="muted small">${esc(v.name)}${v.price ? ` · обычная цена: ${esc(v.price)}` : ''}</p>
    <label class="field"><span>Цена за этот час, ₽ (пусто — как обычно)</span>
      <input type="number" id="slot-price" value="${esc(cur?.price || '')}" placeholder="${esc(String(v.price || '').replace(/[^\d]/g, ''))}">
    </label>
    <div class="slot-pick">
      ${SLOT_TAGS.map((t) => `<button class="slot ${t.cls}" data-tag="${t.id}">${cur?.tag === t.id ? '✓ ' : ''}${t.name}</button>`).join('')}
    </div>
    <div class="actions">
      ${cur ? `<button class="btn danger ghost left" id="slot-clear">Очистить</button>` : ''}
      <button class="btn" id="slot-back">← Назад</button>
    </div>
  `, (root) => {
    const save = async (slotsMutator) => {
      const fresh = (S.data.venues || []).find((x) => x.id === venueId);
      const slots = { ...(fresh?.slots || {}) };
      slotsMutator(slots);
      await doUpdate('venues', { ...fresh, slots });
      openCourts(venueId, week);
    };
    root.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => {
      const price = Number($('#slot-price', root).value) || '';
      save((slots) => { slots[key] = { tag: b.dataset.tag, price }; });
    }));
    $('#slot-clear', root)?.addEventListener('click', () => save((slots) => { delete slots[key]; }));
    $('#slot-back', root).addEventListener('click', () => openCourts(venueId, week));
  });
}

// ---------- Игроки (падел) ----------
function viewPlayers() {
  setTitle('Игроки');
  const q = (S.search.players || '').toLowerCase();
  const scopedPlayers = (S.data.players || []).filter(inActiveBusiness);
  const list = scopedPlayers.filter((p) => !q || (p.name + ' ' + (p.phone || '')).toLowerCase().includes(q));
  $('#view').innerHTML = `
    <div class="searchbar">
      <input type="search" id="pl-search" placeholder="Поиск игрока" value="${esc(S.search.players || '')}">
      ${activeUnits().includes('padel') ? '<button class="btn" id="import-players">📥 Импорт в «Падел»</button>' : ''}
      <button class="btn primary" id="add-player">+ Игрок</button>
    </div>
    <div class="muted small" style="margin-bottom:10px">Всего: ${scopedPlayers.length}</div>
    <div class="list">
      ${list.length ? list.map((p) => `
        <div class="row-card" data-player="${p.id}">
          <div class="grow col">
            <div class="title">${esc(p.name)}</div>
            <div class="sub">${esc(p.phone || 'без телефона')}${p.notes ? ' · ' + esc(p.notes) : ''}</div>
          </div>
          ${p.level ? `<span class="badge blue">${esc(p.level)}</span>` : ''}
        </div>`).join('') : `<div class="card empty"><div class="big">🎾</div>Игроков пока нет — добавьте или импортируйте из Excel</div>`}
    </div>`;
  $('#pl-search').addEventListener('input', (e) => { S.search.players = e.target.value; viewPlayers(); });
  $('#add-player').addEventListener('click', () => openPlayerForm());
  $('#import-players')?.addEventListener('click', openImportPlayers);
  $('#view').querySelectorAll('[data-player]').forEach((el) => el.addEventListener('click', () => openPlayerForm((S.data.players || []).find((p) => p.id === el.dataset.player))));
}

function openPlayerForm(p) {
  const isNew = !p;
  const targetBusinessId = moduleBusinessId('players', p);
  openModal(`
    <h2>${isNew ? 'Новый игрок' : esc(p.name)}</h2>
    <form id="ent-form">
      <label class="field"><span>Имя</span><input type="text" name="name" required value="${esc(p?.name || '')}"></label>
      <div class="form-row">
        <label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(p?.phone || '')}"></label>
        <label class="field"><span>Уровень</span><input type="text" name="level" value="${esc(p?.level || '')}" placeholder="например, C+"></label>
      </div>
      <label class="field"><span>Заметки</span><textarea name="notes">${esc(p?.notes || '')}</textarea></label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        ${p?.phone ? `<a class="btn" href="${telHref(p.phone)}">📞</a>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => bindEntityForm(root, 'players', p, { unit: targetBusinessId }));
}

function openImportPlayers() {
  openModal(`
    <h2>Импорт игроков из Excel</h2>
    <p class="muted small">Выделите в Excel колонки <b>Имя · Телефон · Уровень · Заметки</b> (имя обязательно, порядок именно такой), скопируйте и вставьте сюда. Дубликаты по имени+телефону пропустим.</p>
    <label class="field"><textarea id="import-text" style="min-height:140px" placeholder="Андрей Соколов	+79051111111	C	играет по субботам"></textarea></label>
    <div class="muted small" id="import-preview"></div>
    <div class="actions">
      <button type="button" class="btn" id="modal-cancel">Отмена</button>
      <button type="button" class="btn primary" id="import-go">Импортировать</button>
    </div>
  `, (root) => {
    const parse = () => $('#import-text', root).value.split('\n').map((line) => {
      const cols = line.includes('\t') ? line.split('\t') : line.split(';');
      const [name, phone, level, ...rest] = cols.map((c) => c.trim());
      return name ? { name, phone: phone || '', level: level || '', notes: rest.join(' ') } : null;
    }).filter(Boolean);
    $('#import-text', root).addEventListener('input', () => {
      $('#import-preview', root).textContent = `К импорту: ${parse().length} игроков`;
    });
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#import-go', root).addEventListener('click', async () => {
      const rows = parse();
      if (!rows.length) { toast('Нечего импортировать', true); return; }
      toast('Импортирую…');
      const res = await S.store.importPlayers(S.token, rows);
      if (!res.ok) { toast(res.error || 'Ошибка', true); return; }
      toast(`Добавлено: ${res.added}`);
      closeModal();
      refresh(true);
    });
  });
}

// ---------- Склад ----------
const STOCK_TABS = [
  ['catalog', 'Каталог'], ['balances', 'Остатки'], ['movements', 'Движения'], ['inventories', 'Инвентаризации']
];
const STOCK_MOVEMENT_LABELS = { receipt: 'Приход', expense: 'Расход', transfer: 'Перемещение', inventory: 'Инвентаризация' };

function stockUnits() {
  return activeUnits().filter((id) => businessHasModule(business(id), 'stock'));
}

function stockRows(entity) {
  const units = stockUnits();
  return (S.data?.[entity] || []).filter((item) => units.includes(businessIdOf(item)));
}

function stockItemName(id) {
  return (S.data?.stockItems || []).find((item) => item.id === id)?.name || 'Удалённая позиция';
}

function warehouseName(id) {
  return (S.data?.warehouses || []).find((item) => item.id === id)?.name || 'Удалённый склад';
}

function stockBalance(warehouseId, stockItemId) {
  return (S.data?.stockBalances || []).find((item) => item.warehouseId === warehouseId && item.stockItemId === stockItemId);
}

function stockBusinessSelect(targetBusinessId, disabled = false) {
  const units = stockUnits();
  if (units.length < 2) return `<input type="hidden" name="unit" value="${esc(targetBusinessId || units[0] || '')}">`;
  return `<label class="field"><span>Бизнес</span><select name="unit" ${disabled ? 'disabled' : ''}>
    ${units.map((id) => `<option value="${id}" ${id === targetBusinessId ? 'selected' : ''}>${esc(businessEmoji(id))} ${esc(businessName(id))}</option>`).join('')}
  </select></label>`;
}

function stockScopeTag(item) {
  return stockUnits().length > 1 ? `<span class="badge">${esc(businessEmoji(businessIdOf(item)))} ${esc(businessName(businessIdOf(item)))}</span>` : '';
}

async function stockCreate(entity, item, message) {
  const result = await S.store.create(S.token, entity, item);
  if (!result.ok) { toast(result.error || 'Ошибка', true); return null; }
  if (message) toast(message);
  await refresh(true);
  return result;
}

async function stockUpdate(entity, item, message) {
  const result = await S.store.update(S.token, entity, item);
  if (!result.ok) { toast(result.error || 'Ошибка', true); return null; }
  if (message) toast(message);
  await refresh(true);
  return result;
}

function viewStock() {
  setTitle('Склад');
  if (!hasModule('stock')) { location.hash = '#/dashboard'; return; }
  const tab = S.stockTab || 'catalog';
  const warehouses = stockRows('warehouses');
  const items = stockRows('stockItems');
  const balances = stockRows('stockBalances');
  const movements = stockRows('stockMovements').sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.created || 0) - Number(a.created || 0));
  const inventories = stockRows('inventories').sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
  const totalQuantity = balances.reduce((sum, balance) => sum + Number(balance.quantity || 0), 0);
  const lowCount = items.filter((item) => {
    const total = balances.filter((balance) => balance.stockItemId === item.id).reduce((sum, balance) => sum + Number(balance.quantity || 0), 0);
    return item.active !== false && Number(item.minStock || 0) > 0 && total <= Number(item.minStock);
  }).length;

  let content = '';
  if (tab === 'catalog') content = stockCatalogHtml(warehouses, items, balances);
  if (tab === 'balances') content = stockBalancesHtml(warehouses, items);
  if (tab === 'movements') content = stockMovementsHtml(movements);
  if (tab === 'inventories') content = stockInventoriesHtml(inventories);

  $('#view').innerHTML = `
    <div class="cards-row stock-summary">
      <div class="card stat"><span class="label">Позиций</span><span class="value">${items.filter((item) => item.active !== false).length}</span><span class="hint">в каталоге</span></div>
      <div class="card stat"><span class="label">Складов</span><span class="value">${warehouses.filter((item) => item.active !== false).length}</span><span class="hint">доступно для операций</span></div>
      <div class="card stat"><span class="label">Единиц на остатке</span><span class="value">${new Intl.NumberFormat('ru-RU').format(totalQuantity)}</span><span class="hint">по всем складам</span></div>
      <div class="card stat"><span class="label">Нужно пополнить</span><span class="value ${lowCount ? 'red' : 'green'}">${lowCount}</span><span class="hint">ниже минимума</span></div>
    </div>
    <div class="stock-actions">
      <button class="btn" id="add-warehouse">+ Склад</button>
      <button class="btn" id="add-stock-item">+ Позиция</button>
      <span class="stock-actions-spacer"></span>
      <button class="btn primary" id="stock-receipt">↓ Приход</button>
      <button class="btn" id="stock-expense">↑ Расход</button>
      <button class="btn" id="stock-transfer">⇄ Перемещение</button>
      <button class="btn" id="stock-inventory">≡ Инвентаризация</button>
    </div>
    <div class="chip-row stock-tabs" id="stock-tabs">
      ${STOCK_TABS.map(([id, label]) => `<button class="chip ${tab === id ? 'active' : ''}" data-stock-tab="${id}">${label}</button>`).join('')}
    </div>
    ${content}`;

  $('#view').querySelectorAll('[data-stock-tab]').forEach((button) => button.addEventListener('click', () => { S.stockTab = button.dataset.stockTab; viewStock(); }));
  $('#add-warehouse').addEventListener('click', () => openWarehouseForm());
  $('#add-stock-item').addEventListener('click', () => openStockItemForm());
  $('#stock-receipt').addEventListener('click', () => openStockMovementForm('receipt'));
  $('#stock-expense').addEventListener('click', () => openStockMovementForm('expense'));
  $('#stock-transfer').addEventListener('click', () => openStockMovementForm('transfer'));
  $('#stock-inventory').addEventListener('click', () => openInventoryForm());
  $('#view').querySelectorAll('[data-warehouse]').forEach((row) => row.addEventListener('click', () => openWarehouseForm((S.data.warehouses || []).find((item) => item.id === row.dataset.warehouse))));
  $('#view').querySelectorAll('[data-stock-item]').forEach((row) => row.addEventListener('click', () => openStockItemForm((S.data.stockItems || []).find((item) => item.id === row.dataset.stockItem))));
  $('#view').querySelectorAll('[data-inventory]').forEach((row) => row.addEventListener('click', () => openInventoryForm((S.data.inventories || []).find((item) => item.id === row.dataset.inventory))));
}

function stockCatalogHtml(warehouses, items, balances) {
  const itemRows = items.map((item) => {
    const quantity = balances.filter((balance) => balance.stockItemId === item.id).reduce((sum, balance) => sum + Number(balance.quantity || 0), 0);
    const low = item.active !== false && Number(item.minStock || 0) > 0 && quantity <= Number(item.minStock);
    return `<button class="stock-catalog-row ${item.active === false ? 'muted' : ''}" data-stock-item="${item.id}">
      <span class="stock-catalog-main"><strong>${esc(item.name)}</strong><small>${esc(item.sku || 'без артикула')} · ${esc(item.unitName)}</small></span>
      ${stockScopeTag(item)}<span class="stock-qty ${low ? 'low' : ''}">${quantity} ${esc(item.unitName)}</span>
    </button>`;
  }).join('');
  const warehouseRows = warehouses.map((warehouse) => `<button class="stock-catalog-row ${warehouse.active === false ? 'muted' : ''}" data-warehouse="${warehouse.id}">
    <span class="stock-catalog-main"><strong>${esc(warehouse.name)}</strong><small>${warehouse.active === false ? 'выключен' : 'работает'}</small></span>${stockScopeTag(warehouse)}
  </button>`).join('');
  return `<div class="stock-layout">
    <section class="card stock-panel"><div class="stock-panel-head"><h2>Номенклатура</h2><span>${items.length}</span></div>
      <div class="stock-catalog-list">${itemRows || '<div class="empty"><div class="big">📦</div>Позиции пока не добавлены</div>'}</div>
    </section>
    <section class="card stock-panel"><div class="stock-panel-head"><h2>Склады</h2><span>${warehouses.length}</span></div>
      <div class="stock-catalog-list">${warehouseRows || '<div class="empty"><div class="big">🏬</div>Склады пока не добавлены</div>'}</div>
    </section>
  </div>`;
}

function stockBalancesHtml(warehouses, items) {
  const activeWarehouses = warehouses.filter((item) => item.active !== false);
  const activeItems = items.filter((item) => item.active !== false);
  if (!activeWarehouses.length || !activeItems.length) return '<div class="card empty"><div class="big">📊</div>Сначала добавьте склад и позиции каталога</div>';
  const cards = activeItems.map((item) => {
    const rows = activeWarehouses.map((warehouse) => {
      const balance = stockBalance(warehouse.id, item.id);
      const quantity = Number(balance?.quantity || 0);
      const reserved = Number(balance?.reserved || 0);
      return `<div class="stock-balance-line"><span>${esc(warehouse.name)}</span><strong>${quantity}</strong>${reserved ? `<small>резерв ${reserved}</small>` : ''}</div>`;
    }).join('');
    const total = (S.data.stockBalances || []).filter((balance) => balance.stockItemId === item.id && activeWarehouses.some((warehouse) => warehouse.id === balance.warehouseId)).reduce((sum, balance) => sum + Number(balance.quantity || 0), 0);
    const low = Number(item.minStock || 0) > 0 && total <= Number(item.minStock);
    return `<article class="card stock-balance-card ${low ? 'stock-low' : ''}"><div class="stock-balance-title"><div><strong>${esc(item.name)}</strong><small>${esc(item.sku || item.unitName)}</small></div><span>${total} ${esc(item.unitName)}</span></div>${rows}${low ? `<div class="stock-warning">Ниже минимума ${esc(item.minStock)} ${esc(item.unitName)}</div>` : ''}</article>`;
  }).join('');
  return `<div class="stock-balance-grid">${cards}</div>`;
}

function stockMovementsHtml(movements) {
  if (!movements.length) return '<div class="card empty"><div class="big">↕️</div>Движений пока нет. Оформите первый приход.</div>';
  return `<div class="list">${movements.map((movement) => {
    const sign = movement.type === 'receipt' || (movement.type === 'inventory' && movement.direction === 'increase') ? '+'
      : movement.type === 'expense' || (movement.type === 'inventory' && movement.direction === 'decrease') ? '−' : '⇄';
    const place = movement.type === 'transfer' ? `${warehouseName(movement.fromWarehouseId)} → ${warehouseName(movement.toWarehouseId)}` : warehouseName(movement.warehouseId);
    const extra = movement.type === 'receipt' && movement.supplier ? ` · ${esc(movement.supplier)}` : movement.type === 'expense' && movement.reason ? ` · ${esc(movement.reason)}` : '';
    return `<div class="row-card stock-movement-row"><span class="stock-movement-sign ${sign === '+' ? 'plus' : sign === '−' ? 'minus' : ''}">${sign}</span>
      <div class="grow col"><div class="title">${esc(stockItemName(movement.stockItemId))}</div><div class="sub">${fmtDate(movement.date)} · ${esc(STOCK_MOVEMENT_LABELS[movement.type] || movement.type)} · ${esc(place)}${extra}${movement.note ? ` · ${esc(movement.note)}` : ''}</div></div>
      ${stockScopeTag(movement)}<div class="amount">${esc(movement.quantity)}</div></div>`;
  }).join('')}</div>`;
}

function stockInventoriesHtml(inventories) {
  if (!inventories.length) return '<div class="card empty"><div class="big">🧾</div>Инвентаризаций пока не было</div>';
  return `<div class="list">${inventories.map((inventory) => `<div class="row-card" data-inventory="${inventory.id}">
    <div class="grow col"><div class="title">${esc(warehouseName(inventory.warehouseId))}</div><div class="sub">${fmtDate(inventory.date)} · ${inventory.items?.length || 0} позиций${inventory.note ? ` · ${esc(inventory.note)}` : ''}</div></div>
    ${stockScopeTag(inventory)}<span class="badge ${inventory.status === 'completed' ? 'green' : 'amber'}">${inventory.status === 'completed' ? 'Завершена' : 'Черновик'}</span>
  </div>`).join('')}</div>`;
}

function openWarehouseForm(warehouse) {
  const isNew = !warehouse;
  const targetBusinessId = businessIdOf(warehouse) || moduleBusinessId('stock');
  openModal(`<h2>${isNew ? 'Новый склад' : esc(warehouse.name)}</h2><form id="warehouse-form">
    ${stockBusinessSelect(targetBusinessId, !isNew)}
    <label class="field"><span>Название</span><input type="text" name="name" required value="${esc(warehouse?.name || '')}" placeholder="Например, Основной склад"></label>
    <label class="field"><span>Статус</span><select name="active"><option value="true" ${warehouse?.active !== false ? 'selected' : ''}>Работает</option><option value="false" ${warehouse?.active === false ? 'selected' : ''}>Выключен</option></select></label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="warehouse-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button type="submit" class="btn primary">Сохранить</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#warehouse-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const unit = data.unit || targetBusinessId;
      const item = { ...(warehouse || {}), name: data.name.trim(), active: data.active === 'true', businessId: unit, unit };
      closeModal();
      if (isNew) await doCreate('warehouses', item, 'Склад добавлен'); else await doUpdate('warehouses', item, 'Склад сохранён');
    });
    $('#warehouse-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить склад?')) return; closeModal(); await doDelete('warehouses', warehouse.id, 'Склад удалён'); });
  });
}

function openStockItemForm(stockItem) {
  const isNew = !stockItem;
  const targetBusinessId = businessIdOf(stockItem) || moduleBusinessId('stock');
  openModal(`<h2>${isNew ? 'Новая позиция' : esc(stockItem.name)}</h2><form id="stock-item-form">
    ${stockBusinessSelect(targetBusinessId, !isNew)}
    <label class="field"><span>Название</span><input type="text" name="name" required value="${esc(stockItem?.name || '')}" placeholder="Например, Комплект медалей"></label>
    <div class="form-row"><label class="field"><span>Артикул</span><input type="text" name="sku" value="${esc(stockItem?.sku || '')}"></label><label class="field"><span>Единица</span><input type="text" name="unitName" required value="${esc(stockItem?.unitName || '')}" placeholder="штука, комплект"></label></div>
    <div class="form-row"><label class="field"><span>Себестоимость, ₽</span><input type="number" name="costPrice" required min="0" step="0.01" value="${esc(stockItem?.costPrice ?? 0)}"></label><label class="field"><span>Минимальный остаток</span><input type="number" name="minStock" required min="0" step="0.001" value="${esc(stockItem?.minStock ?? 0)}"></label></div>
    <label class="field"><span>Статус</span><select name="active"><option value="true" ${stockItem?.active !== false ? 'selected' : ''}>Используется</option><option value="false" ${stockItem?.active === false ? 'selected' : ''}>Выключена</option></select></label>
    <div class="actions">${!isNew ? '<button type="button" class="btn danger ghost left" id="stock-item-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">Отмена</button><button type="submit" class="btn primary">Сохранить</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#stock-item-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const unit = data.unit || targetBusinessId;
      const item = { ...(stockItem || {}), name: data.name.trim(), sku: data.sku.trim(), unitName: data.unitName.trim(), costPrice: Number(data.costPrice), minStock: Number(data.minStock), active: data.active === 'true', businessId: unit, unit };
      closeModal();
      if (isNew) await doCreate('stockItems', item, 'Позиция добавлена'); else await doUpdate('stockItems', item, 'Позиция сохранена');
    });
    $('#stock-item-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить позицию?')) return; closeModal(); await doDelete('stockItems', stockItem.id, 'Позиция удалена'); });
  });
}

function openStockMovementForm(type, forcedBusinessId = '') {
  const targetBusinessId = forcedBusinessId || moduleBusinessId('stock');
  const warehouses = (S.data.warehouses || []).filter((item) => businessIdOf(item) === targetBusinessId && item.active !== false);
  const items = (S.data.stockItems || []).filter((item) => businessIdOf(item) === targetBusinessId && item.active !== false);
  const finance = type === 'receipt' ? (S.data.finance || []).filter((item) => businessIdOf(item) === targetBusinessId && item.type === 'expense') : [];
  if (!warehouses.length || !items.length || (type === 'transfer' && warehouses.length < 2)) {
    toast(type === 'transfer' ? 'Для перемещения нужны позиция и два работающих склада' : 'Сначала добавьте работающий склад и позицию', true);
    return;
  }
  const warehouseOptions = warehouses.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  const title = STOCK_MOVEMENT_LABELS[type];
  openModal(`<h2>${esc(title)}</h2><form id="stock-movement-form">
    ${stockBusinessSelect(targetBusinessId)}
    <label class="field"><span>Позиция</span><select name="stockItemId" required>${items.map((item) => `<option value="${item.id}">${esc(item.name)} · ${esc(item.unitName)}</option>`).join('')}</select></label>
    ${type === 'transfer' ? `<div class="form-row"><label class="field"><span>Откуда</span><select name="fromWarehouseId">${warehouseOptions}</select></label><label class="field"><span>Куда</span><select name="toWarehouseId">${[...warehouses].reverse().map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('')}</select></label></div>` : `<label class="field"><span>Склад</span><select name="warehouseId">${warehouseOptions}</select></label>`}
    <div class="form-row"><label class="field"><span>Количество</span><input type="number" name="quantity" min="0.001" step="0.001" required></label><label class="field"><span>Дата</span><input type="date" name="date" value="${today()}" required></label></div>
    ${type === 'receipt' ? `<div class="form-row"><label class="field"><span>Поставщик</span><input type="text" name="supplier"></label><label class="field"><span>Сумма партии, ₽</span><input type="number" name="totalAmount" min="0" step="0.01"></label></div>
      ${finance.length ? `<label class="field"><span>Связать с расходом в финансах (необязательно)</span><select name="financeId"><option value="">Не связывать</option>${finance.map((item) => `<option value="${item.id}">${fmtDate(item.date)} · ${esc(item.counterparty || item.category || 'Расход')} · ${money(item.amount)}</option>`).join('')}</select></label>` : ''}` : ''}
    ${type === 'expense' ? '<div class="form-row"><label class="field"><span>Причина</span><select name="reason"><option value="event">На событие</option><option value="defect">Брак</option><option value="loss">Потеря</option><option value="gift">Подарок</option><option value="other">Другое</option></select></label><label class="field"><span>ID события, если есть</span><input type="text" name="eventId"></label></div>' : ''}
    <label class="field"><span>Комментарий</span><textarea name="note"></textarea></label>
    <div class="actions"><button type="button" class="btn" id="modal-cancel">Отмена</button><button type="submit" class="btn primary">Провести</button></div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    const unitSelect = $('[name=unit]', root);
    if (unitSelect?.tagName === 'SELECT') unitSelect.addEventListener('change', () => { closeModal(); openStockMovementForm(type, unitSelect.value); });
    $('#stock-movement-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const unit = data.unit || targetBusinessId;
      const item = { ...data, type, quantity: Number(data.quantity), totalAmount: data.totalAmount ? Number(data.totalAmount) : undefined, businessId: unit, unit };
      delete item.unitName;
      closeModal();
      await stockCreate('stockMovements', item, `${title} проведён`);
    });
  });
}

function openInventoryForm(inventory, forcedBusinessId = '') {
  const completed = inventory?.status === 'completed';
  const targetBusinessId = businessIdOf(inventory) || forcedBusinessId || moduleBusinessId('stock');
  const warehouses = (S.data.warehouses || []).filter((item) => businessIdOf(item) === targetBusinessId && item.active !== false);
  const items = (S.data.stockItems || []).filter((item) => businessIdOf(item) === targetBusinessId && item.active !== false);
  if (!inventory && (!warehouses.length || !items.length)) { toast('Сначала добавьте работающий склад и позиции', true); return; }
  const warehouseId = inventory?.warehouseId || warehouses[0]?.id;
  const actualByItem = new Map((inventory?.items || []).map((row) => [row.stockItemId, row.actualQuantity]));
  const rows = items.map((item) => `<label class="stock-count-row"><span><strong>${esc(item.name)}</strong><small>${esc(item.unitName)}</small></span><input type="number" name="actual:${item.id}" min="0" step="0.001" value="${esc(actualByItem.has(item.id) ? actualByItem.get(item.id) : Number(stockBalance(warehouseId, item.id)?.quantity || 0))}" ${completed ? 'disabled' : ''}></label>`).join('');
  openModal(`<h2>${completed ? 'Инвентаризация завершена' : inventory ? 'Черновик инвентаризации' : 'Новая инвентаризация'}</h2><form id="inventory-form">
    ${stockBusinessSelect(targetBusinessId, !!inventory)}
    <label class="field"><span>Склад</span><select name="warehouseId" ${completed ? 'disabled' : ''}>${warehouses.map((item) => `<option value="${item.id}" ${item.id === warehouseId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Дата</span><input type="date" name="date" value="${esc(inventory?.date || today())}" required ${completed ? 'disabled' : ''}></label>
    <div class="stock-count-list">${rows || '<div class="empty">Нет активных позиций</div>'}</div>
    <label class="field"><span>Комментарий</span><textarea name="note" ${completed ? 'disabled' : ''}>${esc(inventory?.note || '')}</textarea></label>
    <div class="actions">${inventory && !completed ? '<button type="button" class="btn danger ghost left" id="inventory-delete">Удалить</button>' : ''}<button type="button" class="btn" id="modal-cancel">${completed ? 'Закрыть' : 'Отмена'}</button>${!completed ? '<button type="submit" class="btn" data-inventory-status="draft">Сохранить черновик</button><button type="submit" class="btn primary" data-inventory-status="completed">Завершить</button>' : ''}</div>
  </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    if (completed) return;
    const businessSelect = $('[name=unit]', root);
    if (!inventory && businessSelect?.tagName === 'SELECT') businessSelect.addEventListener('change', () => { closeModal(); openInventoryForm(null, businessSelect.value); });
    $('[name=warehouseId]', root).addEventListener('change', (event) => {
      items.forEach((item) => { const input = $(`[name="actual:${item.id}"]`, root); if (input) input.value = Number(stockBalance(event.target.value, item.id)?.quantity || 0); });
    });
    $('#inventory-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = event.submitter?.dataset.inventoryStatus || 'draft';
      if (status === 'completed' && !confirm('Завершить инвентаризацию и заменить системные остатки фактическими?')) return;
      const data = new FormData(event.target);
      const unit = data.get('unit') || targetBusinessId;
      const itemRows = items.map((item) => ({ stockItemId: item.id, actualQuantity: Number(data.get(`actual:${item.id}`) || 0) }));
      const next = { ...(inventory || {}), businessId: unit, unit, warehouseId: data.get('warehouseId'), date: data.get('date'), note: data.get('note') || '', status, items: itemRows };
      closeModal();
      if (inventory) await stockUpdate('inventories', next, status === 'completed' ? 'Инвентаризация завершена' : 'Черновик сохранён');
      else await stockCreate('inventories', next, status === 'completed' ? 'Инвентаризация завершена' : 'Черновик сохранён');
    });
    $('#inventory-delete', root)?.addEventListener('click', async () => { if (!confirm('Удалить черновик?')) return; closeModal(); await doDelete('inventories', inventory.id, 'Черновик удалён'); });
  });
}

// ---------- Финансы ----------
function finRow(f) {
  const m = FIN_METHODS.find((x) => x.id === f.method);
  const financeBusinessId = businessIdOf(f);
  const unitTag = activeUnits().length > 1 ? `${esc(businessEmoji(financeBusinessId))} ` : '';
  const transferTargets = myUnits().filter((id) => id !== financeBusinessId);
  const legacyOther = financeBusinessId === 'padel' ? 'dev' : financeBusinessId === 'dev' ? 'padel' : '';
  const other = legacyOther && transferTargets.includes(legacyOther)
    ? legacyOther
    : transferTargets.length === 1 ? transferTargets[0] : '';
  return `
    <div class="row-card" data-fin="${f.id}">
      <div class="grow col">
        <div class="title">${unitTag}${esc(f.counterparty || f.category || 'Операция')}${f.owner ? ' · 👤 ' + esc(ownerLabel(f.owner)) : ''}</div>
        <div class="sub">${fmtDate(f.date)} · ${esc(f.category || '')}${f.comment ? ' · ' + esc(f.comment) : ''}</div>
      </div>
      <span class="badge ${f.source === 'bank' ? 'blue' : ''}">${f.source === 'bank' ? '🏦 банк' : '✍️ вручную'}${m ? ' · ' + m.name : ''}</span>
      <div class="amount ${f.type === 'income' ? 'green' : 'red'}">${f.type === 'income' ? '+' : '−'}${money(f.amount)}</div>
      ${other ? `<button class="btn small" data-flip="${f.id}" data-flip-business="${esc(other)}" title="Перекинуть в «${esc(businessName(other))}»">${esc(businessEmoji(other))}</button>` : ''}
    </div>`;
}

function bindFinRows(root) {
  root.querySelectorAll('[data-fin]').forEach((el) => el.addEventListener('click', () => openFinForm((S.data.finance || []).find((f) => f.id === el.dataset.fin))));
  root.querySelectorAll('[data-flip]').forEach((el) => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const f = (S.data.finance || []).find((x) => x.id === el.dataset.flip);
    if (!f) return;
    const other = el.dataset.flipBusiness;
    if (!other) return;
    await doUpdate('finance', { ...f, businessId: other, unit: other }, `Перенесено в «${businessName(other)}»`);
  }));
}

function viewFinance() {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  setTitle('Финансы');
  const tab = S.finTab || 'ops';
  const pendingCount = (S.data.staffExpenses || []).filter((e) => e.status === 'pending').length;
  const bankPendingCount = (S.data.bankTransactions || []).length;
  const tabs = [['bank', `🏦 Необработанные${bankPendingCount ? ' (' + bankPendingCount + ')' : ''}`], ['ops', '💸 Операции'], ['staff', `🧾 Траты${pendingCount ? ' (' + pendingCount + ')' : ''}`], ['accounts', '👥 Счета'], ['cash', '💵 Наличные']];
  const tabsHtml = `<div class="chip-row">${tabs.map(([k, l]) => `<button class="chip ${tab === k ? 'active' : ''}" data-fintab="${k}">${l}</button>`).join('')}</div>`;
  const renderers = { bank: renderFinBank, ops: renderFinOps, staff: renderFinStaff, accounts: renderFinAccounts, cash: renderFinCash };
  (renderers[tab] || renderFinOps)(tabsHtml);
  $('#view').querySelectorAll('[data-fintab]').forEach((b) => b.addEventListener('click', () => { S.finTab = b.dataset.fintab; render(); }));
}

function renderFinBank(tabsHtml) {
  const bankSubTab = S.bankSubTab || 'queue';
  const bankTabs = `<div class="bank-rules-entrybar">
    <button class="btn primary bank-rules-entry" type="button" data-bank-rules-entry>⚙ Настройки правил/скриптов</button>
    <span class="small muted">Правила, автоматизация и журнал</span>
  </div>
  <div class="chip-row bank-rule-tabs">
    ${[['queue', 'Очередь'], ['settings', 'Настройки'], ['journal', 'Журнал']].map(([key, label]) =>
      `<button class="chip ${bankSubTab === key ? 'active' : ''}" data-bank-subtab="${key}">${label}</button>`).join('')}
  </div>`;
  if (bankSubTab === 'settings') { renderBankRuleSettings(tabsHtml, bankTabs); return; }
  if (bankSubTab === 'journal') { void renderBankRuleJournal(tabsHtml, bankTabs); return; }
  const month = S.finMonth;
  const period = S.finPeriod || 'month';
  const monthName = new Date(month + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const periodName = period === 'all' ? 'всё время' : monthName;
  const diagnostics = S.data.bankDiagnostics || {};
  const queueDiagnostics = diagnostics.queue || { count: (S.data.bankTransactions || []).length, earliestDate: null, latestDate: null };
  const hiddenInvalid = Number(diagnostics.hiddenInvalidScope?.count || 0);
  const hiddenInvalidWithoutBankId = Number(diagnostics.hiddenInvalidScopeWithoutBankId?.count || 0);
  const hiddenInvalidRecoverable = Math.max(0, hiddenInvalid - hiddenInvalidWithoutBankId);
  const hiddenArchived = Number(diagnostics.hiddenArchivedScope?.count || 0);
  const hiddenInaccessible = Number(diagnostics.hiddenInaccessibleScope?.count || 0);
  const hiddenTotal = hiddenInvalid + hiddenArchived + hiddenInaccessible;
  const queueDates = queueDiagnostics.earliestDate
    ? `${fmtDate(queueDiagnostics.earliestDate)} — ${fmtDate(queueDiagnostics.latestDate || queueDiagnostics.earliestDate)}`
    : 'нет дат';
  const queueFilter = S.bankQueueFilter || 'active';
  const list = (S.data.bankTransactions || [])
    .filter((item) => period === 'all' || (item.date || '').startsWith(month))
    .filter((item) => queueFilter === 'all' || (queueFilter === 'ignored' ? item.bankRuleState === 'ignored' : item.bankRuleState !== 'ignored'))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const row = (item, index) => {
    const method = FIN_METHODS.find((entry) => entry.id === item.method)?.name || 'Счёт';
    const evaluation = item.ruleEvaluation || {};
    const state = item.bankRuleState || 'pending';
    const status = state === 'ignored' ? ['Игнорируется', '']
      : state === 'manual' ? ['Только вручную', 'amber']
      : evaluation.conflict ? ['Конфликт правил', 'red']
      : evaluation.state === 'matched' && evaluation.decision === 'suggest' ? ['Есть предложение', 'blue']
      : evaluation.state === 'unknown' ? ['Не хватает данных', 'amber']
      : ['Ждёт назначения', 'amber'];
    return `<div class="row-card bank-pending-row" data-bank-index="${index}">
      <div class="grow col">
        <div class="title">${esc(item.counterparty || (item.type === 'income' ? 'Поступление из банка' : 'Списание из банка'))}</div>
        <div class="sub">${fmtDate(item.date)} · ${esc(method)}${item.comment ? ' · ' + esc(item.comment) : ''}</div>
      </div>
      <span class="badge ${status[1]} dot">${status[0]}</span>
      <div class="amount ${item.type === 'income' ? 'green' : 'red'}">${item.type === 'income' ? '+' : '−'}${money(item.amount)}</div>
      <button class="btn small primary" type="button" data-process-bank-index="${index}">Назначить</button>
    </div>`;
  };

  $('#view').innerHTML = `
    ${tabsHtml}
    ${bankTabs}
    <div class="finance-context" aria-label="Контекст необработанных банковских операций">
      <div class="finance-context-icon">🏦</div>
      <div class="finance-context-copy">
        <span>Очередь до назначения бизнеса</span>
        <strong>Все бизнесы <i>·</i> ${esc(periodName)} <i>·</i> до проведения не входит в доходы и расходы</strong>
      </div>
    </div>
    <div class="banner" data-bank-diagnostics data-queue-count="${Number(queueDiagnostics.count || 0)}" data-hidden-count="${hiddenTotal}" data-blocked-count="${hiddenInvalidWithoutBankId}">
      Диагностика загрузки: в очереди ${Number(queueDiagnostics.count || 0)}, период ${esc(queueDates)}; скрыто фильтрами ${hiddenTotal}.
    </div>
    ${hiddenInvalidRecoverable ? `<div class="banner warn">Обнаружено ${hiddenInvalidRecoverable} банковских операций с неверным бизнесом. Обновление сервера должно вернуть их в очередь.</div>` : ''}
    ${hiddenInvalidWithoutBankId ? `<div class="banner warn">Из них ${hiddenInvalidWithoutBankId} операций нельзя восстановить автоматически: отсутствует банковский идентификатор. Нужна ручная проверка.</div>` : ''}
    ${hiddenArchived ? `<div class="banner">В архивных бизнесах остаётся ${hiddenArchived} банковских операций.</div>` : ''}
    ${hiddenInaccessible ? `<div class="banner warn">Для ${hiddenInaccessible} банковских операций у администратора нет доступа к бизнесу.</div>` : ''}
    <div class="searchbar">
      ${period === 'month' ? `
      <button class="btn small" id="bank-m-prev" aria-label="Предыдущий месяц">←</button>
      <span class="btn small ghost nowrap" style="cursor:default">${monthName}</span>
      <button class="btn small" id="bank-m-next" aria-label="Следующий месяц">→</button>` : ''}
      <button class="btn small ${period === 'all' ? 'primary' : ''}" id="bank-period-toggle">${period === 'all' ? '📅 по месяцам' : '∑ за всё время'}</button>
      <button class="btn small ${queueFilter !== 'active' ? 'primary' : ''}" id="bank-queue-filter">${queueFilter === 'active' ? 'Обычная очередь' : queueFilter === 'ignored' ? 'Игнорируемые' : 'Все состояния'}</button>
      <div class="grow"></div>
      <span class="badge amber">${list.length} ${list.length === 1 ? 'операция' : 'операций'}</span>
    </div>
    <div class="banner">Новые операции банка не влияют на доходы и расходы, пока вы не назначите бизнес и категорию.</div>
    <div class="list">${list.length ? list.map(row).join('') : `<div class="card empty"><div class="big">✓</div>Необработанных операций за ${esc(periodName)} нет</div>`}</div>`;

  const shift = (direction) => {
    const date = new Date(S.finMonth + '-01');
    date.setMonth(date.getMonth() + direction);
    S.finMonth = date.toISOString().slice(0, 7);
    render();
  };
  $('#bank-m-prev')?.addEventListener('click', () => shift(-1));
  $('#bank-m-next')?.addEventListener('click', () => shift(1));
  $('#bank-period-toggle').addEventListener('click', () => { S.finPeriod = period === 'all' ? 'month' : 'all'; render(); });
  $('#bank-queue-filter').addEventListener('click', () => {
    S.bankQueueFilter = queueFilter === 'active' ? 'ignored' : queueFilter === 'ignored' ? 'all' : 'active';
    render();
  });
  $('#view').querySelectorAll('[data-process-bank-index]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openBankTransaction(list[Number(button.dataset.processBankIndex)]?.id);
  }));
  $('#view').querySelectorAll('[data-bank-index]').forEach((card) => card.addEventListener('click', () => openBankTransaction(list[Number(card.dataset.bankIndex)]?.id)));
  bindBankSubTabs();
}

function bindBankSubTabs() {
  $('#view').querySelector('[data-bank-rules-entry]')?.addEventListener('click', () => {
    S.bankSubTab = 'settings';
    render();
  });
  $('#view').querySelectorAll('[data-bank-subtab]').forEach((button) => button.addEventListener('click', () => {
    S.bankSubTab = button.dataset.bankSubtab;
    render();
  }));
}

function renderBankRuleSettings(tabsHtml, bankTabs) {
  const settings = (S.data.bankRuleSettings || [])[0] || {
    settingsVersion: 1, autoEnabled: false, allowedDirections: ['income', 'expense'],
    maxAmountMinor: { income: 1000000, expense: 1000000 }, maxTransactionsPerRun: 10,
    maxTransactionsPerDay: 20, maxTotalAmountMinorPerDay: 5000000,
  };
  const rules = (S.data.bankRules || []).slice().sort((a, b) => Number(b.priority) - Number(a.priority) || Number(a.order) - Number(b.order));
  const ruleRow = (rule) => `<div class="row-card bank-rule-row" data-bank-rule-id="${esc(rule.id)}">
    <div class="grow col"><div class="title">${esc(rule.name)}</div>
      <div class="sub">Версия ${Number(rule.version || 1)} · приоритет ${Number(rule.priority || 0)} · ${esc(rule.decision || 'suggest')} · условий ${['all', 'any', 'none'].reduce((sum, key) => sum + Number(rule.conditions?.[key]?.length || 0), 0)}</div>
    </div>
    <span class="badge ${rule.enabled === false ? '' : 'green'}">${rule.deleted ? 'В архиве' : rule.enabled === false ? 'Выключено' : 'Работает'}</span>
    <button class="btn small" type="button" data-edit-bank-rule="${esc(rule.id)}">Изменить</button>
  </div>`;
  $('#view').innerHTML = `${tabsHtml}${bankTabs}
    <div class="banner ${settings.autoEnabled ? 'warn' : ''}" data-bank-auto-state="${settings.autoEnabled ? 'on' : 'off'}">
      <strong>${settings.autoEnabled ? 'Автопроведение включено' : 'Автопроведение выключено'}</strong><br>
      Правила продолжают подсказывать бизнес и категорию. Сумма без сильного признака никогда не проводится автоматически.
    </div>
    <form class="card bank-rule-settings" id="bank-rule-settings-form">
      <div class="section-head"><div><h3>Безопасные лимиты</h3><p class="muted small">Превышение лимита превращает auto в обычное предложение.</p></div>
        <label class="toggle"><input name="autoEnabled" type="checkbox" ${settings.autoEnabled ? 'checked' : ''}><span>Автопроведение</span></label></div>
      <div class="form-row">
        <label class="field"><span>Максимум операций за запуск</span><input name="maxTransactionsPerRun" type="number" min="1" max="100" value="${Number(settings.maxTransactionsPerRun || 10)}"></label>
        <label class="field"><span>Максимум операций в день</span><input name="maxTransactionsPerDay" type="number" min="1" max="1000" value="${Number(settings.maxTransactionsPerDay || 20)}"></label>
        <label class="field"><span>Общая сумма в день, ₽</span><input name="maxTotalAmount" type="number" min="1" step="1" value="${Number(settings.maxTotalAmountMinor || settings.maxTotalAmountMinorPerDay || 0) / 100}"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Один приход, ₽</span><input name="maxIncome" type="number" min="0" step="1" value="${Number(settings.maxAmountMinor?.income || 0) / 100}"></label>
        <label class="field"><span>Один расход, ₽</span><input name="maxExpense" type="number" min="0" step="1" value="${Number(settings.maxAmountMinor?.expense || 0) / 100}"></label>
      </div>
      <div class="actions"><button class="btn" type="button" id="bank-rule-dry-run">Проверить на очереди</button><button class="btn primary" type="submit">Сохранить настройки</button></div>
    </form>
    <div class="section-head"><div><h3>Правила</h3><p class="muted small">Изменение создаёт новую неизменяемую версию.</p></div><button class="btn primary" id="add-bank-rule">+ Правило</button></div>
    <div class="list">${rules.length ? rules.map(ruleRow).join('') : '<div class="card empty"><div class="big">⚙️</div>Правил пока нет. Ручная очередь продолжает работать.</div>'}</div>`;
  bindBankSubTabs();
  $('#add-bank-rule').addEventListener('click', () => openBankRuleForm());
  $('#view').querySelectorAll('[data-edit-bank-rule]').forEach((button) => button.addEventListener('click', () => openBankRuleForm(rules.find((rule) => rule.id === button.dataset.editBankRule))));
  $('#bank-rule-dry-run').addEventListener('click', async () => {
    const button = $('#bank-rule-dry-run'); button.disabled = true;
    const result = await S.store.bankRuleDryRun(S.token);
    button.disabled = false;
    if (!result.ok) { toast(result.error || 'Не удалось проверить правила', true); return; }
    const x = result.summary;
    openModal(`<h2>Проверка без изменений</h2><div class="cards-row bank-preview-cards">
      <div class="card stat"><div class="label">Всего</div><div class="value">${Number(x.total || 0)}</div></div>
      <div class="card stat"><div class="label">Совпало</div><div class="value">${Number(x.matched || 0)}</div></div>
      <div class="card stat"><div class="label">Можно auto</div><div class="value green">${Number(x.autoEligible || 0)}</div></div>
      <div class="card stat"><div class="label">Конфликты</div><div class="value red">${Number(x.conflict || 0)}</div></div>
    </div><div class="banner">Не хватает признаков: ${Number(x.missingSignals || 0)} · вручную: ${Number(x.manual || 0)} · игнор: ${Number(x.ignored || 0)}. Имена, суммы, телефоны, счета и банковские идентификаторы в результат не включены.</div><div class="actions"><button class="btn primary" id="modal-cancel">Понятно</button></div>`, (root) => $('#modal-cancel', root).addEventListener('click', closeModal));
  });
  $('#bank-rule-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const nextAuto = form.elements.autoEnabled.checked;
    if (nextAuto && !settings.autoEnabled && !confirm('Включить автопроведение с указанными лимитами? Неоднозначные операции всё равно останутся в очереди.')) return;
    const next = {
      ...settings, autoEnabled: nextAuto,
      allowedDirections: Array.isArray(settings.allowedDirections) ? [...settings.allowedDirections] : ['income', 'expense'],
      maxTransactionsPerRun: Number(form.elements.maxTransactionsPerRun.value),
      maxTransactionsPerDay: Number(form.elements.maxTransactionsPerDay.value),
      maxTotalAmountMinorPerDay: Math.round(Number(form.elements.maxTotalAmount.value) * 100),
      maxAmountMinor: { income: Math.round(Number(form.elements.maxIncome.value) * 100), expense: Math.round(Number(form.elements.maxExpense.value) * 100) },
    };
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    const result = await S.store.bankRuleSettingsUpdate(S.token, next, settings.settingsVersion);
    submit.disabled = false;
    if (!result.ok) { toast(result.error || 'Не удалось сохранить настройки', true); return; }
    toast('Настройки правил сохранены'); await refresh(true); S.bankSubTab = 'settings'; render();
  });
}

function openBankRuleForm(rule = null, transaction = null) {
  const isNew = !rule;
  const editableOps = {
    direction: 'exact', amountMinor: 'exact', detectedMethod: 'exact',
    'sender.nameNormalized': 'contains', 'recipient.nameNormalized': 'contains',
    'sender.phoneE164': 'exact', 'recipient.phoneE164': 'exact',
    'sender.inn': 'exact', 'recipient.inn': 'exact', descriptionNormalized: 'contains',
  };
  const allConditions = Array.isArray(rule?.conditions?.all) ? rule.conditions.all : [];
  const conditionFields = allConditions.map((condition) => condition?.field);
  const advancedRule = !!rule && (
    (rule?.conditions?.any?.length || 0) > 0 || (rule?.conditions?.none?.length || 0) > 0 ||
    allConditions.some((condition) => editableOps[condition?.field] !== condition?.op) ||
    new Set(conditionFields).size !== conditionFields.length ||
    Object.keys(rule?.actions || {}).some((key) => !['businessId', 'category', 'owner', 'counterpartyOverride', 'comment', 'links'].includes(key))
  );
  const advancedDisabled = advancedRule ? 'disabled' : '';
  const suggested = transaction?.ruleEvaluation?.actions || {};
  const direction = rule?.conditions?.all?.find((condition) => condition.field === 'direction')?.value || transaction?.type || 'income';
  const amountMinor = rule?.conditions?.all?.find((condition) => condition.field === 'amountMinor')?.value;
  const description = rule?.conditions?.all?.find((condition) => condition.field === 'descriptionNormalized')?.value || '';
  const conditionValue = (field) => rule?.conditions?.all?.find((condition) => condition.field === field)?.value || '';
  const detectedMethod = conditionValue('detectedMethod');
  const businessId = rule?.actions?.businessId || suggested.businessId || (S.unit !== 'all' ? S.unit : myUnits()[0]);
  const category = rule?.actions?.category || suggested.category || '';
  const links = rule?.actions?.links || {};
  const ownerOptions = (S.data.businessOwners || []).filter((item) => item.active !== false)
    .map((item) => ({ id: item.ownerId, name: `${item.name || ownerLabel(item.ownerId)} · ${businessName(businessIdOf(item))}` }));
  const optionList = (items, selected, label) => `<option value="">— не связывать —</option>${(items || []).map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(label(item))}</option>`).join('')}`;
  openModal(`<h2>${isNew ? 'Новое правило' : 'Изменить правило'}</h2>
    ${transaction ? '<div class="banner">Создаётся безопасный черновик по направлению и сумме. Он будет только предлагать действие, пока вы не добавите сильный точный признак.</div>' : ''}
    ${advancedRule ? '<div class="banner warn">У этого правила есть расширенные условия или действия. Они защищены от тихой перезаписи: здесь можно изменить только название, решение, приоритет и состояние. Расширенная часть сохранится без изменений.</div>' : ''}
    <form id="bank-rule-form">
      <label class="field"><span>Название</span><input name="name" required maxlength="120" value="${esc(rule?.name || (transaction ? `Операция ${transaction.type === 'income' ? 'приход' : 'расход'}` : ''))}"></label>
      <div class="form-row"><label class="field"><span>Направление</span><select name="direction" ${advancedDisabled}><option value="income" ${direction === 'income' ? 'selected' : ''}>Приход</option><option value="expense" ${direction === 'expense' ? 'selected' : ''}>Расход</option></select></label>
        <label class="field"><span>Точная сумма, ₽ (необязательно)</span><input name="amount" type="number" min="0" step="0.01" value="${amountMinor !== undefined ? Number(amountMinor) / 100 : transaction ? Number(transaction.amount || 0) : ''}" ${advancedDisabled}></label></div>
      <div class="form-row"><label class="field"><span>Способ оплаты (необязательно)</span><select name="detectedMethod" ${advancedDisabled}><option value="">— любой —</option>${FIN_METHODS.map((item) => `<option value="${esc(item.id)}" ${item.id === detectedMethod ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Получатель содержит имя</span><input name="recipientName" maxlength="160" value="${esc(conditionValue('recipient.nameNormalized'))}" placeholder="Например: Андрей" ${advancedDisabled}></label></div>
      <div class="form-row"><label class="field"><span>Телефон получателя</span><input name="recipientPhone" type="tel" maxlength="40" value="${esc(conditionValue('recipient.phoneE164'))}" placeholder="+7 900 000-00-00" ${advancedDisabled}></label>
        <label class="field"><span>ИНН получателя</span><input name="recipientInn" inputmode="numeric" maxlength="12" value="${esc(conditionValue('recipient.inn'))}" ${advancedDisabled}></label></div>
      <div class="form-row"><label class="field"><span>Отправитель содержит имя</span><input name="senderName" maxlength="160" value="${esc(conditionValue('sender.nameNormalized'))}" ${advancedDisabled}></label>
        <label class="field"><span>Телефон отправителя</span><input name="senderPhone" type="tel" maxlength="40" value="${esc(conditionValue('sender.phoneE164'))}" placeholder="+7 900 000-00-00" ${advancedDisabled}></label></div>
      <label class="field"><span>ИНН отправителя (необязательно)</span><input name="senderInn" inputmode="numeric" maxlength="12" value="${esc(conditionValue('sender.inn'))}" ${advancedDisabled}></label>
      <label class="field"><span>Назначение содержит (необязательно)</span><input name="description" maxlength="120" value="${esc(description)}" placeholder="Например: турнир август" ${advancedDisabled}></label>
      <div class="form-row"><label class="field"><span>Решение</span><select name="decision"><option value="suggest" ${!rule || rule.decision === 'suggest' ? 'selected' : ''}>Предложить</option><option value="auto" ${rule?.decision === 'auto' ? 'selected' : ''}>Автоматически при строгих условиях</option><option value="manual" ${rule?.decision === 'manual' ? 'selected' : ''}>Только вручную</option><option value="ignore" ${rule?.decision === 'ignore' ? 'selected' : ''}>Игнорировать</option></select></label>
        <label class="field"><span>Приоритет</span><input name="priority" type="number" min="-1000" max="1000" value="${Number(rule?.priority || 0)}"></label></div>
      <div class="form-row"><label class="field"><span>Бизнес</span><select name="businessId" ${advancedDisabled}>${myUnits().map((id) => `<option value="${esc(id)}" ${id === businessId ? 'selected' : ''}>${esc(businessEmoji(id))} ${esc(businessName(id))}</option>`).join('')}</select></label>
        <label class="field"><span>Категория</span><select name="category" ${advancedDisabled}><option value="">— без назначения —</option>${FIN_CATEGORIES.map((item) => `<option value="${esc(item)}" ${item === category ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></label></div>
      <div class="form-row"><label class="field"><span>Чей личный расход</span><select name="owner" ${advancedDisabled}><option value="">— общий —</option>${ownerOptions.map((item) => `<option value="${esc(item.id)}" ${item.id === rule?.actions?.owner ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Подменить название контрагента</span><input name="counterpartyOverride" maxlength="160" value="${esc(rule?.actions?.counterpartyOverride || '')}" ${advancedDisabled}></label></div>
      <label class="field"><span>Комментарий правила</span><input name="actionComment" maxlength="300" value="${esc(rule?.actions?.comment || '')}" ${advancedDisabled}></label>
      <details class="card"><summary>Связать с CRM, игроком или событием</summary>
        <div class="form-row"><label class="field"><span>Игрок</span><select name="playerId" ${advancedDisabled}>${optionList(S.data.players, links.playerId, (item) => `${item.name} · ${businessName(businessIdOf(item))}`)}</select></label>
          <label class="field"><span>Контрагент</span><select name="companyId" ${advancedDisabled}>${optionList(S.data.companies, links.companyId, (item) => `${item.name} · ${businessName(businessIdOf(item))}`)}</select></label></div>
        <div class="form-row"><label class="field"><span>Контакт</span><select name="contactId" ${advancedDisabled}>${optionList(S.data.contacts, links.contactId, (item) => `${item.name} · ${businessName(businessIdOf(item))}`)}</select></label>
          <label class="field"><span>Сделка</span><select name="dealId" ${advancedDisabled}>${optionList(S.data.deals, links.dealId, (item) => `${item.title || item.name} · ${businessName(businessIdOf(item))}`)}</select></label></div>
        <div class="form-row"><label class="field"><span>Событие</span><select name="eventId" ${advancedDisabled}>${optionList(S.data.events, links.event?.eventId, (item) => `${item.title || item.name} · ${businessName(businessIdOf(item))}`)}</select></label>
          <label class="field"><span>Регистрация участника</span><select name="registrationId" ${advancedDisabled}>${optionList(S.data.eventRegistrations, links.event?.registrationId, (item) => `${eventParticipant(item)} · ${item.eventId}`)}</select></label></div>
        <label class="field"><span>Назначение связи события</span><select name="eventPurpose" ${advancedDisabled}><option value="payment" ${links.event?.purpose === 'payment' ? 'selected' : ''}>Оплата</option><option value="deposit" ${links.event?.purpose === 'deposit' ? 'selected' : ''}>Депозит</option><option value="expense" ${links.event?.purpose === 'expense' ? 'selected' : ''}>Расход</option><option value="refund" ${links.event?.purpose === 'refund' ? 'selected' : ''}>Возврат</option></select></label>
      </details>
      <label class="toggle"><input name="enabled" type="checkbox" ${rule?.enabled === false || rule?.deleted ? '' : 'checked'} ${rule?.deleted ? 'disabled' : ''}><span>${rule?.deleted ? 'Правило в архиве' : 'Правило включено'}</span></label>
      <p class="muted small">Auto с одной суммой или неизвестными признаками всегда понижается до предложения. Для автопроведения укажите точный телефон/ИНН либо два независимых контекстных признака. Псевдоним банковского счёта создаётся системой и доступен только расширенным интеграциям.</p>
      <div class="actions">${rule ? '<button class="btn danger ghost" type="button" id="bank-rule-delete">В архив</button>' : ''}<button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">Сохранить версию</button></div>
    </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#bank-rule-delete', root)?.addEventListener('click', async () => {
      if (!confirm('Перенести правило в архив? Его версии и журнал сохранятся.')) return;
      const result = await S.store.bankRuleDelete(S.token, rule.id, Number(rule.version || 0));
      if (!result.ok) { toast(result.error || 'Не удалось архивировать правило', true); return; }
      closeModal(); toast('Правило перенесено в архив'); await refresh(true); S.bankSubTab = 'settings'; render();
    });
    $('#bank-rule-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const conditions = advancedRule ? null : [{ field: 'direction', op: 'exact', value: form.elements.direction.value }];
      if (!advancedRule && form.elements.amount.value !== '') conditions.push({ field: 'amountMinor', op: 'exact', value: Math.round(Number(form.elements.amount.value) * 100) });
      if (!advancedRule && form.elements.detectedMethod.value) conditions.push({ field: 'detectedMethod', op: 'exact', value: form.elements.detectedMethod.value });
      const addTextCondition = (field, element, op = 'contains', normalize = normalizeBankText) => {
        const raw = element.value.trim();
        if (!raw) return true;
        const value = normalize(raw);
        if (!value) { toast(`Проверьте значение поля «${element.closest('label')?.querySelector('span')?.textContent || field}»`, true); return false; }
        conditions.push({ field, op, value }); return true;
      };
      if (!advancedRule && ![
        addTextCondition('recipient.nameNormalized', form.elements.recipientName),
        addTextCondition('recipient.phoneE164', form.elements.recipientPhone, 'exact', normalizePhone),
        addTextCondition('recipient.inn', form.elements.recipientInn, 'exact', normalizeInn),
        addTextCondition('sender.nameNormalized', form.elements.senderName),
        addTextCondition('sender.phoneE164', form.elements.senderPhone, 'exact', normalizePhone),
        addTextCondition('sender.inn', form.elements.senderInn, 'exact', normalizeInn),
      ].every(Boolean)) return;
      if (!advancedRule && form.elements.description.value.trim()) conditions.push({ field: 'descriptionNormalized', op: 'contains', value: normalizeBankText(form.elements.description.value) });
      const actionLinks = advancedRule ? null : Object.fromEntries(['playerId', 'companyId', 'contactId', 'dealId']
        .map((field) => [field, form.elements[field].value]).filter(([, value]) => value));
      if (!advancedRule && form.elements.eventId.value) actionLinks.event = {
        eventId: form.elements.eventId.value,
        registrationId: form.elements.registrationId.value || undefined,
        purpose: form.elements.eventPurpose.value,
      };
      if (!advancedRule && actionLinks.event && ['payment', 'deposit', 'refund'].includes(actionLinks.event.purpose) && !actionLinks.event.registrationId) {
        toast('Для оплаты, депозита или возврата выберите регистрацию участника', true); return;
      }
      const actions = advancedRule ? rule.actions : {
        businessId: form.elements.businessId.value, category: form.elements.category.value,
        ...(form.elements.owner.value ? { owner: form.elements.owner.value } : {}),
        ...(form.elements.counterpartyOverride.value.trim() ? { counterpartyOverride: form.elements.counterpartyOverride.value.trim() } : {}),
        ...(form.elements.actionComment.value.trim() ? { comment: form.elements.actionComment.value.trim() } : {}),
        ...(Object.keys(actionLinks).length ? { links: actionLinks } : {}),
      };
      const next = {
        ...(rule || {}), name: form.elements.name.value.trim(), enabled: rule?.deleted ? false : form.elements.enabled.checked,
        priority: Number(form.elements.priority.value), order: Number(rule?.order || 0), stopOnMatch: rule?.stopOnMatch === true,
        decision: form.elements.decision.value,
        conditions: advancedRule ? rule.conditions : { all: conditions, any: [], none: [] },
        actions: advancedRule ? rule.actions : actions,
        autoLimits: rule?.autoLimits || { maxTransactionsPerDay: 10, maxAmountMinor: 1000000 },
      };
      const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      const expectedVersion = Number(rule?.version || 0);
      if (next.decision === 'auto' && next.enabled) {
        const dryRun = await S.store.bankRuleDryRun(S.token, next, expectedVersion);
        if (!dryRun.ok || !dryRun.activationToken) {
          submit.disabled = false; toast(dryRun.error || 'Не удалось проверить auto-правило', true); return;
        }
        const summary = dryRun.summary || {};
        if (!confirm(`Проверка завершена: совпадений ${Number(summary.matched || 0)}, кандидатов auto ${Number(summary.autoEligible || 0)}, конфликтов ${Number(summary.conflict || 0)}. Включить эту версию правила?`)) {
          submit.disabled = false; return;
        }
        next.activationToken = dryRun.activationToken;
      }
      const result = await S.store.bankRuleSave(S.token, next, expectedVersion);
      submit.disabled = false;
      if (!result.ok) { toast(result.error || 'Не удалось сохранить правило', true); return; }
      closeModal(); toast('Новая версия правила сохранена'); await refresh(true); S.bankSubTab = 'settings'; render();
    });
  });
}

async function renderBankRuleJournal(tabsHtml, bankTabs) {
  $('#view').innerHTML = `${tabsHtml}${bankTabs}<div class="card empty"><div class="big">⏳</div>Загружаю безопасный журнал…</div>`;
  bindBankSubTabs();
  const result = await S.store.bankRuleJournal(S.token, 50, 0);
  if (currentRoute() !== 'finance' || S.finTab !== 'bank' || S.bankSubTab !== 'journal') return;
  if (!result.ok) { $('#view').insertAdjacentHTML('beforeend', `<div class="banner warn">${esc(result.error || 'Журнал недоступен')}</div>`); return; }
  let rows = result.applications || [];
  let hasMore = result.hasMore === true;
  let nextOffset = Number(result.nextOffset || rows.length);
  const paint = () => {
    $('#view').innerHTML = `${tabsHtml}${bankTabs}<div class="banner">Журнал не содержит банковских идентификаторов, реквизитов, имён, телефонов, ИНН и сумм. Для различения записей показаны только дата, бизнес, классификация и короткая ссылка аудита.</div>
      <div class="list">${rows.length ? rows.map((item) => {
        const method = FIN_METHODS.find((entry) => entry.id === item.method)?.name || item.method || '—';
        const orientation = [item.operationDate ? fmtDate(item.operationDate) : '', item.businessId ? businessName(item.businessId) : '', item.category || '', method]
          .filter(Boolean).join(' · ');
        return `<div class="row-card bank-journal-row">
          <div class="grow col"><div class="title">${esc(item.decision || 'Действие')} · ${esc(item.state || '')} · ${esc(item.auditRef || 'audit')}</div>
            <div class="sub">${esc(orientation)}${orientation ? ' · ' : ''}${fmtDT(Number(item.created || 0))}${item.appliedRuleId ? ` · правило ${esc(item.appliedRuleId)} v${Number(item.appliedRuleVersion || 0)}` : ''}</div></div>
          ${['applied', 'corrected'].includes(item.state) ? `<button class="btn small" data-correct-bank="${esc(item.id)}">Исправить</button>${item.canReverse ? `<button class="btn small danger ghost" data-reverse-bank="${esc(item.id)}">Безопасно отменить</button>` : ''}` : ''}
        </div>`;
      }).join('') : '<div class="card empty"><div class="big">📋</div>Журнал пока пуст</div>'}</div>
      ${hasMore ? '<div class="actions"><button class="btn" type="button" id="bank-journal-more">Показать ещё</button></div>' : ''}`;
    bindBankSubTabs();
    $('#view').querySelectorAll('[data-reverse-bank]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Вернуть операцию в очередь? Отмена сработает только если финансовая запись и её связи не менялись.')) return;
      button.disabled = true;
      const outcome = await S.store.bankRuleReverse(S.token, button.dataset.reverseBank, `reverse:${uid()}`);
      button.disabled = false;
      if (!outcome.ok) { toast(outcome.error || 'Безопасная отмена недоступна', true); return; }
      toast('Операция возвращена в очередь'); await refresh(true); render();
    }));
    $('#view').querySelectorAll('[data-correct-bank]').forEach((button) => button.addEventListener('click', () => openBankCorrection(button.dataset.correctBank)));
    $('#bank-journal-more')?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      const page = await S.store.bankRuleJournal(S.token, 50, nextOffset);
      if (!page.ok) { button.disabled = false; toast(page.error || 'Не удалось загрузить журнал', true); return; }
      if (currentRoute() !== 'finance' || S.finTab !== 'bank' || S.bankSubTab !== 'journal') return;
      rows = [...rows, ...(page.applications || [])]; hasMore = page.hasMore === true;
      nextOffset = Number(page.nextOffset || rows.length); paint();
    });
  };
  paint();
}

function openBankCorrection(applicationId) {
  openModal(`<h2>Исправить классификацию</h2><div class="banner">Сумма, направление и банковская связь останутся неизменными. Исправление будет записано в журнал.</div>
    <form id="bank-correct-form">
      <label class="field"><span>Категория</span><select name="category"><option value="">— не менять —</option>${FIN_CATEGORIES.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('')}</select></label>
      <div class="form-row"><label class="field"><span>Способ оплаты</span><select name="method"><option value="">— не менять —</option>${FIN_METHODS.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Чей личный расход</span><select name="owner"><option value="">— не менять —</option><option value="__clear__">— очистить владельца —</option>${(S.data.businessOwners || []).filter((item) => item.active !== false).map((item) => `<option value="${esc(item.ownerId)}">${esc(item.name || ownerLabel(item.ownerId))} · ${esc(businessName(businessIdOf(item)))}</option>`).join('')}</select></label></div>
      <label class="field"><span>Контрагент</span><input name="counterparty" maxlength="160" placeholder="Оставьте пустым, чтобы не менять"></label>
      <label class="checkline"><input type="checkbox" name="clearCounterparty"><span>Очистить контрагента</span></label>
      <label class="field"><span>Комментарий</span><textarea name="comment" maxlength="300" placeholder="Оставьте пустым, чтобы не менять"></textarea></label>
      <label class="checkline"><input type="checkbox" name="clearComment"><span>Очистить комментарий</span></label>
      <div class="actions"><button class="btn" type="button" id="modal-cancel">Отмена</button><button class="btn primary" type="submit">Записать исправление</button></div>
    </form>`, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#bank-correct-form', root).addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      const patch = Object.fromEntries(['category', 'method', 'counterparty', 'comment']
        .map((field) => [field, form.elements[field].value.trim()]).filter(([, value]) => value));
      if (form.elements.owner.value === '__clear__') patch.owner = null;
      else if (form.elements.owner.value) patch.owner = form.elements.owner.value;
      if (form.elements.clearCounterparty.checked) patch.counterparty = null;
      if (form.elements.clearComment.checked) patch.comment = null;
      if (!Object.keys(patch).length) { submit.disabled = false; toast('Выберите хотя бы одно исправление', true); return; }
      const outcome = await S.store.bankRuleCorrect(S.token, applicationId, patch, `correct:${uid()}`);
      submit.disabled = false;
      if (!outcome.ok) { toast(outcome.error || 'Исправление недоступно', true); return; }
      closeModal(); toast('Исправление записано'); await refresh(true); S.bankSubTab = 'journal'; render();
    });
  });
}

function openBankTransaction(id) {
  const transaction = (S.data.bankTransactions || []).find((item) => item.id === id);
  if (!transaction) return;
  const defaultBusinessId = S.unit !== 'all' && myUnits().includes(S.unit) ? S.unit : myUnits()[0];
  const method = FIN_METHODS.find((item) => item.id === transaction.method)?.name || 'Счёт';
  const evaluation = transaction.ruleEvaluation || {};
  const suggestedBusinessId = evaluation.actions?.businessId;
  const suggestedCategory = evaluation.actions?.category;
  openModal(`
    <h2>Провести банковскую операцию</h2>
    <div class="bank-pending-summary">
      <div><span>Дата</span><strong>${fmtDate(transaction.date)}</strong></div>
      <div><span>Тип</span><strong>${transaction.type === 'income' ? 'Поступление' : 'Списание'}</strong></div>
      <div><span>Сумма</span><strong class="${transaction.type === 'income' ? 'green' : 'red'}">${money(transaction.amount)}</strong></div>
      <div><span>Способ</span><strong>${esc(method)}</strong></div>
    </div>
    <div class="banner">${esc(transaction.counterparty || 'Контрагент не указан')}${transaction.comment ? '<br><span class="small">' + esc(transaction.comment) + '</span>' : ''}</div>
    ${evaluation.appliedRuleId ? `<div class="banner ${evaluation.conflict ? 'warn' : ''}"><strong>${evaluation.conflict ? 'Правила конфликтуют — автопроведение запрещено' : `Предложение правила · уверенность ${Math.round(Number(evaluation.confidence || 0) * 100)}%`}</strong><br>${evaluation.amountOnly ? 'Совпадение только по слабым признакам: требуется подтверждение.' : 'Сервер повторно проверит правило и его версию перед проведением.'}</div>` : ''}
    <form id="bank-process-form">
      <label class="field"><span>Бизнес</span>
        <select name="businessId" required>
          ${myUnits().map((businessId) => `<option value="${esc(businessId)}" ${businessId === (suggestedBusinessId || defaultBusinessId) ? 'selected' : ''}>${esc(businessEmoji(businessId))} ${esc(businessName(businessId))}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Категория</span>
        <select name="category" required>
          <option value="" ${suggestedCategory ? '' : 'selected'} disabled>— выберите категорию —</option>
          ${FIN_CATEGORIES.map((category) => `<option value="${esc(category)}" ${category === suggestedCategory ? 'selected' : ''}>${esc(category)}</option>`).join('')}
        </select>
      </label>
      <p class="muted small">После проведения операция появится во вкладке «Операции» и начнёт участвовать в финансовых итогах.</p>
      <div class="actions">
        <button type="button" class="btn" id="bank-create-rule">Создать правило</button>
        ${transaction.bankRuleState === 'ignored' || transaction.bankRuleState === 'manual'
          ? '<button type="button" class="btn" id="bank-reevaluate">Вернуть к проверке</button>'
          : '<button type="button" class="btn ghost" id="bank-ignore">Игнорировать</button><button type="button" class="btn ghost" id="bank-manual-only">Только вручную</button>'}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        ${evaluation.appliedRuleId && !evaluation.conflict && !['manual', 'ignore'].includes(evaluation.requestedDecision) ? '<button type="button" class="btn primary" id="bank-apply-suggestion">Применить предложение</button>' : ''}
        ${transaction.bankRuleState === 'ignored' ? '' : '<button type="submit" class="btn primary">Провести операцию</button>'}
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#bank-create-rule', root).addEventListener('click', () => { closeModal(); openBankRuleForm(null, transaction); });
    $('#bank-ignore', root)?.addEventListener('click', async () => {
      const result = await S.store.bankRuleIgnore(S.token, transaction.id, `ignore:${uid()}`);
      if (!result.ok) { toast(result.error || 'Не удалось игнорировать операцию', true); return; }
      closeModal(); toast('Операция скрыта из обычной обработки'); await refresh(true); render();
    });
    $('#bank-manual-only', root)?.addEventListener('click', async () => {
      const result = await S.store.bankRuleManual(S.token, transaction.id, `manual-state:${uid()}`);
      if (!result.ok) { toast(result.error || 'Не удалось зафиксировать ручной режим', true); return; }
      closeModal(); toast('Нижестоящие правила для операции остановлены'); await refresh(true); render();
    });
    $('#bank-reevaluate', root)?.addEventListener('click', async () => {
      const result = await S.store.bankRuleReevaluate(S.token, transaction.id, `reevaluate:${uid()}`);
      if (!result.ok) { toast(result.error || 'Не удалось вернуть операцию', true); return; }
      closeModal(); toast('Операция снова проверяется правилами'); await refresh(true); render();
    });
    $('#bank-apply-suggestion', root)?.addEventListener('click', async () => {
      const button = $('#bank-apply-suggestion', root); button.disabled = true;
      const result = await S.store.bankRuleApplySuggestion(S.token, transaction.id, transaction.ruleEvaluationToken, `suggest:${uid()}`);
      button.disabled = false;
      if (!result.ok) { toast(result.error || 'Предложение устарело', true); return; }
      closeModal(); toast('Предложение применено'); await refresh(true); render();
    });
    $('#bank-process-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      const submit = event.target.querySelector('[type="submit"]');
      submit.disabled = true;
      const result = await S.store.processBankTransaction(S.token, transaction.id, values.businessId, values.category);
      submit.disabled = false;
      if (!result.ok) { toast(result.error || 'Не удалось провести операцию', true); return; }
      S.data.bankTransactions = (S.data.bankTransactions || []).filter((item) => item.id !== transaction.id);
      const alreadyShown = (S.data.finance || []).some((item) => item.id === result.item?.id || (item.bankId && item.bankId === result.item?.bankId));
      if (result.item && !alreadyShown) S.data.finance.push(result.item);
      closeModal();
      toast('Операция проведена');
      render();
    });
  });
}

function renderFinOps(tabsHtml) {
  const units = activeUnits();
  const m = S.finMonth;
  const period = S.finPeriod || 'month';
  const inPeriod = (f) => period === 'all' || (f.date || '').startsWith(m);
  const list = (S.data.finance || []).filter((f) => units.includes(businessIdOf(f)) && inPeriod(f)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const income = list.filter((f) => f.type === 'income').reduce((s, f) => s + Number(f.amount || 0), 0);
  const expense = list.filter((f) => f.type === 'expense').reduce((s, f) => s + Number(f.amount || 0), 0);
  const monthName = new Date(m + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const periodName = period === 'all' ? 'всё время' : monthName;
  const financeBusinessName = S.unit === 'all' ? 'Все бизнесы' : `${businessEmoji(S.unit)} ${businessName(S.unit)}`;

  $('#view').innerHTML = `
    ${tabsHtml}
    <div class="finance-context" aria-label="Контекст финансов">
      <div class="finance-context-icon">◎</div>
      <div class="finance-context-copy">
        <span>Сейчас показано</span>
        <strong>${esc(financeBusinessName)} <i>·</i> ${esc(periodName)}</strong>
      </div>
      ${S.unit !== 'all' && myUnits().length > 1 ? '<button class="btn" id="finance-show-all">Все бизнесы</button>' : ''}
    </div>
    <div class="searchbar">
      ${period === 'month' ? `
      <button class="btn small" id="m-prev">←</button>
      <span class="btn small ghost nowrap" style="cursor:default">${monthName}</span>
      <button class="btn small" id="m-next">→</button>` : ''}
      <button class="btn small ${period === 'all' ? 'primary' : ''}" id="period-toggle">${period === 'all' ? '📅 по месяцам' : '∑ за всё время'}</button>
      <div class="grow"></div>
      <button class="btn primary" id="add-fin">+ Операция</button>
    </div>
    <div class="cards-row">
      ${S.data.bankBalance ? `<div class="card stat"><div class="label">На счёте в банке</div><div class="value">${money(S.data.bankBalance.amount)}</div>
        <div class="hint">обновлено ${fmtDT(new Date(S.data.bankBalance.updated).getTime())}</div></div>` : ''}
      <div class="card stat"><div class="label">Доход</div><div class="value green">${money(income)}</div><div class="hint">${periodName}</div></div>
      <div class="card stat"><div class="label">Расход</div><div class="value red">${money(expense)}</div><div class="hint">${periodName}</div></div>
      <div class="card stat"><div class="label">Итог</div><div class="value ${income - expense >= 0 ? 'green' : 'red'}">${money(income - expense)}</div><div class="hint">${periodName}</div></div>
    </div>
    <div class="list">${list.length ? list.map(finRow).join('') : `<div class="card empty"><div class="big">💸</div>Операций за ${periodName} нет</div>`}</div>`;

  const shift = (dir) => {
    const d = new Date(S.finMonth + '-01'); d.setMonth(d.getMonth() + dir);
    S.finMonth = d.toISOString().slice(0, 7); render();
  };
  $('#m-prev')?.addEventListener('click', () => shift(-1));
  $('#m-next')?.addEventListener('click', () => shift(1));
  $('#period-toggle').addEventListener('click', () => { S.finPeriod = (S.finPeriod === 'all') ? 'month' : 'all'; render(); });
  $('#finance-show-all')?.addEventListener('click', () => {
    S.unit = 'all'; localStorage.setItem('monetki_unit', S.unit); render();
  });
  $('#add-fin').addEventListener('click', () => openFinForm());
  bindFinRows($('#view'));
}

const EX_STATUS = {
  pending: { name: 'Не погашена', color: 'red' },
  returned_cash: { name: 'Возвращена наличными', color: 'green' },
  returned_bank: { name: 'Возвращена со счёта', color: 'green' },
  returned_salary: { name: 'Зачтена в зарплате', color: 'green' }
};

function renderFinStaff(tabsHtml) {
  const all = (S.data.staffExpenses || []).sort((a, b) => (b.created || 0) - (a.created || 0));
  const pending = all.filter((e) => e.status === 'pending');
  const rest = all.filter((e) => e.status !== 'pending');
  const exRow = (e) => {
    const st = EX_STATUS[e.status] || EX_STATUS.pending;
    return `<div class="row-card" data-ex-view="${e.id}">
      <div class="grow col"><div class="title">${esc(empName(e.employeeId))}: ${esc(e.title)}</div><div class="sub">${fmtDate(e.date)}</div></div>
      <div class="amount ${e.status === 'pending' ? 'red' : 'green'}">${money(e.amount)}</div>
      <span class="badge ${st.color} dot">${st.name}</span>
    </div>`;
  };
  $('#view').innerHTML = `
    ${tabsHtml}
    <div class="section-title" style="margin-top:4px">Ждут возврата</div>
    <div class="list">${pending.length ? pending.map(exRow).join('') : `<div class="card empty">Всё возвращено 👍</div>`}</div>
    <p class="muted small">Нажмите на трату: посмотреть чек и вернуть деньги. Зачесть трату в зарплате можно при начислении зарплаты (Операции → + Операция → Зарплата).</p>
    ${rest.length ? `<div class="section-title">История</div><div class="list">${rest.map(exRow).join('')}</div>` : ''}`;
  $('#view').querySelectorAll('[data-ex-view]').forEach((el) => el.addEventListener('click', () => openExpenseDetails(el.dataset.exView)));
}

function openExpenseDetails(id) {
  const e = (S.data.staffExpenses || []).find((x) => x.id === id);
  if (!e) return;
  const st = EX_STATUS[e.status] || EX_STATUS.pending;
  openModal(`
    <h2>${esc(e.title)} <span class="badge ${st.color} dot">${st.name}</span></h2>
    <p class="small">${esc(empName(e.employeeId))} · ${fmtDate(e.date)} · <b>${money(e.amount)}</b></p>
    <div id="receipt-holder"><button class="btn small" id="show-receipt">📷 Показать чек</button></div>
    ${e.status === 'pending' ? `
    <div class="actions" style="justify-content:center;margin-top:16px">
      <button class="btn" data-resolve="cash:savva">💵 Вернул из наличных Саввы</button>
      <button class="btn" data-resolve="cash:andrey">💵 Вернул из наличных Андрея</button>
      <button class="btn" data-resolve="bank">🏦 Вернул со счёта</button>
    </div>
    <p class="muted small" style="text-align:center">«Из наличных» — спишется с кассы владельца. «Со счёта» — расход придёт из выписки банка.</p>` : ''}
    <div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#show-receipt', root)?.addEventListener('click', async () => {
      $('#receipt-holder', root).innerHTML = '<div class="muted small">Загружаю…</div>';
      const r = await S.store.getFile(S.token, e.receiptId);
      $('#receipt-holder', root).innerHTML = r.ok && String(r.b64).startsWith('data:image/')
        ? `<img class="receipt-img" src="${r.b64}" alt="Чек">`
        : `<div class="muted small">${esc(r.error || 'Чек не найден')}</div>`;
    });
    root.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
      const res = await S.store.resolveExpense(S.token, e.id, b.dataset.resolve);
      if (!res.ok) { toast(res.error || 'Ошибка', true); return; }
      applyLocal('staffExpenses', 'update', res.item);
      closeModal();
      toast('Возврат отмечен');
      refresh(true);
    }));
  });
}

function renderFinAccounts(tabsHtml) {
  const businessOwners = S.data.businessOwners || [];
  const bal = ownerBalances(S.data.finance || [], businessOwners);
  const sharesText = businesses().map((b) => {
    const owners = businessOwners.filter((o) => businessIdOf(o) === b.id && o.active !== false);
    return `${businessName(b.id)} — ${owners.map((o) => `${o.name || ownerLabel(o.ownerId) || o.ownerId} ${Number(o.share || 0) * 100}%`).join(' / ')}`;
  }).filter((text) => !text.endsWith('— ')).join('; ');
  $('#view').innerHTML = `
    ${tabsHtml}
    <div class="cards-row">
      ${OWNERS.map((o) => {
        const b = bal[o.id];
        return `<div class="card stat"><div class="label">${o.name}</div>
          <div class="value ${b.total >= 0 ? '' : 'red'}">${money(b.total)}</div>
          <div class="hint">💻 Разработка: ${money(b.dev)}</div>
          <div class="hint">🎾 Падел: ${money(b.padel)}</div>
          ${b.personal ? `<div class="hint" style="color:var(--red)">личные расходы: −${money(b.personal)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
    <div class="card muted small">
      <b>Как считается.</b> По каждому направлению берётся (все доходы − все расходы) и делится по долям:
      ${esc(sharesText || 'Разработка — Савва 50% / Андрей 50%; Падел — Андрей 34% / Савва 33% / Дмитрий 33%.')}
      Исключения: расход с указанным «Чей расход» вычитается только у него — «Савва и Андрей» делит его пополам между ними (минуя Дмитрия), конкретный человек — целиком с его счёта;
      «Перевод между счетами» не считается вообще. Наличные кассы живут отдельно (вкладка «Наличные»).
      Всё пересчитывается из операций автоматически, где бы вы их ни меняли.
    </div>`;
}

function renderFinCash(tabsHtml) {
  const cash = (S.data.cash || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const cashOwners = OWNERS.filter((o) => o.cashbox);
  const balOf = (oid) => cash.filter((c) => c.owner === oid).reduce((s, c) => s + (c.type === 'income' ? 1 : -1) * Number(c.amount || 0), 0);
  $('#view').innerHTML = `
    ${tabsHtml}
    <div class="searchbar"><div class="grow"></div><button class="btn primary" id="add-cash">+ Операция с наличными</button></div>
    <div class="cards-row">
      ${cashOwners.map((o) => `<div class="card stat"><div class="label">Наличные — ${o.name}</div><div class="value">${money(balOf(o.id))}</div></div>`).join('')}
    </div>
    <div class="banner">💵 Наличные — отдельная касса: в общую статистику доходов/расходов не попадают. Зарплату наличными начисляйте через Операции → «+ Операция» → категория «Зарплата» → источник «Наличные».</div>
    <div class="list">
      ${cash.length ? cash.map((c) => `
        <div class="row-card" data-cash="${c.id}">
          <div class="grow col"><div class="title">${esc(OWNERS.find((o) => o.id === c.owner)?.name || c.owner)}: ${esc(c.category || '')}</div>
          <div class="sub">${fmtDate(c.date)}${c.employeeId ? ' · ' + esc(empName(c.employeeId)) : ''}${c.comment ? ' · ' + esc(c.comment) : ''}</div></div>
          <div class="amount ${c.type === 'income' ? 'green' : 'red'}">${c.type === 'income' ? '+' : '−'}${money(c.amount)}</div>
        </div>`).join('') : `<div class="card empty"><div class="big">💵</div>Операций с наличными пока нет</div>`}
    </div>`;
  $('#add-cash').addEventListener('click', () => openCashForm());
  $('#view').querySelectorAll('[data-cash]').forEach((el) => el.addEventListener('click', () => openCashForm((S.data.cash || []).find((c) => c.id === el.dataset.cash))));
}

function openCashForm(c) {
  const isNew = !c;
  const cashOwners = OWNERS.filter((o) => o.cashbox);
  openModal(`
    <h2>${isNew ? 'Операция с наличными' : 'Наличные'}</h2>
    <form id="ent-form">
      <div class="form-row">
        <label class="field"><span>Чья касса</span>
          <select name="owner">${cashOwners.map((o) => `<option value="${o.id}" ${(c?.owner || 'savva') === o.id ? 'selected' : ''}>${o.name}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Тип</span>
          <select name="type">
            <option value="income" ${(c?.type || 'income') === 'income' ? 'selected' : ''}>Пришло</option>
            <option value="expense" ${c?.type === 'expense' ? 'selected' : ''}>Ушло</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span>Сумма, ₽</span><input type="number" name="amount" required step="0.01" value="${esc(c?.amount || '')}"></label>
        <label class="field"><span>Дата</span><input type="date" name="date" required value="${esc(c?.date || today())}"></label>
      </div>
      <label class="field"><span>Категория</span>
        <select name="category">${FIN_CATEGORIES.map((x) => `<option ${c?.category === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Сотрудник — если это зарплата или выплата ему</span>
        <select name="employeeId">
          <option value="">— не относится к сотруднику —</option>
          ${(S.data.employees || []).filter((p) => p.active !== false).map((p) => `<option value="${p.id}" ${c?.employeeId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <div id="salary-extra"></div>
      <label class="field"><span>Комментарий</span><input type="text" name="comment" value="${esc(c?.comment || '')}"></label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);

    // Зачёт непогашенных трат сотрудника при зарплате наличными
    const updHint = () => {
      const hint = $('#offset-hint', root);
      if (!hint) return;
      const amt = Number(root.querySelector('[name=amount]').value) || 0;
      const sum = [...root.querySelectorAll('[name=offset]:checked')].reduce((s, cb) => s + Number(cb.dataset.amt), 0);
      hint.textContent = sum ? `К выплате: ${money(amt)} − ${money(sum)} = ${money(amt - sum)}. Выбранные траты будут погашены.` : '';
    };
    const updSalary = () => {
      const box = $('#salary-extra', root);
      const cat = root.querySelector('[name=category]').value;
      const empId = root.querySelector('[name=employeeId]').value;
      if (!isNew || cat !== 'Зарплата' || !empId) { box.innerHTML = ''; return; }
      const pend = (S.data.staffExpenses || []).filter((e) => e.status === 'pending' && e.employeeId === empId);
      box.innerHTML = pend.length ? `
        <div class="field"><span class="small" style="font-weight:600;color:var(--muted)">Зачесть траты сотрудника</span>
          ${pend.map((e2) => `<label class="checkline"><input type="checkbox" name="offset" value="${e2.id}" data-amt="${e2.amount}"><span>${esc(e2.title)} — ${money(e2.amount)}</span></label>`).join('')}
          <div class="muted small" id="offset-hint"></div>
        </div>` : '';
      box.querySelectorAll('[name=offset]').forEach((cb) => cb.addEventListener('change', updHint));
    };
    root.querySelector('[name=category]').addEventListener('change', updSalary);
    root.querySelector('[name=employeeId]').addEventListener('change', updSalary);
    root.querySelector('[name=amount]').addEventListener('input', updHint);
    updSalary();

    $('#ent-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const item = Object.fromEntries(new FormData(e.target).entries());
      item.businessId = item.unit;
      const offsetIds = [...root.querySelectorAll('[name=offset]:checked')].map((cb) => cb.value);
      delete item.offset;
      closeModal();
      if (isNew) await doCreate('cash', { ...item, offsetIds }, 'Добавлено');
      else await doUpdate('cash', { ...c, ...item }, 'Сохранено');
      if (offsetIds.length) refresh(true);
    });
    $('#ent-del', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить запись?')) return;
      closeModal();
      await doDelete('cash', c.id, 'Удалено');
    });
  });
}

function openFinForm(f) {
  const isNew = !f;
  const units = myUnits();
  const bankManaged = !!f && (f.source === 'bank' || f.bankId || f.bankQueueId || f.applicationId || f.appliedRuleId);
  if (bankManaged) {
    const method = FIN_METHODS.find((item) => item.id === f.method)?.name || f.method || 'Счёт';
    openModal(`
      <h2>Банковская операция</h2>
      <div class="banner">Эта запись защищена от обычного редактирования и удаления. Исправить категорию, способ, владельца, контрагента или комментарий можно только через журнал — так сохранится история изменений.</div>
      <div class="bank-pending-summary">
        <div><span>Дата</span><strong>${fmtDate(f.date)}</strong></div>
        <div><span>Тип</span><strong>${f.type === 'income' ? 'Поступление' : 'Списание'}</strong></div>
        <div><span>Сумма</span><strong class="${f.type === 'income' ? 'green' : 'red'}">${money(f.amount)}</strong></div>
        <div><span>Способ</span><strong>${esc(method)}</strong></div>
      </div>
      <div class="card"><strong>${esc(f.category || 'Без категории')}</strong><div class="muted small">${esc(f.counterparty || 'Контрагент не указан')}</div>${f.comment ? `<div class="small">${esc(f.comment)}</div>` : ''}</div>
      <div class="actions"><button type="button" class="btn" id="modal-cancel">Закрыть</button><button type="button" class="btn primary" id="open-bank-journal">Открыть журнал</button></div>
    `, (root) => {
      $('#modal-cancel', root).addEventListener('click', closeModal);
      $('#open-bank-journal', root).addEventListener('click', () => {
        closeModal(); S.finTab = 'bank'; S.bankSubTab = 'journal'; render();
      });
    });
    return;
  }
  openModal(`
    <h2>${isNew ? 'Новая операция' : 'Операция'}</h2>
    <form id="ent-form">
      <div class="form-row">
        <label class="field"><span>Тип</span>
          <select name="type">
            <option value="income" ${(f?.type || 'income') === 'income' ? 'selected' : ''}>Доход</option>
            <option value="expense" ${f?.type === 'expense' ? 'selected' : ''}>Расход</option>
          </select>
        </label>
        <label class="field"><span>Сумма, ₽</span><input type="number" name="amount" required step="0.01" value="${esc(f?.amount || '')}"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Дата</span><input type="date" name="date" required value="${esc(f?.date || today())}"></label>
        <label class="field"><span>Способ</span>
          <select name="method">${FIN_METHODS.map((x) => `<option value="${x.id}" ${(f?.method || 'account') === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span>Направление</span>
          <select name="unit">${units.map((u) => `<option value="${u}" ${(businessIdOf(f) || (S.unit !== 'all' ? S.unit : units[0])) === u ? 'selected' : ''}>${esc(businessName(u))}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Категория</span>
          <select name="category">${FIN_CATEGORIES.map((c) => `<option ${f?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
      </div>
      <label class="field"><span>Контрагент</span><input type="text" name="counterparty" value="${esc(f?.counterparty || '')}"></label>
      <label class="field"><span>Чей расход — спишется с личного счёта</span>
        <select name="owner">
          <option value="">— общий, ни на кого —</option>
          ${OWNERS.map((o) => `<option value="${o.id}" ${f?.owner === o.id ? 'selected' : ''}>${o.name}</option>`).join('')}
          <option value="savva_andrey" ${f?.owner === 'savva_andrey' ? 'selected' : ''}>Савва и Андрей (пополам)</option>
        </select>
      </label>
      <label class="field"><span>Сотрудник — если это зарплата или компенсация ему</span>
        <select name="employeeId">
          <option value="">— не относится к сотруднику —</option>
          ${(S.data.employees || []).filter((p) => p.active !== false).map((p) => `<option value="${p.id}" ${f?.employeeId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <div id="salary-extra"></div>
      <label class="field"><span>Комментарий</span><input type="text" name="comment" value="${esc(f?.comment || '')}"></label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);

    // Блок «зарплата»: источник выплаты + зачёт трат сотрудника
    const updHint = () => {
      const hint = $('#offset-hint', root);
      if (!hint) return;
      const amt = Number(root.querySelector('[name=amount]').value) || 0;
      const sum = [...root.querySelectorAll('[name=offset]:checked')].reduce((s, c) => s + Number(c.dataset.amt), 0);
      hint.textContent = sum ? `К выплате: ${money(amt)} − ${money(sum)} = ${money(amt - sum)}. Выбранные траты будут погашены.` : '';
    };
    const updSalary = () => {
      const box = $('#salary-extra', root);
      const cat = root.querySelector('[name=category]').value;
      const empId = root.querySelector('[name=employeeId]').value;
      if (!isNew || cat !== 'Зарплата' || !empId) { box.innerHTML = ''; return; }
      const pend = (S.data.staffExpenses || []).filter((e) => e.status === 'pending' && e.employeeId === empId);
      box.innerHTML = `
        <label class="field"><span>Источник выплаты</span>
          <select name="paySource">
            <option value="account">Счёт / безнал</option>
            <option value="cash:savva">💵 Наличные Саввы</option>
            <option value="cash:andrey">💵 Наличные Андрея</option>
          </select>
        </label>
        ${pend.length ? `<div class="field"><span class="small" style="font-weight:600;color:var(--muted)">Зачесть траты сотрудника</span>
          ${pend.map((e2) => `<label class="checkline"><input type="checkbox" name="offset" value="${e2.id}" data-amt="${e2.amount}"><span>${esc(e2.title)} — ${money(e2.amount)}</span></label>`).join('')}
          <div class="muted small" id="offset-hint"></div>
        </div>` : ''}`;
      box.querySelectorAll('[name=offset]').forEach((cb) => cb.addEventListener('change', updHint));
      updHint();
    };
    root.querySelector('[name=category]').addEventListener('change', updSalary);
    root.querySelector('[name=employeeId]').addEventListener('change', updSalary);
    root.querySelector('[name=amount]').addEventListener('input', updHint);
    updSalary();

    $('#ent-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const item = Object.fromEntries(new FormData(e.target).entries());
      item.businessId = item.unit;
      const offsetIds = [...root.querySelectorAll('[name=offset]:checked')].map((c) => c.value);
      const paySource = item.paySource || 'account';
      delete item.paySource;
      delete item.offset;
      closeModal();
      if (isNew && item.category === 'Зарплата' && paySource.startsWith('cash:')) {
        await doCreate('cash', { owner: paySource.slice(5), date: item.date, type: 'expense', amount: item.amount, category: 'Зарплата', comment: item.comment || '', employeeId: item.employeeId || '', offsetIds }, 'Зарплата выплачена наличными');
        S.finTab = 'cash';
      } else if (isNew) {
        await doCreate('finance', { ...item, source: 'manual', offsetIds }, 'Добавлено');
      } else {
        await doUpdate('finance', { ...f, ...item }, 'Сохранено');
      }
      if (offsetIds.length) refresh(true);
      render();
    });
    $('#ent-del', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить запись?')) return;
      closeModal();
      await doDelete('finance', f.id, 'Удалено');
    });
  });
}

// ---------- Мои деньги (сотрудник) ----------
function viewMoney() {
  if (isAdmin()) { location.hash = '#/finance'; return; }
  setTitle('Мои деньги');
  const month = today().slice(0, 7);
  const paid = [
    ...(S.data.finance || []),
    ...(S.data.cash || []).map((c) => ({ ...c, _cash: true }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const paidMonth = paid.filter((f) => (f.date || '').startsWith(month)).reduce((s, f) => s + Number(f.amount || 0), 0);
  const paidTotal = paid.reduce((s, f) => s + Number(f.amount || 0), 0);
  const ex = (S.data.staffExpenses || []).sort((a, b) => (b.created || 0) - (a.created || 0));
  const pendingSum = ex.filter((e) => e.status === 'pending').reduce((s, e) => s + Number(e.amount || 0), 0);
  const expensesOn = activeUnits().some(canUseExpenses);

  $('#view').innerHTML = `
    <div class="cards-row">
      <div class="card stat"><div class="label">Выплачено за месяц</div><div class="value green">${money(paidMonth)}</div></div>
      <div class="card stat"><div class="label">Выплачено всего</div><div class="value">${money(paidTotal)}</div></div>
      ${expensesOn ? `<div class="card stat"><div class="label">Жду возврата</div><div class="value ${pendingSum ? 'red' : ''}">${money(pendingSum)}</div></div>` : ''}
    </div>
    ${expensesOn ? `
    <div class="section-title">Мои траты <button class="btn small primary" id="add-expense" style="margin-left:auto">+ Трата</button></div>
    <div class="list">
      ${ex.length ? ex.map((e) => {
        const st = EX_STATUS[e.status] || EX_STATUS.pending;
        return `<div class="row-card" data-ex="${e.id}">
          <div class="grow col"><div class="title">${esc(e.title)}</div><div class="sub">${fmtDate(e.date)}</div></div>
          <div class="amount">${money(e.amount)}</div>
          <span class="badge ${st.color} dot">${st.name}</span>
        </div>`;
      }).join('') : `<div class="card empty"><div class="big">🧾</div>Купили что-то для работы за свои — добавьте трату, и вам вернут деньги</div>`}
    </div>` : ''}
    <div class="section-title">Выплаты мне</div>
    <div class="list">
      ${paid.length ? paid.map((f) => `
        <div class="row-card" style="cursor:default">
          <div class="grow col"><div class="title">${esc(f.category || 'Выплата')}</div><div class="sub">${fmtDate(f.date)}${f.comment ? ' · ' + esc(f.comment) : ''}</div></div>
          ${f._cash ? '<span class="badge">💵 наличными</span>' : ''}
          <div class="amount green">+${money(f.amount)}</div>
        </div>`).join('') : `<div class="card empty"><div class="big">💰</div>Выплат пока не было</div>`}
    </div>`;

  $('#add-expense')?.addEventListener('click', () => openStaffExpenseForm());
  $('#view').querySelectorAll('[data-ex]').forEach((el) => el.addEventListener('click', () => {
    const e = ex.find((x) => x.id === el.dataset.ex);
    if (!e) return;
    if (e.status === 'pending') openStaffExpenseForm(e);
    else showMyReceipt(e);
  }));
}

/** Сжимаем фото на телефоне до разумного размера перед отправкой. */
function resizePhoto(file, max = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc);
      c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('bad image')); };
    img.src = URL.createObjectURL(file);
  });
}

function showMyReceipt(e) {
  const st = EX_STATUS[e.status] || EX_STATUS.pending;
  openModal(`
    <h2>${esc(e.title)} <span class="badge ${st.color} dot">${st.name}</span></h2>
    <p class="small">${fmtDate(e.date)} · <b>${money(e.amount)}</b></p>
    <div id="receipt-holder" class="muted small">Загружаю чек…</div>
    <div class="actions"><button class="btn" id="modal-cancel">Закрыть</button></div>
  `, async (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    const r = await S.store.getFile(S.token, e.receiptId);
    $('#receipt-holder', root).innerHTML = r.ok && String(r.b64).startsWith('data:image/')
      ? `<img class="receipt-img" src="${r.b64}" alt="Чек">`
      : `<div class="muted small">${esc(r.error || 'Чек не найден')}</div>`;
  });
}

function openStaffExpenseForm(ex) {
  const isNew = !ex;
  openModal(`
    <h2>${isNew ? 'Новая трата' : 'Трата'}</h2>
    <p class="muted small">Опишите, что вы купили для работы за свои деньги, и сфотографируйте чек — админ получит уведомление и вернёт вам сумму.</p>
    <form id="ent-form">
      <label class="field"><span>Что купили</span><input type="text" name="title" required value="${esc(ex?.title || '')}" placeholder="Например: бананы и вода на турнир"></label>
      <div class="form-row">
        <label class="field"><span>Сумма, ₽</span><input type="number" name="amount" required step="0.01" value="${esc(ex?.amount || '')}"></label>
        <label class="field"><span>Дата</span><input type="date" name="date" required value="${esc(ex?.date || today())}"></label>
      </div>
      <label class="field"><span>Фото чека — обязательно</span>
        <input type="file" id="receipt-input" accept="image/*" ${isNew ? 'required' : ''}>
        <img id="receipt-preview" class="receipt-img" style="display:none" alt="Чек">
        ${!isNew && ex.receiptId ? `<p class="muted small" style="margin:6px 0 0">Чек уже прикреплён — выберите файл, только если хотите заменить.</p>` : ''}
      </label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary" id="ex-submit">${isNew ? 'Отправить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    let photoB64 = null;
    $('#receipt-input', root).addEventListener('change', async (e2) => {
      const file = e2.target.files[0];
      if (!file) { photoB64 = null; return; }
      try {
        photoB64 = await resizePhoto(file);
        const prev = $('#receipt-preview', root);
        prev.src = photoB64;
        prev.style.display = 'block';
      } catch {
        photoB64 = null;
        toast('Не удалось прочитать фото', true);
      }
    });
    $('#ent-form', root).addEventListener('submit', async (e2) => {
      e2.preventDefault();
      const item = Object.fromEntries(new FormData(e2.target).entries());
      if (isNew && !photoB64) { toast('Прикрепите фото чека', true); return; }
      const btn = $('#ex-submit', root);
      btn.disabled = true;
      let receiptId = ex?.receiptId || '';
      if (photoB64) {
        const up = await S.store.uploadFile(S.token, photoB64);
        if (!up.ok) { toast(up.error || 'Не удалось загрузить фото', true); btn.disabled = false; return; }
        receiptId = up.id;
      }
      closeModal();
      const businessId = S.unit !== 'all' ? S.unit : activeUnits()[0];
      if (isNew) await doCreate('staffExpenses', { title: item.title, amount: item.amount, date: item.date, receiptId, businessId, unit: businessId }, 'Трата отправлена — админу пришло уведомление');
      else await doUpdate('staffExpenses', { ...ex, title: item.title, amount: item.amount, date: item.date, receiptId }, 'Сохранено');
    });
    $('#ent-del', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить трату?')) return;
      closeModal();
      await doDelete('staffExpenses', ex.id, 'Удалено');
    });
  });
}

// ---------- Команда ----------
function viewTeam() {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  setTitle('Команда');
  const list = S.data.employees || [];
  $('#view').innerHTML = `
    <div class="searchbar"><div class="grow"></div><button class="btn primary" id="add-emp">+ Сотрудник</button></div>
    <div class="list">
      ${list.map((e) => `
        <div class="row-card" data-emp="${e.id}" style="${e.active === false ? 'opacity:.5' : ''}">
          <div class="grow col">
            <div class="title">${esc(e.name)}</div>
            <div class="sub">${e.role === 'admin' ? 'администратор' : 'сотрудник'} · ${esc(employeeBusinessIds(e).map(businessName).join(', ') || 'без доступа')}${e.active === false ? ' · отключён' : ''}</div>
          </div>
          ${e.code ? `<button class="btn small" data-code="${esc(e.code)}" title="Скопировать код входа">🔑 ${esc(e.code)}</button>` : ''}
        </div>`).join('')}
    </div>
    <p class="muted small">🔑 — личный код для входа. Передайте его сотруднику, он вводит код на странице входа.</p>`;
  $('#add-emp').addEventListener('click', () => openEmpForm());
  $('#view').querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(b.dataset.code).then(() => toast('Код скопирован'));
  }));
  $('#view').querySelectorAll('[data-emp]').forEach((el) => el.addEventListener('click', () => openEmpForm((S.data.employees || []).find((x) => x.id === el.dataset.emp))));
}

function openEmpForm(emp) {
  const isNew = !emp;
  openModal(`
    <h2>${isNew ? 'Новый сотрудник' : esc(emp.name)}</h2>
    <form id="ent-form">
      <label class="field"><span>Имя</span><input type="text" name="name" required value="${esc(emp?.name || '')}"></label>
      <div class="form-row">
        <label class="field"><span>Роль</span>
          <select name="role">
            <option value="staff" ${(emp?.role || 'staff') === 'staff' ? 'selected' : ''}>Сотрудник</option>
            <option value="admin" ${emp?.role === 'admin' ? 'selected' : ''}>Администратор</option>
          </select>
        </label>
        <label class="field"><span>Направление</span>
          <select name="unit">
            ${businesses().map((b) => `<option value="${esc(b.id)}" ${emp?.unit === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            <option value="all" ${emp?.unit === 'all' ? 'selected' : ''}>Все направления</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(emp?.phone || '')}"></label>
        <label class="field"><span>Telegram</span><input type="text" name="tg" value="${esc(emp?.tg || '')}"></label>
      </div>
      ${!isNew ? `<label class="field"><span>Доступ</span>
        <select name="active"><option value="true" ${emp.active !== false ? 'selected' : ''}>Активен</option><option value="false" ${emp.active === false ? 'selected' : ''}>Отключён</option></select>
      </label>` : `<p class="muted small">Код для входа сгенерируется автоматически — вы увидите его в списке.</p>`}
      <div class="actions">
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#ent-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const item = Object.fromEntries(new FormData(e.target).entries());
      if (item.active !== undefined) item.active = item.active === 'true';
      closeModal();
      if (isNew) await doCreate('employees', item, 'Сотрудник добавлен');
      else await doUpdate('employees', { ...emp, ...item }, 'Сохранено');
    });
  });
}

// ---------- Бизнесы и настройки ----------
function businessAdminHtml() {
  const memberships = S.data.memberships || [];
  const owners = S.data.businessOwners || [];
  const employees = S.data.employees || [];
  const orderedBusinesses = [...allBusinesses()].sort((left, right) => Number(left.active === false) - Number(right.active === false));
  return `
    <div class="card business-admin" style="margin-bottom:12px">
      <div class="business-admin-head">
        <div>
          <div class="section-title" style="margin-top:0">🏢 Бизнесы, роли и доступы</div>
          <p class="small muted">Создавайте новые бизнесы, выбирайте им разделы и настраивайте доступы. Архив скрывает бизнес из переключателя, но сохраняет его данные.</p>
        </div>
        <button class="btn primary create-business" type="button" id="create-business">+ Создать бизнес</button>
      </div>
      <div class="business-grid">
        ${orderedBusinesses.map((b) => {
          const businessOwners = owners.filter((o) => businessIdOf(o) === b.id && o.active !== false);
          const totalShare = businessOwners.reduce((sum, o) => sum + Number(o.share || 0), 0) * 100;
          const archived = b.active === false;
          return `<form class="business-card ${archived ? 'archived' : ''}" data-business-form="${esc(b.id)}">
            <div class="business-card-title"><span>${esc(b.emoji || '🏢')}</span><b>${esc(b.name)}</b>${archived ? '<span class="badge">в архиве</span>' : ''}<code>${esc(b.id)}</code></div>
            <div class="form-row">
              <label class="field"><span>Название</span><input name="name" required value="${esc(b.name)}" ${archived ? 'disabled' : ''}></label>
              <label class="field compact-field"><span>Значок</span><input name="emoji" maxlength="8" value="${esc(b.emoji || '🏢')}" ${archived ? 'disabled' : ''}></label>
            </div>
            <div class="field"><span>Модули</span><div class="check-grid">
              ${Object.entries(BUSINESS_MODULES).map(([id, name]) => `<label class="checkline"><input type="checkbox" name="module" value="${id}" ${(b.modules || []).includes(id) ? 'checked' : ''} ${archived ? 'disabled' : ''}><span>${esc(name)}</span></label>`).join('')}
            </div></div>
            <div class="section-title">Участники и доли <span class="muted small">сумма: ${totalShare.toLocaleString('ru-RU')}%</span></div>
            <div class="owner-grid">
              ${businessOwners.map((o) => `<label class="field owner-share"><span>${esc(o.name || ownerLabel(o.ownerId) || o.ownerId)}</span><div class="suffix-input"><input type="number" min="0" max="100" step="0.01" data-owner-share="${esc(o.id)}" value="${Number(o.share || 0) * 100}" ${archived ? 'disabled' : ''}><span>%</span></div></label>`).join('')}
            </div>
            <div class="section-title">Доступ сотрудников</div>
            <div class="access-list">
              ${employees.map((employee) => {
                const membership = memberships.find((m) => m.employeeId === employee.id && businessIdOf(m) === b.id);
                const self = employee.id === S.profile.id;
                return `<div class="access-row" data-access-row="${esc(employee.id)}" data-membership-id="${esc(membership?.id || '')}">
                  <label class="checkline grow"><input type="checkbox" data-access ${membership?.active !== false && !!membership ? 'checked' : ''} ${self || archived ? 'disabled' : ''}><span>${esc(employee.name)}</span></label>
                  <select data-access-role ${self || archived ? 'disabled' : ''}><option value="staff" ${!['owner', 'manager'].includes(membership?.role) ? 'selected' : ''}>сотрудник</option><option value="manager" ${membership?.role === 'manager' ? 'selected' : ''}>менеджер</option><option value="owner" ${membership?.role === 'owner' ? 'selected' : ''}>владелец</option></select>
                </div>`;
              }).join('')}
            </div>
            <div class="actions">
              <button class="btn ${archived ? 'primary' : 'danger ghost'} left" type="button" data-business-active="${archived ? 'true' : 'false'}">${archived ? 'Восстановить' : 'В архив'}</button>
              ${archived ? '' : '<button class="btn primary" type="submit">Сохранить бизнес</button>'}
            </div>
          </form>`;
        }).join('')}
      </div>
    </div>`;
}

function openBusinessCreateForm() {
  openModal(`
    <h2>Создать бизнес</h2>
    <form id="business-create-form">
      <div class="form-row">
        <label class="field"><span>Название</span><input type="text" name="name" required autofocus placeholder="Например, События"></label>
        <label class="field compact-field"><span>Значок</span><input type="text" name="emoji" maxlength="8" value="🏢"></label>
      </div>
      <div class="field"><span>Модули</span><div class="check-grid">
        ${Object.entries(BUSINESS_MODULES).map(([id, name]) => `<label class="checkline"><input type="checkbox" name="module" value="${id}" ${['dashboard', 'tasks'].includes(id) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </div></div>
      <p class="small muted">После создания вы станете владельцем бизнеса. Доступ другим людям можно выдать в его карточке.</p>
      <div class="actions">
        <button class="btn" type="button" id="modal-cancel">Отмена</button>
        <button class="btn primary" type="submit">Создать</button>
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#business-create-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const name = form.elements.name.value.trim();
      if (!name) { toast('Введите название бизнеса', true); return; }
      const id = businessIdFromName(name, allBusinesses().map((item) => item.id));
      const modules = [...form.querySelectorAll('[name=module]:checked')].map((input) => input.value);
      const submit = form.querySelector('[type=submit]');
      submit.disabled = true;
      const result = await doCreate('businesses', {
        id, name, emoji: form.elements.emoji.value.trim() || '🏢', modules, active: true,
      }, 'Бизнес создан');
      if (!result) { submit.disabled = false; return; }
      closeModal();
      await refresh(true);
      S.unit = id;
      localStorage.setItem('monetki_unit', id);
      render();
    });
  });
}

function bindBusinessAdmin() {
  $('#create-business')?.addEventListener('click', openBusinessCreateForm);
  $('#view').querySelectorAll('[data-business-active]').forEach((button) => button.addEventListener('click', async () => {
    const form = button.closest('[data-business-form]');
    const current = allBusinesses().find((item) => item.id === form?.dataset.businessForm);
    if (!current) return;
    button.disabled = true;
    const active = button.dataset.businessActive === 'true';
    const result = await S.store.update(S.token, 'businesses', { ...current, active });
    if (!result.ok) toast(result.error || 'Не удалось изменить статус бизнеса', true);
    else toast(active ? 'Бизнес восстановлен' : 'Бизнес перемещён в архив');
    await refresh(true);
  }));
  $('#view').querySelectorAll('[data-business-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const businessId = form.dataset.businessForm;
    const current = (S.data.businesses || []).find((b) => b.id === businessId);
    if (!current) return;
    const ownerInputs = [...form.querySelectorAll('[data-owner-share]')];
    const totalShare = ownerInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    if (ownerInputs.length && Math.abs(totalShare - 100) > 0.01) { toast('Доли участников должны в сумме давать 100%', true); return; }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    const modules = [...form.querySelectorAll('[name=module]:checked')].map((input) => input.value);
    const updatedBusiness = { ...current, name: form.elements.name.value.trim(), emoji: form.elements.emoji.value.trim() || '🏢', modules };
    const results = [await S.store.update(S.token, 'businesses', updatedBusiness)];
    for (const input of ownerInputs) {
      const owner = (S.data.businessOwners || []).find((o) => o.id === input.dataset.ownerShare);
      if (owner) results.push(await S.store.update(S.token, 'businessOwners', { ...owner, share: Number(input.value) / 100 }));
    }
    for (const row of form.querySelectorAll('[data-access-row]')) {
      if (row.dataset.accessRow === S.profile.id) continue;
      const membership = (S.data.memberships || []).find((m) => m.id === row.dataset.membershipId);
      const data = {
        businessId, unit: businessId, employeeId: row.dataset.accessRow,
        role: row.querySelector('[data-access-role]').value,
        active: row.querySelector('[data-access]').checked
      };
      results.push(membership
        ? await S.store.update(S.token, 'memberships', { ...membership, ...data })
        : await S.store.create(S.token, 'memberships', data));
    }
    const failed = results.find((result) => !result.ok);
    if (failed) toast(failed.error || 'Не удалось сохранить бизнес', true);
    else toast('Настройки бизнеса сохранены');
    await refresh(true);
  }));
}

function viewSettings() {
  setTitle('Ещё');
  const backend = localStorage.getItem('monetki_backend') || (window.MONETKI_CONFIG?.backendUrl || '');
  const notifState = !('Notification' in window) ? 'нет поддержки' : Notification.permission === 'granted' ? 'включены ✓' : Notification.permission === 'denied' ? 'запрещены в браузере' : 'не включены';
  const quickLinks = navItems().filter((i) => !['settings', 'dashboard'].includes(i.r));
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">📂 Все разделы</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${quickLinks.map((i) => `<button class="btn" data-nav2="${i.r}">${i.ico} ${i.label}</button>`).join('')}
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">🎨 Тема</div>
      <div class="chip-row" style="margin-bottom:0">
        ${[['', 'Как в системе'], ['light', '☀️ Светлая'], ['dark', '🌙 Тёмная']].map(([k, l]) =>
          `<button class="chip ${(localStorage.getItem('monetki_theme') || '') === k ? 'active' : ''}" data-theme-pick="${k}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">🔔 Уведомления</div>
      <p class="small muted">Статус: <b>${notifState}</b>. Уведомления приходят о новых задачах, сообщениях и дедлайнах, пока приложение открыто или установлено на телефон.</p>
      ${('Notification' in window) && Notification.permission !== 'granted' ? `<button class="btn" id="notif-on">Включить уведомления</button>` : ''}
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">📱 Установить на телефон</div>
      <p class="small muted">iPhone: Safari → «Поделиться» → «На экран “Домой”».<br>Android: Chrome → меню ⋮ → «Установить приложение».</p>
    </div>
    ${isAdmin() ? businessAdminHtml() : ''}
    ${isAdmin() ? `
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">🗄️ Общая база Supabase</div>
      <p class="small muted">${backend ? 'База подключена.' : 'База не подключена — работаем в демо-режиме. Инструкция в файле SETUP-SUPABASE.md в репозитории.'}</p>
      <label class="field"><span>Адрес серверной функции</span><input type="url" id="backend-url" placeholder="https://….supabase.co/functions/v1/api" value="${esc(backend)}"></label>
      <button class="btn primary" id="backend-save">Сохранить и перезагрузить</button>
    </div>` : ''}
    ${isAdmin() ? `
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">💾 Резервная копия</div>
      <p class="small muted">Скачивает все данные (клиенты, задачи, финансы, коды сотрудников) в один файл. Нужна для переезда на новую базу и просто на всякий случай.</p>
      <button class="btn" id="backup-download">⬇️ Скачать копию</button>
    </div>` : ''}
    <div class="card">
      <div class="section-title" style="margin-top:0">👤 ${esc(S.profile.name)}</div>
      <p class="small muted">${isAdmin() ? 'Администратор' : 'Сотрудник'} · Монетки v${window.MONETKI_CONFIG?.version || ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="do-refresh">🔄 Обновить данные</button>
        <button class="btn danger" id="do-logout">Выйти</button>
      </div>
    </div>`;
  $('#view').querySelectorAll('[data-theme-pick]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.themePick;
    if (t) localStorage.setItem('monetki_theme', t); else localStorage.removeItem('monetki_theme');
    document.documentElement.dataset.theme = t;
    syncThemeColor();
    render();
  }));
  if (isAdmin()) bindBusinessAdmin();
  $('#view').querySelectorAll('[data-nav2]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.nav2; }));
  $('#notif-on')?.addEventListener('click', () => Notification.requestPermission().then(() => render()));
  $('#backend-save')?.addEventListener('click', () => {
    const v = $('#backend-url').value.trim();
    if (v) localStorage.setItem('monetki_backend', v); else localStorage.removeItem('monetki_backend');
    location.reload();
  });
  $('#backup-download')?.addEventListener('click', async () => {
    toast('Собираю копию…');
    const res = await S.store.backup(S.token);
    if (!res.ok) { toast('Не удалось собрать копию', true); return; }
    const payload = { app: 'monetki', exported: new Date().toISOString(), ...res.data };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `monetki-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Копия скачана');
  });
  $('#do-refresh').addEventListener('click', () => { refresh(); toast('Обновлено'); });
  $('#do-logout').addEventListener('click', logout);
}

// ---------- Уведомления (панель) ----------
function showNotifications() {
  const list = (S.data.notifications || []).sort((a, b) => b.created - a.created).slice(0, 50);
  openModal(`
    <h2>Уведомления</h2>
    <div class="notif-list">
      ${list.length ? list.map((n) => `
        <div class="notif ${n.read ? '' : 'unread'}" data-notif="${n.id}" data-link="${esc(n.link || '')}">
          ${esc(n.text)}<span class="time">${fmtDT(n.created)}</span>
        </div>`).join('') : '<div class="empty">Уведомлений нет</div>'}
    </div>
    <div class="actions">
      ${list.some((n) => !n.read) ? `<button class="btn left" id="read-all">Прочитать все</button>` : ''}
      <button class="btn" id="modal-cancel">Закрыть</button>
    </div>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#read-all', root)?.addEventListener('click', () => {
      const ids = list.filter((n) => !n.read).map((n) => n.id);
      (S.data.notifications || []).forEach((n) => { if (ids.includes(n.id)) n.read = true; });
      closeModal();
      render();
      S.store.markRead(S.token, ids);
    });
    root.querySelectorAll('[data-notif]').forEach((el) => el.addEventListener('click', () => {
      const n = (S.data.notifications || []).find((x) => x.id === el.dataset.notif);
      if (n) n.read = true;
      closeModal();
      if (el.dataset.link) location.hash = el.dataset.link;
      // рендерим всегда: если hash не поменялся, hashchange не сработает, а счётчик у колокольчика должен погаснуть сразу
      render();
      S.store.markRead(S.token, [el.dataset.notif]);
    }));
  });
}

// ---------- Общий обработчик форм сущностей ----------
function bindEntityForm(root, entity, existing, extra = {}) {
  $('#modal-cancel', root).addEventListener('click', closeModal);
  $('#ent-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = Object.fromEntries(new FormData(e.target).entries());
    if (item.unit) item.businessId = item.unit;
    closeModal();
    if (existing) await doUpdate(entity, { ...existing, ...item }, 'Сохранено');
    else await doCreate(entity, { ...item, ...extra }, 'Добавлено');
  });
  $('#ent-del', root)?.addEventListener('click', async () => {
    if (!confirm('Удалить запись?')) return;
    closeModal();
    await doDelete(entity, existing.id, 'Удалено');
  });
}

// ---------- Старт ----------
/** Цвет системной панели браузера следует за темой приложения. */
function syncThemeColor() {
  const forced = document.documentElement.dataset.theme;
  const dark = forced === 'dark' || (!forced && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#10131a' : '#f4f6fa');
}

async function init() {
  syncThemeColor();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);
  if (S.token) {
    await refresh();
    // База не ответила или сессия истекла — показываем экран входа, а не пустую страницу
    if (!S.profile) render();
  } else {
    render();
  }
  // Периодическое обновление: раз в 3 минуты + при возврате на вкладку
  setInterval(() => { if (S.token && document.visibilityState === 'visible') refresh(true); }, 180000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token) refresh(true); });
}
init();
