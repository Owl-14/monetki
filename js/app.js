// ============ Монетки: приложение ============
import { makeStore, UNITS, CLIENT_STATUSES, TASK_STATUSES, FIN_METHODS, FIN_CATEGORIES, OWNERS, ownerBalances } from './store.js';

// ---------- Утилиты ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0)) + ' ₽';
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); };
const fmtDT = (ts) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const today = () => new Date().toISOString().slice(0, 10);
const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');

function toast(text, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Состояние ----------
const S = {
  store: makeStore(),
  token: localStorage.getItem('monetki_token') || '',
  profile: null,
  data: null,
  unit: localStorage.getItem('monetki_unit') || 'padel',
  loading: false,
  taskFilter: { who: 'mine', status: 'active' },
  finMonth: today().slice(0, 7),
  search: {}
};

function isAdmin() { return S.profile && S.profile.role === 'admin'; }
function myUnits() {
  if (!S.profile) return [];
  return (isAdmin() || S.profile.unit === 'all') ? ['padel', 'dev'] : [S.profile.unit];
}
function activeUnits() {
  if (S.unit === 'all') return myUnits();
  return myUnits().includes(S.unit) ? [S.unit] : myUnits();
}
function empName(id) {
  const e = (S.data?.employees || []).find((x) => x.id === id);
  return e ? e.name : '—';
}

// ---------- Модалки ----------
function openModal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  $('.modal-backdrop', root).addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
  if (onMount) onMount(root);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

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
function applyLocal(entity, op, itemOrId) {
  if (!S.data) return;
  const arr = S.data[entity] || (S.data[entity] = []);
  if (op === 'create') arr.push(itemOrId);
  if (op === 'update') { const i = arr.findIndex((x) => x.id === itemOrId.id); if (i >= 0) arr[i] = itemOrId; else arr.push(itemOrId); }
  if (op === 'delete') S.data[entity] = arr.filter((x) => x.id !== itemOrId);
}

async function doCreate(entity, item, okText) {
  const res = await S.store.create(S.token, entity, item);
  if (!res.ok) { toast(res.error || 'Ошибка', true); return null; }
  applyLocal(entity, 'create', res.item || item);
  if (okText) toast(okText);
  render();
  return res;
}

async function doUpdate(entity, item, okText) {
  applyLocal(entity, 'update', item);
  render();
  if (okText) toast(okText);
  const res = await S.store.update(S.token, entity, item);
  if (!res.ok) { toast(res.error || 'Ошибка', true); refresh(true); return null; }
  return res;
}

async function doDelete(entity, id, okText) {
  applyLocal(entity, 'delete', id);
  render();
  if (okText) toast(okText);
  const res = await S.store.remove(S.token, entity, id);
  if (!res.ok) { toast(res.error || 'Ошибка', true); refresh(true); return null; }
  return res;
}

function logout() {
  S.token = ''; S.profile = null; S.data = null;
  localStorage.removeItem('monetki_token');
  location.hash = '#/login';
  render();
}

// ---------- Роутер ----------
const routes = ['dashboard', 'tasks', 'clients', 'venues', 'players', 'finance', 'money', 'team', 'settings', 'login'];
function currentRoute() {
  const r = (location.hash || '').replace('#/', '').split('?')[0];
  return routes.includes(r) ? r : 'dashboard';
}
window.addEventListener('hashchange', render);

// ---------- Навигация ----------
function navItems() {
  const units = activeUnits();
  const items = [
    { r: 'dashboard', ico: '🏠', label: 'Дашборд' },
    { r: 'tasks', ico: '✅', label: 'Задачи', badge: (S.data?.tasks || []).filter((t) => t.assigneeId === S.profile.id && t.status !== 'done').length || '' }
  ];
  if (!isAdmin()) items.push({ r: 'money', ico: '💰', label: 'Деньги' });
  if (units.includes('dev')) items.push({ r: 'clients', ico: '🤝', label: 'Клиенты' });
  if (units.includes('padel')) {
    items.push({ r: 'venues', ico: '🏟️', label: 'Площадки' });
    items.push({ r: 'players', ico: '🎾', label: 'Игроки' });
  }
  if (isAdmin()) {
    items.push({ r: 'finance', ico: '💰', label: 'Финансы' });
    items.push({ r: 'team', ico: '👥', label: 'Команда' });
  }
  items.push({ r: 'settings', ico: '⚙️', label: 'Ещё' });
  return items;
}

function unreadCount() { return (S.data?.notifications || []).filter((n) => !n.read).length; }

// ---------- Рендер ----------
function render() {
  const app = $('#app');
  if (!S.token || !S.profile) { renderLogin(app); return; }
  const route = currentRoute() === 'login' ? 'dashboard' : currentRoute();

  const items = navItems();
  const nav = items.map((i) => `
    <button class="nav-item ${route === i.r ? 'active' : ''}" data-nav="${i.r}">
      <span class="ico">${i.ico}</span>${i.label}
      ${i.badge ? `<span class="badge red">${i.badge}</span>` : ''}
    </button>`).join('');
  // Нижняя навигация (телефон): главное всегда под рукой — админу Финансы, сотруднику Деньги
  const sectionIds = items.map((i) => i.r);
  const unitFirst = ['clients', 'venues', 'players'].find((r) => sectionIds.includes(r));
  const wanted = ['dashboard', 'tasks', isAdmin() ? 'finance' : 'money', unitFirst, 'settings'].filter(Boolean);
  const bottomItems = wanted.map((r) => items.find((i) => i.r === r)).filter(Boolean);
  const bottomNav = bottomItems.map((i) => `
    <button class="${route === i.r ? 'active' : ''}" data-nav="${i.r}"><span class="ico">${i.ico}</span>${i.label}</button>`).join('');

  const showUnitSwitch = myUnits().length > 1;
  const unitSwitch = showUnitSwitch ? `
    <div class="unit-switch">
      ${myUnits().map((u) => `<button class="${S.unit === u ? 'active' : ''}" data-unit="${u}">${UNITS[u].emoji} ${UNITS[u].name}</button>`).join('')}
      <button class="${S.unit === 'all' ? 'active' : ''}" data-unit="all">Все</button>
    </div>` : '';

  const unread = unreadCount();
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="logo">М</div><div><div class="name">Монетки</div><div class="sub">${S.store.demo ? 'демо-режим' : 'общая база'}</div></div></div>
        ${nav}
        <div class="spacer"></div>
        <div class="whoami"><b>${esc(S.profile.name)}</b>${isAdmin() ? 'администратор' : esc(UNITS[S.profile.unit]?.name || '')}</div>
      </aside>
      <main class="main">
        <div class="topbar">
          <h1 id="page-title"></h1>
          <div class="grow"></div>
          ${unitSwitch}
          <button class="btn ghost bell" id="bell" title="Уведомления">🔔${unread ? `<span class="count">${unread}</span>` : ''}</button>
        </div>
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

  const views = { dashboard: viewDashboard, tasks: viewTasks, clients: viewClients, venues: viewVenues, players: viewPlayers, finance: viewFinance, money: viewMoney, team: viewTeam, settings: viewSettings };
  (views[route] || viewDashboard)();
}

function setTitle(t) { $('#page-title').textContent = t; }

// ---------- Логин ----------
function renderLogin(app) {
  const demo = S.store.demo;
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
    if (!(st?.ok && st.employees === 0)) return;
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
  const tasks = (S.data.tasks || []).filter((t) => units.includes(t.unit));
  const mine = tasks.filter((t) => t.assigneeId === S.profile.id && t.status !== 'done');
  const overdue = mine.filter((t) => t.due && t.due < today());
  const month = today().slice(0, 7);
  const fin = (S.data.finance || []).filter((f) => units.includes(f.unit) && (f.date || '').startsWith(month));
  const income = fin.filter((f) => f.type === 'income').reduce((s, f) => s + Number(f.amount || 0), 0);
  const expense = fin.filter((f) => f.type === 'expense').reduce((s, f) => s + Number(f.amount || 0), 0);

  let clientsStat = '';
  if (units.includes('dev')) {
    const cl = (S.data.clients || []).filter((c) => c.status === 'work' || c.status === 'talks');
    clientsStat = `<div class="card stat"><div class="label">Клиенты в работе</div><div class="value">${cl.length}</div><div class="hint">разработка</div></div>`;
  }
  let padelStat = '';
  if (units.includes('padel')) {
    padelStat = `<div class="card stat"><div class="label">Игроков в базе</div><div class="value">${(S.data.players || []).length}</div><div class="hint">падел</div></div>`;
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
  const lastOps = isAdmin() ? (S.data.finance || []).filter((f) => units.includes(f.unit)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5) : [];

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
  const unitTag = activeUnits().length > 1 ? `<span class="badge">${UNITS[t.unit]?.emoji || ''}</span>` : '';
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
  let tasks = (S.data.tasks || []).filter((t) => units.includes(t.unit));
  if (f.who === 'mine') tasks = tasks.filter((t) => t.assigneeId === S.profile.id);
  if (f.who === 'from-me') tasks = tasks.filter((t) => t.authorId === S.profile.id && t.assigneeId !== S.profile.id);
  if (f.status === 'active') tasks = tasks.filter((t) => t.status !== 'done');
  if (f.status === 'done') tasks = tasks.filter((t) => t.status === 'done');
  tasks.sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.due || '9999').localeCompare(b.due || '9999'));

  $('#view').innerHTML = `
    <div class="searchbar">
      <button class="btn primary" id="add-task">+ Задача</button>
    </div>
    <div class="chip-row" style="margin-bottom:6px">
      ${[['mine', 'Мои'], ['from-me', 'От меня'], ['all', 'Все']].map(([k, l]) => `<button class="chip ${f.who === k ? 'active' : ''}" data-who="${k}">${l}</button>`).join('')}
    </div>
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
  const unit = task?.unit || (units.length === 1 ? units[0] : (S.unit !== 'all' ? S.unit : units[0]));
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
        <select name="unit">${units.map((u) => `<option value="${u}" ${unit === u ? 'selected' : ''}>${UNITS[u].name}</option>`).join('')}</select></label>` : `<input type="hidden" name="unit" value="${unit}">`}
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

