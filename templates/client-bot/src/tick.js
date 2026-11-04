/**
 * Тик по расписанию: напоминания клиентам (за 24 ч и за 2 ч), просьба об отзыве после визита, уборка старых данных.
 * Запускается кроном (см. cron-worker/) каждые 5 минут: POST /api/tick с заголовком X-Tick-Secret.
 * Повторов нет: каждое напоминание сначала «захватывается» в reminders_log, и только потом отправляется.
 */
import { planReminders, tickWindow } from './reminders.js';
import { appointmentsForTick, logFor, claimReminder, finishReminder, purge } from './store.js';
import { purgeOld } from './ratelimit.js';
import { createCtx } from './ctx.js';
import { dateLabel, hm, dateOf, relativeDay } from './format.js';
import { localDate } from './time.js';
import { raw } from './texts.js';
import { safeEqual } from './telegram.js';

export async function runTick({ cfg, db, tg, now, doPurge }) {
  const c = createCtx({ cfg, db, tg, now: () => now });
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

  if (doPurge) {
    await purge(db, now, cfg.privacy.retentionDays);
    await purgeOld(db, now);
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

export async function handleTick({ request, env, cfg, tg, now }) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.TG_TOKEN || !env.TICK_SECRET || !env.DB) return new Response('Not configured', { status: 500 });
  const got = request.headers.get('X-Tick-Secret') || '';
  if (!(await safeEqual(got, env.TICK_SECRET))) return new Response('Forbidden', { status: 403 });
  const t = now();
  const out = await runTick({ cfg, db: env.DB, tg, now: t, doPurge: new Date(t).getUTCMinutes() < 5 });
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
