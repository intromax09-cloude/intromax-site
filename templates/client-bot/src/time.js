/**
 * Время и часовые пояса. Чистый JS, без привязки к Cloudflare (работает и в Node).
 * Основа: tzOffset/kyivToUtc из functions/_lib/rem.js, обобщены на любой пояс и на «неудобные»
 * моменты перехода на летнее/зимнее время.
 *
 * Договорённости:
 *  - «локальная дата» — строка YYYY-MM-DD в поясе бизнеса, «локальное время» — HH:MM;
 *  - в базе всё хранится в миллисекундах UTC (start_ts / end_ts);
 *  - несуществующее локальное время (весенний «пропуск часа») сдвигается вперёд на длину пропуска;
 *  - неоднозначное локальное время (осенний «повтор часа») = ПЕРВОЕ из двух вхождений.
 */

const DAY_MS = 86400000;

const fmtCache = new Map();
function parts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch (e) { return false; }
}

/** Смещение пояса от UTC в минутах на момент ms (Киев: 120 зимой, 180 летом). */
export function tzOffset(ms, tz) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export const pad = (n) => String(n).padStart(2, '0');

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 'HH:MM' → минуты от полуночи; допускает 24:00. null, если формат неверный. */
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

export function fmtHM(min) {
  return pad(Math.floor(min / 60)) + ':' + pad(min % 60);
}

/** Локальная дата и время → UTC ms. См. договорённости про DST в шапке файла. */
export function localToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const mins = parseHM(time);
  const guess = Date.UTC(y, m - 1, d, 0, 0) + mins * 60000; // 24:00 корректно переходит на следующий день
  const offs = [...new Set([tzOffset(guess - DAY_MS, tz), tzOffset(guess + DAY_MS, tz)])];
  const valid = [];
  for (const off of offs) {
    const utc = guess - off * 60000;
    if (tzOffset(utc, tz) === off) valid.push(utc);
  }
  if (valid.length) return Math.min(...valid);
  // «пропущенный» час: берём смещение ДО перехода — получится момент сразу после пропуска
  return guess - offs[0] * 60000; // offs[0] — смещение за сутки до guess, т.е. до перехода
}

/** UTC ms → {date:'YYYY-MM-DD', time:'HH:MM', min}. */
export function utcToLocal(ms, tz) {
  const p = parts(ms, tz);
  return { date: p.y + '-' + pad(p.mo) + '-' + pad(p.d), time: pad(p.h) + ':' + pad(p.mi), min: p.h * 60 + p.mi };
}

export function localDate(ms, tz) { return utcToLocal(ms, tz).date; }

/** Календарное сложение: addDays('2026-03-28', 1) = '2026-03-29' (без участия поясов). */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
}

export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / DAY_MS);
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** День недели календарной даты: 'mon'…'sun'. */
export function weekdayKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** [начало, конец) локальных суток в UTC ms. Длина = 23, 24 или 25 часов. */
export function dayRange(date, tz) {
  return [localToUtc(date, '00:00', tz), localToUtc(addDays(date, 1), '00:00', tz)];
}