// ---------- Клиенты (разработка) ----------
function viewClients() {
  setTitle('Клиенты');
  const q = (S.search.clients || '').toLowerCase();
  let list = (S.data.clients || []).filter((c) => !q || (c.name + ' ' + (c.company || '') + ' ' + (c.phone || '')).toLowerCase().includes(q));
  const statuses = CLIENT_STATUSES.dev;
  list.sort((a, b) => statuses.findIndex((s) => s.id === a.status) - statuses.findIndex((s) => s.id === b.status));

  $('#view').innerHTML = `
    <div class="searchbar">
      <input type="search" id="cl-search" placeholder="Поиск по имени, компании, телефону" value="${esc(S.search.clients || '')}">
      <button class="btn primary" id="add-client">+ Клиент</button>
    </div>
    <div class="list">
      ${list.length ? list.map((c) => {
        const st = statuses.find((s) => s.id === c.status) || statuses[0];
        return `<div class="row-card" data-client="${c.id}">
          <div class="grow col">
            <div class="title">${esc(c.name)}</div>
            <div class="sub">${esc(c.company || '')}${c.company && c.phone ? ' · ' : ''}${esc(c.phone || '')}</div>
          </div>
          ${c.amount ? `<div class="amount">${money(c.amount)}</div>` : ''}
          <span class="badge ${st.color} dot">${st.name}</span>
        </div>`;
      }).join('') : `<div class="card empty"><div class="big">🤝</div>Клиентов пока нет</div>`}
    </div>`;

  $('#add-client').addEventListener('click', () => openClientForm());
  $('#cl-search').addEventListener('input', (e) => { S.search.clients = e.target.value; viewClients(); });
  $('#view').querySelectorAll('[data-client]').forEach((el) => el.addEventListener('click', () => openClientForm((S.data.clients || []).find((c) => c.id === el.dataset.client))));
}

