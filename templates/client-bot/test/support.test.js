/**
 * Поддержка Intromax (300 грн/мес): ежемесячный отчёт, мониторинг сайта, передача человеку с выжимкой,
 * журнал неотвеченных вопросов, исправление check-config на Windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTick, handleTick } from '../src/tick.js';
import { collectStats, reportText, reportDue, monthBounds, shiftMonth } from '../src/report.js';
import { checkSite } from '../src/monitor.js';
import { wantsHuman, isQuestion } from '../src/handoff.js';
import { maskQuestion } from '../src/store.js';
import { parseConfig, ConfigError } from '../src/config.js';
import { createCtx } from '../src/ctx.js';
import { makeTg } from '../src/telegram.js';
import { createHarness, barberRaw, rows, at, plain, OWNER, MASTER_IVAN } from './helpers/harness.js';
import { createFakeTelegram, installFetchMock } from './helpers/fake-telegram.js';

const CLIENT = 5001;
const INTROMAX = 777000;
const MIN = 60000;

function supportRaw(extra = {}) {
  const raw = barberRaw();
  raw.support = Object.assign({ chatIds: [INTROMAX], contact: '@intromax_test' }, extra.support);
  raw.monitor = Object.assign({ url: 'https://client.example', failAfter: 2 }, extra.monitor);
  if (extra.handoff) raw.handoff = extra.handoff;
  return raw;
}

/* ================================================================ отчёт */

async function seedOctober(db) {
  const appt = (created, start, status, i) => db.prepare(
    "INSERT INTO appointments (client_id, service_id, service_name, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) VALUES (?, 'cut', 'Стрижка', 'ivan', ?, ?, ?, ?, ?, ?)"
  ).bind(1000 + i, start, start + 45 * MIN, status, created, created, created).run();
  let i = 0;
  /* жовтень: 5 новых записей (одна отменена), 3 подтверждённых визита в жовтні */
  await appt(at('2026-10-01', '00:30'), at('2026-10-05', '10:00'), 'confirmed', i++);
  await appt(at('2026-10-10', '12:00'), at('2026-10-12', '10:00'), 'confirmed', i++);
  await appt(at('2026-10-20', '09:00'), at('2026-10-25', '11:00'), 'confirmed', i++);
  await appt(at('2026-10-21', '09:00'), at('2026-10-26', '11:00'), 'cancelled', i++);
  await appt(at('2026-10-31', '23:30'), at('2026-11-05', '11:00'), 'confirmed', i++);   // создана в жовтні, визит в листопаді
  /* вересень: 4 записи (одна на межі: 30.09 23:59 за Києвом — ще вересень) */
  await appt(at('2026-09-02', '10:00'), at('2026-09-03', '10:00'), 'confirmed', i++);
  await appt(at('2026-09-12', '10:00'), at('2026-09-13', '10:00'), 'confirmed', i++);
  await appt(at('2026-09-22', '10:00'), at('2026-09-23', '10:00'), 'confirmed', i++);
  await appt(at('2026-09-30', '23:59'), at('2026-10-02', '10:00'), 'pending', i++);   // визит в жовтні, но pending — не визит
  /* листопад: не попадает */
  await appt(at('2026-11-01', '00:00'), at('2026-11-06', '10:00'), 'confirmed', i++);

  const ev = (kind, ts, actor, text) => db.prepare('INSERT INTO events (ts, kind, actor, text) VALUES (?, ?, ?, ?)').bind(ts, kind, actor, text || null).run();
  await ev('moved', at('2026-10-03', '10:00'), 'client');
  await ev('moved', at('2026-10-15', '10:00'), 'staff');
  await ev('cancelled', at('2026-10-04', '10:00'), 'client');
  await ev('cancelled', at('2026-10-22', '10:00'), 'client');
  await ev('cancelled', at('2026-10-23', '10:00'), 'staff');
  await ev('cancelled', at('2026-09-23', '10:00'), 'client');           // вересень — не считается
  for (const d of ['05', '06', '07']) await ev('handoff', at('2026-10-' + d, '12:00'), 'client');
  await ev('unanswered', at('2026-10-08', '10:00'), 'client', 'Чи можна з собакою?');
  await ev('unanswered', at('2026-10-18', '10:00'), 'client', 'чи можна з собакою');
  await ev('unanswered', at('2026-10-19', '10:00'), 'client', 'Є подарункові сертифікати?');
  await ev('unanswered', at('2026-11-01', '10:00'), 'client', 'Листопадове питання');

  /* сайт: 1000 проверок в жовтні, 3 неудачные; два падения с тревогой (25 хв и 20 хв в жовтні), одно разовое без тревоги */
  const base = at('2026-10-02', '00:00');
  for (let k = 0; k < 1000; k++) await db.prepare('INSERT INTO uptime_checks (ts, ok, status, ms) VALUES (?, ?, ?, 100)').bind(base + k * 5 * MIN, k < 3 ? 0 : 1, k < 3 ? 503 : 200).run();
  await db.prepare('INSERT INTO uptime_checks (ts, ok, status, ms) VALUES (?, 0, 0, 100)').bind(at('2026-09-20', '10:00')).run();   // вересень
  const inc = (s, e, alerted) => db.prepare('INSERT INTO uptime_incidents (start_ts, end_ts, fails, alerted, last_status) VALUES (?, ?, 3, ?, 503)').bind(s, e, alerted).run();
  await inc(at('2026-10-10', '12:00'), at('2026-10-10', '12:25'), 1);
  await inc(at('2026-09-30', '23:50'), at('2026-10-01', '00:20'), 1);   // через межу місяця: у жовтні 20 хв
  await inc(at('2026-10-11', '12:00'), at('2026-10-11', '12:05'), 0);   // не дотягнуло до тревоги
}

