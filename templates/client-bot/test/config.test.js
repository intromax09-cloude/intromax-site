import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseConfig, ConfigError } from '../src/config.js';
import { example } from './helpers/harness.js';

const NICHES = readdirSync(new URL('../examples/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

const problems = (mutate, base = 'barbershop') => {
  const raw = example(base);
  mutate(raw);
  try { parseConfig(raw); } catch (e) { assert.ok(e instanceof ConfigError, 'ждали ConfigError, получили ' + e); return e.errors; }
  return [];
};
const has = (errs, part) => assert.ok(errs.some((e) => e.includes(part)), 'нет ошибки с «' + part + '». Есть:\n' + errs.join('\n'));

test('примеры всех ниш проходят проверку', () => {
  assert.deepEqual(NICHES.sort(), ['barbershop', 'cosmetology', 'dental', 'furniture', 'salon', 'sto', 'vet']);
  for (const n of NICHES) {
    const cfg = parseConfig(example(n));
    assert.ok(cfg.services.length > 0, n);
    assert.equal(cfg.business.niche, n);
  }
});

test('config.json в корне шаблона валиден', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => parseConfig(raw));
});

test('нормализация: диапазоны дней, часы в минутах, значения по умолчанию', () => {
  const cfg = parseConfig(example('barbershop'));
  assert.deepEqual(cfg.hours.tue, { open: 600, close: 1200, breaks: [[840, 870]] });
  assert.deepEqual(cfg.hours.fri, cfg.hours.mon);
  assert.equal(cfg.hours.sun, null);
  assert.equal(cfg.booking.stepMin, 30);
  assert.equal(cfg.business.timezone, 'Europe/Kyiv');
  assert.equal(cfg.texts.master_nom, 'Майстер');
  assert.deepEqual(cfg.resources, ['ivan', 'petro', 'andriy']);
});

test('ниша меняет подпись исполнителя, config.texts перекрывает', () => {
  assert.equal(parseConfig(example('dental')).texts.master_nom, 'Лікар');
  assert.equal(parseConfig(example('sto')).texts.master_nom, 'Пост'); // из config.texts
  const raw = example('dental'); raw.business.language = 'ru';
  assert.equal(parseConfig(raw).texts.master_nom, 'Врач');
});

test('без мастеров ресурс один — «_»', () => {
  assert.deepEqual(parseConfig(example('furniture')).resources, ['_']);
});

test('плохой конфиг: корень не объект', () => {
  assert.throws(() => parseConfig([]), (e) => e instanceof ConfigError && /корень/.test(e.message));
  assert.throws(() => parseConfig(null), ConfigError);
});

test('плохой конфиг: нет названия, неизвестный язык, ниша и пояс — все ошибки сразу, с путями', () => {
  const errs = problems((r) => { r.business.name = ' '; r.business.language = 'en'; r.business.niche = 'cafe'; r.business.timezone = 'Mars/Base'; });
  has(errs, 'business.name'); has(errs, 'business.language'); has(errs, 'business.niche'); has(errs, 'business.timezone');
  assert.equal(errs.length, 4);
});

test('плохой конфиг: неверное время, закрытие раньше открытия, работа через полночь', () => {
  has(problems((r) => { r.hours['mon-fri'].open = '25:00'; }), 'hours.mon-fri.open');
  has(problems((r) => { r.hours['mon-fri'].close = '09:00'; }), 'должно быть позже открытия');
  has(problems((r) => { r.hours.sat = { open: '20:00', close: '02:00' }; }), 'через полночь');
  has(problems((r) => { r.hours.sat = { open: '10:00', close: '9' }; }), 'hours.sat.close');
});

test('плохой конфиг: перерыв вне часов работы, обратный и пересекающийся', () => {
  has(problems((r) => { r.hours['mon-fri'].breaks = [{ from: '08:00', to: '09:00' }]; }), 'выходит за рабочие часы');
  has(problems((r) => { r.hours['mon-fri'].breaks = [{ from: '15:00', to: '14:00' }]; }), 'конец перерыва');
  has(problems((r) => { r.hours['mon-fri'].breaks = [{ from: '13:00', to: '15:00' }, { from: '14:00', to: '16:00' }]; }), 'пересекаются');
  has(problems((r) => { r.hours['mon-fri'].breaks = 'обед'; }), 'breaks');
});

