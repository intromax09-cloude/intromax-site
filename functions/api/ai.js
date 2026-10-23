/**
 * /api/ai — AI-агент чату першого екрана (устрій — functions/_lib/ai.js).
 * POST {sid, text, hist?, lang?, page?, niche?}
 *   → {ok:true, answer, status, action} — відповідь агента;
 *   → {ok:false, reason} — агент зараз не відповідає ('off' без ключа, 'sid' | 'ip' | 'day' | 'usd' — ліміти, 'error'),
 *     і сайт відповідає по-старому, ключовими словами.
 */
import { json, SID_RE } from '../_lib/chat.js';
import { gate, ipKey, ask, log, card, purge, kyivDay, MAX_Q } from '../_lib/ai.js';

function clip(s, n) { s = String(s == null ? '' : s).trim(); return s.length > n ? s.slice(0, n) : s; }

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, reason: 'off' });
  let data;
  try {
    const raw = await request.text();
    if (raw.length > 12000) return json({ error: 'Too large' }, 413);
    data = JSON.parse(raw);
  } catch (e) { return json({ error: 'Bad request' }, 400); }

  const sid = String(data.sid || '');
  const text = clip(data.text, MAX_Q);
  if (!SID_RE.test(sid) || !text) return json({ error: 'Bad request' }, 400);
  if (data.company) return json({ ok: false, reason: 'off' }); // пастка для ботів

  const db = env.DB, now = Date.now(), day = kyivDay(now);
  const ip = await ipKey(request);
  const why = await gate(env, db, sid, ip, now);
  if (why) return json({ ok: false, reason: why });

  const lang = /^(uk|en|ru)$/.test(data.lang) ? data.lang : 'uk';
  const ctx = { day, lang, niche: clip(data.niche, 60), hist: data.hist };
  await db.batch([
    db.prepare('INSERT INTO ai_use (day, k, n) VALUES (?, ?, 1) ON CONFLICT(day, k) DO UPDATE SET n = n + 1').bind(day, 'sid:' + sid),
    db.prepare('INSERT INTO ai_use (day, k, n) VALUES (?, ?, 1) ON CONFLICT(day, k) DO UPDATE SET n = n + 1').bind(day, 'ip:' + ip),
    db.prepare('INSERT INTO ai_use (day, k, n) VALUES (?, ?, 1) ON CONFLICT(day, k) DO UPDATE SET n = n + 1').bind(day, 'all')
  ]);

  const out = await ask(env, db, text, ctx);
  if (!out) return json({ ok: false, reason: 'error' });

  const id = await log(env, db, { ts: now, sid, q: text, a: out.answer, status: out.status, lang, page: clip(data.page, 80) });
  if (out.status === 'unknown') await card(env, db, id, text, out.answer, ctx);
  if (Math.random() < 0.05) await purge(db, now);

  return json({ ok: true, answer: out.answer, status: out.status, action: out.action });
}
