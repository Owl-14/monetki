// ============ Монетки: приложение ============
import { makeStore, UNITS, CLIENT_STATUSES, TASK_STATUSES, FIN_METHODS, FIN_CATEGORIES } from './store.js';

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

async function mutate(fn, okText) {
  const res = await fn();
  if (!res.ok) { toast(res.error || 'Ошибка', true); return null; }
  if (okText) toast(okText);
  await refresh(true);
  return res;
}

function logout() {
  S.token = ''; S.profile = null; S.data = null;
  localStorage.removeItem('monetki_token');
  location.hash = '#/login';
  render();
}

// ---------- Роутер ----------
const routes = ['dashboard', 'tasks', 'clients', 'venues', 'players', 'finance', 'team', 'settings', 'login'];
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
  // Внизу максимум 5 кнопок: первые разделы + всегда «Ещё» (через него доступно остальное)
  const bottomItems = items.filter((i) => i.r !== 'team' && i.r !== 'settings').slice(0, 4);
  bottomItems.push(items.find((i) => i.r === 'settings'));
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

  const views = { dashboard: viewDashboard, tasks: viewTasks, clients: viewClients, venues: viewVenues, players: viewPlayers, finance: viewFinance, team: viewTeam, settings: viewSettings };
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

  const finCards = isAdmin() ? `
    <div class="card stat"><div class="label">Доход за месяц</div><div class="value green">${money(income)}</div></div>
    <div class="card stat"><div class="label">Расход за месяц</div><div class="value red">${money(expense)}</div></div>
    <div class="card stat"><div class="label">Итог</div><div class="value ${income - expense >= 0 ? 'green' : 'red'}">${money(income - expense)}</div></div>` : '';

  const upcoming = mine.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 6);
  const lastOps = isAdmin() ? (S.data.finance || []).filter((f) => units.includes(f.unit)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5) : [];

  $('#view').innerHTML = `
    <div class="cards-row">
      <div class="card stat"><div class="label">Мои задачи</div><div class="value">${mine.length}</div>${overdue.length ? `<div class="hint" style="color:var(--red)">${overdue.length} просрочено</div>` : '<div class="hint">активных</div>'}</div>
      ${clientsStat}${padelStat}${finCards}
    </div>
    <div class="section-title">Мои ближайшие задачи</div>
    <div class="list">
      ${upcoming.length ? upcoming.map(taskRow).join('') : `<div class="card empty"><div class="big">🎉</div>Активных задач нет</div>`}
    </div>
    ${lastOps.length ? `<div class="section-title">Последние операции</div><div class="list">${lastOps.map(finRow).join('')}</div>` : ''}
  `;
  bindTaskRows();
  $('#view').querySelectorAll('[data-fin]').forEach((el) => el.addEventListener('click', () => openFinForm((S.data.finance || []).find((f) => f.id === el.dataset.fin))));
}

