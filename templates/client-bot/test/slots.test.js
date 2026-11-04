import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { freeSlots, freeDays, findSlot, pickMaster, workSegments, eligibleResources, dateInHorizon } from '../src/slots.js';
import { localToUtc, utcToLocal } from '../src/time.js';

const TZ = 'Europe/Kyiv';
const at = (d, t) => localToUtc(d, t, TZ);
const MIN = 60000;

function cfgOf(mut) {
  const raw = {
    business: { name: 'T', niche: 'barbershop' },
    hours: { 'mon-fri': { open: '10:00', close: '20:00', breaks: [{ from: '14:00', to: '14:30' }] }, sat: null, sun: null },
    booking: { stepMin: 30, minLeadMin: 0, bufferMin: 0, horizonDays: 14 },
    services: [{ id: 'cut', name: 'Cut', durationMin: 45 }, { id: 'long', name: 'Long', durationMin: 150 },
      { id: 's30', name: 'S30', durationMin: 30 }, { id: 'huge', name: 'Huge', durationMin: 400 }, { id: 'h60', name: 'H60', durationMin: 60 }],
    masters: [{ id: 'a', name: 'A' }]
  };
  if (mut) mut(raw);
  return parseConfig(raw);
}
const DAY = '2026-11-03';                     // вторник
const NOW = at('2026-11-02', '09:00');        // понедельник утром
const q = (o) => Object.assign({ serviceId: 'cut', masterId: 'any', date: DAY, now: NOW }, o);
const times = (slots) => slots.map((s) => s.time);
const none = { appointments: [], blocks: [] };
const appt = (o) => Object.assign({ id: 1, master_id: 'a', status: 'confirmed' }, o);
const apptAt = (date, from, to, o) => appt(Object.assign({ start_ts: at(date, from), end_ts: at(date, to) }, o));

test('пустой день: сетка 30 мин по обе стороны перерыва', () => {
  const t = times(freeSlots(cfgOf(), q({ serviceId: 's30' }), none));
  assert.equal(t[0], '10:00');
  assert.deepEqual(t.slice(6, 10), ['13:00', '13:30', '14:30', '15:00']);
  assert.equal(t.length, 8 + 11);
  assert.ok(!t.includes('14:00'), 'слот в перерыв');
});

test('конец рабочего дня: услуга должна закончиться не позже закрытия', () => {
  const cfg = cfgOf();
  const t45 = times(freeSlots(cfg, q({ serviceId: 'cut' }), none));
  assert.equal(t45[t45.length - 1], '19:00');          // 19:00 + 45 мин = 19:45
  assert.ok(!t45.includes('19:30'));                    // 19:30 + 45 мин = 20:15 > 20:00
  const t30 = times(freeSlots(cfg, q({ serviceId: 's30' }), none));
  assert.equal(t30[t30.length - 1], '19:30');           // ровно до закрытия — можно
});

test('перерыв: услуга не может «перелезать» через перерыв, сетка после перерыва начинается заново', () => {
  const t = times(freeSlots(cfgOf(), q({ serviceId: 'cut' }), none));
  assert.ok(t.includes('13:00'));                       // 13:00–13:45 успевает до 14:00
  assert.ok(!t.includes('13:30'));                      // 13:30–14:15 залезло бы в перерыв
  assert.ok(!t.includes('14:00'));
  assert.ok(t.includes('14:30'));                       // после перерыва — с 14:30
});

test('перерыв, не кратный шагу: после перерыва слоты идут от его конца', () => {
  const cfg = cfgOf((r) => { r.hours['mon-fri'].breaks = [{ from: '13:00', to: '13:20' }]; });
  const t = times(freeSlots(cfg, q({ serviceId: 's30' }), none));
  assert.ok(t.includes('13:20') && t.includes('13:50') && !t.includes('13:00'));
});

