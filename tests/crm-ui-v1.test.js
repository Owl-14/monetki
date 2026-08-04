import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CRM_TABS, crmTabFromHash } from '../js/app-shell.js';
import { normalizeItemScope } from '../js/app-state.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('CRM остаётся на маршруте clients и имеет четыре вложенных раздела', async () => {
  const app = await read('../js/app.js');

  assert.deepEqual(CRM_TABS.map((tab) => tab.id), ['deals', 'companies', 'contacts', 'leads']);
  assert.equal(crmTabFromHash('#/clients?tab=contacts'), 'contacts');
  assert.equal(crmTabFromHash('#/clients?tab=unknown'), 'deals');
  assert.match(app, /location\.hash = `#\/clients\?tab=\$\{button\.dataset\.crmTab\}`/);
  assert.match(app, /aria-label="Разделы CRM"/);
});

test('экран работает с реальными CRM-сущностями и не подставляет демонстрационные записи', async () => {
  const app = await read('../js/app.js');

  for (const entity of ['companies', 'contacts', 'leads', 'deals', 'pipelines', 'stages', 'dealItems']) {
    assert.match(app, new RegExp(`['"]${entity}['"]`));
    assert.deepEqual(
      normalizeItemScope(entity, { id: entity, unit: 'dev' }),
      { id: entity, businessId: 'dev', unit: 'dev' },
    );
  }
  assert.match(app, /Воронок пока нет/);
  assert.match(app, /Компаний пока нет/);
  assert.match(app, /Контактов пока нет/);
  assert.match(app, /Лидов пока нет/);
  assert.doesNotMatch(app, /ООО «Ромашка»|Иван Иванов|Тестовая сделка/);
});

test('legacy clients показаны только для чтения и не отправляются в новые CRM-формы', async () => {
  const app = await read('../js/app.js');
  const start = app.indexOf('function openLegacyClient');
  const end = app.indexOf('function openPipelineManager', start);
  const legacy = app.slice(start, end);

  assert.match(app, /legacyClientId/);
  assert.match(app, /Старая карточка/);
  assert.match(legacy, /только чтение/);
  assert.doesNotMatch(legacy, /doCreate|doUpdate|doDelete|bindEntityForm/);
});

test('воронка поддерживает drag, доступную смену стадии и обязательную причину отказа', async () => {
  const app = await read('../js/app.js');

  assert.match(app, /draggable="true"/);
  assert.match(app, /data-deal-stage=/);
  assert.match(app, /addEventListener\('drop'/);
  assert.match(app, /function openLostReasonForm/);
  assert.match(app, /Почему сделка не состоялась/);
  assert.match(app, /stage\.type === 'won' \|\| stage\.type === 'lost'/);
});

test('формы покрывают настройку воронок, стадий и позиции сделки', async () => {
  const app = await read('../js/app.js');

  for (const fn of ['openCompanyForm', 'openContactForm', 'openLeadForm', 'openDealForm', 'openPipelineForm', 'openStageForm']) {
    assert.match(app, new RegExp(`function ${fn}\\(`));
  }
  assert.match(app, /name="responsibleIds"/);
  assert.match(app, /name="responsibleId"/);
  assert.match(app, /name="itemRecurring"/);
  assert.match(app, /name="itemPeriod"/);
  assert.match(app, /doCreate\('dealItems'/);
  assert.match(app, /doUpdate\('dealItems'/);
});

test('CRM адаптирована под телефон и канбан прокручивается по горизонтали', async () => {
  const css = await read('../css/style.css');

  assert.match(css, /\.crm-kanban\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.crm-deal-card/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.crm-kanban\s*\{[^}]*grid-auto-columns:/);
  assert.match(css, /\.crm-tabs\s*\{[^}]*overflow-x:\s*auto/s);
});