// ---------- Задачи ----------
function taskRow(t) {
  const st = TASK_STATUSES.find((s) => s.id === t.status) || TASK_STATUSES[0];
  const over = t.due && t.due < today() && t.status !== 'done';
  const unitTag = activeUnits().length > 1 ? `<span class="badge">${UNITS[t.unit]?.emoji || ''}</span>` : '';
  return `
    <div class="row-card ${t.status === 'done' ? 'done' : ''} ${over ? 'overdue' : ''}" data-task="${t.id}">
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
    <div class="chip-row">
      ${[['mine', 'Мои'], ['from-me', 'От меня'], ['all', 'Все']].map(([k, l]) => `<button class="chip ${f.who === k ? 'active' : ''}" data-who="${k}">${l}</button>`).join('')}
      <span style="width:10px"></span>
      ${[['active', 'Активные'], ['done', 'Готово'], ['any', 'Любые']].map(([k, l]) => `<button class="chip ${f.status === k ? 'active' : ''}" data-status="${k}">${l}</button>`).join('')}
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
  const canEdit = isNew || isAdmin() || task.authorId === S.profile.id || task.assigneeId === S.profile.id;

  openModal(`
    <h2>${isNew ? 'Новая задача' : 'Задача'}</h2>
    <form id="task-form">
      <label class="field"><span>Название</span><input type="text" name="title" required value="${esc(task?.title || '')}" ${canEdit ? '' : 'disabled'}></label>
      <label class="field"><span>Описание</span><textarea name="desc" ${canEdit ? '' : 'disabled'}>${esc(task?.desc || '')}</textarea></label>
      <div class="form-row">
        <label class="field"><span>Исполнитель</span>
          <select name="assigneeId">${people.map((p) => `<option value="${p.id}" ${(task?.assigneeId || S.profile.id) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Срок</span><input type="date" name="due" value="${esc(task?.due || '')}"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>Статус</span>
          <select name="status">${TASK_STATUSES.map((s) => `<option value="${s.id}" ${(task?.status || 'new') === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Приоритет</span>
          <select name="priority">${[['low', 'Низкий'], ['normal', 'Обычный'], ['high', '🔥 Высокий']].map(([k, l]) => `<option value="${k}" ${(task?.priority || 'normal') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
      </div>
      ${units.length > 1 ? `<label class="field"><span>Направление</span>
        <select name="unit">${units.map((u) => `<option value="${u}" ${unit === u ? 'selected' : ''}>${UNITS[u].name}</option>`).join('')}</select></label>` : `<input type="hidden" name="unit" value="${unit}">`}
      ${!isNew ? `
        <div class="section-title" style="margin-top:8px">Обсуждение</div>
        <div class="chat">${(task.comments || []).map((c) => `<div class="msg ${c.authorId === S.profile.id ? 'mine' : ''}"><span class="who">${esc(empName(c.authorId))}</span><span class="when">${fmtDT(c.ts)}</span><div>${esc(c.text)}</div></div>`).join('') || '<div class="muted small">Пока пусто — напишите первым.</div>'}</div>
        <div class="chat-input"><input type="text" id="chat-text" placeholder="Написать сообщение…"><button type="button" class="btn" id="chat-send">➤</button></div>` : ''}
      <div class="actions">
        ${!isNew && canEdit ? `<button type="button" class="btn danger ghost left" id="task-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        ${canEdit ? `<button type="submit" class="btn primary">${isNew ? 'Создать' : 'Сохранить'}</button>` : ''}
        ${!isNew && task.status !== 'done' && task.assigneeId === S.profile.id ? `<button type="button" class="btn primary" id="task-done">✓ Выполнено</button>` : ''}
      </div>
    </form>
  `, (root) => {
    $('#modal-cancel', root).addEventListener('click', closeModal);
    $('#task-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const item = Object.fromEntries(fd.entries());
      if (isNew) {
        await mutate(() => S.store.create(S.token, 'tasks', { ...item, authorId: S.profile.id, comments: [] }), 'Задача создана');
      } else {
        await mutate(() => S.store.update(S.token, 'tasks', { ...task, ...item }), 'Сохранено');
      }
      closeModal();
    });
    $('#task-del', root)?.addEventListener('click', async () => {
      if (!confirm('Удалить задачу?')) return;
      await mutate(() => S.store.remove(S.token, 'tasks', task.id), 'Удалено');
      closeModal();
    });
    $('#task-done', root)?.addEventListener('click', async () => {
      await mutate(() => S.store.update(S.token, 'tasks', { ...task, status: 'done' }), 'Отличная работа! ✓');
      closeModal();
    });
    $('#chat-send', root)?.addEventListener('click', async () => {
      const text = $('#chat-text', root).value.trim();
      if (!text) return;
      const res = await mutate(() => S.store.addComment(S.token, task.id, text));
      if (res) { closeModal(); openTaskForm((S.data.tasks || []).find((t) => t.id === task.id)); }
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
        ${v?.phone ? `<a class="btn" href="${telHref(v.phone)}">📞 Позвонить</a>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => bindEntityForm(root, 'venues', v, { unit: 'padel' }));
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
      const res = await mutate(() => S.store.importPlayers(S.token, rows));
      if (res) { toast(`Добавлено: ${res.added}`); closeModal(); }
    });
  });
}

// ---------- Финансы ----------
function finRow(f) {
  const m = FIN_METHODS.find((x) => x.id === f.method);
  const unitTag = activeUnits().length > 1 ? `${UNITS[f.unit]?.emoji || ''} ` : '';
  return `
    <div class="row-card" data-fin="${f.id}">
      <div class="grow col">
        <div class="title">${unitTag}${esc(f.counterparty || f.category || 'Операция')}</div>
        <div class="sub">${fmtDate(f.date)} · ${esc(f.category || '')}${f.comment ? ' · ' + esc(f.comment) : ''}</div>
      </div>
      <span class="badge ${f.source === 'bank' ? 'blue' : ''}">${f.source === 'bank' ? '🏦 банк' : '✍️ вручную'}${m ? ' · ' + m.name : ''}</span>
      <div class="amount ${f.type === 'income' ? 'green' : 'red'}">${f.type === 'income' ? '+' : '−'}${money(f.amount)}</div>
    </div>`;
}

