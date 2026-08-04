import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BUSINESS_SCOPED_ENTITIES,
  CRM_ENTITIES,
  ENTITIES,
  crmDeleteError,
  defaultCrmPipeline,
  defaultCrmStages,
  missingCrmDefaults,
  normalizeCrmRecord,
  validateCrmEntity,
  visibleBootstrapData,
} from "../supabase/functions/api/rules.js";

const business = (id, active = true, modules = ["clients"]) => ({ id, name: id, active, modules });
const scoped = (id, businessId, extra = {}) => ({ id, businessId, unit: businessId, ...extra });

function bootstrapFixture() {
  return {
    businesses: [business("dev"), business("padel"), business("archive", false)],
    memberships: [scoped("m-dev", "dev", { employeeId: "staff", active: true, role: "staff" })],
    businessOwners: [],
    employees: [{ id: "staff", name: "Сотрудник", role: "staff", active: true }],
    clients: [
      scoped("old-dev", "dev", { name: "Старый клиент", status: "talks", notes: "Сохранить" }),
      scoped("old-padel", "padel", { name: "Чужой клиент" }),
    ],
    companies: [scoped("company-dev", "dev", { name: "Новая компания" })],
    contacts: [scoped("contact-dev", "dev", { name: "Анна", companyId: "company-dev" })],
    leads: [scoped("lead-dev", "dev", { name: "Заявка", status: "new" })],
    deals: [scoped("deal-dev", "dev", { name: "Разработка" })],
    pipelines: [scoped("pipeline-dev", "dev", { name: "Продажи" })],
    stages: [scoped("stage-dev", "dev", { name: "Переговоры" })],
    dealItems: [scoped("item-dev", "dev", { name: "Работа", dealId: "deal-dev" })],
    venues: [], players: [], tasks: [], finance: [], staffExpenses: [], cash: [], notifications: [],
  };
}

test("CRM-сущности входят в серверный протокол и бизнес-изоляцию", () => {
  assert.deepEqual(CRM_ENTITIES, ["companies", "contacts", "leads", "deals", "pipelines", "stages", "dealItems"]);
  for (const entity of CRM_ENTITIES) {
    assert.ok(ENTITIES.includes(entity));
    assert.ok(BUSINESS_SCOPED_ENTITIES.includes(entity));
  }
  assert.ok(ENTITIES.includes("clients"));
});

test("стандартная воронка создаётся детерминированно только для активного CRM-бизнеса", () => {
  const businesses = [business("dev"), business("padel", true, ["tasks"]), business("archive", false)];
  const first = missingCrmDefaults(businesses, [], []);

  assert.deepEqual(first.pipelines, [defaultCrmPipeline("dev")]);
  assert.deepEqual(first.stages, defaultCrmStages("dev"));
  assert.deepEqual(first.stages.map((stage) => stage.id), [
    "stage-dev-contact", "stage-dev-talks", "stage-dev-prepayment",
    "stage-dev-work", "stage-dev-won", "stage-dev-lost",
  ]);
  assert.deepEqual(first.stages.map((stage) => stage.order), [10, 20, 30, 40, 50, 60]);
  assert.deepEqual(first.stages.map((stage) => stage.type), ["open", "open", "open", "open", "won", "lost"]);

  const second = missingCrmDefaults(businesses, first.pipelines, first.stages);
  assert.deepEqual(second, { pipelines: [], stages: [] });
});

test("bootstrap фильтрует CRM по доступу и показывает legacy clients без записи в companies", () => {
  const data = bootstrapFixture();
  const result = visibleBootstrapData(data.employees[0], data);

  assert.deepEqual(result.clients.map((item) => item.id), ["old-dev"]);
  assert.deepEqual(result.companies.map((item) => item.id), ["company-dev", "legacy-client:old-dev"]);
  assert.deepEqual(result.companies[1], {
    id: "legacy-client:old-dev",
    businessId: "dev",
    unit: "dev",
    name: "Старый клиент",
    legalName: "",
    inn: "",
    address: "",
    responsibleIds: [],
    status: "talks",
    notes: "Сохранить",
    legacyPhone: "",
    legacyMessenger: "",
    legacyAmount: 0,
    legacyClientId: "old-dev",
    legacy: true,
    readOnly: true,
    created: undefined,
    updated: undefined,
  });
  for (const entity of ["contacts", "leads", "deals", "pipelines", "stages", "dealItems"]) {
    assert.equal(result[entity].length, 1);
    assert.equal(result[entity][0].businessId, "dev");
  }

  const migratedData = bootstrapFixture();
  migratedData.companies.push(scoped("company-migrated", "dev", {
    name: "Перенесённая компания", legacyClientId: "old-dev",
  }));
  const migratedResult = visibleBootstrapData(migratedData.employees[0], migratedData);
  assert.equal(migratedResult.companies.some((item) => item.id === "legacy-client:old-dev"), false);
});

