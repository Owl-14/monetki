import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('app.js остаётся единственным entrypoint и подключает механические модули', async () => {
  const [html, app] = await Promise.all([read('../index.html'), read('../js/app.js')]);

  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.match(app, /from '\.\/ui\.js'/);
  assert.match(app, /from '\.\/app-state\.js'/);
  assert.match(app, /from '\.\/app-shell\.js'/);
  assert.match(app, /async function init\(\)/);
  assert.match(app, /init\(\);\s*$/);
});

test('редизайн сохраняет все рабочие маршруты и их представления', async () => {
  const app = await read('../js/app.js');
  const routesStart = app.indexOf('const routes =');
  const routesEnd = app.indexOf('function currentRoute()', routesStart);
  const viewsStart = app.indexOf('const views =');
  const viewsEnd = app.indexOf('(views[route]', viewsStart);
  const routeBlock = app.slice(routesStart, routesEnd);
  const viewBlock = app.slice(viewsStart, viewsEnd);

  assert.ok(routesStart >= 0 && routesEnd > routesStart);
  assert.ok(viewsStart >= 0 && viewsEnd > viewsStart);

  for (const route of ['dashboard', 'tasks', 'clients', 'venues', 'players', 'finance', 'money', 'team', 'settings', 'login']) {
    assert.match(routeBlock, new RegExp(`['"]${route}['"]`));
  }
  for (const view of ['viewDashboard', 'viewTasks', 'viewClients', 'viewVenues', 'viewPlayers', 'viewFinance', 'viewMoney', 'viewTeam', 'viewSettings']) {
    assert.match(viewBlock, new RegExp(`${view}`));
  }
});

test('nav строится по модулям без ограничений только на padel/dev', async () => {
  const app = await read('../js/app.js');
  const navStart = app.indexOf('function navItems()');
  const navEnd = app.indexOf('function unreadCount()', navStart);
  const nav = app.slice(navStart, navEnd);

  assert.ok(navStart >= 0 && navEnd > navStart);

  for (const moduleId of ['dashboard', 'tasks', 'money', 'clients', 'venues', 'players', 'finance', 'team']) {
    assert.match(nav, new RegExp(`hasModule\\('${moduleId}'\\)`));
  }
  assert.doesNotMatch(nav, /units\.includes\('(?:dev|padel)'\)/);
  assert.match(nav, /if \(hasModule\('clients'\)\)/);
  assert.match(nav, /if \(hasModule\('venues'\) \|\| hasModule\('players'\)\)/);
  assert.match(nav, /if \(isAdmin\(\)\).*hasModule\('finance'\).*hasModule\('team'\)/s);
});

test('business admin остаётся в app.js и привязан к настройкам', async () => {
  const app = await read('../js/app.js');

  assert.match(app, /function businessAdminHtml\(\)/);
  assert.match(app, /function bindBusinessAdmin\(\)/);
  assert.match(app, /\$\{isAdmin\(\) \? businessAdminHtml\(\) : ''\}/);
  assert.match(app, /if \(isAdmin\(\)\) bindBusinessAdmin\(\);/);
  assert.match(app, /option value="manager"[^>]*membership\?\.role === 'manager'/);
  assert.match(app, /id="create-business">\+ Создать бизнес/);
  assert.match(app, /function openBusinessCreateForm\(\)/);
  assert.match(app, /data-business-active="\$\{archived \? 'true' : 'false'\}"/);
  assert.match(app, /Восстановить/);
  assert.doesNotMatch(app, /карточки двух текущих бизнесов|ID <b>padel<\/b> и <b>dev<\/b> не меняются/);
});

test('оболочка содержит desktop/mobile навигацию и заметный контекст бизнеса', async () => {
  const [app, css] = await Promise.all([read('../js/app.js'), read('../css/style.css')]);

  for (const marker of ['sidebar', 'bottomnav', 'business-context', 'mobile-business', 'page-header', 'page-title', 'page-eyebrow', 'page-subtitle']) {
    assert.match(app, new RegExp(marker));
  }
  assert.match(app, /aria-label="Выбор бизнеса"/);
  assert.match(app, /role="group" aria-label="Выбор бизнеса"/);
  assert.match(app, /aria-pressed=/);
  assert.match(app, /aria-current="page"/);
  assert.match(app, /id="bell"/);
  assert.match(app, /id="bell-mobile"/);
  assert.match(app, /S\.route = route/);
  assert.match(app, /pageMeta\(S\.route \|\| currentRoute\(\)\)/);

  assert.match(css, /\.sidebar\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.bottomnav\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media \(max-width: 840px\)[\s\S]*?\.sidebar\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.bottomnav\s*\{\s*display:\s*flex;/);
  for (const component of ['page-header', 'business-switch', 'card', 'row-card', 'empty', 'table-wrap']) {
    assert.match(css, new RegExp(`\\.${component}`));
  }
});

test('финансы явно показывают бизнес и период с быстрым переходом к общей сводке', async () => {
  const app = await read('../js/app.js');
  const start = app.indexOf('function renderFinOps(');
  const end = app.indexOf('const EX_STATUS', start);
  const finance = app.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(finance, /class="finance-context"/);
  assert.match(finance, /Сейчас показано/);
  assert.match(finance, /financeBusinessName/);
  assert.match(finance, /periodName/);
  assert.match(finance, /id="finance-show-all"/);
  assert.match(finance, /S\.unit = 'all'/);
  assert.doesNotMatch(finance, /55 операций|21\.07|04\.08/);
});

test('PWA v22 кэширует entrypoint и модули оболочки', async () => {
  const sw = await read('../sw.js');

  assert.match(sw, /const CACHE = 'monetki-v23'/);
  for (const path of ['./js/app.js', './js/app-shell.js', './js/app-state.js', './js/store.js', './js/ui.js']) {
    assert.match(sw, new RegExp(`['"]${path.replaceAll('.', '\\.')}['"]`));
  }
});

test('текущий релиз получает patch-версию config', async () => {
  assert.match(await read('../config.js'), /version:\s*"0\.4\.6"/);
});

test('PWA manifest использует палитру новой оболочки и сохраняет установку приложения', async () => {
  const manifest = JSON.parse(await read('../manifest.webmanifest'));

  assert.equal(manifest.background_color, '#f4f6fa');
  assert.equal(manifest.theme_color, '#3157d5');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});