test('отчёт: считает правильно на фикстуре (границы месяца по Києву, сравнение, отмены, вопросы, сайт)', async () => {
  const h = createHarness({ raw: supportRaw() });
  await seedOctober(h.db);
  const s = await collectStats(h.db, h.cfg, '2026-10');
  assert.equal(s.booked, 5);
  assert.equal(s.bookedPrev, 4);
  assert.equal(s.visits, 3);
  assert.equal(s.moved, 2);
  assert.equal(s.cancelled, 3);
  assert.equal(s.cancelledByClient, 2);
  assert.equal(s.cancelledByStaff, 1);
  assert.equal(s.handoffs, 3);
  assert.equal(s.unanswered, 3);
  assert.deepEqual(s.topQuestions.map((q) => q.n), [2, 1]);
  assert.match(s.topQuestions[0].q, /собакою/i);
  assert.equal(s.site.checks, 1000);
  assert.equal(s.site.ok, 997);
  assert.equal(s.site.pct, 99.7);
  assert.equal(s.site.incidents, 2);
  assert.equal(s.site.downMin, 45);

  const c = createCtx({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: () => h.clock.now });
  const text = plain(reportText(c, s));
  assert.match(text, /Звіт за жовтень 2026 — «Barber/);
  assert.match(text, /Нових записів: 5 \(вересень: 4, \+25%\)/);
  assert.match(text, /Підтверджених візитів: 3/);
  assert.match(text, /Переносів: 2 · ❌ Скасувань: 3 \(клієнтами 2, вами 1\)/);
  assert.match(text, /Передано адміністратору: 3/);
  assert.match(text, /не знав відповіді: 3/);
  assert.match(text, /«чи можна з собакою» ×2/i);
  assert.match(text, /Сайт доступний 99,7% часу · збоїв: 2, разом 45 хв/);
  assert.match(text, /Intromax · @intromax_test/);
});