function openClientForm(c) {
  const isNew = !c;
  openModal(`
    <h2>${isNew ? 'Новый клиент' : esc(c.name)}</h2>
    <form id="ent-form">
      <label class="field"><span>Название / имя</span><input type="text" name="name" required value="${esc(c?.name || '')}"></label>
      <div class="form-row">
        <label class="field"><span>Компания / ИП</span><input type="text" name="company" value="${esc(c?.company || '')}"></label>
        <label class="field"><span>Телефон</span><input type="tel" name="phone" value="${esc(c?.phone || '')}"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Telegram</span><input type="text" name="tg" value="${esc(c?.tg || '')}"></label>
        <label class="field"><span>Сумма сделки, ₽</span><input type="number" name="amount" value="${esc(c?.amount || '')}"></label>
      </div>
      <label class="field"><span>Статус</span>
        <select name="status">${CLIENT_STATUSES.dev.map((s) => `<option value="${s.id}" ${(c?.status || 'lead') === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Заметки</span><textarea name="notes">${esc(c?.notes || '')}</textarea></label>
      <div class="actions">
        ${!isNew ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        ${c?.phone ? `<a class="btn" href="${telHref(c.phone)}">📞 Позвонить</a>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => bindEntityForm(root, 'clients', c, { unit: 'dev' }));
}

// ---------- Площадки (падел) ----------
function viewVenues() {
  setTitle('Площадки');
  const list = S.data.venues || [];
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
    bindEntityForm(root, 'venues', v, { unit: 'padel' });
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
  const list = (S.data.players || []).filter((p) => !q || (p.name + ' ' + (p.phone || '')).toLowerCase().includes(q));
  $('#view').innerHTML = `
    <div class="searchbar">
      <input type="search" id="pl-search" placeholder="Поиск игрока" value="${esc(S.search.players || '')}">
      <button class="btn" id="import-players">📥 Импорт</button>
      <button class="btn primary" id="add-player">+ Игрок</button>
    </div>
    <div class="muted small" style="margin-bottom:10px">Всего: ${(S.data.players || []).length}</div>
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
  $('#import-players').addEventListener('click', openImportPlayers);
  $('#view').querySelectorAll('[data-player]').forEach((el) => el.addEventListener('click', () => openPlayerForm((S.data.players || []).find((p) => p.id === el.dataset.player))));
}

function openPlayerForm(p) {
  const isNew = !p;
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
  `, (root) => bindEntityForm(root, 'players', p, { unit: 'padel' }));
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

// ---------- Финансы ----------
function finRow(f) {
  const m = FIN_METHODS.find((x) => x.id === f.method);
  const unitTag = activeUnits().length > 1 ? `${UNITS[f.unit]?.emoji || ''} ` : '';
  const other = f.unit === 'padel' ? 'dev' : 'padel';
  return `
    <div class="row-card" data-fin="${f.id}">
      <div class="grow col">
        <div class="title">${unitTag}${esc(f.counterparty || f.category || 'Операция')}</div>
        <div class="sub">${fmtDate(f.date)} · ${esc(f.category || '')}${f.comment ? ' · ' + esc(f.comment) : ''}</div>
      </div>
      <span class="badge ${f.source === 'bank' ? 'blue' : ''}">${f.source === 'bank' ? '🏦 банк' : '✍️ вручную'}${m ? ' · ' + m.name : ''}</span>
      <div class="amount ${f.type === 'income' ? 'green' : 'red'}">${f.type === 'income' ? '+' : '−'}${money(f.amount)}</div>
      <button class="btn small" data-flip="${f.id}" title="Перекинуть в «${UNITS[other].name}»">${UNITS[other].emoji}</button>
    </div>`;
}

function bindFinRows(root) {
  root.querySelectorAll('[data-fin]').forEach((el) => el.addEventListener('click', () => openFinForm((S.data.finance || []).find((f) => f.id === el.dataset.fin))));
  root.querySelectorAll('[data-flip]').forEach((el) => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const f = (S.data.finance || []).find((x) => x.id === el.dataset.flip);
    if (!f) return;
    const other = f.unit === 'padel' ? 'dev' : 'padel';
    await doUpdate('finance', { ...f, unit: other }, `Перенесено в «${UNITS[other].name}»`);
  }));
}

function viewFinance() {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  setTitle('Финансы');
  const tab = S.finTab || 'ops';
  const pendingCount = (S.data.staffExpenses || []).filter((e) => e.status === 'pending').length;
  const tabs = [['ops', '💸 Операции'], ['staff', `🧾 Траты${pendingCount ? ' (' + pendingCount + ')' : ''}`], ['accounts', '👥 Счета'], ['cash', '💵 Наличные']];
  const tabsHtml = `<div class="chip-row">${tabs.map(([k, l]) => `<button class="chip ${tab === k ? 'active' : ''}" data-fintab="${k}">${l}</button>`).join('')}</div>`;
  const renderers = { ops: renderFinOps, staff: renderFinStaff, accounts: renderFinAccounts, cash: renderFinCash };
  (renderers[tab] || renderFinOps)(tabsHtml);
  $('#view').querySelectorAll('[data-fintab]').forEach((b) => b.addEventListener('click', () => { S.finTab = b.dataset.fintab; render(); }));
}

function renderFinOps(tabsHtml) {
  const units = activeUnits();
  const m = S.finMonth;
  const period = S.finPeriod || 'month';
  const inPeriod = (f) => period === 'all' || (f.date || '').startsWith(m);
  const list = (S.data.finance || []).filter((f) => units.includes(f.unit) && inPeriod(f)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const income = list.filter((f) => f.type === 'income').reduce((s, f) => s + Number(f.amount || 0), 0);
  const expense = list.filter((f) => f.type === 'expense').reduce((s, f) => s + Number(f.amount || 0), 0);
  const monthName = new Date(m + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const periodName = period === 'all' ? 'всё время' : monthName;

  $('#view').innerHTML = `
    ${tabsHtml}
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
  const bal = ownerBalances(S.data.finance || []);
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
      Разработка — Савва 50% / Андрей 50%; Падел — Андрей 34% / Савва 33% / Дмитрий 33%.
      Исключения: расход, записанный на конкретного человека («Чей расход» в операции), вычитается целиком только у него и не делится на всех;
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
  openModal(`
    <h2>${isNew ? 'Новая операция' : 'Операция'}</h2>
    ${f?.source === 'bank' ? `<div class="banner">Операция из банка — можно поменять направление и категорию, суммы редактировать нельзя.</div>` : ''}
    <form id="ent-form">
      <div class="form-row">
        <label class="field"><span>Тип</span>
          <select name="type" ${f?.source === 'bank' ? 'disabled' : ''}>
            <option value="income" ${(f?.type || 'income') === 'income' ? 'selected' : ''}>Доход</option>
            <option value="expense" ${f?.type === 'expense' ? 'selected' : ''}>Расход</option>
          </select>
        </label>
        <label class="field"><span>Сумма, ₽</span><input type="number" name="amount" required step="0.01" value="${esc(f?.amount || '')}" ${f?.source === 'bank' ? 'disabled' : ''}></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Дата</span><input type="date" name="date" required value="${esc(f?.date || today())}" ${f?.source === 'bank' ? 'disabled' : ''}></label>
        <label class="field"><span>Способ</span>
          <select name="method">${FIN_METHODS.map((x) => `<option value="${x.id}" ${(f?.method || 'account') === x.id ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span>Направление</span>
          <select name="unit">${units.map((u) => `<option value="${u}" ${(f?.unit || (S.unit !== 'all' ? S.unit : units[0])) === u ? 'selected' : ''}>${UNITS[u].name}</option>`).join('')}</select>
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
        ${!isNew && f?.source !== 'bank' ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
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

  $('#view').innerHTML = `
    <div class="cards-row">
      <div class="card stat"><div class="label">Выплачено за месяц</div><div class="value green">${money(paidMonth)}</div></div>
      <div class="card stat"><div class="label">Выплачено всего</div><div class="value">${money(paidTotal)}</div></div>
      <div class="card stat"><div class="label">Жду возврата</div><div class="value ${pendingSum ? 'red' : ''}">${money(pendingSum)}</div></div>
    </div>
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
    </div>
    <div class="section-title">Выплаты мне</div>
    <div class="list">
      ${paid.length ? paid.map((f) => `
        <div class="row-card" style="cursor:default">
          <div class="grow col"><div class="title">${esc(f.category || 'Выплата')}</div><div class="sub">${fmtDate(f.date)}${f.comment ? ' · ' + esc(f.comment) : ''}</div></div>
          ${f._cash ? '<span class="badge">💵 наличными</span>' : ''}
          <div class="amount green">+${money(f.amount)}</div>
        </div>`).join('') : `<div class="card empty"><div class="big">💰</div>Выплат пока не было</div>`}
    </div>`;

  $('#add-expense').addEventListener('click', () => openStaffExpenseForm());
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
      if (isNew) await doCreate('staffExpenses', { title: item.title, amount: item.amount, date: item.date, receiptId }, 'Трата отправлена — админу пришло уведомление');
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
            <div class="sub">${e.role === 'admin' ? 'администратор' : 'сотрудник'} · ${e.unit === 'all' ? 'все направления' : esc(UNITS[e.unit]?.name || '')}${e.active === false ? ' · отключён' : ''}</div>
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
            <option value="padel" ${emp?.unit === 'padel' ? 'selected' : ''}>Падел</option>
            <option value="dev" ${emp?.unit === 'dev' ? 'selected' : ''}>Разработка</option>
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

// ---------- Настройки ----------
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
    ${isAdmin() ? `
    <div class="card" style="margin-bottom:12px">
      <div class="section-title" style="margin-top:0">🗄️ Общая база (Google Таблицы)</div>
      <p class="small muted">${backend ? 'База подключена.' : 'База не подключена — работаем в демо-режиме. Инструкция в файле SETUP.md в репозитории.'}</p>
      <label class="field"><span>Ссылка на базу (из Google-скрипта, SETUP.md шаг 2)</span><input type="url" id="backend-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(backend)}"></label>
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
  $('#view').querySelectorAll('[data-nav2]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.nav2; }));
  $('#notif-on')?.addEventListener('click', () => Notification.requestPermission().then(() => render()));
  $('#backend-save')?.addEventListener('click', () => {
    const v = $('#backend-url').value.trim();
    if (v) localStorage.setItem('monetki_backend', v); else localStorage.removeItem('monetki_backend');
    location.reload();
  });
  $('#backup-download')?.addEventListener('click', async () => {
    toast('Собираю копию…');
    const res = await S.store.bootstrap(S.token);
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16181d' : '#faf8f5');
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
