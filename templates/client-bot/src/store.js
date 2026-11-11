/**
 * Работа с D1: все SQL клиентского бота в одном месте. db — интерфейс D1 (prepare/bind/first/all/run),
 * поэтому в тестах подставляется обёртка над node:sqlite, а в Cloudflare — настоящая привязка DB.
 */

const SESSION_TTL_MS = 24 * 3600 * 1000;

/* ---------- сессии диалога ---------- */
export async function getSession(db, chatId, now) {
  const r = await db.prepare('SELECT state, updated_at FROM sessions WHERE chat_id=?').bind(chatId).first();
  if (!r || r.updated_at < now - SESSION_TTL_MS) return null;
  try { return JSON.parse(r.state); } catch (e) { return null; }
}
export async function setSession(db, chatId, state, now) {
  await db.prepare('INSERT INTO sessions (chat_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at')
    .bind(chatId, JSON.stringify(state), now).run();
}
export async function clearSession(db, chatId) {
  await db.prepare('DELETE FROM sessions WHERE chat_id=?').bind(chatId).run();
}

/* ---------- клиенты ---------- */
export async function getClient(db, tgId) {
  return db.prepare('SELECT * FROM clients WHERE tg_id=?').bind(tgId).first();
}
export async function upsertClient(db, c, now) {
  await db.prepare(
    'INSERT INTO clients (tg_id, name, phone, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(tg_id) DO UPDATE SET name=excluded.name, phone=excluded.phone, username=excluded.username, updated_at=excluded.updated_at'
  ).bind(c.tg_id, c.name, c.phone, c.username || null, now, now).run();
}

/* ---------- записи ---------- */
const APPT_SELECT =
  'SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.username AS client_username ' +
  'FROM appointments a LEFT JOIN clients c ON c.tg_id = a.client_id ';

export async function getAppointment(db, id) {
  return db.prepare(APPT_SELECT + 'WHERE a.id=?').bind(id).first();
}

/** Вставка записи. Возвращает id или 0, если место уже занято (сработал уникальный индекс). */
export async function insertAppointment(db, a, now) {
  try {
    const r = await db.prepare(
      'INSERT INTO appointments (client_id, service_id, service_name, price, master_id, start_ts, end_ts, status, booked_at, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(a.client_id, a.service_id, a.service_name, a.price == null ? null : a.price, a.master_id, a.start_ts, a.end_ts, a.status, now, now, now).run();
    return r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return 0;
    throw e;
  }
}

export async function updateAppointment(db, id, fields, now) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => k + '=?').join(', ');
  try {
    const r = await db.prepare('UPDATE appointments SET ' + set + ', updated_at=? WHERE id=?').bind(...keys.map((k) => fields[k]), now, id).run();
    return r.meta.changes > 0;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return false;
    throw e;
  }
}

export async function activeForClient(db, clientId, now) {
  const r = await db.prepare(APPT_SELECT + "WHERE a.client_id=? AND a.status IN ('pending','confirmed') AND a.end_ts > ? ORDER BY a.start_ts LIMIT 20").bind(clientId, now).all();
  return (r && r.results) || [];
}

export async function countActiveForClient(db, clientId, now) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE client_id=? AND status IN ('pending','confirmed') AND end_ts > ?").bind(clientId, now).first();
  return r ? r.n : 0;
}

/** Активные записи, пересекающие [from, to). masterId — только этого мастера (или null — все). */
export async function appointmentsInRange(db, from, to, masterId) {
  const sql = APPT_SELECT + "WHERE a.status IN ('pending','confirmed') AND a.start_ts < ? AND a.end_ts > ?" + (masterId ? ' AND a.master_id=?' : '') + ' ORDER BY a.start_ts';
  const st = db.prepare(sql);
  const r = await (masterId ? st.bind(to, from, masterId) : st.bind(to, from)).all();
  return (r && r.results) || [];
}