test('отчёт: пустой месяц и минус к прошлому; без мониторинга строки о сайте нет', async () => {
  const raw = barberRaw();
  const h = createHarness({ raw });
  const ins = (ts, i) => h.db.prepare("INSERT INTO appointments (client_id, service_id, service_name, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) VALUES (?, 'cut', 'S', 'ivan', ?, ?, 'confirmed', 0, ?, ?)").bind(i, ts + i * MIN, ts + i * MIN + 1, ts, ts).run();
  for (let i = 0; i < 4; i++) await ins(at('2026-09-10', '10:00'), i);
  await ins(at('2026-10-10', '10:00'), 9);
  const c = createCtx({ cfg: h.cfg, db: h.db, tg: h.fake.tg });
  const text = plain(reportText(c, await collectStats(h.db, h.cfg, '2026-10')));
  assert.match(text, /Нових записів: 1 \(вересень: 4, −75%\)/);
  assert.match(text, /Питань без відповіді: 0/);
  assert.doesNotMatch(text, /Сайт/);
});

test('отчёт: границы месяца и «когда пора» по местному времени', () => {
  const cfg = parseConfig(supportRaw());
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  const [from, to] = monthBounds('2026-10', 'Europe/Kyiv');
  assert.equal(from, Date.UTC(2026, 8, 30, 21, 0));      // 1 жовтня 00:00 за Києвом (UTC+3)
  assert.equal(to, Date.UTC(2026, 9, 31, 22, 0));        // 1 листопада 00:00 (вже UTC+2)
  assert.equal(reportDue(at('2026-11-01', '09:59'), cfg), null);
  assert.equal(reportDue(at('2026-11-01', '10:00'), cfg), '2026-10');
  assert.equal(reportDue(at('2026-11-01', '23:55'), cfg), '2026-10');
  assert.equal(reportDue(at('2026-11-02', '10:00'), cfg), null);
  assert.equal(reportDue(at('2027-01-01', '10:00'), cfg), '2026-12');
});

test('отчёт: уходит 1-го числа владельцу и Intromax ровно один раз; сбой — повтор', async () => {
  const h = createHarness({ raw: supportRaw({ monitor: { url: '' } }) });
  await seedOctober(h.db);
  const tick = (d, t) => { h.setNow(d, t); return runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now }); };
  const reports = (chat) => h.fake.texts(chat).filter((x) => /Звіт за/.test(x));
  await tick('2026-11-01', '09:55');
  assert.equal(reports(OWNER).length, 0, 'раньше часа — нет');

  h.fake.failFor(OWNER); h.fake.failFor(INTROMAX);
  const r1 = await tick('2026-11-01', '10:00');
  assert.equal(r1.report, 'failed');
  h.fake.clearFailures();
  const r2 = await tick('2026-11-01', '10:05');
  assert.equal(r2.report, 'sent');
  for (const t of ['10:10', '15:00', '23:55']) await tick('2026-11-01', t);
  await Promise.all([tick('2026-11-01', '11:00'), tick('2026-11-01', '11:00')]);
  assert.equal(reports(OWNER).length, 2, 'одна неудачная попытка + одна доставка, дальше тишина');
  assert.deepEqual((await rows(h.db, 'SELECT month, status, attempts FROM reports_log')), [{ month: '2026-10', status: 'sent', attempts: 2 }]);
  assert.equal(reports(INTROMAX).length, 2);
});

