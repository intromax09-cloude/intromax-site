/**
 * Ежемесячный отчёт владельцу (часть поддержки Intromax): 1-го числа после support.reportHour по местному времени.
 * Что в отчёте за прошлый календарный месяц:
 *  - новых записей (по created_at) и сравнение с позапрошлым месяцем;
 *  - подтверждённых визитов (start_ts в месяце);
 *  - переносов и отмен (журнал events: клиентом / персоналом);
 *  - сколько раз клиент просил человека;
 *  - вопросы, на которые бот не нашёл ответа (events 'unanswered'), самые частые — списком;
 *  - доступность сайта (uptime_checks, uptime_incidents), если включён monitor.
 * Повторов нет: месяц «захватывается» в reports_log до отправки (как напоминания), сбой — до 3 попыток.
 */
import { localToUtc, utcToLocal } from './time.js';
import { raw } from './texts.js';
import { durText } from './monitor.js';

export const MAX_ATTEMPTS = 3;
const TOP_QUESTIONS = 5;

/** 'ГГГГ-ММ' → соседний месяц. */
export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** Границы месяца в UTC-мс по местному часовому поясу: [начало, начало следующего). */
export function monthBounds(key, tz) {
  return [localToUtc(key + '-01', '00:00', tz), localToUtc(shiftMonth(key, 1) + '-01', '00:00', tz)];
}

/** За какой месяц пора слать отчёт (или null): 1-е число, не раньше reportHour местного времени. */
export function reportDue(now, cfg) {
  const { date, time } = utcToLocal(now, cfg.business.timezone);
  if (date.slice(8) !== '01') return null;
  if (parseInt(time.slice(0, 2), 10) < cfg.support.reportHour) return null;
  return shiftMonth(date.slice(0, 7), -1);
}

const count = async (db, sql, ...p) => { const r = await db.prepare(sql).bind(...p).first(); return r ? Number(r.n) || 0 : 0; };

/** Цифры за месяц. Чистые данные, без текста — проверяются тестом на фикстуре. */
export async function collectStats(db, cfg, key) {
  const tz = cfg.business.timezone;
  const [from, to] = monthBounds(key, tz);
  const [pFrom, pTo] = monthBounds(shiftMonth(key, -1), tz);
  const s = { month: key, prevMonth: shiftMonth(key, -1) };
  s.booked = await count(db, 'SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND created_at < ?', from, to);
  s.bookedPrev = await count(db, 'SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND created_at < ?', pFrom, pTo);
  s.visits = await count(db, "SELECT COUNT(*) AS n FROM appointments WHERE status='confirmed' AND start_ts >= ? AND start_ts < ?", from, to);
  s.moved = await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind='moved' AND ts >= ? AND ts < ?", from, to);
  s.cancelledByClient = await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind='cancelled' AND actor='client' AND ts >= ? AND ts < ?", from, to);
  s.cancelledByStaff = await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind='cancelled' AND actor='staff' AND ts >= ? AND ts < ?", from, to);
  s.cancelled = s.cancelledByClient + s.cancelledByStaff;
  s.handoffs = await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind='handoff' AND ts >= ? AND ts < ?", from, to);
  s.unanswered = await count(db, "SELECT COUNT(*) AS n FROM events WHERE kind='unanswered' AND ts >= ? AND ts < ?", from, to);

  /* самые частые вопросы без ответа: одинаковые (без учёта регистра и знаков в конце) склеиваем */
  const qs = (await db.prepare("SELECT text FROM events WHERE kind='unanswered' AND text IS NOT NULL AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 500").bind(from, to).all()).results || [];
  const groups = new Map();
  qs.forEach((r, i) => {
    const k = r.text.toLowerCase().replace(/[\s?!.,…]+$/g, '').replace(/\s+/g, ' ');
    const g = groups.get(k) || { q: r.text.trim(), n: 0, last: i };
    g.n++; groups.set(k, g);
  });
  s.topQuestions = [...groups.values()].sort((a, b) => b.n - a.n || a.last - b.last).slice(0, TOP_QUESTIONS).map((g) => ({ q: g.q.slice(0, 100), n: g.n }));

  /* сайт: % удачных проверок + падения (только те, о которых предупреждали), обрезанные границами месяца */
  const chk = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM uptime_checks WHERE ts >= ? AND ts < ?').bind(from, to).first();
  const incidents = (await db.prepare('SELECT start_ts, end_ts FROM uptime_incidents WHERE alerted = 1 AND start_ts < ? AND (end_ts IS NULL OR end_ts > ?)').bind(to, from).all()).results || [];
  const reportTime = to;                     // открытое падение считаем до конца месяца
  const downMs = incidents.reduce((sum, x) => sum + Math.max(0, Math.min(x.end_ts == null ? reportTime : x.end_ts, to) - Math.max(x.start_ts, from)), 0);
  s.site = {
    checks: Number(chk.total) || 0, ok: Number(chk.ok) || 0,
    pct: chk.total ? Math.floor((chk.ok / chk.total) * 10000) / 100 : null,    // вниз, чтобы 1 сбой из 9000 не показался «100%»
    incidents: incidents.length, downMin: Math.round(downMs / 60000)
  };
  return s;
}

