import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminders, tickWindow, HOUR, MAX_ATTEMPTS } from '../src/reminders.js';

const opts = { enabled: true, beforeHours: [24, 2], reviewUrl: 'https://g.page/r/x', reviewAfterMin: 120 };
const START = Date.UTC(2026, 10, 10, 8, 0);          // визит 10 ноября 10:00 по Киеву
const END = START + 45 * 60000;
const appt = (o) => Object.assign({ id: 1, status: 'confirmed', start_ts: START, end_ts: END, booked_at: START - 72 * HOUR }, o);
const plan = (appts, log, now, o) => planReminders(appts, log || [], now, Object.assign({}, opts, o));
const kinds = (r) => r.map((x) => x.id + ':' + x.kind);

test('за 24 часа: до срока ничего, после срока — одно напоминание', () => {
  assert.deepEqual(plan([appt()], [], START - 25 * HOUR), []);
  assert.deepEqual(kinds(plan([appt()], [], START - 24 * HOUR)), ['1:r24']);
  assert.deepEqual(kinds(plan([appt()], [], START - 23 * HOUR)), ['1:r24']);
});

test('за 2 часа — отдельное напоминание; до него r24 не повторяется', () => {
  const sent24 = [{ appointment_id: 1, kind: 'r24', status: 'sent', attempts: 1 }];
  assert.deepEqual(plan([appt()], sent24, START - 10 * HOUR), []);
  assert.deepEqual(kinds(plan([appt()], sent24, START - 2 * HOUR)), ['1:r2']);
});

test('не дублируются: отправленное и «захваченное» другим запуском пропускаются', () => {
  const both = [{ appointment_id: 1, kind: 'r24', status: 'sent', attempts: 1 }, { appointment_id: 1, kind: 'r2', status: 'sent', attempts: 1 }];
  assert.deepEqual(plan([appt()], both, START - 1 * HOUR), []);
  assert.deepEqual(plan([appt()], [{ appointment_id: 1, kind: 'r24', status: 'sending', attempts: 1 }], START - 23 * HOUR), []);
  // повторный вызов планировщика с теми же данными даёт тот же результат (чистая функция)
  assert.deepEqual(plan([appt()], [], START - 23 * HOUR), plan([appt()], [], START - 23 * HOUR));
});

test('не напоминаем об отменённых (в том числе когда напоминание уже «наступило»)', () => {
  assert.deepEqual(plan([appt({ status: 'cancelled' })], [], START - 23 * HOUR), []);
  assert.deepEqual(plan([appt({ status: 'cancelled' })], [], START - 1 * HOUR), []);
  assert.deepEqual(plan([appt({ status: 'cancelled' })], [], END + 3 * HOUR), []);      // и отзыв тоже
});

test('pending напоминаем, confirmed тоже; неизвестный статус — нет', () => {
  assert.deepEqual(kinds(plan([appt({ status: 'pending' })], [], START - 23 * HOUR)), ['1:r24']);
  assert.deepEqual(plan([appt({ status: 'done' })], [], START - 23 * HOUR), []);
});

test('запись сделана уже после момента напоминания — этого напоминания нет', () => {
  const lateBooked = appt({ booked_at: START - 5 * HOUR });                     // создана за 5 часов
  assert.deepEqual(plan([lateBooked], [], START - 4 * HOUR), []);               // r24 не нужен: клиент только что записался
  assert.deepEqual(kinds(plan([lateBooked], [], START - 2 * HOUR)), ['1:r2']);  // а r2 ещё актуально
  const veryLate = appt({ booked_at: START - 1 * HOUR });
  assert.deepEqual(plan([veryLate], [], START - 30 * 60000), []);
});

test('после простоя крона уходит только самое позднее напоминание, а не «пачка»', () => {
  assert.deepEqual(kinds(plan([appt()], [], START - 1 * HOUR)), ['1:r2']);
});

test('после начала визита напоминаний «до» нет', () => {
  assert.deepEqual(plan([appt()], [], START + 60000, { reviewUrl: null }), []);
});

test('неудачная отправка повторяется не больше MAX_ATTEMPTS раз', () => {
  const failed = (n) => [{ appointment_id: 1, kind: 'r24', status: 'failed', attempts: n }];
  assert.deepEqual(kinds(plan([appt()], failed(1), START - 23 * HOUR)), ['1:r24']);
  assert.deepEqual(kinds(plan([appt()], failed(MAX_ATTEMPTS - 1), START - 23 * HOUR)), ['1:r24']);
  assert.deepEqual(plan([appt()], failed(MAX_ATTEMPTS), START - 23 * HOUR), []);
});

test('отзыв: один раз, после визита + задержка, только по подтверждённым и только со ссылкой', () => {
  const after = END + 120 * 60000;
  assert.deepEqual(plan([appt()], [], after - 1), []);
  assert.deepEqual(kinds(plan([appt()], [], after)), ['1:review']);
  assert.deepEqual(plan([appt()], [{ appointment_id: 1, kind: 'review', status: 'sent', attempts: 1 }], after + HOUR), []);
  assert.deepEqual(plan([appt({ status: 'pending' })], [], after + HOUR), []);
  assert.deepEqual(plan([appt()], [], after + HOUR, { reviewUrl: null }), []);
  assert.deepEqual(plan([appt()], [], END + 49 * HOUR), []);                      // слишком поздно просить
});

test('несколько записей планируются независимо', () => {
  const a = appt({ id: 1 }), b = appt({ id: 2, start_ts: START + HOUR, end_ts: END + HOUR, booked_at: START - 72 * HOUR });
  const r = plan([a, b], [{ appointment_id: 1, kind: 'r24', status: 'sent', attempts: 1 }], START - 23 * HOUR);
  assert.deepEqual(kinds(r), ['2:r24']);   // у первой уже отправлено, у второй наступило
});

test('напоминания выключены или неизвестные настройки', () => {
  assert.deepEqual(plan([appt()], [], START - 23 * HOUR, { enabled: false }), []);
  assert.deepEqual(planReminders([appt()], [], START - 23 * HOUR, null), []);
});

test('сутки перехода на зимнее время: «за 24 часа» — это 24 абсолютных часа, не 24 по часам на стене', () => {
  const visit = Date.UTC(2026, 9, 25, 9, 0);             // 25.10.2026 11:00 Киев (+2)
  const a = appt({ start_ts: visit, end_ts: visit + 3600000, booked_at: visit - 100 * HOUR });
  assert.deepEqual(plan([a], [], visit - 24 * HOUR - 1, { reviewUrl: null }), []);
  assert.deepEqual(kinds(plan([a], [], visit - 24 * HOUR, { reviewUrl: null })), ['1:r24']);
});

test('tickWindow охватывает самое раннее напоминание и просьбу об отзыве', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const w = tickWindow(now, { beforeHours: [24, 2] });
  assert.ok(w.to >= now + 24 * HOUR);
  assert.ok(w.from <= now - 48 * HOUR);
});