test('отчёт и журнал событий из настоящих сценариев: запись, перенос клиентом и владельцем, отмены, вопрос без ответа', async () => {
  const h = createHarness({ raw: supportRaw({ monitor: { url: '' } }), now: ['2026-10-05', '09:00'] });
  await h.book(CLIENT, { date: '2026-10-06', time: '1000' });
  await h.book(5002, { date: '2026-10-06', time: '1100', master: 'petro', name: 'Петро' });
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  /* клиент переносит #1 */
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'mv:1');
  await h.press(CLIENT, 'day:2026-10-07'); await h.press(CLIENT, 'slot:1200');
  /* владелец переносит #2, потом клиент 5002 отменяет */
  await h.pressOn(OWNER, 's:mv:2', h.cardMid(OWNER, 2));
  await h.press(OWNER, 'day:2026-10-08'); await h.press(OWNER, 'slot:1500');
  await h.press(5002, 'my'); await h.press(5002, 'ap:2'); await h.press(5002, 'cc:2'); await h.press(5002, 'cy:2');
  /* владелец отменяет #1 */
  await h.pressOn(OWNER, 's:noy:1', h.cardMid(OWNER, 1));
  /* вопрос без ответа + приветствие (не вопрос) */
  await h.say(5003, 'Чи працюєте ви 31 грудня?');
  await h.say(5003, 'Привіт!');
  const ev = await rows(h.db, 'SELECT kind, actor, appointment_id FROM events ORDER BY id');
  assert.deepEqual(ev.map((e) => e.kind + ':' + e.actor + ':' + (e.appointment_id || '')), [
    'moved:client:1', 'moved:staff:2', 'cancelled:client:2', 'cancelled:staff:1', 'unanswered:client:'
  ]);
  const s = await collectStats(h.db, h.cfg, '2026-10');
  assert.equal(s.booked, 2); assert.equal(s.moved, 2); assert.equal(s.cancelled, 2); assert.equal(s.unanswered, 1);
});

/* ============================================================ мониторинг */

function siteMock(seq) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(url);
    const next = seq.length > 1 ? seq.shift() : seq[0];
    if (next === 'timeout') { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }
    if (next === 'net') throw new TypeError('fetch failed');
    const status = typeof next === 'object' ? next.status : next;
    return new Response([204, 304].includes(status) ? null : (typeof next === 'object' ? next.body : 'ok'), { status });
  };
  fn.calls = calls;
  return fn;
}

function monitorHarness(seq, extra) {
  const h = createHarness({ raw: supportRaw(extra), now: ['2026-11-03', '14:00'] });
  const site = siteMock(seq);
  const tick = (t) => { h.setNow('2026-11-03', t); return runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now, fetchImpl: site }); };
  const msgs = (chat, re) => h.fake.texts(chat).filter((x) => re.test(x));
  return { h, site, tick, msgs };
}

test('монитор: одно сообщение на падение (а не на каждую проверку) и одно на восстановление «лежал N минут»', async () => {
  const { h, site, tick, msgs } = monitorHarness([200, 503, 503, 503, 503, 503, 200, 200]);
  const states = [];
  for (const t of ['14:00', '14:05', '14:10', '14:15', '14:20', '14:25', '14:30', '14:35']) states.push((await tick(t)).site);
  assert.deepEqual(states, ['up', 'down', 'down', 'down', 'down', 'down', 'up', 'up']);
  assert.equal(site.calls.length, 8);
  assert.equal(site.calls[0], 'https://client.example');
  for (const chat of [OWNER, INTROMAX]) {
    const down = msgs(chat, /Сайт не відповідає/);
    assert.equal(down.length, 1, 'одна тревога в чат ' + chat);
    assert.match(plain(down[0]), /відповідь сервера 503\. Не працює з 14:05/);
    const up = msgs(chat, /Сайт знову працює/);
    assert.equal(up.length, 1);
    assert.match(plain(up[0]), /Не працював ≈ 25 хв \(з 14:05\)/);
  }
  assert.equal(msgs(MASTER_IVAN, /Сайт/).length, 0, 'мастерам не шлём');
  assert.equal((await rows(h.db, 'SELECT COUNT(*) AS n FROM uptime_checks'))[0].n, 8);
  assert.deepEqual(await rows(h.db, 'SELECT start_ts, end_ts, alerted FROM uptime_incidents'), [{ start_ts: at('2026-11-03', '14:05'), end_ts: at('2026-11-03', '14:30'), alerted: 1 }]);
});

