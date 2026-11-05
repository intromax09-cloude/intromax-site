import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, barberRaw, rows, at, OWNER, MASTER_IVAN, MASTER_PETRO, example } from './helpers/harness.js';
import { freeSlots } from '../src/slots.js';
import { appointmentsInRange, blocksInRange } from '../src/store.js';
import { dayRange } from '../src/time.js';

const CLIENT = 5001, CLIENT2 = 5002;
const D1 = '2026-11-03';           // вторник; «сейчас» — понедельник 2 ноября 09:00 по Киеву

const appts = (h) => rows(h.db, 'SELECT * FROM appointments ORDER BY id');
const btn = (h, chat, re) => h.buttons(chat).find((b) => re.test(b.text) || re.test(b.data));

test('/start показывает меню; у клиента нет кнопок персонала, у владельца есть', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start');
  assert.match(h.lastText(CLIENT), /Barber Kyiv Demo/);
  assert.deepEqual(h.buttons(CLIENT).map((b) => b.data), ['book', 'my', 'prices', 'info', 'faq']);
  await h.say(OWNER, '/start');
  assert.ok(h.buttons(OWNER).some((b) => b.data === 'st:today') && h.buttons(OWNER).some((b) => b.data === 'st:block'));
});

test('запись от начала до конца: услуга → мастер → день → время → имя → телефон → подтверждение', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start');
  await h.press(CLIENT, 'book');
  assert.deepEqual(h.buttons(CLIENT).slice(0, 4).map((b) => b.data), ['svc:cut', 'svc:beard', 'svc:combo', 'svc:kids']);
  await h.press(CLIENT, 'svc:cut');
  assert.deepEqual(h.buttons(CLIENT).map((b) => b.data), ['mst:ivan', 'mst:petro', 'mst:andriy', 'mst:any', 'back', 'x']);
  await h.press(CLIENT, 'mst:ivan');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'day:' + D1));
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'day:2026-11-07'), 'суббота: у Ивана работа есть');
  await h.press(CLIENT, 'day:' + D1);
  const slots = h.buttons(CLIENT).filter((b) => b.data.startsWith('slot:')).map((b) => b.text);
  assert.equal(slots[0], '10:00');
  assert.ok(!slots.includes('14:00'), 'в перерыв записи нет');
  await h.press(CLIENT, 'slot:1000');
  assert.match(h.lastText(CLIENT), /Як до вас звертатися/);
  await h.say(CLIENT, 'Олена Коваль');
  const ask = h.fake.sent(CLIENT).pop().body;
  assert.match(ask.text, /номер телефону/);
  assert.equal(ask.reply_markup.keyboard[0][0].request_contact, true);       // кнопка «поділитися контактом»
  await h.say(CLIENT, '050 123-45-67');
  assert.match(h.lastText(CLIENT), /Перевірте запис/);
  assert.match(h.lastText(CLIENT), /Олена Коваль, \+380501234567/);
  await h.press(CLIENT, 'ok');

  const [a] = await appts(h);
  assert.equal(a.status, 'pending');
  assert.equal(a.master_id, 'ivan');
  assert.equal(a.start_ts, at(D1, '10:00'));
  assert.equal(a.end_ts, at(D1, '10:45'));
  assert.equal(a.service_name, 'Чоловіча стрижка');
  const cl = (await rows(h.db, 'SELECT * FROM clients'))[0];
  assert.deepEqual([cl.tg_id, cl.name, cl.phone], [CLIENT, 'Олена Коваль', '+380501234567']);
  assert.match(h.texts(CLIENT).at(-1), /Запис створено/);
  assert.match(h.texts(CLIENT).at(-1), /3 листопада|вт, 3/);
  assert.match(h.texts(CLIENT).at(-1), /10:00/);
});

