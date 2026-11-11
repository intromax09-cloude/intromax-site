/**
 * Владелец и мастера: кнопки на карточке заявки (подтвердить / перенести / отменить),
 * списки «сьогодні» и «завтра», ручная блокировка слота или дня.
 * Права: владелец (config.owner.chatIds + TG_CHAT_ID) управляет всем; мастер — только своими записями и своим временем.
 */
import { getAppointment, updateAppointment, appointmentsInRange, blocksInRange, insertBlock, deleteBlock,
  deleteBlocksInRange, setSession, clearSession, resetReminders, saveCard, logEvent } from './store.js';
import { workSegments } from './slots.js';
import { localDate, addDays, dayRange, utcToLocal } from './time.js';
import { dateLabel, hm } from './format.js';
import { raw } from './texts.js';
import { showDays, loadData } from './picker.js';

const MAX_LIST = 30;

/* ---------------------------------------------------------- карточка записи */
export async function onCardAction(c, u, action, id) {
  const a = await getAppointment(c.db, id);
  if (!a || !c.canManage(u.chat, a)) { await c.answer(u.cb, c.cfg.texts.staff_no_access.replace(/<[^>]+>/g, ''), true); return; }
  const now = c.now();

  if (action === 'ap') {                       // открыть карточку из списка
    await c.answer(u.cb);
    const mid = await c.send(u.chat, c.cardText(a), c.cardMarkup(a));
    await saveCard(c.db, a.id, u.chat, mid);
    return;
  }
  if (a.status === 'cancelled') { await c.answer(u.cb, c.cfg.texts.appt_gone.replace(/<[^>]+>/g, ''), true); await c.refreshCards(a); return; }

  if (action === 'ok') {
    if (a.status === 'pending') {
      await updateAppointment(c.db, a.id, { status: 'confirmed' }, now);
      const fresh = await getAppointment(c.db, a.id);
      await c.answer(u.cb, c.cfg.texts.staff_confirmed_note.replace(/<[^>]+>/g, ''));
      await c.refreshCards(fresh);
      await c.send(fresh.client_id, c.t('client_confirmed', { details: raw(c.details(fresh)) }));
    } else await c.answer(u.cb);
    return;
  }
  if (action === 'no') {                       // спросить подтверждение прямо на карточке
    await c.answer(u.cb);
    await c.editMarkup(u.chat, u.mid, { inline_keyboard: [[
      { text: c.p('staff_cancel_yes'), callback_data: 's:noy:' + a.id }, { text: c.p('staff_cancel_no'), callback_data: 's:nn:' + a.id }]] });
    return;
  }
  if (action === 'nn') { await c.answer(u.cb); await c.editMarkup(u.chat, u.mid, c.cardMarkup(a)); return; }
  if (action === 'noy') {
    await updateAppointment(c.db, a.id, { status: 'cancelled', cancelled_by: 'staff' }, now);
    await logEvent(c.db, 'cancelled', now, { appointmentId: a.id, actor: 'staff' });
    const fresh = await getAppointment(c.db, a.id);
    await c.answer(u.cb, c.cfg.texts.staff_cancelled_note.replace(/<[^>]+>/g, ''));
    await c.refreshCards(fresh);
    await c.send(fresh.client_id, c.t('client_cancelled_by_staff', { details: raw(c.details(fresh)), phone: c.cfg.business.phone || '—' }));
    return;
  }
  if (action === 'mv') {
    await c.answer(u.cb);
    const sess = { step: 'day', actor: 'staff', resched: a.id, svc: a.service_id, mst: a.master_id, detailsHtml: c.details(a) };
    await showDays(c, { chat: u.chat, mid: 0, from: u.from }, sess, 0, c.t('staff_resched_title', { id: a.id, details: raw(sess.detailsHtml) }), false);
  }
}

/** Слот выбран при переносе владельцем/мастером: двигаем запись и сообщаем клиенту. */
export async function finishStaffMove(c, u, sess, start, slot) {
  const now = c.now();
  const a = await getAppointment(c.db, sess.resched);
  if (!a || a.status === 'cancelled' || !c.canManage(u.chat, a)) { await clearSession(c.db, u.chat); return; }
  const ok = await updateAppointment(c.db, a.id, { start_ts: start, end_ts: slot.end, status: 'confirmed', booked_at: now }, now);
  if (!ok) { await c.answer(u.cb, c.cfg.texts.slot_taken.replace(/<[^>]+>/g, ''), true); return; }
  await resetReminders(c.db, a.id);
  await logEvent(c.db, 'moved', now, { appointmentId: a.id, actor: 'staff' });
  await clearSession(c.db, u.chat);
  const fresh = await getAppointment(c.db, a.id);
  await c.show(u, c.t('staff_moved'), null);
  await c.refreshCards(fresh);
  await c.send(fresh.client_id, c.t('client_moved_by_staff', { details: raw(c.details(fresh)) }));
}

