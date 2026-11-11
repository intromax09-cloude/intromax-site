/**
 * Крон-воркер: раз в 5 минут дёргает /api/tick бота (напоминания, проверка сайта клиента, отчёт 1-го числа). Pages Functions сами по расписанию не запускаются,
 * поэтому нужен этот крошечный отдельный воркер (как «intromax-tick» у основного сайта).
 * Переменные: TICK_URL (https://<проект>.pages.dev/api/tick) и секрет TICK_SECRET — тот же, что у Pages.
 */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(env.TICK_URL, { method: 'POST', headers: { 'X-Tick-Secret': env.TICK_SECRET } }).then((r) => {
      if (!r.ok) console.error('tick failed', r.status);
    }));
  }
};