test('длинная услуга: помещается только в отрезок достаточной длины', () => {
  const cfg = cfgOf();
  const t = times(freeSlots(cfg, q({ serviceId: 'long' }), none));       // 150 мин
  assert.deepEqual(t.filter((x) => x < '14:00'), ['10:00', '10:30', '11:00', '11:30']); // 11:30–14:00 впритык
  assert.equal(t[t.length - 1], '17:30');                                 // 17:30–20:00 впритык
  assert.deepEqual(freeSlots(cfg, q({ serviceId: 'huge' }), none), []);   // 400 мин не помещается никуда
});

test('занятая запись закрывает пересекающиеся слоты, соседние остаются', () => {
  const data = { appointments: [apptAt(DAY, '11:00', '11:45')], blocks: [] };
  const t = times(freeSlots(cfgOf(), q({ serviceId: 'cut' }), data));
  assert.ok(t.includes('10:00'));                       // 10:00–10:45 до начала записи
  assert.ok(!t.includes('10:30'));                      // 10:30–11:15 пересекается
  assert.ok(!t.includes('11:00') && !t.includes('11:30'));
  assert.ok(t.includes('12:00'));                       // после конца записи
});

test('пауза между записями (bufferMin) сдвигает ближайший свободный слот', () => {
  const cfg = cfgOf((r) => { r.booking.bufferMin = 30; });
  const data = { appointments: [apptAt(DAY, '11:00', '11:45')], blocks: [] };
  const t = times(freeSlots(cfg, q({ serviceId: 's30' }), data));
  assert.ok(!t.includes('12:00'));                      // 11:45 + 30 мин пауза = 12:15
  assert.ok(t.includes('12:30'));
  assert.ok(t.includes('10:00'));                       // 10:00–10:30, пауза до 11:00 — ровно 30 мин
  assert.ok(!t.includes('10:30'));                      // 10:30–11:00 встало бы вплотную без паузы
});

test('пауза не мешает последнему слоту дня', () => {
  const cfg = cfgOf((r) => { r.booking.bufferMin = 30; });
  const t = times(freeSlots(cfg, q({ serviceId: 's30' }), none));
  assert.equal(t[t.length - 1], '19:30');
});

test('статусы: pending занимает, cancelled — нет; перенос исключает саму запись', () => {
  const cfg = cfgOf();
  const mk = (status, id = 1) => ({ appointments: [apptAt(DAY, '10:00', '10:45', { status, id })], blocks: [] });
  assert.ok(!times(freeSlots(cfg, q(), mk('pending'))).includes('10:00'));
  assert.ok(!times(freeSlots(cfg, q(), mk('confirmed'))).includes('10:00'));
  assert.ok(times(freeSlots(cfg, q(), mk('cancelled'))).includes('10:00'));
  assert.ok(times(freeSlots(cfg, q({ excludeId: 1 }), mk('confirmed', 1))).includes('10:00'));
  assert.ok(!times(freeSlots(cfg, q({ excludeId: 2 }), mk('confirmed', 1))).includes('10:00'));
});

test('блокировки: слот, весь день, и блок «для всех» действует на каждого мастера', () => {
  const cfg = cfgOf((r) => { r.masters.push({ id: 'b', name: 'B' }); });
  const slotBlock = { master_id: 'a', start_ts: at(DAY, '12:00'), end_ts: at(DAY, '12:30') };
  const t = times(freeSlots(cfg, q({ serviceId: 's30', masterId: 'a' }), { appointments: [], blocks: [slotBlock] }));
  assert.ok(!t.includes('12:00') && t.includes('11:30') && t.includes('12:30'));
  const dayBlock = { master_id: null, start_ts: at(DAY, '00:00'), end_ts: at('2026-11-04', '00:00') };
  assert.deepEqual(freeSlots(cfg, q(), { appointments: [], blocks: [dayBlock] }), []);
  const onlyB = { master_id: 'b', start_ts: at(DAY, '00:00'), end_ts: at('2026-11-04', '00:00') };
  assert.ok(freeSlots(cfg, q({ masterId: 'a' }), { appointments: [], blocks: [onlyB] }).length > 0);
  assert.deepEqual(freeSlots(cfg, q({ masterId: 'b' }), { appointments: [], blocks: [onlyB] }), []);
});

