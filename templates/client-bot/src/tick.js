/**
 * Тик по расписанию: напоминания клиентам (за 24 ч и за 2 ч), просьба об отзыве после визита, уборка старых данных,
 * а для поддержки Intromax — проверка сайта клиента (monitor.js) и ежемесячный отчёт владельцу 1-го числа (report.js).
 * Запускается кроном (см. cron-worker/) каждые 5 минут: POST /api/tick с заголовком X-Tick-Secret.
 * Повторов нет: каждое напоминание сначала «захватывается» в reminders_log, и только потом отправляется.
 */
import { planReminders, tickWindow } from './reminders.js';
import { appointmentsForTick, logFor, claimReminder, finishReminder, purge, purgeSupport } from './store.js';
import { runMonitor } from './monitor.js';
import { runReport } from './report.js';
import { safeError } from './bot.js';
import { purgeOld } from './ratelimit.js';
import { createCtx } from './ctx.js';
import { dateLabel, hm, dateOf, relativeDay } from './format.js';
import { localDate } from './time.js';
import { raw } from './texts.js';
import { safeEqual } from './telegram.js';

/**
 * fetchImpl — для проверки сайта (по умолчанию глобальный fetch); ownerExtra — chat id владельцев из TG_CHAT_ID.
 * Блоки поддержки (сайт, отчёт, их уборка) изолированы: их сбой (например, не применена миграция 0002) не мешает напоминаниям.
 */
export async function runTick({ cfg, db, tg, now, doPurge, fetchImpl, ownerExtra }) {
  const c = createCtx({ cfg, db, tg, now: () => now, ownerExtra });
  const out = { checked: 0, sent: 0, failed: 0, purged: false };

  if (cfg.reminders.enabled) {
    const w = tickWindow(now, cfg.reminders);
    const appts = await appointmentsForTick(db, w.from, w.to);
    const log = await logFor(db, appts.map((a) => a.id));
    out.checked = appts.length;
    const byId = new Map(appts.map((a) => [a.id, a]));
    for (const job of planReminders(appts, log, now, cfg.reminders)) {
      const a = byId.get(job.id);
      if (!(await claimReminder(db, job.id, job.kind, now))) continue;     // уже захвачено/отправлено
      const r = await c.tg('sendMessage', { chat_id: a.client_id, text: reminderText(c, a, job.kind, now), parse_mode: 'HTML', disable_web_page_preview: true });
      const ok = !!(r && r.ok);
      await finishReminder(db, job.id, job.kind, ok, now);
      if (ok) out.sent++; else out.failed++;
    }
  }

  if (cfg.monitor.url) {
    try { out.site = (await runMonitor(c, fetchImpl || ((...a) => fetch(...a)), now)).state; } catch (e) { console.error('tick monitor', safeError(e)); }
  }
  try { const r = await runReport(c, now); if (r) out.report = r; } catch (e) { console.error('tick report', safeError(e)); }

  if (doPurge) {
    await purge(db, now, cfg.privacy.retentionDays);
    await purgeOld(db, now);
    try { await purgeSupport(db, now, cfg.privacy.retentionDays); } catch (e) { console.error('tick purge support', safeError(e)); }
    out.purged = true;
  }
  return out;
}

function reminderText(c, a, kind, now) {
  const cfg = c.cfg;
  if (kind === 'review') return c.t('review', { biz: cfg.business.name, url: cfg.reminders.reviewUrl });
  const date = dateOf(cfg, a.start_ts);
  const when = relativeDay(cfg, date, localDate(now, cfg.business.timezone)) || dateLabel(cfg, date);
  return c.t('reminder', { when, time: hm(cfg, a.start_ts), details: raw(c.details(a)) });
}

export async function handleTick({ request, env, cfg, tg, now, fetchImpl }) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.TG_TOKEN || !env.TICK_SECRET || !env.DB) return new Response('Not configured', { status: 500 });
  const got = request.headers.get('X-Tick-Secret') || '';
  if (!(await safeEqual(got, env.TICK_SECRET))) return new Response('Forbidden', { status: 403 });
  const t = now();
  const ownerExtra = env.TG_CHAT_ID ? String(env.TG_CHAT_ID).split(',').map((x) => Number(x.trim())).filter(Boolean) : [];
  const out = await runTick({ cfg, db: env.DB, tg, now: t, doPurge: new Date(t).getUTCMinutes() < 5, ownerExtra, fetchImpl });
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
