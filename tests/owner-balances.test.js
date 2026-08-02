import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ownerBalances, ownerParts } from "../js/store.js";

test("ownerBalances делит доходы dev 50/50, а padel 33/34/33", () => {
  const balances = ownerBalances([
    { unit: "dev", type: "income", amount: 1_000 },
    { unit: "padel", type: "income", amount: 1_000 },
  ]);

  assert.deepEqual(balances.savva, { dev: 500, padel: 330, personal: 0, total: 830 });
  assert.deepEqual(balances.andrey, { dev: 500, padel: 340, personal: 0, total: 840 });
  assert.deepEqual(balances.dmitry, { dev: 0, padel: 330, personal: 0, total: 330 });
});

test("личный расход вычитается целиком у выбранного владельца", () => {
  const balances = ownerBalances([
    { unit: "dev", type: "income", amount: 1_000 },
    { unit: "dev", type: "expense", amount: 200, owner: "savva" },
  ]);

  assert.equal(balances.savva.total, 300);
  assert.equal(balances.andrey.total, 500);
  assert.equal(balances.dmitry.total, 0);
});

test("savva_andrey делит личный расход пополам", () => {
  assert.deepEqual(ownerParts("savva_andrey"), [["savva", 0.5], ["andrey", 0.5]]);

  const balances = ownerBalances([
    { unit: "padel", type: "income", amount: 1_000 },
    { unit: "padel", type: "expense", amount: 200, owner: "savva_andrey" },
  ]);

  assert.equal(balances.savva.total, 230);
  assert.equal(balances.andrey.total, 240);
  assert.equal(balances.dmitry.total, 330);
});

test("переводы между счетами полностью игнорируются", () => {
  const transfer = { unit: "dev", amount: 9_999, category: "Перевод между счетами" };

  assert.deepEqual(
    ownerBalances([{ ...transfer, type: "income" }, { ...transfer, type: "expense", owner: "savva" }]),
    ownerBalances([]),
  );
});

test("businessOwners переопределяет прежние доли, а пустой список сохраняет fallback", () => {
  const finance = [{ businessId: "dev", unit: "dev", type: "income", amount: 1_000 }];
  const configured = ownerBalances(finance, [
    { businessId: "dev", ownerId: "savva", share: 0.7 },
    { businessId: "dev", ownerId: "andrey", share: 0.3 },
  ]);

  assert.equal(configured.savva.dev, 700);
  assert.equal(configured.andrey.dev, 300);
  assert.equal(ownerBalances(finance, []).savva.dev, 500);
});

test("новый бизнес и новый ownerId входят в total", () => {
  const balances = ownerBalances(
    [{ businessId: "events", unit: "events", type: "income", amount: 1_000 }],
    [
      { businessId: "events", ownerId: "new-owner", share: 0.6 },
      { businessId: "events", ownerId: "savva", share: 0.4 },
    ],
  );

  assert.equal(balances["new-owner"].events, 600);
  assert.equal(balances["new-owner"].total, 600);
  assert.equal(balances.savva.events, 400);
  assert.equal(balances.savva.total, 400);
});

test("businessId и ownerId constructor не конфликтуют с Object.prototype", () => {
  const balances = ownerBalances(
    [{ businessId: "constructor", unit: "constructor", type: "income", amount: 1_000 }],
    [
      { businessId: "constructor", ownerId: "constructor", share: 0.75 },
      { businessId: "constructor", ownerId: "savva", share: 0.25 },
    ],
  );

  assert.equal(Object.getPrototypeOf(balances), Object.prototype);
  assert.equal(Object.hasOwn(balances, "constructor"), true);
  assert.equal(balances.constructor.constructor, 750);
  assert.equal(balances.constructor.total, 750);
  assert.equal(balances.savva.constructor, 250);
  assert.equal(balances.savva.total, 250);
});

test("наличная касса не передаётся в расчёт счетов владельцев", async () => {
  const data = {
    finance: [{ unit: "dev", type: "income", amount: 100 }],
    cash: [{ unit: "dev", type: "income", amount: 100_000, owner: "savva" }],
  };

  const balances = ownerBalances(data.finance);
  assert.equal(balances.savva.total, 50);
  assert.equal(balances.andrey.total, 50);

  const appSource = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(appSource, /ownerBalances\(S\.data\.finance \|\| \[\], businessOwners\)/);
});
