import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventLedger, eventSplitShares, financeLinkError, ledgerFounderBalances, ledgerMoney, playerEventPaid, walletBalances, walletIdOf,
} from '../js/ledger-rules.js';
import { eventEconomy, ownerSharesForEvent } from '../js/event-rules.js';

const padel = { id: 'padel', accounting: 'ledger' };
const owners = [
  { businessId: 'padel', ownerId: 'dmitry', name: 'Дмитрий', opening: 0 },
  { businessId: 'padel', ownerId: 'andrey', name: 'Андрей', opening: 1000 },
  { businessId: 'padel', ownerId: 'savva', name: 'Савва', opening: 0 },
];
const events = [
  { id: 'e1', businessId: 'padel', split: 'ДШ' },
  { id: 'e2', businessId: 'padel', split: 'ОБЩ' },
];
const op = (id, type, amount, extra = {}) => ({ id, businessId: 'padel', unit: 'padel', type, amount, ...extra });
const finance = [
  op('f1', 'income', 11000, { category: 'Взносы игроков', eventId: 'e1', playerId: 'p1' }),
  op('f2', 'expense', 6000, { category: 'Оплата кортов', eventId: 'e1' }),
  op('f3', 'income', 10000, { category: 'Взносы игроков', eventId: 'e2' }),
  op('f4', 'expense', 4000, { category: 'Оплата кортов', eventId: 'e2' }),
  op('f5', 'income', 3000, { category: 'Расчеты с учредителями', responsible: 'savva', wallet: 'w-cash' }),
  op('f6', 'expense', 600, { category: 'Общие хозяйственные', wallet: 'w-cash' }),
  op('f7', 'expense', 1320, { category: 'На складе' }),
  op('f8', 'income', 5500, { category: 'Депозит клиента', source: 'bank' }),
];

test('прибыль турнира — сумма операций с его пометкой, по статьям', () => {
  const ledger = eventLedger('e1', finance);
  assert.equal(ledger.income, 11000);
  assert.equal(ledger.expense, 6000);
  assert.equal(ledger.profit, 5000);
  assert.deepEqual(ledger.byArticle.map((row) => row.article), ['Взносы игроков', 'Оплата кортов']);
  assert.equal(playerEventPaid('e1', 'p1', finance), 11000);
});

test('счета учредителей считаются как в «Своде»', () => {
  const { founders, generalTotal } = ledgerFounderBalances(padel, { finance, events, businessOwners: owners });
  const byId = Object.fromEntries(founders.map((item) => [item.ownerId, item]));
  assert.equal(generalTotal, -600);
  // ДШ: вся прибыль e1 (5000) Дмитрию; ОБЩ: 6000 × 33/34/33; общие −600 × 2/3 и по 1/6.
  assert.equal(byId.dmitry.result, 5000 + 1980);
  assert.equal(byId.andrey.result, 2040);
  assert.equal(byId.savva.result, 1980);
  assert.equal(byId.dmitry.general, -400);
  assert.equal(byId.andrey.general, -100);
  assert.equal(byId.savva.dds, 3000);
  assert.equal(byId.andrey.total, 1000 + 2040 - 100);
  assert.equal(byId.savva.total, 3000 + 1980 - 100);
});

test('кошельки, склад и депозиты', () => {
  const wallets = [
    { id: 'w-bank', businessId: 'padel', name: 'Точка', kind: 'bank', bankSync: true, opening: 0 },
    { id: 'w-cash', businessId: 'padel', name: 'Касса', kind: 'cash', opening: 500 },
  ];
  assert.equal(walletIdOf(finance[7], wallets), 'w-bank');
  const balances = Object.fromEntries(walletBalances(padel, { wallets, finance }).map((item) => [item.id, item.balance]));
  assert.equal(balances['w-cash'], 500 + 3000 - 600);
  assert.equal(balances['w-bank'], 5500);
  assert.equal(walletBalances(padel, { wallets, finance }, { amount: 777 }).find((item) => item.id === 'w-bank').balance, 777);
  const money = ledgerMoney(padel, { finance });
  assert.equal(money.stock, 1320);
  assert.equal(money.deposits, -5500);
});

test('доли события по пометке ДШ/ОБЩ и экономика события учитывают журнал', () => {
  assert.deepEqual(eventSplitShares(events[0], padel), [{ ownerId: 'dmitry', share: 1 }]);
  const shares = ownerSharesForEvent(events[1], { businesses: [padel], businessOwners: owners, eventTypes: [] });
  assert.deepEqual(shares.map((item) => [item.ownerId, item.share]), [['dmitry', 0.33], ['andrey', 0.34], ['savva', 0.33]]);
  const economy = eventEconomy(events[0], { finance, eventRegistrations: [], eventBudgetLines: [], eventFinanceAllocations: [] });
  assert.equal(economy.actualIncome, 11000);
  assert.equal(economy.directExpenses, 6000);
  assert.equal(economy.profit, 5000);
});

test('ссылки операции проверяются внутри одного бизнеса', () => {
  const data = { wallets: [{ id: 'w', businessId: 'padel' }], events: [{ id: 'e', businessId: 'dev' }], players: [] };
  assert.equal(financeLinkError({ businessId: 'padel', wallet: 'w' }, data), null);
  assert.match(financeLinkError({ businessId: 'padel', eventId: 'e' }, data), /Турнир/);
  assert.match(financeLinkError({ businessId: 'padel', playerId: 'x' }, data), /Игрок/);
});
