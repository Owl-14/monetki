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

test("наличная касса не передаётся в расчёт счетов владельцев", async () => {
  const data = {
    finance: [{ unit: "dev", type: "income", amount: 100 }],
    cash: [{ unit: "dev", type: "income", amount: 100_000, owner: "savva" }],
  };

  const balances = ownerBalances(data.finance);
  assert.equal(balances.savva.total, 50);
  assert.equal(balances.andrey.total, 50);

  const appSource = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(appSource, /ownerBalances\(S\.data\.finance \|\| \[\]\)/);
});