/* ------------------------------------------------------------------ списки */
export async function showList(c, u, which) {
  if (!c.isStaff(u.chat)) { await c.send(u.chat, c.t('staff_no_access')); return; }
  const cfg = c.cfg, tz = cfg.business.timezone;
  const today = localDate(c.now(), tz);
  const date = which === 'tomorrow' ? addDays(today, 1) : today;
  const [from, to] = dayRange(date, tz);
  const role = c.roleOf(u.chat);
  const list = await appointmentsInRange(c.db, from, to, role.role === 'master' ? role.master.id : null);
  const when = which === 'tomorrow' ? cfg.texts.tomorrow : cfg.texts.today;
  const head = { when, date: dateLabel(cfg, date) };
  if (!list.length) { await c.send(u.chat, c.t('list_empty', head)); return; }
  const shown = list.slice(0, MAX_LIST);
  const lines = shown.map((a) => {
    const m = cfg.mastersById[a.master_id];
    return c.t('list_row', {
      icon: a.status === 'confirmed' ? '✅' : '⏳', from: hm(cfg, a.start_ts), to: hm(cfg, a.end_ts),
      service: a.service_name, client: a.client_name || '—',
      master: raw(m && role.role === 'owner' ? ' · ' + escape(m.name) : '')
    });
  });
  if (list.length > shown.length) lines.push(c.t('list_more', { n: list.length - shown.length }));
  const rows = shown.map((a) => [{ text: hm(cfg, a.start_ts) + ' ' + (a.client_name || '—'), callback_data: 's:ap:' + a.id }]);
  await c.send(u.chat, c.t('list_header', Object.assign({ n: list.length }, head)) + '\n\n' + lines.join('\n'), { inline_keyboard: rows });
}

function escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ------------------------------------------------------------- блокировки */
const DAYS_SHOWN = 14;

/** Старт: владелец с мастерами выбирает, кому блокировать; мастер — всегда себе; без мастеров — всему заведению. */
export async function startBlock(c, u) {
  if (!c.isStaff(u.chat)) { await c.send(u.chat, c.t('staff_no_access')); return; }
  const role = c.roleOf(u.chat);
  if (role.role === 'master') return blockPickDay(c, u, { step: 'blk', scope: role.master.id });
  if (!c.cfg.masters.length) return blockPickDay(c, u, { step: 'blk', scope: 'all' });
  const rows = c.cfg.masters.map((m) => [{ text: m.name, callback_data: 'bl:m:' + m.id }]);
  rows.push([{ text: c.p('block_all'), callback_data: 'bl:m:all' }]);
  await c.show(u, c.t('block_scope'), { inline_keyboard: rows });
}

function scopeAllowed(c, u, scope) {
  const role = c.roleOf(u.chat);
  if (role.role === 'owner') return scope === 'all' || !!c.cfg.mastersById[scope];
  if (role.role === 'master') return scope === role.master.id;
  return false;
}

export async function onBlock(c, u, parts, sess) {
  if (!c.isStaff(u.chat)) { await c.answer(u.cb, c.cfg.texts.staff_no_access.replace(/<[^>]+>/g, ''), true); return; }
  const kind = parts[1];
  if (kind === 'm') {
    if (!scopeAllowed(c, u, parts[2])) { await c.answer(u.cb, c.cfg.texts.staff_no_access.replace(/<[^>]+>/g, ''), true); return; }
    return blockPickDay(c, u, { step: 'blk', scope: parts[2] });
  }
  if (!sess || sess.step !== 'blk' || !scopeAllowed(c, u, sess.scope)) { await c.answer(u.cb); return startBlock(c, u); }
  if (kind === 'd') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[2])) return;
    sess.date = parts[2];
    return blockMenu(c, u, sess);
  }
  if (kind === 'day') return toggleDay(c, u, sess);
  if (kind === 't') return toggleSlot(c, u, sess, parts[2]);
  if (kind === 'back') return blockPickDay(c, u, { step: 'blk', scope: sess.scope });
}

async function blockPickDay(c, u, sess) {
  const tz = c.cfg.business.timezone;
  const today = localDate(c.now(), tz);
  const rows = [];
  let row = [];
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const d = addDays(today, i);
    row.push({ text: dateLabel(c.cfg, d), callback_data: 'bl:d:' + d });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: c.p('cancel_flow'), callback_data: 'x' }]);
  await setSession(c.db, u.chat, sess, c.now());
  await c.show(u, c.t('block_day'), { inline_keyboard: rows });
}

function scopeResources(c, scope) { return scope === 'all' ? c.cfg.resources : [scope]; }
function scopeMasterId(scope) { return scope === 'all' ? null : scope; }

