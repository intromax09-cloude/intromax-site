/**
 * Выбор дня и времени: общий для записи клиента, переноса клиентом и переноса владельцем/мастером.
 */
import { freeDays, freeSlots } from './slots.js';
import { appointmentsInRange, blocksInRange, setSession } from './store.js';
import { dayRange, addDays, localDate } from './time.js';
import { dateLabel } from './format.js';
import { bookableRange } from './slots.js';

const PAGE = 8;
const MAX_SLOT_BUTTONS = 48;

export async function loadData(c, fromTs, toTs) {
  const [appointments, blocks] = await Promise.all([
    appointmentsInRange(c.db, fromTs, toTs, null),
    blocksInRange(c.db, fromTs, toTs)
  ]);
  return { appointments, blocks };
}

export async function loadHorizon(c, now) {
  const r = bookableRange(c.cfg, now);
  const tz = c.cfg.business.timezone;
  return loadData(c, dayRange(r.from, tz)[0], dayRange(r.to, tz)[1]);
}

export function queryOf(sess, now) {
  return { serviceId: sess.svc, masterId: sess.mst || 'any', now, excludeId: sess.resched };
}

function backRow(c, withBack) {
  const row = [];
  if (withBack) row.push({ text: c.p('back'), callback_data: 'back' });
  row.push({ text: c.p('cancel_flow'), callback_data: 'x' });
  return row;
}

/** Экран выбора дня. title — заголовок (разный для записи/переноса). */
export async function showDays(c, u, sess, page, title, withBack) {
  const now = c.now();
  const days = freeDays(c.cfg, queryOf(sess, now), await loadHorizon(c, now));
  if (!days.length) {
    await c.show(u, c.t('no_slots', { phone: c.cfg.business.phone || '—' }), { inline_keyboard: [backRow(c, withBack)] });
    return;
  }
  const pages = Math.ceil(days.length / PAGE);
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  sess.step = 'day'; sess.page = p;
  await setSession(c.db, u.chat, sess, now);
  const rows = [];
  const slice = days.slice(p * PAGE, p * PAGE + PAGE);
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((d) => ({ text: dateLabel(c.cfg, d.date), callback_data: 'day:' + d.date })));
  }
  const nav = [];
  if (p > 0) nav.push({ text: c.p('days_prev'), callback_data: 'days:' + (p - 1) });
  if (p < pages - 1) nav.push({ text: c.p('days_next'), callback_data: 'days:' + (p + 1) });
  if (nav.length) rows.push(nav);
  rows.push(backRow(c, withBack));
  await c.show(u, title, { inline_keyboard: rows });
}

/** Экран выбора времени на дату. Возвращает false, если слотов нет. */
export async function showSlots(c, u, sess, date, withBack) {
  const now = c.now();
  const tz = c.cfg.business.timezone;
  const [from, to] = dayRange(date, tz);
  const slots = freeSlots(c.cfg, Object.assign(queryOf(sess, now), { date }), await loadData(c, from, to));
  if (!slots.length) return false;
  sess.step = 'time'; sess.date = date;
  await setSession(c.db, u.chat, sess, now);
  const rows = [];
  const shown = slots.slice(0, MAX_SLOT_BUTTONS);
  for (let i = 0; i < shown.length; i += 4) {
    rows.push(shown.slice(i, i + 4).map((s) => ({ text: s.time, callback_data: 'slot:' + s.time.replace(':', '') })));
  }
  rows.push([{ text: c.p('back'), callback_data: 'back' }, { text: c.p('cancel_flow'), callback_data: 'x' }]);
  await c.show(u, c.t('pick_time', { date: dateLabel(c.cfg, date) }), { inline_keyboard: rows });
  return true;
}

export { localDate, addDays };
