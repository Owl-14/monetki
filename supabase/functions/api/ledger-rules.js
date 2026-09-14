// Учёт «как в таблице Падела»: один журнал денег по кошелькам, прибыль турниров,
// деление ДШ/ОБЩ и счета учредителей. Чистые функции без DOM/Deno.
// Файл зеркалируется в supabase/functions/api/ledger-rules.js — менять оба.

// Статьи из листа «Справочник» таблицы.
export const LEDGER_ARTICLES = [
  'Взносы игроков', 'Оплата кортов', 'Медали кубки', 'Продукты для турниров', 'Заработная плата',
  'Транспортные расходы', 'Банковская комиссия', 'Общие хозяйственные', 'Расчеты с учредителями',
  'Депозит клиента', 'На складе', 'Внутренний перевод', 'Без статьи',
];

export const FOUNDERS_ARTICLE = 'Расчеты с учредителями';
export const GENERAL_ARTICLE = 'Общие хозяйственные';
export const STOCK_ARTICLE = 'На складе';
export const DEPOSIT_ARTICLE = 'Депозит клиента';

// Разделение прибыли турнира («Справочник» → «Разделение»).
export const DEFAULT_SPLIT_PRESETS = {
  'ДШ': [{ ownerId: 'dmitry', share: 1 }],
  'ОБЩ': [{ ownerId: 'dmitry', share: 0.33 }, { ownerId: 'andrey', share: 0.34 }, { ownerId: 'savva', share: 0.33 }],
};

// Общие хозяйственные расходы в «Своде»: Дмитрию 2/3, Андрею и Савве по 1/6.
export const DEFAULT_GENERAL_SHARES = [
  { ownerId: 'dmitry', share: 2 / 3 }, { ownerId: 'andrey', share: 1 / 6 }, { ownerId: 'savva', share: 1 / 6 },
];

export const WALLET_KINDS = ['bank', 'cash'];

const scopeOf = (item) => String(item?.businessId || item?.unit || '');
const cents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => value / 100;

export const isLedgerBusiness = (business) => business?.accounting === 'ledger';

/** Сумма со знаком: приход +, расход −. */
export const signedCents = (item) => (item?.type === 'expense' ? -1 : 1) * cents(item?.amount);

export function splitPresets(business) {
  const custom = business?.splitPresets;
  return custom && typeof custom === 'object' && Object.keys(custom).length ? custom : DEFAULT_SPLIT_PRESETS;
}

export function generalShares(business) {
  return Array.isArray(business?.generalShares) && business.generalShares.length ? business.generalShares : DEFAULT_GENERAL_SHARES;
}

/** Доли прибыли конкретного события по его пометке ДШ/ОБЩ. */
export function eventSplitShares(event, business) {
  const preset = splitPresets(business)[String(event?.split || '')];
  return Array.isArray(preset) ? preset.filter((share) => share?.ownerId && Number(share.share) > 0) : [];
}

/**
 * Доли общего хозяйственного расхода: по ближайшему турниру в этот день или позже (отменённые пропускаются),
 * если турниров после расхода нет — по последнему прошедшему; без турниров с пометкой — `generalShares`.
 */
export function generalExpenseShares(item, events = [], business = null) {
  const day = String(item?.date || '').slice(0, 10);
  const dated = (events || [])
    .filter((event) => event?.status !== 'cancelled' && event?.split && eventSplitShares(event, business).length)
    .map((event) => ({ event, day: String(event.startsAt || '').slice(0, 10) }))
    .filter((entry) => entry.day)
    .sort((left, right) => left.day.localeCompare(right.day));
  const target = dated.find((entry) => entry.day >= day) || [...dated].reverse().find((entry) => entry.day < day);
  return target ? eventSplitShares(target.event, business) : generalShares(business);
}

/** Кошелёк операции: явный или банковский кошелёк с автосинхронизацией для операций из выписки. */
export function walletIdOf(item, wallets = []) {
  if (item?.wallet) return String(item.wallet);
  if (item?.source !== 'bank') return '';
  const bankWallet = (wallets || []).find((wallet) => wallet.bankSync === true && scopeOf(wallet) === scopeOf(item) && wallet.active !== false);
  return bankWallet ? bankWallet.id : '';
}

/** Итоги события по привязанным операциям журнала («Прибыль ДДС» в «Своде»). */
export function eventLedger(eventId, finance = []) {
  const operations = (finance || []).filter((item) => item?.eventId === eventId);
  let incomeCents = 0;
  let expenseCents = 0;
  const byArticle = new Map();
  for (const item of operations) {
    const amount = signedCents(item);
    if (amount >= 0) incomeCents += amount; else expenseCents -= amount;
    const article = item.category || 'Без статьи';
    byArticle.set(article, (byArticle.get(article) || 0) + amount);
  }
  return {
    operations,
    income: fromCents(incomeCents),
    expense: fromCents(expenseCents),
    profit: fromCents(incomeCents - expenseCents),
    byArticle: [...byArticle.entries()].map(([article, amount]) => ({ article, amount: fromCents(amount) }))
      .sort((left, right) => right.amount - left.amount),
  };
}

/** Оплачено игроком на событие — операции журнала с этим событием и игроком. */
export function playerEventPaid(eventId, playerId, finance = []) {
  return fromCents((finance || [])
    .filter((item) => item?.eventId === eventId && item?.playerId === playerId)
    .reduce((sum, item) => sum + signedCents(item), 0));
}

/**
 * Счета учредителей как в «Своде»:
 * на начало + «Расчеты с учредителями» по ответственному + доля прибыли турниров + общие хозяйственные.
 */