test('минимальный запас времени (minLeadMin) и «уже прошло»', () => {
  const cfg = cfgOf((r) => { r.booking.minLeadMin = 120; });
  const now = at(DAY, '12:10');
  const t = times(freeSlots(cfg, q({ now, serviceId: 's30' }), none));
  assert.equal(t[0], '14:30');                           // 12:10 + 2 ч = 14:10; 14:00 в перерыве → 14:30
  assert.deepEqual(freeSlots(cfg, q({ now: at(DAY, '19:00'), serviceId: 's30' }), none), []);
  assert.deepEqual(freeSlots(cfg, q({ date: '2026-11-02', now: at('2026-11-03', '08:00') }), none), []); // вчера
});

test('выходной и индивидуальный выходной мастера', () => {
  const cfg = cfgOf((r) => { r.hours.sat = { open: '10:00', close: '15:00' }; r.masters.push({ id: 'b', name: 'B', hours: { sat: null } }); });
  const sat = '2026-11-07';
  assert.deepEqual(freeSlots(cfg, q({ date: '2026-11-08' }), none), []);               // воскресенье
  assert.deepEqual(freeSlots(cfg, q({ date: sat, masterId: 'b' }), none), []);          // у B в субботу выходной
  assert.ok(freeSlots(cfg, q({ date: sat, masterId: 'a' }), none).length > 0);
  assert.deepEqual(eligibleResources(cfg, 'cut', 'any'), ['a', 'b']);
});

test('«любой мастер»: слот есть, если свободен хотя бы один; masters перечисляет свободных', () => {
  const cfg = cfgOf((r) => { r.masters.push({ id: 'b', name: 'B' }); });
  const data = { appointments: [apptAt(DAY, '10:00', '10:45', { master_id: 'a' })], blocks: [] };
  const s = freeSlots(cfg, q(), data).find((x) => x.time === '10:00');
  assert.deepEqual(s.masters, ['b']);
  const s2 = freeSlots(cfg, q(), data).find((x) => x.time === '11:00');
  assert.deepEqual(s2.masters, ['a', 'b']);
  const both = { appointments: [apptAt(DAY, '10:00', '10:45', { master_id: 'a' }), apptAt(DAY, '10:00', '10:45', { master_id: 'b', id: 2 })], blocks: [] };
  assert.ok(!times(freeSlots(cfg, q(), both)).includes('10:00'));
});

test('услуга доступна не всем мастерам', () => {
  const cfg = cfgOf((r) => { r.masters.push({ id: 'b', name: 'B' }); r.services[0].masters = ['b']; });
  assert.deepEqual(eligibleResources(cfg, 'cut', 'any'), ['b']);
  assert.deepEqual(eligibleResources(cfg, 'cut', 'a'), []);
  assert.deepEqual(freeSlots(cfg, q({ masterId: 'a' }), none), []);
});

test('pickMaster: берём наименее загруженного, при равенстве — первого в конфиге', () => {
  const cfg = cfgOf((r) => { r.masters.push({ id: 'b', name: 'B' }); });
  const slot = { masters: ['a', 'b'] };
  assert.equal(pickMaster(cfg, slot, []), 'a');
  assert.equal(pickMaster(cfg, slot, [appt({ master_id: 'a' })]), 'b');
  assert.equal(pickMaster(cfg, slot, [appt({ master_id: 'a', status: 'cancelled' })]), 'a');
});

