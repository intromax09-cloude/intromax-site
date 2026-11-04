/**
 * POST /api/tick — напоминания клиентам и уборка. Вызывается кроном каждые 5 минут (cron-worker/).
 * Переменные окружения: TG_TOKEN, TICK_SECRET (Secrets), привязка D1 с именем DB.
 */
import { handleTick } from '../../src/tick.js';
import { getConfig, makeTg, respondConfigError } from '../_lib/runtime.js';

export async function onRequest({ request, env }) {
  let cfg;
  try { cfg = getConfig(); } catch (e) { return respondConfigError(e); }
  return handleTick({ request, env, cfg, tg: makeTg(env.TG_TOKEN, undefined, env.TG_API_BASE), now: () => Date.now() });
}