test('монитор: разовый сбой (меньше failAfter) — без сообщений и без падения в истории; второе падение — снова одна тревога', async () => {
  const { h, tick, msgs } = monitorHarness([200, 'net', 200, 'timeout', 'timeout', 200]);
  for (const t of ['14:00', '14:05', '14:10']) await tick(t);
  assert.equal(h.fake.calls.length, 0);
  assert.equal((await rows(h.db, 'SELECT COUNT(*) AS n FROM uptime_incidents'))[0].n, 0);
  for (const t of ['14:15', '14:20', '14:25']) await tick(t);
  assert.equal(msgs(OWNER, /Сайт не відповідає/).length, 1);
  assert.match(plain(msgs(OWNER, /Сайт не відповідає/)[0]), /немає відповіді 10 с/);
  assert.equal(msgs(OWNER, /знову працює/).length, 1);
});

test('монитор: параллельные тики не дублируют тревогу; notifyOwner=false — только Intromax; expectText ловит «пустую» страницу', async () => {
  const { h, tick, msgs } = monitorHarness([{ status: 200, body: '<h1>Hosting suspended</h1>' }], { monitor: { expectText: 'Barber', notifyOwner: false, failAfter: 1 } });
  await Promise.all([tick('14:00'), tick('14:00'), tick('14:00')]);
  await tick('14:05');
  assert.equal(msgs(INTROMAX, /Сайт не відповідає/).length, 1);
  assert.match(plain(msgs(INTROMAX, /Сайт не відповідає/)[0]), /без потрібного вмісту/);
  assert.equal(msgs(OWNER, /Сайт/).length, 0);
  assert.equal((await rows(h.db, 'SELECT COUNT(*) AS n FROM uptime_incidents WHERE end_ts IS NULL'))[0].n, 1);
});

test('монитор: checkSite — 3xx после редиректа и 2xx это «работает», 5xx/сеть/таймаут — нет', async () => {
  const mon = { url: 'https://x.example', timeoutSec: 5, expectText: null };
  assert.equal((await checkSite(siteMock([200]), mon)).ok, true);
  assert.equal((await checkSite(siteMock([304]), mon)).ok, true);
  assert.deepEqual(await checkSite(siteMock([500]), mon, () => 0), { ok: false, status: 500, ms: 0, reason: 'http' });
  assert.equal((await checkSite(siteMock(['net']), mon)).reason, 'network');
  assert.equal((await checkSite(siteMock(['timeout']), mon)).reason, 'timeout');
});

test('монитор через /api/tick: TG_CHAT_ID тоже получает тревогу; в сеть кроме сайта и Telegram не ходим', async () => {
  const h = createHarness({ raw: supportRaw({ support: { chatIds: [] }, monitor: { failAfter: 1 } }) });
  h.cfg.owner.chatIds.length = 0;
  const fake = createFakeTelegram();
  const net = installFetchMock(fake);
  const env = { TG_TOKEN: 'TEST_TOKEN_NOT_REAL', TICK_SECRET: 'tick_secret_for_tests_123456', DB: h.db, TG_CHAT_ID: '424242' };
  try {
    const res = await handleTick({
      request: new Request('https://bot.example/api/tick', { method: 'POST', headers: { 'X-Tick-Secret': env.TICK_SECRET } }),
      env, cfg: h.cfg, tg: makeTg(env.TG_TOKEN), now: () => at('2026-11-03', '12:00'), fetchImpl: siteMock([502])
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).site, 'down');
    assert.equal(fake.sent(424242).length, 1);
    assert.deepEqual(net.outside, []);
  } finally { net.restore(); }
});

test('без миграции 0002 тик не падает: напоминания идут, монитор и отчёт пишут обезличенную ошибку', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const h = createHarness({ raw: supportRaw() });
    for (const t of ['events', 'uptime_checks', 'uptime_incidents', 'reports_log', 'relays']) h.db.exec('DROP TABLE ' + t);
    h.setNow('2026-11-01', '10:00');
    const out = await runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now, fetchImpl: siteMock([200]), doPurge: true });
    assert.equal(out.purged, true);
    assert.ok(errors.some((e) => /tick monitor/.test(e)));
    assert.ok(errors.some((e) => /tick report/.test(e)));
    /* отмена клиентом без таблицы events тоже работает */
    h.setNow('2026-11-02', '09:00');
    await h.book(CLIENT, { date: '2026-11-04', time: '1200' });
    await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'cc:1'); await h.press(CLIENT, 'cy:1');
    assert.match(h.lastText(CLIENT), /Запис скасовано/);
  } finally { console.error = orig; }
});

