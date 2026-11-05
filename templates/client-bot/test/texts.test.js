import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { baseTexts, TEXT_KEYS, fmt, fmtPlain, raw, checkHtml, buildTexts } from '../src/texts.js';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('украинский и русский словари содержат одинаковые ключи и одинаковые подстановки', () => {
  const uk = baseTexts('uk'), ru = baseTexts('ru');
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(uk).sort());
  for (const k of TEXT_KEYS) assert.equal(placeholders(ru[k]), placeholders(uk[k]), 'подстановки в «' + k + '»');
});

test('каждый текст, который вызывает код, есть в словаре', () => {
  const dir = new URL('../src/', import.meta.url);
  const used = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\b(?:c\.t|c\.p|\.t|\.p)\(\s*'([a-z_]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/cfg\.texts\.([a-z_]+)/g)) used.add(m[1]);
  }
  for (const k of used) assert.ok(TEXT_KEYS.includes(k), 'в коде используется текст «' + k + '», которого нет в словаре');
  assert.ok(used.size > 40);
});

test('fmt экранирует HTML в подстановках, raw() — нет, fmtPlain — для кнопок', () => {
  assert.equal(fmt('Привіт, {n}!', { n: '<b>x</b> & y' }), 'Привіт, &lt;b&gt;x&lt;/b&gt; &amp; y!');
  assert.equal(fmt('{d}', { d: raw('<b>ok</b>') }), '<b>ok</b>');
  assert.equal(fmt('a{missing}b', {}), 'ab');
  assert.equal(fmtPlain('Залишити «{n}»', { n: 'A & B' }), 'Залишити «A & B»');
});

test('checkHtml: разрешены только простые теги и сущности', () => {
  assert.equal(checkHtml('<b>ok</b> &amp; <i>да</i>'), '');
  assert.match(checkHtml('1 < 2'), /допустимы только теги/);
  assert.match(checkHtml('<a href="x">z</a>'), /допустимы только теги/);
  assert.match(checkHtml('Tom & Jerry'), /&amp;/);
  assert.match(checkHtml('<b>не закрыт'), /незакрытый/);
});

test('buildTexts: ниша и переопределения клиента накладываются слоями', () => {
  const t = buildTexts('uk', 'dental', { welcome: 'Привіт!' });
  assert.equal(t.welcome, 'Привіт!');
  assert.equal(t.master_nom, 'Лікар');
  assert.equal(t.menu_book, baseTexts('uk').menu_book);
});

test('длинные кнопки: подписи кнопок меню помещаются в разумные рамки', () => {
  for (const lang of ['uk', 'ru']) {
    for (const k of ['menu_book', 'menu_my', 'menu_info', 'menu_prices', 'menu_faq', 'staff_ok', 'staff_move', 'staff_cancel', 'confirm_booking', 'share_contact']) {
      assert.ok(baseTexts(lang)[k].length <= 32, lang + '.' + k);
    }
  }
});