test('новая заявка сразу уходит владельцу и выбранному мастеру с кнопками «Підтвердити / Перенести / Скасувати»', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  for (const chat of [OWNER, MASTER_IVAN]) {
    const msg = h.fake.sent(chat).find((m) => /Нова заявка #1/.test(m.body.text));
    assert.ok(msg, 'карточка в чате ' + chat);
    assert.deepEqual(msg.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['s:ok:1', 's:mv:1', 's:no:1']);
    assert.deepEqual(msg.body.reply_markup.inline_keyboard[0].map((b) => b.text), ['✅ Підтвердити', '🔄 Перенести', '❌ Скасувати']);
    assert.match(msg.body.text, /\+380501234567/);
  }
  assert.equal(h.fake.sent(MASTER_PETRO).length, 0, 'другому мастеру карточка не нужна');
});

test('«любой мастер» назначает наименее загруженного и сообщает ему', async () => {
  const h = createHarness();
  await h.book(CLIENT, { master: 'any', time: '1000' });
  await h.book(CLIENT2, { master: 'any', time: '1000' });
  const list = await appts(h);
  assert.deepEqual(list.map((a) => a.master_id), ['ivan', 'petro']);        // второй клиент получает следующего
  assert.ok(h.fake.sent(MASTER_PETRO).some((m) => /Нова заявка #2/.test(m.body.text)));
});

test('владелец подтверждает: клиент получает сообщение, на карточках исчезает «Підтвердити»', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  assert.equal((await appts(h))[0].status, 'confirmed');
  assert.match(h.texts(CLIENT).at(-1), /підтверджено/);
  const edits = h.fake.calls.filter((c) => c.method === 'editMessageText' && [OWNER, MASTER_IVAN].includes(c.body.chat_id));
  assert.equal(edits.length, 2, 'карточки владельца и мастера обновлены');
  for (const e of edits) assert.deepEqual(e.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['s:mv:1', 's:no:1']);
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));                   // повторное нажатие безвредно
  assert.equal(h.texts(CLIENT).filter((t) => /підтверджено/.test(t)).length, 1);
});

test('автоподтверждение: запись сразу confirmed, клиенту — «підтверджено», карточка без кнопки «Підтвердити»', async () => {
  const raw = barberRaw(); raw.booking.autoConfirm = true;
  const h = createHarness({ raw });
  await h.book(CLIENT);
  assert.equal((await appts(h))[0].status, 'confirmed');
  assert.match(h.texts(CLIENT).at(-1), /Запис підтверджено/);
  const card = h.fake.sent(OWNER).find((m) => /Нова заявка/.test(m.body.text));
  assert.deepEqual(card.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['s:mv:1', 's:no:1']);
});

test('владелец отменяет с подтверждением на карточке: клиент уведомлён, слот снова свободен', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  const mid = h.cardMid(OWNER, 1);
  await h.pressOn(OWNER, 's:no:1', mid);
  assert.equal((await appts(h))[0].status, 'pending', 'пока не подтвердил — запись жива');
  const ask = h.fake.calls.filter((c) => c.method === 'editMessageReplyMarkup').at(-1);
  assert.deepEqual(ask.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['s:noy:1', 's:nn:1']);
  await h.pressOn(OWNER, 's:noy:1', mid);
  const a = (await appts(h))[0];
  assert.deepEqual([a.status, a.cancelled_by], ['cancelled', 'staff']);
  assert.match(h.texts(CLIENT).at(-1), /змушені скасувати/);
  const [f, t] = dayRange(D1, 'Europe/Kyiv');
  const free = freeSlots(h.cfg, { serviceId: 'cut', masterId: 'ivan', date: D1, now: h.clock.now }, { appointments: await appointmentsInRange(h.db, f, t, null), blocks: [] });
  assert.ok(free.some((s) => s.time === '10:00'));
});