test('плохой конфиг: дни недели — пропущены, дублируются, опечатка в ключе, диапазон задом наперёд', () => {
  has(problems((r) => { delete r.hours.sun; }), 'не заданы дни: sun');
  has(problems((r) => { r.hours.mon = null; }), 'задан дважды');
  has(problems((r) => { r.hours.monday = null; }), 'неизвестный ключ');
  has(problems((r) => { r.hours['fri-mon'] = null; }), 'по порядку недели');
  has(problems((r) => { delete r.hours; }), 'hours: обязательный');
});

test('плохой конфиг: услуги', () => {
  has(problems((r) => { r.services = []; }), 'services: нужен непустой список');
  has(problems((r) => { r.services[0].durationMin = 0; }), 'services[0].durationMin');
  has(problems((r) => { delete r.services[1].durationMin; }), 'обязательное поле');
  has(problems((r) => { r.services[1].id = r.services[0].id; }), 'повторяется');
  has(problems((r) => { r.services[0].id = 'Стрижка!'; }), 'services[0].id');
  has(problems((r) => { r.services[0].price = -5; }), 'services[0].price');
  has(problems((r) => { r.services[0].name = ''; }), 'services[0].name');
});

test('плохой конфиг: ссылки на несуществующих мастеров и услуги', () => {
  has(problems((r) => { r.services[3].masters = ['ghost']; }), 'мастер "ghost" не описан');
  has(problems((r) => { r.masters[0].services = ['nope']; }), 'услуга "nope" не описана');
  has(problems((r) => { r.services[3].masters = ['ivan']; r.masters[0].services = ['cut']; }), 'ни один мастер не может выполнять услугу "kids"');
});

test('плохой конфиг: мастера', () => {
  has(problems((r) => { r.masters[1].id = r.masters[0].id; }), 'повторяется');
  has(problems((r) => { r.masters[0].id = 'any'; }), 'masters[0].id');
  has(problems((r) => { r.masters[0].chatId = '123'; }), 'masters[0].chatId');
  has(problems((r) => { r.masters[0].name = ''; }), 'masters[0].name');
});

test('плохой конфиг: chat id владельца — только целые числа', () => {
  has(problems((r) => { r.owner.chatIds = ['123456']; }), 'owner.chatIds[0]');
  has(problems((r) => { r.owner.chatIds = [1.5]; }), 'owner.chatIds[0]');
  has(problems((r) => { r.owner.chatIds = '123'; }), 'owner.chatIds');
});

test('плохой конфиг: числовые настройки, напоминания, ссылка на отзыв', () => {
  has(problems((r) => { r.booking.stepMin = 3; }), 'booking.stepMin');
  has(problems((r) => { r.booking.horizonDays = 'много'; }), 'booking.horizonDays');
  has(problems((r) => { r.booking.autoConfirm = 'да'; }), 'booking.autoConfirm');
  has(problems((r) => { r.reminders.beforeHours = [24, -2]; }), 'reminders.beforeHours');
  has(problems((r) => { r.reminders.reviewUrl = 'g.page/review'; }), 'reminders.reviewUrl');
  has(problems((r) => { r.limits.perMinute = 0; }), 'limits.perMinute');
});

test('плохой конфиг: тексты — неизвестный ключ и сломанный HTML', () => {
  has(problems((r) => { r.texts = { welcom: 'Привіт' }; }), 'texts.welcom: нет такого текста');
  has(problems((r) => { r.texts = { welcome: 'Ціна < 5' }; }), 'допустимы только теги');
  has(problems((r) => { r.texts = { welcome: '<b>Привіт' }; }), 'незакрытый');
  assert.doesNotThrow(() => parseConfig(Object.assign(example('barbershop'), { texts: { welcome: '<b>Привіт</b> &amp; ласкаво просимо' } })));
});

test('плохой конфиг: опечатка в названии раздела не молчит', () => {
  has(problems((r) => { r.servces = []; }), 'servces: неизвестный раздел');
});

test('ConfigError: сообщение читаемо и содержит все пункты', () => {
  const raw = example('barbershop'); raw.business.name = ''; raw.services = [];
  try { parseConfig(raw); assert.fail('должно упасть'); } catch (e) {
    assert.match(e.message, /Ошибки в config\.json/);
    assert.match(e.message, /business\.name/);
    assert.match(e.message, /services/);
  }
});
