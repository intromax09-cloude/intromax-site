/**
 * Мониторинг доступности сайта клиента — наш аналог uptime-kuma без своего сервера.
 * Запускается из тика (cron-worker → /api/tick раз в 5 минут): одна проверка за тик.
 * Правила тревог:
 *  - падение = monitor.failAfter неудачных проверок подряд (по умолчанию 2, чтобы не будить из-за одного сбоя сети);
 *  - на одно падение — ОДНО сообщение (флаг alerted захватывается атомарно, параллельные тики не дублируют);
 *  - при восстановлении — одно сообщение «снова работает, лежал N минут»;
 *  - короткий сбой, не дотянувший до failAfter, молча забывается.
 * История — в D1: uptime_checks (каждая проверка, для % в отчёте) и uptime_incidents (падения).
 */
import { dateLabel, hm, dateOf } from './format.js';

/** Одна проверка. fetchImpl — fetch (в тестах подменяется). Возвращает {ok, status, ms, reason}. */
export async function checkSite(fetchImpl, mon, clock = Date.now) {
  const t0 = clock();
  try {
    const r = await fetchImpl(mon.url, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntromaxUptime/1.0)', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(mon.timeoutSec * 1000)
    });
    let ok = r.status >= 200 && r.status < 400;
    let reason = ok ? '' : 'http';
    if (ok && mon.expectText) {
      const body = await r.text();
      if (!body.includes(mon.expectText)) { ok = false; reason = 'text'; }
    } else if (r.body && typeof r.body.cancel === 'function') {
      try { await r.body.cancel(); } catch (e) { /* тело не нужно */ }
    }
    return { ok, status: r.status, ms: clock() - t0, reason };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, status: 0, ms: clock() - t0, reason: timeout ? 'timeout' : 'network' };
  }
}

async function openIncident(db) {
  return db.prepare('SELECT * FROM uptime_incidents WHERE end_ts IS NULL ORDER BY id DESC LIMIT 1').first();
}

/** «45 хв» / «2 год 5 хв». */
export function durText(c, minutes) {
  const m = Math.max(1, Math.round(minutes));
  return m < 60 ? c.t('dur_min', { m }) : c.t('dur_hm', { h: Math.floor(m / 60), m: m % 60 });
}

function sinceText(c, ts, now) {
  const cfg = c.cfg;
  return dateOf(cfg, ts) === dateOf(cfg, now) ? hm(cfg, ts) : dateLabel(cfg, dateOf(cfg, ts)) + ', ' + hm(cfg, ts);
}

function reasonText(c, inc) {
  if (inc.reason === 'timeout') return c.t('site_reason_timeout', { sec: c.cfg.monitor.timeoutSec });
  if (inc.reason === 'text') return c.t('site_reason_text');
  if (inc.reason === 'http' && inc.last_status) return c.t('site_reason_http', { code: inc.last_status });
  return c.t('site_reason_network');
}

/** Кому тревоги: владельцы (если monitor.notifyOwner) + Intromax (support.chatIds). */
export function monitorRecipients(c) {
  const out = new Set(c.cfg.support.chatIds);
  if (c.cfg.monitor.notifyOwner) for (const id of c.ownerIds) out.add(id);
  return [...out];
}

async function broadcast(c, chats, text) {
  let ok = 0;
  for (const chat of chats) if (await c.send(chat, text)) ok++;
  return ok;
}

/**
 * Проверка + запись в историю + тревоги. c — контекст (ctx.js), now — момент тика.
 * Возвращает {state: 'up'|'down', alerted?: true, recovered?: true}.
 */
export async function runMonitor(c, fetchImpl, now) {
  const mon = c.cfg.monitor, db = c.db;
  const res = await checkSite(fetchImpl, mon);
  await db.prepare('INSERT INTO uptime_checks (ts, ok, status, ms) VALUES (?, ?, ?, ?)').bind(now, res.ok ? 1 : 0, res.status, Math.max(0, res.ms | 0)).run();
  const open = await openIncident(db);

  if (!res.ok) {
    if (!open) {
      /* открыть падение, если его ещё никто не открыл (одно открытое падение на бота) */
      await db.prepare('INSERT INTO uptime_incidents (start_ts, fails, alerted, last_status, reason) SELECT ?, 1, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM uptime_incidents WHERE end_ts IS NULL)')
        .bind(now, res.status, res.reason).run();
    } else {
      await db.prepare('UPDATE uptime_incidents SET fails = fails + 1, last_status = ?, reason = ? WHERE id = ?').bind(res.status, res.reason, open.id).run();
    }
    const cur = await openIncident(db);
    if (cur && cur.fails >= mon.failAfter && !cur.alerted) {
      const claim = await db.prepare('UPDATE uptime_incidents SET alerted = 1 WHERE id = ? AND alerted = 0').bind(cur.id).run();
      if (claim.meta.changes > 0) {
        await broadcast(c, monitorRecipients(c), c.t('site_down', { url: mon.url, reason: reasonText(c, cur), since: sinceText(c, cur.start_ts, now) }));
        return { state: 'down', alerted: true };
      }
    }
    return { state: 'down' };
  }

  if (open) {
    const closed = await db.prepare('UPDATE uptime_incidents SET end_ts = ? WHERE id = ? AND end_ts IS NULL').bind(now, open.id).run();
    if (closed.meta.changes > 0) {
      const inc = await db.prepare('SELECT * FROM uptime_incidents WHERE id = ?').bind(open.id).first();
      if (inc && inc.alerted) {
        await broadcast(c, monitorRecipients(c), c.t('site_up', { url: mon.url, dur: durText(c, (now - inc.start_ts) / 60000), since: sinceText(c, inc.start_ts, now) }));
        return { state: 'up', recovered: true };
      }
      await db.prepare('DELETE FROM uptime_incidents WHERE id = ?').bind(open.id).run();   // разовый сбой — не падение
    }
  }
  return { state: 'up' };
}
