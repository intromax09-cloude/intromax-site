/**
 * GET /api/tick — годинник нагадувань. Викликається кожні 5 хвилин крон-воркером Cloudflare
 * (воркер «intromax-tick», cron «*／5 * * * *», увесь його код:
 *   export default { scheduled(){ return fetch('https://intromax.com.ua/api/tick'); } }
 * ).
 * Що робить: один раз на тиждень переконується, що вебхук бота зареєстровано; перебирає
 * нагадування rem:* у KV; ті, до яких лишилась година або менше, надсилає клієнту (якщо він
 * натиснув Start у боті) і нам у робочий чат, після чого видаляє. Без ключа: виклик нічого
 * не змінює, крім надсилання вже належних нагадувань, тому зловживати ним нема чим.
 */
import { webhookSecret, send, escapeHtml, dueAt, minutesLeft, kyivTime, STALE_MS } from '../_lib/rem.js';
import { tg } from '../_lib/rem.js';

export async function onRequestGet({ request, env }) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID || !env.REM) return new Response('Not configured', { status: 500 });
  const now = Date.now();
  const out = { webhook: 'ok', checked: 0, sent: 0, dropped: 0 };

  if (!(await env.REM.get('tg:webhook'))) {
    const origin = new URL(request.url).origin;
    const r = await tg(env, 'setWebhook', {
      url: origin + '/api/tg',
      secret_token: await webhookSecret(env),
      allowed_updates: ['message'],
      drop_pending_updates: true
    });
    out.webhook = r && r.ok ? 'set' : 'failed';
    if (r && r.ok) await env.REM.put('tg:webhook', origin, { expirationTtl: 7 * 86400 });
  }

  const list = await env.REM.list({ prefix: 'rem:', limit: 1000 });
  for (const k of list.keys) {
    const raw = await env.REM.get(k.name);
    if (!raw) continue;
    let rem;
    try { rem = JSON.parse(raw); } catch (e) { await env.REM.delete(k.name); continue; }
    out.checked++;
    if (rem.at + STALE_MS < now) { await env.REM.delete(k.name); out.dropped++; continue; }
    if (dueAt(rem) > now) continue;

    const left = minutesLeft(rem, now);
    const when = left >= 55 ? 'за годину' : (left > 0 ? 'за ' + left + ' хв' : 'вже зараз');
    if (rem.chat) {
      await send(env, rem.chat, '🔔 Нагадування: дзвінок з Intromax ' + when + ', о <b>' + kyivTime(rem.at) + '</b> за Києвом.\nЯкщо плани змінились, напишіть нам: @Intromax_tech');
    }
    await send(env, env.TG_CHAT_ID, '🔔 Дзвінок ' + when + ': <b>' + escapeHtml(rem.label) + '</b>' +
      '\nКонтакт: ' + escapeHtml(rem.contact || '—') +
      (rem.niche ? '\nНіша: ' + escapeHtml(rem.niche) : '') +
      (rem.topic ? '\nЩо цікавить: ' + escapeHtml(rem.topic) : '') +
      '\nКлієнт нагадування ' + (rem.chat ? 'отримав у Telegram' : 'не вмикав'));
    await env.REM.delete(k.name);
    out.sent++;
  }

  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
