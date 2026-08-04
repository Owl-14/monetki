import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("раздел событий имеет список, календарь и четыре вкладки карточки", async () => {
  const [app, shell] = await Promise.all([read("../js/app.js"), read("../js/app-shell.js")]);
  assert.match(shell, /events:\s*\{ group: 'События'/);
  assert.match(shell, /const EVENT_TABS = \[/);
  for (const tab of ["Обзор", "Участники", "Экономика", "История"]) assert.match(shell, new RegExp(tab));
  assert.match(app, /data-event-view="list"/);
  assert.match(app, /data-event-view="calendar"/);
  assert.match(app, /Событий пока нет/);
  assert.match(app, /В этом месяце событий нет/);
  assert.doesNotMatch(app, /79 событий|917 участ/);
});

test("UI не создаёт второй денежный факт и использует специальные действия", async () => {
  const app = await read("../js/app.js");
  assert.match(app, /Новая денежная операция не создаётся/);
  assert.match(app, /S\.store\.allocateEventFinance/);
  assert.match(app, /S\.store\.closeEventSettlement/);
  assert.doesNotMatch(app, /doCreate\('eventFinanceAllocations'/);
  assert.match(app, /У вас нет доступа к прибыли и финансовым операциям события/);
  assert.match(app, /event\.staffAmount/);
  assert.match(app, /const ownIncome = isResponsible \? event\.staffAmount : 0/);
  assert.match(app, /canManageEvent\(event\)/);
  assert.match(app, /isAdmin\(\) \? `<label class="field"><span>Начислено/);
  assert.match(app, /Доли организаторов/);
  assert.match(app, /plannedProfitPerParticipant/);
});

test("резервная копия использует отдельную админскую операцию", async () => {
  const [app, store, http] = await Promise.all([
    read("../js/app.js"), read("../js/store.js"), read("../supabase/functions/api/http.ts"),
  ]);
  assert.match(app, /S\.store\.backup\(S\.token\)/);
  assert.match(store, /backup\(token\).*action: 'backup'/s);
  assert.match(http, /case "backup"/);
});

test("события имеют отдельную мобильную повестку и адаптивные таблицы", async () => {
  const css = await read("../css/style.css");
  assert.match(css, /\.event-calendar-grid/);
  assert.match(css, /\.event-agenda/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.event-participant-head \{ display: none; \}/);
});
