/**
 * Клиентская сторона: меню, запись (услуга → мастер → день → время → имя/телефон → подтверждение),
 * «Мои записи», отмена и перенос самим клиентом, контакты/цены/частые вопросы.
 * Состояние диалога — в таблице sessions (см. store.js), в callback_data только короткие id.
 */
import { setSession, clearSession, getSession, getClient, upsertClient, getAppointment, updateAppointment, insertAppointment,
  activeForClient, countActiveForClient, resetReminders, logEvent } from './store.js';
import { eligibleResources, findSlot, pickMaster } from './slots.js';
import { serviceEligible } from './config.js';
import { localToUtc, dayRange, fmtHM } from './time.js';
import { dateLabel, cleanName, normalizePhone, priceText, hm, dateOf } from './format.js';
import { raw } from './texts.js';
import { loadData, showDays, showSlots, queryOf } from './picker.js';
import { finishStaffMove } from './staff.js';

const active = (a, now) => a && (a.status === 'pending' || a.status === 'confirmed') && a.end_ts > now;

/* ------------------------------------------------------------------ меню */
export async function showMenu(c, u, greeting) {
  const cfg = c.cfg;
  const rows = [
    [{ text: c.p('menu_book'), callback_data: 'book' }],
    [{ text: c.p('menu_my'), callback_data: 'my' }],
    [{ text: c.p('menu_prices'), callback_data: 'prices' }, { text: c.p('menu_info'), callback_data: 'info' }]
  ];
  if (cfg.faq.length) rows.push([{ text: c.p('menu_faq'), callback_data: 'faq' }]);
  if (c.isStaff(u.chat)) {
    rows.push([{ text: c.p('menu_staff_today'), callback_data: 'st:today' }, { text: c.p('menu_staff_tomorrow'), callback_data: 'st:tomorrow' }]);
    rows.push([{ text: c.p('menu_staff_block'), callback_data: 'st:block' }]);
  }
  const prev = await getSession(c.db, u.chat, c.now());
  if (prev && prev.step === 'phone') await c.send(u.chat, '👌', { remove_keyboard: true }); // убрать клавиатуру «поделиться контактом»
  await clearSession(c.db, u.chat);
  if (greeting === 'question') rows.push(humanRow(c));            // вопрос без ответа: предложить человека
  const text = greeting === 'question' ? c.t('unknown_q') : greeting === false ? c.t('unknown') : c.t('welcome', { biz: cfg.business.name });
  await c.show(u, text, { inline_keyboard: rows });
}

/** Кнопка «Звʼязатися з адміністратором» (если передача человеку включена). */
function humanRow(c) { return [{ text: c.p('menu_human'), callback_data: 'hp' }]; }
const withHuman = (c, u, rows) => (c.cfg.handoff.enabled && !c.isStaff(u.chat) ? [...rows.slice(0, -1), humanRow(c), rows[rows.length - 1]] : rows);

/* ------------------------------------------------------------ информация */
export async function showInfo(c, u) {
  const cfg = c.cfg;
  const names = (cfg.texts.weekdays).split(',');
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const idx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const lines = order.map((d) => {
    const h = cfg.hours[d];
    const day = names[idx[d]];
    if (!h) return c.t('hours_off', { day });
    const breaks = h.breaks.length ? c.t('hours_breaks', { breaks: h.breaks.map(([a, b]) => fmtHM(a) + '–' + fmtHM(b)).join(', ') }) : '';
    return c.t('hours_row', { day, open: fmtHM(h.open), close: fmtHM(h.close), breaks: raw(breaks) });
  });
  const text = c.t('info', {
    biz: cfg.business.name,
    address: raw(cfg.business.address ? c.t('info_address', { address: cfg.business.address }) : ''),
    phone_line: raw(cfg.business.phone ? c.t('info_phone', { phone: cfg.business.phone }) : ''),
    hours: raw(lines.join('\n'))
  });
  await c.show(u, text, { inline_keyboard: withHuman(c, u, [[{ text: c.p('back'), callback_data: 'menu' }]]) });
}