/* ======================================================= передача человеку */

test('выжимка оператору: не теряет выбранную услугу, мастера и время; «що хоче» — слова клиента', async () => {
  const h = createHarness({ raw: supportRaw() });
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:combo'); await h.press(CLIENT, 'mst:petro');
  await h.press(CLIENT, 'day:2026-11-03'); await h.press(CLIENT, 'slot:1000');
  await h.say(CLIENT, '/admin');                                   // на шаге имени: текст считается именем, поэтому команда
  assert.match(h.lastText(CLIENT), /Напишіть одним повідомленням/);
  await h.say(CLIENT, 'Чи можна прийти разом із сином 5 років?');
  let card = plain(h.lastText(OWNER));
  let lines = card.split('\n');
  assert.match(lines[0], /Клієнт просить адміністратора/);
  assert.match(lines[1], /Хоче: «Чи можна прийти разом із сином 5 років\?»/);
  assert.match(lines[2], /Вже: почав запис — Стрижка \+ борода · Петро · .*10:00, не завершив/);
  /* то же со словами в свободном тексте посреди выбора дня */
  const h2 = createHarness({ raw: supportRaw() });
  await h2.say(CLIENT, '/start'); await h2.press(CLIENT, 'book'); await h2.press(CLIENT, 'svc:beard'); await h2.press(CLIENT, 'mst:ivan');
  await h2.say(CLIENT, 'Покличте адміністратора, хочу уточнити, чи робите ви фарбування бороди');
  card = plain(h2.lastText(OWNER)); lines = card.split('\n');
  assert.match(lines[1], /Хоче: «Покличте адміністратора, хочу уточнити, чи робите ви фарбування бороди»/);
  assert.match(lines[2], /Вже: почав запис — Моделювання бороди · Іван, не завершив/);
  assert.match(card, /Тест5001/);
  assert.match(h.lastText(CLIENT), /Передав адміністратору/);
  assert.equal(h.fake.sent(INTROMAX).length, 0, 'Intromax не оператор бизнеса');
  assert.equal(h.fake.sent(MASTER_IVAN).length, 0);
  assert.equal((await rows(h.db, "SELECT COUNT(*) AS n FROM events WHERE kind='handoff'"))[0].n, 1);
});

test('кнопка «Звʼязатися з адміністратором»: недавний вопрос без ответа подставляется в выжимку; есть запись — она во второй строке', async () => {
  const h = createHarness({ raw: supportRaw() });
  await h.book(CLIENT, { date: '2026-11-03', time: '1000' });
  await h.say(CLIENT, 'Чи є у вас паркування біля салону?');
  assert.match(h.lastText(CLIENT), /не знаю відповіді/);
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'hp'));
  await h.press(CLIENT, 'hp');
  const card = plain(h.lastText(OWNER));
  assert.match(card, /Хоче: «Чи є у вас паркування біля салону\?»/);
  assert.match(card, /Вже: має запис .*10:00 · Чоловіча стрижка \(⏳ очікує підтвердження\)/);
  assert.match(card, /Олена, \+380501234567/);
});

