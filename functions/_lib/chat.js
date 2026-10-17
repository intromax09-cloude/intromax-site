/**
 * Живий чат із сайту. Гість натискає «покликати людину» в чаті першого екрана й пише;
 * кожне повідомлення приходить нам у Telegram (той самий бот і робочий чат, що й заявки),
 * а наша відповідь із Telegram зʼявляється в гостя на сайті. Стан — у базі D1 (привʼязка DB):
 *   chat — один рядок на розмову: sid гостя, чи взяли ми її (ack), чи закрита, лічильник пінгів;
 *   msg  — повідомлення: dir 'in' від гостя, 'out' від нас;
 *   tgm  — наші повідомлення в Telegram → sid (щоб reply на картку потрапляв у потрібний чат, і щоб прибрати пінги).
 * Поки ми не взяли чат, сайт опитує сервер, а сервер нагадує нам у Telegram за планом PING_PLAN;
 * щойно гість пішов зі сторінки, опитування припиняється, і нагадування теж.
 */
import { tg, escapeHtml, kyivTime } from './rem.js';

export const MAX_TEXT = 1000;
/* секунд між нагадуваннями: перші пʼять хвилин щохвилини, далі кожні три хвилини, усього ≈ 30 хв */
export const PING_PLAN = [60, 60, 60, 60, 60, 180, 180, 180, 180, 180, 180, 180, 180];
export const GONE_MS = 3 * 60 * 1000;        // гість не опитував чат 3 хв — пішов зі сторінки
export const KEEP_MS = 30 * 86400 * 1000;    // листування зберігаємо 30 днів (політика конфіденційності)
export const SID_RE = /^[a-z0-9]{12,32}$/;

export function code(sid) { return '#' + sid.slice(-6); }

export function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function getChat(db, sid) {
  return db.prepare('SELECT * FROM chat WHERE sid=?').bind(sid).first();
}

export async function findBySid(db, mid) {
  const r = await db.prepare('SELECT sid FROM tgm WHERE mid=?').bind(mid).first();
  return r ? r.sid : '';
}

export async function remember(db, mid, sid, kind) {
  if (!mid) return;
  await db.prepare('INSERT OR REPLACE INTO tgm (mid, sid, kind) VALUES (?, ?, ?)').bind(mid, sid, kind).run();
}

export function keyboardFor(chat) {
  if (chat.closed) return { inline_keyboard: [] };
  if (chat.ack) return { inline_keyboard: [[{ text: '✖️ Закрити чат', callback_data: 'close:' + chat.sid }]] };
  return { inline_keyboard: [[
    { text: '✅ Беру', callback_data: 'ack:' + chat.sid },
    { text: '✖️ Закрити', callback_data: 'close:' + chat.sid }
  ]] };
}

async function post(env, body) {
  const r = await tg(env, 'sendMessage', Object.assign({
    chat_id: env.TG_CHAT_ID, parse_mode: 'HTML', disable_web_page_preview: true
  }, body));
  return r && r.ok && r.result ? r.result.message_id : 0;
}

/* перше повідомлення гостя: картка з кнопками. Повертає message_id картки */
export async function notifyHead(env, db, chat, text) {
  const where = [];
  if (chat.page) where.push('Сторінка: ' + escapeHtml(chat.page));
  if (chat.niche) where.push('Ніша: ' + escapeHtml(chat.niche));
  where.push(kyivTime(Date.now()) + ' за Києвом');
  const mid = await post(env, {
    text: '💬 <b>Гість на сайті кличе людину</b> · ' + code(chat.sid) +
      '\n«' + escapeHtml(text) + '»' +
      '\n<i>' + where.join(' · ') + '</i>' +
      '\n\nВідповідайте reply на це повідомлення: гість побачить відповідь у чаті на сайті. Якщо відкритий чат один, можна просто наступним повідомленням. /close — завершити.',
    reply_markup: keyboardFor(chat)
  });
  await remember(db, mid, chat.sid, 'head');
  return mid;
}