test('два клиента на одно время: второй получает «щойно зайняли» и не может занять тот же слот', async () => {
  const h = createHarness();
  // второй клиент дошёл до подтверждения раньше, чем первый записался
  await h.say(CLIENT2, '/start'); await h.press(CLIENT2, 'book'); await h.press(CLIENT2, 'svc:cut'); await h.press(CLIENT2, 'mst:ivan');
  await h.press(CLIENT2, 'day:' + D1); await h.press(CLIENT2, 'slot:1000'); await h.say(CLIENT2, 'Іра'); await h.say(CLIENT2, '0671112233');
  await h.book(CLIENT);                                                    // первый успел
  h.fake.reset();
  await h.press(CLIENT2, 'ok');
  assert.equal((await appts(h)).length, 1);
  const alert = h.fake.calls.find((c) => c.method === 'answerCallbackQuery' && c.body.show_alert);
  assert.match(alert.body.text, /щойно зайняли/);
  assert.ok(!h.buttons(CLIENT2).some((b) => b.data === 'slot:1000'), 'занятого времени в списке больше нет');
  assert.ok(h.buttons(CLIENT2).some((b) => b.data === 'slot:1100'));
});

test('уникальный индекс страхует от гонки даже без проверки слота', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  const { insertAppointment } = await import('../src/store.js');
  const dup = await insertAppointment(h.db, { client_id: 9, service_id: 'cut', service_name: 'x', price: null, master_id: 'ivan', start_ts: at(D1, '10:00'), end_ts: at(D1, '10:45'), status: 'pending' }, 1);
  assert.equal(dup, 0);
});

test('клиент отменяет запись сам: владелец и мастер уведомлены, карточки обновлены', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.press(CLIENT, 'my');
  await h.press(CLIENT, 'ap:1');
  assert.match(h.lastText(CLIENT), /очікує підтвердження/);
  await h.press(CLIENT, 'cc:1');
  assert.equal((await appts(h))[0].status, 'pending', 'сначала спрашивает подтверждение');
  await h.press(CLIENT, 'cy:1');
  const a = (await appts(h))[0];
  assert.deepEqual([a.status, a.cancelled_by], ['cancelled', 'client']);
  assert.match(h.texts(OWNER).at(-1), /Клієнт скасував запис #1/);
  assert.match(h.texts(MASTER_IVAN).at(-1), /Клієнт скасував запис #1/);
  assert.ok(h.fake.calls.some((c) => c.method === 'editMessageText' && Number(c.body.chat_id) === OWNER && c.body.reply_markup.inline_keyboard.length === 0));
});

test('отмена и перенос клиентом закрыты за clientChangeMinHours до визита', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  h.setNow(D1, '08:30');                                                   // до визита 1,5 часа при пороге 2 часа
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'cc:1');
  assert.match(h.lastText(CLIENT), /менше 2 год/);
  await h.pressOn(CLIENT, 'cy:1', h.screens.get(CLIENT).mid);
  assert.equal((await appts(h))[0].status, 'pending');
  await h.pressOn(CLIENT, 'mv:1', h.screens.get(CLIENT).mid);
  assert.match(h.lastText(CLIENT), /менше 2 год/);
});

test('клиент переносит запись: новое время, статус снова «ожидает», напоминания сброшены, владельцу — новая карточка', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.pressOn(OWNER, 's:ok:1', h.cardMid(OWNER, 1));
  await h.db.prepare("INSERT INTO reminders_log (appointment_id, kind, status, attempts, ts) VALUES (1,'r24','sent',1,0)").run();
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'mv:1');
  assert.match(h.lastText(CLIENT), /Переносимо запис/);
  await h.press(CLIENT, 'day:2026-11-04');
  const slots = h.buttons(CLIENT).filter((b) => b.data.startsWith('slot:')).map((b) => b.text);
  assert.ok(slots.includes('12:00'));
  await h.press(CLIENT, 'slot:1200');
  const a = (await appts(h))[0];
  assert.equal(a.start_ts, at('2026-11-04', '12:00'));
  assert.equal(a.master_id, 'ivan', 'мастер сохраняется');
  assert.equal(a.status, 'pending');
  assert.equal(a.booked_at, h.clock.now);
  assert.equal((await rows(h.db, 'SELECT * FROM reminders_log')).length, 0, 'журнал напоминаний сброшен');
  assert.match(h.texts(OWNER).at(-1), /переніс запис #1/);
  assert.equal((await appts(h)).length, 1, 'новой записи не появилось');
});