test('кнопка без вопроса: бот спрашивает, что нужно, и передаёт ответ; в FAQ и «Контактах» кнопка есть, в главном меню — нет', async () => {
  const h = createHarness({ raw: supportRaw() });
  await h.say(CLIENT, '/start');
  assert.ok(!h.buttons(CLIENT).some((b) => b.data === 'hp'));
  await h.press(CLIENT, 'faq');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'hp'));
  await h.press(CLIENT, 'menu'); await h.press(CLIENT, 'info');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'hp'));
  await h.press(CLIENT, 'hp');
  assert.match(h.lastText(CLIENT), /Напишіть одним повідомленням/);
  assert.equal(h.fake.sent(OWNER).length, 0);
  await h.say(CLIENT, 'Хочу подарунковий сертифікат');
  assert.match(plain(h.lastText(OWNER)), /Хоче: «Хочу подарунковий сертифікат»\n🧾 Вже: нічого не обирав/);
  assert.equal((await rows(h.db, "SELECT COUNT(*) AS n FROM events WHERE kind='unanswered'"))[0].n, 0, 'ответ на «що потрібно» — не неотвеченный вопрос');
});

test('живой чат: оператор отвечает реплаем — клиент получает; клиент дописывает — оператор получает; /start выходит', async () => {
  const h = createHarness({ raw: supportRaw() });
  await h.say(CLIENT, 'оператор');
  await h.say(CLIENT, 'Хочу перенести на вечір');
  const cardMid = h.fake.sent(OWNER).at(-1).mid;
  assert.match(plain(h.fake.texts(OWNER).at(-1)), /Хоче: «Хочу перенести на вечір»/);
  await h.say(OWNER, 'Добрий день! О 18:00 підійде?', { message: { reply_to_message: { message_id: cardMid } } });
  assert.match(plain(h.lastText(CLIENT)), /Barber Kyiv Demo: Добрий день! О 18:00 підійде\?/);
  assert.match(h.lastText(OWNER), /Надіслано клієнту/);
  await h.say(CLIENT, 'Так, підійде');
  const relay = h.fake.sent(OWNER).at(-1);
  assert.match(plain(relay.body.text), /Тест5001: Так, підійде/);
  await h.say(OWNER, 'Записали ✅', { message: { reply_to_message: { message_id: relay.mid } } });
  assert.match(plain(h.lastText(CLIENT)), /Записали ✅/);
  /* реплай не на карточку — обычная обработка, клиенту ничего */
  const before = h.fake.sent(CLIENT).length;
  await h.say(OWNER, 'просто текст', { message: { reply_to_message: { message_id: 1 } } });
  assert.equal(h.fake.sent(CLIENT).length, before);
  /* чужой (не персонал) не может ответить «через карточку» */
  await h.say(6006, 'взлом', { message: { reply_to_message: { message_id: cardMid } } });
  assert.equal(h.fake.sent(CLIENT).length, before);
  await h.say(CLIENT, '/start');
  h.fake.reset();
  await h.say(CLIENT, 'Дякую!');
  assert.equal(h.fake.sent(OWNER).length, 0, 'после /start живой чат закрыт');
});

test('ответ оператора в группе персонала (реплай) тоже доходит клиенту', async () => {
  const raw = supportRaw();
  raw.owner.chatIds = [-100555];
  const h = createHarness({ raw });
  await h.say(CLIENT, 'Чи можна оплатити карткою?');
  await h.say(CLIENT, '/admin');
  const card = h.fake.sent(-100555).at(-1);
  assert.match(plain(card.body.text), /Хоче: «Чи можна оплатити карткою\?»/);
  await h.say(OWNER, 'Так, можна', { chatId: -100555, chatType: 'supergroup', message: { reply_to_message: { message_id: card.mid } } });
  assert.match(plain(h.lastText(CLIENT)), /Так, можна/);
});

test('handoff выключен: кнопки нет, слова «оператор» — вопрос без ответа; нет владельцев — клиенту телефон', async () => {
  const h = createHarness({ raw: supportRaw({ handoff: { enabled: false } }) });
  await h.say(CLIENT, 'Покличте оператора');
  assert.equal(h.fake.sent(OWNER).length, 0);
  assert.match(h.lastText(CLIENT), /Скористайтеся меню/);
  assert.ok(!h.buttons(CLIENT).some((b) => b.data === 'hp'));
  assert.equal((await rows(h.db, "SELECT COUNT(*) AS n FROM events WHERE kind='unanswered'"))[0].n, 1);

  const raw2 = supportRaw(); raw2.owner.chatIds = [];
  const h2 = createHarness({ raw: raw2 });
  const orig = console.error; console.error = () => {};
  try { await h2.say(CLIENT, 'покличте людину, будь ласка'); } finally { console.error = orig; }
  assert.match(h2.lastText(CLIENT), /Зателефонуйте, будь ласка: \+380501234567/);
});

