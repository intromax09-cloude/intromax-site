import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick, handleTick } from '../src/tick.js';
import { makeTg } from '../src/telegram.js';
import { createHarness, rows, at, barberRaw, OWNER } from './helpers/harness.js';
import { createFakeTelegram, installFetchMock } from './helpers/fake-telegram.js';
import { HOUR } from '../src/reminders.js';

const CLIENT = 5001;
const VISIT = '2026-11-04';        // среда; запись на 12:00–12:45, «сейчас» (создание) — 2 ноября 09:00

async function bookedConfirmed(h, o) {
  await h.book(CLIENT, Object.assign({ date: VISIT, time: '1200' }, o));
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  h.fake.reset();
}
const tick = (h, date, time, extra) => { h.setNow(date, time); return runTick(Object.assign({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now }, extra)); };
const toClient = (h) => h.fake.sent(CLIENT);
const logRows = (h) => rows(h.db, 'SELECT appointment_id, kind, status, attempts FROM reminders_log ORDER BY kind');

test('напоминания: за 24 часа и за 2 часа, каждое ровно один раз', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  await tick(h, '2026-11-03', '11:55');
  assert.equal(toClient(h).length, 0, 'раньше срока ничего');

  const r1 = await tick(h, '2026-11-03', '12:00');
  assert.equal(r1.sent, 1);
  assert.match(toClient(h)[0].body.text, /Нагадуємо: ви записані завтра о 12:00/);
  assert.match(toClient(h)[0].body.text, /Чоловіча стрижка/);

  for (const t of ['12:05', '12:10', '18:00', '23:55']) await tick(h, '2026-11-03', t);
  await tick(h, VISIT, '09:55');
  assert.equal(toClient(h).length, 1, 'повторов нет');

  const r2 = await tick(h, VISIT, '10:00');
  assert.equal(r2.sent, 1);
  assert.match(toClient(h)[1].body.text, /ви записані сьогодні о 12:00/);
  for (const t of ['10:05', '11:00', '11:59']) await tick(h, VISIT, t);
  assert.equal(toClient(h).length, 2);
  assert.deepEqual((await logRows(h)).map((r) => r.kind + ':' + r.status), ['r2:sent', 'r24:sent']);
});

test('параллельные запуски тика не дублируют напоминание', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  h.setNow('2026-11-03', '12:01');
  const run = () => runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now });
  const out = await Promise.all([run(), run(), run()]);
  assert.equal(toClient(h).length, 1);
  assert.equal(out.reduce((n, o) => n + o.sent, 0), 1);
});

test('отменённая запись не получает напоминаний: отмена до срока, между напоминаниями и владельцем', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'cc:1'); await h.press(CLIENT, 'cy:1');
  h.fake.reset();
  for (const [d, t] of [['2026-11-03', '12:00'], [VISIT, '10:00'], [VISIT, '15:00']]) await tick(h, d, t);
  assert.equal(toClient(h).length, 0);
  assert.equal((await logRows(h)).length, 0);

  // отмена после первого напоминания → второго нет
  const h2 = createHarness();
  await bookedConfirmed(h2);
  await tick(h2, '2026-11-03', '12:00');
  assert.equal(h2.fake.sent(CLIENT).length, 1);
  await h2.pressOn(OWNER, 's:no:1', h2.cardMid(OWNER, 1)); await h2.pressOn(OWNER, 's:noy:1', h2.cardMid(OWNER, 1));
  h2.fake.reset();
  await tick(h2, VISIT, '10:00'); await tick(h2, VISIT, '15:00');
  assert.equal(h2.fake.sent(CLIENT).length, 0);
});

test('неподтверждённая (pending) запись тоже получает напоминание', async () => {
  const h = createHarness();
  await h.book(CLIENT, { date: VISIT, time: '1200' });
  h.fake.reset();
  await tick(h, '2026-11-03', '12:00');
  assert.equal(toClient(h).length, 1);
});

