/**
 * Обработчик вебхука Telegram на стандартных Request/Response (работает и в Cloudflare, и в Node).
 * Порядок: проверка конфигурации → секрет вебхука → размер и JSON → бот.
 * Всегда отвечаем 200 на принятый update, даже если обработка упала: иначе Telegram будет слать его повторно.
 */
import { createBot } from './bot.js';
import { safeEqual } from './telegram.js';

const MAX_BODY = 64 * 1024;

const text = (body, status) => new Response(body, { status });

export async function handleWebhook({ request, env, cfg, tg, now, log }) {
  if (request.method !== 'POST') return text('Method not allowed', 405);
  if (!env.TG_TOKEN || !env.WEBHOOK_SECRET || !env.DB) return text('Not configured', 500);

  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!(await safeEqual(got, env.WEBHOOK_SECRET))) return text('Forbidden', 403);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return text('Too large', 413);
  let update;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY) return text('Too large', 413);
    update = JSON.parse(body);
  } catch (e) {
    return text('Bad request', 400);
  }
  if (!update || typeof update !== 'object') return text('Bad request', 400);

  const ownerExtra = env.TG_CHAT_ID ? String(env.TG_CHAT_ID).split(',').map((x) => Number(x.trim())).filter(Boolean) : [];
  const bot = createBot({ cfg, db: env.DB, tg, now, ownerExtra, log });
  await bot.handleUpdate(update);
  return text('ok', 200);
}
