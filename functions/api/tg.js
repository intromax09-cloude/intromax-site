/**
 * POST /api/tg — вебхук Telegram-бота Intromax (реєструється автоматично з /api/tick).
 * Єдине завдання: коли клієнт натискає Start за посиланням t.me/<бот>?start=r_<код>,
 * привʼязати його чат до нагадування про дзвінок. Інші повідомлення отримують коротку відповідь.
 * Перевірка справжності: заголовок X-Telegram-Bot-Api-Secret-Token (секрет виводиться з токена).
 */
import { webhookSecret, send, escapeHtml } from '../_lib/rem.js';

const SITE = 'https://intromax.com.ua';

export async function onRequestPost({ request, env }) {
  if (!env.TG_TOKEN || !env.REM) return new Response('Not configured', { status: 500 });
  const expected = await webhookSecret(env);
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== expected) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try { update = await request.json(); } catch (e) { return new Response('Bad request', { status: 400 }); }
  const msg = update && update.message;
  const text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
  const chat = msg && msg.chat && msg.chat.id;
  if (!chat) return ok();

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

function ok() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