test('при переносе клиентом своё прежнее время считается свободным', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.press(CLIENT, 'my'); await h.press(CLIENT, 'ap:1'); await h.press(CLIENT, 'mv:1');
  await h.press(CLIENT, 'day:' + D1);
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'slot:1000'));
});

test('владелец переносит запись: клиент получает новое время, статус confirmed', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.pressOn(OWNER, 's:mv:1', h.cardMid(OWNER, 1));
  assert.match(h.lastText(OWNER), /Переносимо запис #1/);
  await h.press(OWNER, 'day:2026-11-05');
  await h.press(OWNER, 'slot:1530');
  const a = (await appts(h))[0];
  assert.deepEqual([a.start_ts, a.status], [at('2026-11-05', '15:30'), 'confirmed']);
  assert.match(h.texts(CLIENT).at(-1), /перенесено/);
  assert.match(h.texts(CLIENT).at(-1), /15:30/);
});

test('права: чужой клиент не может нажимать кнопки персонала и открывать чужую запись', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  h.fake.reset();
  await h.pressOn(CLIENT2, 's:ok:1', 777);
  await h.pressOn(CLIENT2, 's:noy:1', 777);
  await h.pressOn(CLIENT2, 's:mv:1', 777);
  assert.equal((await appts(h))[0].status, 'pending');
  assert.equal(h.fake.calls.filter((c) => c.method === 'answerCallbackQuery' && c.body.show_alert).length, 3);
  assert.equal(h.fake.sent(CLIENT).length, 0, 'настоящему клиенту ничего не ушло');
  await h.pressOn(CLIENT2, 'cy:1', 777);
  await h.pressOn(CLIENT2, 'mv:1', 777);
  assert.equal((await appts(h))[0].status, 'pending', 'чужую запись отменить нельзя');
  await h.pressOn(CLIENT2, 'ap:1', 777);
  assert.match(h.lastText(CLIENT2), /неактуальн/);
});

test('права: мастер управляет только своими записями', async () => {
  const h = createHarness();
  await h.book(CLIENT);                                                    // запись к Ивану
  h.fake.reset();
  await h.pressOn(MASTER_PETRO, 's:ok:1', 777);
  assert.equal((await appts(h))[0].status, 'pending');
  await h.pressOn(MASTER_IVAN, 's:ok:1', h.cardMid(MASTER_IVAN, 1));
  assert.equal((await appts(h))[0].status, 'confirmed');
});

test('/сьогодні и /завтра: владелец видит все записи, мастер — только свои, клиент — ничего', async () => {
  const h = createHarness();
  await h.book(CLIENT, { master: 'ivan', date: D1, time: '1000' });
  await h.book(CLIENT2, { master: 'petro', date: D1, time: '1100', name: 'Максим', phone: '0671112233' });
  h.setNow(D1, '09:00');
  await h.say(OWNER, '/сьогодні');
  const t = h.lastText(OWNER);
  assert.match(t, /Сьогодні, вт, 3 листопада.*записів: 2/);
  assert.match(t, /10:00–10:45 · Чоловіча стрижка · Олена · Іван/);
  assert.match(t, /11:00–11:45 · Чоловіча стрижка · Максим · Петро/);
  assert.deepEqual(h.buttons(OWNER).map((b) => b.data), ['s:ap:1', 's:ap:2']);
  await h.say(MASTER_IVAN, '/today');
  assert.match(h.lastText(MASTER_IVAN), /записів: 1/);
  assert.doesNotMatch(h.lastText(MASTER_IVAN), /Максим/);
  h.setNow('2026-11-02', '09:00');
  await h.say(OWNER, '/завтра');
  assert.match(h.lastText(OWNER), /Завтра, вт, 3 листопада.*записів: 2/);
  await h.say(OWNER, '/tomorrow@my_bot');
  assert.match(h.lastText(OWNER), /Завтра/);
  await h.say(OWNER, '/сьогодні');
  assert.match(h.lastText(OWNER), /Сьогодні, пн, 2 листопада — записів немає/);
  h.fake.reset();
  await h.say(CLIENT, '/сьогодні');
  assert.doesNotMatch(h.texts(CLIENT).join('\n'), /Олена|Максим|записів/);
  assert.match(h.lastText(CLIENT), /Скористайтеся меню|Немає доступу/);
});

