/**
 * Контекст бота: конфиг, база, вызов Telegram, часы и общие помощники (тексты, отправка, карточки).
 * tg(method, body) → разобранный JSON ответа Telegram ({ok, result, …}) или null при сетевой ошибке.
 * В Cloudflare это fetch к Bot API (см. telegram.js), в тестах — эмулятор (test/helpers/fake-telegram.js).
 */
import { fmt, fmtPlain, raw } from './texts.js';
import { dateLabel, priceText, hm, dateOf, clientLine, usernameLine } from './format.js';
import { saveCard, cardsOf } from './store.js';

export function createCtx({ cfg, db, tg, now, ownerExtra }) {
  const ownerIds = new Set([...cfg.owner.chatIds, ...(ownerExtra || [])].map(Number).filter(Boolean));
  const c = {
    cfg, db, tg,
    now: now || (() => Date.now()),
    ownerIds,
    t: (key, vars) => fmt(cfg.texts[key], vars),
    p: (key, vars) => fmtPlain(cfg.texts[key], vars),

    /** Кто пишет: по chat id. Владелец главнее мастера. */
    roleOf(chatId) {
      if (ownerIds.has(Number(chatId))) return { role: 'owner' };
      const m = cfg.masters.find((x) => x.chatId === Number(chatId));
      return m ? { role: 'master', master: m } : { role: 'client' };
    },
    isStaff(chatId) { return c.roleOf(chatId).role !== 'client'; },
    /** Может ли этот чат управлять записью. */
    canManage(chatId, appt) {
      const r = c.roleOf(chatId);
      return r.role === 'owner' || (r.role === 'master' && r.master.id === appt.master_id);
    },
    /** Кому уходит заявка: владельцы + мастер этой записи. */
    staffChatsFor(masterId) {
      const out = new Set(ownerIds);
      const m = cfg.mastersById[masterId];
      if (m && m.chatId) out.add(m.chatId);
      return [...out];
    },

    async send(chatId, text, markup) {
      const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
      if (markup) body.reply_markup = markup;
      const r = await tg('sendMessage', body);
      return r && r.ok && r.result ? r.result.message_id : 0;
    },
    /** Правка сообщения. false — не вышло (слишком старое и т.п.). «Не изменилось» считаем успехом. */
    async edit(chatId, messageId, text, markup) {
      const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true };
      if (markup) body.reply_markup = markup;
      const r = await tg('editMessageText', body);
      return !!(r && (r.ok || /not modified/i.test(r.description || '')));
    },
    async editMarkup(chatId, messageId, markup) {
      return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup || { inline_keyboard: [] } });
    },
    /** Показать экран: правим сообщение с кнопкой, а если нельзя — присылаем новое. u = {chat, mid}. */
    async show(u, text, markup) {
      if (u.mid && await c.edit(u.chat, u.mid, text, markup)) return u.mid;
      return c.send(u.chat, text, markup);
    },
    answered: new Set(),
    async answer(cbId, text, alert) {
      if (!cbId || c.answered.has(cbId)) return null;
      c.answered.add(cbId);
      const body = { callback_query_id: cbId };
      if (text) { body.text = text; if (alert) body.show_alert = true; }
      return tg('answerCallbackQuery', body);
    },

    /** Описание записи (HTML) для клиента и для карточек. */
    details(a) {
      const cfgm = cfg.mastersById[a.master_id];
      const vars = {
        when: dateLabel(cfg, dateOf(cfg, a.start_ts)), time: hm(cfg, a.start_ts),
        service: a.service_name, price: priceText(cfg, a.price),
        master_nom: cfg.texts.master_nom, master: cfgm ? cfgm.name : cfg.texts.master_any
      };
      return c.t(a.master_id === '_' ? 'detail_no_master' : 'detail_line', vars);
    },
    statusText(a) {
      return a.status === 'confirmed' ? c.t('status_confirmed') : a.status === 'cancelled' ? c.t('staff_cancelled_note') : c.t('status_pending');
    },

    cardText(a, key) {
      return c.t(key || 'staff_card', {
        id: a.id, status: c.statusText(a), details: raw(c.details(a)),
        client: clientLine({ name: a.client_name }), phone: a.client_phone || '—',
        username: raw(usernameLine({ username: a.client_username }))
      });
    },
    cardMarkup(a) {
      if (a.status === 'cancelled') return { inline_keyboard: [] };
      const row = [];
      if (a.status === 'pending') row.push({ text: c.p('staff_ok'), callback_data: 's:ok:' + a.id });
      row.push({ text: c.p('staff_move'), callback_data: 's:mv:' + a.id });
      row.push({ text: c.p('staff_cancel'), callback_data: 's:no:' + a.id });
      return { inline_keyboard: [row] };
    },

    /** Разослать карточку владельцу/мастеру и запомнить message_id, чтобы потом обновить кнопки. */
    async notifyStaff(a, key) {
      const chats = c.staffChatsFor(a.master_id);
      if (!chats.length) console.error('нет получателей заявок: задайте owner.chatIds в config.json или TG_CHAT_ID в окружении');
      for (const chat of chats) {
        const mid = await c.send(chat, c.cardText(a, key), c.cardMarkup(a));
        await saveCard(db, a.id, chat, mid);
      }
    },
    /** Убрать кнопки со всех карточек записи (когда по ней уже есть новая карточка). */
    async stripCards(a) {
      for (const card of await cardsOf(db, a.id)) await c.editMarkup(card.chat_id, card.message_id, null);
    },
    /** Перерисовать все ранее отправленные карточки записи (после подтверждения/отмены/переноса). */
    async refreshCards(a) {
      for (const card of await cardsOf(db, a.id)) {
        await c.edit(card.chat_id, card.message_id, c.cardText(a), c.cardMarkup(a));
      }
    }
  };
  return c;
}
