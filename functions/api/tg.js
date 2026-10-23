/**
 * POST /api/tg — вебхук Telegram-бота Intromax (реєструється автоматично з /api/tick).
 * Три справи:
 *  1) наш робочий чат (TG_CHAT_ID): відповіді на картки живого чату з сайту йдуть гостю
 *     (reply на картку → той чат; без reply → єдиний відкритий), /close закриває чат;
 *  2) кнопки під картками: «Беру» зупиняє нагадування, «Закрити» завершує чат;
 *  3) чати клієнтів: Start за посиланням t.me/<бот>?start=r_<код> привʼязує чат до нагадування про дзвінок;
 *  4) AI-агент сайту: reply на картку «🤖❓ не знав відповіді» додає відповідь у його базу, /kb і /kbdel N — доповнення.
 * Перевірка справжності: заголовок X-Telegram-Bot-Api-Secret-Token (секрет виводиться з токена).
 */
import { webhookSecret, send, escapeHtml, tg } from '../_lib/rem.js';
import { getChat, findBySid, acked, closeChat, reply, code, GONE_MS } from '../_lib/chat.js';
import { teach, kbCommand } from '../_lib/ai.js';

const SITE = 'https://intromax.com.ua';

export async function onRequestPost({ request, env }) {
  if (!env.TG_TOKEN || !env.REM) return new Response('Not configured', { status: 500 });
  const expected = await webhookSecret(env);
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== expected) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try { update = await request.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }

  if (update && update.callback_query && env.DB) return onCallback(update.callback_query, env);

  const msg = update && update.message;
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
  const chat = msg && msg.chat && msg.chat.id;
  if (!chat) return ok();

  if (env.DB && env.TG_CHAT_ID && String(chat) === String(env.TG_CHAT_ID)) return onOperator(msg, text, env);

  const start = text.match(/^\/start(?:@\w+)?(?:\s+r_([a-z0-9]{6,12}))?$/i);
  if (start && start[1]) {
    const key = 'rem:' + start[1].toLowerCase();
    const raw = await env.REM.get(key);
    if (!raw) {
      await send(env, chat, 'Це посилання вже не діє: нагадування або надіслано, або дзвінок минув. Домовитись заново можна на сайті: ' + SITE + '/?bot=call');
      return ok();
    }
    const rem = JSON.parse(raw);
    rem.chat = chat;
    rem.name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ');
    const ttl = Math.max(600, Math.round((rem.at - Date.now()) / 1000) + 3 * 3600);
    await env.REM.put(key, JSON.stringify(rem), { expirationTtl: ttl });
    await send(env, chat, 'Нагадування увімкнено ✅\nДзвінок: <b>' + escapeHtml(rem.label) + '</b> за Києвом. Напишемо сюди за годину до нього.\nЯкщо плани зміняться, просто напишіть нам: @Intromax_tech');
    if (env.TG_CHAT_ID) {
      await send(env, env.TG_CHAT_ID, '🔔 Клієнт увімкнув нагадування про дзвінок\n<b>' + escapeHtml(rem.label) + '</b>\nКонтакт: ' + escapeHtml(rem.contact || '—') +
        (rem.name ? '\nTelegram: ' + escapeHtml(rem.name) : ''));
    }
    return ok();
  }

  if (start) {
    await send(env, chat, 'Привіт 👋 Це бот Intromax: він надсилає нагадування про домовлені дзвінки.\nДомовитись про дзвінок або залишити заявку можна на сайті: ' + SITE + '/?bot=call\nПитання — @Intromax_tech');
    return ok();
  }

  await send(env, chat, 'Цей бот лише нагадує про дзвінки. Напишіть нам у Telegram: @Intromax_tech');
  return ok();
}

/* кнопки під картками живого чату */
async function onCallback(cq, env) {
  const db = env.DB;
  const m = String(cq.data || '').match(/^(ack|close):([a-z0-9]{12,32})$/);
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (!m) { await answer('Невідома кнопка'); return ok(); }
  const chat = await getChat(db, m[2]);
  if (!chat) { await answer('Цей чат уже видалено'); return ok(); }
  if (m[1] === 'ack') {
    if (chat.closed) await answer('Чат уже закрито');
    else { await acked(env, db, chat); await answer('Гість бачить, що ви на звʼязку. Пишіть відповідь reply на картку.'); }
  } else {
    await closeChat(env, db, chat);
    await answer('Чат ' + code(chat.sid) + ' закрито');
  }
  return ok();
}

/* повідомлення в нашому робочому чаті: відповідь гостю на сайт */
async function onOperator(msg, text, env) {
  const db = env.DB, me = env.TG_CHAT_ID, now = Date.now();
  const replyTo = msg.reply_to_message && msg.reply_to_message.message_id;
  if (replyTo && await teach(env, db, replyTo, text, now)) return ok();
  if (text && await kbCommand(env, db, text)) return ok();
  let chat = null;
  if (replyTo) {
    const sid = await findBySid(db, replyTo);
    if (sid) chat = await getChat(db, sid);
    if (!chat) return ok(); // reply на заявку чи нагадування: не наша справа
  } else {
    const open = await db.prepare('SELECT * FROM chat WHERE closed=0 AND seen > ? ORDER BY seen DESC LIMIT 2').bind(now - 2 * 3600 * 1000).all();
    const rows = (open && open.results) || [];
    if (rows.length > 1) {
      await send(env, me, 'Відкритих чатів із сайту зараз ' + rows.length + ': відповідайте reply на картку потрібного.');
      return ok();
    }
    chat = rows[0] || null;
  }

  if (/^\/(start|help)(@\w+)?$/i.test(text)) {
    await send(env, me, 'Це робочий чат Intromax. Сюди приходять заявки з сайту, нагадування про дзвінки й повідомлення гостей із живого чату.\nВідповідь гостю: reply на його картку (або просто повідомлення, якщо відкритий чат один). /close — завершити чат.\nAI-агент сайту: reply на картку 🤖❓ додає відповідь у його базу. /kb — доповнення бази, /kbdel N — прибрати одне.');
    return ok();
  }
  if (!chat) {
    if (text && !text.startsWith('/')) await send(env, me, 'Зараз немає відкритого чату з сайту, тож це повідомлення нікуди не пішло.');
    return ok();
  }
  if (/^\/close(@\w+)?$/i.test(text)) {
    await closeChat(env, db, chat);
    await send(env, me, 'Чат ' + code(chat.sid) + ' закрито. Якщо гість напише знову, прийде нова картка.');
    return ok();
  }
  if (!text) {
    await send(env, me, 'Гостю на сайт можу передати тільки текст.');
    return ok();
  }
  if (chat.closed) {
    await send(env, me, 'Чат ' + code(chat.sid) + ' уже закрито. Гість отримає відповідь, якщо напише знову.');
    return ok();
  }

  await reply(db, chat, text.slice(0, 2000), now);
  await acked(env, db, chat);
  await tg(env, 'setMessageReaction', { chat_id: me, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
  if (now - chat.seen > GONE_MS) {
    const away = Math.round((now - chat.seen) / 60000);
    await send(env, me, 'Гість ' + code(chat.sid) + ' зараз не на сайті (не на звʼязку ' + away + ' хв). Відповідь збережено: побачить, коли повернеться. Якщо лишав контакт, краще написати йому напряму.');
  }
  return ok();
}

function ok() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