/* наступні повідомлення гостя: відповіддю на картку, щоб трималися купи */
export async function notifyMore(env, db, chat, text) {
  const mid = await post(env, {
    text: '💬 ' + code(chat.sid) + ': ' + escapeHtml(text),
    reply_parameters: chat.head ? { message_id: chat.head, allow_sending_without_reply: true } : undefined
  });
  await remember(db, mid, chat.sid, 'msg');
  return mid;
}

/* нагадування, поки чат не взято. Після останнього — одне повідомлення, що більше не турбуємо */
export async function ping(env, db, chat, n, now) {
  const waited = Math.max(1, Math.round((now - chat.created) / 60000));
  const last = await db.prepare("SELECT text FROM msg WHERE sid=? AND dir='in' ORDER BY id DESC LIMIT 1").bind(chat.sid).first();
  let mid;
  if (n < PING_PLAN.length) {
    mid = await post(env, {
      text: '⏳ Гість чекає на сайті вже ' + waited + ' хв · ' + code(chat.sid) + (last ? '\n«' + escapeHtml(last.text) + '»' : ''),
      reply_parameters: chat.head ? { message_id: chat.head, allow_sending_without_reply: true } : undefined,
      reply_markup: keyboardFor(chat)
    });
    await remember(db, mid, chat.sid, 'ping');
  } else {
    mid = await post(env, {
      text: '🔕 Гість ' + code(chat.sid) + ' чекав ' + waited + ' хв, більше не нагадую. Відповідь він побачить, коли повернеться на сайт.',
      reply_parameters: chat.head ? { message_id: chat.head, allow_sending_without_reply: true } : undefined
    });
    await remember(db, mid, chat.sid, 'ping');
  }
  return mid;
}

export async function clearPings(env, db, sid) {
  const r = await db.prepare("SELECT mid FROM tgm WHERE sid=? AND kind='ping'").bind(sid).all();
  for (const row of (r && r.results) || []) {
    await tg(env, 'deleteMessage', { chat_id: env.TG_CHAT_ID, message_id: row.mid });
  }
  await db.prepare("DELETE FROM tgm WHERE sid=? AND kind='ping'").bind(sid).run();
}

/* ми взяли чат: пінги прибрати, на картці лишити тільки «закрити» */
export async function acked(env, db, chat) {
  if (!chat.ack) {
    await db.prepare('UPDATE chat SET ack=1 WHERE sid=?').bind(chat.sid).run();
    chat.ack = 1;
  }
  await clearPings(env, db, chat.sid);
  if (chat.head) await tg(env, 'editMessageReplyMarkup', { chat_id: env.TG_CHAT_ID, message_id: chat.head, reply_markup: keyboardFor(chat) });
}

export async function closeChat(env, db, chat) {
  await db.prepare('UPDATE chat SET closed=1, ack=1 WHERE sid=?').bind(chat.sid).run();
  chat.closed = 1; chat.ack = 1;
  await clearPings(env, db, chat.sid);
  if (chat.head) await tg(env, 'editMessageReplyMarkup', { chat_id: env.TG_CHAT_ID, message_id: chat.head, reply_markup: keyboardFor(chat) });
}

/* наша відповідь гостю */
export async function reply(db, chat, text, now) {
  await db.prepare("INSERT INTO msg (sid, dir, text, ts) VALUES (?, 'out', ?, ?)").bind(chat.sid, text, now).run();
}

/* старі розмови прибираємо: 30 днів із останньої активності */
export async function purge(db, now) {
  const before = now - KEEP_MS;
  await db.prepare('DELETE FROM msg WHERE sid IN (SELECT sid FROM chat WHERE seen < ?)').bind(before).run();
  await db.prepare('DELETE FROM tgm WHERE sid IN (SELECT sid FROM chat WHERE seen < ?)').bind(before).run();
  await db.prepare('DELETE FROM chat WHERE seen < ?').bind(before).run();
}