/* ---------- блокировки ---------- */
export async function blocksInRange(db, from, to) {
  const r = await db.prepare('SELECT * FROM blocks WHERE start_ts < ? AND end_ts > ? ORDER BY start_ts').bind(to, from).all();
  return (r && r.results) || [];
}
export async function insertBlock(db, b, now) {
  await db.prepare('INSERT INTO blocks (master_id, start_ts, end_ts, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(b.master_id == null ? null : b.master_id, b.start_ts, b.end_ts, b.kind, now).run();
}
export async function deleteBlock(db, id) {
  await db.prepare('DELETE FROM blocks WHERE id=?').bind(id).run();
}
/** Снять все блокировки области (master_id или NULL) внутри [from, to). */
export async function deleteBlocksInRange(db, masterId, from, to) {
  const st = masterId == null
    ? db.prepare('DELETE FROM blocks WHERE master_id IS NULL AND start_ts >= ? AND end_ts <= ?').bind(from, to)
    : db.prepare('DELETE FROM blocks WHERE master_id = ? AND start_ts >= ? AND end_ts <= ?').bind(masterId, from, to);
  await st.run();
}

/* ---------- карточки владельцу/мастеру ---------- */
export async function saveCard(db, appointmentId, chatId, messageId) {
  if (!messageId) return;
  await db.prepare('INSERT OR IGNORE INTO cards (appointment_id, chat_id, message_id) VALUES (?, ?, ?)').bind(appointmentId, chatId, messageId).run();
}
export async function cardsOf(db, appointmentId) {
  const r = await db.prepare('SELECT chat_id, message_id FROM cards WHERE appointment_id=?').bind(appointmentId).all();
  return (r && r.results) || [];
}

/* ---------- журнал напоминаний ---------- */
export async function logFor(db, ids) {
  if (!ids.length) return [];
  const r = await db.prepare('SELECT appointment_id, kind, status, attempts FROM reminders_log WHERE appointment_id IN (' + ids.map(() => '?').join(',') + ')').bind(...ids).all();
  return (r && r.results) || [];
}
/** Захватить (запись, вид) для отправки. true — захвачено нами; false — уже отправлено/захвачено другим запуском. */
export async function claimReminder(db, id, kind, now) {
  const ins = await db.prepare("INSERT OR IGNORE INTO reminders_log (appointment_id, kind, status, attempts, ts) VALUES (?, ?, 'sending', 1, ?)").bind(id, kind, now).run();
  if (ins.meta.changes > 0) return true;
  const up = await db.prepare("UPDATE reminders_log SET status='sending', attempts=attempts+1, ts=? WHERE appointment_id=? AND kind=? AND status='failed'").bind(now, id, kind).run();
  return up.meta.changes > 0;
}
export async function finishReminder(db, id, kind, ok, now) {
  await db.prepare('UPDATE reminders_log SET status=?, ts=? WHERE appointment_id=? AND kind=?').bind(ok ? 'sent' : 'failed', now, id, kind).run();
}
export async function resetReminders(db, id) {
  await db.prepare('DELETE FROM reminders_log WHERE appointment_id=?').bind(id).run();
}

/** Записи, которые могут понадобиться тику. */
export async function appointmentsForTick(db, from, to) {
  const r = await db.prepare(APPT_SELECT + "WHERE a.status IN ('pending','confirmed') AND a.end_ts > ? AND a.start_ts < ? ORDER BY a.start_ts LIMIT 500").bind(from, to).all();
  return (r && r.results) || [];
}

/* ---------- уборка (политика хранения) ---------- */
export async function purge(db, now, retentionDays) {
  const cut = now - retentionDays * 86400000;
  await db.prepare('DELETE FROM reminders_log WHERE appointment_id IN (SELECT id FROM appointments WHERE end_ts < ?)').bind(cut).run();
  await db.prepare('DELETE FROM cards WHERE appointment_id IN (SELECT id FROM appointments WHERE end_ts < ?)').bind(cut).run();
  await db.prepare('DELETE FROM appointments WHERE end_ts < ?').bind(cut).run();
  await db.prepare('DELETE FROM blocks WHERE end_ts < ?').bind(cut).run();
  await db.prepare('DELETE FROM clients WHERE tg_id NOT IN (SELECT client_id FROM appointments) AND updated_at < ?').bind(cut).run();
  await db.prepare('DELETE FROM sessions WHERE updated_at < ?').bind(now - SESSION_TTL_MS).run();
}

/* ---------- журнал событий для ежемесячного отчёта ---------- */
const QUESTION_MAX = 300;
const PERSONAL_KEEP_MS = 100 * 86400000;       // текст вопросов и chat id в журнале событий — не дольше 100 дней

/** Вопрос клиента для журнала: обрезан, номера телефонов и длинные числа замаскированы. */
export function maskQuestion(text) {
  return String(text || '').replace(/\+?\d[\d\s()-]{5,}\d/g, '…').replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);
}