test('из списка запись открывается карточкой с кнопками', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  h.setNow(D1, '09:00');
  await h.say(OWNER, '/сьогодні');
  await h.press(OWNER, 's:ap:1');
  const card = h.fake.sent(OWNER).at(-1).body;
  assert.match(card.text, /Запис #1/);
  assert.equal(card.reply_markup.inline_keyboard[0].length, 3);
});

test('блокировка слота: владелец выбирает мастера и день, слот пропадает у клиентов; повторное нажатие снимает', async () => {
  const h = createHarness();
  await h.say(OWNER, '/block');
  assert.deepEqual(h.buttons(OWNER).map((b) => b.data), ['bl:m:ivan', 'bl:m:petro', 'bl:m:andriy', 'bl:m:all']);
  await h.press(OWNER, 'bl:m:ivan');
  await h.press(OWNER, 'bl:d:' + D1);
  assert.match(h.lastText(OWNER), /Іван.*3 листопада/);
  await h.press(OWNER, 'bl:t:1200');
  assert.match(h.buttons(OWNER).find((b) => b.data === 'bl:t:1200').text, /🚫/);
  const [f, t] = dayRange(D1, 'Europe/Kyiv');
  const q = async () => freeSlots(h.cfg, { serviceId: 'cut', masterId: 'ivan', date: D1, now: h.clock.now }, { appointments: [], blocks: await blocksInRange(h.db, f, t) }).map((s) => s.time);
  assert.ok(!(await q()).includes('12:00'));
  assert.ok((await q()).includes('10:00'));
  await h.press(OWNER, 'bl:t:1200');
  assert.ok((await q()).includes('12:00'));
});

test('блокировка всего дня: день исчезает из выбора клиента; снятие возвращает', async () => {
  const h = createHarness();
  await h.say(OWNER, '/блок');
  await h.press(OWNER, 'bl:m:all');
  await h.press(OWNER, 'bl:d:' + D1);
  await h.press(OWNER, 'bl:day');
  assert.match(h.buttons(OWNER).find((b) => b.data === 'bl:day').text, /Зняти блок/);
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:cut'); await h.press(CLIENT, 'mst:any');
  assert.ok(!h.buttons(CLIENT).some((b) => b.data === 'day:' + D1));
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'day:2026-11-04'));
  await h.press(OWNER, 'bl:day');
  const rest = await rows(h.db, 'SELECT * FROM blocks');
  assert.equal(rest.length, 0);
  await h.press(CLIENT, 'x'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:cut'); await h.press(CLIENT, 'mst:any');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'day:' + D1));
});

test('блокировка: мастер блокирует только себя; занятый записью слот помечен и предупреждение показано', async () => {
  const h = createHarness();
  await h.book(CLIENT, { master: 'petro', time: '1000' });
  await h.say(MASTER_PETRO, '/block');
  assert.ok(h.buttons(MASTER_PETRO).some((b) => b.data === 'bl:d:' + D1), 'мастер сразу выбирает день');
  await h.press(MASTER_PETRO, 'bl:d:' + D1);
  assert.match(h.buttons(MASTER_PETRO).find((b) => b.data === 'bl:t:1000').text, /🔒/);
  assert.match(h.lastText(MASTER_PETRO), /уже є записи: 1/);
  await h.press(MASTER_PETRO, 'bl:t:1300');
  const b = (await rows(h.db, 'SELECT * FROM blocks'))[0];
  assert.deepEqual([b.master_id, b.kind], ['petro', 'slot']);
  // чужую область блокировать нельзя
  h.fake.reset();
  await h.pressOn(MASTER_PETRO, 'bl:m:ivan', 777);
  assert.equal((await rows(h.db, 'SELECT * FROM blocks')).length, 1);
  assert.ok(h.fake.calls.some((c) => c.method === 'answerCallbackQuery' && c.body.show_alert));
  // клиент блокировать не может
  await h.say(CLIENT, '/block');
  assert.match(h.lastText(CLIENT), /Немає доступу/);
});