test("CRM-валидация проверяет ссылки и не позволяет пересекать бизнесы", () => {
  const pipeline = scoped("pipeline-dev", "dev", { name: "Продажи", active: true });
  const stage = scoped("stage-dev", "dev", { pipelineId: pipeline.id, name: "Переговоры", order: 20, type: "open" });
  const data = {
    employees: [{ id: "staff", active: true }],
    memberships: [scoped("membership-staff", "dev", { employeeId: "staff", active: true })],
    clients: [scoped("old-dev", "dev", { name: "Старый клиент" })],
    companies: [scoped("company-dev", "dev", { name: "Компания" })],
    contacts: [scoped("contact-dev", "dev", { companyId: "company-dev", name: "Контакт" })],
    leads: [], deals: [], pipelines: [pipeline], stages: [stage], dealItems: [],
  };
  const deal = scoped("deal", "dev", {
    name: "Сделка", companyId: "company-dev", contactId: "contact-dev",
    pipelineId: pipeline.id, stageId: stage.id, amount: 100,
  });

  assert.equal(validateCrmEntity("deals", deal, data), null);
  assert.equal(validateCrmEntity("deals", { ...deal, responsibleId: "staff" }, data), null);
  assert.equal(
    validateCrmEntity("deals", { ...deal, responsibleId: "missing" }, data),
    "Ответственный не найден",
  );
  assert.equal(validateCrmEntity("deals", { ...deal, companyId: "legacy-client:old-dev", contactId: "" }, data), null);
  assert.equal(validateCrmEntity("deals", { ...deal, unit: "padel" }, data), "businessId и unit должны совпадать");
  assert.equal(
    validateCrmEntity("deals", { ...deal, stageId: "missing" }, data),
    "Стадия не найдена",
  );
  assert.equal(
    validateCrmEntity("dealItems", scoped("item", "dev", { name: "Позиция", dealId: "missing", amount: 10 }), data),
    "Сделка не найдена",
  );
  assert.equal(
    validateCrmEntity("leads", scoped("lead", "dev", { name: "Лид", status: "unknown" }), data),
    "Неизвестный статус лида",
  );

  const lostStage = scoped("stage-lost", "dev", {
    pipelineId: pipeline.id, name: "Отказ", order: 60, type: "lost",
  });
  data.stages.push(lostStage);
  assert.equal(
    validateCrmEntity("deals", { ...deal, stageId: lostStage.id }, data),
    "Укажите причину отказа",
  );
  assert.equal(
    validateCrmEntity("deals", { ...deal, stageId: lostStage.id, lostReason: "Нет бюджета" }, data),
    null,
  );
  data.deals.push(deal);
  assert.equal(
    validateCrmEntity("dealItems", scoped("recurring", "dev", {
      name: "Поддержка", dealId: deal.id, amount: 50, recurring: true,
    }), data),
    "Укажите период регулярного платежа",
  );
});

test("серверные значения CRM по умолчанию совпадают с LocalStore", () => {
  assert.deepEqual(normalizeCrmRecord("companies", { name: "Компания" }), {
    name: "Компания", responsibleIds: [], status: "lead",
  });
  assert.deepEqual(normalizeCrmRecord("contacts", { name: "Контакт" }), { name: "Контакт", isPrimary: false });
  assert.deepEqual(normalizeCrmRecord("leads", { name: "Лид" }), { name: "Лид", status: "new" });
  assert.deepEqual(normalizeCrmRecord("pipelines", { name: "Продажи" }), {
    name: "Продажи", isDefault: false, active: true,
  });
  assert.deepEqual(normalizeCrmRecord("deals", { name: "Сделка" }), { name: "Сделка", amount: 0 });
  assert.deepEqual(normalizeCrmRecord("dealItems", { name: "Позиция" }), {
    name: "Позиция", amount: 0, recurring: false,
  });
});

test("удаление не оставляет битые CRM-ссылки", () => {
  const company = scoped("company", "dev", { name: "Компания" });
  const deal = scoped("deal", "dev", { name: "Сделка", companyId: company.id });
  const data = {
    companies: [company], contacts: [], leads: [], deals: [deal], pipelines: [], stages: [],
    dealItems: [scoped("item", "dev", { name: "Позиция", dealId: deal.id })],
  };

  assert.equal(crmDeleteError("companies", company, data), "Компания используется в сделках");
  assert.equal(crmDeleteError("deals", deal, data), "Сначала удалите позиции сделки");
  assert.equal(crmDeleteError("leads", scoped("lead", "dev", { name: "Лид" }), data), null);
});

test("серверный bootstrap создаёт только справочник воронки и применяет CRM-валидацию к записи", async () => {
  const [accessSource, actionsSource] = await Promise.all([
    readFile(new URL("../supabase/functions/api/auth/access.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/api/actions.ts", import.meta.url), "utf8"),
  ]);

  assert.match(accessSource, /readAll\("pipelines"\), readAll\("stages"\)/);
  assert.match(accessSource, /missingCrmDefaults\(allBusinesses, pipelines, stages\)/);
  assert.match(accessSource, /writeRow\("pipelines"/);
  assert.match(accessSource, /writeRow\("stages"/);
  assert.doesNotMatch(accessSource, /writeRow\("(?:companies|contacts|leads|deals|dealItems)"/);
  assert.match(actionsSource, /validateCrmEntity\(entity, item, data\)/);
  assert.match(actionsSource, /crmDeleteError\(entity, item, data\)/);
  assert.match(actionsSource, /Promise\.all\(ENTITIES\.map\(async \(entity\) => \[entity, await readAll\(entity\)\]/);
  assert.match(actionsSource, /Object\.fromEntries\(entries\)/);
  assert.match(actionsSource, /CRM_ENTITIES\.includes\(entity\)\) item = normalizeCrmRecord\(entity, item\)/);
  assert.match(actionsSource, /const merged = normalizeCrmRecord\(entity, \{ \.\.\.before, \.\.\.item, updated: Date\.now\(\) \}\)/);
});