test('запись «в последний момент»: напоминания за 24 ч нет, за 2 ч — есть', async () => {
  const h = createHarness();
  h.setNow('2026-11-03', '09:00');
  await h.book(CLIENT, { date: '2026-11-03', time: '1300' });      // записались за 4 часа до визита
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  h.fake.reset();
  await tick(h, '2026-11-03', '09:30');
  assert.equal(toClient(h).length, 0);
  await tick(h, '2026-11-03', '11:00');
  assert.equal(toClient(h).length, 1);
  assert.match(toClient(h)[0].body.text, /сьогодні о 13:00/);
});

test('перенос записи сбрасывает журнал: напоминания приходят заново по новому времени', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  await tick(h, '2026-11-03', '12:00');
  assert.equal(toClient(h).length, 1);
  h.setNow('2026-11-03', '13:00');
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'mv:1'); await h.press(CLIENT, 'day:2026-11-09'); await h.press(CLIENT, 'slot:1500');
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  h.fake.reset();
  await tick(h, '2026-11-08', '14:00');                              // за 25 часов до нового визита — рано
  assert.equal(toClient(h).length, 0);
  await tick(h, '2026-11-08', '15:00');                              // ровно за 24 часа до 9 ноября 15:00
  assert.equal(toClient(h).length, 1);
  assert.match(toClient(h)[0].body.text, /завтра о 15:00/);
});

test('ошибка отправки (клиент заблокировал бота): 3 попытки на следующих тиках и стоп', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  h.fake.failFor(CLIENT);
  const attempts = [];
  for (const t of ['12:00', '12:05', '12:10', '12:15', '12:20']) {
    const r = await tick(h, '2026-11-03', t);
    attempts.push(r.failed);
  }
  assert.deepEqual(attempts, [1, 1, 1, 0, 0]);
  assert.equal(toClient(h).length, 3);
  assert.deepEqual(await logRows(h), [{ appointment_id: 1, kind: 'r24', status: 'failed', attempts: 3 }]);
});

test('временный сбой: повтор на следующем тике доставляет напоминание', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  h.fake.failFor(CLIENT, 500, 'Internal');
  await tick(h, '2026-11-03', '12:00');
  h.fake.clearFailures();
  const r = await tick(h, '2026-11-03', '12:05');
  assert.equal(r.sent, 1);
  assert.deepEqual((await logRows(h)).map((x) => x.status), ['sent']);
  await tick(h, '2026-11-03', '12:10');
  assert.equal(toClient(h).filter((c) => c.body.text.includes('Нагадуємо')).length, 2, 'одна неудачная + одна удачная попытка, дальше тишина');
});

test('просьба об отзыве: один раз после визита со ссылкой из конфигурации; без ссылки — нет', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  await tick(h, VISIT, '10:00');                                      // r2
  h.fake.reset();
  await tick(h, VISIT, '14:30');                                      // визит кончился в 12:45, +2 часа = 14:45
  assert.equal(toClient(h).length, 0);
  await tick(h, VISIT, '14:45');
  assert.equal(toClient(h).length, 1);
  assert.match(toClient(h)[0].body.text, /https:\/\/g\.page\/r\/EXAMPLE\/review/);
  await tick(h, VISIT, '15:00'); await tick(h, '2026-11-05', '10:00');
  assert.equal(toClient(h).length, 1, 'один раз');

  const raw = barberRaw(); delete raw.reminders.reviewUrl;
  const h2 = createHarness({ raw });
  await bookedConfirmed(h2);
  h2.fake.reset();
  await tick(h2, VISIT, '16:00');
  assert.equal(h2.fake.sent(CLIENT).length, 0);
});

test('отзыв не просим у отменённых и неподтверждённых', async () => {
  const h = createHarness();
  await h.book(CLIENT, { date: VISIT, time: '1200' });               // pending
  h.fake.reset();
  await tick(h, VISIT, '16:00');
  assert.equal(toClient(h).filter((c) => /відгук/.test(c.body.text)).length, 0);
});

