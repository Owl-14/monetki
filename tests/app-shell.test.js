import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupNavItems,
  NAV_GROUPS,
  NAV_ICONS,
  pageMeta,
  pickBottomNavItems,
} from '../js/app-shell.js';

const item = (r, group) => ({ r, group, label: r });

test('меню собирается в подготовленные группы и сохраняет порядок пунктов', () => {
  const groups = groupNavItems([
    item('dashboard', 'overview'),
    item('tasks', 'work'),
    item('clients', 'work'),
    item('finance', 'management'),
  ]);

  assert.deepEqual(groups.map((group) => group.id), ['overview', 'work', 'management']);
  assert.deepEqual(groups.find((group) => group.id === 'work').items.map((entry) => entry.r), ['tasks', 'clients']);
  assert.ok(groups.every((group) => group.items.length > 0));
  assert.deepEqual(NAV_GROUPS.map((group) => group.id), ['overview', 'work', 'operations', 'management']);
});

test('нижнее меню выбирает пять приоритетных разделов для администратора', () => {
  const items = [
    item('dashboard'), item('tasks'), item('clients'), item('venues'),
    item('finance'), item('team'), item('settings'),
  ];

  assert.deepEqual(
    pickBottomNavItems(items, true).map((entry) => entry.r),
    ['dashboard', 'tasks', 'finance', 'clients', 'settings'],
  );
});

test('нижнее меню сотрудника использует личные деньги и пропускает недоступные разделы', () => {
  const items = [item('dashboard'), item('tasks'), item('money'), item('players'), item('settings')];
  const routes = pickBottomNavItems(items, false).map((entry) => entry.r);

  assert.deepEqual(routes, ['dashboard', 'tasks', 'money', 'players', 'settings']);
  assert.equal(new Set(routes).size, routes.length);
  assert.ok(routes.length <= 5);
});

test('каждый сохранённый маршрут получает понятный контекст заголовка', () => {
  for (const route of ['dashboard', 'tasks', 'clients', 'venues', 'players', 'finance', 'money', 'team', 'settings']) {
    assert.ok(pageMeta(route).group);
    assert.ok(pageMeta(route).subtitle);
  }
  assert.deepEqual(pageMeta('unknown'), { group: 'Монетки', subtitle: 'Рабочее пространство бизнеса' });
});

test('все пункты оболочки имеют скрытые от скринридера SVG-иконки', () => {
  for (const route of ['dashboard', 'tasks', 'clients', 'venues', 'players', 'finance', 'money', 'team', 'settings']) {
    assert.match(NAV_ICONS[route], /^<svg /);
    assert.match(NAV_ICONS[route], /aria-hidden="true"/);
  }
});