test('неотвеченные вопросы: приветствия не пишем, телефоны маскируем, персонал не логируем', async () => {
  assert.equal(isQuestion('Привіт!'), false);
  assert.equal(isQuestion('дякую 🙏'), false);
  assert.equal(isQuestion('ок'), false);
  assert.equal(isQuestion('ціна?'), true);
  assert.equal(wantsHuman('Хочу поговорити з живою людиною'), true);
  assert.equal(wantsHuman('Скільки коштує стрижка?'), false);
  assert.equal(maskQuestion('Передзвоніть на +38 (050) 123-45-67 будь ласка'), 'Передзвоніть на … будь ласка');
  const h = createHarness({ raw: supportRaw() });
  await h.say(CLIENT, 'Мій номер 0509998877, передзвоніть щодо ціни');
  await h.say(OWNER, 'Якийсь текст власника без команди');
  const ev = await rows(h.db, 'SELECT chat_id, text FROM events');
  assert.deepEqual(ev, [{ chat_id: CLIENT, text: 'Мій номер …, передзвоніть щодо ціни' }]);
});

test('уборка: через 100 дней текст вопросов и chat id обезличиваются, счётчики остаются; старые проверки сайта удаляются', async () => {
  const h = createHarness({ raw: supportRaw() });
  await h.say(CLIENT, 'Чи є знижки для студентів?');
  await h.db.prepare('INSERT INTO uptime_checks (ts, ok, status, ms) VALUES (?, 1, 200, 50)').bind(h.clock.now).run();
  await runTick({ cfg: h.cfg, db: h.db, tg: h.fake.tg, now: h.clock.now + 101 * 86400000, doPurge: true, fetchImpl: siteMock([200]) });
  assert.deepEqual(await rows(h.db, 'SELECT kind, chat_id, text FROM events'), [{ kind: 'unanswered', chat_id: null, text: null }]);
  assert.equal((await rows(h.db, 'SELECT COUNT(*) AS n FROM uptime_checks'))[0].n, 1, 'осталась только свежая проверка из этого тика');
});

/* ================================================================ конфиг */

test('конфиг: support/monitor/handoff — значения по умолчанию и понятные ошибки', () => {
  const cfg = parseConfig(barberRaw());
  assert.deepEqual(cfg.support, { chatIds: [], contact: '', report: true, reportHour: 10 });
  assert.deepEqual(cfg.monitor, { url: '', expectText: null, failAfter: 2, timeoutSec: 10, notifyOwner: true });
  assert.deepEqual(cfg.handoff, { enabled: true });
  const raw = barberRaw();
  raw.support = { chatIds: ['123'], report: 'yes', reportHour: 25 };
  raw.monitor = { url: 'client.example', failAfter: 0, notifyOwner: 1 };
  raw.handoff = { enabled: 'no' };
  let err;
  try { parseConfig(raw); } catch (e) { err = e; }
  assert.ok(err instanceof ConfigError);
  const all = err.errors.join('\n');
  for (const p of ['support.chatIds[0]', 'support.report', 'support.reportHour', 'monitor.url', 'monitor.failAfter', 'monitor.notifyOwner', 'handoff.enabled']) assert.ok(all.includes(p), p);
});

test('npm run check-config работает и на Windows (путь из import.meta.url через fileURLToPath)', () => {
  const script = fileURLToPath(new URL('../scripts/check-config.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OK: /);
  assert.doesNotMatch(r.stdout + r.stderr, /[A-Z]:\\[A-Z]:\\/);
  assert.match(r.stdout, /передача человеку: да/);
});