/** Сетка слотов дня для области блокировки: объединение рабочих отрезков её ресурсов. */
function gridOf(c, scope, date) {
  const step = c.cfg.booking.stepMin * 60000, tz = c.cfg.business.timezone;
  const starts = new Map();
  for (const res of scopeResources(c, scope)) {
    for (const seg of workSegments(c.cfg, res, date)) {
      for (let s = seg.s; s + step <= seg.e; s += step) {
        const label = utcToLocal(s, tz);
        if (label.date === date && !starts.has(label.time)) starts.set(label.time, s);
      }
    }
  }
  return [...starts.entries()].map(([time, s]) => ({ time, s, e: s + step })).sort((x, y) => x.s - y.s);
}

async function blockMenu(c, u, sess) {
  const cfg = c.cfg, tz = cfg.business.timezone;
  const [from, to] = dayRange(sess.date, tz);
  const grid = gridOf(c, sess.scope, sess.date);
  await setSession(c.db, u.chat, sess, c.now());
  if (!grid.length) {
    await c.show(u, c.t('block_none'), { inline_keyboard: [[{ text: c.p('back'), callback_data: 'bl:back' }]] });
    return;
  }
  const mid = scopeMasterId(sess.scope);
  const data = await loadData(c, from, to);
  const myBlocks = data.blocks.filter((b) => mid == null ? b.master_id == null : (b.master_id === mid || b.master_id == null));
  const appts = data.appointments.filter((a) => mid == null ? true : a.master_id === mid);
  const dayBlocked = myBlocks.some((b) => b.kind === 'day' && (mid == null ? b.master_id == null : b.master_id === mid));
  const rows = [];
  let row = [];
  for (const g of grid) {
    const busyAppt = appts.some((a) => a.start_ts < g.e && a.end_ts > g.s);
    const blocked = myBlocks.some((b) => b.start_ts < g.e && b.end_ts > g.s);
    const icon = blocked ? '🚫' : busyAppt ? '🔒' : '⬜';
    row.push({ text: icon + ' ' + g.time, callback_data: 'bl:t:' + g.time.replace(':', '') });
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: dayBlocked ? c.p('block_unwhole') : c.p('block_whole'), callback_data: 'bl:day' }]);
  rows.push([{ text: c.p('back'), callback_data: 'bl:back' }, { text: c.p('cancel_flow'), callback_data: 'x' }]);
  const who = sess.scope === 'all' ? cfg.texts.block_all : cfg.mastersById[sess.scope].name;
  let text = c.t('block_menu', { who, date: dateLabel(cfg, sess.date) });
  if (appts.length) text += '\n\n' + c.t('block_has_appts', { n: appts.length });
  await c.show(u, text, { inline_keyboard: rows });
}

async function toggleDay(c, u, sess) {
  const now = c.now();
  const [from, to] = dayRange(sess.date, c.cfg.business.timezone);
  const mid = scopeMasterId(sess.scope);
  const existing = (await blocksInRange(c.db, from, to)).filter((b) => b.kind === 'day' && (b.master_id ?? null) === mid);
  if (existing.length) {
    await deleteBlocksInRange(c.db, mid, from, to);
  } else {
    await deleteBlocksInRange(c.db, mid, from, to);        // убрать мелкие блоки внутри дня — их заменяет блок дня
    await insertBlock(c.db, { master_id: mid, start_ts: from, end_ts: to, kind: 'day' }, now);
  }
  await c.answer(u.cb, c.cfg.texts.block_done);
  return blockMenu(c, u, sess);
}

async function toggleSlot(c, u, sess, hhmm) {
  if (!/^\d{4}$/.test(hhmm)) return;
  const now = c.now();
  const time = hhmm.slice(0, 2) + ':' + hhmm.slice(2);
  const g = gridOf(c, sess.scope, sess.date).find((x) => x.time === time);
  if (!g) { await c.answer(u.cb); return; }
  const mid = scopeMasterId(sess.scope);
  const [from, to] = dayRange(sess.date, c.cfg.business.timezone);
  const blocks = await blocksInRange(c.db, from, to);
  const exact = blocks.find((b) => (b.master_id ?? null) === mid && b.kind === 'slot' && b.start_ts === g.s);
  if (exact) await deleteBlock(c.db, exact.id);
  else {
    const covering = blocks.find((b) => b.start_ts < g.e && b.end_ts > g.s && ((b.master_id ?? null) === mid || b.master_id == null));
    if (covering) {
      const why = covering.kind === 'day' ? c.cfg.texts.block_unwhole : c.cfg.texts.staff_no_access;
      await c.answer(u.cb, why.replace(/<[^>]+>/g, ''), true);
      return;
    }
    await insertBlock(c.db, { master_id: mid, start_ts: g.s, end_ts: g.e, kind: 'slot' }, now);
  }
  await c.answer(u.cb);
  return blockMenu(c, u, sess);
}

