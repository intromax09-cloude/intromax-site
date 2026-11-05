/**
 * Свободные слоты. Чистые функции: на вход конфиг и уже загруженные записи/блокировки, на выходе слоты.
 *
 * Правила:
 *  - рабочие отрезки дня = часы работы (или часы мастера) минус перерывы, переведённые в UTC;
 *  - слот стартует на сетке booking.stepMin от начала КАЖДОГО отрезка (после перерыва сетка начинается заново);
 *  - услуга должна целиком поместиться в отрезок: через перерыв и после закрытия записать нельзя;
 *  - занято = активные записи (pending/confirmed) + blocks; между двумя записями обязана быть пауза booking.bufferMin
 *    (на закрытие дня и на ручные блокировки она не распространяется);
 *  - слот не раньше now + booking.minLeadMin;
 *  - сетка идёт по абсолютному времени (UTC), поэтому в сутки перехода на летнее/зимнее время счёт честный;
 *    при осеннем «повторе часа» одинаковые подписи слотов схлопываются в первую.
 */
import { localToUtc, utcToLocal, fmtHM, addDays, weekdayKey, localDate, daysBetween } from './time.js';
import { serviceEligible } from './config.js';

export const ACTIVE = ['pending', 'confirmed'];
const MIN = 60000;

/** Рабочие отрезки ресурса на дату: [{s,e}] в UTC ms. Пусто = выходной. */
export function workSegments(cfg, resId, date) {
  const tz = cfg.business.timezone;
  const day = weekdayKey(date);
  const master = cfg.mastersById[resId];
  let h = cfg.hours[day];
  if (master && master.hours && day in master.hours && master.hours[day] !== undefined) h = master.hours[day];
  if (!h) return [];
  const pieces = [];
  let from = h.open;
  for (const [bs, be] of h.breaks) { if (bs > from) pieces.push([from, bs]); from = be; }
  if (h.close > from) pieces.push([from, h.close]);
  return pieces.map(([a, b]) => ({ s: localToUtc(date, fmtHM(a), tz), e: localToUtc(date, fmtHM(b), tz) }));
}

/** Какие ресурсы могут выполнить услугу (с учётом выбранного мастера или 'any'). */
export function eligibleResources(cfg, serviceId, masterId) {
  const service = cfg.servicesById[serviceId];
  if (!service) return [];
  if (!cfg.masters.length) return ['_'];
  return cfg.masters
    .filter((m) => (masterId && masterId !== 'any' ? m.id === masterId : true) && serviceEligible(service, m))
    .map((m) => m.id);
}

/**
 * Свободные слоты на дату.
 * q: {serviceId, masterId ('any' | id), date, now, excludeId?}  excludeId — запись, которую переносят (не считается занятой)
 * data: {appointments:[{id, master_id, start_ts, end_ts, status}], blocks:[{master_id|null, start_ts, end_ts}]}
 * → [{time:'HH:MM', start, end, masters:[id,…]}] по возрастанию start
 */
export function freeSlots(cfg, q, data) {
  const service = cfg.servicesById[q.serviceId];
  if (!service) return [];
  const tz = cfg.business.timezone;
  const dur = service.durationMin * MIN;
  const step = cfg.booking.stepMin * MIN;
  const buffer = cfg.booking.bufferMin * MIN;
  const earliest = q.now + cfg.booking.minLeadMin * MIN;
  const byStart = new Map();

  for (const res of eligibleResources(cfg, q.serviceId, q.masterId)) {
    const busy = [];
    for (const a of data.appointments || []) {
      if (a.master_id !== res || !ACTIVE.includes(a.status) || (q.excludeId != null && a.id === q.excludeId)) continue;
      busy.push([a.start_ts, a.end_ts + buffer, buffer]);   // пауза нужна и после чужой записи, и после новой
    }
    for (const b of data.blocks || []) {
      if (b.master_id == null || b.master_id === res) busy.push([b.start_ts, b.end_ts, 0]);
    }
    const seenLabels = new Set();
    for (const seg of workSegments(cfg, res, q.date)) {
      for (let s = seg.s; s + dur <= seg.e; s += step) {
        if (s < earliest) continue;
        const e = s + dur;
        if (busy.some(([bs, be, pad]) => s < be && e + pad > bs)) continue;
        const label = utcToLocal(s, tz);
        if (label.date !== q.date) continue; // повтор часа может «вытолкнуть» слот на соседнюю дату — такого быть не должно
        if (seenLabels.has(label.time)) continue; // осенний повтор часа: оставляем первое вхождение
        seenLabels.add(label.time);
        const cur = byStart.get(s);
        if (cur) cur.masters.push(res);
        else byStart.set(s, { time: label.time, start: s, end: e, masters: [res] });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** Диапазон дат, в котором бот вообще показывает записи: сегодня … сегодня+horizonDays. */
export function bookableRange(cfg, now) {
  const today = localDate(now, cfg.business.timezone);
  return { from: today, to: addDays(today, cfg.booking.horizonDays) };
}

export function dateInHorizon(cfg, date, now) {
  const r = bookableRange(cfg, now);
  return date >= r.from && date <= r.to;
}

/** Дни со свободными слотами. data должна покрывать весь горизонт. → [{date, count}] */
export function freeDays(cfg, q, data) {
  const { from, to } = bookableRange(cfg, q.now);
  const n = daysBetween(from, to);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const date = addDays(from, i);
    const slots = freeSlots(cfg, Object.assign({}, q, { date }), data);
    if (slots.length) out.push({ date, count: slots.length });
  }
  return out;
}

/**
 * Свободен ли конкретный слот (для финальной проверки перед записью).
 * Возвращает слот {time,start,end,masters} или null.
 */
export function findSlot(cfg, q, data) {
  const date = localDate(q.start, cfg.business.timezone);
  return freeSlots(cfg, Object.assign({}, q, { date }), data).find((s) => s.start === q.start) || null;
}

/** «Любой мастер»: берём наименее загруженного в этот день, при равенстве — первого в конфиге. */
export function pickMaster(cfg, slot, dayAppointments) {
  const load = (id) => (dayAppointments || []).filter((a) => a.master_id === id && ACTIVE.includes(a.status)).length;
  return slot.masters.slice().sort((a, b) => load(a) - load(b) || cfg.resources.indexOf(a) - cfg.resources.indexOf(b))[0];
}
