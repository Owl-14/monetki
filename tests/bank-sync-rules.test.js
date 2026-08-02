import test from "node:test";
import assert from "node:assert/strict";

import {
  acceptBankTransaction,
  bankTransactionId,
  classifyMethod,
  sumBankBalances,
} from "../supabase/functions/api/rules.js";

test("bankId отсекает запись из базы и дубль внутри одной синхронизации", () => {
  const known = new Set(["already-saved"]);

  assert.equal(acceptBankTransaction({ transactionId: "already-saved" }, known), null);
  assert.deepEqual(
    acceptBankTransaction({ transactionId: "new", Amount: { amount: "125.50" } }, known),
    { bankId: "new", amount: 125.5 },
  );
  assert.equal(acceptBankTransaction({ transactionId: "new", Amount: { amount: "125.50" } }, known), null);
});

test("Pending-операция не резервирует bankId и может прийти готовой позже", () => {
  const known = new Set();
  assert.equal(acceptBankTransaction({ transactionId: "later", status: "Pending" }, known), null);
  assert.equal(known.has("later"), false);
  assert.deepEqual(acceptBankTransaction({ transactionId: "later", status: "Booked" }, known), {
    bankId: "later",
    amount: 0,
  });
});

test("запасной bankId детерминирован из документа, суммы и даты", () => {
  const transaction = {
    documentNumber: "42",
    documentProcessDate: "2026-08-02",
    Amount: { amount: "1000" },
  };
  assert.equal(bankTransactionId(transaction), "42|1000|2026-08-02");
});

test("способ оплаты классифицируется по коду, схеме и описанию", () => {
  assert.equal(classifyMethod({ transactionTypeCode: "Банковские карты" }), "card");
  assert.equal(classifyMethod({ transactionTypeCode: "взнос наличными" }), "cash");
  assert.equal(classifyMethod({ creditDebitIndicator: "Credit", DebtorAccount: { schemeName: "RU.CBR.CellphoneNumber" } }), "sbp");
  assert.equal(classifyMethod({ creditDebitIndicator: "Debit", CreditorAccount: { schemeName: "RU.CBR.PAN" } }), "card");
  assert.equal(classifyMethod({ description: "Оплата по QR через НСПК" }), "sbp");
  assert.equal(classifyMethod({ description: "Обычный банковский перевод" }), "account");
});

test("баланс выбирает лучший тип по каждому счёту и сохраняет знак банка", () => {
  const total = sumBankBalances([
    { accountId: "a", type: "Expected", Amount: { amount: "100" } },
    { accountId: "a", type: "ClosingAvailable", Amount: { amount: "-25" } },
    { accountId: "b", type: "InterimAvailable", Amount: { amount: "10" } },
  ]);

  assert.equal(total, -15);
});
