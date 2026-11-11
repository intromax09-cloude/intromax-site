/**
 * Маршрутизатор бота: разбирает update Telegram и передаёт нужному обработчику.
 * Без привязки к Cloudflare: зависимости (db, tg, now) приходят снаружи.
 */
import { createCtx } from './ctx.js';
import { getSession, clearSession } from './store.js';
import { hit } from './ratelimit.js';
import * as client from './client.js';
import * as staff from './staff.js';
import * as handoff from './handoff.js';

/** Для журнала: только имя ошибки и обрезанный текст, где длинные числа (телефоны, id, токены) заменены на «#». */
export function safeError(err) {
  const msg = String((err && err.message) || '').replace(/\d{5,}/g, '#').replace(/[A-Za-z0-9_-]{30,}/g, '#').slice(0, 120);
  return (err && err.name || 'Error') + ': ' + msg;
}

const CMD = {
  start: 'start', help: 'start', cancel: 'start', скасувати: 'start', отмена: 'start',
  today: 'today', сьогодні: 'today', сегодня: 'today',
  tomorrow: 'tomorrow', завтра: 'tomorrow',
  block: 'block', блок: 'block',
  id: 'id',
  admin: 'human', operator: 'human', human: 'human', адмін: 'human', админ: 'human', оператор: 'human', людина: 'human'
};

export function createBot(opts) {
  const c = createCtx(opts);
  const log = opts.log || ((where, err) => console.error('bot error', where, safeError(err)));
  return {
    ctx: c,
    async handleUpdate(update) {
      const cq = update && update.callback_query;
      const msg = update && update.message;
      const from = (cq || msg || {}).from;
      const chat = cq ? cq.message && cq.message.chat && cq.message.chat.id : msg && msg.chat && msg.chat.id;
      if (!from || !chat) return { handled: false };
      try {
        const verdict = await hit(c.db, 'u:' + from.id, c.now(), c.cfg.limits.perMinute);
        if (verdict === 'drop') return { handled: false, limited: true };
        if (verdict === 'warn') {
          if (cq) await c.answer(cq.id, c.cfg.texts.too_many, true); else await c.send(chat, c.t('too_many'));
          return { handled: false, limited: true };
        }
        if (cq) await onCallback(c, cq);
        else await onMessage(c, msg);
        return { handled: true };
      } catch (err) {
        log(cq ? 'callback' : 'message', err);
        try {
          if (cq) await c.answer(cq.id);
          await c.send(chat, c.t('error', { phone: c.cfg.business.phone || '—' }));
        } catch (e) { /* уже всё равно */ }
        return { handled: false, error: err && err.name };
      }
    }
  };
}

function command(text) {
  const m = /^\/([^\s@]+)(?:@\w+)?(?:\s|$)/.exec(text);
  return m ? (CMD[m[1].toLowerCase()] || 'unknown') : null;
}