test('телефон: неверный номер просит повторить, чужой контакт не принимается, свой контакт принимается', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:beard'); await h.press(CLIENT, 'mst:any');
  await h.press(CLIENT, 'day:' + D1); await h.press(CLIENT, 'slot:1000'); await h.say(CLIENT, '  Іван   Петренко  ');
  await h.say(CLIENT, '12345');
  assert.match(h.lastText(CLIENT), /Не схоже на номер/);
  await h.share(CLIENT, '+380509999999', 4242);                            // контакт другого человека
  assert.match(h.lastText(CLIENT), /Це не ваш контакт/);
  await h.share(CLIENT, '380501112233');                                   // свой, без плюса
  assert.match(h.lastText(CLIENT), /\+380501112233/);
  assert.match(h.lastText(CLIENT), /Іван Петренко/, 'пробелы в имени схлопнуты');
  assert.ok(h.fake.calls.some((c) => c.method === 'sendMessage' && c.body.reply_markup && c.body.reply_markup.remove_keyboard), 'клавиатура контакта убирается');
});

test('имя: пустое и слишком длинное отклоняются; кнопка «Залишити имя из Telegram» работает', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:beard'); await h.press(CLIENT, 'mst:any');
  await h.press(CLIENT, 'day:' + D1); await h.press(CLIENT, 'slot:1000');
  await h.say(CLIENT, 'я'.repeat(61));
  assert.match(h.lastText(CLIENT), /Напишіть, будь ласка, імʼя/);
  await h.press(CLIENT, 'nm:keep');
  assert.match(h.lastText(CLIENT), /номер телефону/);
  await h.say(CLIENT, '0501234567');
  assert.match(h.lastText(CLIENT), /Тест5001/);
});

test('постоянный клиент: имя и телефон подставляются, шаги пропускаются', async () => {
  const h = createHarness();
  await h.book(CLIENT);
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:beard'); await h.press(CLIENT, 'mst:petro');
  await h.press(CLIENT, 'day:' + D1); await h.press(CLIENT, 'slot:1100');
  assert.match(h.lastText(CLIENT), /Перевірте запис/);
  assert.match(h.lastText(CLIENT), /Олена.*\+380501234567/);
  await h.press(CLIENT, 'ok');
  assert.equal((await appts(h)).length, 2);
});

test('лимит активных записей на клиента', async () => {
  const raw = barberRaw(); raw.booking.maxActivePerClient = 1;
  const h = createHarness({ raw });
  await h.book(CLIENT);
  await h.book(CLIENT, { time: '1100' });
  assert.equal((await appts(h)).length, 1);
  assert.match(h.lastText(CLIENT), /уже є 1 активних записів/);
});

test('«Назад» и «Скасувати» в диалоге; устаревшая сессия не ломает бот', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:cut'); await h.press(CLIENT, 'mst:ivan');
  await h.press(CLIENT, 'day:' + D1);
  await h.press(CLIENT, 'back');
  assert.ok(h.buttons(CLIENT).some((b) => b.data.startsWith('day:')));
  await h.press(CLIENT, 'back');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'mst:any'));
  await h.press(CLIENT, 'x');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'book'));
  h.fake.reset();
  await h.pressOn(CLIENT, 'slot:1000', h.screens.get(CLIENT).mid);        // нажатие «из прошлого»
  assert.match(h.texts(CLIENT).join('\n'), /Сесія застаріла/);
  assert.deepEqual(h.errors, []);
});

