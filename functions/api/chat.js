/**
 * /api/chat — живий чат із сайту (устрій — functions/_lib/chat.js).
 * POST {sid, text, page?, niche?} — повідомлення гостя: зберігає й надсилає нам у Telegram.
 *   Відповідь {ok, ack, closed, after}; after — курсор для опитування.
 * GET ?sid=…&after=… — опитування з сайту кожні кілька секунд: наші відповіді з id > after,
 *   стан чату; поки чат не взято, звідси ж іде нагадування нам у Telegram за планом PING_PLAN.
 *   Без sid нічого не віддає: sid знає лише браузер гостя.
 */
import { json, getChat, notifyHead, notifyMore, ping, MAX_TEXT, PING_PLAN, SID_RE } from '../_lib/chat.js';

const SEEN_EVERY = 20 * 1000;

function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; }

export async function onRequestPost({ request, env }) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID || !env.DB) return json({ error: 'Not configured' }, 500);
  let data;
  try {
    const raw = await request.text();
    if (raw.length > 6000) return json({ error: 'Too large' }, 413);
    data = JSON.parse(raw);
  } catch (e) { return json({ error: 'Bad request' }, 400); }

  const sid = String(data.sid || '');
  const text = clip(data.text, MAX_TEXT);
  if (!SID_RE.test(sid) || !text) return json({ error: 'Bad request' }, 400);
  if (data.company) return json({ ok: true }); // пастка для ботів

  const db = env.DB, now = Date.now();
  let chat = await getChat(db, sid);
  if (chat) {
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM msg WHERE sid=? AND dir='in' AND ts > ?").bind(sid, now - 60000).first();
    const total = await db.prepare("SELECT COUNT(*) AS n FROM msg WHERE sid=? AND dir='in'").bind(sid).first();
    if ((recent && recent.n >= 15) || (total && total.n >= 300)) return json({ error: 'Too many' }, 429);
    if (chat.closed) {
      /* гість повернувся після закриття: нова картка, пінги спочатку */
      await db.prepare('UPDATE chat SET closed=0, ack=0, pings=0, pinged=0, head=NULL, created=?, seen=? WHERE sid=?').bind(now, now, sid).run();
      chat = await getChat(db, sid);
    } else {
      await db.prepare('UPDATE chat SET seen=? WHERE sid=?').bind(now, sid).run();
      chat.seen = now;
    }
  } else {
    chat = { sid, created: now, seen: now, ack: 0, closed: 0, pings: 0, pinged: 0, head: null,
      page: clip(data.page, 80), niche: clip(data.niche, 60) };
    await db.prepare('INSERT INTO chat (sid, created, seen, ack, closed, pings, pinged, head, page, niche) VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?, ?)')
      .bind(sid, now, now, chat.page, chat.niche).run();
  }

  const ins = await db.prepare("INSERT INTO msg (sid, dir, text, ts) VALUES (?, 'in', ?, ?)").bind(sid, text, now).run();
  const after = ins && ins.meta && ins.meta.last_row_id ? ins.meta.last_row_id : 0;

  let delivered = true;
  if (!chat.head) {
    const mid = await notifyHead(env, db, chat, text);
    if (mid) await db.prepare('UPDATE chat SET head=?, pinged=? WHERE sid=?').bind(mid, now, sid).run();
    else delivered = false;
  } else {
    delivered = !!(await notifyMore(env, db, chat, text));
  }
  return json({ ok: true, delivered, ack: !!chat.ack, closed: !!chat.closed, after });
}

export async function onRequestGet({ request, env }) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID || !env.DB) return json({ error: 'Not configured' }, 500);
  const u = new URL(request.url);
  const sid = u.searchParams.get('sid') || '';
  const after = Math.max(0, parseInt(u.searchParams.get('after') || '0', 10) || 0);
  if (!SID_RE.test(sid)) return json({ error: 'Bad request' }, 400);

  const db = env.DB, now = Date.now();
  const chat = await getChat(db, sid);
  if (!chat) return json({ msgs: [], ack: false, closed: false, after });

  if (now - chat.seen > SEEN_EVERY) await db.prepare('UPDATE chat SET seen=? WHERE sid=?').bind(now, sid).run();

  const r = await db.prepare("SELECT id, text, ts FROM msg WHERE sid=? AND dir='out' AND id > ? ORDER BY id LIMIT 50").bind(sid, after).all();
  const msgs = (r && r.results) || [];
  let cursor = after;
  msgs.forEach((m) => { if (m.id > cursor) cursor = m.id; });

  /* чат не взято, гість досі на сторінці: нагадуємо собі за планом; гонку між двома опитуваннями
     знімає умовне оновлення pinged */
  if (!chat.ack && !chat.closed && chat.head && chat.pings <= PING_PLAN.length) {
    const gap = PING_PLAN[Math.min(chat.pings, PING_PLAN.length - 1)] * 1000;
    if (now - chat.pinged >= gap) {
      const up = await db.prepare('UPDATE chat SET pings=pings+1, pinged=? WHERE sid=? AND pinged=?').bind(now, sid, chat.pinged).run();
      if (up && up.meta && up.meta.changes) await ping(env, db, chat, chat.pings, now);
    }
  }

  return json({ msgs, ack: !!chat.ack, closed: !!chat.closed, after: cursor });
}