export async function showPrices(c, u) {
  const cfg = c.cfg;
  const lines = cfg.services.map((s) => c.t('prices_row', { name: s.name, dur: s.durationMin, price: priceText(cfg, s.price) }));
  await c.show(u, cfg.texts.prices_title + '\n\n' + lines.join('\n'), { inline_keyboard: [
    [{ text: c.p('menu_book'), callback_data: 'book' }], [{ text: c.p('back'), callback_data: 'menu' }]] });
}

export async function showFaq(c, u, idx) {
  const cfg = c.cfg;
  if (idx == null) {
    const rows = cfg.faq.map((f, i) => [{ text: f.q, callback_data: 'faq:' + i }]);
    rows.push([{ text: c.p('back'), callback_data: 'menu' }]);
    await c.show(u, c.t('faq_title'), { inline_keyboard: withHuman(c, u, rows) });
    return;
  }
  const f = cfg.faq[idx];
  if (!f) return showFaq(c, u, null);
  /* ответ — доверенный HTML из config.json (проверен config.js) */
  await c.show(u, f.a, { inline_keyboard: withHuman(c, u, [[{ text: c.p('faq_back'), callback_data: 'faq' }], [{ text: c.p('back'), callback_data: 'menu' }]]) });
}

/* ---------------------------------------------------------------- запись */
export async function startBooking(c, u) {
  const sess = { step: 'svc', actor: 'client' };
  await setSession(c.db, u.chat, sess, c.now());
  const rows = c.cfg.services.map((s) => [{ text: s.name + (s.price != null ? ' · ' + s.price + ' ' + c.cfg.business.currency : ''), callback_data: 'svc:' + s.id }]);
  rows.push([{ text: c.p('cancel_flow'), callback_data: 'x' }]);
  await c.show(u, c.t('pick_service'), { inline_keyboard: rows });
}

function mastersFor(c, serviceId) {
  const s = c.cfg.servicesById[serviceId];
  return c.cfg.masters.filter((m) => serviceEligible(s, m));
}

export async function onService(c, u, sess, id) {
  if (!sess || !c.cfg.servicesById[id]) return expired(c, u);
  const list = mastersFor(c, id);
  sess.svc = id; sess.mst = 'any';
  if (list.length > 1 && c.cfg.booking.chooseMaster) {
    sess.step = 'mst';
    await setSession(c.db, u.chat, sess, c.now());
    const rows = list.map((m) => [{ text: m.name, callback_data: 'mst:' + m.id }]);
    rows.push([{ text: c.p('any_master'), callback_data: 'mst:any' }]);
    rows.push([{ text: c.p('back'), callback_data: 'back' }, { text: c.p('cancel_flow'), callback_data: 'x' }]);
    return c.show(u, c.t('pick_master', { master_acc: c.cfg.texts.master_acc }), { inline_keyboard: rows });
  }
  if (list.length === 1) sess.mst = list[0].id;
  return showDays(c, u, sess, 0, c.t('pick_day'), true);
}

export async function onMaster(c, u, sess, id) {
  if (!sess || !sess.svc) return expired(c, u);
  const ok = id === 'any' || mastersFor(c, sess.svc).some((m) => m.id === id);
  if (!ok) return expired(c, u);
  sess.mst = id;
  return showDays(c, u, sess, 0, c.t('pick_day'), true);
}

export async function onDays(c, u, sess, page) {
  if (!sess || !sess.svc) return expired(c, u);
  const title = sess.resched ? c.t(sess.actor === 'staff' ? 'staff_resched_title' : 'resched_title', { id: sess.resched, details: raw(sess.detailsHtml || '') }) : c.t('pick_day');
  return showDays(c, u, sess, page, title, !sess.resched);
}

