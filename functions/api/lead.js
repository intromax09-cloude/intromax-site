/**
 * POST /api/lead  — заявки з форм послуг на сайті.
 * Тіло: {type, title, fields:[{label,value}], page, call?:{date:'YYYY-MM-DD', time:'HH:MM'}}
 * Шле повідомлення в Telegram. Потрібні змінні оточення:
 *   TG_TOKEN   — токен бота від @BotFather   (тип Secret)
 *   TG_CHAT_ID — ваш chat id                 (тип Secret)
 * Якщо до проєкту привʼязано KV-простір REM і в заявці є дзвінок (call), ставить нагадування
 * і повертає {ok, code, bot}: сайт показує кнопку t.me/<bot>?start=r_<code>, щоб клієнт
 * увімкнув нагадування собі. Нам нагадування приходить у будь-якому разі (див. /api/tick).
 */
import { escapeHtml, kyivToUtc, botName, newCode } from '../_lib/rem.js';

const MAX_BODY = 12000;
const MAX_AHEAD = 60 * 86400 * 1000;

function clip(s, n) {
  s = String(s == null ? '' : s).trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export async function onRequestPost({ request, env }) {
  if (!env.TG_TOKEN || !env.TG_CHAT_ID) {
    return new Response('Not configured', { status: 500 });
  }

  let data;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return new Response('Too large', { status: 413 });
    data = JSON.parse(raw);
  } catch (e) {
    return new Response('Bad request', { status: 400 });
  }

  // пастка для ботів: живі люди це поле не бачать
  if (data.company) return new Response('OK', { status: 200 });

  const fields = Array.isArray(data.fields) ? data.fields.slice(0, 25) : [];
  if (!fields.length) return new Response('Empty', { status: 400 });

  const lines = [];
  lines.push('<b>🟠 Нова заявка з сайту</b>');
  lines.push('<b>' + escapeHtml(clip(data.title || data.type || 'Заявка', 80)) + '</b>');
  lines.push('');
  for (const f of fields) {
    lines.push('<b>' + escapeHtml(clip(f.label, 80)) + ':</b> ' + escapeHtml(clip(f.value, 900)));
  }
  lines.push('');
  lines.push('<i>' + escapeHtml(clip(data.page || '', 120)) + '</i>');

  const res = await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!res.ok) {
    return new Response('Telegram error', { status: 502 });
  }

  const out = { ok: true };
  const call = data.call;
  if (env.REM && call && /^\d{4}-\d{2}-\d{2}$/.test(call.date || '') && /^\d{2}:\d{2}$/.test(call.time || '')) {
    const at = kyivToUtc(call.date, call.time);
    const now = Date.now();
    if (at > now && at < now + MAX_AHEAD) {
      const pick = (label) => { const f = fields.find((x) => x.label === label); return f ? clip(f.value, 200) : ''; };
      const code = newCode();
      const rem = {
        at,
        label: pick('Дзвінок') || (call.date + ' ' + call.time),
        contact: pick('Контакт'),
        niche: pick('Ніша'),
        topic: pick('Що цікавить'),
        chat: 0,
        created: now
      };
      await env.REM.put('rem:' + code, JSON.stringify(rem), { expirationTtl: Math.round((at - now) / 1000) + 3 * 3600 });
      out.code = code;
      out.bot = await botName(env);
    }
  }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
