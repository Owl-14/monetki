import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('app.js остаётся единственным entrypoint и подключает механические модули', async () => {
  const [html, app] = await Promise.all([read('../index.html'), read('../js/app.js')]);

  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.match(app, /from '\.\/ui\.js'/);
  assert.match(app, /from '\.\/app-state\.js'/);
  assert.match(app, /async function init\(\)/);
  assert.match(app, /init\(\);\s*$/);
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

test('PWA v20 кэширует entrypoint и оба новых модуля', async () => {
  const sw = await read('../sw.js');

  assert.match(sw, /const CACHE = 'monetki-v20'/);
  for (const path of ['./js/app.js', './js/app-state.js', './js/store.js', './js/ui.js']) {
    assert.match(sw, new RegExp(`['"]${path.replaceAll('.', '\\.')}['"]`));
  }
});

test('текущий релиз получает patch-версию config', async () => {
  assert.match(await read('../config.js'), /version:\s*"0\.4\.3"/);
});