test('напоминания можно выключить в конфигурации', async () => {
  const raw = barberRaw(); raw.reminders.enabled = false;
  const h = createHarness({ raw });
  await bookedConfirmed(h);
  const r = await tick(h, '2026-11-03', '12:00');
  assert.equal(r.sent, 0);
  assert.equal(toClient(h).length, 0);
});

test('сутки перехода на зимнее время: запись 25.10 11:00 — напоминание за 24 абсолютных часа (24.10 12:00 по Киеву)', async () => {
  const raw = barberRaw(); raw.hours.sun = { open: '10:00', close: '20:00' };   // 25.10.2026 — воскресенье
  const h = createHarness({ raw, now: ['2026-10-20', '09:00'] });
  await h.book(CLIENT, { date: '2026-10-25', time: '1100' });
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  h.fake.reset();
  // визит 25.10 11:00 (+2) = 09:00Z; 24 часа назад = 24.10 09:00Z = 12:00 по Киеву (+3)
  await tick(h, '2026-10-24', '11:55');
  assert.equal(toClient(h).length, 0);
  await tick(h, '2026-10-24', '12:00');
  assert.equal(toClient(h).length, 1);
  assert.match(toClient(h)[0].body.text, /завтра о 11:00/);
});

test('уборка: старые записи и ненужные клиенты удаляются, свежие остаются; ключи лимита чистятся', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  const old = at('2024-01-10', '10:00');
  await h.db.prepare("INSERT INTO clients (tg_id, name, phone, created_at, updated_at) VALUES (77,'Старий','+380500000000',?,?)").bind(old, old).run();
  await h.db.prepare("INSERT INTO appointments (client_id, service_id, service_name, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) VALUES (77,'cut','x','ivan',?,?, 'confirmed',?,?,?)").bind(old, old + 1000, old, old, old).run();
  await h.db.prepare("INSERT INTO reminders_log (appointment_id, kind, status, attempts, ts) VALUES (2,'r24','sent',1,?)").bind(old).run();
  const r = await tick(h, '2026-11-02', '12:00', { doPurge: true });
  assert.equal(r.purged, true);
  assert.deepEqual((await rows(h.db, 'SELECT id FROM appointments')).map((x) => x.id), [1]);
  assert.deepEqual((await rows(h.db, 'SELECT tg_id FROM clients')).map((x) => x.tg_id), [CLIENT]);
  assert.equal((await rows(h.db, 'SELECT * FROM reminders_log WHERE appointment_id=2')).length, 0);
});

test('/api/tick: только POST с верным X-Tick-Secret; без секрета в окружении не работает вовсе', async () => {
  const h = createHarness();
  await bookedConfirmed(h);
  const fake = createFakeTelegram();
  const net = installFetchMock(fake);
  const env = { TG_TOKEN: 'TEST_TOKEN_NOT_REAL', TICK_SECRET: 'tick_secret_for_tests_123456', DB: h.db };
  const call = (o = {}) => handleTick({
    request: new Request('https://bot.example/api/tick', { method: o.method || 'POST', headers: o.secret === null ? {} : { 'X-Tick-Secret': o.secret === undefined ? env.TICK_SECRET : o.secret } }),
    env: o.env || env, cfg: h.cfg, tg: makeTg(env.TG_TOKEN), now: () => at('2026-11-03', '12:01')
  });
  try {
    assert.equal((await call({ secret: null })).status, 403);
    assert.equal((await call({ secret: 'wrong' })).status, 403);
    assert.equal((await call({ method: 'GET' })).status, 405);
    assert.equal((await call({ env: { ...env, TICK_SECRET: undefined }, secret: '' })).status, 500);
    assert.equal(fake.calls.length, 0, 'без секрета ничего не отправлено');
    const ok = await call();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).sent, 1);
    assert.equal(fake.calls.filter((c) => c.method === 'sendMessage').length, 1);
    assert.deepEqual(net.outside, []);
  } finally { net.restore(); }
});