function monthName(c, key) {
  const [y, m] = key.split('-').map(Number);
  return c.cfg.texts.months_nom.split(',')[m - 1] + ' ' + y;
}

const pctText = (p) => (p === 100 ? '100' : p.toFixed(2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')) + '%';

/** Текст отчёта (HTML для Telegram). */
export function reportText(c, s) {
  const cfg = c.cfg;
  const L = [c.t('report_title', { month: monthName(c, s.month), biz: cfg.business.name }), ''];
  const delta = s.bookedPrev ? Math.round(((s.booked - s.bookedPrev) / s.bookedPrev) * 100) : null;
  L.push(c.t('report_booked', {
    n: s.booked, prev_month: cfg.texts.months_nom.split(',')[Number(s.prevMonth.slice(5)) - 1], prev: s.bookedPrev,
    delta: delta === null || delta === 0 ? '' : ', ' + (delta > 0 ? '+' : '−') + Math.abs(delta) + '%'
  }));
  L.push(c.t('report_visits', { n: s.visits }));
  L.push(c.t('report_changes', { moved: s.moved, cancelled: s.cancelled, by_client: s.cancelledByClient, by_staff: s.cancelledByStaff }));
  if (cfg.handoff.enabled || s.handoffs) L.push(c.t('report_handoff', { n: s.handoffs }));
  if (s.unanswered) {
    L.push(c.t('report_unanswered', { n: s.unanswered }));
    for (const q of s.topQuestions) L.push(c.t('report_unanswered_row', { q: q.q, times: q.n > 1 ? ' ×' + q.n : '' }));
    L.push(c.t('report_unanswered_hint'));
  } else L.push(c.t('report_unanswered_none'));
  if (cfg.monitor.url || s.site.checks) {
    if (!s.site.checks) L.push(c.t('report_site_nodata'));
    else L.push(c.t('report_site', { pct: pctText(s.site.pct), n: s.site.incidents, down: raw(s.site.incidents ? c.t('report_site_down', { dur: durText(c, s.site.downMin) }) : '') }));
  }
  L.push('', c.t('report_footer', { contact: cfg.support.contact ? ' · ' + cfg.support.contact : '' }));
  return L.join('\n');
}

/** Кому отчёт: владельцы + Intromax. */
export function reportRecipients(c) {
  return [...new Set([...c.ownerIds, ...c.cfg.support.chatIds])];
}

async function claim(db, key, now) {
  const ins = await db.prepare("INSERT OR IGNORE INTO reports_log (month, status, attempts, ts) VALUES (?, 'sending', 1, ?)").bind(key, now).run();
  if (ins.meta.changes > 0) return true;
  const up = await db.prepare("UPDATE reports_log SET status='sending', attempts=attempts+1, ts=? WHERE month=? AND status='failed' AND attempts < ?").bind(now, key, MAX_ATTEMPTS).run();
  return up.meta.changes > 0;
}

/** Из тика: если пора — собрать и отправить. Возвращает 'sent' | 'failed' | null (не пора / уже отправлен). */
export async function runReport(c, now) {
  if (!c.cfg.support.report) return null;
  const key = reportDue(now, c.cfg);
  if (!key) return null;
  const chats = reportRecipients(c);
  if (!chats.length) return null;
  if (!(await claim(c.db, key, now))) return null;
  let ok = 0;
  try {
    const text = reportText(c, await collectStats(c.db, c.cfg, key));
    for (const chat of chats) if (await c.send(chat, text)) ok++;
  } finally {
    await c.db.prepare('UPDATE reports_log SET status=?, ts=? WHERE month=?').bind(ok ? 'sent' : 'failed', now, key).run();
  }
  return ok ? 'sent' : 'failed';
}