test('findSlot подтверждает конкретное время и отказывает, если его заняли', () => {
  const cfg = cfgOf();
  const start = at(DAY, '10:00');
  assert.ok(findSlot(cfg, q({ start }), none));
  const taken = { appointments: [apptAt(DAY, '10:00', '10:45')], blocks: [] };
  assert.equal(findSlot(cfg, q({ start }), taken), null);
  assert.equal(findSlot(cfg, q({ start: at(DAY, '10:10') }), none), null); // не на сетке
});

/* ---------- время: полночь, часовые пояса, переход на летнее/зимнее ---------- */

const allDay = (extra) => cfgOf((r) => {
  r.hours = { 'mon-fri': { open: '00:00', close: '24:00' }, sat: { open: '00:00', close: '24:00' }, sun: { open: '00:00', close: '24:00' } };
  r.booking = { stepMin: 60, minLeadMin: 0, horizonDays: 120 };
  if (extra) extra(r);
});

test('полночь: последний слот заканчивается ровно в 24:00 и не блокирует 00:00 следующего дня', () => {
  const cfg = allDay();
  const day = freeSlots(cfg, q({ serviceId: 'h60', date: '2026-11-03' }), none);
  assert.equal(day.length, 24);
  assert.equal(day[23].time, '23:00');
  assert.equal(day[23].end, at('2026-11-04', '00:00'));
  assert.equal(new Date(day[23].start).toISOString(), '2026-11-03T21:00:00.000Z');   // 23:00 по Киеву = 21:00 UTC
  const data = { appointments: [apptAt('2026-11-03', '23:00', '24:00')], blocks: [] };
  const next = freeSlots(cfg, q({ serviceId: 'h60', date: '2026-11-04' }), data);
  assert.equal(next[0].time, '00:00');                                                 // 00:00 завтра свободно
  assert.ok(!times(freeSlots(cfg, q({ serviceId: 'h60', date: '2026-11-03' }), data)).includes('23:00'));
});

test('слот 00:30 по Киеву лежит в «вчерашних» сутках UTC, но принадлежит нужной локальной дате', () => {
  const cfg = allDay((r) => { r.booking.stepMin = 30; });
  const s = freeSlots(cfg, q({ serviceId: 's30', date: '2026-07-10', now: at('2026-07-01', '09:00') }), none).find((x) => x.time === '00:30');
  assert.equal(new Date(s.start).toISOString(), '2026-07-09T21:30:00.000Z');          // лето, +3
  assert.equal(utcToLocal(s.start, TZ).date, '2026-07-10');
});

test('летнее время: тот же 10:00 — другой UTC; перерыв тоже едет вместе с поясом', () => {
  const cfg = cfgOf();
  const summer = freeSlots(cfg, q({ date: '2026-07-07', now: at('2026-07-06', '09:00'), serviceId: 's30' }), none);
  assert.equal(new Date(summer[0].start).toISOString(), '2026-07-07T07:00:00.000Z');
  assert.ok(!times(summer).includes('14:00'));
});

test('весенний переход 29.03.2026: в сутках 23 часа, 03:00 не существует', () => {
  const cfg = allDay();
  const s = freeSlots(cfg, q({ serviceId: 'h60', date: '2026-03-29', now: at('2026-03-27', '09:00') }), none);
  assert.equal(s.length, 23);
  const t = times(s);
  assert.ok(!t.includes('03:00'));
  assert.deepEqual(t.slice(0, 5), ['00:00', '01:00', '02:00', '04:00', '05:00']);
  assert.equal(t[t.length - 1], '23:00');
  assert.equal(new Set(s.map((x) => x.start)).size, 23);
});

