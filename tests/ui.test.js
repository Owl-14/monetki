import test from 'node:test';
import assert from 'node:assert/strict';

import { $, esc, fmtDate, fmtDT, money, telHref, today } from '../js/ui.js';

test('esc экранирует HTML и безопасно обрабатывает пустые значения', () => {
  assert.equal(esc(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('money округляет числа и сохраняет формат рублей', () => {
  assert.equal(money(1234.6).replace(/\s/g, ' '), '1 235 ₽');
  assert.equal(money('не число'), '0 ₽');
});

test('форматирование дат сохраняет русский краткий вид', () => {
  const localDate = new Date(2026, 7, 2, 14, 5);

  assert.match(fmtDate(localDate.toISOString()), /2 авг\./);
  assert.match(fmtDT(localDate.toISOString()), /2 авг\./);
  assert.match(fmtDT(localDate.toISOString()), /14:05/);
  assert.equal(fmtDate(''), '');
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('telHref оставляет только допустимые символы телефонной ссылки', () => {
  assert.equal(telHref('+7 (999) 123-45-67'), 'tel:+79991234567');
  assert.equal(telHref(), 'tel:');
});

test('$ делегирует поиск переданному DOM-корню', () => {
  const root = { querySelector: (selector) => ({ selector }) };
  assert.deepEqual($('.card', root), { selector: '.card' });
});