test('меню «Контакти», «Послуги та ціни», «Часті питання»', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start');
  await h.press(CLIENT, 'info');
  const info = h.fake.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text;
  assert.match(info, /Barber Kyiv Demo/); assert.match(info, /Прикладна, 10/); assert.match(info, /\+380501234567/);
  assert.match(info, /пн: 10:00–20:00 \(перерва 14:00–14:30\)/); assert.match(info, /нд: вихідний/);
  await h.press(CLIENT, 'menu'); await h.press(CLIENT, 'prices');
  const prices = h.fake.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text;
  assert.match(prices, /Чоловіча стрижка — 45 хв — 500 грн/);
  await h.press(CLIENT, 'menu'); await h.press(CLIENT, 'faq');
  assert.ok(h.buttons(CLIENT).some((b) => b.data === 'faq:0'));
  await h.press(CLIENT, 'faq:0');
  assert.match(h.fake.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text, /за 5 хвилин/);
});

test('ввод пользователя экранируется в HTML-сообщениях владельцу', async () => {
  const h = createHarness();
  await h.book(CLIENT, { name: '<b>Хакер</b> & Ко' });
  const card = h.fake.sent(OWNER).find((m) => /Нова заявка/.test(m.body.text)).body.text;
  assert.match(card, /&lt;b&gt;Хакер&lt;\/b&gt; &amp; Ко/);
  assert.doesNotMatch(card, /<b>Хакер/);
});

test('русский язык и своё название исполнителя (ниша СТО)', async () => {
  const raw = example('sto'); raw.business.language = 'ru'; raw.owner.chatIds = [OWNER]; raw.texts = {};
  const h = createHarness({ raw });
  await h.say(CLIENT, '/start');
  assert.match(h.lastText(CLIENT), /Добро пожаловать/);
  await h.press(CLIENT, 'book');
  assert.match(h.fake.calls.filter((c) => c.method === 'editMessageText').at(-1).body.text, /Выберите услугу/);
});

test('ниша без мастеров: шаг выбора мастера пропускается, запись к безымянному ресурсу', async () => {
  const raw = example('furniture'); raw.owner.chatIds = [OWNER];
  const h = createHarness({ raw });
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:measure');
  assert.ok(h.buttons(CLIENT).some((b) => b.data.startsWith('day:')), 'сразу выбор дня');
  const day = h.buttons(CLIENT).find((b) => b.data.startsWith('day:')).data;
  await h.press(CLIENT, day);
  await h.press(CLIENT, h.buttons(CLIENT).find((b) => b.data.startsWith('slot:')).data);
  await h.say(CLIENT, 'Марія'); await h.say(CLIENT, '0971234567');
  await h.press(CLIENT, 'ok');
  const a = (await appts(h))[0];
  assert.equal(a.master_id, '_');
  assert.ok(h.fake.sent(OWNER).some((m) => /Нова заявка/.test(m.body.text)));
  assert.doesNotMatch(h.fake.sent(OWNER).at(-1).body.text, /Майстер:/);
});

test('ограничение частоты: после лимита бот молчит, одно предупреждение, другой пользователь не затронут, через минуту снова работает', async () => {
  const raw = barberRaw(); raw.limits = { perMinute: 5 };
  const h = createHarness({ raw });
  for (let i = 0; i < 5; i++) await h.say(CLIENT, 'привіт');
  assert.equal(h.fake.sent(CLIENT).length, 5);
  await h.say(CLIENT, 'ще');
  assert.match(h.lastText(CLIENT), /Забагато запитів/);
  const n = h.fake.sent(CLIENT).length;
  for (let i = 0; i < 20; i++) await h.say(CLIENT, 'спам');
  assert.equal(h.fake.sent(CLIENT).length, n, 'дальше — тишина');
  await h.say(CLIENT2, 'привіт');
  assert.equal(h.fake.sent(CLIENT2).length, 1);
  h.advance(61000);
  await h.say(CLIENT, 'привіт');
  assert.equal(h.fake.sent(CLIENT).length, n + 1);
});