test('осенний переход 25.10.2026: в сутках 25 часов, повторяющееся 03:00 показывается один раз (первое)', () => {
  const cfg = allDay();
  const s = freeSlots(cfg, q({ serviceId: 'h60', date: '2026-10-25', now: at('2026-10-23', '09:00') }), none);
  const t = times(s);
  assert.equal(t.filter((x) => x === '03:00').length, 1);
  assert.equal(s.length, 24);                                    // 25 абсолютных часов − 1 дубль подписи
  const three = s.find((x) => x.time === '03:00');
  assert.equal(new Date(three.start).toISOString(), '2026-10-25T00:00:00.000Z');   // первое вхождение (+3)
  assert.equal(t[t.length - 1], '23:00');
  // запись на это время находится по подписи так же, как и в списке
  assert.ok(findSlot(cfg, q({ serviceId: 'h60', start: at('2026-10-25', '03:00'), now: at('2026-10-23', '09:00') }), none));
});

test('обычный рабочий день в сутки перехода не страдает (10:00–20:00)', () => {
  const cfg = cfgOf((r) => { r.hours.sun = { open: '10:00', close: '20:00' }; });
  const before = freeSlots(cfg, q({ date: '2026-03-29', now: at('2026-03-27', '09:00'), serviceId: 's30' }), none);
  const after = freeSlots(cfg, q({ date: '2026-10-25', now: at('2026-10-23', '09:00'), serviceId: 's30' }), none);
  assert.equal(before.length, 20);
  assert.equal(after.length, 20);
  assert.equal(before[0].time, '10:00');
  assert.equal(new Date(before[0].start).toISOString(), '2026-03-29T07:00:00.000Z'); // уже +3
  assert.equal(new Date(after[0].start).toISOString(), '2026-10-25T08:00:00.000Z');  // уже +2
});

test('другой часовой пояс бизнеса учитывается', () => {
  const cfg = cfgOf((r) => { r.business.timezone = 'Europe/Warsaw'; });
  const s = freeSlots(cfg, q({ serviceId: 's30', now: localToUtc('2026-11-02', '09:00', 'Europe/Warsaw') }), none);
  assert.equal(new Date(s[0].start).toISOString(), '2026-11-03T09:00:00.000Z');       // 10:00 Варшава зимой = 09:00 UTC
});

test('workSegments: перерыв режет день на отрезки; выходной — пусто', () => {
  const cfg = cfgOf();
  const seg = workSegments(cfg, 'a', DAY);
  assert.equal(seg.length, 2);
  assert.equal((seg[0].e - seg[0].s) / MIN, 240);
  assert.equal((seg[1].e - seg[1].s) / MIN, 330);
  assert.deepEqual(workSegments(cfg, 'a', '2026-11-08'), []);
});

test('freeDays: только дни со слотами в пределах горизонта; «сегодня» считается по Киеву, не по UTC', () => {
  const cfg = cfgOf((r) => { r.booking.horizonDays = 7; });
  // 22:30 UTC 2 ноября = 00:30 3 ноября по Киеву → «сегодня» уже вторник 3-е
  const now = Date.UTC(2026, 10, 2, 22, 30);
  const days = freeDays(cfg, { serviceId: 's30', masterId: 'any', now }, none);
  assert.equal(days[0].date, '2026-11-03');
  assert.ok(days.every((d) => d.date <= '2026-11-10'));
  assert.ok(!days.some((d) => ['2026-11-07', '2026-11-08'].includes(d.date)));        // сб, вс — выходные
  assert.equal(dateInHorizon(cfg, '2026-11-10', now), true);
  assert.equal(dateInHorizon(cfg, '2026-11-11', now), false);
  assert.equal(dateInHorizon(cfg, '2026-11-02', now), false);
});

test('freeDays: если день заполнен записями, он исчезает', () => {
  const cfg = cfgOf();
  const day = '2026-11-03';
  const full = { appointments: [apptAt(day, '10:00', '14:00'), apptAt(day, '14:30', '20:00', { id: 2 })], blocks: [] };
  const days = freeDays(cfg, { serviceId: 'cut', masterId: 'any', now: NOW }, full);
  assert.ok(!days.some((d) => d.date === day));
  assert.ok(days.some((d) => d.date === '2026-11-04'));
});
