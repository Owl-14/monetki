import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLocal,
  createAppState,
  createCrudHelpers,
  normalizeItemScope,
} from '../js/app-state.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
}

test('createAppState восстанавливает только пользовательскую сессию и фильтры по умолчанию', () => {
  const store = {};
  const state = createAppState(store, new MemoryStorage({ monetki_token: 'token', monetki_unit: 'dev' }));

  assert.equal(state.store, store);
  assert.equal(state.token, 'token');
  assert.equal(state.unit, 'dev');
  assert.deepEqual(state.taskFilter, { who: 'mine', status: 'active' });
  assert.match(state.finMonth, /^\d{4}-\d{2}$/);
});

test('normalizeItemScope синхронизирует businessId и unit только у бизнес-сущностей', () => {
  const task = { id: 'task', businessId: 'dev', unit: 'padel' };
  assert.deepEqual(normalizeItemScope('tasks', task), { id: 'task', businessId: 'dev', unit: 'dev' });
  assert.deepEqual(normalizeItemScope('clients', { unit: 'dev' }), { businessId: 'dev', unit: 'dev' });

  const employee = { id: 'employee', unit: 'dev' };
  assert.equal(normalizeItemScope('employees', employee), employee);
});

test('applyLocal механически применяет create, update и delete', () => {
  const state = { data: { tasks: [{ id: 'a', title: 'Старая' }] } };

  applyLocal(state, 'tasks', 'create', { id: 'b', title: 'Новая' });
  applyLocal(state, 'tasks', 'update', { id: 'a', title: 'Обновлённая' });
  applyLocal(state, 'tasks', 'delete', 'b');

  assert.deepEqual(state.data.tasks, [{ id: 'a', title: 'Обновлённая' }]);
});

test('doCreate отправляет нормализованный scope и кладёт серверный ответ в локальное состояние', async () => {
  const calls = [];
  const state = {
    token: 'token',
    data: { tasks: [] },
    store: {
      async create(...args) {
        calls.push(args);
        return { ok: true, item: { ...args[2], id: 'server-id' } };
      },
    },
  };
  const notices = [];
  let renders = 0;
  const { doCreate } = createCrudHelpers(state, {
    toast: (...args) => notices.push(args),
    render: () => { renders += 1; },
    refresh: () => {},
  });

  const result = await doCreate('tasks', { unit: 'dev', title: 'Задача' }, 'Добавлено');

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['token', 'tasks', { businessId: 'dev', unit: 'dev', title: 'Задача' }]]);
  assert.deepEqual(state.data.tasks, [{ id: 'server-id', businessId: 'dev', unit: 'dev', title: 'Задача' }]);
  assert.deepEqual(notices, [['Добавлено']]);
  assert.equal(renders, 1);
});

test('ошибка оптимистичного update запускает тихую сверку с сервером', async () => {
  const events = [];
  const state = {
    token: 'token',
    data: { tasks: [{ id: 'task', status: 'new' }] },
    store: {
      async update() {
        events.push('store');
        return { ok: false, error: 'Отказ' };
      },
    },
  };
  const { doUpdate } = createCrudHelpers(state, {
    toast: (...args) => events.push(['toast', ...args]),
    render: () => events.push('render'),
    refresh: (silent) => events.push(['refresh', silent]),
  });

  const result = await doUpdate('tasks', { id: 'task', unit: 'padel', status: 'done' }, 'Сохранено');

  assert.equal(result, null);
  assert.deepEqual(state.data.tasks, [{ id: 'task', businessId: 'padel', unit: 'padel', status: 'done' }]);
  assert.deepEqual(events, ['render', ['toast', 'Сохранено'], 'store', ['toast', 'Отказ', true], ['refresh', true]]);
});

test('doDelete сразу удаляет запись и передаёт id в store', async () => {
  const calls = [];
  const state = {
    token: 'token',
    data: { clients: [{ id: 'client' }] },
    store: {
      async remove(...args) {
        calls.push(args);
        return { ok: true };
      },
    },
  };
  let renders = 0;
  const { doDelete } = createCrudHelpers(state, {
    toast: () => {},
    render: () => { renders += 1; },
    refresh: () => {},
  });

  const result = await doDelete('clients', 'client');

  assert.equal(result.ok, true);
  assert.deepEqual(state.data.clients, []);
  assert.deepEqual(calls, [['token', 'clients', 'client']]);
  assert.equal(renders, 1);
});
