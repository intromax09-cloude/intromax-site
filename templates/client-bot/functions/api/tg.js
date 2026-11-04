/**
 * POST /api/tg — вебхук Telegram-бота записи. Логика в src/webhook.js.
 * Переменные окружения: TG_TOKEN, WEBHOOK_SECRET (Secrets), привязка D1 с именем DB, TG_CHAT_ID (необязательно).
 */
import { handleWebhook } from '../../src/webhook.js';
import { getConfig, makeTg, respondConfigError } from '../_lib/runtime.js';

export async function onRequest({ request, env }) {
  let cfg;
  try { cfg = getConfig(); } catch (e) { return respondConfigError(e); }
  return handleWebhook({ request, env, cfg, tg: makeTg(env.TG_TOKEN, undefined, env.TG_API_BASE), now: () => Date.now() });
}
