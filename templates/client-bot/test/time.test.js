import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, utcToLocal, tzOffset, addDays, weekdayKey, dayRange, parseHM, isDate, localDate, daysBetween } from '../src/time.js';

const TZ = 'Europe/Kyiv';
const iso = (ms) => new Date(ms).toISOString();

test('tzOffset: Киев зимой +120, летом +180', () => {
  assert.equal(tzOffset(Date.UTC(2026, 0, 15, 12), TZ), 120);
  assert.equal(tzOffset(Date.UTC(2026, 6, 15, 12), TZ), 180);
});

test('localToUtc: обычные дни зимой и летом', () => {
  assert.equal(iso(localToUtc('2026-11-02', '10:00', TZ)), '2026-11-02T08:00:00.000Z');
  assert.equal(iso(localToUtc('2026-07-02', '10:00', TZ)), '2026-07-02T07:00:00.000Z');
});

test('localToUtc: полночь и 24:00 — граница суток по Киеву, не по UTC', () => {
  assert.equal(iso(localToUtc('2026-11-02', '00:00', TZ)), '2026-11-01T22:00:00.000Z');
  assert.equal(iso(localToUtc('2026-11-02', '24:00', TZ)), '2026-11-02T22:00:00.000Z');
  assert.equal(localToUtc('2026-11-02', '24:00', TZ), localToUtc('2026-11-03', '00:00', TZ));
  // 00:30 по Киеву летом — ещё «вчера» по UTC
  assert.equal(iso(localToUtc('2026-07-02', '00:30', TZ)), '2026-07-01T21:30:00.000Z');
});

test('localToUtc: весенний переход (29.03.2026) — несуществующее 03:30 сдвигается вперёд', () => {
  assert.equal(iso(localToUtc('2026-03-29', '02:59', TZ)), '2026-03-29T00:59:00.000Z');
  assert.equal(iso(localToUtc('2026-03-29', '03:30', TZ)), '2026-03-29T01:30:00.000Z'); // = 04:30 по летнему времени
  assert.equal(utcToLocal(localToUtc('2026-03-29', '03:30', TZ), TZ).time, '04:30');
  assert.equal(iso(localToUtc('2026-03-29', '04:00', TZ)), '2026-03-29T01:00:00.000Z');
});

test('localToUtc: осенний переход (25.10.2026) — повторяющееся 03:30 = первое вхождение', () => {
  const first = localToUtc('2026-10-25', '03:30', TZ);
  assert.equal(iso(first), '2026-10-25T00:30:00.000Z');          // летнее время, ещё +3
  assert.equal(utcToLocal(first + 3600000, TZ).time, '03:30');   // через час на часах снова 03:30 (+2)
  assert.equal(iso(localToUtc('2026-10-25', '04:00', TZ)), '2026-10-25T02:00:00.000Z');
});

test('dayRange: в сутки перехода 23 и 25 часов, в обычные 24', () => {
  const len = (d) => { const [a, b] = dayRange(d, TZ); return (b - a) / 3600000; };
  assert.equal(len('2026-03-29'), 23);
  assert.equal(len('2026-10-25'), 25);
  assert.equal(len('2026-11-02'), 24);
});

test('utcToLocal: дата и время по Киеву через границу UTC-суток', () => {
  assert.deepEqual(utcToLocal(Date.UTC(2026, 10, 2, 22, 30), TZ), { date: '2026-11-03', time: '00:30', min: 30 });
  assert.equal(localDate(Date.UTC(2026, 5, 30, 21, 0), TZ), '2026-07-01');
});

test('addDays / daysBetween / weekdayKey — календарные, без поясов', () => {
  assert.equal(addDays('2026-03-28', 1), '2026-03-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(weekdayKey('2026-11-02'), 'mon');
  assert.equal(weekdayKey('2026-03-29'), 'sun');
});

test('parseHM / isDate: отсекают мусор', () => {
  assert.equal(parseHM('09:30'), 570);
  assert.equal(parseHM('24:00'), 1440);
  for (const bad of ['25:00', '24:30', '9', '09:60', '', null, 'ab:cd', '10:5']) assert.equal(parseHM(bad), null, String(bad));
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(isDate('2026-13-01'), false);
});