export async function onDay(c, u, sess, date, cbId) {
  if (!sess || !sess.svc || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return expired(c, u);
  const ok = await showSlots(c, u, sess, date, !sess.resched);
  if (!ok) {
    if (cbId) await c.answer(cbId, c.cfg.texts.day_full.replace(/<[^>]+>/g, ''), true);
    await onDays(c, u, sess, sess.page || 0);
  }
}

export async function onSlot(c, u, sess, hhmm, cbId) {
  if (!sess || !sess.svc || !sess.date || !/^\d{4}$/.test(hhmm)) return expired(c, u);
  const cfg = c.cfg, now = c.now(), tz = cfg.business.timezone;
  const time = hhmm.slice(0, 2) + ':' + hhmm.slice(2);
  const start = localToUtc(sess.date, time, tz);
  const [from, to] = dayRange(sess.date, tz);
  const slot = findSlot(cfg, Object.assign(queryOf(sess, now), { start }), await loadData(c, from, to));
  if (!slot) {
    if (cbId) await c.answer(cbId, cfg.texts.slot_taken.replace(/<[^>]+>/g, ''), true);
    if (!(await showSlots(c, u, sess, sess.date, !sess.resched))) await onDays(c, u, sess, sess.page || 0);
    return;
  }
  if (sess.resched) {
    return sess.actor === 'staff' ? finishStaffMove(c, u, sess, start, slot) : finishClientMove(c, u, sess, start, slot);
  }
  sess.start = start; sess.time = time;
  const client = await getClient(c.db, u.from.id);
  if (client) { sess.name = client.name; sess.phone = client.phone; return showSummary(c, u, sess); }
  return askName(c, u, sess);
}

async function askName(c, u, sess) {
  sess.step = 'name'; delete sess.name; delete sess.phone;
  await setSession(c.db, u.chat, sess, c.now());
  const rows = [];
  const fn = cleanName(u.from && u.from.first_name);
  if (fn) rows.push([{ text: c.p('name_keep', { name: fn }), callback_data: 'nm:keep' }]);
  rows.push([{ text: c.p('cancel_flow'), callback_data: 'x' }]);
  await c.show(u, c.t('ask_name'), { inline_keyboard: rows });
}

async function askPhone(c, u, sess) {
  sess.step = 'phone';
  await setSession(c.db, u.chat, sess, c.now());
  await c.send(u.chat, c.t('ask_phone'), {
    keyboard: [[{ text: c.p('share_contact'), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true
  });
}

export async function onNameKeep(c, u, sess) {
  if (!sess || sess.step !== 'name') return expired(c, u);
  const fn = cleanName(u.from && u.from.first_name);
  if (!fn) return askName(c, u, sess);
  sess.name = fn;
  return askPhone(c, u, sess);
}

/** Текстовое сообщение в диалоге записи. Возвращает true, если обработано. */
export async function onText(c, u, sess, text) {
  if (!sess) return false;
  if (sess.step === 'name') {
    const name = cleanName(text);
    if (!name) { await c.send(u.chat, c.t('bad_name')); return true; }
    sess.name = name;
    await askPhone(c, u, sess);
    return true;
  }
  if (sess.step === 'phone') {
    const phone = normalizePhone(text, false);
    if (!phone) { await c.send(u.chat, c.t('bad_phone')); return true; }
    await acceptPhone(c, u, sess, phone);
    return true;
  }
  return false;
}

export async function onContact(c, u, sess, contact) {
  if (!sess || sess.step !== 'phone') return false;
  /* контакт должен быть собственным: user_id совпадает с автором сообщения */
  if (contact.user_id && u.from && contact.user_id !== u.from.id) { await c.send(u.chat, c.t('foreign_contact')); return true; }
  const phone = normalizePhone(contact.phone_number, true);
  if (!phone) { await c.send(u.chat, c.t('bad_phone')); return true; }
  await acceptPhone(c, u, sess, phone);
  return true;
}

async function acceptPhone(c, u, sess, phone) {
  sess.phone = phone;
  await c.send(u.chat, '👌', { remove_keyboard: true });
  return showSummary(c, u, sess);
}

async function showSummary(c, u, sess) {
  const service = c.cfg.servicesById[sess.svc];
  const fake = { start_ts: sess.start, service_name: service.name, price: service.price,
    master_id: c.cfg.masters.length ? (sess.mst || 'any') : '_' };
  sess.step = 'confirm';
  await setSession(c.db, u.chat, sess, c.now());
  await c.send(u.chat, c.t('summary', { details: raw(c.details(fake)), client: sess.name, phone: sess.phone }), { inline_keyboard: [
    [{ text: c.p('confirm_booking'), callback_data: 'ok' }],
    [{ text: '✏️', callback_data: 'chg' }, { text: c.p('cancel_flow'), callback_data: 'x' }]] });
}

export async function onChange(c, u, sess) {
  if (!sess || sess.step !== 'confirm') return expired(c, u);
  return askName(c, u, sess);
}

export async function onConfirm(c, u, sess, cbId) {
  const cfg = c.cfg, now = c.now(), tz = cfg.business.timezone;
  if (!sess || sess.step !== 'confirm' || !sess.svc || !sess.start || !sess.name || !sess.phone) return expired(c, u);
  const clientId = u.from.id;
  if (await countActiveForClient(c.db, clientId, now) >= cfg.booking.maxActivePerClient) {
    await clearSession(c.db, u.chat);
    return c.show(u, c.t('limit_active', { n: cfg.booking.maxActivePerClient, phone: cfg.business.phone || '—' }), { inline_keyboard: [[{ text: c.p('menu_my'), callback_data: 'my' }]] });
  }
  const [from, to] = dayRange(sess.date, tz);
  const data = await loadData(c, from, to);
  const slot = findSlot(cfg, Object.assign(queryOf(sess, now), { start: sess.start }), data);
  if (!slot) {
    if (cbId) await c.answer(cbId, cfg.texts.slot_taken.replace(/<[^>]+>/g, ''), true);
    if (!(await showSlots(c, u, sess, sess.date, true))) await onDays(c, u, sess, 0);
    return;
  }
  const master = pickMaster(cfg, slot, data.appointments);
  const service = cfg.servicesById[sess.svc];
  await upsertClient(c.db, { tg_id: clientId, name: sess.name, phone: sess.phone, username: u.from.username }, now);
  const status = cfg.booking.autoConfirm ? 'confirmed' : 'pending';
  const id = await insertAppointment(c.db, {
    client_id: clientId, service_id: service.id, service_name: service.name, price: service.price,
    master_id: master, start_ts: slot.start, end_ts: slot.end, status
  }, now);
  if (!id) {
    if (cbId) await c.answer(cbId, cfg.texts.slot_taken.replace(/<[^>]+>/g, ''), true);
    if (!(await showSlots(c, u, sess, sess.date, true))) await onDays(c, u, sess, 0);
    return;
  }
  await clearSession(c.db, u.chat);
  const appt = await getAppointment(c.db, id);
  await c.show(u, c.t(status === 'confirmed' ? 'booked_confirmed' : 'booked_pending', { details: raw(c.details(appt)) }), {
    inline_keyboard: [[{ text: c.p('menu_my'), callback_data: 'my' }]] });
  await c.notifyStaff(appt, 'staff_new');
}

/* ----------------------------------------------------------- мои записи */
export async function showMine(c, u) {
  const list = await activeForClient(c.db, u.from.id, c.now());
  if (!list.length) {
    return c.show(u, c.t('my_empty'), { inline_keyboard: [[{ text: c.p('menu_book'), callback_data: 'book' }]] });
  }
  const rows = list.map((a) => [{ text: dateLabel(c.cfg, dateOf(c.cfg, a.start_ts)) + ', ' + hm(c.cfg, a.start_ts) + ' · ' + a.service_name, callback_data: 'ap:' + a.id }]);
  rows.push([{ text: c.p('back'), callback_data: 'menu' }]);
  await c.show(u, c.t('my_title'), { inline_keyboard: rows });
}

async function ownAppt(c, u, id) {
  const a = await getAppointment(c.db, id);
  return a && a.client_id === u.from.id && active(a, c.now()) ? a : null;
}

export async function showAppt(c, u, id) {
  const a = await ownAppt(c, u, id);
  if (!a) return c.show(u, c.t('appt_gone'), { inline_keyboard: [[{ text: c.p('menu_my'), callback_data: 'my' }]] });
  await c.show(u, c.t('appt_view', { details: raw(c.details(a)), status: c.statusText(a) }), { inline_keyboard: [
    [{ text: c.p('btn_reschedule'), callback_data: 'mv:' + a.id }, { text: c.p('btn_cancel'), callback_data: 'cc:' + a.id }],
    [{ text: c.p('back'), callback_data: 'my' }]] });
}

function tooLate(c, a) {
  return a.start_ts - c.now() < c.cfg.booking.clientChangeMinHours * 3600000;
}

export async function askCancel(c, u, id) {
  const a = await ownAppt(c, u, id);
  if (!a) return showMine(c, u);
  if (tooLate(c, a)) return c.show(u, c.t('too_late', { h: c.cfg.booking.clientChangeMinHours, phone: c.cfg.business.phone || '—' }), { inline_keyboard: [[{ text: c.p('back'), callback_data: 'my' }]] });
  await c.show(u, c.t('cancel_ask', { details: raw(c.details(a)) }), { inline_keyboard: [[
    { text: c.p('cancel_yes'), callback_data: 'cy:' + a.id }, { text: c.p('cancel_no'), callback_data: 'ap:' + a.id }]] });
}

export async function doCancel(c, u, id) {
  const a = await ownAppt(c, u, id);
  if (!a) return showMine(c, u);
  if (tooLate(c, a)) return askCancel(c, u, id);
  await updateAppointment(c.db, a.id, { status: 'cancelled', cancelled_by: 'client' }, c.now());
  await logEvent(c.db, 'cancelled', c.now(), { appointmentId: a.id, actor: 'client' });
  const fresh = await getAppointment(c.db, a.id);
  await c.show(u, c.t('cancelled_client'), { inline_keyboard: [[{ text: c.p('menu_book'), callback_data: 'book' }]] });
  await c.refreshCards(fresh);
  for (const chat of c.staffChatsFor(a.master_id)) {
    await c.send(chat, c.cardText(fresh, 'staff_client_cancelled'));
  }
}

export async function startMove(c, u, id) {
  const a = await ownAppt(c, u, id);
  if (!a) return showMine(c, u);
  if (tooLate(c, a)) return askCancel(c, u, id);
  const sess = { step: 'day', actor: 'client', resched: a.id, svc: a.service_id, mst: a.master_id, detailsHtml: c.details(a) };
  return showDays(c, u, sess, 0, c.t('resched_title', { details: raw(sess.detailsHtml) }), false);
}

async function finishClientMove(c, u, sess, start, slot) {
  const cfg = c.cfg, now = c.now();
  const a = await ownAppt(c, u, sess.resched);
  if (!a || tooLate(c, a)) { await clearSession(c.db, u.chat); return showMine(c, u); }
  const status = cfg.booking.autoConfirm ? 'confirmed' : 'pending';
  const ok = await updateAppointment(c.db, a.id, { start_ts: start, end_ts: slot.end, status, booked_at: now }, now);
  if (!ok) {
    await c.answer(u.cb, cfg.texts.slot_taken.replace(/<[^>]+>/g, ''), true);
    if (!(await showSlots(c, u, sess, sess.date, false))) await onDays(c, u, sess, 0);
    return;
  }
  await resetReminders(c.db, a.id);
  await logEvent(c.db, 'moved', now, { appointmentId: a.id, actor: 'client' });
  await clearSession(c.db, u.chat);
  const fresh = await getAppointment(c.db, a.id);
  await c.show(u, c.t(status === 'confirmed' ? 'resched_done_confirmed' : 'resched_done_pending', { details: raw(c.details(fresh)) }), {
    inline_keyboard: [[{ text: c.p('menu_my'), callback_data: 'my' }]] });
  await c.stripCards(fresh);
  await c.notifyStaff(fresh, 'staff_changed');
}

/** Кнопка «Назад»: на шаг назад по состоянию диалога. */
export async function onBack(c, u, sess) {
  if (!sess) return expired(c, u);
  if (sess.step === 'time' || sess.step === 'name' || sess.step === 'phone' || sess.step === 'confirm') {
    if (sess.step === 'time') return showDays(c, u, sess, sess.page || 0, c.t('pick_day'), true);
    if (await showSlots(c, u, sess, sess.date, true)) return;
    return showDays(c, u, sess, 0, c.t('pick_day'), true);
  }
  if (sess.step === 'day' && mastersFor(c, sess.svc).length > 1 && c.cfg.booking.chooseMaster) return onService(c, u, sess, sess.svc);
  return startBooking(c, u);
}

export async function expired(c, u) {
  await clearSession(c.db, u.chat);
  await c.send(u.chat, c.t('session_expired'));
  return showMenu(c, { chat: u.chat, from: u.from, mid: 0 });
}

