/**
 * POST /api/lead  — заявки з форм послуг на сайті.
 * Тіло: {type, title, fields:[{label,value}], page}
 * Шле повідомлення в Telegram. Потрібні змінні оточення:
 *   TG_TOKEN   — токен бота від @BotFather   (тип Secret)
 *   TG_CHAT_ID — ваш chat id                 (тип Secret)
 */

const MAX_BODY = 12000;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