function viewFinance() {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  setTitle('Финансы');
  const units = activeUnits();
  const m = S.finMonth;
  const list = (S.data.finance || []).filter((f) => units.includes(f.unit) && (f.date || '').startsWith(m)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const income = list.filter((f) => f.type === 'income').reduce((s, f) => s + Number(f.amount || 0), 0);
  const expense = list.filter((f) => f.type === 'expense').reduce((s, f) => s + Number(f.amount || 0), 0);
  const monthName = new Date(m + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  $('#view').innerHTML = `
    <div class="searchbar">
      <button class="btn small" id="m-prev">←</button>
      <span class="btn small ghost nowrap" style="cursor:default">${monthName}</span>
      <button class="btn small" id="m-next">→</button>
      <div class="grow"></div>
      <button class="btn primary" id="add-fin">+ Операция</button>
    </div>
    <div class="cards-row">
      <div class="card stat"><div class="label">Доход</div><div class="value green">${money(income)}</div></div>
      <div class="card stat"><div class="label">Расход</div><div class="value red">${money(expense)}</div></div>
      <div class="card stat"><div class="label">Итог</div><div class="value ${income - expense >= 0 ? 'green' : 'red'}">${money(income - expense)}</div></div>
    </div>
    ${S.store.demo ? '' : `<div class="banner">🏦 Выписка из Точки подтягивается автоматически, если настроена синхронизация (SETUP.md, шаг 4).</div>`}
    <div class="list">${list.length ? list.map(finRow).join('') : `<div class="card empty"><div class="big">💸</div>Операций за ${monthName} нет</div>`}</div>`;

  const shift = (dir) => {
    const d = new Date(S.finMonth + '-01'); d.setMonth(d.getMonth() + dir);
    S.finMonth = d.toISOString().slice(0, 7); render();
  };
  $('#m-prev').addEventListener('click', () => shift(-1));
  $('#m-next').addEventListener('click', () => shift(1));
  $('#add-fin').addEventListener('click', () => openFinForm());
  $('#view').querySelectorAll('[data-fin]').forEach((el) => el.addEventListener('click', () => openFinForm((S.data.finance || []).find((f) => f.id === el.dataset.fin))));
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
      <label class="field"><span>Комментарий</span><input type="text" name="comment" value="${esc(f?.comment || '')}"></label>
      <div class="actions">
        ${!isNew && f?.source !== 'bank' ? `<button type="button" class="btn danger ghost left" id="ent-del">Удалить</button>` : ''}
        <button type="button" class="btn" id="modal-cancel">Отмена</button>
        <button type="submit" class="btn primary">${isNew ? 'Добавить' : 'Сохранить'}</button>
      </div>
    </form>
  `, (root) => bindEntityForm(root, 'finance', f, { source: f?.source || 'manual' }));
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
      if (isNew) await mutate(() => S.store.create(S.token, 'employees', item), 'Сотрудник добавлен');
      else await mutate(() => S.store.update(S.token, 'employees', { ...emp, ...item }), 'Сохранено');
      closeModal();
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
      <label class="field"><span>Адрес веб-приложения Apps Script</span><input type="url" id="backend-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(backend)}"></label>
      <button class="btn primary" id="backend-save">Сохранить и перезагрузить</button>
    </div>` : ''}
    <div class="card">
      <div class="section-title" style="margin-top:0">👤 ${esc(S.profile.name)}</div>
      <p class="small muted">${isAdmin() ? 'Администратор' : 'Сотрудник'} · Монетки v${window.MONETKI_CONFIG?.version || ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="do-refresh">🔄 Обновить данные</button>
        <button class="btn danger" id="do-logout">Выйти</button>
      </div>
    </div>`;
  $('#view').querySelectorAll('[data-nav2]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.nav2; }));
  $('#notif-on')?.addEventListener('click', () => Notification.requestPermission().then(() => render()));
  $('#backend-save')?.addEventListener('click', () => {
    const v = $('#backend-url').value.trim();
    if (v) localStorage.setItem('monetki_backend', v); else localStorage.removeItem('monetki_backend');
    location.reload();
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
    $('#read-all', root)?.addEventListener('click', async () => {
      const ids = list.filter((n) => !n.read).map((n) => n.id);
      await mutate(() => S.store.markRead(S.token, ids));
      closeModal();
    });
    root.querySelectorAll('[data-notif]').forEach((el) => el.addEventListener('click', async () => {
      await S.store.markRead(S.token, [el.dataset.notif]);
      closeModal();
      if (el.dataset.link) location.hash = el.dataset.link;
      refresh(true);
    }));
  });
}

// ---------- Общий обработчик форм сущностей ----------
function bindEntityForm(root, entity, existing, extra = {}) {
  $('#modal-cancel', root).addEventListener('click', closeModal);
  $('#ent-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = Object.fromEntries(new FormData(e.target).entries());
    if (existing) await mutate(() => S.store.update(S.token, entity, { ...existing, ...item }), 'Сохранено');
    else await mutate(() => S.store.create(S.token, entity, { ...item, ...extra }), 'Добавлено');
    closeModal();
  });
  $('#ent-del', root)?.addEventListener('click', async () => {
    if (!confirm('Удалить запись?')) return;
    await mutate(() => S.store.remove(S.token, entity, existing.id), 'Удалено');
    closeModal();
  });
}

// ---------- Старт ----------
async function init() {
  if (S.token) {
    await refresh();
    if (!S.profile) return; // refresh сделал logout
  } else {
    render();
  }
  // Периодическое обновление: раз в 3 минуты + при возврате на вкладку
  setInterval(() => { if (S.token && document.visibilityState === 'visible') refresh(true); }, 180000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token) refresh(true); });
}
init();