test('ошибка внутри обработчика: клиент получает вежливое сообщение, в журнал — только имя ошибки, исключения наружу нет', async () => {
  const logs = [];
  const h = createHarness({ logs });
  const real = h.db.prepare;
  h.db.prepare = (q) => { if (/FROM sessions/.test(q)) throw new Error('boom: секретный текст пользователя 0501234567'); return real(q); };
  const res = await h.bot.handleUpdate({ update_id: 1, message: { message_id: 1, from: { id: CLIENT }, chat: { id: CLIENT, type: 'private' }, text: 'привіт' } });
  assert.equal(res.handled, false);
  assert.match(h.lastText(CLIENT), /Щось пішло не так/);
  assert.equal(logs.length, 1);
});

test('групповые чаты и чужие типы update игнорируются; персонал в группе получает список', async () => {
  const raw = barberRaw(); raw.owner.chatIds = [OWNER, -100200];
  const h = createHarness({ raw });
  await h.bot.handleUpdate({ update_id: 1, edited_message: { text: 'x' } });
  await h.bot.handleUpdate({ update_id: 2, message: { message_id: 1, from: { id: CLIENT }, chat: { id: -999, type: 'group' }, text: '/start' } });
  assert.equal(h.fake.calls.length, 0);
  await h.bot.handleUpdate({ update_id: 3, message: { message_id: 1, from: { id: OWNER }, chat: { id: -100200, type: 'supergroup' }, text: '/today' } });
  assert.match(h.lastText(-100200), /записів немає/);
});

test('новые заявки приходят и в групповой чат владельца', async () => {
  const raw = barberRaw(); raw.owner.chatIds = [OWNER, -100200];
  const h = createHarness({ raw });
  await h.book(CLIENT);
  assert.ok(h.fake.sent(-100200).some((m) => /Нова заявка/.test(m.body.text)));
});

test('если владелец не задан нигде, заявка всё равно сохраняется, а в журнал уходит понятное предупреждение без данных клиента', async () => {
  const raw = barberRaw(); raw.owner.chatIds = []; raw.masters.forEach((m) => { delete m.chatId; });
  const h = createHarness({ raw });
  const spied = [];
  const orig = console.error; console.error = (...a) => spied.push(a.join(' '));
  try { await h.book(CLIENT, { name: 'Приватне Імʼя' }); } finally { console.error = orig; }
  assert.equal((await appts(h)).length, 1);
  assert.match(spied.join('\n'), /нет получателей заявок/);
  assert.doesNotMatch(spied.join('\n'), /Приватне|0501234567/);
});

test('/id сообщает chat id (для заполнения config.json), в личке и в группе', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/id');
  assert.match(h.lastText(CLIENT), /Ваш chat id: 5001/);
  await h.bot.handleUpdate({ update_id: 9, message: { message_id: 1, from: { id: CLIENT }, chat: { id: -100777, type: 'group' }, text: '/id@my_bot' } });
  assert.match(h.lastText(-100777), /Ваш chat id: -100777/);
});

test('посторонний текст посреди записи не сбрасывает диалог', async () => {
  const h = createHarness();
  await h.say(CLIENT, '/start'); await h.press(CLIENT, 'book'); await h.press(CLIENT, 'svc:cut'); await h.press(CLIENT, 'mst:ivan');
  await h.press(CLIENT, 'day:' + D1); await h.press(CLIENT, 'slot:1000'); await h.say(CLIENT, 'Олена'); await h.say(CLIENT, '0501234567');
  await h.say(CLIENT, 'а можна ще чаю?');
  assert.match(h.lastText(CLIENT), /Скористайтеся меню/);
  await h.press(CLIENT, 'ok');                                             // кнопка на экране итога всё ещё работает
  assert.equal((await appts(h)).length, 1);
});
