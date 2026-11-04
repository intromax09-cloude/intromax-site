/**
 * Форматирование дат, имён и телефонов. Чистый JS.
 */
import { utcToLocal, weekdayKey, WEEKDAYS, addDays } from './time.js';
import { escapeHtml } from './texts.js';

const list = (s) => String(s).split(',');

/** «чт, 5 листопада» */
export function dateLabel(cfg, date) {
  const wd = list(cfg.texts.weekdays)[WEEKDAYS.indexOf(weekdayKey(date))];
  const [, m, d] = date.split('-').map(Number);
  return wd + ', ' + d + ' ' + list(cfg.texts.months)[m - 1];
}

/** «понеділок» */
export function weekdayLong(cfg, dayKey) {
  return list(cfg.texts.weekdays_long)[WEEKDAYS.indexOf(dayKey)];
}

/** «сьогодні» / «завтра» / null — для текстов напоминаний. */
export function relativeDay(cfg, date, todayDate) {
  if (date === todayDate) return cfg.texts.when_today;
  if (date === addDays(todayDate, 1)) return cfg.texts.when_tomorrow;
  return null;
}

export function priceText(cfg, price) {
  if (price == null) return '';
  return cfg.texts.price_suffix.replace('{price}', String(price)).replace('{cur}', cfg.business.currency);
}

/** Имя клиента: пробелы схлопнуты, управляющие символы убраны, 1–60 символов. null — не годится. */
export function cleanName(s) {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v && v.length <= 60 ? v : null;
}

/**
 * Телефон → «+380501234567» или null.
 * trusted=true — номер пришёл кнопкой «Поділитися контактом» (его проверил Telegram): принимаем любой 10–15 цифр.
 */
export function normalizePhone(s, trusted) {
  const str = String(s == null ? '' : s).trim();
  if (!/^[+\d\s().-]{7,25}$/.test(str)) return null;
  const digits = str.replace(/\D/g, '');
  if (/^380\d{9}$/.test(digits)) return '+' + digits;
  if (/^0\d{9}$/.test(digits)) return '+38' + digits;
  if (/^\d{10,15}$/.test(digits) && (trusted || str.startsWith('+'))) return '+' + digits;
  return null;
}

export function hm(cfg, ms) { return utcToLocal(ms, cfg.business.timezone).time; }
export function dateOf(cfg, ms) { return utcToLocal(ms, cfg.business.timezone).date; }

/** Общие метки: клиент для списков и карточек. */
export function clientLine(c) { return c ? c.name : '—'; }
export function usernameLine(c) { return c && c.username ? '\n💬 @' + escapeHtml(c.username) : ''; }