/**
 * Записать событие. Отчёт — не главное: если таблицы нет (миграция 0002 не применена) или база сбоит,
 * основной сценарий (отмена, перенос, ответ клиенту) не должен падать.
 */
export async function logEvent(db, kind, now, { appointmentId = null, actor = null, chatId = null, text = null } = {}) {
  try {
    await db.prepare('INSERT INTO events (ts, kind, appointment_id, actor, chat_id, text) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, kind, appointmentId, actor, chatId, text == null ? null : maskQuestion(text)).run();
  } catch (e) {
    console.error('events', e && e.name);
  }
}

/** Последний «неотвеченный вопрос» клиента не старше since — для выжимки при передаче человеку. */
export async function lastQuestion(db, chatId, since) {
  try {
    const r = await db.prepare("SELECT text FROM events WHERE kind='unanswered' AND chat_id=? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT 1").bind(chatId, since).first();
    return r ? r.text : null;
  } catch (e) { return null; }
}

/* ---------- передача человеку: сообщение у персонала → клиент ---------- */
export async function saveRelay(db, chatId, messageId, clientId, now) {
  if (!messageId) return;
  await db.prepare('INSERT OR REPLACE INTO relays (chat_id, message_id, client_id, ts) VALUES (?, ?, ?, ?)').bind(chatId, messageId, clientId, now).run();
}
export async function relayTarget(db, chatId, messageId) {
  const r = await db.prepare('SELECT client_id FROM relays WHERE chat_id=? AND message_id=?').bind(chatId, messageId).first();
  return r ? r.client_id : null;
}

/** Ближайшая активная запись клиента (для выжимки оператору). */
export async function nextForClient(db, clientId, now) {
  return db.prepare(APPT_SELECT + "WHERE a.client_id=? AND a.status IN ('pending','confirmed') AND a.end_ts > ? ORDER BY a.start_ts LIMIT 1").bind(clientId, now).first();
}

/** Уборка таблиц поддержки: отдельно от purge(), чтобы бот без миграции 0002 продолжал работать. */
export async function purgeSupport(db, now, retentionDays) {
  const cut = now - retentionDays * 86400000;
  const personal = now - PERSONAL_KEEP_MS;
  await db.prepare('DELETE FROM events WHERE ts < ?').bind(cut).run();
  await db.prepare('UPDATE events SET text=NULL, chat_id=NULL WHERE ts < ? AND (text IS NOT NULL OR chat_id IS NOT NULL)').bind(personal).run();
  await db.prepare('DELETE FROM relays WHERE ts < ?').bind(now - 30 * 86400000).run();
  await db.prepare('DELETE FROM uptime_checks WHERE ts < ?').bind(personal).run();
  await db.prepare('DELETE FROM uptime_incidents WHERE end_ts IS NOT NULL AND end_ts < ?').bind(cut).run();
}
