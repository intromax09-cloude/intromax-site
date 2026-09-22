/**
 * POST /api/review — відгуки з модалки «Залишити відгук».
 * Форма шле звичайний form-urlencoded (той самий формат, що й раніше на Netlify).
 * Шле повідомлення в Telegram. Змінні оточення: TG_TOKEN, TG_CHAT_ID (Secret).
 */

const FIELDS = [
  ['rating',   'Оцінка'],
  ['name',     'Ім\u2019я'],
  ['contact',  'Контакт'],
  ['service',  'Що робили'],
  ['service_other', 'Що саме (Інше)'],
  ['timeline', 'За який час'],
  ['consent',  'Згода на публікацію'],
  ['text',     'Відгук']
];

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

  let get;
  const ct = request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) {
      const data = await request.json();
      get = (k) => data[k];
    } else {
      const form = await request.formData();
      get = (k) => form.get(k);
    }
  } catch (e) {
    return new Response('Bad request', { status: 400 });
  }

  // honeypot з форми
  if (get('bot-field')) return new Response('OK', { status: 200 });

  const text = clip(get('text'), 900);
  if (!text) return new Response('Empty', { status: 400 });

  const lines = ['<b>⭐ Новий відгук з сайту</b>', ''];
  for (const [key, label] of FIELDS) {
    const v = clip(get(key), 900);
    if (v) lines.push('<b>' + label + ':</b> ' + escapeHtml(v));
  }
  lines.push('');
  lines.push('<i>Опублікувати: додати об\u2019єкт першим у масив REVIEWS в index.html і задеплоїти.</i>');

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

  if (!res.ok) return new Response('Telegram error', { status: 502 });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