export function ledgerFounderBalances(business, { finance = [], events = [], businessOwners = [] } = {}) {
  const businessId = business?.id;
  const rows = (finance || []).filter((item) => scopeOf(item) === businessId);
  const owners = (businessOwners || []).filter((owner) => scopeOf(owner) === businessId && owner.active !== false);
  const result = new Map(owners.map((owner) => [owner.ownerId, {
    ownerId: owner.ownerId, name: owner.name || '', openingCents: cents(owner.opening), ddsCents: 0, resultCents: 0, generalCents: 0,
  }]));
  const ensure = (ownerId) => {
    if (!result.has(ownerId)) result.set(ownerId, { ownerId, name: '', openingCents: 0, ddsCents: 0, resultCents: 0, generalCents: 0 });
    return result.get(ownerId);
  };

  const businessEvents = (events || []).filter((item) => scopeOf(item) === businessId);
  let generalTotalCents = 0;
  for (const item of rows) {
    if (item.category === FOUNDERS_ARTICLE && item.responsible && result.has(item.responsible)) ensure(item.responsible).ddsCents += signedCents(item);
    if (item.category !== GENERAL_ARTICLE) continue;
    const amountCents = signedCents(item);
    generalTotalCents += amountCents;
    // Общий расход делается под ближайший турнир: ДШ — целиком Дмитрию, ОБЩ — по долям ОБЩ.
    const shares = generalExpenseShares(item, businessEvents, business);
    let distributed = 0;
    shares.forEach((share, index) => {
      const part = index === shares.length - 1 ? amountCents - distributed : Math.round(amountCents * Number(share.share || 0));
      distributed += part;
      ensure(share.ownerId).generalCents += part;
    });
  }
  const tournaments = [];
  for (const event of businessEvents) {
    const ledger = eventLedger(event.id, rows);
    const profitCents = cents(ledger.profit);
    const shares = eventSplitShares(event, business);
    tournaments.push({ eventId: event.id, profit: ledger.profit, split: event.split || '' });
    for (const share of shares) ensure(share.ownerId).resultCents += Math.round(profitCents * Number(share.share || 0));
  }
  const founders = [...result.values()].map((item) => ({
    ownerId: item.ownerId,
    name: item.name,
    opening: fromCents(item.openingCents),
    dds: fromCents(item.ddsCents),
    result: fromCents(item.resultCents),
    general: fromCents(item.generalCents),
    total: fromCents(item.openingCents + item.ddsCents + item.resultCents + item.generalCents),
  }));
  return { founders, tournaments, generalTotal: fromCents(generalTotalCents) };
}

/** Остатки кошельков: на начало + движения журнала. У банковского кошелька с синхронизацией — остаток из банка, если он известен. */
export function walletBalances(business, { wallets = [], finance = [] } = {}, bankBalance = null) {
  const businessId = business?.id;
  const list = (wallets || []).filter((wallet) => scopeOf(wallet) === businessId && wallet.active !== false);
  const totals = new Map(list.map((wallet) => [wallet.id, cents(wallet.opening)]));
  for (const item of (finance || []).filter((row) => scopeOf(row) === businessId)) {
    const walletId = walletIdOf(item, list);
    if (totals.has(walletId)) totals.set(walletId, totals.get(walletId) + signedCents(item));
  }
  return list.map((wallet) => ({
    ...wallet,
    balance: wallet.bankSync === true && bankBalance && Number.isFinite(Number(bankBalance.amount))
      ? Number(bankBalance.amount)
      : fromCents(totals.get(wallet.id) || 0),
    computed: fromCents(totals.get(wallet.id) || 0),
  }));
}

/** Блок «Деньги» из «Свода»: товар на складе и депозиты клиентов по статьям журнала. */
export function ledgerMoney(business, { finance = [], deposits = [] } = {}) {
  const businessId = business?.id;
  const rows = (finance || []).filter((item) => scopeOf(item) === businessId);
  const stockCents = -rows.filter((item) => item.category === STOCK_ARTICLE).reduce((sum, item) => sum + signedCents(item), 0);
  // Депозит — деньги клиента, которые мы ему должны: в «Своде» показывается со знаком минус.
  const depositCents = -rows.filter((item) => item.category === DEPOSIT_ARTICLE).reduce((sum, item) => sum + signedCents(item), 0);
  const openDeposits = (deposits || []).filter((item) => scopeOf(item) === businessId && Number(item.amount || 0) - Number(item.usedAmount || 0) > 0);
  return { stock: fromCents(stockCents), deposits: fromCents(depositCents), openDeposits };
}

/** Проверка ссылок операции журнала: кошелёк, событие и игрок должны быть из того же бизнеса. */
export function financeLinkError(item, data = {}) {
  const businessId = scopeOf(item);
  const same = (entity, id) => (data[entity] || []).some((row) => row.id === id && scopeOf(row) === businessId);
  if (item?.wallet && !same('wallets', item.wallet)) return 'Кошелёк не найден в этом бизнесе';
  if (item?.eventId && !same('events', item.eventId)) return 'Турнир не найден в этом бизнесе';
  if (item?.playerId && !same('players', item.playerId)) return 'Игрок не найден в этом бизнесе';
  return null;
}

export function walletError(item) {
  if (!String(item?.name || '').trim()) return 'Укажите название кошелька';
  if (!WALLET_KINDS.includes(item?.kind)) return 'Неизвестный тип кошелька';
  if (item?.opening !== undefined && item?.opening !== '' && !Number.isFinite(Number(item.opening))) return 'Остаток на начало должен быть числом';
  return null;
}
