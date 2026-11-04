/**
 * Стенд для тестов бота: настоящий роутер + настоящие SQL на sqlite + эмулятор Telegram + управляемые часы.
 */
import { readFileSync } from 'node:fs';
import { parseConfig } from '../../src/config.js';
import { createBot } from '../../src/bot.js';
import { localToUtc } from '../../src/time.js';
import { createD1 } from './d1.js';
import { createFakeTelegram, messageUpdate, callbackUpdate, contactUpdate } from './fake-telegram.js';

export const plain = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const example = (name) => JSON.parse(readFileSync(new URL('../../examples/' + name + '.json', import.meta.url), 'utf8'));
export const TZ = 'Europe/Kyiv';
export const at = (date, time) => localToUtc(date, time, TZ);

export const OWNER = 900;
export const MASTER_IVAN = 901;
export const MASTER_PETRO = 902;

/** Барбершоп с владельцем и двумя мастерами, у которых есть chat id. */
export function barberRaw() {
  const raw = example('barbershop');
  raw.owner.chatIds = [OWNER];
  raw.masters.find((m) => m.id === 'ivan').chatId = MASTER_IVAN;
  raw.masters.find((m) => m.id === 'petro').chatId = MASTER_PETRO;
  return raw;
}

export function createHarness({ raw = barberRaw(), now = ['2026-11-02', '09:00'], logs } = {}) {
  const cfg = parseConfig(raw);
  const db = createD1();
  const fake = createFakeTelegram();
  const clock = { now: typeof now === 'number' ? now : at(now[0], now[1]) };
  const errors = logs || [];
  const bot = createBot({ cfg, db, tg: fake.tg, now: () => clock.now, log: (where, err) => errors.push({ where, name: err && err.name, message: err && err.message }) });
  const screens = new Map();            // chat → последнее сообщение с inline-кнопками

  const track = async (fn) => {
    const before = fake.calls.length;
    const res = await fn();
    for (const call of fake.calls.slice(before)) {
      const b = call.body;
      if ((call.method === 'sendMessage' || call.method === 'editMessageText' || call.method === 'editMessageReplyMarkup') && b.reply_markup && b.reply_markup.inline_keyboard) {
        const mid = call.method === 'sendMessage' ? call.mid : b.message_id;
        const prev = screens.get(b.chat_id);
        screens.set(b.chat_id, { mid, text: b.text !== undefined ? b.text : (prev && prev.mid === mid ? prev.text : ''), markup: b.reply_markup });
      }
    }
    return res;
  };
  const buttons = (chat) => {
    const s = screens.get(chat);
    return s ? s.markup.inline_keyboard.flat().map((x) => ({ text: x.text, data: x.callback_data })) : [];
  };
  const h = {
    cfg, db, fake, bot, clock, errors, screens, buttons,
    advance: (ms) => { clock.now += ms; },
    setNow: (date, time) => { clock.now = at(date, time); },
    say: (user, text, extra) => track(() => bot.handleUpdate(messageUpdate(user, text, extra))),
    share: (user, phone, contactUserId) => track(() => bot.handleUpdate(contactUpdate(user, phone, contactUserId))),
    /** Нажать кнопку на последнем экране чата (по точному data или по regexp на подпись/data). */
    press: (user, match, extra = {}) => {
      const chat = extra.chatId || user;
      const s = screens.get(chat);
      const btn = buttons(chat).find((b) => (match instanceof RegExp ? match.test(b.text) || match.test(b.data) : b.data === match));
      if (!btn && extra.mid === undefined) throw new Error('Нет кнопки ' + match + ' на экране чата ' + chat + '. Есть: ' + buttons(chat).map((b) => b.data).join(', '));
      return track(() => bot.handleUpdate(callbackUpdate(user, btn ? btn.data : match, extra.mid || s.mid, extra)));
    },
    /** Нажать callback с заданным data на конкретном сообщении (например, на карточке заявки). */
    pressOn: (user, data, mid, extra) => track(() => bot.handleUpdate(callbackUpdate(user, data, mid, extra))),
    /** message_id карточки заявки #id в чате. */
    cardMid: (chat, id) => {
      const c = fake.calls.filter((x) => x.method === 'sendMessage' && Number(x.body.chat_id) === chat && new RegExp('#' + id + '\\b').test(x.body.text) && x.body.reply_markup);
      return c.length ? c[c.length - 1].mid : 0;
    },
    /** Что пользователь видел в чате по порядку (новые сообщения И правки), без HTML-разметки. */
    texts: (chat) => fake.calls
      .filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && Number(c.body.chat_id) === Number(chat) && typeof c.body.text === 'string')
      .map((c) => plain(c.body.text)),
    lastText: (chat) => { const t = h.texts(chat); return t[t.length - 1] || ''; },
    /** Полный сценарий записи клиентом до подтверждения. */
    async book(user, { svc = 'cut', master = 'ivan', date = '2026-11-03', time = '1000', name = 'Олена', phone = '0501234567', confirm = true } = {}) {
      await h.say(user, '/start');
      await h.press(user, 'book');
      await h.press(user, 'svc:' + svc);
      if (buttons(user).some((b) => b.data.startsWith('mst:'))) await h.press(user, 'mst:' + master);
      await h.press(user, 'day:' + date);
      await h.press(user, 'slot:' + time);
      if (!buttons(user).some((b) => b.data === 'ok')) {          // новый клиент: имя и телефон; постоянный — сразу итог
        await h.say(user, name);
        await h.say(user, phone);
      }
      if (confirm) await h.press(user, 'ok');
    }
  };
  return h;
}

export async function rows(db, sql, ...params) { return (await db.prepare(sql).bind(...params).all()).results; }