async function onMessage(c, msg) {
  const chatId = msg.chat.id;
  const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 1000) : '';
  const u = { chat: chatId, from: msg.from, mid: 0, cb: null };
  const cmd = command(text);

  /* группы: только команды персонала в чате, который есть в config/окружении */
  if (msg.chat.type !== 'private') {
    if (cmd === 'id') return runCommand(c, u, cmd);                 // узнать id группы для config.json
    if (!cmd && msg.reply_to_message && await handoff.relayFromStaff(c, msg)) return;   // ответ оператора клиенту
    if (c.isStaff(chatId) && (cmd === 'today' || cmd === 'tomorrow' || cmd === 'block')) return runCommand(c, u, cmd);
    return;
  }
  if (cmd && cmd !== 'human') return runCommand(c, u, cmd);
  if (!cmd && msg.reply_to_message && await handoff.relayFromStaff(c, msg)) return;   // ответ оператора клиенту

  const sess = await getSession(c.db, chatId, c.now());
  const staffChat = c.isStaff(chatId);
  const human = c.cfg.handoff.enabled && !staffChat;
  if (cmd === 'human') return human ? handoff.startHandoff(c, u, sess, null) : runCommand(c, u, 'start');
  if (msg.contact) {
    if (await client.onContact(c, u, sess, msg.contact)) return;
    return client.showMenu(c, u, false);
  }
  if (text && human && sess && sess.step === 'live') return handoff.relayFromClient(c, u, sess, text);
  if (text && human && sess && sess.step === 'human_ask') return handoff.startHandoff(c, u, sess, text, true);
  if (text && await client.onText(c, u, sess, text)) return;      // шаг имени/телефона: текст — это имя (даже «Людмила Оператор»); человек — /admin
  if (text && human && handoff.wantsHuman(text)) return handoff.startHandoff(c, u, sess, text);
  const asked = text && !staffChat ? await handoff.logUnanswered(c, u, text) : false;   // вопрос, на который нет ответа в меню
  if (sess && (sess.step === 'live' || sess.step === 'human_ask')) return;      // стикер/фото в живом чате — молча
  if (sess) { await c.send(chatId, c.t('unknown')); return; }      // посреди записи: подсказка, диалог не сбрасываем
  return client.showMenu(c, u, asked && human ? 'question' : false);
}

async function runCommand(c, u, cmd) {
  if (cmd === 'today' || cmd === 'tomorrow') return staff.showList(c, u, cmd);
  if (cmd === 'block') return staff.startBlock(c, u);
  if (cmd === 'id') return c.send(u.chat, c.t('your_id', { id: u.chat }));
  return client.showMenu(c, u);
}

async function onCallback(c, cq) {
  const data = typeof cq.data === 'string' ? cq.data.slice(0, 64) : '';
  const m = cq.message;
  const u = { chat: m.chat.id, from: cq.from, mid: m.message_id, cb: cq.id };
  const parts = data.split(':');
  const sess = await getSession(c.db, u.chat, c.now());

  switch (parts[0]) {
    case 'menu': await client.showMenu(c, u); break;
    case 'x': await client.showMenu(c, u); break;
    case 'book': await client.startBooking(c, u); break;
    case 'svc': await client.onService(c, u, sess, parts[1]); break;
    case 'mst': await client.onMaster(c, u, sess, parts[1]); break;
    case 'days': await client.onDays(c, u, sess, parseInt(parts[1], 10) || 0); break;
    case 'day': await client.onDay(c, u, sess, parts[1], cq.id); break;
    case 'slot': await client.onSlot(c, u, sess, parts[1], cq.id); break;
    case 'nm': await client.onNameKeep(c, u, sess); break;
    case 'chg': await client.onChange(c, u, sess); break;
    case 'ok': await client.onConfirm(c, u, sess, cq.id); break;
    case 'back': await client.onBack(c, u, sess); break;
    case 'my': await client.showMine(c, u); break;
    case 'ap': await client.showAppt(c, u, +parts[1]); break;
    case 'cc': await client.askCancel(c, u, +parts[1]); break;
    case 'cy': await client.doCancel(c, u, +parts[1]); break;
    case 'mv': await client.startMove(c, u, +parts[1]); break;
    case 'info': await client.showInfo(c, u); break;
    case 'prices': await client.showPrices(c, u); break;
    case 'faq': await client.showFaq(c, u, parts[1] === undefined ? null : parseInt(parts[1], 10)); break;
    case 'hp': if (c.cfg.handoff.enabled && !c.isStaff(u.chat)) await handoff.startHandoff(c, u, sess, null); break;
    case 's': await staff.onCardAction(c, u, parts[1], +parts[2]); break;
    case 'st': await runCommand(c, u, parts[1]); break;
    case 'bl': await staff.onBlock(c, u, parts, sess); break;
    default: break;
  }
  await c.answer(cq.id);          // убрать «часики» на кнопке, если никто не ответил раньше
}

